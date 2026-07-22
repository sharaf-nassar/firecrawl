import { Buffer } from "node:buffer";

import { describe, expect, test, vi } from "vitest";

import type {
  CreateControlGenerationV1,
  ReconciliationRequestV1,
  ReconciliationResultV1,
} from "./contracts.js";
import {
  MAX_RECONCILIATION_REFERENCES,
  MAX_REPLAY_REQUEST_BYTES,
} from "./contracts.js";
import {
  createStartupState,
  type ControlGenerationRequestContext,
} from "./startup-state.js";
import { BrowserServiceError } from "./errors.js";

const API_A = "11111111-1111-4111-8111-111111111111";
const API_B = "22222222-2222-4222-8222-222222222222";
const API_C = "33333333-3333-4333-8333-333333333333";
const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");
const KEY_C = Buffer.alloc(32, 3).toString("base64url");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function request(
  processNonce: string,
  apiInstanceId = API_A,
  idempotencyKey = KEY_A,
): CreateControlGenerationV1 {
  return { version: 1, processNonce, apiInstanceId, idempotencyKey };
}

function context(controller = new AbortController()): {
  value: ControlGenerationRequestContext;
  controller: AbortController;
} {
  return {
    value: {
      transportSignal: controller.signal,
      deadlineAtMs: Date.now() + 60_000,
    },
    controller,
  };
}

async function handedOffState() {
  let byte = 8;
  const state = createStartupState({
    randomBytes: () => Buffer.alloc(32, byte++),
  });
  const generation = await state.createControlGeneration(
    request(state.processNonce),
    context().value,
    async () => undefined,
  );
  return { state, generation };
}

function reconciliationRequest(
  processNonce: string,
  controlGenerationNonce: string,
  snapshotDigest = DIGEST_A,
): ReconciliationRequestV1 {
  return {
    version: 1,
    processNonce,
    controlGenerationNonce,
    snapshotDigest,
    references: [],
  };
}

function reconciliationResult(
  requestValue: ReconciliationRequestV1,
): ReconciliationResultV1 {
  return {
    version: 1,
    processNonce: requestValue.processNonce,
    controlGenerationNonce: requestValue.controlGenerationNonce,
    snapshotDigest: requestValue.snapshotDigest,
    retained: 0,
    removed: 0,
    missing: 0,
    corrupt: 0,
    ready: true,
  };
}

