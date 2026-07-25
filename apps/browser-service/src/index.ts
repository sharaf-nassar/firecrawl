import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createArtifactService } from "./artifacts.js";
import type {
  AtomicPublicationObservabilityEvent,
  AtomicPublicationObservabilitySink,
} from "./atomic-publication-observability.js";
import {
  type BrowserServiceConfig,
  readBrowserServiceConfig,
} from "./config.js";
import type { ReconciliationRequestV1 } from "./contracts.js";
import { BrowserServiceError } from "./errors.js";
import { createProfileStore } from "./profile-store.js";
import {
  acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot,
  closeAtomicEffectController,
  reconcileBrowserStateWithAuthority,
  type InternalReconciliationOutcome,
} from "./reconciliation.js";
import { createSessionRegistry } from "./session-registry.js";
import {
  createBrowserServiceServer,
  type BrowserGenerationRuntime,
  type BrowserServiceServer,
} from "./server.js";
import {
  createInternalStartupState,
  type InstalledAuthorityBundle,
  type InternalStartupAdmission,
  type ReconciliationExecutionAdmission,
} from "./startup-state.js";
import { createRelayGrantManager } from "./streams.js";

export type BrowserServiceApplication = Readonly<{
  config: BrowserServiceConfig;
  admission: InternalStartupAdmission;
  server: BrowserServiceServer;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  currentRuntime(): BrowserGenerationRuntime | null;
}>;

export type BrowserServiceApplicationOptions = Readonly<{
  config?: BrowserServiceConfig;
  atomicPublicationSink?: AtomicPublicationObservabilitySink;
  startupAdmissionTimeoutMs?: number;
}>;

const STARTUP_ADMISSION_TIMEOUT_MS = 5_000;

function defaultAtomicPublicationSink(
  event: AtomicPublicationObservabilityEvent,
): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function startupFilesystemError(
  cause: unknown,
  message = "browser state root startup validation failed",
): BrowserServiceError {
  if (
    cause instanceof BrowserServiceError &&
    cause.category === "reconciliation_filesystem_unsafe"
  ) {
    return cause;
  }
  const failure = new BrowserServiceError(
    "reconciliation_filesystem_unsafe",
    message,
  );
  Object.defineProperty(failure, "cause", { value: cause });
  return failure;
}

async function validateBrowserStateRootForStartup(
  stateRoot: string,
  processNonce: string,
  timeoutMs: number,
  cancellationSignal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const deadlineFailure = new BrowserServiceError(
    "reconciliation_filesystem_unsafe",
    "browser state root startup validation deadline exceeded",
  );
  const cancel = (): void => {
    if (controller.signal.aborted) return;
    controller.abort(
      startupFilesystemError(
        cancellationSignal.reason,
        "browser state root startup validation cancelled",
      ),
    );
  };
  const deadline = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(deadlineFailure);
  }, timeoutMs);
  cancellationSignal.addEventListener("abort", cancel, { once: true });
  if (cancellationSignal.aborted) cancel();
  const executionAdmission: ReconciliationExecutionAdmission =
    Object.freeze({
      signal: controller.signal,
      assertAdmitted() {
        controller.signal.throwIfAborted();
      },
    });
  const validation = (async () => {
    let lease: Awaited<
      ReturnType<
        typeof acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot
      >
    >;
    try {
      lease =
        await acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
          stateRoot,
          Object.freeze({
            processNonce,
            controlGenerationNonce: randomBytes(32).toString("base64url"),
            snapshotDigest: "0".repeat(64),
          }),
          executionAdmission,
          randomUUID(),
        );
    } catch (cause) {
      throw startupFilesystemError(cause);
    }
    const cleanup = await Promise.allSettled([
      closeAtomicEffectController(lease.controller),
      lease.closeRoot(),
    ]);
    const failures = cleanup.flatMap(result =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) {
      throw startupFilesystemError(failures[0]);
    }
    if (failures.length > 1) {
      throw startupFilesystemError(
        new AggregateError(
          failures,
          "browser state root startup cleanup failed",
        ),
        "browser state root startup cleanup failed",
      );
    }
  })();
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = (): void => {
      reject(startupFilesystemError(controller.signal.reason));
    };
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, {
      once: true,
    });
  });
  try {
    await Promise.race([validation, aborted]);
  } finally {
    clearTimeout(deadline);
    cancellationSignal.removeEventListener("abort", cancel);
    if (!controller.signal.aborted) controller.abort();
    void validation.catch(() => undefined);
  }
}

