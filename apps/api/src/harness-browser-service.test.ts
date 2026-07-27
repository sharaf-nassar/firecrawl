import { describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoHarnessBrowserUserOverrides,
  createBrowserContainerInvocation,
  createDefaultHarnessBrowserServiceDependencies,
  createHarnessBrowserShutdownCoordinator,
  createHarnessPublicBrowserEnvironment,
  HARNESS_BROWSER_EXTERNAL_OVERRIDES,
  HARNESS_BROWSER_PUBLIC_ORIGIN_OVERRIDE,
  startHarnessBrowserControlServer,
  startHarnessBrowserService,
  type HarnessBrowserServiceDependencies,
} from "./harness-browser-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dependencies(
  env: NodeJS.ProcessEnv = {},
): HarnessBrowserServiceDependencies & {
  events: string[];
  cleanupEvents: string[];
  fallbackStates: Array<{
    root: boolean;
    database: boolean;
    container: boolean;
  }>;
  fallbackContainerNames: string[];
  signal(): Promise<void>;
  invokeExitFallback(): void;
} {
  const events: string[] = [];
  const cleanupEvents: string[] = [];
  const fallbackStates: Array<{
    root: boolean;
    database: boolean;
    container: boolean;
  }> = [];
  const fallbackContainerNames: string[] = [];
  let signalCleanup: (() => Promise<void>) | undefined;
  let abortStartup: (() => void) | undefined;
  let registeredExitFallback: (() => void) | undefined;
  let port = 39122;
  return {
    env,
    tempParent: "/tmp/firecrawl-browser-harness",
    monorepoRoot: "/repo",
    events,
    cleanupEvents,
    fallbackStates,
    fallbackContainerNames,
    async signal() {
      abortStartup?.();
      await signalCleanup?.();
    },
    invokeExitFallback() {
      registeredExitFallback?.();
    },
    validateEnvironment: vi.fn(async () => {
      events.push("validate-env");
    }),
    detectRuntime: vi.fn(async () => {
      events.push("detect-runtime");
      return "docker";
    }),
    buildImage: vi.fn(async () => events.push("build")),
    allocatePort: vi.fn(async () => ++port),
    onIdentitiesPrecomputed: vi.fn(() => events.push("precompute-identities")),
    registerCleanup: vi.fn((cleanup, fallback, abort) => {
      events.push("register-cleanup");
      signalCleanup = cleanup;
      abortStartup = abort;
      registeredExitFallback = fallback;
      return () => events.push("unregister-cleanup");
    }),
    createRoot: vi.fn(async () => {
      events.push("create-root");
      return { dev: 1, ino: 2 };
    }),
    createDatabase: vi.fn(async () => {
      events.push("create-database");
      return { databaseUrl: "postgresql://owned.test/firecrawl" };
    }),
    runContainer: vi.fn(async () => events.push("run-container")),
    waitForLive: vi.fn(async () => {
      events.push("live");
      return { processNonce: Buffer.alloc(32, 7).toString("base64url") };
    }),
    removeContainer: vi.fn(async () => {
      events.push("remove-container");
      cleanupEvents.push("remove-container");
    }),
    dropDatabase: vi.fn(async () => {
      events.push("drop-database");
      cleanupEvents.push("drop-database");
    }),
    removeRoot: vi.fn(async () => {
      events.push("remove-root");
      cleanupEvents.push("remove-root");
    }),
    exitFallback: vi.fn((_runtime, identity, state) => {
      fallbackContainerNames.push(identity.containerName);
      fallbackStates.push({ ...state });
    }),
  };
}

