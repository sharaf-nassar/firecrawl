import { Buffer } from "node:buffer";

import type { Pool, PoolClient } from "pg";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** @public */
export class BrowserStartupGateError extends Error {
  constructor(
    public readonly category:
      | "browser_state_unavailable"
      | "control_generation_mismatch",
  ) {
    super(
      category === "control_generation_mismatch"
        ? "Browser control generation is stale"
        : "Browser state is unavailable",
    );
    this.name = "BrowserStartupGateError";
  }
}

/** @public */
export type BrowserStartupBinding = {
  apiInstanceId: string;
  databaseControlEpoch: number;
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
};

/** @public */
export type BrowserMutationDrain = {
  epoch: number;
  drained: Promise<void>;
};

/** @public */
export type BrowserControlFenceTransaction = Pick<PoolClient, "query"> & {
  readonly databaseControlEpoch: number;
  /**
   * Settles only when PostgreSQL's transaction outcome is safe to act on.
   * A rejected COMMIT is ambiguous because the response can be lost after
   * PostgreSQL made the commit durable.
   */
  readonly commitOutcome?: Promise<BrowserMutationCommitOutcome>;
};

/** @public */
export type BrowserMutationCommitOutcome =
  | "committed"
  | "rolled_back"
  | "unknown";

/** @public */
export type BrowserMutationTransactionOptions = {
  /**
   * Bounds only the COMMIT acknowledgement wait. Values above the gate's
   * safety ceiling are capped.
   */
  readonly commitTimeoutMs?: number;
  /** Aborts only the COMMIT acknowledgement wait after COMMIT is sent. */
  readonly signal?: AbortSignal;
};

/** @public */
export type BrowserStateMutationLease = {
  readonly epoch: number;
  readonly scope: "filesystem_and_database";
  readonly binding: BrowserStartupBinding;
  readonly transaction: BrowserControlFenceTransaction;
};

/** @public */
export type BrowserStartupGate = {
  assertOpen(): BrowserStartupBinding;
  close(reason: string): BrowserMutationDrain;
  open(drain: BrowserMutationDrain, binding: BrowserStartupBinding): void;
  waitUntilOpen(signal: AbortSignal): Promise<BrowserStartupBinding>;
  withBrowserStateMutationLease<T>(
    scope: "filesystem_and_database",
    operation: (lease: BrowserStateMutationLease) => Promise<T>,
    options?: BrowserMutationTransactionOptions,
  ): Promise<T>;
  withDrainedBrowserStateMutation<T>(
    drain: BrowserMutationDrain,
    operation: (lease: BrowserStateMutationLease) => Promise<T>,
    options?: BrowserMutationTransactionOptions,
  ): Promise<T>;
};

type FenceRow = {
  database_control_epoch: string | number;
  api_instance_id: string;
  process_nonce: string;
  control_generation_nonce: string;
};

type DrainRecord = {
  token: BrowserMutationDrain;
  resolve: () => void;
  settled: boolean;
  recoveryClaimed: boolean;
};

const MAX_COMMIT_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;

function unavailable(): BrowserStartupGateError {
  return new BrowserStartupGateError("browser_state_unavailable");
}

function mismatch(): BrowserStartupGateError {
  return new BrowserStartupGateError("control_generation_mismatch");
}

function assertBinding(binding: BrowserStartupBinding): void {
  const canonicalToken = (value: string) =>
    TOKEN.test(value) &&
    Buffer.from(value, "base64url").length === 32 &&
    Buffer.from(value, "base64url").toString("base64url") === value;
  if (
    !UUID.test(binding.apiInstanceId) ||
    !Number.isSafeInteger(binding.databaseControlEpoch) ||
    binding.databaseControlEpoch <= 0 ||
    !canonicalToken(binding.processNonce) ||
    !canonicalToken(binding.controlGenerationNonce) ||
    !SHA256.test(binding.snapshotDigest)
  ) {
    throw unavailable();
  }
}

