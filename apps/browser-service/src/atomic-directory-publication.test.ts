import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  ATOMIC_MAX_DIRECTORY_ENTRIES,
  ATOMIC_MAX_ACTIVE_STABLE_INTENTS,
  ATOMIC_MAX_MANIFEST_BYTES,
  ATOMIC_MAX_METADATA_FILES,
  ATOMIC_MAX_OBSERVATION_BYTES,
  ATOMIC_MAX_PARTIAL_CREATE_IDS,
  ATOMIC_MAX_PAYLOAD_BYTES,
  ATOMIC_MAX_PAYLOAD_ENTRIES,
  ATOMIC_MAX_RECOVERY_RECORDS,
  ATOMIC_MAX_SCRATCH_ENTRIES,
  ATOMIC_MAX_TRACKED_IDS,
  assertAtomicProfileCopySchemaV1,
  assertAtomicProfileSchemaV1,
  advanceAtomicManifestPlannedRecovery,
  advanceAtomicCanaryCleanup,
  advanceAtomicProtectedCleanupEntry,
  advanceAtomicProtectedCleanupSuffix,
  advanceAtomicProtectedCleanupTerminal,
  beginAtomicProtectedCleanupEntry,
  beginAtomicProtectedCleanupTerminal,
  createAtomicCanaryReducerState,
  createAtomicManifestPlannedRecoveryState,
  createAtomicProtectedCleanupState,
  createAtomicReducerState,
  isAtomicCanaryProofV1,
  isAtomicControlLeafV1,
  isAtomicPayloadLeafV1,
  reduceAtomicPublication,
  reduceAtomicStartupRecoveryV1,
  validateAtomicInventoryBoundsV1,
  type AtomicEffectObservationV1,
  type AtomicEffectRequestDraftV1,
  type AtomicCanaryProofV1,
  type AtomicManifestPlannedBindingV1,
  type AtomicManifestPlannedRecoveryObservationV1,
  type AtomicObjectEvidenceV1,
  type AtomicProtectedCleanupEntryV1,
  type AtomicProtectedCleanupObservationV1,
  type AtomicProtectedCleanupTerminalObservationV1,
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

