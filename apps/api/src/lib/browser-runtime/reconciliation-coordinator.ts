import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { inspectBrowserStateProcessIdentity } from "../browser-state/process-identity";
import { logger as defaultLogger } from "../logger";
import {
  API_INSTANCE_ID,
  BrowserServiceClient,
  BrowserServiceClientError,
  createHandoffIdempotencyKey,
  type BrowserServiceRequestContext,
} from "../scrape-interact/browser-service-client";
import {
  reconciliationRequestV1Schema,
  type CreateControlGenerationV1,
} from "../scrape-interact/browser-service-contracts";
import { interruptUnfinishedBrowserWork } from "../browser-state/store";
import { recoverBrowserCleanupIntentsBeforeSnapshot } from "../../services/local-retention-worker";
import type { BrowserStateFileDeleter } from "../../services/local-retention-worker";
import { loadBrowserReconciliationSnapshot } from "./reconciliation-snapshot";
import {
  type BrowserMutationDrain,
  type BrowserControlFenceTransaction,
  type BrowserStateMutationLease,
  type BrowserStartupBinding,
  type BrowserStartupGate,
} from "./startup-gate";

/** @public */
export type BrowserReconciliationRetryConfig = {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  startupBudgetMs: number;
  monitorIntervalMs: number;
  retryCooldownMs: number;
};

/** @public */
export type BrowserReconciliationCoordinatorDependencies = {
  gate: BrowserStartupGate;
  pool: Pick<Pool, "connect">;
  deleteReplayCheckpoint?: (
    statePath: string,
    checksum: string,
    lease: BrowserStateMutationLease,
  ) => Promise<void>;
  /** @internal Legacy test injection; production uses Browser Service. */
  filesystem?: BrowserStateFileDeleter;
  inspectProcessIdentity: typeof inspectBrowserStateProcessIdentity;
  serviceClient: Pick<
    BrowserServiceClient,
    | "discoverLive"
    | "createControlGeneration"
    | "getLive"
    | "getReady"
    | "reconcile"
  >;
  loadSnapshot: typeof loadBrowserReconciliationSnapshot;
  interruptUnfinishedBrowserWork: typeof interruptUnfinishedBrowserWork;
  recoverBrowserCleanupIntentsBeforeSnapshot: typeof recoverBrowserCleanupIntentsBeforeSnapshot;
  pauseBrowserRetention: () => Promise<void>;
  startBrowserRetention: () => Promise<void>;
  retry: BrowserReconciliationRetryConfig;
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  logger: Pick<typeof defaultLogger, "info" | "error">;
};

/** @public */
export type BrowserControlGenerationHandoff = {
  apiInstanceId: string;
  idempotencyKey: string;
  processNonce: string;
  controlGenerationNonce: string;
  canonicalRequestBody: string;
  deadlineMs: number;
  drain: BrowserMutationDrain;
};

