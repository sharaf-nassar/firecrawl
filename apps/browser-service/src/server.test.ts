import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket as ClientWebSocket } from "ws";

import { normalizedProposalHashForOperation } from "./action-cache.js";
import {
  ARTIFACT_METADATA_HEADERS,
  MAX_RECONCILIATION_REFERENCES,
  canonicalJson,
  type ControlGenerationV1,
  type ReconciliationResultV1,
  type SessionV1,
} from "./contracts.js";
import { BrowserServiceError } from "./errors.js";
import { createBrowserServiceApplication } from "./index.js";
import {
  canonicalizeReconciliationSnapshot,
  runWithReconciliationFilesystemTestContext,
} from "./reconciliation.js";
import {
  createBrowserServiceServer,
  type BrowserGenerationRuntime,
  type BrowserServiceServer,
} from "./server.js";
import {
  SessionRegistryError,
  createSessionRegistry,
  type SessionRegistry,
} from "./session-registry.js";

const PROCESS_NONCE = Buffer.alloc(32, 1).toString("base64url");
const GENERATION_NONCE = Buffer.alloc(32, 2).toString("base64url");
const OLD_GENERATION_NONCE = Buffer.alloc(32, 3).toString("base64url");
const API_KEY = "0123456789abcdef0123456789abcdef";
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
] as const;

const binding = Object.freeze({
  processNonce: PROCESS_NONCE,
  controlGenerationNonce: GENERATION_NONCE,
});
const session: SessionV1 = {
  version: 1,
  runtimeSessionId: IDS[0],
  state: "ready",
  sessionVersion: 0,
  page: {
    url: "https://example.com/",
    title: "Example",
    snapshotExcerpt: "Example",
  },
  expiresAt: "2026-07-24T15:00:00.000Z",
  idleExpiresAt: "2026-07-24T14:10:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function validActionBody(): string {
  return JSON.stringify({
    version: 1,
    actionId: IDS[1],
    runId: IDS[2],
    sequence: 1,
    normalizedProposalHash: "a".repeat(64),
    effect: "read_only",
    expectedSessionVersion: 0,
    allowedDomains: ["example.com"],
    operation: { kind: "extract" },
  });
}

function realActionBody(
  operation: Parameters<typeof normalizedProposalHashForOperation>[0] = {
    kind: "extract",
  },
  identity: {
    actionId?: string;
    runId?: string;
    expectedSessionVersion?: number;
  } = {},
): string {
  return JSON.stringify({
    version: 1,
    actionId: identity.actionId ?? IDS[1],
    runId: identity.runId ?? IDS[2],
    sequence: 1,
    normalizedProposalHash: normalizedProposalHashForOperation(operation),
    effect: "read_only",
    expectedSessionVersion: identity.expectedSessionVersion ?? 1,
    allowedDomains: ["example.com"],
    operation,
  });
}

function validSessionCreateRequest() {
  return {
    version: 1 as const,
    sessionId: IDS[0],
    initialUrl: "https://example.com/",
    allowedDomains: ["example.com"],
    ttlSeconds: 60,
    activityTtlSeconds: 30,
    profile: null,
    replay: null,
    settings: {
      headers: {},
      cookies: [],
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
      userAgent: "server-test",
      locale: "en-US",
      timezoneId: "UTC",
      location: { country: "us", languages: ["en-US"] },
      proxy: { kind: "auto" as const },
      skipTlsVerification: false,
      blockAds: false,
      lockdown: true,
    },
  };
}

function validReconciliationBody(
  processNonce = PROCESS_NONCE,
  controlGenerationNonce = GENERATION_NONCE,
): string {
  return JSON.stringify({
    version: 1,
    processNonce,
    controlGenerationNonce,
    snapshotDigest: "b".repeat(64),
    references: [],
  });
}

function realRegistryFixture(): {
  registry: SessionRegistry;
  rejectPageUrlWith(error: Error): void;
  rejectPageTitleWith(error: Error): void;
  hangPageWait(): void;
  holdPageTextUntilContextClose(): Promise<void>;
} {
  let pageUrl = "about:blank";
  let pageUrlFailure: Error | undefined;
  let pageTitleFailure: Error | undefined;
  let waitNeverSettles = false;
  let heldPageText:
    | {
        reached: Promise<void>;
        markReached(): void;
        released: Promise<void>;
        release(): void;
      }
    | undefined;
  const cdp = {
    send: vi.fn(async (method: string) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : {},
    ),
    on: vi.fn(),
    off: vi.fn(),
    detach: vi.fn(async () => undefined),
  };
  const tracing = {
    start: vi.fn(async () => undefined),
    startChunk: vi.fn(async () => undefined),
    stopChunk: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  let context: Record<string, unknown>;
  const bodyLocator = {
    innerText: vi.fn(async () => {
      const held = heldPageText;
      if (held !== undefined) {
        held.markReached();
        await held.released;
      }
      return "Example";
    }),
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(async () => {
      const held = heldPageText;
      if (held !== undefined) {
        held.markReached();
        await held.released;
      }
      return [
        {
          connected: true,
          tag: "BODY",
          role: "",
          name: "",
          text: "Example",
        },
      ];
    }),
  };
  const emptyElementsLocator = {
    count: vi.fn(async () => 0),
    nth: vi.fn(() => ({
      elementHandle: vi.fn(async () => null),
    })),
  };
  const page = {
    goto: vi.fn(async (url: string) => {
      pageUrl = url;
    }),
    url: vi.fn(() => {
      if (pageUrlFailure !== undefined) throw pageUrlFailure;
      return pageUrl;
    }),
    title: vi.fn(async () => {
      if (pageTitleFailure !== undefined) throw pageTitleFailure;
      return "Example";
    }),
    textContent: vi.fn(async () => {
      const held = heldPageText;
      if (held !== undefined) {
        held.markReached();
        await held.released;
      }
      return "Example";
    }),
    locator: vi.fn((selector: string) =>
      selector === "body" ? bodyLocator : emptyElementsLocator,
    ),
    waitForTimeout: vi.fn(async () => {
      if (waitNeverSettles) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }),
    screenshot: vi.fn(async () => Buffer.from("image")),
    evaluateHandle: vi.fn(async () => ({
      evaluate: vi.fn(async () => []),
      getProperties: vi.fn(async () => new Map()),
      dispose: vi.fn(async () => undefined),
    })),
    on: vi.fn(),
    off: vi.fn(),
    mainFrame: vi.fn(() => Object.freeze({})),
    context: vi.fn(() => context),
  };
  context = {
    pages: vi.fn(() => [page]),
    serviceWorkers: vi.fn(() => []),
    close: vi.fn(async () => {
      heldPageText?.release();
    }),
    browser: vi.fn(() => null),
    setStorageState: vi.fn(async () => undefined),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    newCDPSession: vi.fn(async () => cdp),
    tracing,
  };
  const gate = {
    state: "restore_closed",
    counters: {
      ingressAttempts: 0,
      ingressViolations: 0,
      dnsResolutions: 0,
      policyDecisions: 0,
      dials: 0,
    },
    recordedCategory: null,
    beginIngress: vi.fn(() => true),
    recordDnsResolution: vi.fn(),
    recordPolicyDecision: vi.fn(),
    recordDial: vi.fn(),
    assertZeroViolations: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    markPositiveControlBaseline: vi.fn(() => ({
      counters: {
        ingressAttempts: 0,
        ingressViolations: 0,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      },
      controlId: 1,
    })),
    assertPositiveControl: vi.fn(),
    completeCounterSnapshot: vi.fn(() => ({
      ingressAttempts: 0,
      ingressViolations: 0,
      dnsResolutions: 0,
      policyDecisions: 0,
      dials: 0,
    })),
    snapshot: vi.fn(() => ({
      state: "open",
      counters: {
        ingressAttempts: 0,
        ingressViolations: 0,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      },
    })),
  };
  const registry = createSessionRegistry({
    admission: {
      processNonce: PROCESS_NONCE,
      requireReady: () => ({
        ...binding,
        snapshotDigest: "b".repeat(64),
      }),
      beginDraining() {},
    },
    binding,
    profileStore: {
      workingGeneration: vi.fn(() => Object.freeze({})),
      readRootFile: vi.fn(async () => Buffer.from("{}")),
      createWorkingCopy: vi.fn(async () => ({
        profileId: IDS[0],
        generationId: IDS[2],
        sessionId: IDS[0],
        mode: "snapshot" as const,
        path: "/tmp/server-real-registry",
      })),
      discardWorkingCopy: vi.fn(async () => undefined),
      prepareWorkingCopy: vi.fn(async () => ({
        profileId: IDS[0],
        generationId: IDS[2],
        checksum: "c".repeat(64),
        byteSize: 1,
        prepareToken: Buffer.alloc(32, 8).toString("base64url"),
      })),
      finalizePreparedGeneration: vi.fn(async () => ({
        version: 1 as const,
        profileId: IDS[0],
        generationId: IDS[2],
        checksum: "c".repeat(64),
        committed: true as const,
      })),
    },
    createEgressProxy: vi.fn(async () => ({
      url: "http://127.0.0.1:1234",
      port: 1234,
      restoreGate: gate,
      close: vi.fn(async () => undefined),
      liveSocketCount: () => 0,
    })) as never,
    launchPersistentChromiumForWorking: vi.fn(async () =>
      Object.freeze({ context }),
    ) as never,
    releaseChromiumSessionAttachment: vi.fn(async () => {
      await (context.close as () => Promise<void>)();
    }) as never,
    createRecordingProducer: vi.fn(async () => ({
      snapshot: vi.fn(async () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])),
      subscribe: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    })),
    now: () => 1_700_000_000_000,
    randomUUID: () => IDS[1],
    cleanupTimeoutMs: 100,
    operationTimeoutMs: 25,
  });
  return {
    registry,
    rejectPageUrlWith(error) {
      pageUrlFailure = error;
    },
    rejectPageTitleWith(error: Error) {
      pageTitleFailure = error;
    },
    hangPageWait() {
      waitNeverSettles = true;
    },
    holdPageTextUntilContextClose() {
      let markReached!: () => void;
      const reached = new Promise<void>(resolve => {
        markReached = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>(resolve => {
        release = resolve;
      });
      heldPageText = { reached, markReached, released, release };
      return reached;
    },
  };
}

function requestHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${API_KEY}`,
    "x-firecrawl-correlation-id": "server-test",
    "x-firecrawl-deadline": new Date(Date.now() + 60_000).toISOString(),
    "x-firecrawl-process-nonce": PROCESS_NONCE,
    "x-firecrawl-control-generation-nonce": GENERATION_NONCE,
    "content-type": "application/json",
    ...overrides,
  };
}

function bootstrapHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${API_KEY}`,
    "x-firecrawl-correlation-id": "server-test",
    "x-firecrawl-deadline": new Date(Date.now() + 60_000).toISOString(),
    "content-type": "application/json",
  };
}

