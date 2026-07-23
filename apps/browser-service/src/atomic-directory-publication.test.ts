import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  ATOMIC_MAX_DIRECTORY_ENTRIES,
  ATOMIC_MAX_OBSERVATION_BYTES,
  ATOMIC_MAX_PARTIAL_CREATE_IDS,
  ATOMIC_MAX_TRACKED_IDS,
  createAtomicReducerState,
  isAtomicControlLeafV1,
  isAtomicPayloadLeafV1,
  reduceAtomicPublication,
  type AtomicEffectObservationV1,
  type AtomicEffectRequestDraftV1,
  type AtomicObjectEvidenceV1,
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

function reserveDraft(): AtomicEffectRequestDraftV1 {
  return {
    kind: "reserve_budget",
    operationId: OPERATION_ID,
    reservation: "payload_entries",
    count: 1,
    byteSize: 0,
  };
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
