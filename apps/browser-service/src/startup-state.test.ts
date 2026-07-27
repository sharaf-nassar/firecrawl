import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

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
  createInternalStartupState,
  createStartupState,
  type ControlGenerationRequestContext,
  type InternalStartupAdmission,
  type ReconciliationExecutionAdmission,
} from "./startup-state.js";
import { BrowserServiceError } from "./errors.js";
import {
  canonicalizeReconciliationSnapshot,
  reconcileBrowserStateWithAuthority,
  runWithReconciliationFilesystemTestContext,
  type InternalReconciliationOutcome,
} from "./reconciliation.js";
import {
  createProfileStore,
  type ProfileStore,
} from "./profile-store.js";

const API_A = "11111111-1111-4111-8111-111111111111";
const API_B = "22222222-2222-4222-8222-222222222222";
const API_C = "33333333-3333-4333-8333-333333333333";
const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");
const KEY_C = Buffer.alloc(32, 3).toString("base64url");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const EMPTY_SNAPSHOT_DIGEST =
  canonicalizeReconciliationSnapshot([]).snapshotDigest;
const authorityRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    authorityRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function authorityRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "startup-authority-"));
  authorityRoots.push(root);
  return root;
}

async function authorityDescriptorCount(root: string): Promise<number> {
  const descriptors = await readdir("/proc/self/fd");
  const targets = await Promise.all(
    descriptors.map((descriptor) =>
      readlink(`/proc/self/fd/${descriptor}`).catch(() => ""),
    ),
  );
  return targets.filter((target) => target.startsWith(root)).length;
}