export function createBrowserServiceApplication(
  options: BrowserServiceApplicationOptions = {},
): BrowserServiceApplication {
  const config = options.config ?? readBrowserServiceConfig();
  const startupAdmissionTimeoutMs =
    options.startupAdmissionTimeoutMs ?? STARTUP_ADMISSION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(startupAdmissionTimeoutMs) ||
    startupAdmissionTimeoutMs <= 0
  ) {
    throw new RangeError(
      "startupAdmissionTimeoutMs must be a positive safe integer",
    );
  }
  const atomicPublicationSink =
    options.atomicPublicationSink ?? defaultAtomicPublicationSink;
  let installedBundle: InstalledAuthorityBundle | null = null;
  let generationRuntime: BrowserGenerationRuntime | null = null;
  let admission!: InternalStartupAdmission;

  admission = createInternalStartupState({
    createProfileStore: (root, binding) =>
      createProfileStore({ root, binding }),
    compareAndSwapInstall(current, next) {
      if (
        current !== installedBundle ||
        current !== null ||
        generationRuntime !== null
      ) {
        return false;
      }
      const binding = Object.freeze({
        processNonce: next.binding.processNonce,
        controlGenerationNonce: next.binding.controlGenerationNonce,
      });
      let routeAdmissionOpen = true;
      const fenceRouteAdmission = (): void => {
        routeAdmissionOpen = false;
      };
      const registry = createSessionRegistry({
        admission: {
          processNonce: admission.processNonce,
          requireReady(requested) {
            if (!routeAdmissionOpen) {
              throw new BrowserServiceError(
                "reconciliation_required",
                "generation route admission is closed",
              );
            }
            return admission.requireReady(requested);
          },
          beginDraining() {
            if (!routeAdmissionOpen) return;
            fenceRouteAdmission();
            admission.beginDraining();
          },
        },
        binding,
        profileStore: next.profileStore,
      });
      const grants = createRelayGrantManager({
        registry,
        binding,
        authBinding: config.apiKey,
      });
      const artifacts = createArtifactService({ registry });
      generationRuntime = Object.freeze({
        binding,
        fenceRouteAdmission,
        registry,
        grants,
        artifacts,
        profileStore: next.profileStore,
      });
      installedBundle = next;
      return true;
    },
  });

  const reconcile = (
    request: ReconciliationRequestV1,
    executionAdmission: ReconciliationExecutionAdmission,
    correlationId: string,
  ): Promise<InternalReconciliationOutcome> =>
    reconcileBrowserStateWithAuthority(config.stateRoot, request, {
      admission: executionAdmission,
      correlationId,
      atomicPublicationSink,
    });

  const server = createBrowserServiceServer({
    apiKey: config.apiKey,
    admission,
    runtime: {
      current: () => generationRuntime,
      release(runtime) {
        if (generationRuntime !== runtime) return;
        generationRuntime = null;
        installedBundle = null;
      },
    },
    reconcile,
  });

  let startPromise: Promise<void> | undefined;
  const startupController = new AbortController();
  const application: BrowserServiceApplication = Object.freeze({
    config,
    admission,
    server,
    start() {
      startPromise ??= (async () => {
        await validateBrowserStateRootForStartup(
          config.stateRoot,
          admission.processNonce,
          startupAdmissionTimeoutMs,
          startupController.signal,
        );
        await server.listen(config.port, "0.0.0.0");
      })();
      return startPromise;
    },
    shutdown() {
      startupController.abort();
      return server.beginShutdown();
    },
    currentRuntime() {
      return generationRuntime;
    },
  });
  return application;
}

export async function startBrowserService(): Promise<BrowserServiceApplication> {
  const application = createBrowserServiceApplication();
  await application.start();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void application.shutdown().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return application;
}

const entrypoint =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(process.argv[1]).href;
if (entrypoint === import.meta.url) {
  await startBrowserService();
}