function bindingFromRow(row: FenceRow): BrowserStartupBinding {
  const databaseControlEpoch = Number(row.database_control_epoch);
  const binding = {
    apiInstanceId: row.api_instance_id,
    databaseControlEpoch,
    processNonce: row.process_nonce,
    controlGenerationNonce: row.control_generation_nonce,
    snapshotDigest: "0".repeat(64),
  };
  assertBinding(binding);
  return binding;
}

function sameFence(
  expected: BrowserStartupBinding,
  actual: BrowserStartupBinding,
): boolean {
  return (
    expected.apiInstanceId === actual.apiInstanceId &&
    expected.databaseControlEpoch === actual.databaseControlEpoch &&
    expected.processNonce === actual.processNonce &&
    expected.controlGenerationNonce === actual.controlGenerationNonce
  );
}

/** @public */
export function createBrowserStartupGate(deps: {
  pool: Pick<Pool, "connect">;
}): BrowserStartupGate {
  let epoch = 0;
  let binding: BrowserStartupBinding | undefined;
  let currentDrain: DrainRecord | undefined;
  let activeMutations = 0;
  const drains = new Set<DrainRecord>();
  const openWaiters = new Set<{
    resolve: (value: BrowserStartupBinding) => void;
    reject: (reason: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }>();

  const settleDrains = () => {
    if (activeMutations !== 0) return;
    for (const drain of drains) {
      if (!drain.settled) {
        drain.settled = true;
        drain.resolve();
      }
    }
  };

  const transact = async <T>(
    leaseEpoch: number,
    expected: BrowserStartupBinding | undefined,
    operation: (lease: BrowserStateMutationLease) => Promise<T>,
    options?: BrowserMutationTransactionOptions,
  ): Promise<T> => {
    const requestedCommitTimeoutMs =
      options?.commitTimeoutMs ?? MAX_COMMIT_ACKNOWLEDGEMENT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestedCommitTimeoutMs) ||
      requestedCommitTimeoutMs <= 0
    ) {
      throw unavailable();
    }
    const commitTimeoutMs = Math.min(
      requestedCommitTimeoutMs,
      MAX_COMMIT_ACKNOWLEDGEMENT_TIMEOUT_MS,
    );
    const client = await deps.pool.connect();
    let begun = false;
    let commitStarted = false;
    let destroyClient = false;
    let outcomeSettled = false;
    let settleOutcome!: (outcome: BrowserMutationCommitOutcome) => void;
    const commitOutcome = new Promise<BrowserMutationCommitOutcome>(resolve => {
      settleOutcome = resolve;
    });
    const settleCommitOutcome = (outcome: BrowserMutationCommitOutcome) => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      settleOutcome(outcome);
    };
    try {
      await client.query("BEGIN");
      begun = true;
      const result = await client.query<FenceRow>(
        `SELECT database_control_epoch, api_instance_id, process_nonce,
                control_generation_nonce
           FROM browser_control_generation
          WHERE singleton_id = 1
          FOR UPDATE`,
      );
      if (result.rows.length !== 1) throw mismatch();
      const durable = bindingFromRow(result.rows[0]!);
      if (expected !== undefined && !sameFence(expected, durable)) {
        throw mismatch();
      }
      const transaction: BrowserControlFenceTransaction = {
        query: client.query.bind(client),
        databaseControlEpoch: durable.databaseControlEpoch,
        commitOutcome,
      };
      const value = await operation({
        epoch: leaseEpoch,
        scope: "filesystem_and_database",
        binding: expected ?? durable,
        transaction,
      });
      commitStarted = true;
      let committed;
      try {
        const commit = client.query("COMMIT");
        committed = await new Promise<Awaited<typeof commit>>(
          (resolve, reject) => {
            let settled = false;
            const finish = (
              callback: (value: Awaited<typeof commit>) => void,
              value: Awaited<typeof commit>,
            ) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              options?.signal?.removeEventListener("abort", abort);
              callback(value);
            };
            const fail = (error: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              options?.signal?.removeEventListener("abort", abort);
              reject(error);
            };
            const abort = () => fail(options?.signal?.reason ?? unavailable());
            const timer = setTimeout(
              () => fail(unavailable()),
              commitTimeoutMs,
            );
            timer.unref?.();
            options?.signal?.addEventListener("abort", abort, { once: true });
            if (options?.signal?.aborted) {
              abort();
            }
            commit.then(
              result => finish(resolve, result),
              error => fail(error),
            );
          },
        );
      } catch (error) {
        // A transport failure can arrive after PostgreSQL durably committed.
        // Do not issue ROLLBACK or reuse this connection as either action would
        // incorrectly turn an ambiguous outcome into an asserted rollback.
        begun = false;
        destroyClient = true;
        settleCommitOutcome("unknown");
        throw error;
      }
      begun = false;
      if (committed.command === "ROLLBACK") {
        settleCommitOutcome("rolled_back");
        throw unavailable();
      }
      settleCommitOutcome("committed");
      return value;
    } catch (error) {
      if (begun && !commitStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyClient = true;
          // COMMIT was never sent, so disconnecting still guarantees rollback.
        }
        begun = false;
        settleCommitOutcome("rolled_back");
      } else if (!outcomeSettled) {
        settleCommitOutcome("unknown");
      }
      throw error;
    } finally {
      if (destroyClient) {
        client.release(true);
      } else {
        client.release();
      }
    }
  };

  const gate: BrowserStartupGate = {
    assertOpen() {
      if (binding === undefined) throw unavailable();
      return { ...binding };
    },

    close(_reason) {
      binding = undefined;
      epoch += 1;
      let resolve!: () => void;
      const drained = new Promise<void>(settle => {
        resolve = settle;
      });
      const token = { epoch, drained };
      const record = {
        token,
        resolve,
        settled: false,
        recoveryClaimed: false,
      };
      currentDrain = record;
      drains.add(record);
      settleDrains();
      return token;
    },

    open(drain, nextBinding) {
      if (
        currentDrain?.token !== drain ||
        drain.epoch !== epoch ||
        !currentDrain.settled ||
        binding !== undefined
      ) {
        throw unavailable();
      }
      assertBinding(nextBinding);
      binding = { ...nextBinding };
      drains.delete(currentDrain);
      currentDrain = undefined;
      for (const waiter of openWaiters) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.resolve({ ...nextBinding });
        openWaiters.delete(waiter);
      }
    },

    waitUntilOpen(signal) {
      if (binding !== undefined) return Promise.resolve({ ...binding });
      if (signal.aborted) return Promise.reject(signal.reason ?? unavailable());
      return new Promise<BrowserStartupBinding>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal,
          abort: () => {
            openWaiters.delete(waiter);
            reject(signal.reason ?? unavailable());
          },
        };
        openWaiters.add(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
      });
    },

    async withBrowserStateMutationLease(scope, operation, options) {
      if (scope !== "filesystem_and_database" || binding === undefined) {
        throw unavailable();
      }
      const admittedBinding = { ...binding };
      const admittedEpoch = epoch;
      activeMutations += 1;
      try {
        return await transact(
          admittedEpoch,
          admittedBinding,
          operation,
          options,
        );
      } finally {
        activeMutations -= 1;
        settleDrains();
      }
    },

    async withDrainedBrowserStateMutation(drain, operation, options) {
      if (
        currentDrain?.token !== drain ||
        drain.epoch !== epoch ||
        !currentDrain.settled ||
        currentDrain.recoveryClaimed ||
        binding !== undefined ||
        activeMutations !== 0
      ) {
        throw unavailable();
      }
      currentDrain.recoveryClaimed = true;
      activeMutations += 1;
      try {
        return await transact(epoch, undefined, operation, options);
      } finally {
        activeMutations -= 1;
        settleDrains();
      }
    },
  };

  return gate;
}
