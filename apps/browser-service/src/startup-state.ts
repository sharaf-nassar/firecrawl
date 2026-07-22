import { randomBytes as systemRandomBytes } from "node:crypto";

import {
  MAX_RECONCILIATION_REFERENCES,
  MAX_REPLAY_REQUEST_BYTES,
  controlGenerationV1Schema,
  createControlGenerationV1Schema,
  reconciliationRequestV1Schema,
  reconciliationResultV1Schema,
  type ControlGenerationV1,
  type CreateControlGenerationV1,
  type LiveDiscoveryV1,
  type ReadyHealthV1,
  type ReconciliationRequestV1,
  type ReconciliationResultV1,
  type ScopedLiveHealthV1,
  type UnreadyHealthV1,
} from "./contracts.js";
import {
  BrowserServiceError,
  type BrowserServiceInternalDetail,
} from "./errors.js";

const CONTROL_GENERATION_HISTORY_LIMIT = 1_024;

export type ControlGenerationBinding = {
  processNonce: string;
  controlGenerationNonce: string;
};

export type ReconciliationExecutionAdmission = {
  readonly signal: AbortSignal;
  assertAdmitted(): void;
};

export type ControlGenerationDrainAdmission = {
  readonly signal: AbortSignal;
  assertWaveActive(): void;
};

export type ControlGenerationRequestContext = {
  readonly transportSignal: AbortSignal;
  readonly deadlineAtMs: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

type PendingHistory = {
  state: "pending";
  request: CreateControlGenerationV1;
  outcome: Deferred<ControlGenerationV1>;
};

type CompletedHistory = {
  state: "completed";
  request: CreateControlGenerationV1;
  result: ControlGenerationV1;
};

type FailedHistory = {
  state: "failed";
  request: CreateControlGenerationV1;
  error: BrowserServiceError;
};

type SupersededHistory = {
  state: "superseded";
  request: CreateControlGenerationV1;
  error: BrowserServiceError;
};

type HandoffHistory =
  | PendingHistory
  | CompletedHistory
  | FailedHistory
  | SupersededHistory;

type HandoffWave = {
  ownerKey: string;
  ownerContext: ControlGenerationRequestContext;
  drainController: AbortController;
  drainPromise: Promise<void>;
  phase: "pre_mint" | "minted" | "failed";
};

type ReconciliationCache = {
  generationNonce: string;
  digest: string;
  result: ReconciliationResultV1;
};

type ReconciliationFlight = {
  generationNonce: string;
  digest: string;
  controller: AbortController;
  promise: Promise<ReconciliationResultV1>;
};

export type StartupAdmission = {
  readonly processNonce: string;
  createControlGeneration(
    request: CreateControlGenerationV1,
    context: ControlGenerationRequestContext,
    drainRuntime: (admission: ControlGenerationDrainAdmission) => Promise<void>,
  ): Promise<ControlGenerationV1>;
  requireReady(binding: ControlGenerationBinding): {
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: string;
  };
  liveHealth(): LiveDiscoveryV1;
  scopedLiveHealth(binding: ControlGenerationBinding): ScopedLiveHealthV1;
  readyHealth(): ReadyHealthV1 | UnreadyHealthV1;
  reconcile(
    request: ReconciliationRequestV1,
    execute: (
      request: ReconciliationRequestV1,
      admission: ReconciliationExecutionAdmission,
    ) => Promise<ReconciliationResultV1>,
  ): Promise<ReconciliationResultV1>;
  beginDraining(): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((accept, decline) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      accept(value);
    };
    reject = (reason) => {
      if (settled) return;
      settled = true;
      decline(reason);
    };
  });
  return { promise, resolve, reject };
}

function error(
  category: ConstructorParameters<typeof BrowserServiceError>[0],
  message: string,
  detail?: BrowserServiceInternalDetail,
): BrowserServiceError {
  return new BrowserServiceError(
    category,
    message,
    detail === undefined ? {} : { detail },
  );
}