function profileStoreFixture() {
  const close = vi.fn(async () => undefined);
  return {
    close,
    store: { close } as unknown as ProfileStore,
  };
}

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

  test("atomically installs a genuine reconciliation authority before ready", async () => {
    const root = await authorityRoot();
    const fixture = profileStoreFixture();
    const installOrder: string[] = [];
    let state!: InternalStartupAdmission;
    const createProfileStore = vi.fn(async (_root, binding, sealedCount) => {
      installOrder.push("create-store");
      expect(state.readyHealth()).toMatchObject({
        status: "unready",
      });
      expect(binding).toEqual({
        processNonce: state.processNonce,
        controlGenerationNonce: expect.any(String),
        snapshotDigest: EMPTY_SNAPSHOT_DIGEST,
      });
      expect(sealedCount).toBe(0);
      return fixture.store;
    });
    const compareAndSwapInstall = vi.fn(() => true);
    state = createStartupState({
      randomBytes: () => Buffer.alloc(32, 31),
      createProfileStore,
      compareAndSwapInstall,
    });
    if (false) {
      // @ts-expect-error Authority startup never exposes result-only reconcile.
      void state.reconcile;
    }
    const generation = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );

    const result = await state.reconcileWithAuthority(
      input,
      async (requestValue, admission) => {
        installOrder.push("execute");
        return reconcileBrowserStateWithAuthority(root, requestValue, {
          admission,
        });
      },
    );
    installOrder.push("ready");

    expect(result).toEqual(reconciliationResult(input));
    expect(installOrder).toEqual(["execute", "create-store", "ready"]);
    expect(createProfileStore).toHaveBeenCalledOnce();
    expect(compareAndSwapInstall).toHaveBeenCalledOnce();
    expect("reconcile" in state).toBe(false);
    const [current, bundle] = compareAndSwapInstall.mock.calls[0]!;
    expect(current).toBeNull();
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.generation)).toBe(true);
    expect(Object.isFrozen(bundle.result)).toBe(true);
    expect(Object.isFrozen(bundle.binding)).toBe(true);
    expect(bundle).toMatchObject({
      generation,
      result,
      profileStore: fixture.store,
      binding: {
        processNonce: state.processNonce,
        controlGenerationNonce: generation.controlGenerationNonce,
        snapshotDigest: EMPTY_SNAPSHOT_DIGEST,
      },
    });
    expect(state.requireReady(generation)).toEqual({
      processNonce: state.processNonce,
      controlGenerationNonce: generation.controlGenerationNonce,
      snapshotDigest: EMPTY_SNAPSHOT_DIGEST,
    });
  });

  test("fences synchronously but awaits installed authority close separately", async () => {
    const root = await authorityRoot();
    const fixture = profileStoreFixture();
    const state = createInternalStartupState({
      createProfileStore: async () => fixture.store,
      compareAndSwapInstall: () => true,
    });
    const generation = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(input, (requestValue, admission) =>
      reconcileBrowserStateWithAuthority(root, requestValue, { admission }),
    );
    expect(await authorityDescriptorCount(root)).toBeGreaterThan(0);

    state.beginDraining();

    expect(() => state.requireReady(generation)).toThrow(
      expect.objectContaining({ category: "reconciliation_required" }),
    );
    expect(fixture.close).not.toHaveBeenCalled();
    expect(await authorityDescriptorCount(root)).toBeGreaterThan(0);

    await state.closeInstalledAuthority();

    expect(fixture.close).toHaveBeenCalledOnce();
    expect(await authorityDescriptorCount(root)).toBe(0);
  });

  test("does not swallow installed authority close failure", async () => {
    const root = await authorityRoot();
    const fixture = profileStoreFixture();
    fixture.close.mockRejectedValueOnce(new Error("injected close failure"));
    const state = createInternalStartupState({
      createProfileStore: async () => fixture.store,
      compareAndSwapInstall: () => true,
    });
    const generation = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(input, (requestValue, admission) =>
      reconcileBrowserStateWithAuthority(root, requestValue, { admission }),
    );
    state.beginDraining();

    await expect(state.closeInstalledAuthority()).rejects.toThrow(
      "injected close failure",
    );
  });

  test("requires compare-and-swap for production authority startup", () => {
    expect(() =>
      createStartupState({
        createProfileStore: async () => profileStoreFixture().store,
      } as Parameters<typeof createStartupState>[0]),
    ).toThrow("compareAndSwapInstall is required");
  });

  test("rejects a forged reconciliation outcome without installing ready", async () => {
    const createProfileStore = vi.fn(async () => profileStoreFixture().store);
    const state = createInternalStartupState({
      createProfileStore,
      compareAndSwapInstall: () => true,
    });
    const generation = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    const execute = vi.fn(async () =>
      Object.freeze({}) as InternalReconciliationOutcome,
    );

    await expect(
      state.reconcileWithAuthority(input, execute),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(execute).toHaveBeenCalledOnce();
    expect(createProfileStore).not.toHaveBeenCalled();
    expect(state.readyHealth()).toMatchObject({
      status: "unready",
      category: "reconciliation_required",
    });
  });

  test("store construction failure leaves authority uninstalled without reconstruction", async () => {
    const root = await authorityRoot();
    const createProfileStore = vi
      .fn()
      .mockRejectedValue(new Error("store construction failed"));
    const state = createInternalStartupState({
      createProfileStore,
      compareAndSwapInstall: () => true,
    });
    const generation = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    const execute = (
      requestValue: ReconciliationRequestV1,
      admission: ReconciliationExecutionAdmission,
    ) =>
      reconcileBrowserStateWithAuthority(root, requestValue, { admission });

    await expect(
      state.reconcileWithAuthority(input, execute),
    ).rejects.toBeInstanceOf(Error);
    expect(state.readyHealth()).toMatchObject({
      status: "unready",
      category: "reconciliation_required",
    });
    expect(() => state.requireReady(generation)).toThrow(
      expect.objectContaining({ category: "reconciliation_required" }),
    );

    await expect(
      state.reconcileWithAuthority(input, execute),
    ).rejects.toMatchObject({
      category: "reconciliation_execution_failed",
    });
    expect(createProfileStore).toHaveBeenCalledOnce();
    expect(() => state.requireReady(generation)).toThrow(
      expect.objectContaining({ category: "reconciliation_required" }),
    );
    expect(await authorityDescriptorCount(root)).toBe(0);
  });

  test("CAS failure closes the one uninstalled store and exposes no bundle", async () => {
    const root = await authorityRoot();
    const fixture = profileStoreFixture();
    const createProfileStore = vi.fn(async () => fixture.store);
    const compareAndSwapInstall = vi.fn(() => false);
    const state = createInternalStartupState({
      createProfileStore,
      compareAndSwapInstall,
    });
    const generation = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      generation.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );

    await expect(
      state.reconcileWithAuthority(input, (requestValue, admission) =>
        reconcileBrowserStateWithAuthority(root, requestValue, { admission }),
      ),
    ).rejects.toMatchObject({
      category: "reconciliation_execution_failed",
    });
    expect(createProfileStore).toHaveBeenCalledOnce();
    expect(compareAndSwapInstall).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(state.readyHealth()).toMatchObject({
      status: "unready",
      category: "reconciliation_required",
    });
    expect(() => state.requireReady(generation)).toThrow(
      expect.objectContaining({ category: "reconciliation_required" }),
    );
    expect(await authorityDescriptorCount(root)).toBe(0);
  });

  test("rollover remains unready until later authority reconciliation", async () => {
    const root = await authorityRoot();
    const stores = [profileStoreFixture(), profileStoreFixture()];
    const createProfileStore = vi
      .fn()
      .mockResolvedValueOnce(stores[0]!.store)
      .mockResolvedValueOnce(stores[1]!.store);
    const state = createInternalStartupState({
      randomBytes: (() => {
        let byte = 41;
        return () => Buffer.alloc(32, byte++);
      })(),
      createProfileStore,
      compareAndSwapInstall: () => true,
    });
    const first = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const firstInput = reconciliationRequest(
      state.processNonce,
      first.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(firstInput, (requestValue, admission) =>
      reconcileBrowserStateWithAuthority(root, requestValue, { admission }),
    );
    expect(state.readyHealth().status).toBe("ready");

    const second = await state.createControlGeneration(
      request(state.processNonce, API_B, KEY_B),
      context().value,
      async () => undefined,
    );
    expect(stores[0]!.close).toHaveBeenCalledOnce();
    expect(state.readyHealth()).toMatchObject({
      status: "unready",
      controlGenerationNonce: second.controlGenerationNonce,
      category: "reconciliation_required",
    });
    expect(() => state.requireReady(second)).toThrow(
      expect.objectContaining({ category: "reconciliation_required" }),
    );

    const secondInput = reconciliationRequest(
      state.processNonce,
      second.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(secondInput, (requestValue, admission) =>
      reconcileBrowserStateWithAuthority(root, requestValue, { admission }),
    );
    expect(createProfileStore).toHaveBeenCalledTimes(2);
    expect(state.requireReady(second).snapshotDigest).toBe(
      EMPTY_SNAPSHOT_DIGEST,
    );
  });

  test("retains old authority only for cleanup while rollover is fenced", async () => {
    const root = await authorityRoot();
    const fixture = profileStoreFixture();
    let oldAdmission: ReconciliationExecutionAdmission | undefined;
    const state = createInternalStartupState({
      createProfileStore: async () => fixture.store,
      compareAndSwapInstall: () => true,
    });
    const first = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const firstInput = reconciliationRequest(
      state.processNonce,
      first.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(
      firstInput,
      (requestValue, admission) => {
        oldAdmission = admission;
        return reconcileBrowserStateWithAuthority(root, requestValue, {
          admission,
        });
      },
    );

    const second = await state.createControlGeneration(
      request(state.processNonce, API_B, KEY_B),
      context().value,
      async () => {
        expect(state.liveHealth().status).toBe("live_unreconciled");
        expect(state.readyHealth()).toMatchObject({
          status: "unready",
          controlGenerationNonce: first.controlGenerationNonce,
          category: "reconciliation_required",
        });
        expect(() => state.requireReady(first)).toThrow(
          expect.objectContaining({ category: "reconciliation_required" }),
        );
        expect(() => oldAdmission!.assertAdmitted()).not.toThrow();
        await expect(
          state.reconcileWithAuthority(firstInput, async () => {
            throw new Error("reconciliation should remain fenced");
          }),
        ).rejects.toMatchObject({ category: "reconciliation_required" });
      },
    );

    expect(fixture.close).toHaveBeenCalledOnce();
    expect(() => oldAdmission!.assertAdmitted()).toThrow(
      expect.objectContaining({ category: "reconciliation_required" }),
    );
    expect(state.readyHealth()).toMatchObject({
      status: "unready",
      controlGenerationNonce: second.controlGenerationNonce,
      category: "reconciliation_required",
    });
  });

  test("control handoff retries unverified generation cleanup", async () => {
    const root = await authorityRoot();
    let installedStore: ProfileStore | undefined;
    const state = createInternalStartupState({
      randomBytes: (() => {
        let byte = 51;
        return () => Buffer.alloc(32, byte++);
      })(),
      async createProfileStore(anchoredRoot, binding) {
        installedStore = await createProfileStore({
          root: anchoredRoot,
          binding,
          randomUUID: () => API_C,
        });
        return installedStore;
      },
      compareAndSwapInstall: () => true,
    });
    const first = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      first.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(input, (requestValue, activeAdmission) =>
      reconcileBrowserStateWithAuthority(root, requestValue, {
        admission: activeAdmission,
      }),
    );
    await installedStore!.createWorkingCopy(API_A, null, "snapshot", API_B);
    let injected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async closeOperation(point, close) {
            if (!injected && point === "generation") {
              injected = true;
              throw new Error("injected handoff generation close failure");
            }
            await close();
          },
        },
        () => state.createControlGeneration(
          request(state.processNonce, API_B, KEY_B),
          context().value,
          async () => undefined,
        ),
      ),
    ).rejects.toBeDefined();
    expect(injected).toBe(true);
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_C, KEY_C),
        context().value,
        async () => undefined,
      ),
    ).resolves.toMatchObject({ apiInstanceId: API_C });
  });

  test("control handoff drains root-owned partial create cleanup", async () => {
    const root = await authorityRoot();
    let installedStore: ProfileStore | undefined;
    const state = createInternalStartupState({
      randomBytes: (() => {
        let byte = 61;
        return () => Buffer.alloc(32, byte++);
      })(),
      async createProfileStore(anchoredRoot, binding) {
        installedStore = await createProfileStore({
          root: anchoredRoot,
          binding,
          randomUUID: () => API_C,
        });
        return installedStore;
      },
      compareAndSwapInstall: () => true,
    });
    const first = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      first.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(input, (requestValue, activeAdmission) =>
      reconcileBrowserStateWithAuthority(root, requestValue, {
        admission: activeAdmission,
      }),
    );
    const baseline = await authorityDescriptorCount(root);
    let primaryInjected = false;
    let closeRejected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (!primaryInjected && point === "profile-mkdir-generation") {
              primaryInjected = true;
              throw new Error("injected partial bind failure");
            }
          },
          async closeOperation(point, close) {
            if (!closeRejected && point === "profile-create-cleanup") {
              closeRejected = true;
              throw new Error("injected actual close rejection");
            }
            await close();
          },
        },
        () => installedStore!.createWorkingCopy(
          API_A,
          null,
          "snapshot",
          API_B,
        ),
      ),
    ).rejects.toMatchObject({ cleanupUnverified: true });
    expect(primaryInjected).toBe(true);
    expect(closeRejected).toBe(true);
    expect(await authorityDescriptorCount(root)).toBeGreaterThan(baseline);
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_B, KEY_B),
        context().value,
        async () => undefined,
      ),
    ).resolves.toMatchObject({ apiInstanceId: API_B });
    expect(await authorityDescriptorCount(root)).toBe(0);
  });

  test("control handoff fail-stops on an unverifiable created leaf", async () => {
    const root = await authorityRoot();
    let installedStore: ProfileStore | undefined;
    const state = createInternalStartupState({
      randomBytes: (() => {
        let byte = 71;
        return () => Buffer.alloc(32, byte++);
      })(),
      async createProfileStore(anchoredRoot, binding) {
        installedStore = await createProfileStore({
          root: anchoredRoot,
          binding,
          randomUUID: () => API_C,
        });
        return installedStore;
      },
      compareAndSwapInstall: () => true,
    });
    const first = await state.createControlGeneration(
      request(state.processNonce),
      context().value,
      async () => undefined,
    );
    const input = reconciliationRequest(
      state.processNonce,
      first.controlGenerationNonce,
      EMPTY_SNAPSHOT_DIGEST,
    );
    await state.reconcileWithAuthority(input, (requestValue, activeAdmission) =>
      reconcileBrowserStateWithAuthority(root, requestValue, {
        admission: activeAdmission,
      }),
    );
    const created = join(root, "profiles", API_A, "working", API_C);
    const displaced = `${created}.unverified`;
    let identityRejected = false;
    let replaced = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (!identityRejected && point === "profile-lstat-created-generation") {
              identityRejected = true;
              throw new Error("injected creation identity failure");
            }
          },
          async beforeCleanup(point) {
            if (!replaced && point === "profile-create-cleanup-pin-lstat") {
              replaced = true;
              await rename(created, displaced);
              await mkdir(created, { mode: 0o700 });
              await writeFile(join(created, "outside"), "safe");
            }
          },
        },
        () => installedStore!.createWorkingCopy(
          API_A,
          null,
          "snapshot",
          API_B,
        ),
      ),
    ).rejects.toMatchObject({ cleanupUnverified: true });
    expect(identityRejected).toBe(true);
    expect(replaced).toBe(true);
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_B, KEY_B),
        context().value,
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      category: "control_generation_drain_failed",
      detail: "close_failed",
    });
    expect(await readFile(join(created, "outside"), "utf8")).toBe("safe");
    await rm(created, { recursive: true });
    await rm(displaced, { recursive: true });
    await expect(
      state.createControlGeneration(
        request(state.processNonce, API_C, KEY_C),
        context().value,
        async () => undefined,
      ),
    ).resolves.toMatchObject({ apiInstanceId: API_C });
    expect(await authorityDescriptorCount(root)).toBe(0);
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