describe("startup recovery reducer", () => {
  const topology = {
    stableIntent: true,
    intentTemp: false,
    wrapper: true,
    privateSource: true,
    publicSource: false,
    publicTarget: "absent" as const,
    manifest: "absent" as const,
  };

  test.each(["allocated", "building", "aborting_prepublication"] as const)(
    "aborts %s with never-attempted classification",
    phase => {
      expect(
        reduceAtomicStartupRecoveryV1({
          kind: "working",
          phase,
          classification: null,
          authorizedByFreshSnapshot: false,
          topology,
        }),
      ).toEqual({
        kind: "abort_prepublication",
        classification: "never_attempted",
      });
    },
  );

  test.each([
    ["scaffold", true, "adopt"],
    ["prepare", true, "adopt"],
    ["finalize", true, "adopt"],
    ["working", true, "release_to_reconciliation"],
    ["finalize", false, "release_to_reconciliation"],
  ] as const)("resolves published %s authority", (kind, authorized, disposition) => {
    expect(
      reduceAtomicStartupRecoveryV1({
        kind,
        phase: "manifest_published",
        classification: "published",
        authorizedByFreshSnapshot: authorized,
        topology: {
          ...topology,
          publicTarget: "match",
          manifest: "stable",
        },
      }),
    ).toEqual({ kind: "recover_published", disposition });
  });

  test("recovers ready after native success from observed locations", () => {
    expect(
      reduceAtomicStartupRecoveryV1({
        kind: "prepare",
        phase: "ready",
        classification: null,
        authorizedByFreshSnapshot: true,
        topology: {
          ...topology,
          privateSource: false,
          publicTarget: "match",
        },
      }),
    ).toEqual({ kind: "recover_published", disposition: "adopt" });
  });

  test("fails closed for ambiguous and orphan topology", () => {
    expect(
      reduceAtomicStartupRecoveryV1({
        kind: "finalize",
        phase: "renamed",
        classification: "published",
        authorizedByFreshSnapshot: true,
        topology: { ...topology, publicTarget: "other" },
      }),
    ).toEqual({ kind: "fail_stop", reason: "ambiguous" });
    expect(
      reduceAtomicStartupRecoveryV1({
        kind: "working",
        phase: "building",
        classification: null,
        authorizedByFreshSnapshot: false,
        topology: { ...topology, stableIntent: false, intentTemp: true },
      }),
    ).toEqual({ kind: "fail_stop", reason: "orphan_temp" });
  });
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
  test("enforces every independent and aggregate inventory maximum", () => {
    const maximum = {
      activeStableIntents: ATOMIC_MAX_ACTIVE_STABLE_INTENTS,
      recoveryRecords: ATOMIC_MAX_RECOVERY_RECORDS,
      payloadEntries: ATOMIC_MAX_PAYLOAD_ENTRIES,
      payloadBytes: ATOMIC_MAX_PAYLOAD_BYTES,
      scratchEntries: ATOMIC_MAX_SCRATCH_ENTRIES,
      stableMetadataFiles: 3_072,
      scratchMetadataFiles: 1_024,
      stableManifestBytes: 100_663_296,
      scratchManifestBytes: 33_554_432,
      stableOtherMetadataBytes: 12_582_912,
      scratchOtherMetadataBytes: 4_194_304,
    };
    expect(validateAtomicInventoryBoundsV1(maximum)).toEqual(maximum);
    expect(
      maximum.payloadEntries +
        maximum.scratchEntries +
        maximum.stableMetadataFiles +
        maximum.scratchMetadataFiles,
    ).toBe(30_120);
    expect(
      maximum.stableMetadataFiles + maximum.scratchMetadataFiles,
    ).toBe(ATOMIC_MAX_METADATA_FILES);
    expect(
      maximum.stableManifestBytes + maximum.scratchManifestBytes,
    ).toBe(ATOMIC_MAX_MANIFEST_BYTES);
    for (const key of Object.keys(maximum) as Array<keyof typeof maximum>) {
      expect(() =>
        validateAtomicInventoryBoundsV1({
          ...maximum,
          [key]: maximum[key] + 1,
        }),
      ).toThrow(/budget exceeded/u);
    }
  });

  test("permits internal empty payloads but rejects aggregate-empty writers", () => {
    expect(() => assertAtomicProfileSchemaV1("scaffold", 3, 0)).not.toThrow();
    expect(() => assertAtomicProfileSchemaV1("canary", 0, 0)).not.toThrow();
    expect(() =>
      assertAtomicProfileSchemaV1("initial_working", 0, 0),
    ).not.toThrow();
    expect(() => assertAtomicProfileSchemaV1("writer", 1, 0)).toThrow(
      /profile_schema_empty/u,
    );
    expect(() => assertAtomicProfileSchemaV1("writer", 20, 0)).toThrow(
      /profile_schema_empty/u,
    );
    expect(() => assertAtomicProfileSchemaV1("writer", 1, 1)).not.toThrow();
    expect(() =>
      assertAtomicProfileCopySchemaV1(
        "committed",
        "working",
        false,
        1,
        1,
      ),
    ).not.toThrow();
    expect(() =>
      assertAtomicProfileCopySchemaV1("staging", "working", false, 1, 1),
    ).toThrow(/copy authority/u);
    expect(() =>
      assertAtomicProfileCopySchemaV1(
        "committed",
        "staging",
        false,
        1,
        1,
      ),
    ).toThrow(/copy authority/u);
    expect(() =>
      assertAtomicProfileCopySchemaV1(
        "committed",
        "working",
        true,
        1,
        1,
      ),
    ).toThrow(/copy authority/u);
  });

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

  test("binds each protected removal to a durable manifest cursor", () => {
    const parentId = semanticId();
    const objectId = semanticId();
    const removed = evidence({ mode: 384, size: 7, contentSha256: HASH });
    const entryDigest = "b".repeat(64);
    const initial = createAtomicProtectedCleanupState({
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      entryCount: 1,
      entryCounts: {
        privateSourceEntries: 1,
        wrapperTemps: 0,
        intentTemps: 0,
      },
      entryDigests: [entryDigest],
      cursor: 0,
      suffix: "private_source_entries",
    });
    const entry: AtomicProtectedCleanupEntryV1 = {
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      index: 0,
      suffix: "private_source_entries",
      scope: "private_profile_payload",
      entryDigest,
      requestKind: "remove_file",
      role: "payload_entry",
      parentId,
      leaf: "state.bin",
      objectId,
      expected: removed,
      release: {
        reservation: "payload_entries",
        count: 1,
        byteSize: 7,
      },
    };
    expect(() =>
      beginAtomicProtectedCleanupEntry(initial, {
        ...entry,
        entryDigest: "c".repeat(64),
      }),
    ).toThrow(/invalid atomic protected cleanup entry/u);
    const persist = beginAtomicProtectedCleanupEntry(initial, entry);
    expect(persist.action).toEqual({
      kind: "persist_cursor",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      suffix: "private_source_entries",
      previousCursor: 0,
      nextIndex: 1,
      entryDigest,
    });
    expect(() =>
      advanceAtomicProtectedCleanupEntry(persist.state, {
        kind: "cursor_persisted",
        operationId: OPERATION_ID,
        manifestSha256: "c".repeat(64),
        suffix: "private_source_entries",
        previousCursor: 0,
        nextIndex: 1,
        entryDigest,
        evidenceDigest: HASH,
      }),
    ).toThrow(/cursor mismatch/u);
    expect(() =>
      advanceAtomicProtectedCleanupEntry(persist.state, {
        kind: "cursor_persisted",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        suffix: "private_source_entries",
        previousCursor: 0,
        nextIndex: 2,
        entryDigest,
        evidenceDigest: HASH,
      }),
    ).toThrow(/cursor mismatch/u);
    const remove = advanceAtomicProtectedCleanupEntry(persist.state, {
      kind: "cursor_persisted",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      suffix: "private_source_entries",
      previousCursor: 0,
      nextIndex: 1,
      entryDigest,
      evidenceDigest: HASH,
    });
    expect(remove.action).toMatchObject({
      kind: "remove",
      manifestSha256: HASH,
      cursor: 1,
      entryDigest,
      request: {
        kind: "remove_file",
        role: "payload_entry",
        objectId,
        expected: removed,
        manifestSha256: HASH,
        cursor: 1,
      },
    });
    expect(() =>
      advanceAtomicProtectedCleanupEntry(remove.state, {
        kind: "cursor_persisted",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        suffix: "private_source_entries",
        previousCursor: 0,
        nextIndex: 1,
        entryDigest,
        evidenceDigest: HASH,
      }),
    ).toThrow(/removal mismatch/u);
    expect(() =>
      advanceAtomicProtectedCleanupEntry(remove.state, {
        kind: "removal_observed",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        cursor: 1,
        entryDigest,
        requestKind: "remove_file",
        objectId,
        removedEvidence: evidence({
          mode: 384,
          size: 8,
          contentSha256: HASH,
        }),
        state: "absent",
        parentSynced: true,
        evidenceDigest: HASH,
      }),
    ).toThrow(/removal mismatch/u);
    expect(() =>
      advanceAtomicProtectedCleanupEntry(remove.state, {
        kind: "removal_observed",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        cursor: 1,
        entryDigest,
        requestKind: "remove_file",
        objectId,
        removedEvidence: removed,
        state: "absent",
        parentSynced: false,
        evidenceDigest: HASH,
      } as unknown as AtomicProtectedCleanupObservationV1),
    ).toThrow(/removal mismatch/u);
    const close = advanceAtomicProtectedCleanupEntry(remove.state, {
      kind: "removal_observed",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      cursor: 1,
      entryDigest,
      requestKind: "remove_file",
      objectId,
      removedEvidence: removed,
      state: "absent",
      parentSynced: true,
      evidenceDigest: HASH,
    });
    expect(close.action).toMatchObject({
      kind: "close",
      cursor: 1,
      request: { kind: "close_handle", objectId, expected: removed },
    });
    expect(() =>
      advanceAtomicProtectedCleanupEntry(close.state, {
        kind: "reservation_released",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        cursor: 1,
        entryDigest,
        reservation: "payload_entries",
        count: 1,
        byteSize: 7,
        evidenceDigest: HASH,
      }),
    ).toThrow(/close mismatch/u);
    const release = advanceAtomicProtectedCleanupEntry(close.state, {
      kind: "handle_closed",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      cursor: 1,
      entryDigest,
      role: "payload_entry",
      objectId,
      closedEvidence: removed,
      evidenceDigest: HASH,
    });
    expect(release.action).toMatchObject({
      kind: "release",
      cursor: 1,
      request: {
        kind: "release_budget",
        reservation: "payload_entries",
        count: 1,
        byteSize: 7,
      },
    });
    const completed = advanceAtomicProtectedCleanupEntry(release.state, {
      kind: "reservation_released",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      cursor: 1,
      entryDigest,
      reservation: "payload_entries",
      count: 1,
      byteSize: 7,
      evidenceDigest: HASH,
    });
    expect(completed).toMatchObject({
      action: null,
      state: { cursor: 1, stage: "ready", activeEntry: null },
    });
    expect(() =>
      advanceAtomicProtectedCleanupEntry(release.state, {
        kind: "reservation_released",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        cursor: 1,
        entryDigest: "c".repeat(64),
        reservation: "payload_entries",
        count: 1,
        byteSize: 7,
        evidenceDigest: HASH,
      }),
    ).toThrow(/release mismatch/u);
  });

  test("permits only manifest temp files through protected general removal", () => {
    const parentId = semanticId();
    const objectId = semanticId();
    const expected = evidence({
      mode: 384,
      size: 7,
      contentSha256: HASH,
    });
    const state = createAtomicReducerState({
      flightNonce: "manifest-temp-removal",
      request: {
        kind: "remove_file",
        operationId: OPERATION_ID,
        role: "manifest_temp",
        parentId,
        leaf:
          `${OPERATION_ID}.identities.22222222-2222-4222-8222-222222222222.tmp`,
        objectId,
        expected,
        manifestSha256: HASH,
        cursor: 0,
      },
      semanticIds: [parentId, objectId],
    });
    const effect = reduceAtomicPublication(state, null);
    expect(effect).toMatchObject({
      kind: "effect",
      request: {
        kind: "remove_file",
        role: "manifest_temp",
        manifestSha256: HASH,
        cursor: 0,
      },
    });
  });

  test("makes public and committed-profile removal unrepresentable", () => {
    const parentId = semanticId();
    const objectId = semanticId();
    for (const role of ["public_source", "public_target"] as const) {
      expect(() =>
        createAtomicReducerState({
          flightNonce: `flight-forbidden-removal-${role}`,
          request: {
            kind: "remove_root",
            operationId: OPERATION_ID,
            role,
            parentId,
            leaf: "generation",
            objectId,
            expected: EVIDENCE,
            manifestSha256: HASH,
            cursor: 1,
          } as unknown as AtomicEffectRequestDraftV1,
          semanticIds: [parentId, objectId],
        }),
      ).toThrow(/invalid atomic effect request/u);
    }
    expect(() =>
      createAtomicReducerState({
        flightNonce: "flight-forbidden-private-file-root",
        request: {
          kind: "remove_file",
          operationId: OPERATION_ID,
          role: "private_source",
          parentId,
          leaf: "payload",
          objectId,
          expected: evidence({ mode: 384 }),
          manifestSha256: HASH,
          cursor: 1,
        },
        semanticIds: [parentId, objectId],
      }),
    ).toThrow(/invalid atomic effect request/u);
  });

  test("enforces cleanup suffix order, cursor ranges, and bounds", () => {
    expect(() =>
      createAtomicProtectedCleanupState({
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        entryCount: ATOMIC_MAX_PAYLOAD_ENTRIES + 1,
        entryCounts: {
          privateSourceEntries: ATOMIC_MAX_PAYLOAD_ENTRIES + 1,
          wrapperTemps: 0,
          intentTemps: 0,
        },
        entryDigests: [],
        cursor: 0,
        suffix: "private_source_entries",
      }),
    ).toThrow(/invalid atomic protected cleanup state/u);
    expect(() =>
      createAtomicProtectedCleanupState({
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        entryCount: 2,
        entryCounts: {
          privateSourceEntries: 1,
          wrapperTemps: 0,
          intentTemps: 0,
        },
        entryDigests: [HASH, HASH],
        cursor: 0,
        suffix: "private_source_entries",
      }),
    ).toThrow(/invalid atomic protected cleanup state/u);

    const privateComplete = createAtomicProtectedCleanupState({
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      entryCount: 3,
      entryCounts: {
        privateSourceEntries: 1,
        wrapperTemps: 1,
        intentTemps: 1,
      },
      entryDigests: [HASH, "b".repeat(64), "c".repeat(64)],
      cursor: 1,
      suffix: "private_source_entries",
    });
    expect(() =>
      advanceAtomicProtectedCleanupSuffix(
        privateComplete,
        "wrapper_temps",
      ),
    ).toThrow(/cleanup suffix/u);
    const privateRoot = advanceAtomicProtectedCleanupSuffix(
      privateComplete,
      "private_source_root",
    );
    const wrapperTemps = advanceAtomicProtectedCleanupSuffix(
      privateRoot,
      "wrapper_temps",
    );
    expect(() =>
      advanceAtomicProtectedCleanupSuffix(wrapperTemps, "wrapper_root"),
    ).toThrow(/cleanup suffix/u);

    const wrapperComplete = createAtomicProtectedCleanupState({
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      entryCount: 3,
      entryCounts: {
        privateSourceEntries: 1,
        wrapperTemps: 1,
        intentTemps: 1,
      },
      entryDigests: [HASH, "b".repeat(64), "c".repeat(64)],
      cursor: 2,
      suffix: "wrapper_temps",
    });
    const wrapperRoot = advanceAtomicProtectedCleanupSuffix(
      wrapperComplete,
      "wrapper_root",
    );
    const intentTemps = advanceAtomicProtectedCleanupSuffix(
      wrapperRoot,
      "intent_temps",
    );
    expect(() =>
      advanceAtomicProtectedCleanupSuffix(intentTemps, "done"),
    ).toThrow(/cleanup suffix/u);

    const intentComplete = createAtomicProtectedCleanupState({
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      entryCount: 3,
      entryCounts: {
        privateSourceEntries: 1,
        wrapperTemps: 1,
        intentTemps: 1,
      },
      entryDigests: [HASH, "b".repeat(64), "c".repeat(64)],
      cursor: 3,
      suffix: "intent_temps",
    });
    expect(
      advanceAtomicProtectedCleanupSuffix(intentComplete, "done"),
    ).toMatchObject({ suffix: "done", cursor: 3 });
  });

  test("deletes stable manifest before persisting cleaned and intent last", () => {
    let cleanup = createAtomicProtectedCleanupState({
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      entryCount: 0,
      entryCounts: {
        privateSourceEntries: 0,
        wrapperTemps: 0,
        intentTemps: 0,
      },
      entryDigests: [],
      cursor: 0,
      suffix: "private_source_entries",
    });
    for (const suffix of [
      "private_source_root",
      "wrapper_temps",
      "wrapper_root",
      "intent_temps",
      "done",
    ] as const) {
      cleanup = advanceAtomicProtectedCleanupSuffix(cleanup, suffix);
    }
    const parentId = semanticId();
    const manifestId = semanticId();
    const intentId = semanticId();
    const manifestEvidence = evidence({
      mode: 384,
      size: 20,
      contentSha256: HASH,
    });
    const intentEvidence = evidence({
      mode: 384,
      size: 30,
      contentSha256: HASH,
    });
    const intentRecord = {
      role: "intent_stable" as const,
      parentId,
      leaf: `${OPERATION_ID}.json`,
      objectId: intentId,
      expected: intentEvidence,
      release: {
        reservation: "other_metadata_bytes" as const,
        count: 1 as const,
        byteSize: 30,
      },
    };
    let current = beginAtomicProtectedCleanupTerminal(cleanup, {
      manifest: {
        role: "manifest_stable",
        parentId,
        leaf: `${OPERATION_ID}.identities.json`,
        objectId: manifestId,
        expected: manifestEvidence,
        release: {
          reservation: "manifest_bytes",
          count: 1,
          byteSize: 20,
        },
      },
      intent: intentRecord,
    });
    expect(current.action).toMatchObject({
      kind: "persist_phase",
      phase: "manifest_deleting",
    });
    expect(() =>
      advanceAtomicProtectedCleanupTerminal(current.state, {
        kind: "phase_persisted",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        cursor: 0,
        phase: "cleaned",
        intent: intentRecord,
        evidenceDigest: HASH,
      }),
    ).toThrow(/manifest deletion was not authorized/u);
    current = advanceAtomicProtectedCleanupTerminal(current.state, {
      kind: "phase_persisted",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      cursor: 0,
      phase: "manifest_deleting",
      intent: intentRecord,
      evidenceDigest: HASH,
    });
    expect(current.action).toMatchObject({
      kind: "remove_stable",
      role: "manifest_stable",
      request: { kind: "remove_manifest", stableObjectId: manifestId },
    });

    const stableObservation = (
      kind: "removal_observed" | "handle_closed",
      role: "manifest_stable" | "intent_stable",
      objectId: FlightSemanticId,
      itemEvidence: AtomicObjectEvidenceV1,
    ): AtomicProtectedCleanupTerminalObservationV1 =>
      kind === "removal_observed"
        ? {
            kind,
            operationId: OPERATION_ID,
            manifestSha256: HASH,
            cursor: 0,
            role,
            objectId,
            removedEvidence: itemEvidence,
            state: "absent",
            parentSynced: true,
            evidenceDigest: HASH,
          }
        : {
            kind,
            operationId: OPERATION_ID,
            manifestSha256: HASH,
            cursor: 0,
            role,
            objectId,
            closedEvidence: itemEvidence,
            evidenceDigest: HASH,
          };

    expect(() =>
      advanceAtomicProtectedCleanupTerminal(
        current.state,
        stableObservation(
          "removal_observed",
          "intent_stable",
          intentId,
          intentEvidence,
        ),
      ),
    ).toThrow(/manifest removal mismatch/u);
    current = advanceAtomicProtectedCleanupTerminal(
      current.state,
      stableObservation(
        "removal_observed",
        "manifest_stable",
        manifestId,
        manifestEvidence,
      ),
    );
    expect(current.action).toMatchObject({
      kind: "close_stable",
      role: "manifest_stable",
    });
    current = advanceAtomicProtectedCleanupTerminal(
      current.state,
      stableObservation(
        "handle_closed",
        "manifest_stable",
        manifestId,
        manifestEvidence,
      ),
    );
    expect(current.action).toMatchObject({
      kind: "release_stable",
      role: "manifest_stable",
    });
    current = advanceAtomicProtectedCleanupTerminal(current.state, {
      kind: "reservation_released",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      cursor: 0,
      role: "manifest_stable",
      reservation: "manifest_bytes",
      count: 1,
      byteSize: 20,
      evidenceDigest: HASH,
    });
    expect(current.action).toMatchObject({
      kind: "persist_phase",
      phase: "cleaned",
    });
    current = advanceAtomicProtectedCleanupTerminal(current.state, {
      kind: "phase_persisted",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      cursor: 0,
      phase: "cleaned",
      intent: intentRecord,
      evidenceDigest: HASH,
    });
    expect(current.action).toMatchObject({
      kind: "remove_stable",
      role: "intent_stable",
      request: { kind: "remove_intent", stableObjectId: intentId },
    });
    current = advanceAtomicProtectedCleanupTerminal(
      current.state,
      stableObservation(
        "removal_observed",
        "intent_stable",
        intentId,
        intentEvidence,
      ),
    );
    current = advanceAtomicProtectedCleanupTerminal(
      current.state,
      stableObservation(
        "handle_closed",
        "intent_stable",
        intentId,
        intentEvidence,
      ),
    );
    current = advanceAtomicProtectedCleanupTerminal(current.state, {
      kind: "reservation_released",
      operationId: OPERATION_ID,
      manifestSha256: HASH,
      cursor: 0,
      role: "intent_stable",
      reservation: "other_metadata_bytes",
      count: 1,
      byteSize: 30,
      evidenceDigest: HASH,
    });
    expect(current).toMatchObject({
      action: null,
      state: { stage: "complete" },
    });
    expect(() =>
      advanceAtomicProtectedCleanupTerminal(current.state, {
        kind: "phase_persisted",
        operationId: OPERATION_ID,
        manifestSha256: HASH,
        cursor: 0,
        phase: "cleaned",
        intent: intentRecord,
        evidenceDigest: HASH,
      }),
    ).toThrow(/terminal observation/u);
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

  test("rejects invalid persistence phase discriminators before effects", () => {
    const tempParentId = semanticId();
    const tempObjectId = semanticId();
    const stableParentId = semanticId();
    const canonicalBytes = new TextEncoder().encode("{}\n");
    const contentDigest = createHash("sha256")
      .update(canonicalBytes)
      .digest("hex");
    const common = {
      operationId: OPERATION_ID,
      canonicalBytes,
      contentDigest,
      tempParentId,
      tempLeaf: `${OPERATION_ID}.allocated.${OPERATION_ID}.tmp`,
      tempObjectId,
      expectedTemp: evidence({
        mode: 384,
        size: canonicalBytes.byteLength,
        contentSha256: contentDigest,
      }),
      stableParentId,
      stableLeaf: `${OPERATION_ID}.json`,
      expectedStable: { absent: true as const },
    };
    for (const request of [
      {
        ...common,
        kind: "persist_intent",
        expectedPhase: "building",
      },
      {
        ...common,
        kind: "persist_manifest",
        expectedPhase: null,
      },
    ]) {
      expect(() =>
        createAtomicReducerState({
          flightNonce: "flight-invalid-persistence-phase",
          request: request as unknown as AtomicEffectRequestDraftV1,
          semanticIds: [tempParentId, tempObjectId, stableParentId],
        }),
      ).toThrow(/invalid atomic effect request/u);
    }
  });

  test("requires exact persistence location proof after native resolution", () => {
    const tempParentId = semanticId();
    const tempObjectId = semanticId();
    const stableParentId = semanticId();
    const targetObjectId = semanticId();
    const canonicalBytes = new TextEncoder().encode("{}\n");
    const contentDigest = createHash("sha256")
      .update(canonicalBytes)
      .digest("hex");
    const expectedTemp = evidence({
      mode: 384,
      size: canonicalBytes.byteLength,
      contentSha256: contentDigest,
    });
    const state = createAtomicReducerState({
      flightNonce: "flight-persistence-locations",
      request: {
        kind: "persist_manifest",
        operationId: OPERATION_ID,
        expectedPhase: "manifest_planned",
        canonicalBytes,
        contentDigest,
        tempParentId,
        tempLeaf: `${OPERATION_ID}.identities.${OPERATION_ID}.tmp`,
        tempObjectId,
        expectedTemp,
        stableParentId,
        stableLeaf: `${OPERATION_ID}.identities.json`,
        expectedStable: { absent: true },
      },
      semanticIds: [tempParentId, tempObjectId, stableParentId],
    });
    const native = emittedEffect(reduceAtomicPublication(state, null));
    const observing = reduceAtomicPublication(state, {
      kind: "native_resolved",
      effectId: native.request.effectId,
      requestKind: "persist_manifest",
      operationId: OPERATION_ID,
      move: "manifest_publish",
      sourceObjectId: tempObjectId,
      sourceEvidence: expectedTemp,
      rawCode: "success",
      nativePrecheckEvidenceDigest: HASH,
      evidenceDigest: HASH,
    });
    expect(observing).toMatchObject({
      kind: "effect",
      request: {
        kind: "observe_locations",
        requestKind: "persist_manifest",
        move: "manifest_publish",
        tempObjectId,
        expectedTemp,
        expectedTargetBefore: { absent: true },
        expectedTargetAfter: expectedTemp,
      },
    });
    if (observing.kind !== "effect") {
      throw new Error("persistence location effect missing");
    }
    const completed = reduceAtomicPublication(observing.state, {
      kind: "locations_observed",
      effectId: observing.request.effectId,
      requestKind: "persist_manifest",
      operationId: OPERATION_ID,
      move: "manifest_publish",
      tempParentId,
      tempLeaf: `${OPERATION_ID}.identities.${OPERATION_ID}.tmp`,
      stableParentId,
      stableLeaf: `${OPERATION_ID}.identities.json`,
      requestedSourceObjectId: tempObjectId,
      sourceObjectId: null,
      targetObjectId,
      source: location("absent", null, null),
      target: location("match", targetObjectId, expectedTemp),
      evidenceDigest: HASH,
    });
    expect(completed).toMatchObject({
      kind: "terminal",
      result: { kind: "protocol_complete" },
    });
    const wrongAssociation = reduceAtomicPublication(observing.state, {
      kind: "locations_observed",
      effectId: observing.request.effectId,
      requestKind: "persist_manifest",
      operationId: OPERATION_ID,
      move: "manifest_publish",
      tempParentId,
      tempLeaf: `${OPERATION_ID}.identities.${OPERATION_ID}.tmp`,
      stableParentId,
      stableLeaf: `${OPERATION_ID}.identities.json`,
      requestedSourceObjectId: semanticId(),
      sourceObjectId: null,
      targetObjectId,
      source: location("absent", null, null),
      target: location("match", targetObjectId, expectedTemp),
      evidenceDigest: HASH,
    });
    expect(wrongAssociation).toMatchObject({
      kind: "terminal",
      result: { kind: "fail_stop", code: "observation_mismatch" },
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

describe("manifest planned recovery", () => {
  const MANIFEST_BYTES = new TextEncoder().encode(
    '{"version":1,"entries":[{"index":0}]}\n',
  );
  const MANIFEST_SHA256 = createHash("sha256")
    .update(MANIFEST_BYTES)
    .digest("hex");
  const TRANSITION_ID = "22222222-2222-4222-8222-222222222222";

  function manifestBinding(): AtomicManifestPlannedBindingV1 {
    return Object.freeze({
      operationId: OPERATION_ID,
      canonicalBytes: MANIFEST_BYTES,
      manifestSha256: MANIFEST_SHA256,
      manifestByteSize: MANIFEST_BYTES.byteLength,
      entryCount: 1,
      intentsParentId: semanticId(),
      tempLeaf: `${OPERATION_ID}.identities.${TRANSITION_ID}.tmp`,
      stableLeaf: `${OPERATION_ID}.identities.json`,
    });
  }

  function manifestEvidence(
    overrides: Partial<Omit<AtomicObjectEvidenceV1, "evidenceDigest">> = {},
  ): AtomicObjectEvidenceV1 {
    return evidence({
      mode: 384,
      size: MANIFEST_BYTES.byteLength,
      contentSha256: MANIFEST_SHA256,
      ...overrides,
    });
  }

  function observationBinding(binding: AtomicManifestPlannedBindingV1) {
    return {
      operationId: binding.operationId,
      manifestSha256: binding.manifestSha256,
      manifestByteSize: binding.manifestByteSize,
      entryCount: binding.entryCount,
      intentsParentId: binding.intentsParentId,
      tempLeaf: binding.tempLeaf,
      stableLeaf: binding.stableLeaf,
    };
  }

  function absent(leaf: string) {
    return Object.freeze({
      state: "absent" as const,
      leaf,
      objectId: null,
      evidence: null,
    });
  }

  function present(
    leaf: string,
    objectId: FlightSemanticId,
    objectEvidence: AtomicObjectEvidenceV1,
  ) {
    return Object.freeze({
      state: "present" as const,
      leaf,
      objectId,
      evidence: objectEvidence,
    });
  }

  function locations(
    binding: AtomicManifestPlannedBindingV1,
    temp: ReturnType<typeof absent> | ReturnType<typeof present>,
    stable: ReturnType<typeof absent> | ReturnType<typeof present>,
    options: {
      stableParentSynced?: boolean;
      publicationProof?: AtomicManifestPlannedRecoveryObservationV1 extends infer _T
        ? Extract<
            AtomicManifestPlannedRecoveryObservationV1,
            { kind: "manifest_locations_observed" }
          >["publicationProof"]
        : never;
    } = {},
  ): Extract<
    AtomicManifestPlannedRecoveryObservationV1,
    { kind: "manifest_locations_observed" }
  > {
    return {
      kind: "manifest_locations_observed",
      ...observationBinding(binding),
      temp,
      stable,
      stableParentSynced: options.stableParentSynced ?? false,
      publicationProof: options.publicationProof ?? null,
    };
  }

  test("recreates exact bytes when both locations are absent", () => {
    const binding = manifestBinding();
    const initial = createAtomicManifestPlannedRecoveryState(binding);
    expect(initial.action).toEqual({
      kind: "observe_manifest_locations",
      ...observationBinding(binding),
      expectedMode: 384,
    });
    const recreate = advanceAtomicManifestPlannedRecovery(
      initial.state,
      locations(
        binding,
        absent(binding.tempLeaf),
        absent(binding.stableLeaf),
      ),
    );
    expect(recreate.action).toMatchObject({
      kind: "recreate_manifest_temp",
      canonicalBytes: MANIFEST_BYTES,
      mode: 384,
      expectedAbsence: true,
    });

    const tempObjectId = semanticId();
    const expected = manifestEvidence();
    const publish = advanceAtomicManifestPlannedRecovery(recreate.state, {
      kind: "manifest_temp_recreated",
      ...observationBinding(binding),
      tempObjectId,
      tempEvidence: expected,
      tempParentSynced: true,
    });
    expect(publish.action).toMatchObject({
      kind: "publish_manifest_temp",
      tempObjectId,
      expectedTemp: expected,
      expectedStable: { absent: true },
    });

    const stableObjectId = semanticId();
    const persist = advanceAtomicManifestPlannedRecovery(publish.state, {
      kind: "manifest_publication_observed",
      ...observationBinding(binding),
      tempObjectId,
      tempEvidence: expected,
      stableObjectId,
      stableEvidence: expected,
      sourceState: "absent",
      targetState: "present",
      stableParentSynced: true,
    });
    expect(persist.action).toMatchObject({
      kind: "persist_manifest_published",
      stableObjectId,
      expectedStable: expected,
      stableParentSynced: true,
    });

    const complete = advanceAtomicManifestPlannedRecovery(persist.state, {
      kind: "manifest_published_persisted",
      ...observationBinding(binding),
      phase: "manifest_published",
      stableObjectId,
      stableEvidence: expected,
      stableParentSynced: true,
    });
    expect(complete).toMatchObject({
      action: null,
      result: { kind: "complete" },
      state: { stage: "complete" },
    });
  });

  test("publishes an exact pinned temp and binds an exact stable file", () => {
    const binding = manifestBinding();
    const expected = manifestEvidence();
    const tempObjectId = semanticId();
    const tempInitial = createAtomicManifestPlannedRecoveryState(binding);
    const publish = advanceAtomicManifestPlannedRecovery(
      tempInitial.state,
      locations(
        binding,
        present(binding.tempLeaf, tempObjectId, expected),
        absent(binding.stableLeaf),
      ),
    );
    expect(publish.action).toMatchObject({
      kind: "publish_manifest_temp",
      tempObjectId,
      expectedTemp: expected,
    });

    const stableObjectId = semanticId();
    const stableInitial = createAtomicManifestPlannedRecoveryState(binding);
    const persist = advanceAtomicManifestPlannedRecovery(
      stableInitial.state,
      locations(
        binding,
        absent(binding.tempLeaf),
        present(binding.stableLeaf, stableObjectId, expected),
        { stableParentSynced: true },
      ),
    );
    expect(persist.action).toMatchObject({
      kind: "persist_manifest_published",
      stableObjectId,
      expectedStable: expected,
    });
  });

  test("authorization-first removes an exact leftover temp before binding", () => {
    const binding = manifestBinding();
    const tempExpected = manifestEvidence({ ino: "10" });
    const stableExpected = manifestEvidence({ ino: "11" });
    const tempObjectId = semanticId();
    const stableObjectId = semanticId();
    const proof = Object.freeze({
      operationId: OPERATION_ID,
      tempObjectId,
      stableObjectId,
      tempEvidence: tempExpected,
      stableEvidence: stableExpected,
      sourceState: "present" as const,
      targetState: "present" as const,
      stableParentSynced: true as const,
      evidenceDigest: HASH,
    });
    const initial = createAtomicManifestPlannedRecoveryState(binding);
    const authorize = advanceAtomicManifestPlannedRecovery(
      initial.state,
      locations(
        binding,
        present(binding.tempLeaf, tempObjectId, tempExpected),
        present(binding.stableLeaf, stableObjectId, stableExpected),
        { stableParentSynced: true, publicationProof: proof },
      ),
    );
    expect(authorize.action).toMatchObject({
      kind: "authorize_manifest_temp_cleanup",
      tempObjectId,
      stableObjectId,
      expectedTemp: tempExpected,
      expectedStable: stableExpected,
    });
    if (authorize.action?.kind !== "authorize_manifest_temp_cleanup") {
      throw new Error("manifest cleanup authorization was not emitted");
    }
    const authorizationDigest = authorize.action.authorizationDigest;

    const remove = advanceAtomicManifestPlannedRecovery(authorize.state, {
      kind: "manifest_temp_cleanup_authorized",
      ...observationBinding(binding),
      authorizationDigest,
    });
    expect(remove.action).toMatchObject({
      kind: "remove_manifest_temp",
      tempObjectId,
      expectedTemp: tempExpected,
      authorizationDigest,
    });

    const persist = advanceAtomicManifestPlannedRecovery(remove.state, {
      kind: "manifest_temp_removed",
      ...observationBinding(binding),
      tempObjectId,
      removedEvidence: tempExpected,
      state: "absent",
      parentSynced: true,
      authorizationDigest,
    });
    expect(persist.action).toMatchObject({
      kind: "persist_manifest_published",
      stableObjectId,
      expectedStable: stableExpected,
    });
  });

  test("fails closed on both-present without stable publication proof", () => {
    const binding = manifestBinding();
    const expected = manifestEvidence();
    const initial = createAtomicManifestPlannedRecoveryState(binding);
    expect(
      advanceAtomicManifestPlannedRecovery(
        initial.state,
        locations(
          binding,
          present(binding.tempLeaf, semanticId(), expected),
          present(binding.stableLeaf, semanticId(), expected),
          { stableParentSynced: true },
        ),
      ),
    ).toMatchObject({
      action: null,
      result: { kind: "fail_stop", code: "unknown_topology" },
      state: { stage: "fail_stop" },
    });
  });

  test.each([
    ["mode", manifestEvidence({ mode: 448 })],
    ["size", manifestEvidence({ size: MANIFEST_BYTES.byteLength + 1 })],
    ["hash", manifestEvidence({ contentSha256: "b".repeat(64) })],
  ])("fails closed on manifest %s drift", (_name, drifted) => {
    const binding = manifestBinding();
    const initial = createAtomicManifestPlannedRecoveryState(binding);
    expect(
      advanceAtomicManifestPlannedRecovery(
        initial.state,
        locations(
          binding,
          present(binding.tempLeaf, semanticId(), drifted),
          absent(binding.stableLeaf),
        ),
      ),
    ).toMatchObject({
      result: { kind: "fail_stop", code: "binding_mismatch" },
      state: { stage: "fail_stop" },
    });
  });

  test("fails closed on inode drift, unknown topology, and binding echoes", () => {
    const binding = manifestBinding();
    const tempObjectId = semanticId();
    const stableObjectId = semanticId();
    const tempEvidence = manifestEvidence({ ino: "10" });
    const stableEvidence = manifestEvidence({ ino: "11" });
    const driftedProofTempEvidence = manifestEvidence({ ino: "12" });
    const proof = {
      operationId: OPERATION_ID,
      tempObjectId,
      stableObjectId,
      tempEvidence: driftedProofTempEvidence,
      stableEvidence,
      sourceState: "present" as const,
      targetState: "present" as const,
      stableParentSynced: true as const,
      evidenceDigest: HASH,
    };
    let initial = createAtomicManifestPlannedRecoveryState(binding);
    expect(
      advanceAtomicManifestPlannedRecovery(
        initial.state,
        locations(
          binding,
          present(binding.tempLeaf, tempObjectId, tempEvidence),
          present(binding.stableLeaf, stableObjectId, stableEvidence),
          { stableParentSynced: true, publicationProof: proof },
        ),
      ),
    ).toMatchObject({
      result: { kind: "fail_stop", code: "binding_mismatch" },
    });

    initial = createAtomicManifestPlannedRecoveryState(binding);
    expect(
      advanceAtomicManifestPlannedRecovery(initial.state, {
        ...locations(
          binding,
          absent(binding.tempLeaf),
          absent(binding.stableLeaf),
        ),
        temp: {
          state: "other",
          leaf: binding.tempLeaf,
          objectId: semanticId(),
          evidence: manifestEvidence(),
        },
      }),
    ).toMatchObject({
      result: { kind: "fail_stop", code: "unknown_topology" },
    });

    initial = createAtomicManifestPlannedRecoveryState(binding);
    expect(
      advanceAtomicManifestPlannedRecovery(initial.state, {
        ...locations(
          binding,
          absent(binding.tempLeaf),
          absent(binding.stableLeaf),
        ),
        entryCount: 2,
      }),
    ).toMatchObject({
      result: { kind: "fail_stop", code: "observation_mismatch" },
    });
  });

  test("accepts an empty abort manifest and rejects invalid bindings", () => {
    const binding = manifestBinding();
    const emptyBytes = new TextEncoder().encode("{}\n");
    expect(() =>
      createAtomicManifestPlannedRecoveryState({
        ...binding,
        canonicalBytes: emptyBytes,
        manifestSha256: createHash("sha256")
          .update(emptyBytes)
          .digest("hex"),
        manifestByteSize: emptyBytes.byteLength,
        entryCount: 0,
      }),
    ).not.toThrow();
    for (const invalid of [
      { ...binding, stableLeaf: "other.identities.json" },
      { ...binding, tempLeaf: `${OPERATION_ID}.identities.not-a-uuid.tmp` },
      { ...binding, manifestSha256: HASH },
      { ...binding, manifestByteSize: binding.manifestByteSize + 1 },
      { ...binding, entryCount: -1 },
    ]) {
      expect(() =>
        createAtomicManifestPlannedRecoveryState(invalid),
      ).toThrow(/invalid atomic manifest planned binding/u);
    }
  });
});