function tupleKey(request: CreateControlGenerationV1): string {
  return `${request.processNonce}\u0000${request.apiInstanceId}\u0000${request.idempotencyKey}`;
}

function ownerIsLive(context: ControlGenerationRequestContext): boolean {
  return !context.transportSignal.aborted && Date.now() < context.deadlineAtMs;
}

function reconciliationRequestPrecheck(
  input: unknown,
): "invalid" | "too_large" | null {
  try {
    if (input !== null && typeof input === "object") {
      const references = (input as { references?: unknown }).references;
      if (
        Array.isArray(references) &&
        references.length > MAX_RECONCILIATION_REFERENCES
      ) {
        return "too_large";
      }
    }
    const encoded = JSON.stringify(input);
    if (encoded === undefined) return "invalid";
    if (Buffer.byteLength(encoded, "utf8") > MAX_REPLAY_REQUEST_BYTES) {
      return "too_large";
    }
    return null;
  } catch {
    return "invalid";
  }
}

function frozenError(
  category: "control_generation_superseded" | "control_generation_drain_failed",
  detail?: BrowserServiceInternalDetail,
): BrowserServiceError {
  const value = error(
    category,
    category === "control_generation_superseded"
      ? "control generation was superseded"
      : "runtime drain failed",
    detail,
  );
  Object.freeze(value);
  return value;
}

