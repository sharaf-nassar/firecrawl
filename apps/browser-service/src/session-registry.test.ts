import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { canonicalJson } from "./contracts.js";
import { ProfileStoreError } from "./profile-store.js";
import {
  UnverifiedChromiumLaunchError,
  type ChromiumSessionAttachment,
} from "./reconciliation.js";
import {
  TrustedPreSpawnLaunchError,
  captureSessionArtifact,
  closeSessionCdpChannel,
  createSessionRegistry,
  openSessionCdpChannel,
  sendSessionCdpCommand,
  subscribeSessionCdpEvent,
  sessionRuntimeSignal,
} from "./session-registry.js";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    sessionId: IDS[0]!,
    initialUrl: "https://example.com/",
    allowedDomains: ["example.com"],
    ttlSeconds: 60,
    activityTtlSeconds: 10,
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
      userAgent: "Browser Service Test",
      locale: "en-US",
      location: { country: "us-generic", languages: ["en-US"] },
      proxy: { kind: "auto" as const },
      skipTlsVerification: false,
      blockAds: false,
      lockdown: true,
    },
    ...overrides,
  };
}

function harness(
  _stateRoot?: string,
  afterChromiumAttachment?: () => void,
  registryOptions: {
    cleanupTimeoutMs?: number;
    launchTimeoutMs?: number;
    operationTimeoutMs?: number;
    afterRuntimeLeaseSnapshot?: () => Promise<void>;
    createRecordingProducer?: () => Promise<{
      snapshot(): Promise<Uint8Array>;
      subscribe(listener: (frame: unknown) => void): () => void;
      close(): Promise<void>;
    }>;
  } = {},
) {
  let now = 1_700_000_000_000;
  let ready = true;
  let id = 1;
  let pageUrl = "about:blank";
  let context: Record<string, unknown>;
  const mainFrame = Object.freeze({});
  const bodyLocator = {
    innerText: vi.fn(async () => ""),
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(async () => [
      {
        connected: true,
        tag: "BODY",
        role: "",
        name: "",
        text: "",
      },
    ]),
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
    url: vi.fn(() => pageUrl),
    title: vi.fn(async () => ""),
    textContent: vi.fn(async () => ""),
    locator: vi.fn((selector: string) =>
      selector === "body" ? bodyLocator : emptyElementsLocator,
    ),
    waitForTimeout: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from("image")),
    evaluateHandle: vi.fn(async () => ({
      evaluate: vi.fn(async () => []),
      getProperties: vi.fn(async () => new Map()),
      dispose: vi.fn(async () => undefined),
    })),
    on: vi.fn(),
    off: vi.fn(),
    mainFrame: vi.fn(() => mainFrame),
    context: vi.fn(() => context),
  };
  const cdp = {
    send: vi.fn(async (method: string) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : { ok: true },
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
  context = {
    pages: vi.fn(() => [page]),
    serviceWorkers: vi.fn(() => []),
    close: vi.fn(async () => undefined),
    browser: vi.fn(() => null),
    setStorageState: vi.fn(async () => undefined),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    newCDPSession: vi.fn(async () => cdp),
    tracing,
  };
  const gate = {
    state: "restore_closed" as "restore_closed" | "open" | "closed",
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
    open: vi.fn(function (this: typeof gate) {
      this.state = "open";
    }),
    close: vi.fn(function (this: typeof gate) {
      this.state = "closed";
    }),
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
      state: gate.state,
      counters: {
        ingressAttempts: 0,
        ingressViolations: 0,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      },
    })),
  };
  const work = {
    profileId: IDS[0]!,
    generationId: IDS[2]!,
    sessionId: IDS[0]!,
    mode: "snapshot" as const,
    path: "/tmp/work",
  };
  const profileStore = {
    workingGeneration: vi.fn(() => Object.freeze({})),
    readRootFile: vi.fn(async (relative: string) => {
      if (_stateRoot === undefined) throw new Error("state root unavailable");
      return readFile(join(_stateRoot, relative));
    }),
    createWorkingCopy: vi.fn(
      async (
        _profileId: string,
        _base: string | null,
        mode: "writer" | "snapshot",
      ) => ({ ...work, mode }),
    ),
    discardWorkingCopy: vi.fn(async () => undefined),
    prepareWorkingCopy: vi.fn(async () => ({
      profileId: IDS[0]!,
      generationId: IDS[2]!,
      checksum: "a".repeat(64),
      byteSize: 1,
      prepareToken: Buffer.alloc(32, 9).toString("base64url"),
    })),
    finalizePreparedGeneration: vi.fn(async () => ({
      version: 1 as const,
      profileId: IDS[0]!,
      generationId: IDS[2]!,
      checksum: "a".repeat(64),
      committed: true as const,
    })),
  };
  const proxy = {
    url: "http://127.0.0.1:1234",
    port: 1234,
    restoreGate: gate,
    close: vi.fn(async () => undefined),
    liveSocketCount: () => 0,
  };
  const launchPersistentContext = vi.fn(async () => Object.freeze({ context }));
  const contextCloseAttempted = new WeakSet<object>();
  const releaseChromiumSessionAttachment = vi.fn(
    async (attachment: { context: typeof context }) => {
      if (!contextCloseAttempted.has(attachment)) {
        contextCloseAttempted.add(attachment);
        try {
          await attachment.context.close();
          return;
        } catch {
          // Retry only the public Browser close below.
        }
      }
      const browser = attachment.context.browser();
      if (browser === null) throw new Error("Chromium close is unverified");
      await browser.close();
      if (browser.isConnected()) {
        throw new Error("Chromium close is unverified");
      }
    },
  );
  const proxyFactory = vi.fn(async () => proxy);
  const beginDraining = vi.fn(() => {
    ready = false;
  });
  const recordingProducer = {
    snapshot: vi.fn(async () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])),
    subscribe: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
  const createRecordingProducer =
    registryOptions.createRecordingProducer ??
    vi.fn(async () => recordingProducer);
  const registry = createSessionRegistry({
    admission: {
      processNonce: "process",
      requireReady: () => {
        if (!ready)
          throw Object.assign(new Error("reconciliation required"), {
            category: "reconciliation_required",
          });
        return {
          processNonce: "process",
          controlGenerationNonce: "control",
          snapshotDigest: "a".repeat(64),
        };
      },
      beginDraining,
    },
    binding: { processNonce: "process", controlGenerationNonce: "control" },
    profileStore,
    createEgressProxy: proxyFactory,
    launchPersistentChromiumForWorking: launchPersistentContext,
    releaseChromiumSessionAttachment,
    createRecordingProducer,
    ...(afterChromiumAttachment === undefined
      ? {}
      : { afterChromiumAttachment }),
    now: () => now,
    randomUUID: () => IDS[id++]!,
    ...registryOptions,
  });
  return {
    registry,
    context,
    page,
    bodyLocator,
    gate,
    profileStore,
    proxy,
    proxyFactory,
    launchPersistentContext,
    releaseChromiumSessionAttachment,
    createRecordingProducer,
    recordingProducer,
    cdp,
    tracing,
    beginDraining,
    setReady: (value: boolean) => (ready = value),
    advance: (ms: number) => (now += ms),
  };
}

