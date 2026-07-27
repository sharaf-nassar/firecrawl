import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  chmod,
  chown,
  mkdir,
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

import { Client } from "pg";
import { BROWSER_HARNESS_MARKER } from "./harness-browser-command";

export const HARNESS_BROWSER_EXTERNAL_OVERRIDES = [
  "TEST_BROWSER_SERVICE_URL",
  "TEST_BROWSER_SERVICE_API_KEY",
  "BROWSER_SERVICE_URL",
  "BROWSER_SERVICE_API_KEY",
  "BROWSER_REPLAY_INGEST_URL",
  "BROWSER_REPLAY_INGEST_API_KEY",
  "LOCAL_BROWSER_STATE_ROOT",
  "TEST_APPLICATION_DATABASE_URL",
  "APPLICATION_DATABASE_URL",
  "TEST_BROWSER_HARNESS_CONTROL_URL",
  "TEST_BROWSER_HARNESS_CONTROL_TOKEN",
  BROWSER_HARNESS_MARKER,
] as const;

export const HARNESS_BROWSER_PUBLIC_ORIGIN_OVERRIDE =
  "BROWSER_PUBLIC_API_ORIGIN" as const;

const PROCESS_NONCE = /^[A-Za-z0-9_-]{43}$/;
const IMAGE = "firecrawl-local-browser-service:harness";
const BROWSER_UID = 1000;
const BROWSER_GID = 1000;
const BROWSER_STATE_MODE = 0o700;
const BROWSER_STATE_CHILDREN = Object.freeze([
  ".profile-publish-staging",
  "profiles",
]);
const BROWSER_STAGING_CHILDREN = Object.freeze(["bundles", "intents"]);

type HarnessIdentity = Readonly<{
  invocationId: string;
  ownershipToken: string;
  serviceKey: string;
  replayIngestKey: string;
  stateRoot: string;
  ownershipMarker: string;
  databaseName: string;
  databaseContainerName: string;
  databasePort: number;
  containerName: string;
  projectName: string;
  browserPort: number;
}>;

type ResourceState = {
  root: boolean;
  database: boolean;
  container: boolean;
};

type RootIdentity = Readonly<{ dev: number; ino: number }>;

type HarnessBrowserLive = Readonly<{ processNonce: string }>;

export type HarnessBrowserServiceDependencies = {
  env: NodeJS.ProcessEnv;
  tempParent: string;
  monorepoRoot: string;
  validateEnvironment(): Promise<unknown>;
  detectRuntime(): Promise<string | null>;
  buildImage(runtime: string, image: string, root: string): Promise<unknown>;
  allocatePort(): Promise<number>;
  registerCleanup(
    cleanup: () => Promise<void>,
    exitFallback: () => void,
    abortStartup: () => void,
  ): () => void;
  createRoot(
    identity: HarnessIdentity,
    publishIdentity: (rootIdentity: RootIdentity) => void,
  ): Promise<RootIdentity>;
  createDatabase(
    runtime: string,
    identity: HarnessIdentity,
  ): Promise<{ databaseUrl: string }>;
  runContainer(runtime: string, identity: HarnessIdentity): Promise<unknown>;
  waitForLive(identity: HarnessIdentity): Promise<HarnessBrowserLive>;
  waitForReady?(
    identity: HarnessIdentity,
    live: HarnessBrowserLive,
    databaseUrl: string,
  ): Promise<void>;
  removeContainer(runtime: string, identity: HarnessIdentity): Promise<unknown>;
  dropDatabase(runtime: string, identity: HarnessIdentity): Promise<unknown>;
  removeRoot(
    identity: HarnessIdentity,
    rootIdentity: RootIdentity | undefined,
  ): Promise<unknown>;
  exitFallback?(
    runtime: string,
    identity: HarnessIdentity,
    state: Readonly<ResourceState>,
    rootIdentity: RootIdentity | undefined,
  ): void;
  onIdentitiesPrecomputed?(identity: HarnessIdentity): void;
  onCleanupRegistered?(abortStartup: () => void): void;
};

type HarnessBrowserShutdownCoordinator = Readonly<{
  register(
    cleanup: () => Promise<void>,
    exitFallback: () => void,
    abortStartup: () => void,
  ): () => void;
  shutdown(): Promise<void>;
}>;