export function createStartupState(
  deps: {
    randomBytes?: (size: number) => Buffer;
  } = {},
): StartupAdmission {
  const randomBytes = deps.randomBytes ?? systemRandomBytes;

  function mintToken(): string {
    const bytes = randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 32) {
      throw new TypeError("randomBytes must return exactly 32 bytes");
    }
    return bytes.toString("base64url");
  }

  const processNonce = mintToken();
  const history = new Map<string, HandoffHistory>();
  const apiIdentities = new Map<string, string>();
  const idempotencyKeys = new Map<string, string>();
  let reservedHistorySlots = 0;
  let activeWave: HandoffWave | null = null;
  let currentGeneration: ControlGenerationV1 | null = null;
  let reconciliationCache: ReconciliationCache | null = null;
  let reconciliationFlight: ReconciliationFlight | null = null;
  let draining = false;
  let status: "live_unreconciled" | "reconciling" | "ready" =
    "live_unreconciled";

  function abortReconciliation(): void {
    reconciliationFlight?.controller.abort();
    reconciliationFlight = null;
    reconciliationCache = null;
    status = "live_unreconciled";
  }

  function validateBinding(binding: ControlGenerationBinding): void {
    if (binding.processNonce !== processNonce) {
      throw error(
        "reconciliation_nonce_mismatch",
        "browser service process does not match",
      );
    }
    if (currentGeneration === null) {
      throw error(
        "control_generation_required",
        "control generation is required",
      );
    }
    if (
      binding.controlGenerationNonce !==
      currentGeneration.controlGenerationNonce
    ) {
      throw error(
        "control_generation_mismatch",
        "control generation does not match",
      );
    }
  }

  function replayHistory(entry: HandoffHistory): Promise<ControlGenerationV1> {
    if (entry.state === "completed") return Promise.resolve(entry.result);
    if (entry.state === "failed" || entry.state === "superseded") {
      return Promise.reject(entry.error);
    }
    if (
      activeWave?.ownerKey === tupleKey(entry.request) &&
      !ownerIsLive(activeWave.ownerContext)
    ) {
      return Promise.reject(
        error(
          "control_generation_in_progress",
          "orphaned control generation awaits replacement",
        ),
      );
    }
    return entry.outcome.promise;
  }

  function reserve(request: CreateControlGenerationV1): {
    commit(): PendingHistory;
    release(): void;
  } {
    if (
      history.size + reservedHistorySlots >=
      CONTROL_GENERATION_HISTORY_LIMIT
    ) {
      throw error(
        "control_generation_history_exhausted",
        "control generation history is exhausted",
      );
    }
    reservedHistorySlots += 1;
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      reservedHistorySlots -= 1;
    };
    const priorKey = apiIdentities.get(request.apiInstanceId);
    const priorApi = idempotencyKeys.get(request.idempotencyKey);
    if (
      (priorKey !== undefined && priorKey !== request.idempotencyKey) ||
      (priorApi !== undefined && priorApi !== request.apiInstanceId)
    ) {
      release();
      throw error(
        "control_generation_conflict",
        "control generation tuple conflicts with history",
      );
    }
    return {
      commit(): PendingHistory {
        if (!active) {
          throw new TypeError("control generation reservation is inactive");
        }
        const entry: PendingHistory = {
          state: "pending",
          request: Object.freeze({ ...request }),
          outcome: deferred<ControlGenerationV1>(),
        };
        history.set(tupleKey(request), entry);
        apiIdentities.set(request.apiInstanceId, request.idempotencyKey);
        idempotencyKeys.set(request.idempotencyKey, request.apiInstanceId);
        release();
        return entry;
      },
      release,
    };
  }

  function failWave(
    wave: HandoffWave,
    detail: BrowserServiceInternalDetail,
  ): void {
    if (wave.phase !== "pre_mint") return;
    wave.phase = "failed";
    wave.drainController.abort();
    const entry = history.get(wave.ownerKey);
    if (entry?.state === "pending") {
      const failure = frozenError("control_generation_drain_failed", detail);
      history.set(wave.ownerKey, {
        state: "failed",
        request: entry.request,
        error: failure,
      });
      entry.outcome.reject(failure);
    }
    if (activeWave === wave) activeWave = null;
    currentGeneration = null;
    abortReconciliation();
  }

  async function finishWave(wave: HandoffWave): Promise<void> {
    try {
      await wave.drainPromise;
    } catch (caught) {
      failWave(
        wave,
        caught instanceof BrowserServiceError && caught.detail !== undefined
          ? caught.detail
          : "close_failed",
      );
      return;
    }
    if (
      draining ||
      activeWave !== wave ||
      wave.phase !== "pre_mint" ||
      !ownerIsLive(wave.ownerContext)
    ) {
      return;
    }
    const entry = history.get(wave.ownerKey);
    if (entry?.state !== "pending") return;
    let generation: ControlGenerationV1;
    try {
      generation = controlGenerationV1Schema.parse({
        version: 1,
        processNonce,
        controlGenerationNonce: mintToken(),
        apiInstanceId: entry.request.apiInstanceId,
      });
    } catch {
      failWave(wave, "drain_invariant_failed");
      return;
    }
    wave.phase = "minted";
    currentGeneration = Object.freeze(generation);
    reconciliationCache = null;
    status = "live_unreconciled";
    history.set(wave.ownerKey, {
      state: "completed",
      request: entry.request,
      result: currentGeneration,
    });
    activeWave = null;
    entry.outcome.resolve(currentGeneration);
  }

  function createControlGeneration(
    input: CreateControlGenerationV1,
    context: ControlGenerationRequestContext,
    drainRuntime: (admission: ControlGenerationDrainAdmission) => Promise<void>,
  ): Promise<ControlGenerationV1> {
    let request: CreateControlGenerationV1;
    try {
      request = createControlGenerationV1Schema.parse(input);
    } catch {
      return Promise.reject(
        error("invalid_request", "invalid handoff request"),
      );
    }
    if (request.processNonce !== processNonce) {
      return Promise.reject(
        error(
          "reconciliation_nonce_mismatch",
          "browser service process does not match",
        ),
      );
    }
    if (
      draining ||
      context.transportSignal.aborted ||
      Date.now() >= context.deadlineAtMs
    ) {
      return Promise.reject(
        error(
          "control_generation_in_progress",
          "control generation request is not live",
        ),
      );
    }

    const key = tupleKey(request);
    const known = history.get(key);
    if (known !== undefined) return replayHistory(known);

    let reservation: ReturnType<typeof reserve>;
    try {
      reservation = reserve(request);
    } catch (caught) {
      return Promise.reject(caught);
    }

    if (activeWave !== null) {
      if (ownerIsLive(activeWave.ownerContext)) {
        reservation.release();
        return Promise.reject(
          error(
            "control_generation_in_progress",
            "another control generation is in progress",
          ),
        );
      }
      const replacement = reservation.commit();
      const oldKey = activeWave.ownerKey;
      const old = history.get(oldKey);
      if (old?.state === "pending") {
        const superseded = frozenError("control_generation_superseded");
        history.set(oldKey, {
          state: "superseded",
          request: old.request,
          error: superseded,
        });
        old.outcome.reject(superseded);
      }
      activeWave.ownerKey = key;
      activeWave.ownerContext = context;
      void finishWave(activeWave);
      return replacement.outcome.promise;
    }

    const entry = reservation.commit();
    currentGeneration = null;
    abortReconciliation();
    const drainController = new AbortController();
    const drainOutcome = deferred<void>();
    const wave: HandoffWave = {
      ownerKey: key,
      ownerContext: context,
      drainController,
      drainPromise: drainOutcome.promise,
      phase: "pre_mint",
    };
    const admission: ControlGenerationDrainAdmission = {
      signal: drainController.signal,
      assertWaveActive(): void {
        if (
          drainController.signal.aborted ||
          draining ||
          wave.phase !== "pre_mint"
        ) {
          throw error(
            "control_generation_drain_failed",
            "control generation drain is no longer active",
          );
        }
      },
    };
    activeWave = wave;
    void finishWave(wave);
    try {
      Promise.resolve(drainRuntime(admission)).then(
        () => drainOutcome.resolve(),
        (caught: unknown) => drainOutcome.reject(caught),
      );
    } catch (caught) {
      drainOutcome.reject(caught);
    }
    return entry.outcome.promise;
  }

  async function reconcile(
    input: ReconciliationRequestV1,
    execute: (
      request: ReconciliationRequestV1,
      admission: ReconciliationExecutionAdmission,
    ) => Promise<ReconciliationResultV1>,
  ): Promise<ReconciliationResultV1> {
    const precheck = reconciliationRequestPrecheck(input);
    if (precheck === "too_large") {
      throw error(
        "reconciliation_snapshot_too_large",
        "reconciliation snapshot exceeds its limit",
      );
    }
    if (precheck === "invalid") {
      throw error(
        "reconciliation_snapshot_invalid",
        "invalid reconciliation snapshot",
      );
    }
    let request: ReconciliationRequestV1;
    try {
      request = reconciliationRequestV1Schema.parse(input);
    } catch {
      throw error(
        "reconciliation_snapshot_invalid",
        "invalid reconciliation snapshot",
      );
    }
    validateBinding(request);
    if (draining) {
      throw error("reconciliation_required", "reconciliation is not admitted");
    }
    const generation = currentGeneration;
    if (generation === null) {
      throw error(
        "control_generation_required",
        "control generation is required",
      );
    }
    if (reconciliationCache !== null) {
      if (reconciliationCache.digest !== request.snapshotDigest) {
        throw error(
          "reconciliation_conflicting_replay",
          "generation already reconciled with another snapshot",
        );
      }
      await Promise.resolve();
      validateBinding(request);
      if (draining || status !== "ready") {
        throw error(
          "reconciliation_required",
          "reconciliation is not admitted",
        );
      }
      return reconciliationCache.result;
    }
    if (reconciliationFlight !== null) {
      if (
        reconciliationFlight.generationNonce !==
          generation.controlGenerationNonce ||
        reconciliationFlight.digest !== request.snapshotDigest
      ) {
        throw error(
          "reconciliation_in_progress",
          "another reconciliation is in progress",
        );
      }
      const result = await reconciliationFlight.promise;
      validateBinding(request);
      if (draining || status !== "ready") {
        throw error(
          "reconciliation_required",
          "reconciliation is not admitted",
        );
      }
      return result;
    }

    const controller = new AbortController();
    const admission: ReconciliationExecutionAdmission = {
      signal: controller.signal,
      assertAdmitted(): void {
        if (
          controller.signal.aborted ||
          draining ||
          currentGeneration?.controlGenerationNonce !==
            generation.controlGenerationNonce
        ) {
          throw error(
            "reconciliation_required",
            "reconciliation is not admitted",
          );
        }
      },
    };
    status = "reconciling";
    const outcome = deferred<ReconciliationResultV1>();
    const flight: ReconciliationFlight = {
      generationNonce: generation.controlGenerationNonce,
      digest: request.snapshotDigest,
      controller,
      promise: outcome.promise,
    };
    reconciliationFlight = flight;

    const run = async (): Promise<void> => {
      try {
        admission.assertAdmitted();
        const rawResult = await execute(request, admission);
        admission.assertAdmitted();
        let result: ReconciliationResultV1;
        try {
          result = reconciliationResultV1Schema.parse(rawResult);
        } catch {
          throw error(
            "reconciliation_execution_failed",
            "reconciliation returned an invalid result",
          );
        }
        if (
          result.processNonce !== processNonce ||
          result.controlGenerationNonce !== generation.controlGenerationNonce ||
          result.snapshotDigest !== request.snapshotDigest
        ) {
          throw error(
            "reconciliation_execution_failed",
            "reconciliation result identity does not match",
          );
        }
        admission.assertAdmitted();
        const immutable = Object.freeze({ ...result });
        reconciliationCache = {
          generationNonce: generation.controlGenerationNonce,
          digest: request.snapshotDigest,
          result: immutable,
        };
        status = "ready";
        if (reconciliationFlight === flight) reconciliationFlight = null;
        outcome.resolve(immutable);
      } catch (caught) {
        if (reconciliationFlight === flight) {
          reconciliationFlight = null;
          if (reconciliationCache === null) status = "live_unreconciled";
        }
        outcome.reject(
          controller.signal.aborted
            ? error("reconciliation_required", "reconciliation is not admitted")
            : caught,
        );
      }
    };
    void run();
    const result = await flight.promise;
    validateBinding(request);
    if (draining || reconciliationCache === null) {
      throw error("reconciliation_required", "reconciliation is not admitted");
    }
    return result;
  }

  function liveHealth(): LiveDiscoveryV1 {
    return { version: 1, status, processNonce };
  }

  function scopedLiveHealth(
    binding: ControlGenerationBinding,
  ): ScopedLiveHealthV1 {
    validateBinding(binding);
    return {
      version: 1,
      status,
      processNonce,
      controlGenerationNonce: binding.controlGenerationNonce,
    };
  }

  function readyHealth(): ReadyHealthV1 | UnreadyHealthV1 {
    if (currentGeneration === null) {
      throw error(
        "control_generation_required",
        "control generation is required",
      );
    }
    if (status === "ready" && reconciliationCache !== null && !draining) {
      return {
        version: 1,
        status: "ready",
        processNonce,
        controlGenerationNonce: currentGeneration.controlGenerationNonce,
        snapshotDigest: reconciliationCache.digest,
      };
    }
    return {
      version: 1,
      status: "unready",
      processNonce,
      controlGenerationNonce: currentGeneration.controlGenerationNonce,
      category:
        status === "reconciling"
          ? "reconciliation_in_progress"
          : "reconciliation_required",
    };
  }

  function requireReady(binding: ControlGenerationBinding) {
    validateBinding(binding);
    if (draining || status !== "ready" || reconciliationCache === null) {
      throw error("reconciliation_required", "reconciliation is required");
    }
    return {
      processNonce,
      controlGenerationNonce: binding.controlGenerationNonce,
      snapshotDigest: reconciliationCache.digest,
    };
  }

  function beginDraining(): void {
    if (draining) return;
    draining = true;
    abortReconciliation();
    if (activeWave !== null) {
      failWave(activeWave, "drain_invariant_failed");
    }
  }

  return Object.freeze({
    processNonce,
    createControlGeneration,
    requireReady,
    liveHealth,
    scopedLiveHealth,
    readyHealth,
    reconcile,
    beginDraining,
  });
}
