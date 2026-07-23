import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  ATOMIC_MAX_DIRECTORY_ENTRIES,
  ATOMIC_MAX_OBSERVATION_BYTES,
  ATOMIC_MAX_PARTIAL_CREATE_IDS,
  ATOMIC_MAX_TRACKED_IDS,
  advanceAtomicCanaryCleanup,
  createAtomicCanaryReducerState,
  createAtomicReducerState,
  isAtomicCanaryProofV1,
  isAtomicControlLeafV1,
  isAtomicPayloadLeafV1,
  reduceAtomicPublication,
  type AtomicEffectObservationV1,
  type AtomicEffectRequestDraftV1,
  type AtomicCanaryProofV1,
  type AtomicObjectEvidenceV1,
  type AtomicReducerStepV1,
  type CanonicalLocationEvidenceV1,
  type FlightEffectId,
  type FlightPartialCreateId,
  type FlightSemanticId,
} from "./atomic-directory-publication.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const EVIDENCE_VALUE = {
  dev: "1",
  ino: "2",
  mode: 448,
  size: 0,
  contentSha256: null,
};
const EVIDENCE: AtomicObjectEvidenceV1 = Object.freeze({
  ...EVIDENCE_VALUE,
  evidenceDigest: createHash("sha256")
    .update(JSON.stringify(EVIDENCE_VALUE))
    .digest("hex"),
});

function evidence(
  overrides: Partial<Omit<AtomicObjectEvidenceV1, "evidenceDigest">> = {},
): AtomicObjectEvidenceV1 {
  const value = { ...EVIDENCE_VALUE, ...overrides };
  return Object.freeze({
    ...value,
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex"),
  });
}

function semanticId(): FlightSemanticId {
  return Object.freeze({}) as FlightSemanticId;
}

function effectId(): FlightEffectId {
  return Object.freeze({}) as FlightEffectId;
}

function partialId(): FlightPartialCreateId {
  return Object.freeze({}) as FlightPartialCreateId;
}

function location(
  state: CanonicalLocationEvidenceV1["state"],
  objectId: FlightSemanticId | null,
  objectEvidence: AtomicObjectEvidenceV1 | null,
): CanonicalLocationEvidenceV1 {
  return Object.freeze({
    state,
    objectId,
    dev: objectEvidence?.dev ?? null,
    ino: objectEvidence?.ino ?? null,
    mode: objectEvidence?.mode ?? null,
    evidence: objectEvidence,
    evidenceDigest: HASH,
  });
}

function reserveDraft(): AtomicEffectRequestDraftV1 {
  return {
    kind: "reserve_budget",
    operationId: OPERATION_ID,
    reservation: "payload_entries",
    count: 1,
    byteSize: 0,
  };
}

function emittedEffect(
  step: AtomicReducerStepV1,
): Extract<AtomicReducerStepV1, { kind: "effect" }> {
  if (step.kind !== "effect") {
    throw new Error(`effect was not emitted: ${JSON.stringify(step.result)}`);
  }
  return step;
}

function plannedCanaryProof(
  wrapperEvidence: AtomicObjectEvidenceV1,
  targetParentEvidence: AtomicObjectEvidenceV1,
  privateSourceEvidence: AtomicObjectEvidenceV1,
): AtomicCanaryProofV1 {
  return Object.freeze({
    version: 1,
    operationId: OPERATION_ID,
    targetParentLocatorDigest: HASH,
    targetParentEvidence,
    wrapperEvidence,
    attempt: 0,
    sourceLeaf: `proof-${OPERATION_ID}-0`,
    targetLeaf: `canary-${OPERATION_ID}-0`,
    deletionLeaf: `deletion-${OPERATION_ID}-0`,
    phase: "planned",
    privateSourceEvidence,
    publishedEvidence: null,
    privateDeletionEvidence: null,
    classification: null,
    manifestSha256: null,
    cleanupNextIndex: 0,
    cleanupEntryCount: 0,
    sourceParentSynced: false,
    targetParentSynced: false,
  });
}