export type HarnessBrowserServiceHandle = Readonly<
  HarnessIdentity & {
    processNonce: string;
    databaseUrl: string;
    environment: Record<string, string>;
    restart(): Promise<{
      oldProcessNonce: string;
      newProcessNonce: string;
    }>;
    cleanup(): Promise<void>;
    waitForReady(): Promise<void>;
  }
>;

export type HarnessBrowserControlServer = Readonly<{
  url: string;
  token: string;
  close(): Promise<void>;
}>;

export function createHarnessPublicBrowserEnvironment(
  testApiUrl: string,
): Readonly<{ BROWSER_PUBLIC_API_ORIGIN: string }> {
  const parsed = new URL(testApiUrl);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== testApiUrl
  ) {
    throw categorized(
      "harness_browser_public_origin_unsafe",
      "Harness Browser public origin must be an exact loopback API origin",
    );
  }
  return Object.freeze({ BROWSER_PUBLIC_API_ORIGIN: testApiUrl });
}

export function createHarnessBrowserShutdownCoordinator(): HarnessBrowserShutdownCoordinator {
  let registered:
    | Readonly<{
        cleanup: () => Promise<void>;
        exitFallback: () => void;
        abortStartup: () => void;
      }>
    | undefined;

  return {
    register(cleanup, exitFallback, abortStartup) {
      if (registered !== undefined) {
        throw categorized(
          "harness_browser_cleanup_already_registered",
          "Harness Browser cleanup is already registered",
        );
      }
      const registration = { cleanup, exitFallback, abortStartup };
      registered = registration;
      const exit = (): void => {
        if (registered === registration) {
          exitFallback();
        }
      };
      process.once("exit", exit);
      return () => {
        process.off("exit", exit);
        if (registered === registration) {
          registered = undefined;
        }
      };
    },
    async shutdown() {
      const registration = registered;
      if (registration === undefined) return;
      registration.abortStartup();
      await registration.cleanup();
    },
  };
}

const CONTROL_RESTART_PATH = "/v1/browser-service/restart";
const CONTROL_BODY_LIMIT_BYTES = 1024;
const CONTROL_BODY_TIMEOUT_MS = 2_000;

class HarnessControlRequestError extends Error {
  constructor(
    readonly status: number,
    readonly category: string,
    message: string,
  ) {
    super(message);
  }
}

function writeControlJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const bytes = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(bytes),
    connection: "close",
  });
  response.end(bytes);
}