describe("startHarnessBrowserService", () => {
  it("registers cleanup before creating any owned resource", async () => {
    const deps = dependencies();
    vi.mocked(deps.waitForLive).mockImplementation(async () => {
      deps.events.push("live");
      throw new Error("not live");
    });

    await expect(startHarnessBrowserService(deps)).rejects.toThrow("not live");

    expect(deps.events).toEqual([
      "validate-env",
      "detect-runtime",
      "build",
      "precompute-identities",
      "register-cleanup",
      "create-root",
      "create-database",
      "run-container",
      "live",
      "remove-container",
      "drop-database",
      "remove-root",
      "unregister-cleanup",
    ]);
  });

  it("rejects every external Browser Service override", async () => {
    for (const name of HARNESS_BROWSER_EXTERNAL_OVERRIDES) {
      const deps = dependencies({ [name]: "external-value" });
      await expect(startHarnessBrowserService(deps)).rejects.toMatchObject({
        category: "harness_external_browser_override_rejected",
      });
      expect(deps.runContainer).not.toHaveBeenCalled();
    }
  });

  it("binds the public Browser origin to the exact dynamic API origin", () => {
    const environment = createHarnessPublicBrowserEnvironment(
      "http://127.0.0.1:39122",
    );

    expect(environment).toEqual({
      BROWSER_PUBLIC_API_ORIGIN: "http://127.0.0.1:39122",
    });
    expect(environment).not.toHaveProperty("BROWSER_SERVICE_URL");
    expect(HARNESS_BROWSER_PUBLIC_ORIGIN_OVERRIDE).toBe(
      "BROWSER_PUBLIC_API_ORIGIN",
    );
    expect(() =>
      assertNoHarnessBrowserUserOverrides({
        BROWSER_PUBLIC_API_ORIGIN: "http://attacker.example:3010",
      }),
    ).toThrowError(
      expect.objectContaining({
        category: "harness_external_browser_override_rejected",
      }),
    );
  });

  for (const unsafe of [
    "http://browser-service:3010",
    "http://127.0.0.1:3010/private",
    "https://127.0.0.1:3010",
    "http://attacker.example:3010",
  ]) {
    it(`rejects unsafe public Browser origin ${unsafe}`, () => {
      expect(() => createHarnessPublicBrowserEnvironment(unsafe)).toThrowError(
        expect.objectContaining({
          category: "harness_browser_public_origin_unsafe",
        }),
      );
    });
  }

  it("uses fresh owned identities and environment each run", async () => {
    const firstDeps = dependencies();
    const secondDeps = dependencies();
    const first = await startHarnessBrowserService(firstDeps);
    const second = await startHarnessBrowserService(secondDeps);

    expect(second.containerName).not.toBe(first.containerName);
    expect(second.stateRoot).not.toBe(first.stateRoot);
    expect(second.databaseName).not.toBe(first.databaseName);
    expect(second.projectName).not.toBe(first.projectName);
    expect(second.serviceKey).not.toBe(first.serviceKey);
    expect(second.replayIngestKey).not.toBe(first.replayIngestKey);
    expect(first.replayIngestKey).not.toBe(first.serviceKey);
    expect(first.environment).toMatchObject({
      LOCAL_BROWSER_SERVICE_ENABLED: "true",
      LOCAL_BROWSER_STATE_ROOT: first.stateRoot,
      BROWSER_SERVICE_API_KEY: first.serviceKey,
      APPLICATION_DATABASE_URL: first.databaseUrl,
    });

    await first.cleanup();
    await second.cleanup();
    expect(firstDeps.cleanupEvents).toEqual([
      "remove-container",
      "drop-database",
      "remove-root",
    ]);
  });

  it("cleans a partially created container once in reverse order", async () => {
    const deps = dependencies();
    vi.mocked(deps.runContainer).mockImplementation(async () => {
      deps.events.push("run-container");
      throw new Error("run failed after create");
    });

    await expect(startHarnessBrowserService(deps)).rejects.toThrow(
      "run failed after create",
    );
    expect(deps.cleanupEvents).toEqual([
      "remove-container",
      "drop-database",
      "remove-root",
    ]);
  });

  it("makes cleanup idempotent while an invocation is live", async () => {
    const deps = dependencies();
    const handle = await startHarnessBrowserService(deps);
    await Promise.all([handle.cleanup(), handle.cleanup()]);
    await handle.cleanup();
    expect(deps.cleanupEvents).toEqual([
      "remove-container",
      "drop-database",
      "remove-root",
    ]);
  });

  it("retries failed cleanup layers without skipping reverse order", async () => {
    const deps = dependencies();
    const handle = await startHarnessBrowserService(deps);
    vi.mocked(deps.removeContainer).mockRejectedValueOnce(
      new Error("container removal failed"),
    );

    await expect(handle.cleanup()).rejects.toThrow(
      "Harness Browser cleanup failed",
    );
    expect(deps.cleanupEvents).toEqual([]);
    expect(deps.dropDatabase).not.toHaveBeenCalled();
    expect(deps.removeRoot).not.toHaveBeenCalled();

    await handle.cleanup();
    expect(deps.removeContainer).toHaveBeenCalledTimes(2);
    expect(deps.cleanupEvents).toEqual([
      "remove-container",
      "drop-database",
      "remove-root",
    ]);
  });

  for (const failure of ["dropDatabase", "removeRoot"] as const) {
    it(`retries only still-marked layers after ${failure} fails`, async () => {
      const deps = dependencies();
      const handle = await startHarnessBrowserService(deps);
      vi.mocked(deps[failure]).mockRejectedValueOnce(
        new Error(`${failure} failed`),
      );

      await expect(handle.cleanup()).rejects.toThrow(
        "Harness Browser cleanup failed",
      );
      await handle.cleanup();

      expect(deps.removeContainer).toHaveBeenCalledTimes(1);
      expect(deps.dropDatabase).toHaveBeenCalledTimes(
        failure === "dropDatabase" ? 2 : 1,
      );
      expect(deps.removeRoot).toHaveBeenCalledTimes(
        failure === "removeRoot" ? 2 : 1,
      );
      expect(deps.cleanupEvents).toEqual([
        "remove-container",
        ...(failure === "removeRoot" ? ["drop-database"] : []),
        ...(failure === "dropDatabase" ? ["drop-database"] : []),
        "remove-root",
      ]);
    });
  }

  it("awaits signal cleanup and never creates a later resource", async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    const deps = dependencies();
    vi.mocked(deps.createRoot).mockImplementation(async () => {
      deps.events.push("create-root");
      reached.resolve();
      await release.promise;
      return { dev: 1, ino: 2 };
    });
    const run = startHarnessBrowserService(deps);
    await reached.promise;
    const cleanup = deps.signal();
    release.resolve();
    await cleanup;
    await expect(run).rejects.toMatchObject({
      category: "harness_browser_startup_aborted",
    });
    expect(deps.cleanupEvents).toEqual(["remove-root"]);
    expect(deps.removeRoot).toHaveBeenCalledWith(expect.any(Object), {
      dev: 1,
      ino: 2,
    });
    expect(deps.createDatabase).not.toHaveBeenCalled();
  });

  it("coordinates a real shutdown during startup before later phases", async () => {
    const coordinator = createHarnessBrowserShutdownCoordinator();
    const deps = dependencies();
    deps.registerCleanup = coordinator.register;
    const reached = deferred<void>();
    const release = deferred<void>();
    vi.mocked(deps.createRoot).mockImplementation(async () => {
      deps.events.push("create-root");
      reached.resolve();
      await release.promise;
      return { dev: 17, ino: 29 };
    });

    const startup = startHarnessBrowserService(deps);
    await reached.promise;
    const shutdown = coordinator.shutdown();
    release.resolve();
    await shutdown;

    await expect(startup).rejects.toMatchObject({
      category: "harness_browser_startup_aborted",
    });
    expect(deps.createDatabase).not.toHaveBeenCalled();
    expect(deps.cleanupEvents).toEqual(["remove-root"]);
    expect(deps.removeRoot).toHaveBeenCalledWith(expect.any(Object), {
      dev: 17,
      ino: 29,
    });
  });

  it("aborts immediately after cleanup registration without creating resources", async () => {
    const deps = dependencies();
    deps.onCleanupRegistered = abort => abort();

    await expect(startHarnessBrowserService(deps)).rejects.toMatchObject({
      category: "harness_browser_startup_aborted",
    });
    expect(deps.createRoot).not.toHaveBeenCalled();
    expect(deps.cleanupEvents).toEqual([]);
  });

  for (const boundary of [
    "createRoot",
    "createDatabase",
    "runContainer",
    "waitForLive",
  ] as const) {
    it(`awaits signal cleanup during ${boundary}`, async () => {
      const deps = dependencies();
      const reached = deferred<void>();
      const release = deferred<void>();
      vi.mocked(deps[boundary]).mockImplementation((async () => {
        reached.resolve();
        await release.promise;
        deps.events.push(
          boundary === "createRoot"
            ? "create-root"
            : boundary === "createDatabase"
              ? "create-database"
              : boundary === "runContainer"
                ? "run-container"
                : "live",
        );
        if (boundary === "createRoot") return { dev: 1, ino: 2 };
        if (boundary === "createDatabase") {
          return { databaseUrl: "postgresql://owned.test/firecrawl" };
        }
        if (boundary === "waitForLive") {
          return {
            processNonce: Buffer.alloc(32, 7).toString("base64url"),
          };
        }
      }) as never);

      const run = startHarnessBrowserService(deps);
      await reached.promise;
      const cleanup = deps.signal();
      release.resolve();
      await cleanup;
      await expect(run).rejects.toMatchObject({
        category: "harness_browser_startup_aborted",
      });

      const expected =
        boundary === "createRoot"
          ? ["remove-root"]
          : boundary === "createDatabase"
            ? ["drop-database", "remove-root"]
            : ["remove-container", "drop-database", "remove-root"];
      expect(deps.cleanupEvents).toEqual(expected);
    });
  }

  it("rejects a noncanonical service process nonce", async () => {
    const deps = dependencies();
    vi.mocked(deps.waitForLive).mockResolvedValue({ processNonce: "short" });
    await expect(startHarnessBrowserService(deps)).rejects.toMatchObject({
      category: "harness_browser_process_nonce_invalid",
    });
  });

  it("retains failed cleanup state for the synchronous exit fallback", async () => {
    const deps = dependencies();
    const handle = await startHarnessBrowserService(deps);
    vi.mocked(deps.removeContainer).mockRejectedValueOnce(
      new Error("container removal failed"),
    );

    await expect(handle.cleanup()).rejects.toThrow(
      "Harness Browser cleanup failed",
    );
    deps.invokeExitFallback();

    expect(deps.fallbackStates).toEqual([
      { root: true, database: true, container: true },
    ]);
    expect(deps.fallbackContainerNames).toEqual([handle.containerName]);
  });

  it("keeps the Browser API secret out of container argv", () => {
    const serviceKey = "super-secret-browser-api-key";
    const invocation = createBrowserContainerInvocation({
      containerName: "browser",
      projectName: "project",
      ownershipToken: "owner",
      browserPort: 3010,
      stateRoot: "/tmp/browser-state",
      serviceKey,
    });

    expect(invocation.args).toContain("BROWSER_SERVICE_API_KEY");
    expect(invocation.args.join(" ")).not.toContain(serviceKey);
    expect(invocation.env.BROWSER_SERVICE_API_KEY).toBe(serviceKey);
  });

  it("coalesces exact-container restarts and waits for replacement readiness", async () => {
    const deps = dependencies();
    const firstNonce = Buffer.alloc(32, 7).toString("base64url");
    const replacementNonce = Buffer.alloc(32, 8).toString("base64url");
    vi.mocked(deps.waitForLive)
      .mockResolvedValueOnce({ processNonce: firstNonce })
      .mockImplementationOnce(async () => {
        deps.events.push("replacement-live");
        return { processNonce: replacementNonce };
      });
    deps.waitForReady = vi.fn(async (_identity, live) => {
      deps.events.push(`ready:${live.processNonce}`);
    });
    const handle = await startHarnessBrowserService(deps);

    const [first, coalesced] = await Promise.all([
      handle.restart(),
      handle.restart(),
    ]);

    expect(first).toEqual({
      oldProcessNonce: firstNonce,
      newProcessNonce: replacementNonce,
    });
    expect(coalesced).toEqual(first);
    expect(handle.processNonce).toBe(replacementNonce);
    expect(deps.removeContainer).toHaveBeenCalledTimes(1);
    expect(deps.runContainer).toHaveBeenCalledTimes(2);
    expect(deps.events).toContain("replacement-live");
    expect(deps.events).toContain(`ready:${replacementNonce}`);

    await handle.cleanup();
    expect(deps.removeContainer).toHaveBeenCalledTimes(2);
  });

  it("waits for an active restart before cleaning the replacement", async () => {
    const deps = dependencies();
    const replacementReached = deferred<void>();
    const releaseReplacement = deferred<void>();
    vi.mocked(deps.waitForLive)
      .mockResolvedValueOnce({
        processNonce: Buffer.alloc(32, 7).toString("base64url"),
      })
      .mockImplementationOnce(async () => {
        replacementReached.resolve();
        await releaseReplacement.promise;
        return {
          processNonce: Buffer.alloc(32, 8).toString("base64url"),
        };
      });
    deps.waitForReady = vi.fn(async () => undefined);
    const handle = await startHarnessBrowserService(deps);

    const restart = handle.restart();
    await replacementReached.promise;
    const cleanup = handle.cleanup();
    await Promise.resolve();
    expect(deps.dropDatabase).not.toHaveBeenCalled();
    expect(deps.removeRoot).not.toHaveBeenCalled();

    releaseReplacement.resolve();
    await restart;
    await cleanup;
    expect(deps.removeContainer).toHaveBeenCalledTimes(2);
    expect(deps.cleanupEvents).toEqual([
      "remove-container",
      "remove-container",
      "drop-database",
      "remove-root",
    ]);
  });

  it("default root cleanup verifies identity and removes its exact root", async () => {
    const tempParent = await mkdtemp(join(tmpdir(), "browser-harness-test-"));
    const stateRoot = join(tempParent, "state-owned");
    const identity = {
      invocationId: "invocation",
      ownershipToken: "ownership-token",
      serviceKey: "service-key",
      replayIngestKey: "replay-key",
      stateRoot,
      ownershipMarker: `${stateRoot}.owner`,
      databaseName: "database",
      databaseContainerName: "database-container",
      databasePort: 39123,
      containerName: "browser-container",
      projectName: "browser-project",
      browserPort: 39124,
    };
    try {
      const deps = createDefaultHarnessBrowserServiceDependencies({
        env: {},
        tempParent,
        monorepoRoot: "/repo",
        shutdownCoordinator: createHarnessBrowserShutdownCoordinator(),
      });

      let publishedIdentity: { dev: number; ino: number } | undefined;
      const rootIdentity = await deps.createRoot(identity, identity => {
        publishedIdentity = identity;
      });
      expect(publishedIdentity).toEqual(rootIdentity);
      expect((await readdir(stateRoot)).sort()).toEqual([
        ".profile-publish-staging",
        "profiles",
      ]);
      expect(
        (await readdir(join(stateRoot, ".profile-publish-staging"))).sort(),
      ).toEqual(["bundles", "intents"]);
      for (const relative of [
        ".",
        "profiles",
        ".profile-publish-staging",
        ".profile-publish-staging/bundles",
        ".profile-publish-staging/intents",
      ]) {
        const metadata = await lstat(join(stateRoot, relative));
        expect(metadata.isDirectory(), relative).toBe(true);
        expect(metadata.isSymbolicLink(), relative).toBe(false);
        expect(metadata.uid, relative).toBe(1000);
        expect(metadata.gid, relative).toBe(1000);
        expect(metadata.mode & 0o7777, relative).toBe(0o700);
        expect(metadata.dev, relative).toBe(rootIdentity.dev);
      }
      await writeFile(join(stateRoot, "canary"), "owned");
      await deps.removeRoot(identity, rootIdentity);

      await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(identity.ownershipMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempParent, { recursive: true, force: true });
    }
  });

  it("publishes root identity before layout failure so cleanup stays exact", async () => {
    const tempParent = await mkdtemp(join(tmpdir(), "browser-harness-test-"));
    const stateRoot = join(tempParent, "state-partial");
    const identity = {
      invocationId: "invocation",
      ownershipToken: "ownership-token",
      serviceKey: "service-key",
      replayIngestKey: "replay-key",
      stateRoot,
      ownershipMarker: `${stateRoot}.owner`,
      databaseName: "database",
      databaseContainerName: "database-container",
      databasePort: 39123,
      containerName: "browser-container",
      projectName: "browser-project",
      browserPort: 39124,
    };
    const deps = createDefaultHarnessBrowserServiceDependencies({
      env: {},
      tempParent,
      monorepoRoot: "/repo",
      shutdownCoordinator: createHarnessBrowserShutdownCoordinator(),
    });
    let publishedIdentity: { dev: number; ino: number } | undefined;

    try {
      await expect(
        deps.createRoot(identity, rootIdentity => {
          publishedIdentity = rootIdentity;
          mkdirSync(join(stateRoot, "foreign"), { mode: 0o700 });
        }),
      ).rejects.toMatchObject({
        category: "harness_browser_root_collision",
      });
      expect(publishedIdentity).toBeDefined();
      await deps.removeRoot(identity, publishedIdentity);
      await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(identity.ownershipMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempParent, { recursive: true, force: true });
    }
  });

  it("removes a default root when creation fails after authority publication", async () => {
    const tempParent = await mkdtemp(join(tmpdir(), "browser-harness-test-"));
    const defaults = createDefaultHarnessBrowserServiceDependencies({
      env: {},
      tempParent,
      monorepoRoot: "/repo",
      shutdownCoordinator: createHarnessBrowserShutdownCoordinator(),
    });
    const deps = dependencies();
    deps.tempParent = tempParent;
    let stateRoot = "";
    let ownershipMarker = "";
    deps.onIdentitiesPrecomputed = identity => {
      stateRoot = identity.stateRoot;
      ownershipMarker = identity.ownershipMarker;
    };
    deps.createRoot = async (identity, publishIdentity) =>
      defaults.createRoot(identity, rootIdentity => {
        publishIdentity(rootIdentity);
        throw new Error("failed after root authority publication");
      });
    deps.removeRoot = defaults.removeRoot;

    try {
      await expect(startHarnessBrowserService(deps)).rejects.toThrow(
        "failed after root authority publication",
      );
      expect(deps.createDatabase).not.toHaveBeenCalled();
      await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(ownershipMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempParent, { recursive: true, force: true });
    }
  });

  it("never attempts root deletion before identity publication", async () => {
    const deps = dependencies();
    deps.createRoot = vi.fn(async () => {
      throw new Error("failed before root authority publication");
    });

    await expect(startHarnessBrowserService(deps)).rejects.toThrow(
      "Harness Browser startup and cleanup failed",
    );
    expect(deps.removeRoot).not.toHaveBeenCalled();
    deps.invokeExitFallback();
    expect(deps.fallbackStates).toEqual([
      { root: true, database: false, container: false },
    ]);
  });

  it("sync fallback removes an exact partial root after async cleanup fails", async () => {
    const tempParent = await mkdtemp(join(tmpdir(), "browser-harness-test-"));
    const defaults = createDefaultHarnessBrowserServiceDependencies({
      env: {},
      tempParent,
      monorepoRoot: "/repo",
      shutdownCoordinator: createHarnessBrowserShutdownCoordinator(),
    });
    const deps = dependencies();
    deps.tempParent = tempParent;
    let stateRoot = "";
    let ownershipMarker = "";
    deps.onIdentitiesPrecomputed = identity => {
      stateRoot = identity.stateRoot;
      ownershipMarker = identity.ownershipMarker;
    };
    deps.createRoot = async (identity, publishIdentity) =>
      defaults.createRoot(identity, rootIdentity => {
        publishIdentity(rootIdentity);
        throw new Error("failed after root authority publication");
      });
    deps.removeRoot = vi.fn(async () => {
      throw new Error("async root removal failed");
    });
    deps.exitFallback = defaults.exitFallback;

    try {
      await expect(startHarnessBrowserService(deps)).rejects.toThrow(
        "Harness Browser startup and cleanup failed",
      );
      await expect(stat(stateRoot)).resolves.toBeTruthy();
      deps.invokeExitFallback();
      await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(ownershipMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempParent, { recursive: true, force: true });
    }
  });
});