function harness(registryOverride?: SessionRegistry) {
  const order: string[] = [];
  const internalErrors: unknown[] = [];
  let routeAdmissionOpen = true;
  const registry = {
    create: vi.fn(async () => session),
    get: vi.fn(() => session),
    touch: vi.fn(() => session),
    extendAuthority: vi.fn(async () => session),
    executeAction: vi.fn(async () => ({
      version: 1,
      actionId: IDS[1],
      sequence: 1,
      normalizedProposalHash: "a".repeat(64),
      outcome: "succeeded",
      result: { kind: "extract", text: "Example" },
      page: session.page,
      sessionVersion: 0,
    })),
    close: vi.fn(async () => ({
      version: 1,
      runtimeSessionId: IDS[0],
      closed: true,
      sessionVersion: 0,
      preparedProfile: null,
    })),
    drainAll: vi.fn(async () => {
      order.push("registry");
    }),
  };
  const grants = {
    create: vi.fn(() => ({
      version: 1,
      grantId: IDS[1],
      permission: "passive",
      expiresAt: "2026-07-24T14:30:00.000Z",
      relayToken: Buffer.alloc(32, 9).toString("base64url"),
    })),
    revoke: vi.fn(async () => ({
      version: 1,
      grantId: IDS[1],
      revoked: true,
    })),
    open: vi.fn(async () => undefined),
    sweepExpired: vi.fn(() => 0),
    drain: vi.fn(async () => {
      order.push("streams");
    }),
    inventory: vi.fn(() => ({ grants: 0, streams: 0 })),
  };
  const artifacts = {
    capture: vi.fn(async () => ({
      metadata: {
        version: 1,
        artifactId: IDS[2],
        kind: "screenshot",
        contentType: "image/png",
        byteSize: 3,
        checksum:
          "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      },
      stream: Readable.from(Buffer.from([1, 2, 3])),
    })),
    releaseSession: vi.fn(),
    sweepExpired: vi.fn(),
    drainAll: vi.fn(() => {
      order.push("artifacts");
    }),
  };
  const profileStore = {
    persistReplayCheckpoint: vi.fn(async input => {
      const value = input as {
        ownerId: string;
        scrapeId: string;
        checkpointId: string;
        storageState: unknown;
      };
      const bytes = Buffer.from(canonicalJson(value.storageState), "utf8");
      return {
        statePath:
          `replay/${value.ownerId}/${value.scrapeId}/` +
          `${value.checkpointId}.json`,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
      };
    }),
    readRootFile: vi.fn(async () => Buffer.from('{"cookies":[],"origins":[]}')),
    deleteReplayCheckpoint: vi.fn(async () => true),
    deleteRetainedProfileGeneration: vi.fn(async input => ({
      version: 1 as const,
      ...(input as {
        generationId: string;
        statePath: string;
        checksum: string;
      }),
      deleted: true,
    })),
    finalizePreparedGenerationByAuthorization: vi.fn(async input => ({
      version: 1,
      profileId: (input as { profileId: string }).profileId,
      generationId: (input as { generationId: string }).generationId,
      checksum: (input as { checksum: string }).checksum,
      committed: true,
    })),
    deletePreparedGenerationByAuthorization: vi.fn(async (input) => ({
      version: 1,
      profileId: (input as { profileId: string }).profileId,
      generationId: (input as { generationId: string }).generationId,
      checksum: (input as { checksum: string }).checksum,
      deleted: true,
    })),
  };
  const runtime = {
    binding,
    fenceRouteAdmission: vi.fn(() => {
      if (!routeAdmissionOpen) return;
      routeAdmissionOpen = false;
      order.push("routes");
    }),
    registry: registryOverride ?? registry,
    grants,
    artifacts,
    profileStore,
  } as unknown as BrowserGenerationRuntime;
  let installed: BrowserGenerationRuntime | null = runtime;
  const generation: ControlGenerationV1 = {
    version: 1,
    processNonce: PROCESS_NONCE,
    controlGenerationNonce: GENERATION_NONCE,
    apiInstanceId: IDS[2],
  };
  const reconciliationResult: ReconciliationResultV1 = {
    version: 1,
    processNonce: PROCESS_NONCE,
    controlGenerationNonce: GENERATION_NONCE,
    snapshotDigest: "b".repeat(64),
    retained: 0,
    removed: 0,
    missing: 0,
    corrupt: 0,
    ready: true,
  };
  const admission = {
    processNonce: PROCESS_NONCE,
    createControlGeneration: vi.fn(
      async (
        _input: unknown,
        _context: unknown,
        drain: (admission: {
          signal: AbortSignal;
          assertWaveActive(): void;
        }) => Promise<void>,
      ) => {
        await drain({
          signal: new AbortController().signal,
          assertWaveActive() {},
        });
        return generation;
      },
    ),
    requireReady: vi.fn((actual: typeof binding) => {
      if (
        actual.processNonce !== PROCESS_NONCE ||
        actual.controlGenerationNonce !== GENERATION_NONCE
      ) {
        throw new BrowserServiceError(
          "control_generation_mismatch",
          "control generation does not match",
        );
      }
      return { ...binding, snapshotDigest: "b".repeat(64) };
    }),
    liveHealth: vi.fn(() => ({
      version: 1,
      status: "ready",
      processNonce: PROCESS_NONCE,
    })),
    scopedLiveHealth: vi.fn(() => ({
      version: 1,
      status: "ready",
      ...binding,
    })),
    readyHealth: vi.fn(() => ({
      version: 1,
      status: "ready",
      ...binding,
      snapshotDigest: "b".repeat(64),
    })),
    reconcileWithAuthority: vi.fn(
      async (
        input: unknown,
        execute: (input: unknown, admission: unknown) => Promise<unknown>,
      ) => {
        await execute(input, {
          signal: new AbortController().signal,
          assertAdmitted() {},
        });
        return reconciliationResult;
      },
    ),
    beginDraining: vi.fn(),
    closeInstalledAuthority: vi.fn(async () => {
      order.push("authority");
    }),
  };
  const reconcile = vi.fn(async () => Object.freeze({}) as never);
  const service = createBrowserServiceServer({
    apiKey: API_KEY,
    admission: admission as never,
    runtime: {
      current: () => installed,
      release(expected) {
        if (installed === expected) installed = null;
      },
    },
    reconcile,
    internalErrorSink: (cause) => {
      internalErrors.push(cause);
    },
    sweepIntervalMs: 60_000,
  });
  return {
    service,
    admission,
    registry,
    runtimeRegistry: registryOverride ?? registry,
    grants,
    artifacts,
    profileStore,
    runtime,
    reconcile,
    internalErrors,
    order,
  };
}

const running: BrowserServiceServer[] = [];
const stateRoots: string[] = [];

async function provisionBrowserStateRoot(
  root: string,
  optionalDirectories: readonly ("quarantine" | "replay")[] = [],
): Promise<void> {
  await mkdir(join(root, "profiles"), { mode: 0o700 });
  await mkdir(join(root, ".profile-publish-staging"), { mode: 0o700 });
  await mkdir(join(root, ".profile-publish-staging", "bundles"), {
    mode: 0o700,
  });
  await mkdir(join(root, ".profile-publish-staging", "intents"), {
    mode: 0o700,
  });
  await Promise.all(
    optionalDirectories.map((directory) =>
      mkdir(join(root, directory), { mode: 0o700 }),
    ),
  );
}

function realApplication(
  stateRoot: string,
  startupAdmissionTimeoutMs?: number,
  internalErrorSink?: (cause: unknown) => void,
) {
  return createBrowserServiceApplication({
    config: {
      port: 0,
      apiKey: API_KEY,
      stateRoot,
      replayRoot: join(stateRoot, "replay"),
      profilesRoot: join(stateRoot, "profiles"),
      quarantineRoot: join(stateRoot, "quarantine"),
      maxBrowserSessions: 2,
    },
    atomicPublicationSink: vi.fn(),
    internalErrorSink,
    startupAdmissionTimeoutMs,
  });
}

async function stateRootDescriptors(stateRoot: string): Promise<string[]> {
  const descriptors: string[] = [];
  for (const descriptor of await readdir("/proc/self/fd")) {
    try {
      const target = await readlink(`/proc/self/fd/${descriptor}`);
      if (target.includes(stateRoot)) descriptors.push(target);
    } catch {
      // A descriptor can close between directory enumeration and readlink.
    }
  }
  return descriptors;
}

async function snapshotBrowserStateRoot(root: string) {
  const paths = [
    ".",
    "profiles",
    ".profile-publish-staging",
    ".profile-publish-staging/bundles",
    ".profile-publish-staging/intents",
  ] as const;
  return {
    rootEntries: (await readdir(root)).sort(),
    stagingEntries: (
      await readdir(join(root, ".profile-publish-staging"))
    ).sort(),
    metadata: await Promise.all(
      paths.map(async (relative) => {
        const metadata = await lstat(join(root, relative), {
          bigint: true,
        });
        return {
          relative,
          dev: String(metadata.dev),
          ino: String(metadata.ino),
          uid: String(metadata.uid),
          gid: String(metadata.gid),
          mode: Number(metadata.mode & 0o7777n),
          nlink: String(metadata.nlink),
          size: String(metadata.size),
          mtimeNs: String(metadata.mtimeNs),
          ctimeNs: String(metadata.ctimeNs),
        };
      }),
    ),
  };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.beginShutdown()));
  await Promise.all(
    stateRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function start(h: ReturnType<typeof harness>) {
  const address = await h.service.listen(0, "127.0.0.1");
  running.push(h.service);
  return `http://127.0.0.1:${address.port}`;
}

describe("private browser server", () => {
  test("rejects stale fencing before parsing a body or touching runtime", async () => {
    const h = harness();
    const base = await start(h);
    const response = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: requestHeaders({
        "x-firecrawl-control-generation-nonce": OLD_GENERATION_NONCE,
      }),
      body: "{",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      version: 1,
      category: "control_generation_mismatch",
    });
    expect(h.registry.create).not.toHaveBeenCalled();
  });

  test("mounts create, touch, action, and prepared close transport", async () => {
    const h = harness();
    const base = await start(h);
    const created = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        sessionId: IDS[0],
        initialUrl: "https://example.com/",
        allowedDomains: ["example.com"],
        ttlSeconds: 60,
        activityTtlSeconds: 30,
        profile: null,
        replay: null,
        settings: {
          headers: {},
          cookies: [],
          viewport: {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
          },
          userAgent: "server-test",
          locale: "en-US",
          timezoneId: "UTC",
          location: { country: "us", languages: ["en-US"] },
          proxy: { kind: "basic" },
          skipTlsVerification: false,
          blockAds: false,
          lockdown: true,
        },
      }),
    });
    expect(created.status).toBe(201);

    const touched = await fetch(`${base}/v1/sessions/${IDS[0]}`, {
      headers: requestHeaders(),
    });
    expect(touched.status).toBe(200);
    expect(h.registry.touch).toHaveBeenCalledWith(IDS[0]);

    const action = await fetch(`${base}/v1/sessions/${IDS[0]}/actions`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        actionId: IDS[1],
        runId: IDS[2],
        sequence: 1,
        normalizedProposalHash: "a".repeat(64),
        effect: "read_only",
        expectedSessionVersion: 0,
        allowedDomains: ["example.com"],
        operation: { kind: "extract" },
      }),
    });
    expect(action.status).toBe(200);
    expect(h.registry.executeAction).toHaveBeenCalledOnce();

    const closed = await fetch(`${base}/v1/sessions/${IDS[0]}`, {
      method: "DELETE",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        reason: "requested",
        expectedSessionVersion: 0,
      }),
    });
    expect(closed.status).toBe(200);
    expect(h.registry.close).toHaveBeenCalledWith(IDS[0], "requested");
    expect(h.artifacts.releaseSession).toHaveBeenCalledWith({
      ...binding,
      runtimeSessionId: IDS[0],
    });
  });

  test("streams an artifact with the exact metadata header set", async () => {
    const h = harness();
    const base = await start(h);
    const response = await fetch(`${base}/v1/sessions/${IDS[0]}/artifacts`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        artifactId: IDS[2],
        kind: "screenshot",
        format: "png",
        fullPage: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(response.headers.get(ARTIFACT_METADATA_HEADERS.artifactId)).toBe(
      IDS[2],
    );
    expect(response.headers.get(ARTIFACT_METADATA_HEADERS.checksum)).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
  });

  test("binds grant and profile transports to repeated route IDs", async () => {
    const h = harness();
    const base = await start(h);
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const created = await fetch(`${base}/v1/sessions/${IDS[0]}/grants`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        grantId: IDS[1],
        permission: "passive",
        expiresAt,
        useLimit: 1,
        expectedSessionVersion: 0,
        allowedDomains: ["example.com"],
      }),
    });
    expect(created.status).toBe(201);
    expect(h.grants.create).toHaveBeenCalledWith(
      IDS[0],
      expect.objectContaining({ grantId: IDS[1] }),
    );

    const revoked = await fetch(
      `${base}/v1/sessions/${IDS[0]}/grants/${IDS[1]}`,
      {
        method: "DELETE",
        headers: requestHeaders(),
        body: JSON.stringify({ version: 1, grantId: IDS[1] }),
      },
    );
    expect(revoked.status).toBe(200);

    const checksum = "c".repeat(64);
    const prepareToken = Buffer.alloc(32, 7).toString("base64url");
    const finalized = await fetch(
      `${base}/v1/profile-generations/${IDS[1]}/finalize`,
      {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          version: 1,
          profileId: IDS[0],
          generationId: IDS[1],
          checksum,
          prepareToken,
        }),
      },
    );
    expect(finalized.status).toBe(200);
    expect(
      h.profileStore.finalizePreparedGenerationByAuthorization,
    ).toHaveBeenCalledWith({
      profileId: IDS[0],
      generationId: IDS[1],
      checksum,
      prepareToken,
    });

    const mismatch = await fetch(`${base}/v1/profile-generations/${IDS[2]}`, {
      method: "DELETE",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        profileId: IDS[0],
        generationId: IDS[1],
        checksum,
        prepareToken,
      }),
    });
    expect(mismatch.status).toBe(400);
    expect(
      h.profileStore.deletePreparedGenerationByAuthorization,
    ).not.toHaveBeenCalled();

    const deleted = await fetch(`${base}/v1/profile-generations/${IDS[1]}`, {
      method: "DELETE",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        profileId: IDS[0],
        generationId: IDS[1],
        checksum,
        prepareToken,
      }),
    });
    expect(deleted.status).toBe(200);
    expect(
      h.profileStore.deletePreparedGenerationByAuthorization,
    ).toHaveBeenCalledWith({
      profileId: IDS[0],
      generationId: IDS[1],
      checksum,
      prepareToken,
    });

    const retentionPath = `profiles/${IDS[0]}/committed/${IDS[1]}`;
    const retained = await fetch(
      `${base}/v1/profile-generations/${IDS[1]}/retention`,
      {
        method: "DELETE",
        headers: requestHeaders(),
        body: JSON.stringify({
          version: 1,
          generationId: IDS[1],
          statePath: retentionPath,
          checksum,
        }),
      },
    );
    expect(retained.status).toBe(200);
    expect(h.profileStore.deleteRetainedProfileGeneration).toHaveBeenCalledWith(
      {
        version: 1,
        generationId: IDS[1],
        statePath: retentionPath,
        checksum,
      },
    );

    const retainedMismatch = await fetch(
      `${base}/v1/profile-generations/${IDS[2]}/retention`,
      {
        method: "DELETE",
        headers: requestHeaders(),
        body: JSON.stringify({
          version: 1,
          generationId: IDS[1],
          statePath: retentionPath,
          checksum,
        }),
      },
    );
    expect(retainedMismatch.status).toBe(400);
  });

  test("owns replay checkpoint persist, read, and delete bytes", async () => {
    const h = harness();
    const base = await start(h);
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState), "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const statePath = `replay/${IDS[0]}/${IDS[1]}/${IDS[2]}.json`;

    const persisted = await fetch(`${base}/v1/replay-checkpoints`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        ownerId: IDS[0],
        scrapeId: IDS[1],
        checkpointId: IDS[2],
        storageState,
      }),
    });
    expect(persisted.status).toBe(201);
    expect(await persisted.json()).toEqual({
      version: 1,
      statePath,
      checksum,
      byteSize: bytes.byteLength,
    });

    const loaded = await fetch(`${base}/v1/replay-checkpoints/read`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        statePath,
        checksum,
        byteSize: bytes.byteLength,
      }),
    });
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toEqual({
      version: 1,
      statePath,
      checksum,
      byteSize: bytes.byteLength,
      storageState,
    });

    const deleted = await fetch(`${base}/v1/replay-checkpoints`, {
      method: "DELETE",
      headers: requestHeaders(),
      body: JSON.stringify({ version: 1, statePath, checksum }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      version: 1,
      statePath,
      checksum,
      deleted: true,
    });
  });

  test("uses only the dedicated relay header and enforces ws maxPayload", async () => {
    const h = harness();
    h.grants.open.mockImplementationOnce(
      async (
        _input: unknown,
        upgrade: () => Promise<import("ws").WebSocket>,
      ) => {
        const socket = await upgrade();
        await new Promise<void>((resolve) =>
          socket.once("close", () => resolve()),
        );
      },
    );
    const base = await start(h);
    const relayToken = Buffer.alloc(32, 9).toString("base64url");
    const client = new ClientWebSocket(
      `${base.replace("http:", "ws:")}/v1/sessions/${IDS[0]}/streams/cdp`,
      {
        headers: {
          ...requestHeaders(),
          "x-firecrawl-relay-token": relayToken,
        },
      },
    );
    const closed = new Promise<number>((resolve, reject) => {
      client.once("open", () => {
        client.send(Buffer.alloc(256 * 1024 + 1), { binary: false });
      });
      client.once("close", (code) => resolve(code));
      client.once("error", reject);
    });
    await expect(closed).resolves.toBe(1009);
    expect(h.grants.open).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken,
        authority: {
          ...binding,
          authBinding: API_KEY,
        },
      }),
      expect.any(Function),
    );

    const fallback = new ClientWebSocket(
      `${base.replace("http:", "ws:")}/v1/sessions/${IDS[0]}/streams/cdp?relayToken=${relayToken}`,
      {
        headers: requestHeaders(),
      },
    );
    const rejected = new Promise<number>((resolve, reject) => {
      fallback.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      fallback.once("error", reject);
    });
    await expect(rejected).resolves.toBe(400);
    expect(h.grants.open).toHaveBeenCalledTimes(1);
  });

  test("closes ambiguous action transport and fail-stops its session", async () => {
    const h = harness();
    h.registry.executeAction.mockResolvedValueOnce({
      invalid: 1n,
    } as never);
    const base = await start(h);
    const request = fetch(`${base}/v1/sessions/${IDS[0]}/actions`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        actionId: IDS[1],
        runId: IDS[2],
        sequence: 1,
        normalizedProposalHash: "a".repeat(64),
        effect: "read_only",
        expectedSessionVersion: 0,
        allowedDomains: ["example.com"],
        operation: { kind: "extract" },
      }),
    });

    await expect(request).rejects.toThrow();
    expect(h.registry.close).toHaveBeenCalledWith(IDS[0], "error");
    expect(h.internalErrors).toHaveLength(1);
  });

  test.each([
    new Error("Chromium transport failed"),
    new Error("operation deadline exceeded"),
    new TypeError("operation result serialization failed"),
  ])(
    "fail-stops registry-side ambiguous action rejection: %s",
    async (rejection) => {
      const h = harness();
      h.registry.executeAction.mockRejectedValueOnce(rejection);
      const base = await start(h);
      const response = fetch(`${base}/v1/sessions/${IDS[0]}/actions`, {
        method: "POST",
        headers: requestHeaders(),
        body: validActionBody(),
      });

      await expect(response).rejects.toThrow();
      expect(h.registry.close).toHaveBeenCalledWith(IDS[0], "error");
      expect(h.artifacts.releaseSession).toHaveBeenCalledWith({
        ...binding,
        runtimeSessionId: IDS[0],
      });
      expect(h.internalErrors).toEqual([rejection]);
    },
  );

  test("executes sequence one independently for sequential action runs", async () => {
    const real = realRegistryFixture();
    const created = await real.registry.create(validSessionCreateRequest());
    const h = harness(real.registry);
    const base = await start(h);
    const endpoint = `${base}/v1/sessions/${created.runtimeSessionId}/actions`;
    const firstBody = realActionBody();

    const first = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(),
      body: firstBody,
    });
    expect(first.status).toBe(200);
    const firstResult = await first.json();
    expect(firstResult).toMatchObject({
      actionId: IDS[1],
      sequence: 1,
      outcome: "succeeded",
      sessionVersion: 2,
    });

    const firstReplay = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(),
      body: firstBody,
    });
    expect(firstReplay.status).toBe(200);
    expect(await firstReplay.json()).toEqual(firstResult);

    const secondBody = realActionBody(
      { kind: "extract" },
      {
        actionId: IDS[3],
        runId: IDS[4],
        expectedSessionVersion: 2,
      },
    );
    const second = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(),
      body: secondBody,
    });
    expect(second.status).toBe(200);
    const secondResult = await second.json();
    expect(secondResult).toMatchObject({
      actionId: IDS[3],
      sequence: 1,
      outcome: "succeeded",
      sessionVersion: 3,
    });

    const secondReplay = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(),
      body: secondBody,
    });
    expect(secondReplay.status).toBe(200);
    expect(await secondReplay.json()).toEqual(secondResult);
    expect(real.registry.entries()).toHaveLength(1);
  });

  test("fail-stops a real registry Chromium rejection with no usable cache", async () => {
    const real = realRegistryFixture();
    const created = await real.registry.create(validSessionCreateRequest());
    expect(created.runtimeSessionId).toBe(IDS[1]);
    const h = harness(real.registry);
    const base = await start(h);
    const chromiumFailure = new Error("Chromium transport failed");
    real.rejectPageUrlWith(chromiumFailure);
    const first = fetch(
      `${base}/v1/sessions/${created.runtimeSessionId}/actions`,
      {
        method: "POST",
        headers: requestHeaders(),
        body: realActionBody(),
      },
    );

    await expect(first).rejects.toThrow();
    expect(real.registry.entries()).toEqual([]);
    expect(h.grants.inventory()).toEqual({ grants: 0, streams: 0 });
    expect(h.artifacts.releaseSession).toHaveBeenCalledWith({
      ...binding,
      runtimeSessionId: created.runtimeSessionId,
    });
    expect(h.internalErrors).toContain(chromiumFailure);

    const replay = await fetch(
      `${base}/v1/sessions/${created.runtimeSessionId}/actions`,
      {
        method: "POST",
        headers: requestHeaders(),
        body: realActionBody(),
      },
    );
    expect(replay.status).toBe(404);
    expect(await replay.json()).toMatchObject({
      category: "session_not_found",
    });
  });

  test("fail-stops a real registry operation timeout", async () => {
    const real = realRegistryFixture();
    const created = await real.registry.create(validSessionCreateRequest());
    real.hangPageWait();
    const h = harness(real.registry);
    const base = await start(h);
    const response = fetch(
      `${base}/v1/sessions/${created.runtimeSessionId}/actions`,
      {
        method: "POST",
        headers: requestHeaders(),
        body: realActionBody({ kind: "wait", milliseconds: 1 }),
      },
    );

    await expect(response).rejects.toThrow();
    expect(real.registry.entries()).toEqual([]);
    expect(h.internalErrors).toHaveLength(1);
  });

  test("fail-stops a real registry result serialization rejection", async () => {
    const real = realRegistryFixture();
    const created = await real.registry.create(validSessionCreateRequest());
    const serializationFailure = new TypeError(
      "page state serialization failed",
    );
    real.rejectPageTitleWith(serializationFailure);
    const h = harness(real.registry);
    const base = await start(h);
    const response = fetch(
      `${base}/v1/sessions/${created.runtimeSessionId}/actions`,
      {
        method: "POST",
        headers: requestHeaders(),
        body: realActionBody(),
      },
    );

    await expect(response).rejects.toThrow();
    expect(real.registry.entries()).toEqual([]);
    expect(h.internalErrors).toContain(serializationFailure);
  });

  test("destroys ambiguous action transport when cleanup also rejects", async () => {
    const h = harness();
    const rejection = new Error("Chromium transport failed");
    const cleanupFailure = new Error("Chromium close failed");
    h.registry.executeAction.mockRejectedValueOnce(rejection);
    h.registry.close.mockRejectedValueOnce(cleanupFailure);
    const base = await start(h);
    const response = fetch(`${base}/v1/sessions/${IDS[0]}/actions`, {
      method: "POST",
      headers: requestHeaders(),
      body: validActionBody(),
    });

    await expect(response).rejects.toThrow();
    expect(h.artifacts.releaseSession).toHaveBeenCalledOnce();
    expect(h.internalErrors).toHaveLength(1);
    expect(h.internalErrors[0]).toBeInstanceOf(AggregateError);
    expect((h.internalErrors[0] as AggregateError).errors).toEqual([
      rejection,
      expect.any(AggregateError),
    ]);
    expect(
      ((h.internalErrors[0] as AggregateError).errors[1] as AggregateError)
        .errors,
    ).toContain(cleanupFailure);
  });

  test("serializes typed proven-no-effect registry rejection", async () => {
    const h = harness();
    h.registry.executeAction.mockRejectedValueOnce(
      new SessionRegistryError(
        "concurrency_exceeded",
        "session writer is already held",
      ),
    );
    const base = await start(h);
    const response = await fetch(`${base}/v1/sessions/${IDS[0]}/actions`, {
      method: "POST",
      headers: requestHeaders(),
      body: validActionBody(),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      category: "concurrency_exceeded",
    });
    expect(h.registry.close).not.toHaveBeenCalled();
    expect(h.internalErrors).toEqual([]);
  });

  test("does not dispatch an action when transport closes before dispatch", async () => {
    const h = harness();
    const base = await start(h);
    const target = new URL(`/v1/sessions/${IDS[0]}/actions`, base);
    const request = httpRequest(target, {
      method: "POST",
      headers: {
        ...requestHeaders(),
        "content-length": validActionBody().length + 10,
      },
    });
    request.on("error", () => undefined);
    request.write(validActionBody().slice(0, 20));
    request.destroy();

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.registry.executeAction).not.toHaveBeenCalled();
    expect(h.registry.close).not.toHaveBeenCalled();
  });

  test("fail-stops an action when transport closes after dispatch", async () => {
    const h = harness();
    const action =
      deferred<Awaited<ReturnType<typeof h.registry.executeAction>>>();
    h.registry.executeAction.mockImplementationOnce(() => action.promise);
    const base = await start(h);
    const target = new URL(`/v1/sessions/${IDS[0]}/actions`, base);
    const request = httpRequest(target, {
      method: "POST",
      headers: {
        ...requestHeaders(),
        "content-length": Buffer.byteLength(validActionBody(), "utf8"),
      },
    });
    request.on("error", () => undefined);
    let clientSocket: import("node:net").Socket | undefined;
    request.once("socket", (socket) => {
      clientSocket = socket;
    });
    request.end(validActionBody());
    await vi.waitFor(() =>
      expect(h.registry.executeAction).toHaveBeenCalledOnce(),
    );

    clientSocket!.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    action.resolve({
      version: 1,
      actionId: IDS[1],
      sequence: 1,
      normalizedProposalHash: "a".repeat(64),
      outcome: "succeeded",
      result: { kind: "extract", text: "Example" },
      page: session.page,
      sessionVersion: 0,
    });

    await vi.waitFor(() =>
      expect(h.registry.close).toHaveBeenCalledWith(IDS[0], "error"),
    );
    expect(h.artifacts.releaseSession).toHaveBeenCalledWith({
      ...binding,
      runtimeSessionId: IDS[0],
    });
  });

  test("maps reconciliation ingress failures before filesystem execution", async () => {
    const h = harness();
    const base = await start(h);
    const malformed = await fetch(`${base}/v1/reconciliation`, {
      method: "POST",
      headers: requestHeaders(),
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      category: "reconciliation_snapshot_invalid",
    });

    const excessive = await fetch(`${base}/v1/reconciliation`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        version: 1,
        processNonce: PROCESS_NONCE,
        controlGenerationNonce: GENERATION_NONCE,
        snapshotDigest: "b".repeat(64),
        references: Array.from(
          { length: MAX_RECONCILIATION_REFERENCES + 1 },
          () => ({}),
        ),
      }),
    });
    expect(excessive.status).toBe(413);
    expect(await excessive.json()).toMatchObject({
      category: "reconciliation_snapshot_too_large",
    });

    const bodyMismatch = await fetch(`${base}/v1/reconciliation`, {
      method: "POST",
      headers: requestHeaders(),
      body: validReconciliationBody(OLD_GENERATION_NONCE),
    });
    expect(bodyMismatch.status).toBe(409);
    expect(await bodyMismatch.json()).toMatchObject({
      category: "reconciliation_nonce_mismatch",
    });

    const generationMismatch = await fetch(`${base}/v1/reconciliation`, {
      method: "POST",
      headers: requestHeaders(),
      body: validReconciliationBody(PROCESS_NONCE, OLD_GENERATION_NONCE),
    });
    expect(generationMismatch.status).toBe(409);
    expect(await generationMismatch.json()).toMatchObject({
      category: "control_generation_mismatch",
    });
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  test("aborts admitted reconciliation when its transport closes", async () => {
    const h = harness();
    const observed = deferred<AbortSignal>();
    h.reconcile.mockImplementationOnce(async (_request, admission) => {
      observed.resolve(admission.signal);
      await new Promise<void>((resolve) =>
        admission.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      admission.assertAdmitted();
      return Object.freeze({}) as never;
    });
    const base = await start(h);
    const body = validReconciliationBody();
    const request = httpRequest(new URL("/v1/reconciliation", base), {
      method: "POST",
      headers: {
        ...requestHeaders(),
        "content-length": Buffer.byteLength(body, "utf8"),
      },
    });
    request.on("error", () => undefined);
    request.end(body);
    const signal = await observed.promise;
    request.destroy();

    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  test.each([
    ["invalid_request", 400],
    ["replay_unavailable", 409],
    ["replay_unsupported", 409],
    ["concurrency_exceeded", 429],
    ["session_not_found", 404],
  ] as const)("maps registry %s to canonical %i", async (category, status) => {
    const h = harness();
    h.registry.create.mockRejectedValueOnce(
      new SessionRegistryError(category, "session policy rejected"),
    );
    const base = await start(h);
    const response = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(validSessionCreateRequest()),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      category,
    });
  });

  test("authenticates and fences unknown private routes before 400", async () => {
    const h = harness();
    const base = await start(h);
    const unauthorized = await fetch(`${base}/v1/private-unknown`, {
      method: "PUT",
      headers: requestHeaders({ authorization: "Bearer wrong" }),
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const stale = await fetch(`${base}/v1/private-unknown`, {
      method: "PUT",
      headers: requestHeaders({
        "x-firecrawl-control-generation-nonce": OLD_GENERATION_NONCE,
      }),
      body: "{}",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      category: "control_generation_mismatch",
    });
    expect(h.registry.create).not.toHaveBeenCalled();
    expect(h.registry.executeAction).not.toHaveBeenCalled();
    expect(h.artifacts.capture).not.toHaveBeenCalled();
  });

  test("fences wrong methods on bootstrap paths before route errors", async () => {
    const h = harness();
    const base = await start(h);
    const staleHeaders = requestHeaders({
      "x-firecrawl-control-generation-nonce": OLD_GENERATION_NONCE,
    });
    const wrongLiveMethod = await fetch(`${base}/health/live`, {
      method: "POST",
      headers: staleHeaders,
      body: "{}",
    });
    expect(wrongLiveMethod.status).toBe(409);
    expect(await wrongLiveMethod.json()).toMatchObject({
      category: "control_generation_mismatch",
    });

    const wrongControlMethod = await fetch(`${base}/v1/control-generations`, {
      method: "GET",
      headers: staleHeaders,
    });
    expect(wrongControlMethod.status).toBe(409);
    expect(await wrongControlMethod.json()).toMatchObject({
      category: "control_generation_mismatch",
    });
    expect(h.admission.createControlGeneration).not.toHaveBeenCalled();
  });

  test("drains streams, artifacts, then registry before handoff response", async () => {
    const h = harness();
    const base = await start(h);
    const response = await fetch(`${base}/v1/control-generations`, {
      method: "POST",
      headers: requestHeaders({
        "x-firecrawl-process-nonce": "",
        "x-firecrawl-control-generation-nonce": "",
      }),
      body: JSON.stringify({
        version: 1,
        processNonce: PROCESS_NONCE,
        apiInstanceId: IDS[2],
        idempotencyKey: Buffer.alloc(32, 4).toString("base64url"),
      }),
    });

    expect(response.status).toBe(201);
    expect(h.order).toEqual(["routes", "streams", "artifacts", "registry"]);
  });

  test("replacement handoff drains a retained API writer session", async () => {
    const real = realRegistryFixture();
    const created = await real.registry.create(validSessionCreateRequest());
    const writerStarted = real.holdPageTextUntilContextClose();
    const h = harness(real.registry);
    const base = await start(h);
    const writer = fetch(
      `${base}/v1/sessions/${created.runtimeSessionId}/actions`,
      {
        method: "POST",
        headers: requestHeaders(),
        body: realActionBody({ kind: "extract" }),
      },
    );
    const writerRejected = expect(writer).rejects.toThrow();
    await writerStarted;
    const replacement = fetch(`${base}/v1/control-generations`, {
      method: "POST",
      headers: bootstrapHeaders(),
      body: JSON.stringify({
        version: 1,
        processNonce: PROCESS_NONCE,
        apiInstanceId: IDS[2],
        idempotencyKey: Buffer.alloc(32, 4).toString("base64url"),
      }),
    });

    await writerRejected;
    const response = await replacement;
    expect(response.status).toBe(201);
    expect(real.registry.entries()).toEqual([]);
    expect(h.internalErrors).toHaveLength(1);
    expect(h.order).toEqual(["routes", "streams", "artifacts"]);
  });

  test("validates the held state root before binding and stays unreconciled", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    stateRoots.push(stateRoot);
    await provisionBrowserStateRoot(stateRoot, ["quarantine", "replay"]);
    const application = realApplication(stateRoot);

    await application.start();
    running.push(application.server);

    const address = application.server.address();
    expect(address).not.toBeNull();
    const response = await fetch(
      `http://127.0.0.1:${address!.port}/health/live`,
      { headers: bootstrapHeaders() },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "live_unreconciled",
      processNonce: application.admission.processNonce,
    });
  });

  test("rejects unsafe startup metadata without binding or mutation", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    stateRoots.push(stateRoot);
    await provisionBrowserStateRoot(stateRoot);
    await chmod(join(stateRoot, "profiles"), 0o755);
    const before = await snapshotBrowserStateRoot(stateRoot);
    const application = realApplication(stateRoot);

    await expect(application.start()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });

    expect(application.server.address()).toBeNull();
    expect(await snapshotBrowserStateRoot(stateRoot)).toEqual(before);
  });

  test("rejects a missing reserved layout without binding or creation", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    stateRoots.push(stateRoot);
    const before = await readdir(stateRoot);
    const application = realApplication(stateRoot);

    await expect(application.start()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });

    expect(application.server.address()).toBeNull();
    expect(await readdir(stateRoot)).toEqual(before);
  });

  test.runIf(process.geteuid?.() !== 0)(
    "rejects an inaccessible parent without binding or mutation",
    async () => {
      const container = await mkdtemp(join(tmpdir(), "browser-server-denied-"));
      stateRoots.push(container);
      const stateRoot = join(container, "state");
      await mkdir(stateRoot, { mode: 0o700 });
      await provisionBrowserStateRoot(stateRoot);
      const before = await snapshotBrowserStateRoot(stateRoot);
      const application = realApplication(stateRoot);
      await chmod(container, 0o000);

      try {
        await expect(application.start()).rejects.toMatchObject({
          category: "reconciliation_filesystem_unsafe",
        });
        expect(application.server.address()).toBeNull();
      } finally {
        await chmod(container, 0o700);
      }
      expect(await snapshotBrowserStateRoot(stateRoot)).toEqual(before);
    },
  );

  test("rejects disallowed startup filesystems before binding", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    stateRoots.push(stateRoot);
    await provisionBrowserStateRoot(stateRoot);
    const application = realApplication(stateRoot);

    await expect(
      runWithReconciliationFilesystemTestContext(
        { atomicStatfsScenario: "disallowed" },
        () => application.start(),
      ),
    ).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });

    expect(application.server.address()).toBeNull();
  });

  test("rejects a startup root replacement race before binding", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    const displaced = `${stateRoot}-displaced`;
    stateRoots.push(stateRoot, displaced);
    await provisionBrowserStateRoot(stateRoot);
    const application = realApplication(stateRoot);
    let swapped = false;

    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "open-root" || swapped) return;
            swapped = true;
            await rename(stateRoot, displaced);
            await mkdir(stateRoot, { mode: 0o700 });
            await provisionBrowserStateRoot(stateRoot);
          },
        },
        () => application.start(),
      ),
    ).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });

    expect(swapped).toBe(true);
    expect(application.server.address()).toBeNull();
  });

  test("bounds startup admission and cancels held filesystem work before bind", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    stateRoots.push(stateRoot);
    await provisionBrowserStateRoot(stateRoot);
    const before = await snapshotBrowserStateRoot(stateRoot);
    const application = realApplication(stateRoot, 25);
    const entered = deferred<void>();
    const release = deferred<void>();
    let blocked = false;

    const start = runWithReconciliationFilesystemTestContext(
      {
        async beforeCall(point) {
          if (point !== "open-root" || blocked) return;
          blocked = true;
          entered.resolve();
          await release.promise;
        },
      },
      () => application.start(),
    );
    await entered.promise;
    await expect(start).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
      message: "browser state root startup validation deadline exceeded",
    });
    expect(application.server.address()).toBeNull();

    release.resolve();
    await vi.waitFor(async () => {
      expect(await stateRootDescriptors(stateRoot)).toEqual([]);
    });
    expect(await snapshotBrowserStateRoot(stateRoot)).toEqual(before);
  });

  test("shutdown cancels startup admission without binding a listener", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    stateRoots.push(stateRoot);
    await provisionBrowserStateRoot(stateRoot);
    const application = realApplication(stateRoot, 60_000);
    const entered = deferred<void>();
    const release = deferred<void>();
    let blocked = false;

    const start = runWithReconciliationFilesystemTestContext(
      {
        async beforeCall(point) {
          if (point !== "open-root" || blocked) return;
          blocked = true;
          entered.resolve();
          await release.promise;
        },
      },
      () => application.start(),
    );
    await entered.promise;
    await application.shutdown();
    await expect(start).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
      message: "browser state root startup validation cancelled",
    });
    expect(application.server.address()).toBeNull();

    release.resolve();
    await vi.waitFor(async () => {
      expect(await stateRootDescriptors(stateRoot)).toEqual([]);
    });
  });

  test("attempts root cleanup after atomic controller close failure", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-start-"));
    stateRoots.push(stateRoot);
    await provisionBrowserStateRoot(stateRoot);
    const application = realApplication(stateRoot, 1_000);
    let injected = false;
    let rootCloseAttempted = false;

    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeClose(point) {
            if (point === "root") rootCloseAttempted = true;
            if (!injected && point === "atomic-controller-close") {
              injected = true;
              throw new Error("injected atomic controller close failure");
            }
          },
        },
        () => application.start(),
      ),
    ).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(injected).toBe(true);
    expect(rootCloseAttempted).toBe(true);
    expect(application.server.address()).toBeNull();
    expect(await stateRootDescriptors(stateRoot)).toEqual([]);
  });

  test("wires real application handoff, reconciliation, runtime, and shutdown", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "browser-server-app-"));
    stateRoots.push(stateRoot);
    await provisionBrowserStateRoot(stateRoot);
    const application = realApplication(stateRoot);
    await application.start();
    running.push(application.server);
    const address = application.server.address();
    expect(address).not.toBeNull();
    const base = `http://127.0.0.1:${address!.port}`;
    const handedOff = await fetch(`${base}/v1/control-generations`, {
      method: "POST",
      headers: bootstrapHeaders(),
      body: JSON.stringify({
        version: 1,
        processNonce: application.admission.processNonce,
        apiInstanceId: IDS[2],
        idempotencyKey: Buffer.alloc(32, 4).toString("base64url"),
      }),
    });
    expect(handedOff.status).toBe(201);
    const generation = (await handedOff.json()) as ControlGenerationV1;
    const staleCleanupPath = `replay/${IDS[0]}/${IDS[1]}/${IDS[0]}.json`;
    const staleCleanupChecksum = "d".repeat(64);
    const references = [
      {
        kind: "replay_checkpoint_cleanup_intent" as const,
        id: IDS[0],
        path: staleCleanupPath,
        checksum: staleCleanupChecksum,
      },
    ];
    const snapshotDigest =
      canonicalizeReconciliationSnapshot(references).snapshotDigest;
    const reconciled = await fetch(`${base}/v1/reconciliation`, {
      method: "POST",
      headers: {
        ...bootstrapHeaders(),
        "x-firecrawl-process-nonce": generation.processNonce,
        "x-firecrawl-control-generation-nonce":
          generation.controlGenerationNonce,
      },
      body: JSON.stringify({
        version: 1,
        processNonce: generation.processNonce,
        controlGenerationNonce: generation.controlGenerationNonce,
        snapshotDigest,
        references,
      }),
    });
    const reconciledBody = await reconciled.json();
    expect(reconciled.status, JSON.stringify(reconciledBody)).toBe(200);
    expect(reconciledBody).toMatchObject({
      ready: true,
      snapshotDigest,
    });
    expect(application.currentRuntime()?.binding).toEqual({
      processNonce: generation.processNonce,
      controlGenerationNonce: generation.controlGenerationNonce,
    });
    const generationHeaders = {
      ...requestHeaders(),
      "x-firecrawl-process-nonce": generation.processNonce,
      "x-firecrawl-control-generation-nonce":
        generation.controlGenerationNonce,
    };
    const convergedCleanup = await fetch(
      `${base}/v1/replay-checkpoints`,
      {
        method: "DELETE",
        headers: generationHeaders,
        body: JSON.stringify({
          version: 1,
          statePath: staleCleanupPath,
          checksum: staleCleanupChecksum,
        }),
      },
    );
    expect(convergedCleanup.status, await convergedCleanup.text()).toBe(200);
    const storageState = { cookies: [], origins: [] };
    const checkpointBytes = Buffer.from(canonicalJson(storageState), "utf8");
    const checkpointChecksum = createHash("sha256")
      .update(checkpointBytes)
      .digest("hex");
    const checkpointPath = `replay/${IDS[0]}/${IDS[1]}/${IDS[2]}.json`;
    const persisted = await fetch(`${base}/v1/replay-checkpoints`, {
      method: "POST",
      headers: generationHeaders,
      body: JSON.stringify({
        version: 1,
        ownerId: IDS[0],
        scrapeId: IDS[1],
        checkpointId: IDS[2],
        storageState,
      }),
    });
    expect(persisted.status, await persisted.text()).toBe(201);
    const deleted = await fetch(`${base}/v1/replay-checkpoints`, {
      method: "DELETE",
      headers: generationHeaders,
      body: JSON.stringify({
        version: 1,
        statePath: checkpointPath,
        checksum: checkpointChecksum,
      }),
    });
    expect(deleted.status, await deleted.text()).toBe(200);

    const replacement = await fetch(`${base}/v1/control-generations`, {
      method: "POST",
      headers: bootstrapHeaders(),
      body: JSON.stringify({
        version: 1,
        processNonce: application.admission.processNonce,
        apiInstanceId: IDS[1],
        idempotencyKey: Buffer.alloc(32, 5).toString("base64url"),
      }),
    });
    expect(replacement.status).toBe(201);
    expect(application.currentRuntime()).toBeNull();
    const stalePersist = await fetch(`${base}/v1/replay-checkpoints`, {
      method: "POST",
      headers: generationHeaders,
      body: JSON.stringify({
        version: 1,
        ownerId: IDS[0],
        scrapeId: IDS[1],
        checkpointId: IDS[2],
        storageState,
      }),
    });
    expect(stalePersist.status).toBe(409);
    const staleReady = await fetch(`${base}/health/ready`, {
      headers: {
        ...bootstrapHeaders(),
        "x-firecrawl-process-nonce": generation.processNonce,
        "x-firecrawl-control-generation-nonce":
          generation.controlGenerationNonce,
      },
    });
    expect(staleReady.status).toBe(409);

    await application.shutdown();

    expect(application.currentRuntime()).toBeNull();
  });

  test(
    "real handoff drains a retained writer profile and unused grants",
    { timeout: 15_000 },
    async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), "browser-server-retained-"),
      );
      stateRoots.push(stateRoot);
      await provisionBrowserStateRoot(stateRoot);
      const internalErrors: unknown[] = [];
      const application = realApplication(stateRoot, undefined, cause =>
        internalErrors.push(cause),
      );
      await application.start();
      running.push(application.server);
      const address = application.server.address();
      expect(address).not.toBeNull();
      const base = `http://127.0.0.1:${address!.port}`;

      const firstHandoff = await fetch(`${base}/v1/control-generations`, {
        method: "POST",
        headers: bootstrapHeaders(),
        body: JSON.stringify({
          version: 1,
          processNonce: application.admission.processNonce,
          apiInstanceId: IDS[0],
          idempotencyKey: Buffer.alloc(32, 3).toString("base64url"),
        }),
      });
      expect(firstHandoff.status).toBe(201);
      const firstGeneration =
        (await firstHandoff.json()) as ControlGenerationV1;
      const snapshotDigest = canonicalizeReconciliationSnapshot(
        [],
      ).snapshotDigest;
      const reconciled = await fetch(`${base}/v1/reconciliation`, {
        method: "POST",
        headers: {
          ...bootstrapHeaders(),
          "x-firecrawl-process-nonce": firstGeneration.processNonce,
          "x-firecrawl-control-generation-nonce":
            firstGeneration.controlGenerationNonce,
        },
        body: JSON.stringify({
          version: 1,
          processNonce: firstGeneration.processNonce,
          controlGenerationNonce: firstGeneration.controlGenerationNonce,
          snapshotDigest,
          references: [],
        }),
      });
      expect(reconciled.status).toBe(200);
      const generationHeaders = {
        ...requestHeaders(),
        "x-firecrawl-process-nonce": firstGeneration.processNonce,
        "x-firecrawl-control-generation-nonce":
          firstGeneration.controlGenerationNonce,
      };
      const createdResponse = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: generationHeaders,
        body: JSON.stringify({
          ...validSessionCreateRequest(),
          initialUrl: "about:blank",
          allowedDomains: [],
          profile: {
            profileId: IDS[2],
            mode: "writer",
            generationId: null,
            statePath: null,
            checksum: null,
          },
        }),
      });
      const createdBody = await createdResponse.text();
      expect(createdResponse.status, createdBody).toBe(201);
      const created = JSON.parse(createdBody) as SessionV1;
      for (const [index, permission] of (
        ["passive", "interactive", "cdp"] as const
      ).entries()) {
        const grant = await fetch(
          `${base}/v1/sessions/${created.runtimeSessionId}/grants`,
          {
            method: "POST",
            headers: generationHeaders,
            body: JSON.stringify({
              version: 1,
              grantId: IDS[index],
              permission,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
              useLimit: 1,
              expectedSessionVersion: created.sessionVersion,
              allowedDomains: [],
            }),
          },
        );
        expect(grant.status, await grant.text()).toBe(201);
      }

      const replacement = await fetch(`${base}/v1/control-generations`, {
        method: "POST",
        headers: bootstrapHeaders(),
        body: JSON.stringify({
          version: 1,
          processNonce: application.admission.processNonce,
          apiInstanceId: IDS[1],
          idempotencyKey: Buffer.alloc(32, 4).toString("base64url"),
        }),
      });
      const replacementBody = await replacement.text();
      expect(
        replacement.status,
        `${replacementBody}\n${String(internalErrors[0])}`,
      ).toBe(201);
      expect(internalErrors).toEqual([]);
      expect(application.currentRuntime()).toBeNull();
      await expect(
        readdir(join(stateRoot, "profiles", IDS[2], "working")),
      ).resolves.toEqual([]);
      await expect(
        readdir(join(stateRoot, "profiles", IDS[2], "staging")),
      ).resolves.toEqual([]);
      await expect(
        readdir(join(stateRoot, ".profile-publish-staging", "bundles")),
      ).resolves.toEqual([]);
      await expect(
        readdir(join(stateRoot, ".profile-publish-staging", "intents")),
      ).resolves.toEqual([]);
    },
  );

  test("shutdown closes admission synchronously and preserves drain order", async () => {
    const h = harness();
    await start(h);
    const shutdown = h.service.beginShutdown();
    expect(h.admission.beginDraining).toHaveBeenCalledOnce();
    await h.service.listenerClosed();
    await shutdown;
    expect(h.order).toEqual([
      "routes",
      "streams",
      "artifacts",
      "registry",
      "authority",
    ]);
  });
});