function controlTokenMatches(
  authorization: string | undefined,
  token: string,
): boolean {
  if (authorization === undefined) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(authorization);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

function requireEmptyControlBody(request: IncomingMessage): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let bytes = 0;
    let hasBody = false;
    let settled = false;
    const finish = (failure?: HarnessControlRequestError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      if (failure === undefined) {
        resolvePromise();
      } else {
        request.resume();
        rejectPromise(failure);
      }
    };
    const onData = (chunk: Buffer | string): void => {
      hasBody = true;
      bytes += Buffer.byteLength(chunk);
      if (bytes > CONTROL_BODY_LIMIT_BYTES) {
        finish(
          new HarnessControlRequestError(
            413,
            "harness_browser_control_body_too_large",
            "Harness Browser control request body is too large",
          ),
        );
      }
    };
    const onEnd = (): void => {
      finish(
        hasBody
          ? new HarnessControlRequestError(
              400,
              "harness_browser_control_body_rejected",
              "Harness Browser restart does not accept a request body",
            )
          : undefined,
      );
    };
    const onAborted = (): void => {
      finish(
        new HarnessControlRequestError(
          400,
          "harness_browser_control_request_aborted",
          "Harness Browser control request was aborted",
        ),
      );
    };
    const onError = (): void => {
      finish(
        new HarnessControlRequestError(
          400,
          "harness_browser_control_request_failed",
          "Harness Browser control request failed",
        ),
      );
    };
    const timer = setTimeout(() => {
      finish(
        new HarnessControlRequestError(
          408,
          "harness_browser_control_body_timeout",
          "Harness Browser control request body timed out",
        ),
      );
    }, CONTROL_BODY_TIMEOUT_MS);
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

export async function startHarnessBrowserControlServer(
  browser: Pick<HarnessBrowserServiceHandle, "restart">,
): Promise<HarnessBrowserControlServer> {
  const token = randomBytes(32).toString("base64url");
  let restartActive = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    if (!controlTokenMatches(request.headers.authorization, token)) {
      request.resume();
      writeControlJson(response, 401, {
        success: false,
        category: "harness_browser_control_unauthorized",
      });
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      response.setHeader("allow", "POST");
      writeControlJson(response, 405, {
        success: false,
        category: "harness_browser_control_method_rejected",
      });
      return;
    }
    if (request.url !== CONTROL_RESTART_PATH) {
      request.resume();
      writeControlJson(response, 404, {
        success: false,
        category: "harness_browser_control_path_rejected",
      });
      return;
    }
    if (closing) {
      request.resume();
      writeControlJson(response, 503, {
        success: false,
        category: "harness_browser_control_closing",
      });
      return;
    }
    if (restartActive) {
      request.resume();
      writeControlJson(response, 409, {
        success: false,
        category: "harness_browser_restart_in_progress",
      });
      return;
    }
    try {
      await requireEmptyControlBody(request);
    } catch (cause) {
      const failure =
        cause instanceof HarnessControlRequestError
          ? cause
          : new HarnessControlRequestError(
              400,
              "harness_browser_control_request_failed",
              "Harness Browser control request failed",
            );
      writeControlJson(response, failure.status, {
        success: false,
        category: failure.category,
      });
      return;
    }

    if (closing) {
      writeControlJson(response, 503, {
        success: false,
        category: "harness_browser_control_closing",
      });
      return;
    }
    if (restartActive) {
      writeControlJson(response, 409, {
        success: false,
        category: "harness_browser_restart_in_progress",
      });
      return;
    }
    restartActive = true;
    try {
      const restarted = await browser.restart();
      writeControlJson(response, 200, restarted);
    } catch (cause) {
      writeControlJson(response, 500, {
        success: false,
        category:
          cause instanceof Error &&
          "category" in cause &&
          typeof cause.category === "string"
            ? cause.category
            : "harness_browser_restart_failed",
      });
    } finally {
      restartActive = false;
    }
  });
  server.requestTimeout = CONTROL_BODY_TIMEOUT_MS;
  server.headersTimeout = CONTROL_BODY_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (cause: Error): void => {
      server.off("listening", onListening);
      rejectPromise(cause);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address() as AddressInfo;
  const close = (): Promise<void> => {
    closing = true;
    if (closePromise !== undefined) return closePromise;
    closePromise = new Promise((resolvePromise, rejectPromise) => {
      server.close(error =>
        error === undefined ? resolvePromise() : rejectPromise(error),
      );
      server.closeIdleConnections();
    });
    return closePromise;
  };
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    token,
    close,
  });
}

function categorized(category: string, message: string): Error {
  return Object.assign(new Error(message), { category });
}

async function provisionBrowserStateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: BROWSER_STATE_MODE });
  await chown(path, BROWSER_UID, BROWSER_GID);
  await chmod(path, BROWSER_STATE_MODE);
}

async function validateBrowserStateDirectory(
  path: string,
  expectedDevice: number,
  label: string,
): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== expectedDevice ||
    metadata.uid !== BROWSER_UID ||
    metadata.gid !== BROWSER_GID ||
    (metadata.mode & 0o7777) !== BROWSER_STATE_MODE
  ) {
    throw categorized(
      "harness_browser_root_unsafe",
      `Harness ${label} does not match the Browser state layout policy`,
    );
  }
}

async function assertExactDirectoryChildren(
  path: string,
  expected: readonly string[],
  label: string,
): Promise<void> {
  const children = (await readdir(path)).sort();
  if (
    children.length !== expected.length ||
    children.some((child, index) => child !== expected[index])
  ) {
    throw categorized(
      "harness_browser_root_collision",
      `Harness ${label} layout is partial or unknown`,
    );
  }
}

async function provisionBrowserStateLayout(
  stateRoot: string,
  expectedDevice: number,
): Promise<void> {
  const profiles = join(stateRoot, "profiles");
  const staging = join(stateRoot, ".profile-publish-staging");
  const bundles = join(staging, "bundles");
  const intents = join(staging, "intents");

  await provisionBrowserStateDirectory(profiles);
  await provisionBrowserStateDirectory(staging);
  await provisionBrowserStateDirectory(bundles);
  await provisionBrowserStateDirectory(intents);

  await validateBrowserStateDirectory(stateRoot, expectedDevice, "state root");
  await assertExactDirectoryChildren(
    stateRoot,
    BROWSER_STATE_CHILDREN,
    "state root",
  );
  await validateBrowserStateDirectory(
    profiles,
    expectedDevice,
    "profiles directory",
  );
  await validateBrowserStateDirectory(
    staging,
    expectedDevice,
    "publication staging directory",
  );
  await assertExactDirectoryChildren(
    staging,
    BROWSER_STAGING_CHILDREN,
    "publication staging",
  );
  await validateBrowserStateDirectory(
    bundles,
    expectedDevice,
    "publication bundles directory",
  );
  await validateBrowserStateDirectory(
    intents,
    expectedDevice,
    "publication intents directory",
  );
}