describe("startHarnessBrowserControlServer", () => {
  it("authenticates the exact restart route and rejects other requests", async () => {
    const restart = vi.fn(async () => ({
      oldProcessNonce: Buffer.alloc(32, 7).toString("base64url"),
      newProcessNonce: Buffer.alloc(32, 8).toString("base64url"),
    }));
    const control = await startHarnessBrowserControlServer({ restart });
    const authorization = `Bearer ${control.token}`;

    try {
      expect(control.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(control.url).not.toContain(control.token);

      const unauthorized = await fetch(
        `${control.url}/v1/browser-service/restart`,
        {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
        },
      );
      expect(unauthorized.status).toBe(401);

      const method = await fetch(`${control.url}/v1/browser-service/restart`, {
        method: "GET",
        headers: { authorization },
      });
      expect(method.status).toBe(405);

      const path = await fetch(`${control.url}/v1/browser-service/other`, {
        method: "POST",
        headers: { authorization },
      });
      expect(path.status).toBe(404);

      const body = await fetch(`${control.url}/v1/browser-service/restart`, {
        method: "POST",
        headers: { authorization },
        body: "not accepted",
      });
      expect(body.status).toBe(400);

      const success = await fetch(`${control.url}/v1/browser-service/restart`, {
        method: "POST",
        headers: { authorization },
      });
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({
        oldProcessNonce: Buffer.alloc(32, 7).toString("base64url"),
        newProcessNonce: Buffer.alloc(32, 8).toString("base64url"),
      });
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      await control.close();
    }
  });

  it("rejects concurrent restarts and drains the active request on close", async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    const restart = vi.fn(async () => {
      reached.resolve();
      await release.promise;
      return {
        oldProcessNonce: Buffer.alloc(32, 7).toString("base64url"),
        newProcessNonce: Buffer.alloc(32, 8).toString("base64url"),
      };
    });
    const control = await startHarnessBrowserControlServer({ restart });
    const request = () =>
      fetch(`${control.url}/v1/browser-service/restart`, {
        method: "POST",
        headers: { authorization: `Bearer ${control.token}` },
      });

    const active = request();
    await reached.promise;
    const concurrent = await request();
    expect(concurrent.status).toBe(409);

    let closed = false;
    const close = control.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release.resolve();
    expect((await active).status).toBe(200);
    await close;
    expect(restart).toHaveBeenCalledTimes(1);
    await expect(request()).rejects.toThrow();
  });
});