function indexedRequest(
  processNonce: string,
  index: number,
): CreateControlGenerationV1 {
  const key = Buffer.alloc(32);
  key.writeUInt32BE(index, 28);
  return request(
    processNonce,
    `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    key.toString("base64url"),
  );
}

describe("startup admission", () => {
  test("starts discoverable but rejects work before handoff", () => {
    const state = createStartupState({
      randomBytes: () => Buffer.alloc(32, 7),
    });
    expect(state.liveHealth()).toEqual({
      version: 1,
      status: "live_unreconciled",
      processNonce: Buffer.alloc(32, 7).toString("base64url"),
    });
    expect(() =>
      state.requireReady({
        processNonce: state.processNonce,
        controlGenerationNonce: KEY_A,
      }),
    ).toThrow(
      expect.objectContaining({ category: "control_generation_required" }),
    );
  });

  test("keeps process identity stable and mints distinct generations", async () => {
    let byte = 10;
    const state = createStartupState({
      randomBytes: () => Buffer.alloc(32, byte++),
    });
    const first = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const second = await state.createControlGeneration(
      request(state.processNonce, API_B, KEY_B),
      context().value,
      async () => undefined,
    );
    expect(state.processNonce).toHaveLength(43);
    expect(first.processNonce).toBe(state.processNonce);
    expect(second.processNonce).toBe(state.processNonce);
    expect(second.controlGenerationNonce).not.toBe(
      first.controlGenerationNonce,
    );
  });

  test("closes admission before one shared drain and fences live takeover", async () => {
    const state = createStartupState();
    const drain = deferred<void>();
    const drainRuntime = vi.fn(() => drain.promise);
    const first = state.createControlGeneration(
      request(state.processNonce),
      context().value,
      drainRuntime,
    );
    expect(state.liveHealth().status).toBe("live_unreconciled");
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_B, KEY_B),
        context().value,
        drainRuntime,
      ),
    ).rejects.toMatchObject({ category: "control_generation_in_progress" });
    drain.resolve();
    await expect(first).resolves.toMatchObject({ apiInstanceId: API_A });
    expect(drainRuntime).toHaveBeenCalledTimes(1);
  });

  test("publishes the handoff wave before synchronous callback reentry", async () => {
    const state = createStartupState();
    let reentry: Promise<unknown> | undefined;
    const drainRuntime = vi.fn(async () => {
      reentry = state.createControlGeneration(
        request(state.processNonce, API_B, KEY_B),
        context().value,
        drainRuntime,
      );
    });

    await expect(
      state.createControlGeneration(
        request(state.processNonce),
        context().value,
        drainRuntime,
      ),
    ).resolves.toMatchObject({ apiInstanceId: API_A });
    await expect(reentry).rejects.toMatchObject({
      category: "control_generation_in_progress",
    });
    expect(drainRuntime).toHaveBeenCalledTimes(1);
  });

  test("synchronous shutdown aborts the already-published handoff wave", async () => {
    const state = createStartupState();
    let receivedSignal: AbortSignal | undefined;
    const attempt = state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async (admission) => {
        receivedSignal = admission.signal;
        state.beginDraining();
      },
    );

    expect(receivedSignal?.aborted).toBe(true);
    await expect(attempt).rejects.toMatchObject({
      category: "control_generation_drain_failed",
      detail: "drain_invariant_failed",
    });
  });

  test("orphan replacements adopt one drain and only latest owner mints", async () => {
    const state = createStartupState();
    const drain = deferred<void>();
    const drainRuntime = vi.fn(() => drain.promise);
    const aContext = context();
    const bContext = context();
    const a = state.createControlGeneration(
      request(state.processNonce),
      aContext.value,
      drainRuntime,
    );
    aContext.controller.abort();
    const b = state.createControlGeneration(
      request(state.processNonce, API_B, KEY_B),
      bContext.value,
      drainRuntime,
    );
    bContext.controller.abort();
    const c = state.createControlGeneration(
      request(state.processNonce, API_C, KEY_C),
      context().value,
      drainRuntime,
    );
    drain.resolve();
    await expect(a).rejects.toMatchObject({
      category: "control_generation_superseded",
    });
    await expect(b).rejects.toMatchObject({
      category: "control_generation_superseded",
    });
    await expect(c).resolves.toMatchObject({ apiInstanceId: API_C });
    await expect(
      state.createControlGeneration(
        request(state.processNonce),
        context().value,
        drainRuntime,
      ),
    ).rejects.toMatchObject({ category: "control_generation_superseded" });
    expect(drainRuntime).toHaveBeenCalledTimes(1);
  });

  test("deadline-expired owner can be superseded without a second drain", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
      const state = createStartupState();
      const drain = deferred<void>();
      const drainRuntime = vi.fn(() => drain.promise);
      const old = state.createControlGeneration(
        request(state.processNonce),
        {
          transportSignal: new AbortController().signal,
          deadlineAtMs: Date.now() + 1_000,
        },
        drainRuntime,
      );
      vi.setSystemTime(new Date("2026-07-21T12:00:01.001Z"));
      const replacement = state.createControlGeneration(
        request(state.processNonce, API_B, KEY_B),
        context().value,
        drainRuntime,
      );
      drain.resolve();
      await expect(old).rejects.toMatchObject({
        category: "control_generation_superseded",
      });
      await expect(replacement).resolves.toMatchObject({
        apiInstanceId: API_B,
      });
      expect(drainRuntime).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("replacement finishes a drain that settled after its owner died", async () => {
    const state = createStartupState();
    const drain = deferred<void>();
    const drainRuntime = vi.fn(() => drain.promise);
    const oldContext = context();
    const old = state.createControlGeneration(
      request(state.processNonce),
      oldContext.value,
      drainRuntime,
    );
    oldContext.controller.abort();
    drain.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const replacement = state.createControlGeneration(
      request(state.processNonce, API_B, KEY_B),
      context().value,
      drainRuntime,
    );

    await expect(old).rejects.toMatchObject({
      category: "control_generation_superseded",
    });
    await expect(replacement).resolves.toMatchObject({ apiInstanceId: API_B });
    expect(drainRuntime).toHaveBeenCalledTimes(1);
  });

  test("orphan replacement can adopt the drain at history capacity", async () => {
    const state = createStartupState();
    for (let index = 0; index < 1_022; index += 1) {
      await state.createControlGeneration(
        indexedRequest(state.processNonce, index),
        context().value,
        async () => undefined,
      );
    }
    const drain = deferred<void>();
    const oldContext = context();
    const oldRequest = indexedRequest(state.processNonce, 1_022);
    const old = state.createControlGeneration(
      oldRequest,
      oldContext.value,
      () => drain.promise,
    );
    oldContext.controller.abort();
    const replacementRequest = indexedRequest(state.processNonce, 1_023);
    const replacement = state.createControlGeneration(
      replacementRequest,
      context().value,
      () => drain.promise,
    );
    drain.resolve();

    await expect(old).rejects.toMatchObject({
      category: "control_generation_superseded",
    });
    await expect(replacement).resolves.toMatchObject({
      apiInstanceId: replacementRequest.apiInstanceId,
    });
  });

  test("history capacity rejects orphan replacement without owner change", async () => {
    const state = createStartupState();
    for (let index = 0; index < 1_023; index += 1) {
      await state.createControlGeneration(
        indexedRequest(state.processNonce, index),
        context().value,
        async () => undefined,
      );
    }
    const drain = deferred<void>();
    const drainRuntime = vi.fn(() => drain.promise);
    const ownerContext = context();
    const ownerRequest = indexedRequest(state.processNonce, 1_023);
    const owner = state.createControlGeneration(
      ownerRequest,
      ownerContext.value,
      drainRuntime,
    );
    void owner.catch(() => undefined);
    ownerContext.controller.abort();
    await expect(
      state.createControlGeneration(
        indexedRequest(state.processNonce, 1_024),
        context().value,
        drainRuntime,
      ),
    ).rejects.toMatchObject({
      category: "control_generation_history_exhausted",
    });
    await expect(
      state.createControlGeneration(
        ownerRequest,
        context().value,
        drainRuntime,
      ),
    ).rejects.toMatchObject({
      category: "control_generation_in_progress",
    });
    expect(drainRuntime).toHaveBeenCalledTimes(1);
  });

  test("shutdown aborts a handoff wave and never mints", async () => {
    const state = createStartupState();
    const drain = deferred<void>();
    let waveSignal: AbortSignal | undefined;
    const attempt = state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async (waveAdmission) => {
        waveSignal = waveAdmission.signal;
        return drain.promise;
      },
    );
    state.beginDraining();
    expect(waveSignal?.aborted).toBe(true);
    drain.resolve();
    await expect(attempt).rejects.toMatchObject({
      category: "control_generation_drain_failed",
      detail: "drain_invariant_failed",
    });
    expect(state.liveHealth().status).toBe("live_unreconciled");
  });

  test("caches terminal drain failure and requires a fresh full redrain", async () => {
    const state = createStartupState();
    const failure = new Error("close failed");
    const failDrain = vi.fn(async () => Promise.reject(failure));
    const firstRequest = request(state.processNonce);
    const first = state.createControlGeneration(
      firstRequest,
      context().value,
      failDrain,
    );
    await expect(first).rejects.toMatchObject({
      category: "control_generation_drain_failed",
      detail: "close_failed",
    });
    const replay = state.createControlGeneration(
      firstRequest,
      context().value,
      async () => undefined,
    );
    await expect(replay).rejects.toBe(await first.catch((error) => error));

    const redrain = vi.fn(async () => undefined);
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_B, KEY_B),
        context().value,
        redrain,
      ),
    ).resolves.toMatchObject({ apiInstanceId: API_B });
    expect(failDrain).toHaveBeenCalledTimes(1);
    expect(redrain).toHaveBeenCalledTimes(1);
  });

  test("rejects tuple collisions without draining", async () => {
    const { state } = await handedOffState();
    const drain = vi.fn(async () => undefined);
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_A, KEY_B),
        context().value,
        drain,
      ),
    ).rejects.toMatchObject({ category: "control_generation_conflict" });
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_B, KEY_A),
        context().value,
        drain,
      ),
    ).rejects.toMatchObject({ category: "control_generation_conflict" });
    expect(drain).not.toHaveBeenCalled();
  });

  test("reserves unknown tuple capacity before collision semantics", async () => {
    const state = createStartupState();
    for (let index = 0; index < 1_023; index += 1) {
      await state.createControlGeneration(
        indexedRequest(state.processNonce, index),
        context().value,
        async () => undefined,
      );
    }
    const drain = vi.fn(async () => undefined);
    const collidingBelowCapacity = request(
      state.processNonce,
      indexedRequest(state.processNonce, 0).apiInstanceId,
      KEY_C,
    );
    await expect(
      state.createControlGeneration(
        collidingBelowCapacity,
        context().value,
        drain,
      ),
    ).rejects.toMatchObject({ category: "control_generation_conflict" });

    const finalRequest = indexedRequest(state.processNonce, 1_023);
    await expect(
      state.createControlGeneration(
        finalRequest,
        context().value,
        async () => undefined,
      ),
    ).resolves.toMatchObject({ apiInstanceId: finalRequest.apiInstanceId });
    await expect(
      state.createControlGeneration(
        collidingBelowCapacity,
        context().value,
        drain,
      ),
    ).rejects.toMatchObject({
      category: "control_generation_history_exhausted",
    });
    await expect(
      state.createControlGeneration(finalRequest, context().value, drain),
    ).resolves.toMatchObject({ apiInstanceId: finalRequest.apiInstanceId });
    expect(drain).not.toHaveBeenCalled();
  });

  test("completed A to B then replay A leaves B as current", async () => {
    const state = createStartupState();
    const aRequest = request(state.processNonce);
    const a = await state.createControlGeneration(
      aRequest,
      context().value,
      async () => undefined,
    );
    const b = await state.createControlGeneration(
      request(state.processNonce, API_B, KEY_B),
      context().value,
      async () => undefined,
    );
    await expect(
      state.createControlGeneration(
        aRequest,
        context().value,
        async () => undefined,
      ),
    ).resolves.toEqual(a);
    expect(() => state.requireReady(a)).toThrow(
      expect.objectContaining({ category: "control_generation_mismatch" }),
    );
    expect(state.scopedLiveHealth(b).controlGenerationNonce).toBe(
      b.controlGenerationNonce,
    );
  });

  test("fails closed when accepted tuple history is exhausted", async () => {
    const state = createStartupState();
    let historical:
      | Awaited<ReturnType<typeof state.createControlGeneration>>
      | undefined;
    let historicalRequest: CreateControlGenerationV1 | undefined;
    for (let index = 0; index < 1_024; index += 1) {
      const key = Buffer.alloc(32);
      key.writeUInt32BE(index, 28);
      historicalRequest = request(
        state.processNonce,
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        key.toString("base64url"),
      );
      historical = await state.createControlGeneration(
        historicalRequest,
        context().value,
        async () => undefined,
      );
    }
    const drain = vi.fn(async () => undefined);
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_C, KEY_C),
        context().value,
        drain,
      ),
    ).rejects.toMatchObject({
      category: "control_generation_history_exhausted",
    });
    await expect(
      state.createControlGeneration(historicalRequest!, context().value, drain),
    ).resolves.toEqual(historical);
    expect(drain).not.toHaveBeenCalled();
  });

  test("rejects stale process and generation before reconciliation callback", async () => {
    const { state, generation } = await handedOffState();
    const execute = vi.fn(async (value: ReconciliationRequestV1) =>
      reconciliationResult(value),
    );
    await expect(
      state.reconcile(
        reconciliationRequest(KEY_A, generation.controlGenerationNonce),
        execute,
      ),
    ).rejects.toMatchObject({ category: "reconciliation_nonce_mismatch" });
    await expect(
      state.reconcile(
        reconciliationRequest(state.processNonce, KEY_A),
        execute,
      ),
    ).rejects.toMatchObject({ category: "control_generation_mismatch" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("caches exact success and rejects a conflicting digest", async () => {
    const { state, generation } = await handedOffState();
    const valid = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    const execute = vi.fn(async (value: ReconciliationRequestV1) =>
      reconciliationResult(value),
    );
    const first = await state.reconcile(valid, execute);
    await expect(state.reconcile(valid, execute)).resolves.toEqual(first);
    await expect(
      state.reconcile({ ...valid, snapshotDigest: DIGEST_B }, execute),
    ).rejects.toMatchObject({
      category: "reconciliation_conflicting_replay",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.requireReady(generation)).toEqual({
      processNonce: state.processNonce,
      controlGenerationNonce: generation.controlGenerationNonce,
      snapshotDigest: DIGEST_A,
    });
  });

  test("shares one same-digest reconciliation execution", async () => {
    const { state, generation } = await handedOffState();
    const valid = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    const paused = deferred<ReconciliationResultV1>();
    const execute = vi.fn(() => paused.promise);
    const first = state.reconcile(valid, execute);
    const second = state.reconcile(valid, execute);
    paused.resolve(reconciliationResult(valid));
    await expect(first).resolves.toEqual(reconciliationResult(valid));
    await expect(second).resolves.toEqual(reconciliationResult(valid));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("publishes reconciliation flight before synchronous reentry", async () => {
    const { state, generation } = await handedOffState();
    const valid = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    let reentry: Promise<ReconciliationResultV1> | undefined;
    const execute = vi.fn(async (value: ReconciliationRequestV1) => {
      reentry = state.reconcile(valid, execute);
      return reconciliationResult(value);
    });

    await expect(state.reconcile(valid, execute)).resolves.toEqual(
      reconciliationResult(valid),
    );
    await expect(reentry).resolves.toEqual(reconciliationResult(valid));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("synchronous shutdown aborts the published reconciliation flight", async () => {
    const { state, generation } = await handedOffState();
    const valid = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    let receivedSignal: AbortSignal | undefined;
    const attempt = state.reconcile(valid, async (value, admission) => {
      receivedSignal = admission.signal;
      state.beginDraining();
      return reconciliationResult(value);
    });

    expect(receivedSignal?.aborted).toBe(true);
    await expect(attempt).rejects.toMatchObject({
      category: "reconciliation_required",
    });
  });

  test("applies reconciliation request category precedence before execution", async () => {
    const { state, generation } = await handedOffState();
    const valid = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    const execute = vi.fn(async (value: ReconciliationRequestV1) =>
      reconciliationResult(value),
    );
    const tooMany = {
      ...valid,
      references: Array.from(
        { length: MAX_RECONCILIATION_REFERENCES + 1 },
        () => ({ bad: true }),
      ),
    } as unknown as ReconciliationRequestV1;
    await expect(state.reconcile(tooMany, execute)).rejects.toMatchObject({
      category: "reconciliation_snapshot_too_large",
    });
    const oversized = {
      ...valid,
      padding: "x".repeat(MAX_REPLAY_REQUEST_BYTES),
    } as unknown as ReconciliationRequestV1;
    await expect(state.reconcile(oversized, execute)).rejects.toMatchObject({
      category: "reconciliation_snapshot_too_large",
    });
    await expect(
      state.reconcile({ ...valid, snapshotDigest: "bad" }, execute),
    ).rejects.toMatchObject({ category: "reconciliation_snapshot_invalid" });
    await expect(
      state.reconcile({ ...valid, processNonce: KEY_A }, execute),
    ).rejects.toMatchObject({ category: "reconciliation_nonce_mismatch" });
    await expect(
      state.reconcile({ ...valid, controlGenerationNonce: KEY_A }, execute),
    ).rejects.toMatchObject({ category: "control_generation_mismatch" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("failed reconciliation remains unready and is retryable", async () => {
    const { state, generation } = await handedOffState();
    const valid = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    await expect(
      state.reconcile(valid, async () => {
        throw new BrowserServiceError(
          "reconciliation_cleanup_failed",
          "cleanup failed",
        );
      }),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    expect(state.readyHealth()).toMatchObject({
      status: "unready",
      category: "reconciliation_required",
    });
    await expect(
      state.reconcile(valid, async (value) => reconciliationResult(value)),
    ).resolves.toMatchObject({ ready: true });
  });

  test("cached success cannot return after draining starts", async () => {
    const { state, generation } = await handedOffState();
    const valid = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    const execute = vi.fn(async (value: ReconciliationRequestV1) =>
      reconciliationResult(value),
    );
    await state.reconcile(valid, execute);
    const replay = state.reconcile(valid, execute);
    state.beginDraining();
    await expect(replay).rejects.toMatchObject({
      category: "reconciliation_required",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("new handoff clears readiness and accepts a changed digest", async () => {
    const { state, generation } = await handedOffState();
    const firstRequest = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    await state.reconcile(firstRequest, async (value) =>
      reconciliationResult(value),
    );
    const next = await state.createControlGeneration(
      request(state.processNonce, API_B, KEY_B),
      context().value,
      async () => undefined,
    );
    expect(() => state.requireReady(generation)).toThrow(
      expect.objectContaining({ category: "control_generation_mismatch" }),
    );
    const nextRequest = reconciliationRequest(
      state.processNonce,
      next.controlGenerationNonce,
      DIGEST_B,
    );
    await expect(
      state.reconcile(nextRequest, async (value) =>
        reconciliationResult(value),
      ),
    ).resolves.toMatchObject({ snapshotDigest: DIGEST_B });
  });

  test("draining aborts in-flight reconciliation and permanently closes readiness", async () => {
    const { state, generation } = await handedOffState();
    const requestValue = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
    );
    const paused = deferred<ReconciliationResultV1>();
    let receivedSignal: AbortSignal | undefined;
    const attempt = state.reconcile(requestValue, async (_value, admission) => {
      receivedSignal = admission.signal;
      return paused.promise;
    });
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    state.beginDraining();
    expect(receivedSignal?.aborted).toBe(true);
    paused.resolve(reconciliationResult(requestValue));
    await expect(attempt).rejects.toMatchObject({
      category: "reconciliation_required",
    });
    expect(() => state.requireReady(generation)).toThrow(
      expect.objectContaining({ category: "reconciliation_required" }),
    );
  });
});