function assertNoExternalOverrides(env: NodeJS.ProcessEnv): void {
  for (const name of HARNESS_BROWSER_EXTERNAL_OVERRIDES) {
    if (env[name] !== undefined) {
      throw categorized(
        "harness_external_browser_override_rejected",
        `Harness rejects inherited ${name}`,
      );
    }
  }
}

export function assertNoHarnessBrowserUserOverrides(
  env: NodeJS.ProcessEnv,
): void {
  assertNoExternalOverrides(env);
  if (env[HARNESS_BROWSER_PUBLIC_ORIGIN_OVERRIDE] !== undefined) {
    throw categorized(
      "harness_external_browser_override_rejected",
      `Harness rejects inherited ${HARNESS_BROWSER_PUBLIC_ORIGIN_OVERRIDE}`,
    );
  }
}

function createIdentity(
  tempParent: string,
  browserPort: number,
  databasePort: number,
): HarnessIdentity {
  const invocationId = randomBytes(16).toString("hex");
  const ownershipToken = randomBytes(32).toString("base64url");
  const suffix = invocationId.slice(0, 20);
  const stateRoot = join(tempParent, `state-${invocationId}`);
  return Object.freeze({
    invocationId,
    ownershipToken,
    serviceKey: randomBytes(32).toString("base64url"),
    replayIngestKey: randomBytes(32).toString("base64url"),
    stateRoot,
    ownershipMarker: `${stateRoot}.owner`,
    databaseName: `firecrawl_${suffix}`,
    databaseContainerName: `firecrawl-browser-db-${suffix}`,
    databasePort,
    containerName: `firecrawl-browser-${suffix}`,
    projectName: `firecrawl-browser-harness-${suffix}`,
    browserPort,
  });
}