/** @public */
export type BrowserReconciliationCoordinator = {
  acquireControlGeneration(
    signal?: AbortSignal,
  ): Promise<BrowserControlGenerationHandoff>;
  initializeAfterMigrations(
    handoff: BrowserControlGenerationHandoff,
    signal?: AbortSignal,
  ): Promise<BrowserStartupBinding>;
  checkNow(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
};

/** @public */
export class BrowserReconciliationCoordinatorError extends Error {
  readonly category = "browser_state_unavailable";

  constructor(cause?: unknown) {
    super("Browser state is unavailable", { cause });
    this.name = "BrowserReconciliationCoordinatorError";
  }
}

class ServiceProcessChangedError extends Error {}
class HandoffProcessChangedError extends Error {}
class ServiceControlLostError extends Error {}

type ControlRow = {
  database_control_epoch: string | number;
  api_instance_id: string;
  process_nonce: string;
  control_generation_nonce: string;
};

type HandoffTuple = {
  processNonce: string;
  idempotencyKey: string;
  request: CreateControlGenerationV1;
  canonicalRequestBody: string;
};

type FrozenReconciliationCycle = {
  databaseControlEpoch: number;
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
  canonicalRequestBody: string;
};

function canonicalControlBody(request: CreateControlGenerationV1): string {
  return JSON.stringify({
    version: request.version,
    processNonce: request.processNonce,
    apiInstanceId: request.apiInstanceId,
    idempotencyKey: request.idempotencyKey,
  });
}

function requestContext(
  signal: AbortSignal,
  deadlineMs: number,
  binding?: {
    processNonce: string;
    controlGenerationNonce: string;
  },
): BrowserServiceRequestContext {
  return {
    correlationId: randomUUID(),
    deadline: new Date(deadlineMs),
    signal,
    ...(binding ?? {
      processNonce: "A".repeat(43),
      controlGenerationNonce: "A".repeat(43),
    }),
  };
}

function isNonRetryable(error: unknown): boolean {
  return (
    error instanceof ServiceControlLostError ||
    (error instanceof BrowserServiceClientError &&
      [
        "browser_service_authentication_failed",
        "browser_service_protocol_error",
        "control_generation_drain_failed",
        "control_generation_mismatch",
        "control_generation_superseded",
        "reconciliation_conflicting_replay",
      ].includes(error.category))
  );
}

function transactionPool(
  transaction: Pick<PoolClient, "query">,
): Pick<Pool, "connect"> {
  return {
    connect: async () =>
      ({
        query: transaction.query.bind(transaction),
        release() {},
      }) as PoolClient,
  };
}

function deadlineTransaction(
  transaction: BrowserControlFenceTransaction,
  signal: AbortSignal,
  deadlineMs: number,
  now: () => number,
): BrowserControlFenceTransaction {
  const query: PoolClient["query"] = (async (
    textOrConfig: unknown,
    values?: unknown[],
  ) => {
    signal.throwIfAborted();
    const remaining = deadlineMs - now();
    if (remaining <= 0) {
      throw new BrowserReconciliationCoordinatorError();
    }
    await transaction.query(
      `SELECT set_config('statement_timeout', $1, true),
              set_config('lock_timeout', $1, true)`,
      [`${remaining}ms`],
    );
    signal.throwIfAborted();
    return transaction.query(textOrConfig as never, values as never);
  }) as PoolClient["query"];
  return {
    query,
    databaseControlEpoch: transaction.databaseControlEpoch,
  };
}

/** @public */
export function createBrowserReconciliationCoordinator(
  deps: BrowserReconciliationCoordinatorDependencies,
): BrowserReconciliationCoordinator {
  const controller = new AbortController();
  let stopped = false;
  let currentBinding: BrowserStartupBinding | undefined;
  let authorityBinding: BrowserStartupBinding | undefined;
  let currentHandoff: BrowserControlGenerationHandoff | undefined;
  const handoffTuples = new Map<string, HandoffTuple>();
  const frozenCycles = new Map<string, FrozenReconciliationCycle>();
  const handoffBudgetStarts = new WeakMap<
    BrowserControlGenerationHandoff,
    number
  >();
  let operation: Promise<unknown> | undefined;
  let startupOperation: Promise<BrowserStartupBinding> | undefined;
  let monitor: NodeJS.Timeout | undefined;
  let failedBinding:
    | { processNonce: string; controlGenerationNonce: string; until: number }
    | undefined;

  const signalFor = (signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  const deadlineFor = (startedAt: number): number =>
    startedAt + deps.retry.startupBudgetMs;

  const budgetSignalFor = (
    startedAt: number,
    signal?: AbortSignal,
  ): AbortSignal => {
    const remaining = deadlineFor(startedAt) - deps.now();
    if (remaining <= 0) {
      return AbortSignal.abort(new BrowserReconciliationCoordinatorError());
    }
    return signalFor(
      AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(remaining),
      ]),
    );
  };

  const awaitWithinBudget = async <T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    if (signal.aborted) throw signal.reason;
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      operation.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", aborted);
      });
    });
  };

  const assertRunning = (signal: AbortSignal, deadline: number) => {
    if (stopped || signal.aborted || deps.now() >= deadline) {
      throw new BrowserReconciliationCoordinatorError(
        signal.aborted ? signal.reason : undefined,
      );
    }
  };

  const retry = async <T>(
    startedAt: number,
    signal: AbortSignal,
    operation: (deadline: number) => Promise<T>,
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < deps.retry.maxAttempts; attempt += 1) {
      const deadline = deadlineFor(startedAt);
      assertRunning(signal, deadline);
      if (attempt > 0) {
        const delay = Math.min(
          deps.retry.maxBackoffMs,
          deps.retry.initialBackoffMs * 2 ** (attempt - 1),
          Math.max(0, deadline - deps.now()),
        );
        if (delay <= 0) break;
        await deps.sleep(delay, signal);
        assertRunning(signal, deadline);
      }
      try {
        return await operation(deadline);
      } catch (error) {
        if (
          error instanceof ServiceProcessChangedError ||
          isNonRetryable(error)
        ) {
          throw error;
        }
        lastError = error;
      }
    }
    throw new BrowserReconciliationCoordinatorError(lastError);
  };

  const requireScopedLive = async (
    processNonce: string,
    controlGenerationNonce: string,
    signal: AbortSignal,
    deadline: number,
  ) => {
    const binding = { processNonce, controlGenerationNonce };
    try {
      return await deps.serviceClient.getLive(
        requestContext(signal, deadline, binding),
      );
    } catch (error) {
      if (
        error instanceof BrowserServiceClientError &&
        error.category === "control_generation_mismatch"
      ) {
        const discovery = await deps.serviceClient.discoverLive(
          requestContext(signal, deadline),
        );
        if (discovery.processNonce !== processNonce) {
          throw new ServiceProcessChangedError();
        }
        throw new ServiceControlLostError();
      }
      throw error;
    }
  };

  const activateDatabaseControl = async (
    handoff: BrowserControlGenerationHandoff,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<number> => {
    const connection = deps.pool.connect();
    let client: PoolClient;
    try {
      client = await awaitWithinBudget(connection, signal);
    } catch (error) {
      void connection.then(lateClient => lateClient.release(true));
      throw error;
    }
    const query = async <Row extends Record<string, unknown> = never>(
      text: string,
      values?: unknown[],
    ) => {
      signal.throwIfAborted();
      const remaining = deadlineFor(startedAt) - deps.now();
      if (remaining <= 0) {
        throw new BrowserReconciliationCoordinatorError();
      }
      await client.query(
        `SELECT set_config('statement_timeout', $1, false),
                set_config('lock_timeout', $1, false)`,
        [`${remaining}ms`],
      );
      signal.throwIfAborted();
      return client.query<Row>(text, values);
    };
    let begun = false;
    try {
      await query("BEGIN");
      begun = true;
      await query("SELECT pg_advisory_xact_lock(1179796818, 1112687443)");
      const selected = await query<ControlRow>(
        `SELECT database_control_epoch, api_instance_id, process_nonce,
                control_generation_nonce
           FROM browser_control_generation
          WHERE singleton_id = 1
          FOR UPDATE`,
      );
      const prior = selected.rows[0];
      const same =
        prior?.api_instance_id === handoff.apiInstanceId &&
        prior.process_nonce === handoff.processNonce &&
        prior.control_generation_nonce === handoff.controlGenerationNonce;
      const epoch = same
        ? Number(prior.database_control_epoch)
        : prior
          ? Number(prior.database_control_epoch) + 1
          : 1;
      if (!Number.isSafeInteger(epoch) || epoch <= 0) {
        throw new BrowserReconciliationCoordinatorError();
      }
      const deadline = deadlineFor(startedAt);
      assertRunning(signal, deadline);
      await requireScopedLive(
        handoff.processNonce,
        handoff.controlGenerationNonce,
        signal,
        deadline,
      );
      if (!same) {
        await query(
          `INSERT INTO browser_control_generation (
             singleton_id, database_control_epoch, api_instance_id,
             process_nonce, control_generation_nonce, activated_at
           ) VALUES (1, $1, $2, $3, $4, now())
           ON CONFLICT (singleton_id) DO UPDATE
             SET database_control_epoch = EXCLUDED.database_control_epoch,
                 api_instance_id = EXCLUDED.api_instance_id,
                 process_nonce = EXCLUDED.process_nonce,
                 control_generation_nonce =
                   EXCLUDED.control_generation_nonce,
                 activated_at = now()`,
          [
            epoch,
            handoff.apiInstanceId,
            handoff.processNonce,
            handoff.controlGenerationNonce,
          ],
        );
      }
      await query("COMMIT");
      begun = false;
      await requireScopedLive(
        handoff.processNonce,
        handoff.controlGenerationNonce,
        signal,
        deadline,
      );
      return epoch;
    } catch (error) {
      if (begun) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the activation failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  };

  const acquire = async (
    outerSignal?: AbortSignal,
    budgetStartedAt = deps.now(),
  ): Promise<BrowserControlGenerationHandoff> => {
    const startedAt = budgetStartedAt;
    const signal = budgetSignalFor(startedAt, outerSignal);
    const drain = deps.gate.close("browser_service_handoff");
    await deps.pauseBrowserRetention();
    let tuple: HandoffTuple | undefined;
    const handoff = await retry(startedAt, signal, async deadline => {
      const live = await deps.serviceClient.discoverLive(
        requestContext(signal, deadline),
      );
      if (!tuple || tuple.processNonce !== live.processNonce) {
        tuple = handoffTuples.get(live.processNonce);
        if (!tuple) {
          const request: CreateControlGenerationV1 = {
            version: 1,
            processNonce: live.processNonce,
            apiInstanceId: API_INSTANCE_ID,
            idempotencyKey: createHandoffIdempotencyKey(),
          };
          tuple = {
            processNonce: live.processNonce,
            idempotencyKey: request.idempotencyKey,
            request,
            canonicalRequestBody: canonicalControlBody(request),
          };
          handoffTuples.set(live.processNonce, tuple);
        }
      }
      const generation = await deps.serviceClient.createControlGeneration(
        tuple.request,
        requestContext(signal, deadline),
      );
      if (
        generation.processNonce !== tuple.processNonce ||
        generation.apiInstanceId !== API_INSTANCE_ID
      ) {
        throw new BrowserReconciliationCoordinatorError();
      }
      try {
        await requireScopedLive(
          generation.processNonce,
          generation.controlGenerationNonce,
          signal,
          deadline,
        );
      } catch (error) {
        if (error instanceof ServiceProcessChangedError) {
          handoffTuples.delete(tuple.processNonce);
          tuple = undefined;
          throw new HandoffProcessChangedError();
        }
        throw error;
      }
      return {
        apiInstanceId: API_INSTANCE_ID,
        idempotencyKey: tuple.idempotencyKey,
        processNonce: generation.processNonce,
        controlGenerationNonce: generation.controlGenerationNonce,
        canonicalRequestBody: tuple.canonicalRequestBody,
        deadlineMs: deadlineFor(startedAt),
        drain,
      };
    });
    handoffBudgetStarts.set(handoff, startedAt);
    currentHandoff = handoff;
    return handoff;
  };

  const prepareReconciliationCycle = async (
    handoff: BrowserControlGenerationHandoff,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<FrozenReconciliationCycle> => {
    const existing = frozenCycles.get(handoff.controlGenerationNonce);
    if (
      existing?.processNonce === handoff.processNonce &&
      existing.controlGenerationNonce === handoff.controlGenerationNonce
    ) {
      return existing;
    }
    assertRunning(signal, deadlineFor(startedAt));
    const databaseControlEpoch = await activateDatabaseControl(
      handoff,
      signal,
      startedAt,
    );
    await awaitWithinBudget(handoff.drain.drained, signal);
    assertRunning(signal, deadlineFor(startedAt));
    await awaitWithinBudget(
      deps.gate.withDrainedBrowserStateMutation(handoff.drain, async lease => {
        const deadline = deadlineFor(startedAt);
        assertRunning(signal, deadline);
        if (
          lease.transaction.databaseControlEpoch !== databaseControlEpoch ||
          lease.binding.apiInstanceId !== handoff.apiInstanceId ||
          lease.binding.processNonce !== handoff.processNonce ||
          lease.binding.controlGenerationNonce !==
            handoff.controlGenerationNonce
        ) {
          throw new ServiceControlLostError();
        }
        const transaction = deadlineTransaction(
          lease.transaction,
          signal,
          deadline,
          deps.now,
        );
        await deps.interruptUnfinishedBrowserWork(
          new Date(deps.now()),
          transaction,
        );
        assertRunning(signal, deadlineFor(startedAt));
        await deps.recoverBrowserCleanupIntentsBeforeSnapshot({
          pool: transactionPool(transaction),
          filesystem:
            deps.filesystem ??
            ({
              delete: async () => {
                throw new BrowserReconciliationCoordinatorError();
              },
              deleteWithChecksum: (statePath, checksum) => {
                if (deps.deleteReplayCheckpoint) {
                  return deps.deleteReplayCheckpoint(
                    statePath,
                    checksum,
                    lease,
                  );
                }
                throw new BrowserReconciliationCoordinatorError();
              },
            } satisfies BrowserStateFileDeleter),
          inspectProcessIdentity: deps.inspectProcessIdentity,
          signal,
        });
        assertRunning(signal, deadlineFor(startedAt));
      }),
      signal,
    );
    assertRunning(signal, deadlineFor(startedAt));
    const snapshot = await awaitWithinBudget(
      deps.loadSnapshot(deps.pool, signal),
      signal,
    );
    assertRunning(signal, deadlineFor(startedAt));
    const request = reconciliationRequestV1Schema.parse({
      version: 1,
      processNonce: handoff.processNonce,
      controlGenerationNonce: handoff.controlGenerationNonce,
      snapshotDigest: snapshot.snapshotDigest,
      references: snapshot.references,
    });
    const canonicalRequestBody = JSON.stringify(request);
    const cycle = {
      databaseControlEpoch,
      processNonce: handoff.processNonce,
      controlGenerationNonce: handoff.controlGenerationNonce,
      snapshotDigest: snapshot.snapshotDigest,
      canonicalRequestBody,
    };
    frozenCycles.set(handoff.controlGenerationNonce, cycle);
    return cycle;
  };

  const reconcileGeneration = async (
    handoff: BrowserControlGenerationHandoff,
    outerSignal?: AbortSignal,
  ): Promise<BrowserStartupBinding> => {
    const startedAt = handoffBudgetStarts.get(handoff) ?? deps.now();
    const signal = budgetSignalFor(startedAt, outerSignal);
    const cycle = await prepareReconciliationCycle(handoff, signal, startedAt);
    const serviceBinding = {
      processNonce: cycle.processNonce,
      controlGenerationNonce: cycle.controlGenerationNonce,
    };
    await retry(startedAt, signal, async deadline => {
      const live = await requireScopedLive(
        cycle.processNonce,
        cycle.controlGenerationNonce,
        signal,
        deadline,
      );
      if (live.processNonce !== cycle.processNonce) {
        throw new ServiceProcessChangedError();
      }
      if (live.controlGenerationNonce !== cycle.controlGenerationNonce) {
        throw new ServiceControlLostError();
      }
      const result = await deps.serviceClient.reconcile(
        cycle.canonicalRequestBody,
        requestContext(signal, deadline, serviceBinding),
      );
      if (result.snapshotDigest !== cycle.snapshotDigest || !result.ready) {
        throw new BrowserReconciliationCoordinatorError();
      }
      return result;
    });
    const deadline = deadlineFor(startedAt);
    let ready: Awaited<ReturnType<typeof deps.serviceClient.getReady>>;
    try {
      ready = await deps.serviceClient.getReady(
        requestContext(signal, deadline, serviceBinding),
      );
    } catch (error) {
      if (
        error instanceof BrowserServiceClientError &&
        error.category === "control_generation_mismatch"
      ) {
        await requireScopedLive(
          cycle.processNonce,
          cycle.controlGenerationNonce,
          signal,
          deadline,
        );
      }
      throw error;
    }
    if (
      ready.status !== "ready" ||
      ready.processNonce !== cycle.processNonce ||
      ready.controlGenerationNonce !== cycle.controlGenerationNonce ||
      ready.snapshotDigest !== cycle.snapshotDigest
    ) {
      throw new BrowserReconciliationCoordinatorError();
    }
    if (stopped) throw new BrowserReconciliationCoordinatorError();
    const binding = {
      apiInstanceId: handoff.apiInstanceId,
      databaseControlEpoch: cycle.databaseControlEpoch,
      processNonce: cycle.processNonce,
      controlGenerationNonce: cycle.controlGenerationNonce,
      snapshotDigest: cycle.snapshotDigest,
    };
    deps.gate.open(handoff.drain, binding);
    await deps.startBrowserRetention();
    currentBinding = binding;
    authorityBinding = binding;
    failedBinding = undefined;
    handoffTuples.delete(cycle.processNonce);
    frozenCycles.delete(cycle.controlGenerationNonce);
    return binding;
  };

  const initialize = async (
    handoff: BrowserControlGenerationHandoff,
    signal?: AbortSignal,
  ): Promise<BrowserStartupBinding> => {
    let next = handoff;
    for (;;) {
      try {
        return await reconcileGeneration(next, signal);
      } catch (error) {
        if (!(error instanceof ServiceProcessChangedError)) throw error;
        frozenCycles.delete(next.controlGenerationNonce);
        handoffTuples.delete(next.processNonce);
        next = await acquire(
          signal,
          handoffBudgetStarts.get(next) ?? deps.now(),
        );
      }
    }
  };

  const permanentlyLoseControl = async (): Promise<void> => {
    deps.gate.close("browser_control_lost");
    await deps.pauseBrowserRetention();
    currentBinding = undefined;
    authorityBinding = undefined;
    stopped = true;
    controller.abort(new BrowserReconciliationCoordinatorError());
    if (monitor) {
      clearInterval(monitor);
      monitor = undefined;
    }
  };

  const check = (explicit: boolean, signal?: AbortSignal): Promise<void> => {
    if (operation) return operation.then(() => undefined);
    operation = (async () => {
      const active = currentBinding ?? authorityBinding;
      if (!active || stopped) return;
      const effectiveSignal = signalFor(signal);
      if (currentBinding) {
        try {
          const ready = await deps.serviceClient.getReady(
            requestContext(
              effectiveSignal,
              deps.now() + deps.retry.startupBudgetMs,
              active,
            ),
          );
          if (
            ready.status === "ready" &&
            ready.processNonce === active.processNonce &&
            ready.controlGenerationNonce === active.controlGenerationNonce &&
            ready.snapshotDigest === active.snapshotDigest
          ) {
            return;
          }
          if (
            ready.processNonce === active.processNonce &&
            ready.controlGenerationNonce !== active.controlGenerationNonce
          ) {
            await permanentlyLoseControl();
            throw new BrowserReconciliationCoordinatorError();
          }
        } catch (error) {
          if (error instanceof BrowserReconciliationCoordinatorError) {
            throw error;
          }
          if (
            error instanceof BrowserServiceClientError &&
            error.category === "control_generation_mismatch"
          ) {
            let sameProcess = false;
            try {
              const discovery = await deps.serviceClient.discoverLive(
                requestContext(
                  effectiveSignal,
                  deps.now() + deps.retry.startupBudgetMs,
                ),
              );
              sameProcess = discovery.processNonce === active.processNonce;
            } catch {
              // Treat failed discovery as an unavailable runtime below.
            }
            if (sameProcess) {
              await permanentlyLoseControl();
              throw new BrowserReconciliationCoordinatorError(error);
            }
          }
        }
        deps.gate.close("browser_service_restart");
        await deps.pauseBrowserRetention();
        currentBinding = undefined;
      }
      const prior = currentHandoff;
      if (
        !explicit &&
        failedBinding &&
        prior &&
        failedBinding.processNonce === prior.processNonce &&
        failedBinding.controlGenerationNonce === prior.controlGenerationNonce &&
        deps.now() < failedBinding.until
      ) {
        try {
          const live = await deps.serviceClient.discoverLive(
            requestContext(
              effectiveSignal,
              deps.now() + deps.retry.startupBudgetMs,
            ),
          );
          if (live.processNonce === failedBinding.processNonce) return;
          failedBinding = undefined;
        } catch {
          return;
        }
      }
      try {
        const handoff = await acquire(effectiveSignal);
        await initialize(handoff, effectiveSignal);
      } catch (error) {
        if (error instanceof ServiceControlLostError) {
          await permanentlyLoseControl();
          throw new BrowserReconciliationCoordinatorError(error);
        }
        const failed = currentHandoff;
        if (failed) {
          failedBinding = {
            processNonce: failed.processNonce,
            controlGenerationNonce: failed.controlGenerationNonce,
            until: deps.now() + deps.retry.retryCooldownMs,
          };
        }
        throw error;
      }
    })().finally(() => {
      operation = undefined;
    });
    return operation.then(() => undefined);
  };

  const scheduleMonitor = () => {
    if (monitor || stopped) return;
    monitor = setInterval(() => {
      void check(false).catch(() => {
        deps.logger.error("Browser reconciliation monitor failed", {
          category: "browser_state_unavailable",
        });
      });
    }, deps.retry.monitorIntervalMs);
    monitor.unref();
  };

  const coordinator: BrowserReconciliationCoordinator = {
    acquireControlGeneration(signal) {
      return acquire(signal).catch(error => {
        throw error instanceof BrowserReconciliationCoordinatorError
          ? error
          : new BrowserReconciliationCoordinatorError(error);
      });
    },

    initializeAfterMigrations(handoff, signal) {
      const initializing = (async () => {
        try {
          const binding = await initialize(handoff, signal);
          scheduleMonitor();
          return binding;
        } catch (error) {
          await deps.pauseBrowserRetention();
          throw error instanceof BrowserReconciliationCoordinatorError
            ? error
            : new BrowserReconciliationCoordinatorError(error);
        }
      })();
      startupOperation = initializing;
      return initializing.finally(() => {
        if (startupOperation === initializing) startupOperation = undefined;
      });
    },

    checkNow(signal) {
      return check(true, signal);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      controller.abort(new BrowserReconciliationCoordinatorError());
      if (monitor) {
        clearInterval(monitor);
        monitor = undefined;
      }
      const shutdownDrain = deps.gate.close("shutdown");
      await deps.pauseBrowserRetention();
      try {
        await Promise.all([operation, startupOperation]);
      } catch {
        // The aborted operation has already left the gate closed.
      }
      await shutdownDrain.drained;
      currentBinding = undefined;
      authorityBinding = undefined;
    },
  };

  return coordinator;
}