describe("persistent session registry", () => {
  test("cannot create a profile or Chromium session before reconciliation", async () => {
    const h = harness();
    h.setReady(false);
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "reconciliation_required",
    });
    expect(h.launchPersistentContext).not.toHaveBeenCalled();
    expect(h.profileStore.createWorkingCopy).not.toHaveBeenCalled();
  });

  test("opens the restore gate before acquiring the launch page", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    expect(session.runtimeSessionId).toBe(IDS[1]);
    expect(h.gate.assertZeroViolations).toHaveBeenCalledOnce();
    expect(h.gate.open).toHaveBeenCalledOnce();
    expect(h.context.pages).toHaveBeenCalledOnce();
    expect(h.gate.open.mock.invocationCallOrder[0]).toBeLessThan(
      h.context.pages.mock.invocationCallOrder[0]!,
    );
    expect(h.context.pages.mock.invocationCallOrder[0]).toBeLessThan(
      h.page.goto.mock.invocationCallOrder[0]!,
    );
    expect(h.launchPersistentContext.mock.calls[0]![2]).not.toHaveProperty(
      "storageState",
    );
    const proxyDeadline = h.proxyFactory.mock.calls[0]![0].deadlineAtMs;
    expect(typeof proxyDeadline).toBe("function");
    expect((proxyDeadline as () => number)()).toBe(1_700_000_010_000);
    expect(h.gate.assertPositiveControl).toHaveBeenCalledWith(
      expect.anything(),
      "https://example.com/",
    );
  });

  test("replays captured policy under stricter sandbox egress", async () => {
    const h = harness();
    const session = await h.registry.create(
      request({
        settings: {
          ...request().settings,
          blockAds: true,
          lockdown: false,
        },
      }),
    );

    expect(session.page.url).toBe("https://example.com/");
    expect(h.proxyFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDomains: ["example.com"],
        blockAds: true,
      }),
    );
  });

  test("completes maximum wait plus bounded observation within timeout margin", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.page.waitForTimeout.mockImplementation(
        (milliseconds: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      );
      const session = await h.registry.create(
        request({ ttlSeconds: 60, activityTtlSeconds: 60 }),
      );
      h.page.evaluateHandle.mockImplementationOnce(async () => ({
        evaluate: vi.fn(
          () =>
            new Promise<never[]>((resolve) =>
              setTimeout(() => resolve([]), 14_000),
            ),
        ),
        getProperties: vi.fn(async () => new Map()),
        dispose: vi.fn(async () => undefined),
      }));
      const operation = { kind: "wait" as const, milliseconds: 30_000 };
      const execution = h.registry.executeAction(session.runtimeSessionId, {
        version: 1,
        actionId: IDS[2]!,
        runId: IDS[0]!,
        sequence: 1,
        normalizedProposalHash: createHash("sha256")
          .update(canonicalJson(operation))
          .digest("hex"),
        effect: "read_only",
        expectedSessionVersion: 1,
        allowedDomains: ["example.com"],
        operation,
      });

      const completed = expect(execution).resolves.toMatchObject({
        outcome: "succeeded",
        result: { kind: "wait", waitedMs: 30_000 },
        sessionVersion: 2,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(14_000);
      await completed;
      expect(h.context.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("fail-stops when post-wait observation exceeds phase deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.page.waitForTimeout.mockImplementation(
        (milliseconds: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      );
      const session = await h.registry.create(
        request({ ttlSeconds: 60, activityTtlSeconds: 60 }),
      );
      h.page.evaluateHandle.mockImplementationOnce(async () => ({
        evaluate: vi.fn(
          () =>
            new Promise<never[]>((resolve) =>
              setTimeout(() => resolve([]), 16_000),
            ),
        ),
        getProperties: vi.fn(async () => new Map()),
        dispose: vi.fn(async () => undefined),
      }));
      const operation = { kind: "wait" as const, milliseconds: 30_000 };
      const execution = h.registry.executeAction(session.runtimeSessionId, {
        version: 1,
        actionId: IDS[2]!,
        runId: IDS[0]!,
        sequence: 1,
        normalizedProposalHash: createHash("sha256")
          .update(canonicalJson(operation))
          .digest("hex"),
        effect: "read_only",
        expectedSessionVersion: 1,
        allowedDomains: ["example.com"],
        operation,
      });
      const rejected = expect(execution).rejects.toThrow(
        "session operation timed out",
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(h.context.close).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fail-stops an effect that exceeds the default timeout margin", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const session = await h.registry.create(
        request({ ttlSeconds: 60, activityTtlSeconds: 60 }),
      );
      h.bodyLocator.evaluate.mockImplementationOnce(
        () =>
          new Promise<
            Array<{
              connected: boolean;
              tag: string;
              role: string;
              name: string;
              text: string;
            }>
          >((resolve) =>
            setTimeout(
              () =>
                resolve([
                  {
                    connected: true,
                    tag: "BODY",
                    role: "",
                    name: "",
                    text: "late body",
                  },
                ]),
              46_000,
            ),
          ),
      );
      const operation = { kind: "extract" as const };
      const execution = h.registry.executeAction(session.runtimeSessionId, {
        version: 1,
        actionId: IDS[2]!,
        runId: IDS[0]!,
        sequence: 1,
        normalizedProposalHash: createHash("sha256")
          .update(canonicalJson(operation))
          .digest("hex"),
        effect: "read_only",
        expectedSessionVersion: 1,
        allowedDomains: ["example.com"],
        operation,
      });
      const rejected = expect(execution).rejects.toThrow(
        "session operation timed out",
      );

      await vi.advanceTimersByTimeAsync(45_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(h.context.close).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("creates a direct about:blank session without network bootstrap", async () => {
    const h = harness();
    const session = await h.registry.create(
      request({ initialUrl: "about:blank", allowedDomains: [] }),
    );

    expect(session.page.url).toBe("about:blank");
    expect(h.page.goto).not.toHaveBeenCalled();
    expect(h.gate.markPositiveControlBaseline).not.toHaveBeenCalled();
    expect(h.gate.assertPositiveControl).not.toHaveBeenCalled();
  });

  test.each([
    [30, 10],
    [600, 600],
    [3_600, 600],
  ])(
    "accepts exact session TTL boundary %s/%s",
    async (ttlSeconds, activityTtlSeconds) => {
      const h = harness();
      const session = await h.registry.create(
        request({ ttlSeconds, activityTtlSeconds }),
      );
      expect(session.expiresAt).toBe(
        new Date(1_700_000_000_000 + ttlSeconds * 1_000).toISOString(),
      );
    },
  );

  test("passes supported mobile settings without privileged helpers", async () => {
    const h = harness();
    await h.registry.create(
      request({
        settings: {
          ...request().settings,
          viewport: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
          },
          userAgent: "Mobile Browser Service Test",
        },
      }),
    );
    const options = h.launchPersistentContext.mock.calls[0]![2];
    expect(options).toMatchObject({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: "Mobile Browser Service Test",
      serviceWorkers: "block",
    });
    expect(options).not.toHaveProperty("executablePath");
    expect(options).not.toHaveProperty("chromiumSandbox");
  });

  test("expires at first idle or absolute deadline", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    h.advance(10_000);
    await h.registry.sweepExpired();
    expect(h.registry.get(session.runtimeSessionId)).toBeUndefined();
    expect(h.context.close).toHaveBeenCalledOnce();
  });

  test("touch moves only idle deadline and cannot move absolute expiry", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    const absolute = session.expiresAt;
    h.advance(9_000);
    const touched = h.registry.touch(session.runtimeSessionId);
    expect(touched.expiresAt).toBe(absolute);
    expect(touched.idleExpiresAt).not.toBe(session.idleExpiresAt);
  });

  test("cannot revive or mutate a session after either deadline", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    h.advance(10_000);
    expect(h.registry.get(session.runtimeSessionId)).toBeUndefined();
    expect(() => h.registry.touch(session.runtimeSessionId)).toThrowError(
      "session has expired",
    );
    const operation = vi.fn(async () => undefined);
    await expect(
      h.registry.withWriter(session.runtimeSessionId, operation),
    ).rejects.toMatchObject({ category: "session_not_found" });
    expect(operation).not.toHaveBeenCalled();
  });

  test("withWriter rejects concurrent mutation", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    let release!: () => void;
    const first = h.registry.withWriter(
      session.runtimeSessionId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(
      h.registry.withWriter(session.runtimeSessionId, async () => undefined),
    ).rejects.toMatchObject({ category: "concurrency_exceeded" });
    release();
    await first;
  });

  test("runtime leases expose only authenticated bounded browser operations", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    let retainedLease: unknown;
    let retainedChannel: unknown;

    await h.registry.withRuntime(
      session.runtimeSessionId,
      "passive",
      async (lease) => {
        retainedLease = lease;
        expect(Object.keys(lease)).toEqual([]);
        expect(sessionRuntimeSignal(lease).aborted).toBe(false);
        const channel = await openSessionCdpChannel(lease);
        retainedChannel = channel;
        expect(Object.keys(channel)).toEqual([]);
        await expect(
          sendSessionCdpCommand(channel, "Runtime.enable", {}),
        ).resolves.toEqual({ ok: true });
        const eventListener = vi.fn();
        const unsubscribe = subscribeSessionCdpEvent(
          channel,
          "Runtime.consoleAPICalled",
          eventListener,
        );
        expect(h.cdp.on).toHaveBeenCalledWith(
          "Runtime.consoleAPICalled",
          expect.any(Function),
        );
        const subscribed = h.cdp.on.mock.calls.find(
          ([event]) => event === "Runtime.consoleAPICalled",
        )![1] as (params: unknown) => void;
        subscribed({ type: "log" });
        expect(eventListener).toHaveBeenCalledWith({ type: "log" });
        unsubscribe();
        expect(h.cdp.off).toHaveBeenCalledWith(
          "Runtime.consoleAPICalled",
          expect.any(Function),
        );
        await expect(
          captureSessionArtifact(lease, {
            version: 1,
            artifactId: IDS[2]!,
            kind: "recording",
            preset: "diagnostic-v1",
          }),
        ).resolves.toEqual({
          contentType: "video/webm",
          bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
        });
        await closeSessionCdpChannel(channel);
      },
    );

    expect(() => sessionRuntimeSignal(retainedLease as never)).toThrow();
    await expect(
      sendSessionCdpCommand(retainedChannel as never, "Runtime.enable", {}),
    ).rejects.toBeDefined();
    await h.registry.close(session.runtimeSessionId, "requested");
  });

  test("a CDP detach timeout fail-stops admission", async () => {
    const h = harness(undefined, undefined, {
      cleanupTimeoutMs: 25,
    });
    h.cdp.detach.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const session = await h.registry.create(request());
    await expect(
      h.registry.withRuntime(
        session.runtimeSessionId,
        "passive",
        async (lease) => {
          await openSessionCdpChannel(lease);
        },
      ),
    ).rejects.toBeDefined();
    expect(h.cdp.detach).toHaveBeenCalledOnce();
    expect(h.beginDraining).toHaveBeenCalledOnce();
  });

  test("trace capture reads a bounded completed chunk and resumes tracing", async () => {
    const h = harness();
    const traceBytes = Buffer.from("PK\u0003\u0004trace");
    h.tracing.stopChunk.mockImplementationOnce(
      async ({ path }: { path: string }) => writeFile(path, traceBytes),
    );
    const session = await h.registry.create(request());
    await expect(
      h.registry.withRuntime(session.runtimeSessionId, "passive", (lease) =>
        captureSessionArtifact(lease, {
          version: 1,
          artifactId: IDS[2]!,
          kind: "trace",
          preset: "diagnostic-v1",
        }),
      ),
    ).resolves.toEqual({
      contentType: "application/zip",
      bytes: Uint8Array.from(traceBytes),
    });
    expect(h.tracing.startChunk).toHaveBeenCalledWith({
      title: "diagnostic-v1",
    });
    await h.registry.close(session.runtimeSessionId, "requested");
  });

  test("oversized trace is rejected before reading and fail-stops admission", async () => {
    const h = harness();
    h.tracing.stopChunk.mockImplementationOnce(
      async ({ path }: { path: string }) => {
        await writeFile(path, "");
        await truncate(path, 16 * 1024 * 1024 + 1);
      },
    );
    const session = await h.registry.create(request());
    await expect(
      h.registry.withRuntime(session.runtimeSessionId, "passive", (lease) =>
        captureSessionArtifact(lease, {
          version: 1,
          artifactId: IDS[2]!,
          kind: "trace",
          preset: "diagnostic-v1",
        }),
      ),
    ).rejects.toMatchObject({ category: "browser_unavailable" });
    expect(h.tracing.startChunk).not.toHaveBeenCalled();
    expect(h.beginDraining).toHaveBeenCalledOnce();
  });

  test.each(["passive", "writer"] as const)(
    "full drain aborts %s runtime leases before closing browser resources",
    async (mode) => {
      const h = harness();
      const session = await h.registry.create(request());
      let observedAbort = false;
      const runtime = h.registry.withRuntime(
        session.runtimeSessionId,
        mode,
        async (lease) => {
          const signal = sessionRuntimeSignal(lease);
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
        },
      );

      await h.registry.drainAll("shutdown");
      if (mode === "writer") {
        await expect(runtime).rejects.toMatchObject({
          category: "browser_unavailable",
        });
      } else {
        await runtime;
      }
      expect(observedAbort).toBe(true);
      expect(h.recordingProducer.close).toHaveBeenCalledOnce();
      expect(h.context.close).toHaveBeenCalledOnce();
      await expect(h.registry.create(request())).rejects.toMatchObject({
        category: "browser_unavailable",
      });
    },
  );

  test("handoff discards uncommitted writer work instead of preparing it", async () => {
    const h = harness();
    await h.registry.create(
      request({
        profile: {
          profileId: IDS[0]!,
          mode: "writer",
          generationId: null,
          statePath: null,
          checksum: null,
        },
      }),
    );

    await h.registry.drainAll("handoff");

    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "writer" }),
    );
    expect(h.profileStore.prepareWorkingCopy).not.toHaveBeenCalled();
    expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
    expect(h.registry.entries()).toEqual([]);
  });

  test("full drain waits for an already-admitted API action writer", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    let writerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    let releaseWriter!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = h.registry.withWriter(session.runtimeSessionId, async () => {
      writerStarted();
      await held;
    });
    await started;

    let drainSettled = false;
    const drain = h.registry.drainAll("handoff").finally(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    releaseWriter();
    await expect(writer).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    await expect(drain).resolves.toBeUndefined();
    expect(h.registry.entries()).toEqual([]);
    expect(h.context.close).toHaveBeenCalledOnce();
  });

  test("close is idempotent and snapshot work never publishes", async () => {
    const h = harness();
    const session = await h.registry.create(request());
    const first = await h.registry.close(session.runtimeSessionId, "requested");
    expect(
      await h.registry.close(session.runtimeSessionId, "requested"),
    ).toEqual(first);
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.prepareWorkingCopy).not.toHaveBeenCalled();
  });

  test("a default UUIDv7 session owns and discards service-local work", async () => {
    const h = harness();
    const sessionId = "019fa364-b9bd-75da-baa6-e9c96915ae98";
    const session = await h.registry.create(request({ sessionId }));

    expect(h.profileStore.createWorkingCopy).toHaveBeenCalledWith(
      session.runtimeSessionId,
      null,
      "snapshot",
      sessionId,
    );
    expect(session.runtimeSessionId).toBe(IDS[1]);
    expect(session.runtimeSessionId).not.toBe(sessionId);

    await h.registry.close(session.runtimeSessionId, "requested");
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.prepareWorkingCopy).not.toHaveBeenCalled();
  });

  test("close linearizes admission before its runtime cleanup snapshot", async () => {
    let snapshotReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      snapshotReached = resolve;
    });
    let releaseSnapshot!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const h = harness(undefined, undefined, {
      afterRuntimeLeaseSnapshot: async () => {
        snapshotReached();
        await held;
      },
    });
    const session = await h.registry.create(request());
    const cdpSessionCalls = h.context.newCDPSession.mock.calls.length;
    const close = h.registry.close(session.runtimeSessionId, "requested");
    await reached;
    const runtimeEffect = vi.fn(async () => undefined);

    await expect(
      h.registry.withRuntime(
        session.runtimeSessionId,
        "passive",
        runtimeEffect,
      ),
    ).rejects.toMatchObject({ category: "session_not_found" });
    expect(runtimeEffect).not.toHaveBeenCalled();
    expect(h.context.newCDPSession).toHaveBeenCalledTimes(cdpSessionCalls);
    expect(h.page.screenshot).not.toHaveBeenCalled();
    expect(h.recordingProducer.snapshot).not.toHaveBeenCalled();

    releaseSnapshot();
    await expect(close).resolves.toMatchObject({
      runtimeSessionId: session.runtimeSessionId,
      closed: true,
    });
    expect(h.context.close).toHaveBeenCalledOnce();
  });

  test("serializes concurrent close and rejects close during a writer", async () => {
    const h = harness();
    const session = await h.registry.create(
      request({
        profile: {
          profileId: IDS[0]!,
          mode: "writer",
          generationId: null,
          statePath: null,
          checksum: null,
        },
      }),
    );
    let release!: () => void;
    const writer = h.registry.withWriter(
      session.runtimeSessionId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(
      h.registry.close(session.runtimeSessionId, "requested"),
    ).rejects.toMatchObject({ category: "concurrency_exceeded" });
    release();
    await writer;

    const [first, second] = await Promise.all([
      h.registry.close(session.runtimeSessionId, "requested"),
      h.registry.close(session.runtimeSessionId, "requested"),
    ]);
    expect(second).toEqual(first);
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.profileStore.prepareWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
  });

  test("generic launch rejection retains fail-stop ownership", async () => {
    const h = harness();
    h.launchPersistentContext.mockRejectedValueOnce(new Error("launch failed"));
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.registry.entries()).toMatchObject([
      { state: "cleanup_failed", cleanupDetail: "launch_cleanup_unverified" },
    ]);
    expect(h.beginDraining).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
  });

  test("times out one hanging launch and retains fail-stop ownership", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(undefined, undefined, {
        cleanupTimeoutMs: 25,
        launchTimeoutMs: 25,
      });
      h.launchPersistentContext.mockImplementationOnce(
        () => new Promise(() => undefined),
      );
      const creating = h.registry.create(request());
      const rejected = expect(creating).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(h.launchPersistentContext).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toMatchObject([
        {
          state: "cleanup_failed",
          cleanupDetail: "launch_cleanup_unverified",
          launchAttempt: { state: "cleanup_unverified" },
        },
      ]);
      expect(h.beginDraining).toHaveBeenCalledOnce();
      expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("adopts and cleans a launch attachment that resolves after timeout", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(undefined, undefined, {
        cleanupTimeoutMs: 25,
        launchTimeoutMs: 25,
      });
      let resolveLaunch!: (
        value: Readonly<{ context: typeof h.context }>,
      ) => void;
      h.launchPersistentContext.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLaunch = resolve;
          }),
      );
      const creating = h.registry.create(request());
      const rejected = expect(creating).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      resolveLaunch(Object.freeze({ context: h.context }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.launchPersistentContext).toHaveBeenCalledOnce();
      expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
      expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("serializes late attachment recovery behind timeout cleanup", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(undefined, undefined, {
        cleanupTimeoutMs: 100,
        launchTimeoutMs: 25,
      });
      let resolveLaunch!: (
        value: Readonly<{ context: typeof h.context }>,
      ) => void;
      let resolveProxyClose!: () => void;
      h.launchPersistentContext.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLaunch = resolve;
          }),
      );
      h.proxy.close.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveProxyClose = resolve;
          }),
      );
      const creating = h.registry.create(request());
      const rejected = expect(creating).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(h.proxy.close).toHaveBeenCalledOnce();
      resolveLaunch(Object.freeze({ context: h.context }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.releaseChromiumSessionAttachment).not.toHaveBeenCalled();
      resolveProxyClose();
      await rejected;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.proxy.close).toHaveBeenCalledOnce();
      expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
      expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ["trusted", new TrustedPreSpawnLaunchError("pre-spawn"), true],
    ["ambiguous", new Error("unknown launch result"), false],
  ] as const)(
    "handles %s launch rejection after timeout without relaunch",
    async (_name, lateError, releasesOwnership) => {
      vi.useFakeTimers();
      try {
        const h = harness(undefined, undefined, {
          cleanupTimeoutMs: 25,
          launchTimeoutMs: 25,
        });
        let rejectLaunch!: (reason: unknown) => void;
        h.launchPersistentContext.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectLaunch = reject;
            }),
        );
        const creating = h.registry.create(request());
        const rejected = expect(creating).rejects.toMatchObject({
          category: "browser_unavailable",
        });
        await vi.advanceTimersByTimeAsync(25);
        await rejected;
        rejectLaunch(lateError);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.launchPersistentContext).toHaveBeenCalledOnce();
        expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledTimes(
          releasesOwnership ? 1 : 0,
        );
        expect(h.registry.entries()).toHaveLength(releasesOwnership ? 0 : 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("retries cleanup after a late launch attachment is adopted", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(undefined, undefined, {
        cleanupTimeoutMs: 25,
        launchTimeoutMs: 25,
      });
      let resolveLaunch!: (
        value: Readonly<{ context: typeof h.context }>,
      ) => void;
      h.launchPersistentContext.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLaunch = resolve;
          }),
      );
      h.releaseChromiumSessionAttachment.mockRejectedValueOnce(
        new Error("close failed"),
      );
      const creating = h.registry.create(request());
      const rejected = expect(creating).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      resolveLaunch(Object.freeze({ context: h.context }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.registry.entries()).toMatchObject([
        {
          state: "cleanup_failed",
          cleanupDetail: "resource_cleanup_failed",
          cleanupCodes: ["chromium_close_failed"],
        },
      ]);
      expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
      await h.registry.sweepCleanupFailed();
      expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledTimes(2);
      expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("converges phased Chromium proxy socket and profile cleanup retries", async () => {
    const h = harness();
    h.gate.assertZeroViolations.mockImplementationOnce(() => {
      throw new Error("post-launch failure");
    });
    h.releaseChromiumSessionAttachment.mockRejectedValueOnce(
      new Error("Chromium close failed"),
    );
    h.proxy.close.mockRejectedValueOnce(new Error("proxy close failed"));
    const liveSocketCount = vi
      .fn<() => number>()
      .mockReturnValueOnce(1)
      .mockReturnValue(0);
    h.proxy.liveSocketCount = liveSocketCount;
    h.profileStore.discardWorkingCopy.mockRejectedValueOnce(
      new Error("profile discard failed"),
    );

    await expect(h.registry.create(request())).rejects.toMatchObject({
      cleanupCodes: [
        "chromium_close_failed",
        "proxy_listener_close_failed",
        "proxy_socket_drain_failed",
      ],
    });
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();

    await h.registry.sweepCleanupFailed();
    expect(h.registry.entries()).toMatchObject([
      {
        state: "cleanup_failed",
        cleanupCodes: ["profile_discard_failed"],
      },
    ]);
    expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledTimes(2);
    expect(h.proxy.close).toHaveBeenCalledTimes(2);
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();

    await h.registry.sweepCleanupFailed();
    expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledTimes(2);
    expect(h.proxy.close).toHaveBeenCalledTimes(2);
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledTimes(2);
    expect(h.registry.entries()).toEqual([]);
  });

  test("adopts and retries cleanup for unverified launch attachments", async () => {
    const h = harness();
    const attachment = Object.freeze({
      context: h.context,
    }) as unknown as ChromiumSessionAttachment;
    h.launchPersistentContext.mockRejectedValueOnce(
      new UnverifiedChromiumLaunchError(
        "launch cleanup unverified",
        attachment,
      ),
    );
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledWith(attachment);
    expect(h.beginDraining).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toEqual([]);
  });

  test("discards a trusted pre-spawn launch rejection", async () => {
    const h = harness();
    h.launchPersistentContext.mockRejectedValueOnce(
      new TrustedPreSpawnLaunchError("launch rejected before spawn"),
    );
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.beginDraining).not.toHaveBeenCalled();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toEqual([]);
  });

  test("releases an attachment when registry attachment bookkeeping fails", async () => {
    const h = harness(undefined, () => {
      throw new Error("attachment bookkeeping failed");
    });
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toEqual([]);
  });

  test("does not launch Chromium after the session deadline expires", async () => {
    const h = harness();
    h.proxyFactory.mockImplementationOnce(async () => {
      h.advance(60_001);
      return h.proxy;
    });
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.launchPersistentContext).not.toHaveBeenCalled();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
  });

  test("cannot publish when idle expiry occurs during Chromium launch", async () => {
    const h = harness();
    h.launchPersistentContext.mockImplementationOnce(async () => {
      h.advance(10_000);
      return Object.freeze({ context: h.context });
    });
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.registry.get(IDS[1]!)).toBeUndefined();
    expect(h.gate.open).not.toHaveBeenCalled();
    expect(h.context.close).toHaveBeenCalledOnce();
  });

  test("checks the deadline before invoking each browser operation", async () => {
    const h = harness();
    h.page.goto.mockImplementationOnce(async () => {
      h.advance(60_001);
    });
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.page.title).not.toHaveBeenCalled();
    expect(h.page.textContent).not.toHaveBeenCalled();
  });

  test.each(["extra-page", "non-inert-page", "service-worker"] as const)(
    "rejects launch-owned %s after opening the restore gate",
    async (shape) => {
      const h = harness();
      if (shape === "extra-page") {
        h.context.pages.mockReturnValueOnce([
          h.page,
          { ...h.page, url: vi.fn(() => "about:blank") },
        ]);
      } else if (shape === "non-inert-page") {
        h.page.url.mockReturnValueOnce("https://attacker.example/");
      } else {
        h.context.serviceWorkers.mockReturnValueOnce([
          { url: () => "https://attacker.example/worker.js" },
        ]);
      }
      await expect(h.registry.create(request())).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      expect(h.gate.open).toHaveBeenCalledOnce();
      expect(h.page.goto).not.toHaveBeenCalled();
      expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
      expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toEqual([]);
    },
  );

  test("operation timeout fail-stops when the underlying effect never settles", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(undefined, undefined, { operationTimeoutMs: 25 });
      h.page.goto.mockImplementationOnce(() => new Promise(() => undefined));
      const creating = h.registry.create(request());
      const rejected = expect(creating).rejects.toMatchObject({
        category: "browser_unavailable",
        cleanupCodes: ["browser_effect_drain_failed"],
      });
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
      expect(h.proxy.close).toHaveBeenCalledOnce();
      expect(h.proxy.liveSocketCount()).toBe(0);
      expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
      expect(h.beginDraining).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toMatchObject([{ state: "cleanup_failed" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Chromium crash during page work cleans every owned resource", async () => {
    const h = harness();
    h.page.title.mockRejectedValueOnce(new Error("Chromium crashed"));
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
      cleanupCodes: [],
    });
    expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.proxy.liveSocketCount()).toBe(0);
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toEqual([]);
  });

  test("checks admission after synchronous acquisition boundaries", async () => {
    const h = harness();
    h.gate.assertPositiveControl.mockImplementationOnce(() => {
      h.advance(10_000);
    });
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.page.title).not.toHaveBeenCalled();
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toEqual([]);
  });

  test("cleans every post-launch acquisition failure without publication", async () => {
    const cases: Array<{
      name: string;
      inject(h: ReturnType<typeof harness>): void;
    }> = [
      {
        name: "gate-open",
        inject: (h) =>
          h.gate.open.mockImplementationOnce(() => {
            throw new Error("gate open failed");
          }),
      },
      {
        name: "page-acquisition",
        inject: (h) =>
          h.context.pages.mockImplementationOnce(() => {
            throw new Error("pages failed");
          }),
      },
      {
        name: "navigation",
        inject: (h) =>
          h.page.goto.mockRejectedValueOnce(new Error("goto failed")),
      },
      {
        name: "positive-control",
        inject: (h) =>
          h.gate.assertPositiveControl.mockImplementationOnce(() => {
            throw new Error("positive control failed");
          }),
      },
      {
        name: "title",
        inject: (h) =>
          h.page.title.mockRejectedValueOnce(new Error("title failed")),
      },
      {
        name: "body",
        inject: (h) =>
          h.bodyLocator.innerText.mockRejectedValueOnce(
            new Error("body failed"),
          ),
      },
      {
        name: "page-url",
        inject: (h) =>
          h.page.url.mockImplementationOnce(() => {
            throw new Error("url failed");
          }),
      },
    ];
    for (const testCase of cases) {
      const h = harness();
      testCase.inject(h);
      await expect(
        h.registry.create(request()),
        testCase.name,
      ).rejects.toMatchObject({ category: "browser_unavailable" });
      expect(h.context.close, testCase.name).toHaveBeenCalledOnce();
      expect(h.proxy.close, testCase.name).toHaveBeenCalledOnce();
      expect(
        h.profileStore.discardWorkingCopy,
        testCase.name,
      ).toHaveBeenCalledOnce();
      expect(
        h.profileStore.prepareWorkingCopy,
        testCase.name,
      ).not.toHaveBeenCalled();
      expect(
        h.profileStore.finalizePreparedGeneration,
        testCase.name,
      ).not.toHaveBeenCalled();
      expect(h.registry.entries(), testCase.name).toEqual([]);
    }
  });

  test("retains ownership when pre-context cleanup fails", async () => {
    const h = harness();
    h.proxyFactory.mockRejectedValueOnce(new Error("bind failed"));
    h.profileStore.discardWorkingCopy.mockRejectedValueOnce(
      new Error("discard failed"),
    );
    await expect(h.registry.create(request())).rejects.toMatchObject({
      cleanupCodes: ["profile_discard_failed"],
    });
    expect(h.registry.entries()).toMatchObject([
      {
        state: "cleanup_failed",
        admission: "closed",
        cleanupDetail: "acquisition_cleanup_failed",
        cleanupCodes: ["profile_discard_failed"],
      },
    ]);
  });

  test("drains and retains unverified profile acquisition ownership", async () => {
    const h = harness();
    const retainedWork = {
      profileId: IDS[0]!,
      generationId: IDS[2]!,
      sessionId: IDS[0]!,
      mode: "snapshot" as const,
      path: `/proc/${process.pid}/fd/999`,
    };
    h.profileStore.createWorkingCopy.mockRejectedValueOnce(
      new ProfileStoreError("profile_prepare_failed", "cleanup unverified", {
        retainedWork,
        cleanupUnverified: true,
      }),
    );
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
      cleanupCodes: [],
    });
    expect(h.beginDraining).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toMatchObject([
      {
        state: "cleanup_failed",
        cleanupDetail: "profile_acquisition_cleanup_unverified",
      },
    ]);
    await h.registry.sweepCleanupFailed();
    expect(h.registry.entries()).toHaveLength(1);
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
  });

  test("uses exact replay restore order without a launch storageState option", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-replay-"));
    roots.push(root);
    const checkpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const statePath = `replay/owner/scrape/${checkpointId}.json`;
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState));
    const hash = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(root, "replay", "owner", "scrape"), { recursive: true });
    await writeFile(join(root, statePath), bytes);
    const h = harness(root);
    const replayRequest = request({
      replay: {
        checkpointId,
        statePath,
        checksum: hash,
        byteSize: bytes.length,
        storageState,
        finalUrl: "https://example.com/",
        fingerprint: {
          finalUrl: "https://example.com/",
          titleSha256: createHash("sha256").update("").digest("hex"),
          bodyTextSha256: createHash("sha256").update("").digest("hex"),
        },
      },
    });

    await h.registry.create(replayRequest);
    expect(h.launchPersistentContext.mock.calls[0]![2]).not.toHaveProperty(
      "storageState",
    );
    const order = [
      [
        "working-copy",
        h.profileStore.createWorkingCopy.mock.invocationCallOrder[0]!,
      ],
      ["proxy-gate-closed", h.proxyFactory.mock.invocationCallOrder[0]!],
      ["launch", h.launchPersistentContext.mock.invocationCallOrder[0]!],
      [
        "set-storage-state",
        h.context.setStorageState.mock.invocationCallOrder[0]!,
      ],
      ["export-unknown", h.context.storageState.mock.invocationCallOrder[0]!],
      [
        "assert-zero-ingress-violations",
        h.gate.assertZeroViolations.mock.invocationCallOrder[0]!,
      ],
      ["open-gate", h.gate.open.mock.invocationCallOrder[0]!],
      ["acquire-page", h.context.pages.mock.invocationCallOrder[0]!],
    ] as const;
    expect(
      [...order]
        .sort((left, right) => left[1] - right[1])
        .map(([label]) => label),
    ).toEqual(order.map(([label]) => label));
  });

  test("cleans replay restore, export, comparison, and navigation failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-replay-failures-"));
    roots.push(root);
    const checkpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const statePath = `replay/owner/scrape/${checkpointId}.json`;
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState));
    await mkdir(join(root, "replay", "owner", "scrape"), { recursive: true });
    await writeFile(join(root, statePath), bytes);
    const replay = {
      checkpointId,
      statePath,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      storageState,
      finalUrl: "https://example.com/",
      fingerprint: {
        finalUrl: "https://example.com/",
        titleSha256: createHash("sha256").update("").digest("hex"),
        bodyTextSha256: createHash("sha256").update("").digest("hex"),
      },
    };
    const cases: Array<{
      name: string;
      inject(h: ReturnType<typeof harness>): void;
      mutate?: (value: typeof replay) => typeof replay;
    }> = [
      {
        name: "restore",
        inject: (h) =>
          h.context.setStorageState.mockRejectedValueOnce(
            new Error("restore failed"),
          ),
      },
      {
        name: "malformed-export",
        inject: (h) =>
          h.context.storageState.mockResolvedValueOnce({ cookies: "invalid" }),
      },
      {
        name: "semantic-mismatch",
        inject: (h) =>
          h.context.storageState.mockResolvedValueOnce({
            cookies: [],
            origins: [
              {
                origin: "https://other.test/",
                localStorage: [{ name: "x", value: "y" }],
              },
            ],
          }),
      },
      {
        name: "navigation",
        inject: (h) =>
          h.page.goto.mockRejectedValueOnce(new Error("navigation failed")),
      },
    ];
    for (const testCase of cases) {
      const h = harness(root);
      testCase.inject(h);
      await expect(
        h.registry.create(
          request({
            replay:
              testCase.mutate === undefined ? replay : testCase.mutate(replay),
          }),
        ),
        testCase.name,
      ).rejects.toMatchObject({ category: "replay_unavailable" });
      expect(h.context.close, testCase.name).toHaveBeenCalledOnce();
      expect(h.proxy.close, testCase.name).toHaveBeenCalledOnce();
      expect(
        h.profileStore.discardWorkingCopy,
        testCase.name,
      ).toHaveBeenCalledOnce();
      expect(
        h.profileStore.prepareWorkingCopy,
        testCase.name,
      ).not.toHaveBeenCalled();
      expect(
        h.profileStore.finalizePreparedGeneration,
        testCase.name,
      ).not.toHaveBeenCalled();
      expect(h.registry.entries(), testCase.name).toEqual([]);
    }
  });

  test("normalizes replay body fingerprints without rejecting dynamic DOM changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-replay-dynamic-"));
    roots.push(root);
    const checkpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const statePath = `replay/owner/scrape/${checkpointId}.json`;
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState));
    await mkdir(join(root, "replay", "owner", "scrape"), { recursive: true });
    await writeFile(join(root, statePath), bytes);
    const replay = {
      checkpointId,
      statePath,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      storageState,
      finalUrl: "https://example.com/",
      fingerprint: {
        finalUrl: "https://example.com/",
        titleSha256: createHash("sha256")
          .update("captured title")
          .digest("hex"),
        bodyTextSha256: createHash("sha256")
          .update("captured body")
          .digest("hex"),
      },
    };
    const h = harness(root);
    h.page.title.mockResolvedValue("dynamic title");
    h.bodyLocator.innerText.mockResolvedValue(" dynamic\n body ");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(h.registry.create(request({ replay }))).resolves.toMatchObject(
      {
        page: { url: "https://example.com/" },
      },
    );
    expect(warning).toHaveBeenCalledWith(
      "firecrawl_replay_fingerprint_changed",
      expect.objectContaining({
        titleMatches: false,
        bodyMatches: false,
      }),
    );
    warning.mockRestore();

    const normalized = harness(root);
    normalized.page.title.mockResolvedValue("captured title");
    normalized.bodyLocator.innerText.mockResolvedValue(
      "  captured \n\t body  ",
    );
    const normalizedWarning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    await expect(
      normalized.registry.create(
        request({
          sessionId: IDS[2]!,
          replay,
        }),
      ),
    ).resolves.toMatchObject({
      page: { url: "https://example.com/" },
    });
    expect(normalizedWarning).not.toHaveBeenCalled();
    normalizedWarning.mockRestore();
  });

  test("rejects a replay whose restored final URL differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-replay-url-"));
    roots.push(root);
    const checkpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const statePath = `replay/owner/scrape/${checkpointId}.json`;
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState));
    await mkdir(join(root, "replay", "owner", "scrape"), { recursive: true });
    await writeFile(join(root, statePath), bytes);
    const h = harness(root);
    h.page.goto.mockResolvedValueOnce(undefined);

    try {
      await h.registry.create(
        request({
          replay: {
            checkpointId,
            statePath,
            checksum: createHash("sha256").update(bytes).digest("hex"),
            byteSize: bytes.length,
            storageState,
            finalUrl: "https://example.com/",
            fingerprint: {
              finalUrl: "https://example.com/",
              titleSha256: createHash("sha256").update("").digest("hex"),
              bodyTextSha256: createHash("sha256").update("").digest("hex"),
            },
          },
        }),
      );
      throw new Error("expected replay URL mismatch");
    } catch (error) {
      expect(error).toMatchObject({
        category: "replay_unavailable",
        cause: {
          category: "replay_unavailable",
          cause: {
            category: "replay_unavailable",
            message: "replay final URL differs",
          },
        },
      });
    }
  });

  test("rejects unsupported settings before profile, proxy, or Chromium", async () => {
    const h = harness();
    const unsupported = request({
      settings: { ...request().settings, deviceName: "not-a-real-device" },
    });
    await expect(h.registry.create(unsupported)).rejects.toMatchObject({
      category: "replay_unsupported",
    });
    expect(h.profileStore.createWorkingCopy).not.toHaveBeenCalled();
    expect(h.launchPersistentContext).not.toHaveBeenCalled();
    expect(h.registry.entries()).toEqual([]);
  });

  test("rejects replay with an existing profile generation before side effects", async () => {
    const h = harness();
    await expect(
      h.registry.create(
        request({
          profile: {
            profileId: IDS[0]!,
            mode: "snapshot",
            generationId: IDS[2]!,
            statePath: `profiles/${IDS[0]}/committed/${IDS[2]}`,
            checksum: "a".repeat(64),
          },
          replay: { conflict: true },
        }),
      ),
    ).rejects.toMatchObject({ category: "replay_unsupported" });
    expect(h.profileStore.createWorkingCopy).not.toHaveBeenCalled();
    expect(h.proxyFactory).not.toHaveBeenCalled();
    expect(h.launchPersistentContext).not.toHaveBeenCalled();
  });

  test("rejects a noncanonical profile authority before side effects", async () => {
    const h = harness();
    await expect(
      h.registry.create(
        request({
          profile: {
            profileId: IDS[0]!,
            mode: "snapshot",
            generationId: IDS[2]!,
            statePath: `profiles/${IDS[0]}/committed/../committed/${IDS[2]}`,
            checksum: "a".repeat(64),
          },
        }),
      ),
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(h.profileStore.createWorkingCopy).not.toHaveBeenCalled();
    expect(h.proxyFactory).not.toHaveBeenCalled();
    expect(h.launchPersistentContext).not.toHaveBeenCalled();
  });

  test("rejects replay cookies before profile, proxy, or Chromium", async () => {
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState));
    const h = harness();
    await expect(
      h.registry.create(
        request({
          replay: {
            checkpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            statePath:
              "replay/owner/scrape/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json",
            checksum: createHash("sha256").update(bytes).digest("hex"),
            byteSize: bytes.length,
            storageState,
            finalUrl: "https://example.com/",
            fingerprint: {
              finalUrl: "https://example.com/",
              titleSha256: createHash("sha256").update("").digest("hex"),
              bodyTextSha256: createHash("sha256").update("").digest("hex"),
            },
          },
          settings: {
            ...request().settings,
            cookies: [
              {
                name: "late",
                value: "mutation",
                domain: "example.com",
                path: "/",
                expires: -1,
                httpOnly: false,
                secure: true,
                sameSite: "Lax",
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ category: "replay_unsupported" });
    expect(h.profileStore.createWorkingCopy).not.toHaveBeenCalled();
    expect(h.proxyFactory).not.toHaveBeenCalled();
    expect(h.launchPersistentContext).not.toHaveBeenCalled();
  });

  test("cleans a later gate verification failure without publication", async () => {
    const h = harness();
    h.gate.assertZeroViolations.mockImplementationOnce(() => {
      throw new Error("violation");
    });
    await expect(h.registry.create(request())).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.prepareWorkingCopy).not.toHaveBeenCalled();
    expect(h.registry.entries()).toEqual([]);
  });

  test("retains truthful cleanup_failed when public Chromium close cannot verify", async () => {
    const h = harness();
    h.gate.assertZeroViolations.mockImplementationOnce(() => {
      throw new Error("violation");
    });
    h.context.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(h.registry.create(request())).rejects.toMatchObject({
      cleanupCodes: ["chromium_close_failed"],
    });
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
    expect(h.beginDraining).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toMatchObject([
      {
        state: "cleanup_failed",
        admission: "closed",
        cleanupDetail: "resource_cleanup_failed",
      },
    ]);
    await h.registry.sweepCleanupFailed();
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toHaveLength(1);
  });

  test("retains a timed-out close and releases ownership after late verification", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(undefined, undefined, { cleanupTimeoutMs: 25 });
      let resolveContextClose!: () => void;
      h.context.close.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveContextClose = resolve;
          }),
      );
      const session = await h.registry.create(request());
      const closing = h.registry.close(session.runtimeSessionId, "requested");
      const rejected = expect(closing).rejects.toMatchObject({
        cleanupCodes: ["chromium_close_failed"],
      });

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
      expect(h.context.close).toHaveBeenCalledOnce();
      expect(h.profileStore.prepareWorkingCopy).not.toHaveBeenCalled();
      expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
      expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
      expect(h.beginDraining).toHaveBeenCalledOnce();

      resolveContextClose();
      await vi.advanceTimersByTimeAsync(0);
      await h.registry.sweepCleanupFailed();
      expect(h.releaseChromiumSessionAttachment).toHaveBeenCalledOnce();
      expect(h.context.close).toHaveBeenCalledOnce();
      expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
      expect(h.registry.entries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("aggregates a synchronous context close throw and still closes proxy", async () => {
    const h = harness();
    h.gate.assertZeroViolations.mockImplementationOnce(() => {
      throw new Error("violation");
    });
    h.context.close.mockImplementationOnce(() => {
      throw new Error("close threw");
    });
    await expect(h.registry.create(request())).rejects.toMatchObject({
      cleanupCodes: ["chromium_close_failed"],
    });
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
    expect(h.registry.entries()).toMatchObject([
      { state: "cleanup_failed", admission: "closed" },
    ]);
  });

  test("uses public browser close after context close fails", async () => {
    const h = harness();
    const browser = {
      close: vi.fn(async () => undefined),
      isConnected: vi.fn(() => false),
    };
    h.context.close.mockRejectedValueOnce(new Error("context close failed"));
    h.context.browser.mockReturnValueOnce(browser);
    const session = await h.registry.create(request());
    await expect(
      h.registry.close(session.runtimeSessionId, "requested"),
    ).resolves.toMatchObject({ closed: true });
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.profileStore.discardWorkingCopy).toHaveBeenCalledOnce();
    expect(h.registry.entries()).toEqual([]);
  });

  test("resumes writer publication after transient resource cleanup", async () => {
    const h = harness();
    h.proxy.close.mockRejectedValueOnce(new Error("proxy close failed"));
    const session = await h.registry.create(
      request({
        profile: {
          profileId: IDS[0]!,
          mode: "writer",
          generationId: null,
          statePath: null,
          checksum: null,
        },
      }),
    );

    await expect(
      h.registry.close(session.runtimeSessionId, "requested"),
    ).rejects.toMatchObject({
      cleanupCodes: ["proxy_listener_close_failed"],
    });
    expect(h.profileStore.prepareWorkingCopy).not.toHaveBeenCalled();
    expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();

    await h.registry.sweepCleanupFailed();
    const closed = await h.registry.close(
      session.runtimeSessionId,
      "requested",
    );
    expect(closed).toMatchObject({ closed: true, preparedProfile: {} });
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledTimes(2);
    expect(h.profileStore.prepareWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
    expect(h.registry.entries()).toEqual([]);
  });

  test("retries transient writer prepare without discarding work", async () => {
    const h = harness();
    h.profileStore.prepareWorkingCopy.mockRejectedValueOnce(
      new Error("prepare failed"),
    );
    const session = await h.registry.create(
      request({
        profile: {
          profileId: IDS[0]!,
          mode: "writer",
          generationId: null,
          statePath: null,
          checksum: null,
        },
      }),
    );

    await expect(
      h.registry.close(session.runtimeSessionId, "requested"),
    ).rejects.toMatchObject({ cleanupCodes: ["profile_prepare_failed"] });
    await h.registry.sweepCleanupFailed();
    const closed = await h.registry.close(
      session.runtimeSessionId,
      "requested",
    );

    expect(closed).toMatchObject({ closed: true, preparedProfile: {} });
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.proxy.close).toHaveBeenCalledOnce();
    expect(h.profileStore.prepareWorkingCopy).toHaveBeenCalledTimes(2);
    expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
    expect(h.registry.entries()).toEqual([]);
  });

  test("returns prepared authority without invoking finalize", async () => {
    const h = harness();
    h.profileStore.finalizePreparedGeneration.mockRejectedValueOnce(
      new Error("finalize failed"),
    );
    const session = await h.registry.create(
      request({
        profile: {
          profileId: IDS[0]!,
          mode: "writer",
          generationId: null,
          statePath: null,
          checksum: null,
        },
      }),
    );

    const closed = await h.registry.close(
      session.runtimeSessionId,
      "requested",
    );
    const prepared = h.profileStore.prepareWorkingCopy.mock.results[0]!.value;
    expect(closed).toMatchObject({ closed: true });
    expect(closed.preparedProfile).toEqual(await prepared);
    expect(h.profileStore.prepareWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
    expect(h.registry.entries()).toEqual([]);
  });

  test("prepares a writer only after verified normal resource shutdown", async () => {
    const h = harness();
    const session = await h.registry.create(
      request({
        profile: {
          profileId: IDS[0]!,
          mode: "writer",
          generationId: null,
          statePath: null,
          checksum: null,
        },
      }),
    );
    await h.registry.close(session.runtimeSessionId, "requested");
    expect(h.context.close.mock.invocationCallOrder[0]).toBeLessThan(
      h.profileStore.prepareWorkingCopy.mock.invocationCallOrder[0]!,
    );
    expect(h.proxy.close.mock.invocationCallOrder[0]).toBeLessThan(
      h.profileStore.prepareWorkingCopy.mock.invocationCallOrder[0]!,
    );
    expect(h.profileStore.prepareWorkingCopy).toHaveBeenCalledOnce();
    expect(h.profileStore.finalizePreparedGeneration).not.toHaveBeenCalled();
    expect(h.profileStore.discardWorkingCopy).not.toHaveBeenCalled();
  });
});