export async function startHarnessBrowserService(
  deps: HarnessBrowserServiceDependencies,
): Promise<HarnessBrowserServiceHandle> {
  await deps.validateEnvironment();
  assertNoExternalOverrides(deps.env);
  const runtime = await deps.detectRuntime();
  if (runtime === null) {
    throw categorized(
      "harness_container_runtime_missing",
      "Neither Docker nor Podman is available",
    );
  }
  await deps.buildImage(runtime, IMAGE, deps.monorepoRoot);
  const [browserPort, databasePort] = await Promise.all([
    deps.allocatePort(),
    deps.allocatePort(),
  ]);
  if (browserPort === databasePort) {
    throw categorized(
      "harness_port_collision",
      "Harness allocated the same port twice",
    );
  }
  const identity = createIdentity(deps.tempParent, browserPort, databasePort);
  deps.onIdentitiesPrecomputed?.(identity);

  const state: ResourceState = {
    root: false,
    database: false,
    container: false,
  };
  const startupAbort = new AbortController();
  let rootIdentity: RootIdentity | undefined;
  let activeStartupPhase: Promise<unknown> = Promise.resolve();
  let cleanupRequested = false;
  let cleanupPromise: Promise<void> | undefined;
  let cleanupComplete = false;
  let restartPromise:
    | Promise<{
        oldProcessNonce: string;
        newProcessNonce: string;
      }>
    | undefined;
  let currentLive: HarnessBrowserLive | undefined;
  let unregister = (): void => {};
  const runStartupPhase = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    markMayExist?: () => void,
  ): Promise<T> => {
    if (cleanupRequested || startupAbort.signal.aborted) {
      throw categorized(
        "harness_browser_startup_aborted",
        "Harness Browser startup was aborted",
      );
    }
    markMayExist?.();
    const phase = operation(startupAbort.signal);
    activeStartupPhase = phase;
    const value = await phase;
    if (cleanupRequested || startupAbort.signal.aborted) {
      throw categorized(
        "harness_browser_startup_aborted",
        "Harness Browser startup was aborted",
      );
    }
    return value;
  };
  const cleanup = (): Promise<void> => {
    cleanupRequested = true;
    startupAbort.abort();
    if (cleanupComplete) return Promise.resolve();
    if (cleanupPromise !== undefined) return cleanupPromise;
    const attempt = (async () => {
      await activeStartupPhase.catch(() => undefined);
      await restartPromise?.catch(() => undefined);
      const failures: unknown[] = [];
      if (state.container) {
        try {
          await deps.removeContainer(runtime, identity);
          state.container = false;
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length === 0 && state.database) {
        try {
          await deps.dropDatabase(runtime, identity);
          state.database = false;
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length === 0 && state.root) {
        if (rootIdentity === undefined) {
          failures.push(
            categorized(
              "harness_browser_ownership_mismatch",
              "Harness root identity was not recorded",
            ),
          );
        } else {
          try {
            await deps.removeRoot(identity, rootIdentity);
            state.root = false;
          } catch (cause) {
            failures.push(cause);
          }
        }
      }
      if (failures.length !== 0) {
        throw new AggregateError(failures, "Harness Browser cleanup failed");
      }
      cleanupComplete = true;
      unregister();
    })();
    cleanupPromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (cleanupPromise === attempt) cleanupPromise = undefined;
      },
    );
    return attempt;
  };
  unregister = deps.registerCleanup(
    cleanup,
    () => {
      deps.exitFallback?.(runtime, identity, state, rootIdentity);
    },
    () => {
      cleanupRequested = true;
      startupAbort.abort();
    },
  );
  deps.onCleanupRegistered?.(() => {
    cleanupRequested = true;
    startupAbort.abort();
  });

  try {
    await runStartupPhase(
      async () => {
        const createdRootIdentity = await deps.createRoot(
          identity,
          publishedIdentity => {
            rootIdentity = Object.freeze({ ...publishedIdentity });
          },
        );
        rootIdentity ??= Object.freeze({ ...createdRootIdentity });
        return createdRootIdentity;
      },
      () => {
        state.root = true;
      },
    );
    const database = await runStartupPhase(
      () => deps.createDatabase(runtime, identity),
      () => {
        state.database = true;
      },
    );
    // A failed `run` may have created the container before its process failed.
    await runStartupPhase(
      () => deps.runContainer(runtime, identity),
      () => {
        state.container = true;
      },
    );
    const live = await runStartupPhase(() => deps.waitForLive(identity));
    if (!PROCESS_NONCE.test(live.processNonce)) {
      throw categorized(
        "harness_browser_process_nonce_invalid",
        "Browser Service returned a noncanonical process nonce",
      );
    }
    currentLive = live;
    const environment = Object.freeze({
      LOCAL_BROWSER_SERVICE_ENABLED: "true",
      LOCAL_BROWSER_STATE_ROOT: identity.stateRoot,
      BROWSER_SERVICE_URL: `http://127.0.0.1:${identity.browserPort}`,
      BROWSER_SERVICE_API_KEY: identity.serviceKey,
      BROWSER_REPLAY_INGEST_API_KEY: identity.replayIngestKey,
      APPLICATION_DATABASE_URL: database.databaseUrl,
    });
    const handle = {
      ...identity,
      get processNonce() {
        return currentLive!.processNonce;
      },
      databaseUrl: database.databaseUrl,
      environment,
      restart(): Promise<{
        oldProcessNonce: string;
        newProcessNonce: string;
      }> {
        if (cleanupRequested || cleanupComplete) {
          return Promise.reject(
            categorized(
              "harness_browser_restart_unavailable",
              "Harness Browser restart is unavailable during cleanup",
            ),
          );
        }
        if (restartPromise !== undefined) return restartPromise;
        const restart = (async () => {
          const oldProcessNonce = currentLive!.processNonce;
          await deps.removeContainer(runtime, identity);
          state.container = false;
          if (cleanupRequested) {
            throw categorized(
              "harness_browser_restart_unavailable",
              "Harness Browser restart was interrupted by cleanup",
            );
          }
          // A failed run may create the container before returning an error.
          state.container = true;
          await deps.runContainer(runtime, identity);
          const replacement = await deps.waitForLive(identity);
          if (
            !PROCESS_NONCE.test(replacement.processNonce) ||
            replacement.processNonce === oldProcessNonce
          ) {
            throw categorized(
              "harness_browser_process_nonce_invalid",
              "Restarted Browser Service returned an invalid process nonce",
            );
          }
          await deps.waitForReady?.(
            identity,
            replacement,
            database.databaseUrl,
          );
          currentLive = replacement;
          return Object.freeze({
            oldProcessNonce,
            newProcessNonce: replacement.processNonce,
          });
        })();
        restartPromise = restart;
        void restart.then(
          () => {
            if (restartPromise === restart) restartPromise = undefined;
          },
          () => {
            if (restartPromise === restart) restartPromise = undefined;
          },
        );
        return restart;
      },
      cleanup,
      waitForReady: async () => {
        await deps.waitForReady?.(identity, currentLive!, database.databaseUrl);
      },
    } satisfies HarnessBrowserServiceHandle;
    return Object.freeze(handle);
  } catch (cause) {
    try {
      await cleanup();
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Harness Browser startup and cleanup failed",
      );
    }
    throw cause;
  }
}