describe("atomic publication effect protocol", () => {
  test("enforces canonical UUID and exact control/payload leaf grammars", () => {
    expect(isAtomicControlLeafV1("a")).toBe(true);
    expect(isAtomicControlLeafV1(`a${".".repeat(126)}z`)).toBe(true);
    expect(isAtomicControlLeafV1(`a${".".repeat(127)}z`)).toBe(false);
    expect(isAtomicControlLeafV1("-bad")).toBe(false);
    expect(isAtomicControlLeafV1("bad-")).toBe(false);
    expect(isAtomicControlLeafV1("Bad")).toBe(false);
    expect(isAtomicControlLeafV1("bad/slash")).toBe(false);

    expect(isAtomicPayloadLeafV1("a")).toBe(true);
    expect(isAtomicPayloadLeafV1("é".repeat(127) + "a")).toBe(true);
    expect(isAtomicPayloadLeafV1("é".repeat(128))).toBe(false);
    expect(isAtomicPayloadLeafV1("e\u0301")).toBe(false);
    expect(isAtomicPayloadLeafV1("bad/slash")).toBe(false);
    expect(isAtomicPayloadLeafV1("bad\\slash")).toBe(false);
    expect(isAtomicPayloadLeafV1("\0")).toBe(false);

    expect(() =>
      createAtomicReducerState({
        flightNonce: "flight-uuid-v6",
        request: {
          ...reserveDraft(),
          operationId: "11111111-1111-6111-8111-111111111111",
        },
      }),
    ).toThrow(/invalid atomic effect request/u);
  });

  test("requires canonical, digest-authenticated object evidence", () => {
    const parentId = semanticId();
    for (const expected of [
      evidence({ dev: "01" }),
      Object.freeze({
        ...EVIDENCE,
        evidenceDigest: HASH,
      }) as AtomicObjectEvidenceV1,
    ]) {
      expect(() =>
        createAtomicReducerState({
          flightNonce: "flight-invalid-evidence",
          request: {
            kind: "open_pin_handle",
            operationId: OPERATION_ID,
            role: "payload_entry",
            parentId,
            leaf: "payload",
            flags: "file_read_nofollow",
            expected,
          },
          semanticIds: [parentId],
        }),
      ).toThrow(/invalid atomic effect request/u);
    }
  });

  test("rejects extra request and observation keys", () => {
    expect(() =>
      createAtomicReducerState({
        flightNonce: "flight-extra-request",
        request: {
          ...reserveDraft(),
          extra: true,
        } as AtomicEffectRequestDraftV1,
      }),
    ).toThrow(/invalid atomic effect request/u);

    const state = createAtomicReducerState({
      flightNonce: "flight-extra-observation",
      request: reserveDraft(),
    });
    const effect = reduceAtomicPublication(state, null);
    if (effect.kind !== "effect") throw new Error("effect was not emitted");
    expect(
      reduceAtomicPublication(state, {
        kind: "effect_completed",
        effectId: effect.request.effectId,
        requestKind: "reserve_budget",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
        extra: true,
      } as unknown as AtomicEffectObservationV1),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "unexpected_observation" },
    });
  });

  test("emits one effect and accepts only its matching observation once", () => {
    const state = createAtomicReducerState({
      flightNonce: "flight-a",
      request: reserveDraft(),
    });
    const first = reduceAtomicPublication(state, null);
    expect(first.kind).toBe("effect");
    if (first.kind !== "effect") throw new Error("effect was not emitted");
    expect(Object.keys(first.request)).toContain("effectId");

    const mismatched = reduceAtomicPublication(state, {
      kind: "effect_completed",
      effectId: effectId(),
      requestKind: "reserve_budget",
      evidenceDigest: HASH,
      count: 1,
      byteSize: 0,
    });
    expect(mismatched).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "effect_id_mismatch" },
    });

    const completed: AtomicEffectObservationV1 = {
      kind: "effect_completed",
      effectId: first.request.effectId,
      requestKind: "reserve_budget",
      evidenceDigest: HASH,
      count: 1,
      byteSize: 0,
    };
    const terminal = reduceAtomicPublication(state, completed);
    expect(terminal).toMatchObject({
      kind: "terminal",
      result: { kind: "protocol_complete" },
    });
    const replay = reduceAtomicPublication(terminal.state, completed);
    expect(replay).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "terminal_replay" },
    });
  });

  test("rejects out-of-order request kinds and observations without batching", () => {
    const state = createAtomicReducerState({
      flightNonce: "flight-b",
      request: reserveDraft(),
    });
    const first = reduceAtomicPublication(state, null);
    if (first.kind !== "effect") throw new Error("effect was not emitted");
    const result = reduceAtomicPublication(state, {
      kind: "effect_completed",
      effectId: first.request.effectId,
      requestKind: "release_budget",
      evidenceDigest: HASH,
      count: 1,
      byteSize: 0,
    });
    expect(result).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "request_kind_mismatch" },
    });
    expect("requests" in first).toBe(false);
  });

  test("rejects cross-flight and stale consumed effect IDs", () => {
    const firstFlight = createAtomicReducerState({
      flightNonce: "flight-cross-a",
      request: reserveDraft(),
    });
    const secondFlight = createAtomicReducerState({
      flightNonce: "flight-cross-b",
      request: reserveDraft(),
    });
    const firstEffect = reduceAtomicPublication(firstFlight, null);
    const secondEffect = reduceAtomicPublication(secondFlight, null);
    if (firstEffect.kind !== "effect" || secondEffect.kind !== "effect") {
      throw new Error("effect was not emitted");
    }
    expect(
      reduceAtomicPublication(firstFlight, {
        kind: "effect_completed",
        effectId: secondEffect.request.effectId,
        requestKind: "reserve_budget",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "effect_id_mismatch" },
    });

    const parentId = semanticId();
    const partialState = createAtomicReducerState({
      flightNonce: "flight-stale",
      request: {
        kind: "create_and_pin_directory",
        operationId: OPERATION_ID,
        role: "private_source",
        parentId,
        leaf: "payload",
        parentEvidenceDigest: HASH,
        mode: 448,
        expectedAbsence: true,
      },
      semanticIds: [parentId],
    });
    const create = reduceAtomicPublication(partialState, null);
    if (create.kind !== "effect") throw new Error("create was not emitted");
    const stalePartialId = partialId();
    const cleanup = reduceAtomicPublication(partialState, {
      kind: "create_and_pin_partial",
      effectId: create.request.effectId,
      requestKind: "create_and_pin_directory",
      partialId: stalePartialId,
      stage: "entry_created",
      entryCreated: true,
      handleOpened: false,
      evidence: null,
      code: "io",
      evidenceDigest: HASH,
    });
    if (cleanup.kind !== "effect") throw new Error("cleanup was not emitted");
    expect(
      reduceAtomicPublication(cleanup.state, {
        kind: "create_and_pin_partial",
        effectId: create.request.effectId,
        requestKind: "create_and_pin_directory",
        partialId: stalePartialId,
        stage: "entry_created",
        entryCreated: true,
        handleOpened: false,
        evidence: null,
        code: "io",
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "replayed_observation" },
    });
  });

  test("requires reservation and enforces directory observation bounds", () => {
    const rootId = semanticId();
    const draft: AtomicEffectRequestDraftV1 = {
      kind: "enumerate_directory",
      operationId: OPERATION_ID,
      role: "private_source",
      objectId: rootId,
      cursor: 0,
      byteLength: ATOMIC_MAX_OBSERVATION_BYTES,
      expected: EVIDENCE,
    };
    const missing = createAtomicReducerState({
      flightNonce: "flight-directory-missing",
      request: draft,
      semanticIds: [rootId],
    });
    expect(reduceAtomicPublication(missing, null)).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "reservation_missing" },
    });

    const state = createAtomicReducerState({
      flightNonce: "flight-directory",
      request: draft,
      semanticIds: [rootId],
      reservations: {
        directoryEntries: ATOMIC_MAX_DIRECTORY_ENTRIES + 1,
        directoryBytes: ATOMIC_MAX_OBSERVATION_BYTES,
      },
    });
    const first = reduceAtomicPublication(state, null);
    if (first.kind !== "effect") throw new Error("effect was not emitted");
    const entries = Array.from(
      { length: ATOMIC_MAX_DIRECTORY_ENTRIES + 1 },
      (_, index) => ({
        leaf: `entry-${index}`,
        role: "payload_entry" as const,
        objectId: semanticId(),
        type: "file" as const,
        evidenceDigest: HASH,
      }),
    );
    expect(
      reduceAtomicPublication(state, {
        kind: "directory_observed",
        effectId: first.request.effectId,
        cursor: 0,
        entries,
        done: false,
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "bounds_exceeded" },
    });
  });

  test("accepts exact directory maxima and rejects one encoded byte more", () => {
    const rootId = semanticId();
    const request: AtomicEffectRequestDraftV1 = {
      kind: "enumerate_directory",
      operationId: OPERATION_ID,
      role: "private_source",
      objectId: rootId,
      cursor: 0,
      byteLength: ATOMIC_MAX_OBSERVATION_BYTES,
      expected: EVIDENCE,
    };
    const makeState = (nonce: string) =>
      createAtomicReducerState({
        flightNonce: nonce,
        request,
        semanticIds: [rootId],
        reservations: {
          directoryEntries: ATOMIC_MAX_DIRECTORY_ENTRIES,
          directoryBytes: ATOMIC_MAX_OBSERVATION_BYTES,
        },
      });
    const entries = Array.from(
      { length: ATOMIC_MAX_DIRECTORY_ENTRIES },
      (_, index) => ({
        leaf: `e${index}-${"x".repeat(index < 109 ? 105 : 104)}`,
        role: "payload_entry" as const,
        objectId: semanticId(),
        type: "file" as const,
        evidenceDigest: HASH,
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(entries), "utf8")).toBe(
      ATOMIC_MAX_OBSERVATION_BYTES,
    );
    const exactState = makeState("flight-directory-exact");
    const exactEffect = reduceAtomicPublication(exactState, null);
    if (exactEffect.kind !== "effect") {
      throw new Error("directory effect was not emitted");
    }
    expect(
      reduceAtomicPublication(exactState, {
        kind: "directory_observed",
        effectId: exactEffect.request.effectId,
        cursor: 0,
        entries,
        done: true,
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "protocol_complete" },
    });

    const oversized = entries.map((entry, index) =>
      index === 0 ? { ...entry, leaf: `${entry.leaf}x` } : entry,
    );
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBe(
      ATOMIC_MAX_OBSERVATION_BYTES + 1,
    );
    const oversizedState = makeState("flight-directory-oversized");
    const oversizedEffect = reduceAtomicPublication(oversizedState, null);
    if (oversizedEffect.kind !== "effect") {
      throw new Error("directory effect was not emitted");
    }
    expect(
      reduceAtomicPublication(oversizedState, {
        kind: "directory_observed",
        effectId: oversizedEffect.request.effectId,
        cursor: 0,
        entries: oversized,
        done: true,
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "bounds_exceeded" },
    });
  });

  test("enforces decoded file chunks and monotonic cursors", () => {
    const fileId = semanticId();
    const state = createAtomicReducerState({
      flightNonce: "flight-file",
      request: {
        kind: "read_file_chunk",
        operationId: OPERATION_ID,
        role: "payload_entry",
        objectId: fileId,
        cursor: 3,
        byteLength: 1,
        expected: evidence({ mode: 384, size: 4 }),
      },
      semanticIds: [fileId],
      reservations: { fileBytes: ATOMIC_MAX_OBSERVATION_BYTES },
      cursors: { file: 0 },
    });
    expect(reduceAtomicPublication(state, null)).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "cursor_mismatch" },
    });

    const bounded = createAtomicReducerState({
      flightNonce: "flight-file-bounded",
      request: {
        kind: "read_file_chunk",
        operationId: OPERATION_ID,
        role: "payload_entry",
        objectId: fileId,
        cursor: 0,
        byteLength: ATOMIC_MAX_OBSERVATION_BYTES,
        expected: evidence({
          mode: 384,
          size: ATOMIC_MAX_OBSERVATION_BYTES,
        }),
      },
      semanticIds: [fileId],
      reservations: { fileBytes: ATOMIC_MAX_OBSERVATION_BYTES },
    });
    const effect = reduceAtomicPublication(bounded, null);
    if (effect.kind !== "effect") throw new Error("effect was not emitted");
    const oversized = Buffer.alloc(ATOMIC_MAX_OBSERVATION_BYTES + 1).toString(
      "base64",
    );
    expect(
      reduceAtomicPublication(bounded, {
        kind: "file_chunk_observed",
        effectId: effect.request.effectId,
        cursor: 0,
        byteSize: ATOMIC_MAX_OBSERVATION_BYTES + 1,
        bytesBase64: oversized,
        contentDigest: HASH,
        eof: false,
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "bounds_exceeded" },
    });
  });

  test("routes partial creates through exactly one cleanup effect", () => {
    const parentId = semanticId();
    const state = createAtomicReducerState({
      flightNonce: "flight-partial",
      request: {
        kind: "create_and_pin_directory",
        operationId: OPERATION_ID,
        role: "private_source",
        parentId,
        leaf: "payload",
        parentEvidenceDigest: HASH,
        mode: 448,
        expectedAbsence: true,
      },
      semanticIds: [parentId],
    });
    const create = reduceAtomicPublication(state, null);
    if (create.kind !== "effect") throw new Error("create was not emitted");
    const partial = partialId();
    const cleanup = reduceAtomicPublication(state, {
      kind: "create_and_pin_partial",
      effectId: create.request.effectId,
      requestKind: "create_and_pin_directory",
      partialId: partial,
      stage: "fstat_failed",
      entryCreated: true,
      handleOpened: true,
      evidence: null,
      code: "io",
      evidenceDigest: HASH,
    });
    expect(cleanup).toMatchObject({
      kind: "effect",
      request: {
        kind: "cleanup_partial_create",
        partialId: partial,
      },
    });
    if (cleanup.kind !== "effect") throw new Error("cleanup was not emitted");
    const completed = reduceAtomicPublication(cleanup.state, {
      kind: "partial_create_cleanup_observed",
      effectId: cleanup.request.effectId,
      partialId: partial,
      state: "absent",
      parentSynced: true,
      evidenceDigest: HASH,
    });
    expect(completed).toMatchObject({
      kind: "terminal",
      result: { kind: "protocol_complete" },
    });

    const failed = reduceAtomicPublication(cleanup.state, {
      kind: "partial_create_cleanup_failed",
      effectId: cleanup.request.effectId,
      partialId: partial,
      stage: "parent_fsync",
      state: "absent_unsynced",
      parentSynced: false,
      code: "io",
      evidenceDigest: HASH,
    });
    expect(failed).toMatchObject({
      kind: "terminal",
      result: {
        kind: "fail_stop",
        code: "partial_cleanup_failed",
        retainedPartialId: partial,
      },
    });
  });

  test("rejects malformed partial cleanup and removal correlations", () => {
    const parentId = semanticId();
    const createState = createAtomicReducerState({
      flightNonce: "flight-partial-correlations",
      request: {
        kind: "create_and_pin_directory",
        operationId: OPERATION_ID,
        role: "private_source",
        parentId,
        leaf: "payload",
        parentEvidenceDigest: HASH,
        mode: 448,
        expectedAbsence: true,
      },
      semanticIds: [parentId],
    });
    const create = reduceAtomicPublication(createState, null);
    if (create.kind !== "effect") throw new Error("create was not emitted");
    const partial = partialId();
    const cleanup = reduceAtomicPublication(createState, {
      kind: "create_and_pin_partial",
      effectId: create.request.effectId,
      requestKind: "create_and_pin_directory",
      partialId: partial,
      stage: "entry_created",
      entryCreated: true,
      handleOpened: false,
      evidence: null,
      code: "io",
      evidenceDigest: HASH,
    });
    if (cleanup.kind !== "effect") throw new Error("cleanup was not emitted");

    expect(
      reduceAtomicPublication(cleanup.state, {
        kind: "partial_create_cleanup_observed",
        effectId: cleanup.request.effectId,
        partialId: partial,
        state: "absent",
        parentSynced: false,
        evidenceDigest: HASH,
      } as unknown as AtomicEffectObservationV1),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "unexpected_observation" },
    });
    expect(
      reduceAtomicPublication(cleanup.state, {
        kind: "partial_create_cleanup_failed",
        effectId: cleanup.request.effectId,
        partialId: partial,
        stage: "parent_fsync",
        state: "present",
        parentSynced: false,
        code: "io",
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "unexpected_observation" },
    });

    const objectId = semanticId();
    const removal = createAtomicReducerState({
      flightNonce: "flight-removal-correlations",
      request: {
        kind: "remove_file",
        operationId: OPERATION_ID,
        role: "payload_entry",
        parentId,
        leaf: "payload",
        objectId,
        expected: evidence({ mode: 384 }),
        manifestSha256: HASH,
        cursor: 0,
      },
      semanticIds: [parentId, objectId],
    });
    const removeEffect = reduceAtomicPublication(removal, null);
    if (removeEffect.kind !== "effect") {
      throw new Error("remove was not emitted");
    }
    expect(
      reduceAtomicPublication(removal, {
        kind: "removal_observed",
        effectId: removeEffect.request.effectId,
        requestKind: "remove_file",
        objectId,
        removedEvidence: evidence({ mode: 384 }),
        state: "absent",
        parentSynced: false,
        evidenceDigest: HASH,
      } as unknown as AtomicEffectObservationV1),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "unexpected_observation" },
    });
  });

  test("rejects foreign semantic IDs and duplicate discovered IDs", () => {
    const known = semanticId();
    const foreign = semanticId();
    const foreignRequest = createAtomicReducerState({
      flightNonce: "flight-foreign-semantic",
      request: {
        kind: "open_pin_handle",
        operationId: OPERATION_ID,
        role: "payload_entry",
        parentId: foreign,
        leaf: "payload",
        flags: "file_read_nofollow",
        expected: evidence({ mode: 384 }),
      },
      semanticIds: [known],
    });
    expect(reduceAtomicPublication(foreignRequest, null)).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "invalid_request" },
    });

    const directory = createAtomicReducerState({
      flightNonce: "flight-duplicate-discovery",
      request: {
        kind: "enumerate_directory",
        operationId: OPERATION_ID,
        role: "private_source",
        objectId: known,
        cursor: 0,
        byteLength: 1,
        expected: EVIDENCE,
      },
      semanticIds: [known],
      reservations: { directoryEntries: 2, directoryBytes: 1 },
    });
    const directoryEffect = reduceAtomicPublication(directory, null);
    if (directoryEffect.kind !== "effect") {
      throw new Error("directory effect was not emitted");
    }
    const duplicate = semanticId();
    expect(
      reduceAtomicPublication(directory, {
        kind: "directory_observed",
        effectId: directoryEffect.request.effectId,
        cursor: 0,
        entries: [
          {
            leaf: "one",
            role: "payload_entry",
            objectId: duplicate,
            type: "file",
            evidenceDigest: HASH,
          },
          {
            leaf: "two",
            role: "payload_entry",
            objectId: duplicate,
            type: "file",
            evidenceDigest: HASH,
          },
        ],
        done: true,
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "observation_mismatch" },
    });
  });

  test("binds persistence native observations to exact move discriminators", () => {
    const tempParentId = semanticId();
    const tempObjectId = semanticId();
    const stableParentId = semanticId();
    const canonicalBytes = new TextEncoder().encode("{}\n");
    const contentDigest = createHash("sha256")
      .update(canonicalBytes)
      .digest("hex");
    const state = createAtomicReducerState({
      flightNonce: "flight-native-discriminator",
      request: {
        kind: "persist_intent",
        operationId: OPERATION_ID,
        expectedPhase: null,
        canonicalBytes,
        contentDigest,
        tempParentId,
        tempLeaf: "intent.tmp",
        tempObjectId,
        expectedTemp: evidence({
          mode: 384,
          size: canonicalBytes.byteLength,
          contentSha256: contentDigest,
        }),
        stableParentId,
        stableLeaf: "intent.json",
        expectedStable: { absent: true },
      },
      semanticIds: [tempParentId, tempObjectId, stableParentId],
    });
    const effect = reduceAtomicPublication(state, null);
    if (effect.kind !== "effect") throw new Error("effect was not emitted");
    expect(
      reduceAtomicPublication(state, {
        kind: "native_resolved",
        effectId: effect.request.effectId,
        requestKind: "persist_intent",
        operationId: OPERATION_ID,
        move: "manifest_publish",
        sourceObjectId: tempObjectId,
        sourceEvidence: evidence({
          mode: 384,
          size: canonicalBytes.byteLength,
          contentSha256: contentDigest,
        }),
        rawCode: "success",
        nativePrecheckEvidenceDigest: HASH,
        evidenceDigest: HASH,
      } as AtomicEffectObservationV1),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "unexpected_observation" },
    });
  });

  test("separates native resolution from canonical location classification", () => {
    const sourceParentId = semanticId();
    const sourceId = semanticId();
    const targetParentId = semanticId();
    const targetId = semanticId();
    const state = createAtomicReducerState({
      flightNonce: "flight-canary-success",
      request: {
        kind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceParentId,
        sourceId,
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetParentId,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        expectedSource: EVIDENCE,
        expectedTarget: { absent: true },
        evidenceDigest: HASH,
      },
      semanticIds: [sourceParentId, sourceId, targetParentId],
    });
    const native = reduceAtomicPublication(state, null);
    if (native.kind !== "effect") throw new Error("native effect missing");
    const observe = reduceAtomicPublication(state, {
      kind: "native_resolved",
      effectId: native.request.effectId,
      requestKind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "canary_publish",
      sourceObjectId: sourceId,
      sourceEvidence: EVIDENCE,
      rawCode: "success",
      nativePrecheckEvidenceDigest: HASH,
      evidenceDigest: HASH,
    });
    expect(observe).toMatchObject({
      kind: "effect",
      request: {
        kind: "observe_locations",
        requestKind: "native_no_replace",
        sourceId,
      },
    });
    if (observe.kind !== "effect") throw new Error("observe effect missing");
    const completed = reduceAtomicPublication(observe.state, {
      kind: "locations_observed",
      effectId: observe.request.effectId,
      requestKind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "canary_publish",
      sourceParentId,
      sourceLeaf: `proof-${OPERATION_ID}-0`,
      targetParentId,
      targetLeaf: `canary-${OPERATION_ID}-0`,
      requestedSourceObjectId: sourceId,
      sourceObjectId: null,
      targetObjectId: targetId,
      source: location("absent", null, null),
      target: location("match", targetId, EVIDENCE),
      evidenceDigest: HASH,
    });
    expect(completed).toMatchObject({
      kind: "terminal",
      result: { kind: "protocol_complete" },
      state: {
        admission: "open",
        nativeClassification: {
          outcome: "published",
          nativeCode: "success",
        },
      },
    });
  });

  test("recovers canary publication and private manifest cleanup", () => {
    const wrapperId = semanticId();
    const privateSourceId = semanticId();
    const publicParentId = semanticId();
    const publishedId = semanticId();
    const deletionId = semanticId();
    const wrapperEvidence = evidence({ ino: "10" });
    const publicParentEvidence = evidence({ ino: "11" });
    const sourceEvidence = evidence({ ino: "12" });
    const planned = plannedCanaryProof(
      wrapperEvidence,
      publicParentEvidence,
      sourceEvidence,
    );
    expect(() =>
      createAtomicCanaryReducerState({
        flightNonce: "flight-canary-duplicate",
        action: "prove_mount",
        proof: planned,
        unresolvedForTargetParent: [planned, planned],
        sourceParentId: wrapperId,
        sourceParentRole: "wrapper",
        sourceParentEvidence: wrapperEvidence,
        sourceId: privateSourceId,
        targetParentId: publicParentId,
        targetParentRole: "profiles_parent",
        targetParentEvidence: publicParentEvidence,
        cleanupManifest: null,
      }),
    ).toThrow(/invalid atomic canary recovery input/u);

    let current = emittedEffect(
      reduceAtomicPublication(
        createAtomicCanaryReducerState({
          flightNonce: "flight-canary-mount",
          action: "prove_mount",
          proof: planned,
          unresolvedForTargetParent: [],
          sourceParentId: wrapperId,
          sourceParentRole: "wrapper",
          sourceParentEvidence: wrapperEvidence,
          sourceId: privateSourceId,
          targetParentId: publicParentId,
          targetParentRole: "profiles_parent",
          targetParentEvidence: publicParentEvidence,
          cleanupManifest: null,
        }),
        null,
      ),
    );
    expect(current.request).toMatchObject({
      kind: "persist_canary_phase",
      previousPhase: null,
      proof: { phase: "planned" },
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "effect_completed",
        effectId: current.request.effectId,
        requestKind: "persist_canary_phase",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    );
    expect(current.request).toMatchObject({
      kind: "revalidate_handle",
      objectId: wrapperId,
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "effect_completed",
        effectId: current.request.effectId,
        requestKind: "revalidate_handle",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    );
    expect(current.request).toMatchObject({
      kind: "revalidate_handle",
      objectId: publicParentId,
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "effect_completed",
        effectId: current.request.effectId,
        requestKind: "revalidate_handle",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    );
    expect(current.request).toMatchObject({
      kind: "statfs_parent",
      objectId: wrapperId,
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "statfs_observed",
        effectId: current.request.effectId,
        objectId: wrapperId,
        filesystem: "overlay",
        magic: "0x794c7630",
        device: "1",
        evidenceDigest: HASH,
      }),
    );
    expect(current.request).toMatchObject({
      kind: "statfs_parent",
      objectId: publicParentId,
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "statfs_observed",
        effectId: current.request.effectId,
        objectId: publicParentId,
        filesystem: "overlay",
        magic: "0x794c7630",
        device: "1",
        evidenceDigest: HASH,
      }),
    );
    expect(current.request).toMatchObject({
      kind: "native_no_replace",
      move: "canary_publish",
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "native_resolved",
        effectId: current.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceObjectId: privateSourceId,
        sourceEvidence,
        rawCode: "success",
        nativePrecheckEvidenceDigest: HASH,
        evidenceDigest: HASH,
      }),
    );
    expect(current.request).toMatchObject({ kind: "observe_locations" });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "locations_observed",
        effectId: current.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceParentId: wrapperId,
        sourceLeaf: planned.sourceLeaf,
        targetParentId: publicParentId,
        targetLeaf: planned.targetLeaf,
        requestedSourceObjectId: privateSourceId,
        sourceObjectId: null,
        targetObjectId: publishedId,
        source: location("absent", null, null),
        target: location("match", publishedId, sourceEvidence),
        evidenceDigest: HASH,
      }),
    );
    expect(current.request).toMatchObject({
      kind: "fsync_directory",
      objectId: wrapperId,
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "effect_completed",
        effectId: current.request.effectId,
        requestKind: "fsync_directory",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    );
    expect(current.request).toMatchObject({
      kind: "fsync_directory",
      objectId: publicParentId,
    });
    const mounted = reduceAtomicPublication(current.state, {
      kind: "effect_completed",
      effectId: current.request.effectId,
      requestKind: "fsync_directory",
      evidenceDigest: HASH,
      count: 1,
      byteSize: 0,
    });
    if (mounted.kind !== "effect") {
      throw new Error("published canary persistence was not requested");
    }
    expect(mounted.request).toMatchObject({
      kind: "persist_canary_phase",
      previousPhase: "planned",
      proof: { phase: "published" },
    });
    const persistedMount = reduceAtomicPublication(mounted.state, {
      kind: "effect_completed",
      effectId: mounted.request.effectId,
      requestKind: "persist_canary_phase",
      evidenceDigest: HASH,
      count: 1,
      byteSize: 0,
    });
    expect(persistedMount).toMatchObject({
      kind: "terminal",
      result: {
        kind: "mount_proved",
        proof: {
          phase: "published",
          publishedEvidence: sourceEvidence,
          sourceParentSynced: true,
          targetParentSynced: true,
        },
      },
    });
    if (
      persistedMount.kind !== "terminal" ||
      persistedMount.result.kind !== "mount_proved"
    ) {
      throw new Error("mount proof was not completed");
    }
    const published = persistedMount.result.proof;

    current = emittedEffect(
      reduceAtomicPublication(
        createAtomicCanaryReducerState({
          flightNonce: "flight-canary-published-replay",
          action: "prove_mount",
          proof: published,
          unresolvedForTargetParent: [published],
          sourceParentId: wrapperId,
          sourceParentRole: "wrapper",
          sourceParentEvidence: wrapperEvidence,
          sourceId: privateSourceId,
          targetParentId: publicParentId,
          targetParentRole: "profiles_parent",
          targetParentEvidence: publicParentEvidence,
          cleanupManifest: null,
        }),
        null,
      ),
    );
    for (const requestKind of [
      "revalidate_handle",
      "revalidate_handle",
    ] as const) {
      current = emittedEffect(
        reduceAtomicPublication(current.state, {
          kind: "effect_completed",
          effectId: current.request.effectId,
          requestKind,
          evidenceDigest: HASH,
          count: 1,
          byteSize: 0,
        }),
      );
    }
    for (const objectId of [wrapperId, publicParentId] as const) {
      current = emittedEffect(
        reduceAtomicPublication(current.state, {
          kind: "statfs_observed",
          effectId: current.request.effectId,
          objectId,
          filesystem: "overlay",
          magic: "0x794c7630",
          device: "1",
          evidenceDigest: HASH,
        }),
      );
    }
    expect(current.request).toMatchObject({
      kind: "observe_locations",
      move: "canary_publish",
    });
    const replayedMount = reduceAtomicPublication(current.state, {
      kind: "locations_observed",
      effectId: current.request.effectId,
      requestKind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "canary_publish",
      sourceParentId: wrapperId,
      sourceLeaf: planned.sourceLeaf,
      targetParentId: publicParentId,
      targetLeaf: planned.targetLeaf,
      requestedSourceObjectId: privateSourceId,
      sourceObjectId: null,
      targetObjectId: publishedId,
      source: location("absent", null, null),
      target: location("match", publishedId, sourceEvidence),
      evidenceDigest: HASH,
    });
    expect(replayedMount).toMatchObject({
      kind: "terminal",
      result: {
        kind: "mount_proved",
        proof: {
          classification: {
            nativeCode: "success",
          },
        },
      },
      state: {
        nativeClassification: {
          nativeCode: "atomic_publish_replay_completed",
        },
      },
    });
    if (
      replayedMount.kind !== "terminal" ||
      replayedMount.result.kind !== "mount_proved"
    ) {
      throw new Error("published replay was not completed");
    }
    expect(replayedMount.result.proof).toBe(published);

    current = emittedEffect(
      reduceAtomicPublication(
        createAtomicCanaryReducerState({
          flightNonce: "flight-canary-published-regression",
          action: "prove_mount",
          proof: published,
          unresolvedForTargetParent: [published],
          sourceParentId: wrapperId,
          sourceParentRole: "wrapper",
          sourceParentEvidence: wrapperEvidence,
          sourceId: privateSourceId,
          targetParentId: publicParentId,
          targetParentRole: "profiles_parent",
          targetParentEvidence: publicParentEvidence,
          cleanupManifest: null,
        }),
        null,
      ),
    );
    for (const requestKind of [
      "revalidate_handle",
      "revalidate_handle",
    ] as const) {
      current = emittedEffect(
        reduceAtomicPublication(current.state, {
          kind: "effect_completed",
          effectId: current.request.effectId,
          requestKind,
          evidenceDigest: HASH,
          count: 1,
          byteSize: 0,
        }),
      );
    }
    for (const objectId of [wrapperId, publicParentId] as const) {
      current = emittedEffect(
        reduceAtomicPublication(current.state, {
          kind: "statfs_observed",
          effectId: current.request.effectId,
          objectId,
          filesystem: "overlay",
          magic: "0x794c7630",
          device: "1",
          evidenceDigest: HASH,
        }),
      );
    }
    const regressionClose = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "locations_observed",
        effectId: current.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceParentId: wrapperId,
        sourceLeaf: planned.sourceLeaf,
        targetParentId: publicParentId,
        targetLeaf: planned.targetLeaf,
        requestedSourceObjectId: privateSourceId,
        sourceObjectId: privateSourceId,
        targetObjectId: null,
        source: location("match", privateSourceId, sourceEvidence),
        target: location("absent", null, null),
        evidenceDigest: HASH,
      }),
    );
    expect(regressionClose.request).toMatchObject({
      kind: "close_admission",
      reason: "binding_invalid",
    });
    expect(
      reduceAtomicPublication(regressionClose.state, {
        kind: "effect_completed",
        effectId: regressionClose.request.effectId,
        requestKind: "close_admission",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "native_binding_invalid" },
      state: { admission: "closed" },
    });

    current = emittedEffect(
      reduceAtomicPublication(
        createAtomicCanaryReducerState({
          flightNonce: "flight-canary-cleanup",
          action: "cleanup",
          proof: published,
          unresolvedForTargetParent: [published],
          sourceParentId: publicParentId,
          sourceParentRole: "profiles_parent",
          sourceParentEvidence: publicParentEvidence,
          sourceId: publishedId,
          targetParentId: wrapperId,
          targetParentRole: "wrapper",
          targetParentEvidence: wrapperEvidence,
          cleanupManifest: {
            sha256: HASH,
            entryCount: 1,
            nextIndex: 0,
          },
        }),
        null,
      ),
    );
    expect(current.request).toMatchObject({
      kind: "persist_canary_phase",
      previousPhase: "published",
      proof: { phase: "deleting" },
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "effect_completed",
        effectId: current.request.effectId,
        requestKind: "persist_canary_phase",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    );
    for (const [objectId, requestKind] of [
      [publicParentId, "revalidate_handle"],
      [wrapperId, "revalidate_handle"],
    ] as const) {
      expect(current.request).toMatchObject({ kind: requestKind, objectId });
      current = emittedEffect(
        reduceAtomicPublication(current.state, {
          kind: "effect_completed",
          effectId: current.request.effectId,
          requestKind,
          evidenceDigest: HASH,
          count: 1,
          byteSize: 0,
        }),
      );
    }
    for (const objectId of [publicParentId, wrapperId] as const) {
      expect(current.request).toMatchObject({
        kind: "statfs_parent",
        objectId,
      });
      current = emittedEffect(
        reduceAtomicPublication(current.state, {
          kind: "statfs_observed",
          effectId: current.request.effectId,
          objectId,
          filesystem: "overlay",
          magic: "0x794c7630",
          device: "1",
          evidenceDigest: HASH,
        }),
      );
    }
    expect(current.request).toMatchObject({
      kind: "native_no_replace",
      move: "canary_source_to_private",
    });
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "native_resolved",
        effectId: current.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_source_to_private",
        sourceObjectId: publishedId,
        sourceEvidence,
        rawCode: "success",
        nativePrecheckEvidenceDigest: HASH,
        evidenceDigest: HASH,
      }),
    );
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "locations_observed",
        effectId: current.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_source_to_private",
        sourceParentId: publicParentId,
        sourceLeaf: planned.targetLeaf,
        targetParentId: wrapperId,
        targetLeaf: planned.deletionLeaf,
        requestedSourceObjectId: publishedId,
        sourceObjectId: null,
        targetObjectId: deletionId,
        source: location("absent", null, null),
        target: location("match", deletionId, sourceEvidence),
        evidenceDigest: HASH,
      }),
    );
    for (const objectId of [publicParentId, wrapperId] as const) {
      expect(current.request).toMatchObject({
        kind: "fsync_directory",
        objectId,
      });
      const next = reduceAtomicPublication(current.state, {
        kind: "effect_completed",
        effectId: current.request.effectId,
        requestKind: "fsync_directory",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      });
      if (objectId === publicParentId) current = emittedEffect(next);
      else {
        const persisted = emittedEffect(next);
        expect(persisted.request).toMatchObject({
          kind: "persist_canary_phase",
          previousPhase: "deleting",
          proof: { phase: "deleting" },
        });
        const completedCleanup = reduceAtomicPublication(persisted.state, {
          kind: "effect_completed",
          effectId: persisted.request.effectId,
          requestKind: "persist_canary_phase",
          evidenceDigest: HASH,
          count: 1,
          byteSize: 0,
        });
        expect(completedCleanup).toMatchObject({
          kind: "terminal",
          result: {
            kind: "cleanup_pending",
            proof: {
              phase: "deleting",
              manifestSha256: HASH,
              cleanupNextIndex: 0,
              cleanupEntryCount: 1,
              privateDeletionEvidence: sourceEvidence,
            },
          },
        });
        if (
          completedCleanup.kind !== "terminal" ||
          completedCleanup.result.kind !== "cleanup_pending"
        ) {
          throw new Error("canary cleanup was not authorized");
        }
        expect(() =>
          advanceAtomicCanaryCleanup(completedCleanup.result.proof, {
            operationId: OPERATION_ID,
            manifestSha256: HASH,
            completedIndex: 0,
            nextIndex: 2,
            privateDeletionAbsent: true,
            sourceParentSynced: true,
            targetParentSynced: true,
            evidenceDigest: HASH,
          }),
        ).toThrow(/invalid atomic canary cleanup progress/u);
        const cleaned = advanceAtomicCanaryCleanup(
          completedCleanup.result.proof,
          {
          operationId: OPERATION_ID,
          manifestSha256: HASH,
          completedIndex: 0,
          nextIndex: 1,
          privateDeletionAbsent: true,
          sourceParentSynced: true,
          targetParentSynced: true,
          evidenceDigest: HASH,
          },
        );
        expect(cleaned).toMatchObject({
          phase: "cleaned",
          cleanupNextIndex: 1,
        });
        expect(() =>
          createAtomicCanaryReducerState({
            flightNonce: "flight-canary-cleaned-reuse",
            action: "prove_mount",
            proof: cleaned,
            unresolvedForTargetParent: [],
            sourceParentId: wrapperId,
            sourceParentRole: "wrapper",
            sourceParentEvidence: wrapperEvidence,
            sourceId: privateSourceId,
            targetParentId: publicParentId,
            targetParentRole: "profiles_parent",
            targetParentEvidence: publicParentEvidence,
            cleanupManifest: null,
          }),
        ).toThrow(/invalid atomic canary recovery input/u);
      }
    }
  });

  test("closes admission when canary parent devices differ", () => {
    const wrapperId = semanticId();
    const sourceId = semanticId();
    const targetParentId = semanticId();
    const wrapperEvidence = evidence({ ino: "20" });
    const targetParentEvidence = evidence({ dev: "2", ino: "21" });
    const sourceEvidence = evidence({ ino: "22" });
    const proof = plannedCanaryProof(
      wrapperEvidence,
      targetParentEvidence,
      sourceEvidence,
    );
    let current = emittedEffect(
      reduceAtomicPublication(
        createAtomicCanaryReducerState({
          flightNonce: "flight-canary-cross-device",
          action: "prove_mount",
          proof,
          unresolvedForTargetParent: [proof],
          sourceParentId: wrapperId,
          sourceParentRole: "wrapper",
          sourceParentEvidence: wrapperEvidence,
          sourceId,
          targetParentId,
          targetParentRole: "profiles_parent",
          targetParentEvidence,
          cleanupManifest: null,
        }),
        null,
      ),
    );
    for (const requestKind of [
      "revalidate_handle",
      "revalidate_handle",
    ] as const) {
      current = emittedEffect(
        reduceAtomicPublication(current.state, {
          kind: "effect_completed",
          effectId: current.request.effectId,
          requestKind,
          evidenceDigest: HASH,
          count: 1,
          byteSize: 0,
        }),
      );
    }
    current = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "statfs_observed",
        effectId: current.request.effectId,
        objectId: wrapperId,
        filesystem: "overlay",
        magic: "0x794c7630",
        device: "1",
        evidenceDigest: HASH,
      }),
    );
    const close = emittedEffect(
      reduceAtomicPublication(current.state, {
        kind: "statfs_observed",
        effectId: current.request.effectId,
        objectId: targetParentId,
        filesystem: "overlay",
        magic: "0x794c7630",
        device: "2",
        evidenceDigest: HASH,
      }),
    );
    expect(close.request).toMatchObject({
      kind: "close_admission",
      reason: "cross_device",
    });
    expect(
      reduceAtomicPublication(close.state, {
        kind: "effect_completed",
        effectId: close.request.effectId,
        requestKind: "close_admission",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "native_cross_device" },
      state: { admission: "closed" },
    });
  });

  test("rejects invalid durable canary phase, identity, and cursor tuples", () => {
    const wrapperId = semanticId();
    const sourceId = semanticId();
    const targetParentId = semanticId();
    const wrapperEvidence = evidence({ ino: "30" });
    const targetParentEvidence = evidence({ ino: "31" });
    const sourceEvidence = evidence({ ino: "32" });
    const planned = plannedCanaryProof(
      wrapperEvidence,
      targetParentEvidence,
      sourceEvidence,
    );
    const baseInput = {
      flightNonce: "flight-invalid-durable-canary",
      action: "prove_mount" as const,
      unresolvedForTargetParent: [] as ReadonlyArray<AtomicCanaryProofV1>,
      sourceParentId: wrapperId,
      sourceParentRole: "wrapper" as const,
      sourceParentEvidence: wrapperEvidence,
      sourceId,
      targetParentId,
      targetParentRole: "profiles_parent" as const,
      targetParentEvidence,
      cleanupManifest: null,
    };
    for (const proof of [
      { ...planned, attempt: 1 },
      { ...planned, sourceLeaf: `proof-${OPERATION_ID}-1` },
      { ...planned, phase: "published" },
    ] as unknown as AtomicCanaryProofV1[]) {
      expect(() =>
        createAtomicCanaryReducerState({ ...baseInput, proof }),
      ).toThrow(/invalid atomic canary recovery input/u);
    }
    expect(() =>
      createAtomicCanaryReducerState({
        ...baseInput,
        proof: planned,
        sourceParentEvidence: evidence({ ino: "33" }),
      }),
    ).toThrow(/invalid atomic canary mount proof input/u);
    expect(() =>
      createAtomicCanaryReducerState({
        ...baseInput,
        proof: planned,
        targetParentEvidence: evidence({ ino: "34" }),
      }),
    ).toThrow(/invalid atomic canary mount proof input/u);

    const classification = Object.freeze({
      outcome: "published" as const,
      nativeCode: "success" as const,
      sourceMatches: false,
      targetMatches: true,
      targetOther: false,
      nativePrecheckEvidenceDigest: HASH,
      locationEvidenceDigest: HASH,
    });
    const deleting: AtomicCanaryProofV1 = Object.freeze({
      ...planned,
      phase: "deleting",
      publishedEvidence: sourceEvidence,
      privateDeletionEvidence: null,
      classification,
      manifestSha256: HASH,
      cleanupNextIndex: 0,
      cleanupEntryCount: 2,
    });
    for (const proof of [
      {
        ...deleting,
        classification: {
          ...classification,
          sourceMatches: true,
        },
      },
      {
        ...deleting,
        publishedEvidence: evidence({ ino: "36" }),
      },
      {
        ...deleting,
        privateDeletionEvidence: sourceEvidence,
      },
      {
        ...deleting,
        sourceParentSynced: true,
        targetParentSynced: false,
      },
    ] as AtomicCanaryProofV1[]) {
      expect(isAtomicCanaryProofV1(proof)).toBe(false);
    }
    expect(() =>
      createAtomicCanaryReducerState({
        flightNonce: "flight-invalid-cleanup-cursor",
        action: "cleanup",
        proof: deleting,
        unresolvedForTargetParent: [deleting],
        sourceParentId: targetParentId,
        sourceParentRole: "profiles_parent",
        sourceParentEvidence: targetParentEvidence,
        sourceId,
        targetParentId: wrapperId,
        targetParentRole: "wrapper",
        targetParentEvidence: wrapperEvidence,
        cleanupManifest: {
          sha256: HASH,
          entryCount: 2,
          nextIndex: 1,
        },
      }),
    ).toThrow(/atomic canary cleanup cursor changed/u);
    expect(() =>
      createAtomicCanaryReducerState({
        flightNonce: "flight-invalid-deletion-identity",
        action: "cleanup",
        proof: {
          ...deleting,
          privateDeletionEvidence: evidence({ ino: "35" }),
          sourceParentSynced: true,
          targetParentSynced: true,
        },
        unresolvedForTargetParent: [],
        sourceParentId: targetParentId,
        sourceParentRole: "profiles_parent",
        sourceParentEvidence: targetParentEvidence,
        sourceId,
        targetParentId: wrapperId,
        targetParentRole: "wrapper",
        targetParentEvidence: wrapperEvidence,
        cleanupManifest: {
          sha256: HASH,
          entryCount: 2,
          nextIndex: 0,
        },
      }),
    ).toThrow(/invalid atomic canary/u);
  });

  test("normalizes only exact attempt-zero canary source-missing replay", () => {
    const sourceParentId = semanticId();
    const sourceId = semanticId();
    const targetParentId = semanticId();
    const targetId = semanticId();
    const request: AtomicEffectRequestDraftV1 = {
      kind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "canary_publish",
      sourceParentId,
      sourceId,
      sourceLeaf: `proof-${OPERATION_ID}-0`,
      targetParentId,
      targetLeaf: `canary-${OPERATION_ID}-0`,
      expectedSource: EVIDENCE,
      expectedTarget: { absent: true },
      evidenceDigest: HASH,
    };
    const state = createAtomicReducerState({
      flightNonce: "flight-canary-replay",
      request,
      semanticIds: [sourceParentId, sourceId, targetParentId],
      canaryReplayAuthority: {
        operationId: OPERATION_ID,
        attempt: 0,
        phase: "planned",
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        deletionLeaf: `deletion-${OPERATION_ID}-0`,
        privateSourceEvidence: EVIDENCE,
        publishedEvidence: null,
        privateDeletionEvidence: null,
        manifestSha256: null,
        cleanupNextIndex: 0,
        cleanupEntryCount: 0,
      },
    });
    const native = reduceAtomicPublication(state, null);
    if (native.kind !== "effect") throw new Error("native effect missing");
    const observe = reduceAtomicPublication(state, {
      kind: "native_resolved",
      effectId: native.request.effectId,
      requestKind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "canary_publish",
      sourceObjectId: sourceId,
      sourceEvidence: EVIDENCE,
      rawCode: "atomic_publish_source_missing",
      nativePrecheckEvidenceDigest: HASH,
      evidenceDigest: HASH,
    });
    if (observe.kind !== "effect") throw new Error("observe effect missing");
    const completed = reduceAtomicPublication(observe.state, {
      kind: "locations_observed",
      effectId: observe.request.effectId,
      requestKind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "canary_publish",
      sourceParentId,
      sourceLeaf: `proof-${OPERATION_ID}-0`,
      targetParentId,
      targetLeaf: `canary-${OPERATION_ID}-0`,
      requestedSourceObjectId: sourceId,
      sourceObjectId: null,
      targetObjectId: targetId,
      source: location("absent", null, null),
      target: location("match", targetId, EVIDENCE),
      evidenceDigest: HASH,
    });
    expect(completed).toMatchObject({
      kind: "terminal",
      result: { kind: "protocol_complete" },
      state: {
        admission: "open",
        nativeClassification: {
          nativeCode: "atomic_publish_replay_completed",
        },
      },
    });
    expect(() =>
      createAtomicReducerState({
        flightNonce: "flight-canary-wrong-attempt",
        request: { ...request, sourceLeaf: `proof-${OPERATION_ID}-1` },
        semanticIds: [sourceParentId, sourceId, targetParentId],
      }),
    ).toThrow(/invalid atomic effect request/u);
  });

  test("closes admission for an exact no-replace canary conflict", () => {
    const sourceParentId = semanticId();
    const sourceId = semanticId();
    const targetParentId = semanticId();
    const targetId = semanticId();
    const state = createAtomicReducerState({
      flightNonce: "flight-canary-conflict",
      request: {
        kind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceParentId,
        sourceId,
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetParentId,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        expectedSource: EVIDENCE,
        expectedTarget: { absent: true },
        evidenceDigest: HASH,
      },
      semanticIds: [sourceParentId, sourceId, targetParentId],
    });
    const native = emittedEffect(reduceAtomicPublication(state, null));
    const observe = emittedEffect(
      reduceAtomicPublication(native.state, {
        kind: "native_resolved",
        effectId: native.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceObjectId: sourceId,
        sourceEvidence: EVIDENCE,
        rawCode: "atomic_publish_exists",
        nativePrecheckEvidenceDigest: HASH,
        evidenceDigest: HASH,
      }),
    );
    const close = emittedEffect(
      reduceAtomicPublication(observe.state, {
        kind: "locations_observed",
        effectId: observe.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceParentId,
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetParentId,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        requestedSourceObjectId: sourceId,
        sourceObjectId: sourceId,
        targetObjectId: targetId,
        source: location("match", sourceId, EVIDENCE),
        target: location("other", targetId, evidence({ ino: "99" })),
        evidenceDigest: HASH,
      }),
    );
    expect(close.request).toMatchObject({
      kind: "close_admission",
      reason: "binding_invalid",
    });
    expect(
      reduceAtomicPublication(close.state, {
        kind: "effect_completed",
        effectId: close.request.effectId,
        requestKind: "close_admission",
        evidenceDigest: HASH,
        count: 1,
        byteSize: 0,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "native_binding_invalid" },
      state: { admission: "closed" },
    });
  });

  test.each(["planned", "published"] as const)(
    "closes cleanup source-missing replay in %s phase",
    phase => {
      const sourceParentId = semanticId();
      const sourceId = semanticId();
      const targetParentId = semanticId();
      const targetId = semanticId();
      const state = createAtomicReducerState({
        flightNonce: `flight-cleanup-replay-${phase}`,
        request: {
          kind: "native_no_replace",
          operationId: OPERATION_ID,
          move: "canary_source_to_private",
          sourceParentId,
          sourceId,
          sourceLeaf: `canary-${OPERATION_ID}-0`,
          targetParentId,
          targetLeaf: `deletion-${OPERATION_ID}-0`,
          expectedSource: EVIDENCE,
          expectedTarget: { absent: true },
          evidenceDigest: HASH,
        },
        semanticIds: [sourceParentId, sourceId, targetParentId],
        canaryReplayAuthority: {
          operationId: OPERATION_ID,
          attempt: 0,
          phase,
          sourceLeaf: `proof-${OPERATION_ID}-0`,
          targetLeaf: `canary-${OPERATION_ID}-0`,
          deletionLeaf: `deletion-${OPERATION_ID}-0`,
          privateSourceEvidence: EVIDENCE,
          publishedEvidence: phase === "published" ? EVIDENCE : null,
          privateDeletionEvidence: null,
          manifestSha256: null,
          cleanupNextIndex: 0,
          cleanupEntryCount: 0,
        },
      });
      const native = emittedEffect(reduceAtomicPublication(state, null));
      const observe = emittedEffect(
        reduceAtomicPublication(native.state, {
          kind: "native_resolved",
          effectId: native.request.effectId,
          requestKind: "native_no_replace",
          operationId: OPERATION_ID,
          move: "canary_source_to_private",
          sourceObjectId: sourceId,
          sourceEvidence: EVIDENCE,
          rawCode: "atomic_publish_source_missing",
          nativePrecheckEvidenceDigest: HASH,
          evidenceDigest: HASH,
        }),
      );
      const close = emittedEffect(
        reduceAtomicPublication(observe.state, {
          kind: "locations_observed",
          effectId: observe.request.effectId,
          requestKind: "native_no_replace",
          operationId: OPERATION_ID,
          move: "canary_source_to_private",
          sourceParentId,
          sourceLeaf: `canary-${OPERATION_ID}-0`,
          targetParentId,
          targetLeaf: `deletion-${OPERATION_ID}-0`,
          requestedSourceObjectId: sourceId,
          sourceObjectId: null,
          targetObjectId: targetId,
          source: location("absent", null, null),
          target: location("match", targetId, EVIDENCE),
          evidenceDigest: HASH,
        }),
      );
      expect(close.request).toMatchObject({
        kind: "close_admission",
        reason: "binding_invalid",
      });
      expect(
        reduceAtomicPublication(close.state, {
          kind: "effect_completed",
          effectId: close.request.effectId,
          requestKind: "close_admission",
          evidenceDigest: HASH,
          count: 1,
          byteSize: 0,
        }),
      ).toMatchObject({
        kind: "terminal",
        result: { kind: "fail_stop", code: "native_binding_invalid" },
        state: { admission: "closed" },
      });
    },
  );

  test("observes noncanary source-missing before closing admission", () => {
    const sourceParentId = semanticId();
    const sourceId = semanticId();
    const targetParentId = semanticId();
    const state = createAtomicReducerState({
      flightNonce: "flight-profile-source-missing",
      request: {
        kind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "profile_publish",
        sourceParentId,
        sourceId,
        sourceLeaf: "payload",
        targetParentId,
        targetLeaf: OPERATION_ID,
        expectedSource: EVIDENCE,
        expectedTarget: { absent: true },
        evidenceDigest: HASH,
      },
      semanticIds: [sourceParentId, sourceId, targetParentId],
    });
    const native = reduceAtomicPublication(state, null);
    if (native.kind !== "effect") throw new Error("native effect missing");
    const observe = reduceAtomicPublication(state, {
      kind: "native_resolved",
      effectId: native.request.effectId,
      requestKind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "profile_publish",
      sourceObjectId: sourceId,
      sourceEvidence: EVIDENCE,
      rawCode: "atomic_publish_source_missing",
      nativePrecheckEvidenceDigest: HASH,
      evidenceDigest: HASH,
    });
    if (observe.kind !== "effect") throw new Error("observe effect missing");
    const close = reduceAtomicPublication(observe.state, {
      kind: "locations_observed",
      effectId: observe.request.effectId,
      requestKind: "native_no_replace",
      operationId: OPERATION_ID,
      move: "profile_publish",
      sourceParentId,
      sourceLeaf: "payload",
      targetParentId,
      targetLeaf: OPERATION_ID,
      requestedSourceObjectId: sourceId,
      sourceObjectId: null,
      targetObjectId: null,
      source: location("absent", null, null),
      target: location("absent", null, null),
      evidenceDigest: HASH,
    });
    expect(close).toMatchObject({
      kind: "effect",
      request: {
        kind: "close_admission",
        reason: "binding_invalid",
      },
    });
    if (close.kind !== "effect") throw new Error("close effect missing");
    const terminal = reduceAtomicPublication(close.state, {
      kind: "effect_completed",
      effectId: close.request.effectId,
      requestKind: "close_admission",
      evidenceDigest: HASH,
      count: 1,
      byteSize: 0,
    });
    expect(terminal).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "native_binding_invalid" },
      state: { admission: "closed" },
    });
  });

  test.each(
    (["absent", "match", "other"] as const).flatMap(sourceState =>
      (["absent", "match", "other"] as const)
        .filter(
          targetState =>
            !(sourceState === "absent" && targetState === "match"),
        )
        .map(targetState => [sourceState, targetState] as const),
    ),
  )(
    "closes admission for success with %s source and %s target",
    (sourceState, targetState) => {
      const sourceParentId = semanticId();
      const sourceId = semanticId();
      const targetParentId = semanticId();
      const sourceOtherId = semanticId();
      const targetId = semanticId();
      const otherEvidence = evidence({ ino: "3" });
      const state = createAtomicReducerState({
        flightNonce: `flight-invalid-locations-${sourceState}-${targetState}`,
        request: {
          kind: "native_no_replace",
          operationId: OPERATION_ID,
          move: "canary_publish",
          sourceParentId,
          sourceId,
          sourceLeaf: `proof-${OPERATION_ID}-0`,
          targetParentId,
          targetLeaf: `canary-${OPERATION_ID}-0`,
          expectedSource: EVIDENCE,
          expectedTarget: { absent: true },
          evidenceDigest: HASH,
        },
        semanticIds: [sourceParentId, sourceId, targetParentId],
      });
      const native = reduceAtomicPublication(state, null);
      if (native.kind !== "effect") throw new Error("native effect missing");
      const observe = reduceAtomicPublication(state, {
        kind: "native_resolved",
        effectId: native.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceObjectId: sourceId,
        sourceEvidence: EVIDENCE,
        rawCode: "success",
        nativePrecheckEvidenceDigest: HASH,
        evidenceDigest: HASH,
      });
      if (observe.kind !== "effect") throw new Error("observe effect missing");
      const sourceObjectId =
        sourceState === "absent"
          ? null
          : sourceState === "match"
            ? sourceId
            : sourceOtherId;
      const targetObjectId =
        targetState === "absent" ? null : targetId;
      const close = reduceAtomicPublication(observe.state, {
        kind: "locations_observed",
        effectId: observe.request.effectId,
        requestKind: "native_no_replace",
        operationId: OPERATION_ID,
        move: "canary_publish",
        sourceParentId,
        sourceLeaf: `proof-${OPERATION_ID}-0`,
        targetParentId,
        targetLeaf: `canary-${OPERATION_ID}-0`,
        requestedSourceObjectId: sourceId,
        sourceObjectId,
        targetObjectId,
        source: location(
          sourceState,
          sourceObjectId,
          sourceState === "absent"
            ? null
            : sourceState === "match"
              ? EVIDENCE
              : otherEvidence,
        ),
        target: location(
          targetState,
          targetObjectId,
          targetState === "absent"
            ? null
            : targetState === "match"
              ? EVIDENCE
              : otherEvidence,
        ),
        evidenceDigest: HASH,
      });
      expect(close).toMatchObject({
        kind: "effect",
        request: { kind: "close_admission", reason: "ambiguous" },
      });
    },
  );

  test("accepts exact observation maxima and rejects maxima plus one", () => {
    const fileId = semanticId();
    const bytes = Buffer.alloc(ATOMIC_MAX_OBSERVATION_BYTES, 7);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const state = createAtomicReducerState({
      flightNonce: "flight-file-exact-max",
      request: {
        kind: "read_file_chunk",
        operationId: OPERATION_ID,
        role: "payload_entry",
        objectId: fileId,
        cursor: 0,
        byteLength: ATOMIC_MAX_OBSERVATION_BYTES,
        expected: evidence({
          mode: 384,
          size: ATOMIC_MAX_OBSERVATION_BYTES,
        }),
      },
      semanticIds: [fileId],
      reservations: { fileBytes: ATOMIC_MAX_OBSERVATION_BYTES },
    });
    const effect = reduceAtomicPublication(state, null);
    if (effect.kind !== "effect") throw new Error("effect was not emitted");
    expect(
      reduceAtomicPublication(state, {
        kind: "file_chunk_observed",
        effectId: effect.request.effectId,
        cursor: 0,
        byteSize: bytes.byteLength,
        bytesBase64: bytes.toString("base64"),
        contentDigest: digest,
        eof: true,
        evidenceDigest: HASH,
      }),
    ).toMatchObject({
      kind: "terminal",
      result: { kind: "protocol_complete" },
    });
  });

  test("enforces the combined semantic and partial ID caps", () => {
    expect(() =>
      createAtomicReducerState({
        flightNonce: "flight-cap",
        request: reserveDraft(),
        semanticIdCount:
          ATOMIC_MAX_TRACKED_IDS - ATOMIC_MAX_PARTIAL_CREATE_IDS,
        partialCreateIdCount: ATOMIC_MAX_PARTIAL_CREATE_IDS + 1,
      }),
    ).toThrow(/cap/u);
    expect(() =>
      createAtomicReducerState({
        flightNonce: "flight-combined-cap",
        request: reserveDraft(),
        semanticIdCount: ATOMIC_MAX_TRACKED_IDS,
        partialCreateIdCount: 1,
      }),
    ).toThrow(/cap/u);
  });

  test("keeps the reducer free of authority and filesystem imports", async () => {
    const source = await readFile(
      new URL("./atomic-directory-publication.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:reconciliation|startup-state|profile-store|session-registry|node:fs|atomic-directory-publication-native)[^"']*["']/u,
    );
    expect(source).not.toMatch(
      /AnchoredRoot|BoundGeneration|PreReadyRecoveryAuthority|WeakMap|FileHandle|proc\/self\/fd|renameNoReplace/u,
    );
  });
});