type RunResult = Readonly<{ stdout: string; stderr: string }>;

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk.toString()));
    child.stderr.on("data", chunk => (stderr += chunk.toString()));
    child.once("error", rejectPromise);
    child.once("close", code => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(
          new Error(
            `${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function allocateLoopbackPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Unable to allocate loopback port"));
        return;
      }
      server.close(error =>
        error ? rejectPromise(error) : resolvePromise(address.port),
      );
    });
  });
}

async function waitUntil(
  operation: () => Promise<boolean>,
  description: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCause: unknown;
  while (Date.now() < deadline) {
    try {
      if (await operation()) return;
    } catch (cause) {
      lastCause = cause;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw Object.assign(new Error(`${description} timed out`), {
    cause: lastCause,
  });
}

async function assertOwnedContainer(
  runtime: string,
  name: string,
  ownershipToken: string,
): Promise<boolean> {
  let result: RunResult;
  try {
    result = await run(runtime, [
      "inspect",
      "--format",
      '{{index .Config.Labels "firecrawl.harness.invocation"}}',
      name,
    ]);
  } catch (cause) {
    if (
      cause instanceof Error &&
      /no such (?:object|container)/i.test(cause.message)
    ) {
      return false;
    }
    throw cause;
  }
  if (result.stdout.trim() !== ownershipToken) {
    throw categorized(
      "harness_browser_ownership_mismatch",
      `Harness refuses to remove unowned container ${name}`,
    );
  }
  return true;
}

function privateHeaders(serviceKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${serviceKey}`,
    "x-firecrawl-correlation-id": randomBytes(16).toString("hex"),
    "x-firecrawl-deadline": new Date(Date.now() + 30_000).toISOString(),
  };
}

export function createBrowserContainerInvocation(
  identity: Pick<
    HarnessIdentity,
    | "containerName"
    | "projectName"
    | "ownershipToken"
    | "browserPort"
    | "stateRoot"
    | "serviceKey"
  >,
): Readonly<{ args: readonly string[]; env: NodeJS.ProcessEnv }> {
  return {
    args: [
      "run",
      "--detach",
      "--name",
      identity.containerName,
      "--label",
      `com.docker.compose.project=${identity.projectName}`,
      "--label",
      `firecrawl.harness.invocation=${identity.ownershipToken}`,
      "--publish",
      `127.0.0.1:${identity.browserPort}:3010`,
      "--user",
      "1000:1000",
      "--read-only",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=1g",
      "--mount",
      `type=bind,src=${identity.stateRoot},dst=/var/lib/firecrawl-browser`,
      "--env",
      "PORT=3010",
      "--env",
      "BROWSER_SERVICE_API_KEY",
      "--env",
      "LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser",
      IMAGE,
    ],
    env: { BROWSER_SERVICE_API_KEY: identity.serviceKey },
  };
}

export function createDefaultHarnessBrowserServiceDependencies(options: {
  env?: NodeJS.ProcessEnv;
  tempParent: string;
  monorepoRoot: string;
  shutdownCoordinator: HarnessBrowserShutdownCoordinator;
}): HarnessBrowserServiceDependencies {
  const env = options.env ?? process.env;
  return {
    env,
    tempParent: options.tempParent,
    monorepoRoot: options.monorepoRoot,
    async validateEnvironment() {
      const metadata = await lstat(options.tempParent);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw categorized(
          "harness_browser_root_unsafe",
          "Harness temp parent must be a directory",
        );
      }
      const parent = await realpath(options.tempParent);
      if (parent !== resolve(options.tempParent)) {
        throw categorized(
          "harness_browser_root_unsafe",
          "Harness temp parent must be canonical",
        );
      }
    },
    async detectRuntime() {
      for (const runtime of ["docker", "podman"]) {
        try {
          await run(runtime, ["--version"]);
          return runtime;
        } catch {}
      }
      return null;
    },
    async buildImage(runtime, image, root) {
      await run(
        runtime,
        [
          "build",
          "--file",
          "apps/browser-service/Dockerfile",
          "--tag",
          image,
          ".",
        ],
        { cwd: root },
      );
    },
    allocatePort: allocateLoopbackPort,
    registerCleanup(cleanup, exitFallback, abortStartup) {
      return options.shutdownCoordinator.register(
        cleanup,
        exitFallback,
        abortStartup,
      );
    },
    async createRoot(identity, publishIdentity) {
      const parent = await realpath(options.tempParent);
      const expectedPrefix = `${parent}${sep}`;
      if (
        resolve(identity.stateRoot) !== identity.stateRoot ||
        !identity.stateRoot.startsWith(expectedPrefix)
      ) {
        throw categorized(
          "harness_browser_root_unsafe",
          "Harness state root escapes temp parent",
        );
      }
      await mkdir(identity.stateRoot, { mode: 0o700 });
      await chown(identity.stateRoot, BROWSER_UID, BROWSER_GID);
      await chmod(identity.stateRoot, BROWSER_STATE_MODE);
      const rootIdentity = await lstat(identity.stateRoot);
      if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
        throw categorized(
          "harness_browser_root_unsafe",
          "Harness state root is not a directory",
        );
      }
      const contents = await readdir(identity.stateRoot);
      if (contents.length !== 0) {
        throw categorized(
          "harness_browser_root_collision",
          "Harness state root is not empty",
        );
      }
      await writeFile(identity.ownershipMarker, identity.ownershipToken, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const authority = Object.freeze({
        dev: rootIdentity.dev,
        ino: rootIdentity.ino,
      });
      publishIdentity(authority);
      await provisionBrowserStateLayout(identity.stateRoot, rootIdentity.dev);
      return authority;
    },
    async createDatabase(runtime, identity) {
      await run(runtime, [
        "run",
        "--detach",
        "--name",
        identity.databaseContainerName,
        "--label",
        `com.docker.compose.project=${identity.projectName}`,
        "--label",
        `firecrawl.harness.invocation=${identity.ownershipToken}`,
        "--publish",
        `127.0.0.1:${identity.databasePort}:5432`,
        "--env",
        "POSTGRES_USER=firecrawl",
        "--env",
        "POSTGRES_PASSWORD=firecrawl",
        "--env",
        `POSTGRES_DB=${identity.databaseName}`,
        "postgres:17.10-bookworm",
      ]);
      const databaseUrl =
        `postgresql://firecrawl:firecrawl@127.0.0.1:` +
        `${identity.databasePort}/${identity.databaseName}`;
      await waitUntil(async () => {
        const client = new Client({
          connectionString: databaseUrl,
          connectionTimeoutMillis: 1_000,
        });
        try {
          await client.connect();
          await client.query("SELECT 1");
          return true;
        } finally {
          await client.end().catch(() => undefined);
        }
      }, "Harness PostgreSQL readiness");
      return { databaseUrl };
    },
    async runContainer(runtime, identity) {
      const invocation = createBrowserContainerInvocation(identity);
      await run(runtime, invocation.args, { env: invocation.env });
    },
    async waitForLive(identity) {
      let processNonce = "";
      await waitUntil(async () => {
        const response = await fetch(
          `http://127.0.0.1:${identity.browserPort}/health/live`,
          {
            headers: privateHeaders(identity.serviceKey),
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (!response.ok) return false;
        const body = (await response.json()) as { processNonce?: unknown };
        if (typeof body.processNonce !== "string") return false;
        processNonce = body.processNonce;
        return true;
      }, "Browser Service authenticated liveness");
      return { processNonce };
    },
    async waitForReady(identity, live, databaseUrl) {
      await waitUntil(async () => {
        const client = new Client({
          connectionString: databaseUrl,
          connectionTimeoutMillis: 1_000,
        });
        let row:
          | {
              process_nonce: string | null;
              control_generation_nonce: string | null;
            }
          | undefined;
        try {
          await client.connect();
          const result = await client.query(
            `SELECT process_nonce, control_generation_nonce
               FROM browser_control_generation WHERE singleton_id = 1`,
          );
          row = result.rows[0];
        } finally {
          await client.end().catch(() => undefined);
        }
        if (
          row?.process_nonce !== live.processNonce ||
          typeof row.control_generation_nonce !== "string"
        ) {
          return false;
        }
        const response = await fetch(
          `http://127.0.0.1:${identity.browserPort}/health/ready`,
          {
            headers: {
              ...privateHeaders(identity.serviceKey),
              "x-firecrawl-process-nonce": row.process_nonce,
              "x-firecrawl-control-generation-nonce":
                row.control_generation_nonce,
            },
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (!response.ok) return false;
        const body = (await response.json()) as {
          processNonce?: unknown;
          controlGenerationNonce?: unknown;
          snapshotDigest?: unknown;
        };
        return (
          body.processNonce === row.process_nonce &&
          body.controlGenerationNonce === row.control_generation_nonce &&
          typeof body.snapshotDigest === "string" &&
          /^[a-f0-9]{64}$/.test(body.snapshotDigest)
        );
      }, "API-confirmed Browser Service readiness");
    },
    async removeContainer(runtime, identity) {
      if (
        !(await assertOwnedContainer(
          runtime,
          identity.containerName,
          identity.ownershipToken,
        ))
      ) {
        return;
      }
      await run(runtime, ["rm", "--force", identity.containerName]);
    },
    async dropDatabase(runtime, identity) {
      if (
        !(await assertOwnedContainer(
          runtime,
          identity.databaseContainerName,
          identity.ownershipToken,
        ))
      ) {
        return;
      }
      await run(runtime, [
        "rm",
        "--force",
        "--volumes",
        identity.databaseContainerName,
      ]);
    },
    async removeRoot(identity, expectedIdentity) {
      if (expectedIdentity === undefined) {
        throw categorized(
          "harness_browser_ownership_mismatch",
          "Harness root identity was not recorded",
        );
      }
      const marker = await readFile(identity.ownershipMarker, "utf8");
      if (marker !== identity.ownershipToken) {
        throw categorized(
          "harness_browser_ownership_mismatch",
          "Harness root ownership marker changed",
        );
      }
      const rootStat = await lstat(identity.stateRoot);
      if (rootStat.isSymbolicLink()) {
        throw categorized(
          "harness_browser_root_unsafe",
          "Harness root became a symlink",
        );
      }
      if (
        rootStat.dev !== expectedIdentity.dev ||
        rootStat.ino !== expectedIdentity.ino
      ) {
        throw categorized(
          "harness_browser_ownership_mismatch",
          "Harness root identity changed",
        );
      }
      await rm(identity.stateRoot, { recursive: true, force: false });
      await rm(identity.ownershipMarker, { force: false });
    },
    exitFallback(runtime, identity, state, rootIdentity) {
      if (state.container) {
        const inspection = spawnSync(
          runtime,
          [
            "inspect",
            "--format",
            '{{index .Config.Labels "firecrawl.harness.invocation"}}',
            identity.containerName,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        if (
          inspection.status !== 0 ||
          inspection.stdout.trim() !== identity.ownershipToken
        ) {
          return;
        }
        const removal = spawnSync(
          runtime,
          ["rm", "--force", identity.containerName],
          {
            stdio: "ignore",
          },
        );
        if (removal.status !== 0) {
          return;
        }
      }
      if (state.database) {
        const inspection = spawnSync(
          runtime,
          [
            "inspect",
            "--format",
            '{{index .Config.Labels "firecrawl.harness.invocation"}}',
            identity.databaseContainerName,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        if (
          inspection.status !== 0 ||
          inspection.stdout.trim() !== identity.ownershipToken
        ) {
          return;
        }
        const removal = spawnSync(
          runtime,
          ["rm", "--force", "--volumes", identity.databaseContainerName],
          { stdio: "ignore" },
        );
        if (removal.status !== 0) {
          return;
        }
      }
      if (state.root) {
        try {
          if (
            rootIdentity === undefined ||
            readFileSync(identity.ownershipMarker, "utf8") !==
              identity.ownershipToken
          ) {
            return;
          }
          const current = lstatSync(identity.stateRoot);
          if (
            current.dev === rootIdentity.dev &&
            current.ino === rootIdentity.ino &&
            !current.isSymbolicLink()
          ) {
            rmSync(identity.stateRoot, { recursive: true, force: true });
            rmSync(identity.ownershipMarker, { force: true });
          }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
            rmSync(identity.ownershipMarker, { force: true });
          }
        }
      }
    },
  };
}
