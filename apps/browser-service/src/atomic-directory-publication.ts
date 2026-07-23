import { createHash } from "node:crypto";

const flightIdBrand: unique symbol = Symbol("atomic-publication-flight-id");
const effectNonce: unique symbol = Symbol("atomic-publication-effect-nonce");
const effectStep: unique symbol = Symbol("atomic-publication-effect-step");

export const ATOMIC_MAX_TRACKED_IDS = 4_096;
export const ATOMIC_MAX_PARTIAL_CREATE_IDS = 1_024;
export const ATOMIC_MAX_DIRECTORY_ENTRIES = 256;
export const ATOMIC_MAX_OBSERVATION_BYTES = 65_536;

export type CanonicalUuid = string;
export type Sha256 = string;

export type AtomicNativeMoveV1 =
  | "profile_publish"
  | "canary_publish"
  | "profile_source_to_private"
  | "canary_source_to_private";

export type AtomicLocationMoveV1 =
  | AtomicNativeMoveV1
  | "intent_publish"
  | "manifest_publish";

export type FlightSemanticId = Readonly<{ [flightIdBrand]: true }>;
export type FlightEffectId = Readonly<{
  effect: true;
  [flightIdBrand]: true;
}>;
export type FlightPartialCreateId = Readonly<{
  partialCreate: true;
  [flightIdBrand]: true;
}>;

export type AtomicObjectEvidenceV1 = Readonly<{
  dev: string;
  ino: string;
  mode: number;
  size: number;
  contentSha256: Sha256 | null;
  evidenceDigest: Sha256;
}>;

export type AtomicObjectRoleV1 =
  | "trusted_parent"
  | "state_root"
  | "profiles_parent"
  | "staging_root"
  | "intents_parent"
  | "bundles_parent"
  | "wrapper"
  | "private_source"
  | "payload_entry"
  | "intent_temp"
  | "intent_stable"
  | "manifest_temp"
  | "manifest_stable"
  | "private_deletion"
  | "public_source"
  | "public_target";

export type AtomicEffectKindV1 =
  | "reserve_budget"
  | "release_budget"
  | "create_and_pin_wrapper"
  | "create_and_pin_directory"
  | "create_and_pin_file"
  | "create_and_pin_temp_file"
  | "cleanup_partial_create"
  | "open_pin_handle"
  | "revalidate_handle"
  | "statfs_parent"
  | "close_handle"
  | "enumerate_directory"
  | "read_file_chunk"
  | "populate_payload_entry"
  | "copy_payload_chunk"
  | "write_file_chunk"
  | "canonicalize_tree_step"
  | "hash_content_chunk"
  | "fsync_file"
  | "fsync_directory"
  | "fsync_parent"
  | "persist_canary_phase"
  | "persist_intent"
  | "replace_intent"
  | "remove_intent"
  | "persist_manifest"
  | "remove_manifest"
  | "native_no_replace"
  | "observe_locations"
  | "remove_file"
  | "remove_directory"
  | "remove_root"
  | "resolve_adoption"
  | "adopt_generation"
  | "release_publication"
  | "close_admission";

export type CanonicalLocationEvidenceV1 = Readonly<{
  state: "absent" | "match" | "other";
  objectId: FlightSemanticId | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  evidence: AtomicObjectEvidenceV1 | null;
  evidenceDigest: Sha256;
}>;

export type AtomicRawNativeCodeV1 =
  | "success"
  | "atomic_publish_exists"
  | "atomic_publish_source_missing"
  | "atomic_publish_unsupported"
  | "atomic_publish_cross_device"
  | "atomic_publish_binding_invalid"
  | "atomic_publish_denied"
  | "atomic_publish_invalid_argument"
  | "atomic_publish_io";

export type AtomicPublishPhaseV1 =
  | "allocated"
  | "building"
  | "aborting_prepublication"
  | "ready"
  | "classified"
  | "renamed"
  | "manifest_planned"
  | "manifest_published"
  | "source_deleting"
  | "adopted"
  | "discarding"
  | "manifest_deleting"
  | "cleaned";

export type AtomicEffectRequestV1 =
  | Readonly<{
      kind: "reserve_budget" | "release_budget";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      reservation:
        | "payload_entries"
        | "payload_bytes"
        | "stable_files"
        | "scratch_files"
        | "manifest_bytes"
        | "other_metadata_bytes";
      count: number;
      byteSize: number;
    }>
  | Readonly<{
      kind:
        | "create_and_pin_wrapper"
        | "create_and_pin_directory"
        | "create_and_pin_file"
        | "create_and_pin_temp_file";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      parentId: FlightSemanticId;
      leaf: string;
      parentEvidenceDigest: Sha256;
      mode: 384 | 448;
      expectedAbsence: true;
    }>
  | Readonly<{
      kind: "cleanup_partial_create";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      partialId: FlightPartialCreateId;
    }>
  | Readonly<{
      kind: "open_pin_handle";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      parentId: FlightSemanticId;
      leaf: string;
      flags:
        | "directory_nofollow"
        | "file_read_nofollow"
        | "file_write_nofollow"
        | "path_nofollow";
      expected: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "statfs_parent";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      objectId: FlightSemanticId;
      expected: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind:
        | "revalidate_handle"
        | "close_handle"
        | "enumerate_directory"
        | "read_file_chunk";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      objectId: FlightSemanticId;
      cursor: number;
      byteLength: number;
      expected: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "persist_canary_phase";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      previousPhase: "planned" | "published" | "deleting" | null;
      proof: AtomicCanaryProofV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "populate_payload_entry" | "canonicalize_tree_step";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      rootId: FlightSemanticId;
      cursor: number;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "copy_payload_chunk" | "write_file_chunk";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      sourceFileId: FlightSemanticId | null;
      inlineBytes: Uint8Array | null;
      destinationFileId: FlightSemanticId;
      offset: number;
      byteLength: number;
      expectedChunkSha256: Sha256;
      expectedResultSha256: Sha256;
    }>
  | Readonly<{
      kind: "hash_content_chunk";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      objectId: FlightSemanticId;
      offset: number;
      byteLength: number;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "fsync_file" | "fsync_directory" | "fsync_parent";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      objectId: FlightSemanticId;
      expected: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "persist_intent" | "persist_manifest";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      expectedPhase: AtomicPublishPhaseV1 | null;
      canonicalBytes: Uint8Array;
      contentDigest: Sha256;
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedStable: Readonly<{ absent: true }>;
    }>
  | Readonly<{
      kind: "replace_intent";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      expectedPhase: AtomicPublishPhaseV1;
      canonicalBytes: Uint8Array;
      contentDigest: Sha256;
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedStable: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "remove_intent" | "remove_manifest";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      stableObjectId: FlightSemanticId;
      expectedStable: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "native_no_replace";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceParentId: FlightSemanticId;
      sourceId: FlightSemanticId;
      sourceLeaf: string;
      targetParentId: FlightSemanticId;
      targetLeaf: string;
      expectedSource: AtomicObjectEvidenceV1;
      expectedTarget:
        | AtomicObjectEvidenceV1
        | Readonly<{ absent: true }>;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "observe_locations";
      requestKind: "native_no_replace";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceParentId: FlightSemanticId;
      sourceId: FlightSemanticId | null;
      sourceLeaf: string;
      targetParentId: FlightSemanticId;
      targetLeaf: string;
      expectedSource: AtomicObjectEvidenceV1;
      expectedTarget:
        | AtomicObjectEvidenceV1
        | Readonly<{ absent: true }>;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "observe_locations";
      requestKind: "persist_intent";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: "intent_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedTargetBefore: Readonly<{ absent: true }>;
      expectedTargetAfter: AtomicObjectEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "observe_locations";
      requestKind: "persist_manifest";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      move: "manifest_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      tempObjectId: FlightSemanticId;
      expectedTemp: AtomicObjectEvidenceV1;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      expectedTargetBefore: Readonly<{ absent: true }>;
      expectedTargetAfter: AtomicObjectEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "remove_file" | "remove_directory" | "remove_root";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      role: AtomicObjectRoleV1;
      parentId: FlightSemanticId;
      leaf: string;
      objectId: FlightSemanticId;
      expected: AtomicObjectEvidenceV1;
      manifestSha256: Sha256;
      cursor: number;
    }>
  | Readonly<{
      kind:
        | "resolve_adoption"
        | "adopt_generation"
        | "release_publication";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      authorityDigest: Sha256;
    }>
  | Readonly<{
      kind: "close_admission";
      effectId: FlightEffectId;
      operationId: CanonicalUuid;
      reason:
        | "binding_invalid"
        | "ambiguous"
        | "unsupported"
        | "cross_device"
        | "denied"
        | "io"
        | "close_unverified";
      evidenceDigest: Sha256;
    }>;

export type AtomicEffectObservationV1 =
  | Readonly<{
      kind: "effect_rejected";
      effectId: FlightEffectId;
      requestKind: AtomicEffectKindV1;
      code:
        | "budget_exceeded"
        | "binding_invalid"
        | "conflict"
        | "unsupported"
        | "denied"
        | "io"
        | "close_unverified";
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "effect_completed";
      effectId: FlightEffectId;
      requestKind: Exclude<
        AtomicEffectKindV1,
        | "native_no_replace"
        | "observe_locations"
        | "persist_intent"
        | "persist_manifest"
        | "remove_intent"
        | "remove_manifest"
        | "remove_file"
        | "remove_directory"
        | "remove_root"
        | "create_and_pin_wrapper"
        | "create_and_pin_directory"
        | "create_and_pin_file"
        | "create_and_pin_temp_file"
        | "open_pin_handle"
        | "enumerate_directory"
        | "read_file_chunk"
        | "canonicalize_tree_step"
        | "hash_content_chunk"
        | "cleanup_partial_create"
        | "resolve_adoption"
        | "adopt_generation"
        | "release_publication"
      >;
      evidenceDigest: Sha256;
      count: number;
      byteSize: number;
    }>
  | Readonly<{
      kind: "create_and_pin_completed";
      effectId: FlightEffectId;
      requestKind:
        | "create_and_pin_wrapper"
        | "create_and_pin_directory"
        | "create_and_pin_file"
        | "create_and_pin_temp_file";
      handleId: FlightSemanticId;
      evidence: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "existing_handle_pinned";
      effectId: FlightEffectId;
      handleId: FlightSemanticId;
      evidence: AtomicObjectEvidenceV1;
    }>
  | Readonly<{
      kind: "statfs_observed";
      effectId: FlightEffectId;
      objectId: FlightSemanticId;
      filesystem: "ext" | "xfs" | "btrfs" | "tmpfs" | "overlay";
      magic: string;
      device: string;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "create_and_pin_partial";
      effectId: FlightEffectId;
      requestKind:
        | "create_and_pin_wrapper"
        | "create_and_pin_directory"
        | "create_and_pin_file"
        | "create_and_pin_temp_file";
      partialId: FlightPartialCreateId;
      stage: "entry_created" | "handle_opened" | "fstat_failed";
      entryCreated: true;
      handleOpened: boolean;
      evidence: AtomicObjectEvidenceV1 | null;
      code: "binding_invalid" | "denied" | "io";
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "partial_create_cleanup_observed";
      effectId: FlightEffectId;
      partialId: FlightPartialCreateId;
      state: "absent";
      parentSynced: true;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "partial_create_cleanup_failed";
      effectId: FlightEffectId;
      partialId: FlightPartialCreateId;
      stage:
        | "close"
        | "identity_verify"
        | "remove"
        | "absence_verify"
        | "parent_fsync";
      state: "present" | "unknown" | "absent_unsynced";
      parentSynced: false;
      code:
        | "binding_invalid"
        | "denied"
        | "io"
        | "close_unverified";
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "removal_observed";
      effectId: FlightEffectId;
      requestKind:
        | "remove_intent"
        | "remove_manifest"
        | "remove_file"
        | "remove_directory"
        | "remove_root";
      objectId: FlightSemanticId;
      removedEvidence: AtomicObjectEvidenceV1;
      state: "absent";
      parentSynced: true;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "directory_observed";
      effectId: FlightEffectId;
      cursor: number;
      entries: ReadonlyArray<
        Readonly<{
          leaf: string;
          role: AtomicObjectRoleV1;
          objectId: FlightSemanticId;
          type: "file" | "directory";
          evidenceDigest: Sha256;
        }>
      >;
      done: boolean;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "file_chunk_observed";
      effectId: FlightEffectId;
      cursor: number;
      byteSize: number;
      bytesBase64: string;
      contentDigest: Sha256;
      eof: boolean;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "native_resolved";
      effectId: FlightEffectId;
      requestKind: "native_no_replace";
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceObjectId: FlightSemanticId;
      sourceEvidence: AtomicObjectEvidenceV1;
      rawCode: AtomicRawNativeCodeV1;
      nativePrecheckEvidenceDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "native_resolved";
      effectId: FlightEffectId;
      requestKind: "persist_intent";
      operationId: CanonicalUuid;
      move: "intent_publish";
      sourceObjectId: FlightSemanticId;
      sourceEvidence: AtomicObjectEvidenceV1;
      rawCode: AtomicRawNativeCodeV1;
      nativePrecheckEvidenceDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "native_resolved";
      effectId: FlightEffectId;
      requestKind: "persist_manifest";
      operationId: CanonicalUuid;
      move: "manifest_publish";
      sourceObjectId: FlightSemanticId;
      sourceEvidence: AtomicObjectEvidenceV1;
      rawCode: AtomicRawNativeCodeV1;
      nativePrecheckEvidenceDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "locations_observed";
      effectId: FlightEffectId;
      requestKind: "native_no_replace";
      operationId: CanonicalUuid;
      move: AtomicNativeMoveV1;
      sourceParentId: FlightSemanticId;
      sourceLeaf: string;
      targetParentId: FlightSemanticId;
      targetLeaf: string;
      requestedSourceObjectId: FlightSemanticId | null;
      sourceObjectId: FlightSemanticId | null;
      targetObjectId: FlightSemanticId | null;
      source: CanonicalLocationEvidenceV1;
      target: CanonicalLocationEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "locations_observed";
      effectId: FlightEffectId;
      requestKind: "persist_intent";
      operationId: CanonicalUuid;
      move: "intent_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      requestedSourceObjectId: FlightSemanticId;
      sourceObjectId: FlightSemanticId | null;
      targetObjectId: FlightSemanticId | null;
      source: CanonicalLocationEvidenceV1;
      target: CanonicalLocationEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "locations_observed";
      effectId: FlightEffectId;
      requestKind: "persist_manifest";
      operationId: CanonicalUuid;
      move: "manifest_publish";
      tempParentId: FlightSemanticId;
      tempLeaf: string;
      stableParentId: FlightSemanticId;
      stableLeaf: string;
      requestedSourceObjectId: FlightSemanticId;
      sourceObjectId: FlightSemanticId | null;
      targetObjectId: FlightSemanticId | null;
      source: CanonicalLocationEvidenceV1;
      target: CanonicalLocationEvidenceV1;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "content_observed";
      effectId: FlightEffectId;
      requestKind: "canonicalize_tree_step" | "hash_content_chunk";
      cursor: number;
      byteSize: number;
      contentDigest: Sha256;
      evidenceDigest: Sha256;
    }>
  | Readonly<{
      kind: "authority_observed";
      effectId: FlightEffectId;
      requestKind:
        | "resolve_adoption"
        | "adopt_generation"
        | "release_publication";
      adopted: boolean;
      authorityDigest: Sha256;
      evidenceDigest: Sha256;
    }>;

export type ApplyAtomicEffectV1 = (
  request: AtomicEffectRequestV1,
) => Promise<AtomicEffectObservationV1>;

type WithoutEffectId<T> = T extends unknown ? Omit<T, "effectId"> : never;

export type AtomicEffectRequestDraftV1 =
  WithoutEffectId<AtomicEffectRequestV1>;

export type AtomicReadReservationsV1 = Readonly<{
  directoryEntries: number;
  directoryBytes: number;
  fileBytes: number;
}>;

export type AtomicReducerCursorsV1 = Readonly<{
  directory: number;
  file: number;
  content: number;
}>;

export type AtomicProtocolFailureV1 =
  | "invalid_state"
  | "invalid_request"
  | "observation_required"
  | "unexpected_observation"
  | "replayed_observation"
  | "effect_id_mismatch"
  | "request_kind_mismatch"
  | "observation_mismatch"
  | "bounds_exceeded"
  | "cursor_mismatch"
  | "reservation_missing"
  | "id_cap_exceeded"
  | "effect_rejected"
  | "partial_cleanup_failed"
  | "native_binding_invalid"
  | "native_ambiguous"
  | "native_unsupported"
  | "native_cross_device"
  | "native_denied"
  | "native_io"
  | "terminal_replay";

export type AtomicNativeClassificationV1 = Readonly<{
  outcome: "unpublished" | "conflict" | "published";
  nativeCode:
    | Exclude<AtomicRawNativeCodeV1, "atomic_publish_source_missing">
    | "atomic_publish_replay_completed";
  sourceMatches: boolean;
  targetMatches: boolean;
  targetOther: boolean;
  nativePrecheckEvidenceDigest: Sha256;
  locationEvidenceDigest: Sha256;
}>;

export type AtomicCanaryReplayAuthorityV1 = Readonly<{
  operationId: CanonicalUuid;
  attempt: 0;
  phase: "planned" | "published" | "deleting";
  sourceLeaf: string;
  targetLeaf: string;
  deletionLeaf: string;
  privateSourceEvidence: AtomicObjectEvidenceV1;
  publishedEvidence: AtomicObjectEvidenceV1 | null;
  privateDeletionEvidence: AtomicObjectEvidenceV1 | null;
  manifestSha256: Sha256 | null;
  cleanupNextIndex: number;
  cleanupEntryCount: number;
}>;

export type AtomicCanaryProofV1 = Readonly<{
  version: 1;
  operationId: CanonicalUuid;
  targetParentLocatorDigest: Sha256;
  targetParentEvidence: AtomicObjectEvidenceV1;
  wrapperEvidence: AtomicObjectEvidenceV1;
  attempt: 0;
  sourceLeaf: string;
  targetLeaf: string;
  deletionLeaf: string;
  phase: "planned" | "published" | "deleting" | "cleaned";
  privateSourceEvidence: AtomicObjectEvidenceV1;
  publishedEvidence: AtomicObjectEvidenceV1 | null;
  privateDeletionEvidence: AtomicObjectEvidenceV1 | null;
  classification: AtomicNativeClassificationV1 | null;
  manifestSha256: Sha256 | null;
  cleanupNextIndex: number;
  cleanupEntryCount: number;
  sourceParentSynced: boolean;
  targetParentSynced: boolean;
}>;

export type AtomicCanaryRecoveryInputV1 = Readonly<{
  flightNonce: string;
  action: "prove_mount" | "cleanup";
  proof: AtomicCanaryProofV1;
  unresolvedForTargetParent: ReadonlyArray<AtomicCanaryProofV1>;
  sourceParentId: FlightSemanticId;
  sourceParentRole: AtomicObjectRoleV1;
  sourceParentEvidence: AtomicObjectEvidenceV1;
  sourceId: FlightSemanticId;
  targetParentId: FlightSemanticId;
  targetParentRole: AtomicObjectRoleV1;
  targetParentEvidence: AtomicObjectEvidenceV1;
  cleanupManifest:
    | Readonly<{
        sha256: Sha256;
        entryCount: number;
        nextIndex: number;
      }>
    | null;
}>;

type AtomicCanaryWorkflowStageV1 =
  | "revalidate_source"
  | "revalidate_target"
  | "statfs_source"
  | "statfs_target"
  | "native"
  | "observe"
  | "sync_source"
  | "sync_target"
  | "persist_planned"
  | "persist_deleting"
  | "persist_published"
  | "persist_deleting_evidence"
  | "verify_published_locations";

type AtomicCanaryWorkflowV1 = Readonly<{
  action: AtomicCanaryRecoveryInputV1["action"];
  stage: AtomicCanaryWorkflowStageV1;
  durablePhase: "planned" | "published" | "deleting";
  proof: AtomicCanaryProofV1;
  sourceParentId: FlightSemanticId;
  sourceParentRole: AtomicObjectRoleV1;
  sourceParentEvidence: AtomicObjectEvidenceV1;
  sourceId: FlightSemanticId;
  targetParentId: FlightSemanticId;
  targetParentRole: AtomicObjectRoleV1;
  targetParentEvidence: AtomicObjectEvidenceV1;
  sourceFilesystem: string | null;
  sourceDevice: string | null;
  targetFilesystem: string | null;
  targetDevice: string | null;
}>;

type PendingAtomicNativeResolutionV1 = Readonly<{
  request: Extract<AtomicEffectRequestV1, { kind: "native_no_replace" }>;
  rawCode: AtomicRawNativeCodeV1;
  nativePrecheckEvidenceDigest: Sha256;
}>;

export type AtomicTerminalResultV1 =
  | Readonly<{ kind: "protocol_complete" }>
  | Readonly<{
      kind: "mount_proved";
      proof: AtomicCanaryProofV1;
    }>
  | Readonly<{
      kind: "cleanup_pending";
      proof: AtomicCanaryProofV1;
    }>
  | Readonly<{
      kind: "canary_cleaned";
      proof: AtomicCanaryProofV1;
    }>
  | Readonly<{
      kind: "fail_stop";
      code: AtomicProtocolFailureV1;
      retainedPartialId: FlightPartialCreateId | null;
      retainedReservations: AtomicReadReservationsV1;
    }>;

export type AtomicReducerStateV1 = Readonly<{
  version: 1;
  durableBytesBase64: string;
  flightNonce: string;
  stepCounter: number;
  semanticIdCount: number;
  partialCreateIdCount: number;
  semanticIds: ReadonlyArray<FlightSemanticId>;
  outstandingRequest: AtomicEffectRequestV1 | null;
  consumedEffectIds: ReadonlyArray<FlightEffectId>;
  consumedPartialIds: ReadonlyArray<FlightPartialCreateId>;
  activePartialId: FlightPartialCreateId | null;
  reservations: AtomicReadReservationsV1;
  cursors: AtomicReducerCursorsV1;
  admission: "open" | "closed";
  canaryWorkflow: AtomicCanaryWorkflowV1 | null;
  canaryReplayAuthority: AtomicCanaryReplayAuthorityV1 | null;
  pendingNativeResolution: PendingAtomicNativeResolutionV1 | null;
  nativeClassification: AtomicNativeClassificationV1 | null;
  pendingNativeFailure: AtomicProtocolFailureV1 | null;
  terminalResult: AtomicTerminalResultV1 | null;
}>;

export type AtomicReducerStepV1 =
  | Readonly<{
      kind: "effect";
      state: AtomicReducerStateV1;
      request: AtomicEffectRequestV1;
    }>
  | Readonly<{
      kind: "terminal";
      state: AtomicReducerStateV1;
      result: AtomicTerminalResultV1;
    }>;

export type CreateAtomicReducerStateV1 = Readonly<{
  flightNonce: string;
  request: AtomicEffectRequestDraftV1;
  durableBytesBase64?: string;
  semanticIds?: ReadonlyArray<FlightSemanticId>;
  semanticIdCount?: number;
  partialCreateIdCount?: number;
  reservations?: Partial<AtomicReadReservationsV1>;
  cursors?: Partial<AtomicReducerCursorsV1>;
  canaryReplayAuthority?: AtomicCanaryReplayAuthorityV1;
}>;

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalUuid(value: unknown): value is CanonicalUuid {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeEffectId(flightNonce: string, step: number): FlightEffectId {
  const id = {
    effect: true as const,
    [flightIdBrand]: true as const,
  };
  Object.defineProperties(id, {
    [effectNonce]: {
      value: flightNonce,
      enumerable: false,
      writable: false,
      configurable: false,
    },
    [effectStep]: {
      value: step,
      enumerable: false,
      writable: false,
      configurable: false,
    },
  });
  return Object.freeze(id);
}

function cloneEvidence(
  evidence: AtomicObjectEvidenceV1,
): AtomicObjectEvidenceV1 {
  return Object.freeze({ ...evidence });
}

function cloneExpectedTarget(
  expected:
    | AtomicObjectEvidenceV1
    | Readonly<{ absent: true }>,
): AtomicObjectEvidenceV1 | Readonly<{ absent: true }> {
  return "absent" in expected
    ? Object.freeze({ absent: true as const })
    : cloneEvidence(expected);
}

function cloneCanaryProof(
  proof: AtomicCanaryProofV1,
): AtomicCanaryProofV1 {
  return Object.freeze({
    ...proof,
    targetParentEvidence: cloneEvidence(proof.targetParentEvidence),
    wrapperEvidence: cloneEvidence(proof.wrapperEvidence),
    privateSourceEvidence: cloneEvidence(proof.privateSourceEvidence),
    publishedEvidence:
      proof.publishedEvidence === null
        ? null
        : cloneEvidence(proof.publishedEvidence),
    privateDeletionEvidence:
      proof.privateDeletionEvidence === null
        ? null
        : cloneEvidence(proof.privateDeletionEvidence),
    classification:
      proof.classification === null
        ? null
        : Object.freeze({ ...proof.classification }),
  });
}

function cloneRequest(
  request: AtomicEffectRequestDraftV1,
): AtomicEffectRequestDraftV1 {
  if (request.kind === "persist_canary_phase") {
    return { ...request, proof: cloneCanaryProof(request.proof) };
  }
  if (
    request.kind === "copy_payload_chunk" ||
    request.kind === "write_file_chunk"
  ) {
    return {
      ...request,
      inlineBytes:
        request.inlineBytes === null
          ? null
          : new Uint8Array(request.inlineBytes),
    };
  }
  if (
    request.kind === "persist_intent" ||
    request.kind === "persist_manifest"
  ) {
    return {
      ...request,
      canonicalBytes: new Uint8Array(request.canonicalBytes),
      expectedTemp: cloneEvidence(request.expectedTemp),
      expectedStable: Object.freeze({ absent: true as const }),
    };
  }
  if (request.kind === "replace_intent") {
    return {
      ...request,
      canonicalBytes: new Uint8Array(request.canonicalBytes),
      expectedTemp: cloneEvidence(request.expectedTemp),
      expectedStable: cloneEvidence(request.expectedStable),
    };
  }
  if (
    request.kind === "open_pin_handle" ||
    request.kind === "revalidate_handle" ||
    request.kind === "statfs_parent" ||
    request.kind === "close_handle" ||
    request.kind === "enumerate_directory" ||
    request.kind === "read_file_chunk" ||
    request.kind === "fsync_file" ||
    request.kind === "fsync_directory" ||
    request.kind === "fsync_parent" ||
    request.kind === "remove_file" ||
    request.kind === "remove_directory" ||
    request.kind === "remove_root"
  ) {
    return { ...request, expected: cloneEvidence(request.expected) };
  }
  if (
    request.kind === "remove_intent" ||
    request.kind === "remove_manifest"
  ) {
    return { ...request, expectedStable: cloneEvidence(request.expectedStable) };
  }
  if (request.kind === "native_no_replace") {
    return {
      ...request,
      expectedSource: cloneEvidence(request.expectedSource),
      expectedTarget: cloneExpectedTarget(request.expectedTarget),
    };
  }
  if (request.kind === "observe_locations") {
    return request.requestKind === "native_no_replace"
      ? {
          ...request,
          expectedSource: cloneEvidence(request.expectedSource),
          expectedTarget: cloneExpectedTarget(request.expectedTarget),
        }
      : {
          ...request,
          expectedTemp: cloneEvidence(request.expectedTemp),
          expectedTargetBefore: Object.freeze({ absent: true as const }),
          expectedTargetAfter: cloneEvidence(request.expectedTargetAfter),
        };
  }
  return request;
}

function attachEffectId(
  request: AtomicEffectRequestDraftV1,
  effectId: FlightEffectId,
): AtomicEffectRequestV1 {
  return Object.freeze({
    ...cloneRequest(request),
    effectId,
  }) as AtomicEffectRequestV1;
}

export function isAtomicControlLeafV1(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".."
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code > 0x7f || code === 0x2f || code === 0x5c) {
      return false;
    }
    const alphanumeric =
      (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
    const innerPunctuation = code === 0x2e || code === 0x5f || code === 0x2d;
    const edge = index === 0 || index + 1 === value.length;
    if (!alphanumeric && (edge || !innerPunctuation)) {
      return false;
    }
  }
  return true;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isAtomicPayloadLeafV1(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  try {
    const bytes = new TextEncoder().encode(value);
    return (
      bytes.byteLength >= 1 &&
      bytes.byteLength <= 255 &&
      new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value
    );
  } catch {
    return false;
  }
}

function validLeaf(role: AtomicObjectRoleV1, leaf: string): boolean {
  return role === "payload_entry"
    ? isAtomicPayloadLeafV1(leaf)
    : isAtomicControlLeafV1(leaf);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isOneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

const ATOMIC_OBJECT_ROLES = [
  "trusted_parent",
  "state_root",
  "profiles_parent",
  "staging_root",
  "intents_parent",
  "bundles_parent",
  "wrapper",
  "private_source",
  "payload_entry",
  "intent_temp",
  "intent_stable",
  "manifest_temp",
  "manifest_stable",
  "private_deletion",
  "public_source",
  "public_target",
] as const;

const ATOMIC_NATIVE_MOVES = [
  "profile_publish",
  "canary_publish",
  "profile_source_to_private",
  "canary_source_to_private",
] as const;

const ATOMIC_PUBLISH_PHASES = [
  "allocated",
  "building",
  "aborting_prepublication",
  "ready",
  "classified",
  "renamed",
  "manifest_planned",
  "manifest_published",
  "source_deleting",
  "adopted",
  "discarding",
  "manifest_deleting",
  "cleaned",
] as const;

const ATOMIC_EFFECT_KINDS = [
  "reserve_budget",
  "release_budget",
  "create_and_pin_wrapper",
  "create_and_pin_directory",
  "create_and_pin_file",
  "create_and_pin_temp_file",
  "cleanup_partial_create",
  "open_pin_handle",
  "revalidate_handle",
  "statfs_parent",
  "close_handle",
  "enumerate_directory",
  "read_file_chunk",
  "populate_payload_entry",
  "copy_payload_chunk",
  "write_file_chunk",
  "canonicalize_tree_step",
  "hash_content_chunk",
  "fsync_file",
  "fsync_directory",
  "fsync_parent",
  "persist_canary_phase",
  "persist_intent",
  "replace_intent",
  "remove_intent",
  "persist_manifest",
  "remove_manifest",
  "native_no_replace",
  "observe_locations",
  "remove_file",
  "remove_directory",
  "remove_root",
  "resolve_adoption",
  "adopt_generation",
  "release_publication",
  "close_admission",
] as const;

const EFFECT_COMPLETED_KINDS = [
  "reserve_budget",
  "release_budget",
  "revalidate_handle",
  "close_handle",
  "populate_payload_entry",
  "copy_payload_chunk",
  "write_file_chunk",
  "fsync_file",
  "fsync_directory",
  "fsync_parent",
  "persist_canary_phase",
  "replace_intent",
  "close_admission",
] as const;

function isFlightId(value: unknown): value is FlightSemanticId {
  return isRecord(value);
}

function isEvidence(value: unknown): value is AtomicObjectEvidenceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "dev",
      "ino",
      "mode",
      "size",
      "contentSha256",
      "evidenceDigest",
    ]) ||
    typeof value.dev !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.dev) ||
    typeof value.ino !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.ino) ||
    !isNonNegativeInteger(value.mode as number) ||
    !isNonNegativeInteger(value.size as number) ||
    !(
      value.contentSha256 === null ||
      (typeof value.contentSha256 === "string" &&
        isSha256(value.contentSha256))
    ) ||
    typeof value.evidenceDigest !== "string" ||
    !isSha256(value.evidenceDigest)
  ) {
    return false;
  }
  const canonical = JSON.stringify({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    size: value.size,
    contentSha256: value.contentSha256,
  });
  return (
    value.evidenceDigest ===
    sha256(new TextEncoder().encode(canonical))
  );
}

function isExpectedAbsent(
  value: unknown,
): value is Readonly<{ absent: true }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["absent"]) &&
    value.absent === true
  );
}

function evidenceEquals(
  left: AtomicObjectEvidenceV1,
  right: AtomicObjectEvidenceV1,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.contentSha256 === right.contentSha256 &&
    left.evidenceDigest === right.evidenceDigest
  );
}

function nativeMoveLeavesValid(
  move: AtomicNativeMoveV1,
  operationId: CanonicalUuid,
  sourceLeaf: string,
  targetLeaf: string,
): boolean {
  switch (move) {
    case "profile_publish":
      return sourceLeaf === "payload";
    case "canary_publish":
      return (
        sourceLeaf === `proof-${operationId}-0` &&
        targetLeaf === `canary-${operationId}-0`
      );
    case "profile_source_to_private":
      return targetLeaf === `delete-${operationId}`;
    case "canary_source_to_private":
      return (
        sourceLeaf === `canary-${operationId}-0` &&
        targetLeaf === `deletion-${operationId}-0`
      );
  }
}

function validRequest(value: unknown): value is AtomicEffectRequestV1 {
  if (
    !isRecord(value) ||
    !isOneOf(value.kind, ATOMIC_EFFECT_KINDS)
  ) {
    return false;
  }
  const request = value as AtomicEffectRequestV1;
  if (
    typeof request.operationId !== "string" ||
    !isCanonicalUuid(request.operationId) ||
    !isFlightId(request.effectId)
  ) {
    return false;
  }
  switch (request.kind) {
    case "reserve_budget":
    case "release_budget":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "reservation",
          "count",
          "byteSize",
        ]) &&
        isOneOf(request.reservation, [
          "payload_entries",
          "payload_bytes",
          "stable_files",
          "scratch_files",
          "manifest_bytes",
          "other_metadata_bytes",
        ]) &&
        isNonNegativeInteger(request.count) &&
        isNonNegativeInteger(request.byteSize)
      );
    case "persist_canary_phase":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "previousPhase",
          "proof",
          "evidenceDigest",
        ]) &&
        (request.previousPhase === null ||
          isOneOf(request.previousPhase, [
            "planned",
            "published",
            "deleting",
          ])) &&
        validCanaryProof(request.proof) &&
        request.proof.operationId === request.operationId &&
        ((request.previousPhase === null &&
          request.proof.phase === "planned") ||
          (request.previousPhase === "planned" &&
            request.proof.phase === "published") ||
          (request.previousPhase === "published" &&
            request.proof.phase === "deleting") ||
          (request.previousPhase === "deleting" &&
            (request.proof.phase === "deleting" ||
              request.proof.phase === "cleaned"))) &&
        isSha256(request.evidenceDigest)
      );
    case "create_and_pin_wrapper":
    case "create_and_pin_directory":
    case "create_and_pin_file":
    case "create_and_pin_temp_file":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "role",
          "parentId",
          "leaf",
          "parentEvidenceDigest",
          "mode",
          "expectedAbsence",
        ]) &&
        isOneOf(request.role, ATOMIC_OBJECT_ROLES) &&
        isFlightId(request.parentId) &&
        typeof request.leaf === "string" &&
        validLeaf(request.role, request.leaf) &&
        typeof request.parentEvidenceDigest === "string" &&
        isSha256(request.parentEvidenceDigest) &&
        (request.mode === 384 || request.mode === 448) &&
        request.expectedAbsence === true
      );
    case "cleanup_partial_create":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "partialId",
        ]) && isFlightId(request.partialId)
      );
    case "open_pin_handle":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "role",
          "parentId",
          "leaf",
          "flags",
          "expected",
        ]) &&
        isOneOf(request.role, ATOMIC_OBJECT_ROLES) &&
        isFlightId(request.parentId) &&
        typeof request.leaf === "string" &&
        validLeaf(request.role, request.leaf) &&
        isOneOf(request.flags, [
          "directory_nofollow",
          "file_read_nofollow",
          "file_write_nofollow",
          "path_nofollow",
        ]) &&
        isEvidence(request.expected)
      );
    case "revalidate_handle":
    case "close_handle":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "role",
          "objectId",
          "cursor",
          "byteLength",
          "expected",
        ]) &&
        isOneOf(request.role, ATOMIC_OBJECT_ROLES) &&
        isFlightId(request.objectId) &&
        isNonNegativeInteger(request.cursor) &&
        isNonNegativeInteger(request.byteLength) &&
        isEvidence(request.expected)
      );
    case "statfs_parent":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "role",
          "objectId",
          "expected",
        ]) &&
        isOneOf(request.role, ATOMIC_OBJECT_ROLES) &&
        isFlightId(request.objectId) &&
        isEvidence(request.expected)
      );
    case "enumerate_directory":
    case "read_file_chunk":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "role",
          "objectId",
          "cursor",
          "byteLength",
          "expected",
        ]) &&
        isOneOf(request.role, ATOMIC_OBJECT_ROLES) &&
        isFlightId(request.objectId) &&
        isNonNegativeInteger(request.cursor) &&
        request.byteLength > 0 &&
        request.byteLength <= ATOMIC_MAX_OBSERVATION_BYTES &&
        isEvidence(request.expected)
      );
    case "populate_payload_entry":
    case "canonicalize_tree_step":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "rootId",
          "cursor",
          "evidenceDigest",
        ]) &&
        isFlightId(request.rootId) &&
        isNonNegativeInteger(request.cursor) &&
        typeof request.evidenceDigest === "string" &&
        isSha256(request.evidenceDigest)
      );
    case "copy_payload_chunk":
    case "write_file_chunk": {
      const hasSource = request.sourceFileId !== null;
      const hasInline = request.inlineBytes !== null;
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "sourceFileId",
          "inlineBytes",
          "destinationFileId",
          "offset",
          "byteLength",
          "expectedChunkSha256",
          "expectedResultSha256",
        ]) &&
        (request.sourceFileId === null || isFlightId(request.sourceFileId)) &&
        (request.inlineBytes === null ||
          request.inlineBytes instanceof Uint8Array) &&
        isFlightId(request.destinationFileId) &&
        hasSource !== hasInline &&
        isNonNegativeInteger(request.offset) &&
        request.byteLength > 0 &&
        request.byteLength <= ATOMIC_MAX_OBSERVATION_BYTES &&
        (request.inlineBytes === null ||
          (request.inlineBytes.byteLength === request.byteLength &&
            sha256(request.inlineBytes) === request.expectedChunkSha256)) &&
        isSha256(request.expectedChunkSha256) &&
        isSha256(request.expectedResultSha256)
      );
    }
    case "hash_content_chunk":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "objectId",
          "offset",
          "byteLength",
          "evidenceDigest",
        ]) &&
        isFlightId(request.objectId) &&
        isNonNegativeInteger(request.offset) &&
        request.byteLength > 0 &&
        request.byteLength <= ATOMIC_MAX_OBSERVATION_BYTES &&
        isSha256(request.evidenceDigest)
      );
    case "fsync_file":
    case "fsync_directory":
    case "fsync_parent":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "role",
          "objectId",
          "expected",
        ]) &&
        isOneOf(request.role, ATOMIC_OBJECT_ROLES) &&
        isFlightId(request.objectId) &&
        isEvidence(request.expected)
      );
    case "persist_intent":
    case "persist_manifest":
    case "replace_intent":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "expectedPhase",
          "canonicalBytes",
          "contentDigest",
          "tempParentId",
          "tempLeaf",
          "tempObjectId",
          "expectedTemp",
          "stableParentId",
          "stableLeaf",
          "expectedStable",
        ]) &&
        (request.expectedPhase === null ||
          isOneOf(request.expectedPhase, ATOMIC_PUBLISH_PHASES)) &&
        request.canonicalBytes instanceof Uint8Array &&
        isSha256(request.contentDigest) &&
        sha256(request.canonicalBytes) === request.contentDigest &&
        isFlightId(request.tempParentId) &&
        isFlightId(request.tempObjectId) &&
        isFlightId(request.stableParentId) &&
        isAtomicControlLeafV1(request.tempLeaf) &&
        isAtomicControlLeafV1(request.stableLeaf) &&
        isEvidence(request.expectedTemp) &&
        (request.kind === "replace_intent"
          ? request.expectedPhase !== null &&
            isEvidence(request.expectedStable)
          : isExpectedAbsent(request.expectedStable))
      );
    case "remove_intent":
    case "remove_manifest":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "stableParentId",
          "stableLeaf",
          "stableObjectId",
          "expectedStable",
        ]) &&
        isFlightId(request.stableParentId) &&
        isFlightId(request.stableObjectId) &&
        isAtomicControlLeafV1(request.stableLeaf) &&
        isEvidence(request.expectedStable)
      );
    case "native_no_replace":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "move",
          "sourceParentId",
          "sourceId",
          "sourceLeaf",
          "targetParentId",
          "targetLeaf",
          "expectedSource",
          "expectedTarget",
          "evidenceDigest",
        ]) &&
        isOneOf(request.move, ATOMIC_NATIVE_MOVES) &&
        isFlightId(request.sourceParentId) &&
        isFlightId(request.sourceId) &&
        isFlightId(request.targetParentId) &&
        isAtomicControlLeafV1(request.sourceLeaf) &&
        isAtomicControlLeafV1(request.targetLeaf) &&
        nativeMoveLeavesValid(
          request.move,
          request.operationId,
          request.sourceLeaf,
          request.targetLeaf,
        ) &&
        isEvidence(request.expectedSource) &&
        (isEvidence(request.expectedTarget) ||
          isExpectedAbsent(request.expectedTarget)) &&
        isSha256(request.evidenceDigest)
      );
    case "observe_locations":
      if (request.requestKind === "native_no_replace") {
        return (
          hasExactKeys(value, [
            "kind",
            "requestKind",
            "effectId",
            "operationId",
            "move",
            "sourceParentId",
            "sourceId",
            "sourceLeaf",
            "targetParentId",
            "targetLeaf",
            "expectedSource",
            "expectedTarget",
            "evidenceDigest",
          ]) &&
            isOneOf(request.move, ATOMIC_NATIVE_MOVES) &&
            isFlightId(request.sourceParentId) &&
            (request.sourceId === null || isFlightId(request.sourceId)) &&
            isFlightId(request.targetParentId) &&
            isAtomicControlLeafV1(request.sourceLeaf) &&
            isAtomicControlLeafV1(request.targetLeaf) &&
            nativeMoveLeavesValid(
              request.move,
              request.operationId,
              request.sourceLeaf,
              request.targetLeaf,
            ) &&
            isEvidence(request.expectedSource) &&
            (isEvidence(request.expectedTarget) ||
              isExpectedAbsent(request.expectedTarget)) &&
            isSha256(request.evidenceDigest)
        );
      }
      return (
        (request.requestKind === "persist_intent" ||
          request.requestKind === "persist_manifest") &&
        hasExactKeys(value, [
          "kind",
          "requestKind",
          "effectId",
          "operationId",
          "move",
          "tempParentId",
          "tempLeaf",
          "tempObjectId",
          "expectedTemp",
          "stableParentId",
          "stableLeaf",
          "expectedTargetBefore",
          "expectedTargetAfter",
          "evidenceDigest",
        ]) &&
            request.move ===
              (request.requestKind === "persist_intent"
                ? "intent_publish"
                : "manifest_publish") &&
            isFlightId(request.tempParentId) &&
            isFlightId(request.tempObjectId) &&
            isFlightId(request.stableParentId) &&
            isAtomicControlLeafV1(request.tempLeaf) &&
            isAtomicControlLeafV1(request.stableLeaf) &&
            isEvidence(request.expectedTemp) &&
            isExpectedAbsent(request.expectedTargetBefore) &&
            isEvidence(request.expectedTargetAfter) &&
            isSha256(request.evidenceDigest)
      );
    case "remove_file":
    case "remove_directory":
    case "remove_root":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "role",
          "parentId",
          "leaf",
          "objectId",
          "expected",
          "manifestSha256",
          "cursor",
        ]) &&
        isOneOf(request.role, ATOMIC_OBJECT_ROLES) &&
        isFlightId(request.parentId) &&
        isFlightId(request.objectId) &&
        typeof request.leaf === "string" &&
        validLeaf(request.role, request.leaf) &&
        isEvidence(request.expected) &&
        isSha256(request.manifestSha256) &&
        isNonNegativeInteger(request.cursor)
      );
    case "resolve_adoption":
    case "adopt_generation":
    case "release_publication":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "authorityDigest",
        ]) && isSha256(request.authorityDigest)
      );
    case "close_admission":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "operationId",
          "reason",
          "evidenceDigest",
        ]) &&
        isOneOf(request.reason, [
          "binding_invalid",
          "ambiguous",
          "unsupported",
          "cross_device",
          "denied",
          "io",
          "close_unverified",
        ]) &&
        isSha256(request.evidenceDigest)
      );
  }
}

function validCount(value: number | undefined): value is number {
  return value === undefined || isNonNegativeInteger(value);
}

export function createAtomicReducerState(
  input: CreateAtomicReducerStateV1,
): AtomicReducerStateV1 {
  if (
    input.flightNonce.length === 0 ||
    !validCount(input.semanticIdCount) ||
    !validCount(input.partialCreateIdCount)
  ) {
    throw new TypeError("invalid atomic reducer state");
  }
  const semanticIds = Object.freeze([...(input.semanticIds ?? [])]);
  if (new Set(semanticIds).size !== semanticIds.length) {
    throw new TypeError("duplicate initial semantic id");
  }
  const semanticIdCount = input.semanticIdCount ?? semanticIds.length;
  const partialCreateIdCount = input.partialCreateIdCount ?? 0;
  if (
    semanticIdCount < semanticIds.length ||
    partialCreateIdCount > ATOMIC_MAX_PARTIAL_CREATE_IDS ||
    semanticIdCount + partialCreateIdCount > ATOMIC_MAX_TRACKED_IDS
  ) {
    throw new RangeError("atomic reducer id cap exceeded");
  }
  const reservations = Object.freeze({
    directoryEntries: input.reservations?.directoryEntries ?? 0,
    directoryBytes: input.reservations?.directoryBytes ?? 0,
    fileBytes: input.reservations?.fileBytes ?? 0,
  });
  const cursors = Object.freeze({
    directory: input.cursors?.directory ?? 0,
    file: input.cursors?.file ?? 0,
    content: input.cursors?.content ?? 0,
  });
  if (
    !isNonNegativeInteger(reservations.directoryEntries) ||
    !isNonNegativeInteger(reservations.directoryBytes) ||
    !isNonNegativeInteger(reservations.fileBytes) ||
    !isNonNegativeInteger(cursors.directory) ||
    !isNonNegativeInteger(cursors.file) ||
    !isNonNegativeInteger(cursors.content)
  ) {
    throw new TypeError("invalid atomic reducer bounds");
  }
  if (
    input.canaryReplayAuthority !== undefined &&
    !validCanaryReplayAuthority(input.canaryReplayAuthority)
  ) {
    throw new TypeError("invalid atomic canary replay authority");
  }
  const effectId = makeEffectId(input.flightNonce, 0);
  const outstandingRequest = attachEffectId(input.request, effectId);
  if (!validRequest(outstandingRequest)) {
    throw new TypeError("invalid atomic effect request");
  }
  return Object.freeze({
    version: 1 as const,
    durableBytesBase64: input.durableBytesBase64 ?? "",
    flightNonce: input.flightNonce,
    stepCounter: 1,
    semanticIdCount,
    partialCreateIdCount,
    semanticIds,
    outstandingRequest,
    consumedEffectIds: Object.freeze([]),
    consumedPartialIds: Object.freeze([]),
    activePartialId: null,
    reservations,
    cursors,
    admission: "open" as const,
    canaryWorkflow: null,
    canaryReplayAuthority:
      input.canaryReplayAuthority === undefined
        ? null
        : Object.freeze({
            ...input.canaryReplayAuthority,
            privateSourceEvidence: cloneEvidence(
              input.canaryReplayAuthority.privateSourceEvidence,
            ),
            publishedEvidence:
              input.canaryReplayAuthority.publishedEvidence === null
                ? null
                : cloneEvidence(
                    input.canaryReplayAuthority.publishedEvidence,
                  ),
            privateDeletionEvidence:
              input.canaryReplayAuthority.privateDeletionEvidence === null
                ? null
                : cloneEvidence(
                    input.canaryReplayAuthority.privateDeletionEvidence,
                  ),
          }),
    pendingNativeResolution: null,
    nativeClassification: null,
    pendingNativeFailure: null,
    terminalResult: null,
  });
}

function canaryReplayAuthorityFromProof(
  proof: AtomicCanaryProofV1,
): AtomicCanaryReplayAuthorityV1 | null {
  if (proof.phase === "cleaned") return null;
  return Object.freeze({
    operationId: proof.operationId,
    attempt: 0 as const,
    phase: proof.phase,
    sourceLeaf: proof.sourceLeaf,
    targetLeaf: proof.targetLeaf,
    deletionLeaf: proof.deletionLeaf,
    privateSourceEvidence: proof.privateSourceEvidence,
    publishedEvidence: proof.publishedEvidence,
    privateDeletionEvidence: proof.privateDeletionEvidence,
    manifestSha256: proof.manifestSha256,
    cleanupNextIndex: proof.cleanupNextIndex,
    cleanupEntryCount: proof.cleanupEntryCount,
  });
}

export function createAtomicCanaryReducerState(
  input: AtomicCanaryRecoveryInputV1,
): AtomicReducerStateV1 {
  if (
    !validCanaryProof(input.proof) ||
    input.proof.phase === "cleaned" ||
    input.unresolvedForTargetParent.length > 1 ||
    (input.unresolvedForTargetParent.length === 1 &&
      (!validCanaryProof(input.unresolvedForTargetParent[0]!) ||
        JSON.stringify(input.unresolvedForTargetParent[0]) !==
          JSON.stringify(input.proof))) ||
    !isFlightId(input.sourceParentId) ||
    !isOneOf(input.sourceParentRole, ATOMIC_OBJECT_ROLES) ||
    !isEvidence(input.sourceParentEvidence) ||
    !isFlightId(input.sourceId) ||
    !isFlightId(input.targetParentId) ||
    !isOneOf(input.targetParentRole, ATOMIC_OBJECT_ROLES) ||
    !isEvidence(input.targetParentEvidence)
  ) {
    throw new TypeError("invalid atomic canary recovery input");
  }
  let proof = input.proof;
  const durablePhase = proof.phase as
    | "planned"
    | "published"
    | "deleting";
  let persistDeleting = false;
  const persistPlanned =
    input.action === "prove_mount" &&
    proof.phase === "planned" &&
    input.unresolvedForTargetParent.length === 0;
  if (input.action === "prove_mount") {
    if (
      (proof.phase !== "planned" && proof.phase !== "published") ||
      input.sourceParentRole !== "wrapper" ||
      !evidenceEquals(input.sourceParentEvidence, proof.wrapperEvidence) ||
      !evidenceEquals(
        input.targetParentEvidence,
        proof.targetParentEvidence,
      ) ||
      (input.unresolvedForTargetParent.length === 0 &&
        proof.phase !== "planned")
    ) {
      throw new TypeError("invalid atomic canary mount proof input");
    }
  } else {
    if (
      (proof.phase !== "published" && proof.phase !== "deleting") ||
      proof.publishedEvidence === null ||
      !evidenceEquals(
        input.sourceParentEvidence,
        proof.targetParentEvidence,
      ) ||
      input.targetParentRole !== "wrapper" ||
      !evidenceEquals(input.targetParentEvidence, proof.wrapperEvidence) ||
      input.cleanupManifest === null ||
      !isSha256(input.cleanupManifest.sha256) ||
      !isNonNegativeInteger(input.cleanupManifest.entryCount) ||
      input.cleanupManifest.entryCount < 1 ||
      !isNonNegativeInteger(input.cleanupManifest.nextIndex) ||
      input.cleanupManifest.nextIndex >=
        input.cleanupManifest.entryCount
    ) {
      throw new TypeError("invalid atomic canary cleanup input");
    }
    if (proof.phase === "published") {
      persistDeleting = true;
      proof = Object.freeze({
        ...proof,
        phase: "deleting" as const,
        manifestSha256: input.cleanupManifest.sha256,
        cleanupNextIndex: input.cleanupManifest.nextIndex,
        cleanupEntryCount: input.cleanupManifest.entryCount,
        sourceParentSynced: false,
        targetParentSynced: false,
      });
    } else if (
      proof.manifestSha256 !== input.cleanupManifest.sha256 ||
      proof.cleanupNextIndex !== input.cleanupManifest.nextIndex ||
      proof.cleanupEntryCount !== input.cleanupManifest.entryCount
    ) {
      throw new TypeError("atomic canary cleanup cursor changed");
    }
  }

  const replayAuthority = canaryReplayAuthorityFromProof(proof);
  const base = createAtomicReducerState({
    flightNonce: input.flightNonce,
    request: persistDeleting || persistPlanned
      ? {
          kind: "persist_canary_phase",
          operationId: proof.operationId,
          previousPhase: persistDeleting ? "published" : null,
          proof,
          evidenceDigest: sha256(
            new TextEncoder().encode(JSON.stringify(proof)),
          ),
        }
      : {
          kind: "revalidate_handle",
          operationId: proof.operationId,
          role: input.sourceParentRole,
          objectId: input.sourceParentId,
          cursor: 0,
          byteLength: 0,
          expected: input.sourceParentEvidence,
        },
    semanticIds: [
      input.sourceParentId,
      input.sourceId,
      input.targetParentId,
    ],
    ...(replayAuthority === null
      ? {}
      : { canaryReplayAuthority: replayAuthority }),
  });
  const workflow: AtomicCanaryWorkflowV1 = Object.freeze({
    action: input.action,
    stage: persistDeleting
      ? ("persist_deleting" as const)
      : persistPlanned
        ? ("persist_planned" as const)
        : ("revalidate_source" as const),
    durablePhase,
    proof,
    sourceParentId: input.sourceParentId,
    sourceParentRole: input.sourceParentRole,
    sourceParentEvidence: input.sourceParentEvidence,
    sourceId: input.sourceId,
    targetParentId: input.targetParentId,
    targetParentRole: input.targetParentRole,
    targetParentEvidence: input.targetParentEvidence,
    sourceFilesystem: null,
    sourceDevice: null,
    targetFilesystem: null,
    targetDevice: null,
  });
  return Object.freeze({ ...base, canaryWorkflow: workflow });
}

export type AtomicCanaryCleanupProgressV1 = Readonly<{
  operationId: CanonicalUuid;
  manifestSha256: Sha256;
  completedIndex: number;
  nextIndex: number;
  privateDeletionAbsent: boolean;
  sourceParentSynced: boolean;
  targetParentSynced: boolean;
  evidenceDigest: Sha256;
}>;

export function advanceAtomicCanaryCleanup(
  proof: AtomicCanaryProofV1,
  progress: AtomicCanaryCleanupProgressV1,
): AtomicCanaryProofV1 {
  if (
    !validCanaryProof(proof) ||
    proof.phase !== "deleting" ||
    proof.privateDeletionEvidence === null ||
    progress.operationId !== proof.operationId ||
    progress.manifestSha256 !== proof.manifestSha256 ||
    progress.completedIndex !== proof.cleanupNextIndex ||
    progress.nextIndex !== progress.completedIndex + 1 ||
    progress.nextIndex > proof.cleanupEntryCount ||
    typeof progress.privateDeletionAbsent !== "boolean" ||
    progress.sourceParentSynced !== true ||
    progress.targetParentSynced !== true ||
    !isSha256(progress.evidenceDigest) ||
    (progress.nextIndex === proof.cleanupEntryCount) !==
      progress.privateDeletionAbsent
  ) {
    throw new TypeError("invalid atomic canary cleanup progress");
  }
  return Object.freeze({
    ...proof,
    phase:
      progress.nextIndex === proof.cleanupEntryCount
        ? ("cleaned" as const)
        : ("deleting" as const),
    cleanupNextIndex: progress.nextIndex,
    sourceParentSynced: true,
    targetParentSynced: true,
  });
}

function requestKindForObservation(
  observation: AtomicEffectObservationV1,
): AtomicEffectKindV1 | null {
  switch (observation.kind) {
    case "effect_rejected":
    case "effect_completed":
    case "create_and_pin_completed":
    case "create_and_pin_partial":
    case "removal_observed":
    case "native_resolved":
    case "content_observed":
    case "authority_observed":
      return observation.requestKind;
    case "existing_handle_pinned":
      return "open_pin_handle";
    case "statfs_observed":
      return "statfs_parent";
    case "partial_create_cleanup_observed":
    case "partial_create_cleanup_failed":
      return "cleanup_partial_create";
    case "directory_observed":
      return "enumerate_directory";
    case "file_chunk_observed":
      return "read_file_chunk";
    case "locations_observed":
      return "observe_locations";
    default:
      return null;
  }
}

function partialCleanupFailureCorrelates(
  observation: Extract<
    AtomicEffectObservationV1,
    { kind: "partial_create_cleanup_failed" }
  >,
): boolean {
  switch (observation.stage) {
    case "close":
      return (
        (observation.state === "unknown" ||
          observation.state === "absent_unsynced") &&
        observation.code === "close_unverified"
      );
    case "identity_verify":
      return (
        observation.state === "present" &&
        observation.code === "binding_invalid"
      );
    case "remove":
      return (
        observation.state === "unknown" &&
        (observation.code === "binding_invalid" ||
          observation.code === "denied" ||
          observation.code === "io")
      );
    case "absence_verify":
      return (
        observation.state === "unknown" &&
        (observation.code === "binding_invalid" ||
          observation.code === "io")
      );
    case "parent_fsync":
      return (
        observation.state === "absent_unsynced" &&
        observation.code === "io"
      );
  }
}

function locationEvidenceShapeValid(value: unknown): value is CanonicalLocationEvidenceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "state",
      "objectId",
      "dev",
      "ino",
      "mode",
      "evidence",
      "evidenceDigest",
    ]) ||
    !isOneOf(value.state, ["absent", "match", "other"]) ||
    (value.objectId !== null && !isFlightId(value.objectId)) ||
    (value.dev !== null && typeof value.dev !== "string") ||
    (value.ino !== null && typeof value.ino !== "string") ||
    (value.mode !== null && !isNonNegativeInteger(value.mode as number)) ||
    (value.evidence !== null && !isEvidence(value.evidence)) ||
    typeof value.evidenceDigest !== "string" ||
    !isSha256(value.evidenceDigest)
  ) {
    return false;
  }
  return true;
}

function validObservation(value: unknown): value is AtomicEffectObservationV1 {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "effect_rejected":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "code",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isOneOf(value.requestKind, ATOMIC_EFFECT_KINDS) &&
        isOneOf(value.code, [
          "budget_exceeded",
          "binding_invalid",
          "conflict",
          "unsupported",
          "denied",
          "io",
          "close_unverified",
        ]) &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest)
      );
    case "effect_completed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "evidenceDigest",
          "count",
          "byteSize",
        ]) &&
        isFlightId(value.effectId) &&
        isOneOf(value.requestKind, EFFECT_COMPLETED_KINDS) &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest) &&
        isNonNegativeInteger(value.count as number) &&
        isNonNegativeInteger(value.byteSize as number)
      );
    case "create_and_pin_completed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "handleId",
          "evidence",
        ]) &&
        isFlightId(value.effectId) &&
        isOneOf(value.requestKind, [
          "create_and_pin_wrapper",
          "create_and_pin_directory",
          "create_and_pin_file",
          "create_and_pin_temp_file",
        ]) &&
        isFlightId(value.handleId) &&
        isEvidence(value.evidence)
      );
    case "statfs_observed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "objectId",
          "filesystem",
          "magic",
          "device",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isFlightId(value.objectId) &&
        isOneOf(value.filesystem, [
          "ext",
          "xfs",
          "btrfs",
          "tmpfs",
          "overlay",
        ]) &&
        isOneOf(value.magic, [
          "0xef53",
          "0x58465342",
          "0x9123683e",
          "0x1021994",
          "0x794c7630",
        ]) &&
        /^(?:0|[1-9][0-9]*)$/u.test(value.device as string) &&
        isSha256(value.evidenceDigest)
      );
    case "existing_handle_pinned":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "handleId",
          "evidence",
        ]) &&
        isFlightId(value.effectId) &&
        isFlightId(value.handleId) &&
        isEvidence(value.evidence)
      );
    case "create_and_pin_partial": {
      if (
        !hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "partialId",
          "stage",
          "entryCreated",
          "handleOpened",
          "evidence",
          "code",
          "evidenceDigest",
        ]) ||
        !isFlightId(value.effectId) ||
        !isFlightId(value.partialId) ||
        !isOneOf(value.requestKind, [
          "create_and_pin_wrapper",
          "create_and_pin_directory",
          "create_and_pin_file",
          "create_and_pin_temp_file",
        ]) ||
        !isOneOf(value.stage, [
          "entry_created",
          "handle_opened",
          "fstat_failed",
        ]) ||
        value.entryCreated !== true ||
        !isOneOf(value.code, ["binding_invalid", "denied", "io"]) ||
        typeof value.evidenceDigest !== "string" ||
        !isSha256(value.evidenceDigest)
      ) {
        return false;
      }
      if (value.stage === "entry_created") {
        return value.handleOpened === false && value.evidence === null;
      }
      if (value.stage === "fstat_failed") {
        return value.handleOpened === true && value.evidence === null;
      }
      return value.handleOpened === true && isEvidence(value.evidence);
    }
    case "partial_create_cleanup_observed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "partialId",
          "state",
          "parentSynced",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isFlightId(value.partialId) &&
        value.state === "absent" &&
        value.parentSynced === true &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest)
      );
    case "partial_create_cleanup_failed": {
      if (
        !hasExactKeys(value, [
          "kind",
          "effectId",
          "partialId",
          "stage",
          "state",
          "parentSynced",
          "code",
          "evidenceDigest",
        ]) ||
        !isFlightId(value.effectId) ||
        !isFlightId(value.partialId) ||
        !isOneOf(value.stage, [
          "close",
          "identity_verify",
          "remove",
          "absence_verify",
          "parent_fsync",
        ]) ||
        !isOneOf(value.state, ["present", "unknown", "absent_unsynced"]) ||
        value.parentSynced !== false ||
        !isOneOf(value.code, [
          "binding_invalid",
          "denied",
          "io",
          "close_unverified",
        ]) ||
        typeof value.evidenceDigest !== "string" ||
        !isSha256(value.evidenceDigest)
      ) {
        return false;
      }
      return partialCleanupFailureCorrelates(
        value as Extract<
          AtomicEffectObservationV1,
          { kind: "partial_create_cleanup_failed" }
        >,
      );
    }
    case "removal_observed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "objectId",
          "removedEvidence",
          "state",
          "parentSynced",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isOneOf(value.requestKind, [
          "remove_intent",
          "remove_manifest",
          "remove_file",
          "remove_directory",
          "remove_root",
        ]) &&
        isFlightId(value.objectId) &&
        isEvidence(value.removedEvidence) &&
        value.state === "absent" &&
        value.parentSynced === true &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest)
      );
    case "directory_observed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "cursor",
          "entries",
          "done",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isNonNegativeInteger(value.cursor as number) &&
        Array.isArray(value.entries) &&
        value.entries.every(
          entry =>
            isRecord(entry) &&
            hasExactKeys(entry, [
              "leaf",
              "role",
              "objectId",
              "type",
              "evidenceDigest",
            ]) &&
            typeof entry.leaf === "string" &&
            isOneOf(entry.role, ATOMIC_OBJECT_ROLES) &&
            isFlightId(entry.objectId) &&
            isOneOf(entry.type, ["file", "directory"]) &&
            typeof entry.evidenceDigest === "string" &&
            isSha256(entry.evidenceDigest),
        ) &&
        typeof value.done === "boolean" &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest)
      );
    case "file_chunk_observed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "cursor",
          "byteSize",
          "bytesBase64",
          "contentDigest",
          "eof",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isNonNegativeInteger(value.cursor as number) &&
        isNonNegativeInteger(value.byteSize as number) &&
        typeof value.bytesBase64 === "string" &&
        typeof value.contentDigest === "string" &&
        isSha256(value.contentDigest) &&
        typeof value.eof === "boolean" &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest)
      );
    case "native_resolved": {
      if (
        !hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "operationId",
          "move",
          "sourceObjectId",
          "sourceEvidence",
          "rawCode",
          "nativePrecheckEvidenceDigest",
          "evidenceDigest",
        ]) ||
        !isFlightId(value.effectId) ||
        !isOneOf(value.requestKind, [
          "native_no_replace",
          "persist_intent",
          "persist_manifest",
        ]) ||
        typeof value.operationId !== "string" ||
        !isCanonicalUuid(value.operationId) ||
        !isFlightId(value.sourceObjectId) ||
        !isEvidence(value.sourceEvidence) ||
        !isOneOf(value.rawCode, [
          "success",
          "atomic_publish_exists",
          "atomic_publish_source_missing",
          "atomic_publish_unsupported",
          "atomic_publish_cross_device",
          "atomic_publish_binding_invalid",
          "atomic_publish_denied",
          "atomic_publish_invalid_argument",
          "atomic_publish_io",
        ]) ||
        typeof value.nativePrecheckEvidenceDigest !== "string" ||
        !isSha256(value.nativePrecheckEvidenceDigest) ||
        typeof value.evidenceDigest !== "string" ||
        !isSha256(value.evidenceDigest)
      ) {
        return false;
      }
      return value.requestKind === "native_no_replace"
        ? isOneOf(value.move, ATOMIC_NATIVE_MOVES)
        : value.move ===
            (value.requestKind === "persist_intent"
              ? "intent_publish"
              : "manifest_publish");
    }
    case "locations_observed": {
      const common =
        isFlightId(value.effectId) &&
        typeof value.operationId === "string" &&
        isCanonicalUuid(value.operationId) &&
        (value.sourceObjectId === null || isFlightId(value.sourceObjectId)) &&
        (value.targetObjectId === null || isFlightId(value.targetObjectId)) &&
        locationEvidenceShapeValid(value.source) &&
        locationEvidenceShapeValid(value.target) &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest);
      if (value.requestKind === "native_no_replace") {
        return (
          hasExactKeys(value, [
            "kind",
            "effectId",
            "requestKind",
            "operationId",
            "move",
            "sourceParentId",
            "sourceLeaf",
            "targetParentId",
            "targetLeaf",
            "requestedSourceObjectId",
            "sourceObjectId",
            "targetObjectId",
            "source",
            "target",
            "evidenceDigest",
          ]) &&
          common &&
          isOneOf(value.move, ATOMIC_NATIVE_MOVES) &&
          isFlightId(value.sourceParentId) &&
          typeof value.sourceLeaf === "string" &&
          isAtomicControlLeafV1(value.sourceLeaf) &&
          isFlightId(value.targetParentId) &&
          typeof value.targetLeaf === "string" &&
          isAtomicControlLeafV1(value.targetLeaf) &&
          (value.requestedSourceObjectId === null ||
            isFlightId(value.requestedSourceObjectId))
        );
      }
      return (
        (value.requestKind === "persist_intent" ||
          value.requestKind === "persist_manifest") &&
        hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "operationId",
          "move",
          "tempParentId",
          "tempLeaf",
          "stableParentId",
          "stableLeaf",
          "requestedSourceObjectId",
          "sourceObjectId",
          "targetObjectId",
          "source",
          "target",
          "evidenceDigest",
        ]) &&
        common &&
        value.move ===
          (value.requestKind === "persist_intent"
            ? "intent_publish"
            : "manifest_publish") &&
        isFlightId(value.tempParentId) &&
        typeof value.tempLeaf === "string" &&
        isAtomicControlLeafV1(value.tempLeaf) &&
        isFlightId(value.stableParentId) &&
        typeof value.stableLeaf === "string" &&
        isAtomicControlLeafV1(value.stableLeaf) &&
        isFlightId(value.requestedSourceObjectId)
      );
    }
    case "content_observed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "cursor",
          "byteSize",
          "contentDigest",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isOneOf(value.requestKind, [
          "canonicalize_tree_step",
          "hash_content_chunk",
        ]) &&
        isNonNegativeInteger(value.cursor as number) &&
        isNonNegativeInteger(value.byteSize as number) &&
        typeof value.contentDigest === "string" &&
        isSha256(value.contentDigest) &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest)
      );
    case "authority_observed":
      return (
        hasExactKeys(value, [
          "kind",
          "effectId",
          "requestKind",
          "adopted",
          "authorityDigest",
          "evidenceDigest",
        ]) &&
        isFlightId(value.effectId) &&
        isOneOf(value.requestKind, [
          "resolve_adoption",
          "adopt_generation",
          "release_publication",
        ]) &&
        typeof value.adopted === "boolean" &&
        typeof value.authorityDigest === "string" &&
        isSha256(value.authorityDigest) &&
        typeof value.evidenceDigest === "string" &&
        isSha256(value.evidenceDigest)
      );
    default:
      return false;
  }
}

function terminal(
  state: AtomicReducerStateV1,
  result: AtomicTerminalResultV1,
): AtomicReducerStepV1 {
  const terminalState: AtomicReducerStateV1 = Object.freeze({
    ...state,
    outstandingRequest: null,
    admission: result.kind === "fail_stop" ? "closed" : state.admission,
    terminalResult: result,
  });
  return Object.freeze({
    kind: "terminal" as const,
    state: terminalState,
    result,
  });
}

function fail(
  state: AtomicReducerStateV1,
  code: AtomicProtocolFailureV1,
): AtomicReducerStepV1 {
  return terminal(
    state,
    Object.freeze({
      kind: "fail_stop" as const,
      code,
      retainedPartialId: state.activePartialId,
      retainedReservations: state.reservations,
    }),
  );
}

function completed(
  state: AtomicReducerStateV1,
): AtomicReducerStepV1 {
  return terminal(state, Object.freeze({ kind: "protocol_complete" as const }));
}

function base64DecodedLength(value: string): number | null {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeCanonicalBase64(value: string): Uint8Array | null {
  const expectedLength = base64DecodedLength(value);
  if (expectedLength === null) {
    return null;
  }
  try {
    const binary = atob(value);
    if (binary.length !== expectedLength || btoa(binary) !== value) {
      return null;
    }
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function locationEvidenceValid(
  location: CanonicalLocationEvidenceV1,
  explicitObjectId: FlightSemanticId | null,
): boolean {
  if (!isSha256(location.evidenceDigest) || location.objectId !== explicitObjectId) {
    return false;
  }
  if (location.state === "absent") {
    return (
      explicitObjectId === null &&
      location.dev === null &&
      location.ino === null &&
      location.mode === null &&
      location.evidence === null
    );
  }
  return (
    explicitObjectId !== null &&
    location.dev !== null &&
    location.ino !== null &&
    location.mode !== null &&
    location.evidence !== null &&
    isEvidence(location.evidence) &&
    location.evidence.dev === location.dev &&
    location.evidence.ino === location.ino &&
    location.evidence.mode === location.mode
  );
}

function directoryObservationValid(
  request: AtomicEffectRequestV1 & { kind: "enumerate_directory" },
  observation: Extract<
    AtomicEffectObservationV1,
    { kind: "directory_observed" }
  >,
  state: AtomicReducerStateV1,
): AtomicProtocolFailureV1 | null {
  if (
    observation.cursor !== request.cursor ||
    observation.cursor !== state.cursors.directory
  ) {
    return "cursor_mismatch";
  }
  if (
    state.reservations.directoryEntries < observation.entries.length ||
    state.reservations.directoryBytes < request.byteLength
  ) {
    return "reservation_missing";
  }
  if (
    observation.entries.length > ATOMIC_MAX_DIRECTORY_ENTRIES ||
    (!observation.done && observation.entries.length === 0)
  ) {
    return "bounds_exceeded";
  }
  const seenLeaves = new Set<string>();
  const seenObjectIds = new Set<FlightSemanticId>();
  for (const entry of observation.entries) {
    if (
      !validLeaf(entry.role, entry.leaf) ||
      !isSha256(entry.evidenceDigest) ||
      seenLeaves.has(entry.leaf) ||
      seenObjectIds.has(entry.objectId) ||
      state.semanticIds.includes(entry.objectId)
    ) {
      return "observation_mismatch";
    }
    seenLeaves.add(entry.leaf);
    seenObjectIds.add(entry.objectId);
  }
  if (
    utf8Length(JSON.stringify(observation.entries)) >
      ATOMIC_MAX_OBSERVATION_BYTES ||
    !isSha256(observation.evidenceDigest)
  ) {
    return "bounds_exceeded";
  }
  return null;
}

function fileObservationValid(
  request: AtomicEffectRequestV1 & { kind: "read_file_chunk" },
  observation: Extract<
    AtomicEffectObservationV1,
    { kind: "file_chunk_observed" }
  >,
  state: AtomicReducerStateV1,
): AtomicProtocolFailureV1 | null {
  if (
    observation.cursor !== request.cursor ||
    observation.cursor !== state.cursors.file
  ) {
    return "cursor_mismatch";
  }
  const decodedBytes = decodeCanonicalBase64(observation.bytesBase64);
  if (
    decodedBytes === null ||
    decodedBytes.byteLength !== observation.byteSize ||
    observation.byteSize > request.byteLength ||
    observation.byteSize > ATOMIC_MAX_OBSERVATION_BYTES ||
    (!observation.eof && observation.byteSize === 0)
  ) {
    return "bounds_exceeded";
  }
  if (state.reservations.fileBytes < request.byteLength) {
    return "reservation_missing";
  }
  if (
    !isSha256(observation.contentDigest) ||
    !isSha256(observation.evidenceDigest) ||
    sha256(decodedBytes) !== observation.contentDigest
  ) {
    return "observation_mismatch";
  }
  return null;
}

function observationSpecificMismatch(
  request: AtomicEffectRequestV1,
  observation: AtomicEffectObservationV1,
  state: AtomicReducerStateV1,
): AtomicProtocolFailureV1 | null {
  switch (observation.kind) {
    case "effect_rejected":
      return isSha256(observation.evidenceDigest)
        ? null
        : "observation_mismatch";
    case "statfs_observed":
      return request.kind === "statfs_parent" &&
        observation.objectId === request.objectId &&
        observation.device === request.expected.dev &&
        isSha256(observation.evidenceDigest)
        ? null
        : "observation_mismatch";
    case "effect_completed":
      return isNonNegativeInteger(observation.count) &&
        isNonNegativeInteger(observation.byteSize) &&
        isSha256(observation.evidenceDigest)
        ? null
        : "observation_mismatch";
    case "create_and_pin_completed":
      return isEvidence(observation.evidence) &&
        !state.semanticIds.includes(observation.handleId)
        ? null
        : "observation_mismatch";
    case "existing_handle_pinned":
      return request.kind === "open_pin_handle" &&
        isEvidence(observation.evidence) &&
        evidenceEquals(observation.evidence, request.expected) &&
        !state.semanticIds.includes(observation.handleId)
        ? null
        : "observation_mismatch";
    case "create_and_pin_partial":
      return isSha256(observation.evidenceDigest) &&
        (observation.evidence === null || isEvidence(observation.evidence))
        ? null
        : "observation_mismatch";
    case "partial_create_cleanup_observed":
    case "partial_create_cleanup_failed":
      if (
        request.kind !== "cleanup_partial_create" ||
        observation.partialId !== request.partialId ||
        observation.partialId !== state.activePartialId
      ) {
        return "observation_mismatch";
      }
      return isSha256(observation.evidenceDigest)
        ? null
        : "observation_mismatch";
    case "removal_observed": {
      if (!isEvidence(observation.removedEvidence)) {
        return "observation_mismatch";
      }
      if (
        request.kind === "remove_intent" ||
        request.kind === "remove_manifest"
      ) {
        return observation.objectId === request.stableObjectId &&
          evidenceEquals(observation.removedEvidence, request.expectedStable)
          ? null
          : "observation_mismatch";
      }
      if (
        request.kind === "remove_file" ||
        request.kind === "remove_directory" ||
        request.kind === "remove_root"
      ) {
        return observation.objectId === request.objectId &&
          evidenceEquals(observation.removedEvidence, request.expected)
          ? null
          : "observation_mismatch";
      }
      return "observation_mismatch";
    }
    case "directory_observed":
      return request.kind === "enumerate_directory"
        ? directoryObservationValid(
            request as AtomicEffectRequestV1 & {
              kind: "enumerate_directory";
            },
            observation,
            state,
          )
        : "request_kind_mismatch";
    case "file_chunk_observed":
      return request.kind === "read_file_chunk"
        ? fileObservationValid(
            request as AtomicEffectRequestV1 & { kind: "read_file_chunk" },
            observation,
            state,
          )
        : "request_kind_mismatch";
    case "native_resolved":
      if (
        (request.kind !== "native_no_replace" &&
          request.kind !== "persist_intent" &&
          request.kind !== "persist_manifest") ||
        observation.operationId !== request.operationId ||
        observation.requestKind !== request.kind
      ) {
        return "observation_mismatch";
      }
      if (
        request.kind === "native_no_replace" &&
        (observation.move !== request.move ||
          observation.sourceObjectId !== request.sourceId ||
          !evidenceEquals(observation.sourceEvidence, request.expectedSource) ||
          state.pendingNativeResolution !== null)
      ) {
        return "observation_mismatch";
      }
      if (
        (request.kind === "persist_intent" ||
          request.kind === "persist_manifest") &&
        (observation.sourceObjectId !== request.tempObjectId ||
          !evidenceEquals(observation.sourceEvidence, request.expectedTemp))
      ) {
        return "observation_mismatch";
      }
      return isSha256(observation.nativePrecheckEvidenceDigest) &&
        isSha256(observation.evidenceDigest)
        ? null
        : "observation_mismatch";
    case "locations_observed":
      if (
        request.kind !== "observe_locations" ||
        observation.operationId !== request.operationId ||
        observation.requestKind !== request.requestKind ||
        observation.move !== request.move ||
        !locationEvidenceValid(observation.source, observation.sourceObjectId) ||
        !locationEvidenceValid(observation.target, observation.targetObjectId) ||
        !isSha256(observation.evidenceDigest)
      ) {
        return "observation_mismatch";
      }
      if (
        request.requestKind === "native_no_replace" &&
        observation.requestKind === "native_no_replace"
      ) {
        const pending = state.pendingNativeResolution;
        const verification = state.canaryWorkflow;
        const authorizedRequest =
          (pending !== null &&
            pending.request.operationId === request.operationId &&
            pending.request.move === request.move &&
            pending.request.sourceParentId === request.sourceParentId &&
            pending.request.sourceId === request.sourceId &&
            pending.request.sourceLeaf === request.sourceLeaf &&
            pending.request.targetParentId === request.targetParentId &&
            pending.request.targetLeaf === request.targetLeaf &&
            evidenceEquals(
              pending.request.expectedSource,
              request.expectedSource,
            )) ||
          (verification !== null &&
            verification.stage === "verify_published_locations" &&
            verification.action === "prove_mount" &&
            verification.durablePhase === "published" &&
            request.operationId === verification.proof.operationId &&
            request.move === "canary_publish" &&
            request.sourceParentId === verification.sourceParentId &&
            request.sourceId === verification.sourceId &&
            request.sourceLeaf === verification.proof.sourceLeaf &&
            request.targetParentId === verification.targetParentId &&
            request.targetLeaf === verification.proof.targetLeaf &&
            evidenceEquals(
              request.expectedSource,
              verification.proof.privateSourceEvidence,
            ));
        return authorizedRequest &&
          observation.sourceParentId === request.sourceParentId &&
          observation.sourceLeaf === request.sourceLeaf &&
          observation.targetParentId === request.targetParentId &&
          observation.targetLeaf === request.targetLeaf &&
          observation.requestedSourceObjectId === request.sourceId
          ? null
          : "observation_mismatch";
      }
      if (
        request.requestKind !== "native_no_replace" &&
        observation.requestKind !== "native_no_replace"
      ) {
        return observation.tempParentId === request.tempParentId &&
          observation.tempLeaf === request.tempLeaf &&
          observation.stableParentId === request.stableParentId &&
          observation.stableLeaf === request.stableLeaf &&
          observation.requestedSourceObjectId === request.tempObjectId
          ? null
          : "observation_mismatch";
      }
      return "observation_mismatch";
    case "content_observed":
      if (
        (request.kind !== "canonicalize_tree_step" &&
          request.kind !== "hash_content_chunk") ||
        observation.cursor !== state.cursors.content
      ) {
        return "cursor_mismatch";
      }
      const requestCursor =
        request.kind === "canonicalize_tree_step"
          ? request.cursor
          : (
              request as AtomicEffectRequestV1 & {
                kind: "hash_content_chunk";
              }
            ).offset;
      if (observation.cursor !== requestCursor) {
        return "cursor_mismatch";
      }
      return observation.byteSize > 0 &&
        observation.byteSize <= ATOMIC_MAX_OBSERVATION_BYTES &&
        isSha256(observation.contentDigest) &&
        isSha256(observation.evidenceDigest)
        ? null
        : "bounds_exceeded";
    case "authority_observed":
      return (
        (request.kind === "resolve_adoption" ||
          request.kind === "adopt_generation" ||
          request.kind === "release_publication") &&
        observation.authorityDigest === request.authorityDigest &&
        isSha256(observation.evidenceDigest)
      )
        ? null
        : "observation_mismatch";
  }
}

function mintedSemanticIds(
  request: AtomicEffectRequestV1,
  observation: AtomicEffectObservationV1,
  known: ReadonlyArray<FlightSemanticId>,
): ReadonlyArray<FlightSemanticId> {
  switch (observation.kind) {
    case "create_and_pin_completed":
    case "existing_handle_pinned":
      return known.includes(observation.handleId)
        ? []
        : [observation.handleId];
    case "directory_observed":
      return observation.entries
        .map(entry => entry.objectId)
        .filter(id => !known.includes(id));
    case "locations_observed": {
      const existing =
        request.kind === "observe_locations"
          ? request.requestKind === "native_no_replace"
            ? request.sourceId
            : request.tempObjectId
          : null;
      const ids = [observation.sourceObjectId, observation.targetObjectId].filter(
        (id): id is FlightSemanticId =>
          id !== null && id !== existing && !known.includes(id),
      );
      return ids[0] !== undefined && ids[1] === ids[0] ? [ids[0]] : ids;
    }
    default:
      return [];
  }
}

function withAcceptedObservation(
  state: AtomicReducerStateV1,
  request: AtomicEffectRequestV1,
  observation: AtomicEffectObservationV1,
): AtomicReducerStateV1 {
  const newSemanticIds = mintedSemanticIds(
    request,
    observation,
    state.semanticIds,
  );
  let directory = state.cursors.directory;
  let file = state.cursors.file;
  let content = state.cursors.content;
  if (observation.kind === "directory_observed") {
    directory += observation.entries.length;
  } else if (observation.kind === "file_chunk_observed") {
    file += observation.byteSize;
  } else if (observation.kind === "content_observed") {
    content += observation.byteSize;
  }
  return Object.freeze({
    ...state,
    semanticIdCount: state.semanticIdCount + newSemanticIds.length,
    semanticIds: Object.freeze([...state.semanticIds, ...newSemanticIds]),
    outstandingRequest: null,
    consumedEffectIds: Object.freeze([
      ...state.consumedEffectIds,
      request.effectId,
    ]),
    cursors: Object.freeze({ directory, file, content }),
  });
}

function requestSemanticIds(
  request: AtomicEffectRequestV1,
): ReadonlyArray<FlightSemanticId> {
  switch (request.kind) {
    case "create_and_pin_wrapper":
    case "create_and_pin_directory":
    case "create_and_pin_file":
    case "create_and_pin_temp_file":
    case "open_pin_handle":
      return [request.parentId];
    case "revalidate_handle":
    case "statfs_parent":
    case "close_handle":
    case "enumerate_directory":
    case "read_file_chunk":
    case "hash_content_chunk":
    case "fsync_file":
    case "fsync_directory":
    case "fsync_parent":
      return [request.objectId];
    case "populate_payload_entry":
    case "canonicalize_tree_step":
      return [request.rootId];
    case "copy_payload_chunk":
    case "write_file_chunk":
      return request.sourceFileId === null
        ? [request.destinationFileId]
        : [request.sourceFileId, request.destinationFileId];
    case "persist_intent":
    case "persist_manifest":
    case "replace_intent":
      return [
        request.tempParentId,
        request.tempObjectId,
        request.stableParentId,
      ];
    case "remove_intent":
    case "remove_manifest":
      return [request.stableParentId, request.stableObjectId];
    case "native_no_replace":
      return [
        request.sourceParentId,
        request.sourceId,
        request.targetParentId,
      ];
    case "observe_locations":
      return request.requestKind === "native_no_replace"
        ? request.sourceId === null
          ? [request.sourceParentId, request.targetParentId]
          : [request.sourceParentId, request.sourceId, request.targetParentId]
        : [
            request.tempParentId,
            request.tempObjectId,
            request.stableParentId,
          ];
    case "remove_file":
    case "remove_directory":
    case "remove_root":
      return [request.parentId, request.objectId];
    case "reserve_budget":
    case "release_budget":
    case "persist_canary_phase":
    case "cleanup_partial_create":
    case "resolve_adoption":
    case "adopt_generation":
    case "release_publication":
    case "close_admission":
      return [];
  }
}

function validNativeClassification(
  value: AtomicNativeClassificationV1 | null,
): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "outcome",
      "nativeCode",
      "sourceMatches",
      "targetMatches",
      "targetOther",
      "nativePrecheckEvidenceDigest",
      "locationEvidenceDigest",
    ]) ||
    !isOneOf(value.outcome, ["unpublished", "conflict", "published"]) ||
    !isOneOf(value.nativeCode, [
      "success",
      "atomic_publish_replay_completed",
      "atomic_publish_exists",
      "atomic_publish_unsupported",
      "atomic_publish_cross_device",
      "atomic_publish_binding_invalid",
      "atomic_publish_denied",
      "atomic_publish_invalid_argument",
      "atomic_publish_io",
    ]) ||
    typeof value.sourceMatches !== "boolean" ||
    typeof value.targetMatches !== "boolean" ||
    typeof value.targetOther !== "boolean" ||
    !isSha256(value.nativePrecheckEvidenceDigest) ||
    !isSha256(value.locationEvidenceDigest)
  ) {
    return false;
  }
  if (value.outcome === "published") {
    return (
      (value.nativeCode === "success" ||
        value.nativeCode === "atomic_publish_replay_completed") &&
      !value.sourceMatches &&
      value.targetMatches &&
      !value.targetOther
    );
  }
  if (value.outcome === "conflict") {
    return (
      value.nativeCode === "atomic_publish_exists" &&
      value.sourceMatches &&
      !value.targetMatches &&
      value.targetOther
    );
  }
  return (
    value.nativeCode !== "success" &&
    value.nativeCode !== "atomic_publish_replay_completed" &&
    value.nativeCode !== "atomic_publish_exists" &&
    value.sourceMatches &&
    !value.targetMatches &&
    !value.targetOther
  );
}

function validCanaryReplayAuthority(
  value: AtomicCanaryReplayAuthorityV1 | null,
): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "operationId",
      "attempt",
      "phase",
      "sourceLeaf",
      "targetLeaf",
      "deletionLeaf",
      "privateSourceEvidence",
      "publishedEvidence",
      "privateDeletionEvidence",
      "manifestSha256",
      "cleanupNextIndex",
      "cleanupEntryCount",
    ]) ||
    !isCanonicalUuid(value.operationId) ||
    value.attempt !== 0 ||
    !isOneOf(value.phase, ["planned", "published", "deleting"]) ||
    value.sourceLeaf !== `proof-${value.operationId}-0` ||
    value.targetLeaf !== `canary-${value.operationId}-0` ||
    value.deletionLeaf !== `deletion-${value.operationId}-0` ||
    !isEvidence(value.privateSourceEvidence) ||
    (value.publishedEvidence !== null &&
      (!isEvidence(value.publishedEvidence) ||
        !evidenceEquals(
          value.publishedEvidence,
          value.privateSourceEvidence,
        ))) ||
    (value.privateDeletionEvidence !== null &&
      (!isEvidence(value.privateDeletionEvidence) ||
        value.publishedEvidence === null ||
        !evidenceEquals(
          value.privateDeletionEvidence,
          value.publishedEvidence,
        ))) ||
    (value.manifestSha256 !== null && !isSha256(value.manifestSha256)) ||
    !isNonNegativeInteger(value.cleanupNextIndex) ||
    !isNonNegativeInteger(value.cleanupEntryCount) ||
    value.cleanupNextIndex > value.cleanupEntryCount
  ) {
    return false;
  }
  if (value.phase === "planned") {
    return (
      value.publishedEvidence === null &&
      value.privateDeletionEvidence === null &&
      value.manifestSha256 === null &&
      value.cleanupNextIndex === 0 &&
      value.cleanupEntryCount === 0
    );
  }
  if (value.phase === "published") {
    return (
      value.publishedEvidence !== null &&
      value.privateDeletionEvidence === null &&
      value.manifestSha256 === null &&
      value.cleanupNextIndex === 0 &&
      value.cleanupEntryCount === 0
    );
  }
  return (
    value.publishedEvidence !== null &&
    value.manifestSha256 !== null &&
    value.cleanupEntryCount > 0
  );
}

function validCanaryProof(value: AtomicCanaryProofV1): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "operationId",
      "targetParentLocatorDigest",
      "targetParentEvidence",
      "wrapperEvidence",
      "attempt",
      "sourceLeaf",
      "targetLeaf",
      "deletionLeaf",
      "phase",
      "privateSourceEvidence",
      "publishedEvidence",
      "privateDeletionEvidence",
      "classification",
      "manifestSha256",
      "cleanupNextIndex",
      "cleanupEntryCount",
      "sourceParentSynced",
      "targetParentSynced",
    ]) ||
    value.version !== 1 ||
    !isCanonicalUuid(value.operationId) ||
    !isSha256(value.targetParentLocatorDigest) ||
    !isEvidence(value.targetParentEvidence) ||
    value.targetParentEvidence.mode !== 448 ||
    !isEvidence(value.wrapperEvidence) ||
    value.wrapperEvidence.mode !== 448 ||
    value.attempt !== 0 ||
    value.sourceLeaf !== `proof-${value.operationId}-0` ||
    value.targetLeaf !== `canary-${value.operationId}-0` ||
    value.deletionLeaf !== `deletion-${value.operationId}-0` ||
    !isOneOf(value.phase, [
      "planned",
      "published",
      "deleting",
      "cleaned",
    ]) ||
    !isEvidence(value.privateSourceEvidence) ||
    value.privateSourceEvidence.mode !== 448 ||
    (value.publishedEvidence !== null &&
      (!isEvidence(value.publishedEvidence) ||
        !evidenceEquals(
          value.publishedEvidence,
          value.privateSourceEvidence,
        ))) ||
    (value.privateDeletionEvidence !== null &&
      (!isEvidence(value.privateDeletionEvidence) ||
        value.publishedEvidence === null ||
        !evidenceEquals(
          value.privateDeletionEvidence,
          value.publishedEvidence,
        ))) ||
    !validNativeClassification(value.classification) ||
    (value.manifestSha256 !== null && !isSha256(value.manifestSha256)) ||
    !isNonNegativeInteger(value.cleanupNextIndex) ||
    !isNonNegativeInteger(value.cleanupEntryCount) ||
    value.cleanupNextIndex > value.cleanupEntryCount ||
    typeof value.sourceParentSynced !== "boolean" ||
    typeof value.targetParentSynced !== "boolean"
  ) {
    return false;
  }
  if (value.phase === "planned") {
    return (
      value.publishedEvidence === null &&
      value.privateDeletionEvidence === null &&
      value.classification === null &&
      value.manifestSha256 === null &&
      value.cleanupNextIndex === 0 &&
      value.cleanupEntryCount === 0 &&
      !value.sourceParentSynced &&
      !value.targetParentSynced
    );
  }
  if (
    value.publishedEvidence === null ||
    value.classification === null ||
    value.classification.outcome !== "published"
  ) {
    return false;
  }
  if (value.phase === "published") {
    return (
      value.privateDeletionEvidence === null &&
      value.manifestSha256 === null &&
      value.cleanupNextIndex === 0 &&
      value.cleanupEntryCount === 0 &&
      value.sourceParentSynced &&
      value.targetParentSynced
    );
  }
  if (
    value.manifestSha256 === null ||
    value.cleanupEntryCount < 1
  ) {
    return false;
  }
  if (value.phase === "deleting") {
    return (
      value.cleanupNextIndex < value.cleanupEntryCount &&
      (value.privateDeletionEvidence === null
        ? !value.sourceParentSynced && !value.targetParentSynced
        : value.sourceParentSynced && value.targetParentSynced)
    );
  }
  return (
    value.privateDeletionEvidence !== null &&
    value.cleanupNextIndex === value.cleanupEntryCount &&
    value.sourceParentSynced &&
    value.targetParentSynced
  );
}

export function isAtomicCanaryProofV1(
  value: unknown,
): value is AtomicCanaryProofV1 {
  return validCanaryProof(value as AtomicCanaryProofV1);
}

function validCanaryWorkflow(value: AtomicCanaryWorkflowV1 | null): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        "action",
        "stage",
        "durablePhase",
        "proof",
        "sourceParentId",
        "sourceParentRole",
        "sourceParentEvidence",
        "sourceId",
        "targetParentId",
        "targetParentRole",
        "targetParentEvidence",
        "sourceFilesystem",
        "sourceDevice",
        "targetFilesystem",
        "targetDevice",
      ]) &&
      isOneOf(value.action, ["prove_mount", "cleanup"]) &&
      isOneOf(value.durablePhase, [
        "planned",
        "published",
        "deleting",
      ]) &&
      isOneOf(value.stage, [
        "revalidate_source",
        "revalidate_target",
        "statfs_source",
        "statfs_target",
        "native",
        "observe",
        "sync_source",
        "sync_target",
        "persist_planned",
        "persist_deleting",
        "persist_published",
        "persist_deleting_evidence",
        "verify_published_locations",
      ]) &&
      (validCanaryProof(value.proof) ||
        ((value.stage === "sync_source" ||
          value.stage === "sync_target" ||
          value.stage === "persist_published" ||
          value.stage === "persist_deleting_evidence") &&
          validCanaryProof({
            ...value.proof,
            sourceParentSynced: true,
            targetParentSynced: true,
          }))) &&
      isFlightId(value.sourceParentId) &&
      isOneOf(value.sourceParentRole, ATOMIC_OBJECT_ROLES) &&
      isEvidence(value.sourceParentEvidence) &&
      isFlightId(value.sourceId) &&
      isFlightId(value.targetParentId) &&
      isOneOf(value.targetParentRole, ATOMIC_OBJECT_ROLES) &&
      isEvidence(value.targetParentEvidence) &&
      (value.sourceFilesystem === null ||
        isOneOf(value.sourceFilesystem, [
          "ext",
          "xfs",
          "btrfs",
          "tmpfs",
          "overlay",
        ])) &&
      (value.targetFilesystem === null ||
        isOneOf(value.targetFilesystem, [
          "ext",
          "xfs",
          "btrfs",
          "tmpfs",
          "overlay",
        ])) &&
      (value.sourceDevice === null ||
        /^(?:0|[1-9][0-9]*)$/u.test(value.sourceDevice)) &&
      (value.targetDevice === null ||
        /^(?:0|[1-9][0-9]*)$/u.test(value.targetDevice)))
  );
}

function validPendingNativeResolution(
  value: PendingAtomicNativeResolutionV1 | null,
): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, [
        "request",
        "rawCode",
        "nativePrecheckEvidenceDigest",
      ]) &&
      validRequest(value.request) &&
      value.request.kind === "native_no_replace" &&
      isOneOf(value.rawCode, [
        "success",
        "atomic_publish_exists",
        "atomic_publish_source_missing",
        "atomic_publish_unsupported",
        "atomic_publish_cross_device",
        "atomic_publish_binding_invalid",
        "atomic_publish_denied",
        "atomic_publish_invalid_argument",
        "atomic_publish_io",
      ]) &&
      isSha256(value.nativePrecheckEvidenceDigest))
  );
}

function validNativeFailure(value: AtomicProtocolFailureV1 | null): boolean {
  return (
    value === null ||
    isOneOf(value, [
      "native_binding_invalid",
      "native_ambiguous",
      "native_unsupported",
      "native_cross_device",
      "native_denied",
      "native_io",
    ])
  );
}

function validateState(state: AtomicReducerStateV1): boolean {
  return (
    isRecord(state) &&
    hasExactKeys(state, [
      "version",
      "durableBytesBase64",
      "flightNonce",
      "stepCounter",
      "semanticIdCount",
      "partialCreateIdCount",
      "semanticIds",
      "outstandingRequest",
      "consumedEffectIds",
      "consumedPartialIds",
      "activePartialId",
      "reservations",
      "cursors",
      "admission",
      "canaryWorkflow",
      "canaryReplayAuthority",
      "pendingNativeResolution",
      "nativeClassification",
      "pendingNativeFailure",
      "terminalResult",
    ]) &&
    state.version === 1 &&
    typeof state.durableBytesBase64 === "string" &&
    typeof state.flightNonce === "string" &&
    state.flightNonce.length > 0 &&
    isNonNegativeInteger(state.stepCounter) &&
    isNonNegativeInteger(state.semanticIdCount) &&
    isNonNegativeInteger(state.partialCreateIdCount) &&
    Array.isArray(state.semanticIds) &&
    state.semanticIds.every(isFlightId) &&
    state.semanticIds.length <= state.semanticIdCount &&
    new Set(state.semanticIds).size === state.semanticIds.length &&
    Array.isArray(state.consumedEffectIds) &&
    state.consumedEffectIds.every(isFlightId) &&
    new Set(state.consumedEffectIds).size === state.consumedEffectIds.length &&
    Array.isArray(state.consumedPartialIds) &&
    state.consumedPartialIds.every(isFlightId) &&
    new Set(state.consumedPartialIds).size ===
      state.consumedPartialIds.length &&
    (state.activePartialId === null || isFlightId(state.activePartialId)) &&
    state.partialCreateIdCount <= ATOMIC_MAX_PARTIAL_CREATE_IDS &&
    state.semanticIdCount + state.partialCreateIdCount <=
      ATOMIC_MAX_TRACKED_IDS &&
    isRecord(state.reservations) &&
    hasExactKeys(state.reservations, [
      "directoryEntries",
      "directoryBytes",
      "fileBytes",
    ]) &&
    isNonNegativeInteger(state.reservations.directoryEntries) &&
    isNonNegativeInteger(state.reservations.directoryBytes) &&
    isNonNegativeInteger(state.reservations.fileBytes) &&
    isRecord(state.cursors) &&
    hasExactKeys(state.cursors, ["directory", "file", "content"]) &&
    isNonNegativeInteger(state.cursors.directory) &&
    isNonNegativeInteger(state.cursors.file) &&
    isNonNegativeInteger(state.cursors.content) &&
    (state.admission === "open" || state.admission === "closed") &&
    validCanaryWorkflow(state.canaryWorkflow) &&
    validCanaryReplayAuthority(state.canaryReplayAuthority) &&
    validPendingNativeResolution(state.pendingNativeResolution) &&
    validNativeClassification(state.nativeClassification) &&
    validNativeFailure(state.pendingNativeFailure) &&
    (state.terminalResult === null ||
      (state.terminalResult.kind === "protocol_complete"
        ? isRecord(state.terminalResult) &&
          hasExactKeys(state.terminalResult, ["kind"])
        : state.terminalResult.kind === "mount_proved" ||
            state.terminalResult.kind === "cleanup_pending" ||
            state.terminalResult.kind === "canary_cleaned"
          ? isRecord(state.terminalResult) &&
            hasExactKeys(state.terminalResult, ["kind", "proof"]) &&
            validCanaryProof(state.terminalResult.proof)
        : state.terminalResult.kind === "fail_stop" &&
          isRecord(state.terminalResult) &&
          hasExactKeys(state.terminalResult, [
            "kind",
            "code",
            "retainedPartialId",
            "retainedReservations",
          ])))
  );
}

function initialRequestFailure(
  state: AtomicReducerStateV1,
  request: AtomicEffectRequestV1,
): AtomicProtocolFailureV1 | null {
  if (!validRequest(request)) {
    return "invalid_request";
  }
  if (
    requestSemanticIds(request).some(
      semanticId => !state.semanticIds.includes(semanticId),
    )
  ) {
    return "invalid_request";
  }
  if (
    request.kind === "cleanup_partial_create" &&
    (request.partialId !== state.activePartialId ||
      !state.consumedPartialIds.includes(request.partialId))
  ) {
    return "invalid_request";
  }
  if (
    request.kind === "enumerate_directory" &&
    (request.cursor !== state.cursors.directory ||
      state.reservations.directoryEntries < 1 ||
      state.reservations.directoryBytes < request.byteLength)
  ) {
    return request.cursor === state.cursors.directory
      ? "reservation_missing"
      : "cursor_mismatch";
  }
  if (
    request.kind === "read_file_chunk" &&
    (request.cursor !== state.cursors.file ||
      state.reservations.fileBytes < request.byteLength)
  ) {
    return request.cursor === state.cursors.file
      ? "reservation_missing"
      : "cursor_mismatch";
  }
  if (
    request.kind === "canonicalize_tree_step" &&
    request.cursor !== state.cursors.content
  ) {
    return "cursor_mismatch";
  }
  if (
    request.kind === "hash_content_chunk" &&
    request.offset !== state.cursors.content
  ) {
    return "cursor_mismatch";
  }
  return null;
}

function scheduleAtomicEffect(
  state: AtomicReducerStateV1,
  draft: AtomicEffectRequestDraftV1,
  additions: Partial<AtomicReducerStateV1> = {},
): AtomicReducerStepV1 {
  const request = attachEffectId(
    draft,
    makeEffectId(state.flightNonce, state.stepCounter),
  );
  if (!validRequest(request)) return fail(state, "invalid_request");
  const nextState: AtomicReducerStateV1 = Object.freeze({
    ...state,
    ...additions,
    stepCounter: state.stepCounter + 1,
    outstandingRequest: request,
  });
  return Object.freeze({ kind: "effect" as const, state: nextState, request });
}

function exactLocationMatch(
  location: CanonicalLocationEvidenceV1,
  expected: AtomicObjectEvidenceV1,
): boolean {
  return (
    location.state === "match" &&
    location.evidence !== null &&
    evidenceEquals(location.evidence, expected) &&
    location.dev === expected.dev &&
    location.ino === expected.ino &&
    location.mode === expected.mode
  );
}

function nativeClassificationFromLocations(
  pending: PendingAtomicNativeResolutionV1,
  authority: AtomicCanaryReplayAuthorityV1 | null,
  observation: Extract<
    AtomicEffectObservationV1,
    { kind: "locations_observed"; requestKind: "native_no_replace" }
  >,
): AtomicNativeClassificationV1 | null {
  const sourceMatches =
    exactLocationMatch(observation.source, pending.request.expectedSource) &&
    observation.sourceObjectId === pending.request.sourceId;
  const targetMatches = exactLocationMatch(
    observation.target,
    pending.request.expectedSource,
  );
  const sourceAbsent =
    observation.source.state === "absent" &&
    observation.sourceObjectId === null;
  const targetAbsent =
    observation.target.state === "absent" &&
    observation.targetObjectId === null;
  const targetOther =
    observation.target.state === "other" &&
    observation.targetObjectId !== null;
  const unpublished = sourceMatches && targetAbsent;
  const conflict = sourceMatches && targetOther;
  const published = sourceAbsent && targetMatches;
  if (
    Number(unpublished) + Number(conflict) + Number(published) !==
    1
  ) {
    return null;
  }

  let outcome: AtomicNativeClassificationV1["outcome"];
  let nativeCode: AtomicNativeClassificationV1["nativeCode"];
  if (pending.rawCode === "success" && published) {
    outcome = "published";
    nativeCode = "success";
  } else if (pending.rawCode === "atomic_publish_exists" && conflict) {
    outcome = "conflict";
    nativeCode = "atomic_publish_exists";
  } else if (
    pending.rawCode === "atomic_publish_source_missing" &&
    published &&
    authority !== null &&
    authority.operationId === pending.request.operationId &&
    authority.attempt === 0 &&
    authority.sourceLeaf ===
      `proof-${pending.request.operationId}-0` &&
    authority.targetLeaf ===
      `canary-${pending.request.operationId}-0` &&
    authority.deletionLeaf ===
      `deletion-${pending.request.operationId}-0` &&
    evidenceEquals(
      authority.privateSourceEvidence,
      pending.request.expectedSource,
    ) &&
    ((pending.request.move === "canary_publish" &&
      (authority.phase === "planned" ||
        (authority.phase === "published" &&
          authority.publishedEvidence !== null &&
          evidenceEquals(
            authority.publishedEvidence,
            pending.request.expectedSource,
          )))) ||
      (pending.request.move === "canary_source_to_private" &&
        authority.phase === "deleting" &&
        authority.publishedEvidence !== null &&
        evidenceEquals(
          authority.publishedEvidence,
          pending.request.expectedSource,
        ) &&
        authority.manifestSha256 !== null &&
        authority.cleanupEntryCount > 0 &&
        authority.cleanupNextIndex <= authority.cleanupEntryCount))
  ) {
    outcome = "published";
    nativeCode = "atomic_publish_replay_completed";
  } else if (
    unpublished &&
    pending.rawCode !== "success" &&
    pending.rawCode !== "atomic_publish_exists" &&
    pending.rawCode !== "atomic_publish_source_missing"
  ) {
    outcome = "unpublished";
    nativeCode = pending.rawCode;
  } else {
    return null;
  }

  return Object.freeze({
    outcome,
    nativeCode,
    sourceMatches,
    targetMatches,
    targetOther,
    nativePrecheckEvidenceDigest: pending.nativePrecheckEvidenceDigest,
    locationEvidenceDigest: observation.evidenceDigest,
  });
}

function nativeFailureAction(
  rawCode: AtomicRawNativeCodeV1,
  ambiguous: boolean,
): Readonly<{
  reason: Extract<
    AtomicEffectRequestV1,
    { kind: "close_admission" }
  >["reason"];
  failure: AtomicProtocolFailureV1;
}> | null {
  if (rawCode === "atomic_publish_source_missing") {
    return {
      reason: "binding_invalid",
      failure: "native_binding_invalid",
    };
  }
  if (ambiguous) {
    return { reason: "ambiguous", failure: "native_ambiguous" };
  }
  switch (rawCode) {
    case "success":
    case "atomic_publish_exists":
      return null;
    case "atomic_publish_binding_invalid":
    case "atomic_publish_invalid_argument":
      return {
        reason: "binding_invalid",
        failure: "native_binding_invalid",
      };
    case "atomic_publish_unsupported":
      return { reason: "unsupported", failure: "native_unsupported" };
    case "atomic_publish_cross_device":
      return { reason: "cross_device", failure: "native_cross_device" };
    case "atomic_publish_denied":
      return { reason: "denied", failure: "native_denied" };
    case "atomic_publish_io":
      return { reason: "io", failure: "native_io" };
  }
}

export function reduceAtomicPublication(
  state: AtomicReducerStateV1,
  observation: AtomicEffectObservationV1 | null,
): AtomicReducerStepV1 {
  if (!validateState(state)) {
    return fail(state, "invalid_state");
  }
  if (state.terminalResult !== null) {
    return observation === null
      ? terminal(state, state.terminalResult)
      : fail(state, "terminal_replay");
  }
  const request = state.outstandingRequest;
  if (request === null) {
    return fail(
      state,
      observation === null ? "observation_required" : "unexpected_observation",
    );
  }
  const requestFailure = initialRequestFailure(state, request);
  if (requestFailure !== null) {
    return fail(state, requestFailure);
  }
  if (observation === null) {
    return Object.freeze({ kind: "effect" as const, state, request });
  }
  if (!validObservation(observation)) {
    return fail(state, "unexpected_observation");
  }
  if (state.consumedEffectIds.includes(observation.effectId)) {
    return fail(state, "replayed_observation");
  }
  if (observation.effectId !== request.effectId) {
    return fail(state, "effect_id_mismatch");
  }
  if (requestKindForObservation(observation) !== request.kind) {
    return fail(state, "request_kind_mismatch");
  }
  const mismatch = observationSpecificMismatch(request, observation, state);
  if (mismatch !== null) {
    if (
      request.kind === "observe_locations" &&
      request.requestKind === "native_no_replace" &&
      state.pendingNativeResolution !== null
    ) {
      const consumed: AtomicReducerStateV1 = Object.freeze({
        ...state,
        outstandingRequest: null,
        consumedEffectIds: Object.freeze([
          ...state.consumedEffectIds,
          request.effectId,
        ]),
      });
      return scheduleAtomicEffect(
        consumed,
        {
          kind: "close_admission",
          operationId: request.operationId,
          reason: "binding_invalid",
          evidenceDigest: sha256(
            new TextEncoder().encode(
              JSON.stringify({
                precheck:
                  state.pendingNativeResolution
                    .nativePrecheckEvidenceDigest,
                request: request.evidenceDigest,
                mismatch,
              }),
            ),
          ),
        },
        {
          pendingNativeResolution: null,
          pendingNativeFailure: "native_binding_invalid",
        },
      );
    }
    return fail(state, mismatch);
  }
  const accepted = withAcceptedObservation(state, request, observation);
  if (
    accepted.semanticIdCount + accepted.partialCreateIdCount >
    ATOMIC_MAX_TRACKED_IDS
  ) {
    return fail(accepted, "id_cap_exceeded");
  }
  if (observation.kind === "effect_rejected") {
    return fail(accepted, "effect_rejected");
  }
  if (observation.kind === "create_and_pin_partial") {
    if (
      state.consumedPartialIds.includes(observation.partialId) ||
      state.partialCreateIdCount >= ATOMIC_MAX_PARTIAL_CREATE_IDS ||
      state.semanticIdCount + state.partialCreateIdCount >=
        ATOMIC_MAX_TRACKED_IDS
    ) {
      return fail(accepted, "id_cap_exceeded");
    }
    const cleanupEffectId = makeEffectId(state.flightNonce, state.stepCounter);
    const cleanupRequest: AtomicEffectRequestV1 = Object.freeze({
      kind: "cleanup_partial_create",
      effectId: cleanupEffectId,
      operationId: request.operationId,
      partialId: observation.partialId,
    });
    const cleanupState: AtomicReducerStateV1 = Object.freeze({
      ...accepted,
      stepCounter: state.stepCounter + 1,
      partialCreateIdCount: state.partialCreateIdCount + 1,
      outstandingRequest: cleanupRequest,
      consumedPartialIds: Object.freeze([
        ...state.consumedPartialIds,
        observation.partialId,
      ]),
      activePartialId: observation.partialId,
    });
    return Object.freeze({
      kind: "effect" as const,
      state: cleanupState,
      request: cleanupRequest,
    });
  }
  if (observation.kind === "partial_create_cleanup_failed") {
    return fail(accepted, "partial_cleanup_failed");
  }
  if (observation.kind === "partial_create_cleanup_observed") {
    return completed(
      Object.freeze({
        ...accepted,
        activePartialId: null,
      }),
    );
  }
  const workflow = accepted.canaryWorkflow;
  if (
    workflow !== null &&
    observation.kind === "effect_completed" &&
    observation.requestKind === "persist_canary_phase"
  ) {
    if (
      workflow.stage === "persist_planned" ||
      workflow.stage === "persist_deleting"
    ) {
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "revalidate_handle",
          operationId: workflow.proof.operationId,
          role: workflow.sourceParentRole,
          objectId: workflow.sourceParentId,
          cursor: 0,
          byteLength: 0,
          expected: workflow.sourceParentEvidence,
        },
        {
          canaryWorkflow: Object.freeze({
            ...workflow,
            durablePhase:
              workflow.stage === "persist_planned"
                ? ("planned" as const)
                : ("deleting" as const),
            stage: "revalidate_source" as const,
          }),
        },
      );
    }
    if (
      workflow.stage === "persist_published" ||
      workflow.stage === "persist_deleting_evidence"
    ) {
      const result: AtomicTerminalResultV1 =
        workflow.stage === "persist_published"
          ? Object.freeze({
              kind: "mount_proved" as const,
              proof: workflow.proof,
            })
          : Object.freeze({
              kind: "cleanup_pending" as const,
              proof: workflow.proof,
            });
      return terminal(
        Object.freeze({
          ...accepted,
          canaryWorkflow: null,
          canaryReplayAuthority:
            canaryReplayAuthorityFromProof(workflow.proof),
        }),
        result,
      );
    }
  }
  if (
    workflow !== null &&
    observation.kind === "effect_completed" &&
    observation.requestKind === "revalidate_handle"
  ) {
    if (workflow.stage === "revalidate_source") {
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "revalidate_handle",
          operationId: workflow.proof.operationId,
          role: workflow.targetParentRole,
          objectId: workflow.targetParentId,
          cursor: 0,
          byteLength: 0,
          expected: workflow.targetParentEvidence,
        },
        {
          canaryWorkflow: Object.freeze({
            ...workflow,
            stage: "revalidate_target" as const,
          }),
        },
      );
    }
    if (workflow.stage === "revalidate_target") {
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "statfs_parent",
          operationId: workflow.proof.operationId,
          role: workflow.sourceParentRole,
          objectId: workflow.sourceParentId,
          expected: workflow.sourceParentEvidence,
        },
        {
          canaryWorkflow: Object.freeze({
            ...workflow,
            stage: "statfs_source" as const,
          }),
        },
      );
    }
  }
  if (
    workflow !== null &&
    observation.kind === "statfs_observed" &&
    request.kind === "statfs_parent"
  ) {
    if (workflow.stage === "statfs_source") {
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "statfs_parent",
          operationId: workflow.proof.operationId,
          role: workflow.targetParentRole,
          objectId: workflow.targetParentId,
          expected: workflow.targetParentEvidence,
        },
        {
          canaryWorkflow: Object.freeze({
            ...workflow,
            stage: "statfs_target" as const,
            sourceFilesystem: observation.filesystem,
            sourceDevice: observation.device,
          }),
        },
      );
    }
    if (workflow.stage === "statfs_target") {
      if (
        workflow.sourceDevice !== observation.device ||
        workflow.sourceFilesystem === null
      ) {
        return scheduleAtomicEffect(
          accepted,
          {
            kind: "close_admission",
            operationId: workflow.proof.operationId,
            reason: "cross_device",
            evidenceDigest: sha256(
              new TextEncoder().encode(
                JSON.stringify({
                  sourceDevice: workflow.sourceDevice,
                  targetDevice: observation.device,
                }),
              ),
            ),
          },
          {
            pendingNativeFailure: "native_cross_device",
            canaryWorkflow: null,
          },
        );
      }
      if (
        workflow.action === "prove_mount" &&
        workflow.durablePhase === "published"
      ) {
        return scheduleAtomicEffect(
          accepted,
          {
            kind: "observe_locations",
            requestKind: "native_no_replace",
            operationId: workflow.proof.operationId,
            move: "canary_publish",
            sourceParentId: workflow.sourceParentId,
            sourceId: workflow.sourceId,
            sourceLeaf: workflow.proof.sourceLeaf,
            targetParentId: workflow.targetParentId,
            targetLeaf: workflow.proof.targetLeaf,
            expectedSource: workflow.proof.privateSourceEvidence,
            expectedTarget: { absent: true },
            evidenceDigest: sha256(
              new TextEncoder().encode(
                JSON.stringify({
                  proof: workflow.proof,
                  sourceFilesystem: workflow.sourceFilesystem,
                  sourceDevice: workflow.sourceDevice,
                  targetFilesystem: observation.filesystem,
                  targetDevice: observation.device,
                  verification: "published_locations",
                }),
              ),
            ),
          },
          {
            canaryWorkflow: Object.freeze({
              ...workflow,
              stage: "verify_published_locations" as const,
              targetFilesystem: observation.filesystem,
              targetDevice: observation.device,
            }),
          },
        );
      }
      const cleanup = workflow.action === "cleanup";
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "native_no_replace",
          operationId: workflow.proof.operationId,
          move: cleanup
            ? "canary_source_to_private"
            : "canary_publish",
          sourceParentId: workflow.sourceParentId,
          sourceId: workflow.sourceId,
          sourceLeaf: cleanup
            ? workflow.proof.targetLeaf
            : workflow.proof.sourceLeaf,
          targetParentId: workflow.targetParentId,
          targetLeaf: cleanup
            ? workflow.proof.deletionLeaf
            : workflow.proof.targetLeaf,
          expectedSource: cleanup
            ? workflow.proof.publishedEvidence!
            : workflow.proof.privateSourceEvidence,
          expectedTarget: { absent: true },
          evidenceDigest: sha256(
            new TextEncoder().encode(
              JSON.stringify({
                proof: workflow.proof,
                sourceFilesystem: workflow.sourceFilesystem,
                sourceDevice: workflow.sourceDevice,
                targetFilesystem: observation.filesystem,
                targetDevice: observation.device,
              }),
            ),
          ),
        },
        {
          canaryWorkflow: Object.freeze({
            ...workflow,
            stage: "native" as const,
            targetFilesystem: observation.filesystem,
            targetDevice: observation.device,
          }),
        },
      );
    }
  }
  if (
    workflow !== null &&
    observation.kind === "effect_completed" &&
    observation.requestKind === "fsync_directory"
  ) {
    if (workflow.stage === "sync_source") {
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "fsync_directory",
          operationId: workflow.proof.operationId,
          role: workflow.targetParentRole,
          objectId: workflow.targetParentId,
          expected: workflow.targetParentEvidence,
        },
        {
          canaryWorkflow: Object.freeze({
            ...workflow,
            stage: "sync_target" as const,
          }),
        },
      );
    }
    if (workflow.stage === "sync_target") {
      const proof = Object.freeze({
        ...workflow.proof,
        sourceParentSynced: true,
        targetParentSynced: true,
      });
      const publishing = workflow.action === "prove_mount";
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "persist_canary_phase",
          operationId: workflow.proof.operationId,
          previousPhase: workflow.durablePhase,
          proof,
          evidenceDigest: sha256(
            new TextEncoder().encode(JSON.stringify(proof)),
          ),
        },
        {
          canaryWorkflow: Object.freeze({
            ...workflow,
            durablePhase: publishing
              ? ("published" as const)
              : ("deleting" as const),
            stage: publishing
              ? ("persist_published" as const)
              : ("persist_deleting_evidence" as const),
            proof,
          }),
          canaryReplayAuthority:
            canaryReplayAuthorityFromProof(proof),
        },
      );
    }
  }
  if (
    observation.kind === "native_resolved" &&
    request.kind === "native_no_replace"
  ) {
    return scheduleAtomicEffect(
      accepted,
      {
        kind: "observe_locations",
        requestKind: "native_no_replace",
        operationId: request.operationId,
        move: request.move,
        sourceParentId: request.sourceParentId,
        sourceId: request.sourceId,
        sourceLeaf: request.sourceLeaf,
        targetParentId: request.targetParentId,
        targetLeaf: request.targetLeaf,
        expectedSource: request.expectedSource,
        expectedTarget: request.expectedTarget,
        evidenceDigest: request.evidenceDigest,
      },
      {
        pendingNativeResolution: Object.freeze({
          request,
          rawCode: observation.rawCode,
          nativePrecheckEvidenceDigest:
            observation.nativePrecheckEvidenceDigest,
        }),
        canaryWorkflow:
          workflow === null
            ? null
            : Object.freeze({
                ...workflow,
                stage: "observe" as const,
              }),
      },
    );
  }
  if (
    observation.kind === "locations_observed" &&
    observation.requestKind === "native_no_replace" &&
    request.kind === "observe_locations" &&
    request.requestKind === "native_no_replace"
  ) {
    if (
      workflow !== null &&
      workflow.stage === "verify_published_locations"
    ) {
      const sourceAbsent =
        observation.source.state === "absent" &&
        observation.sourceObjectId === null;
      const targetMatches =
        exactLocationMatch(
          observation.target,
          workflow.proof.privateSourceEvidence,
        ) && observation.targetObjectId !== null;
      if (sourceAbsent && targetMatches) {
        const classification: AtomicNativeClassificationV1 =
          Object.freeze({
            outcome: "published",
            nativeCode: "atomic_publish_replay_completed",
            sourceMatches: false,
            targetMatches: true,
            targetOther: false,
            nativePrecheckEvidenceDigest: request.evidenceDigest,
            locationEvidenceDigest: observation.evidenceDigest,
          });
        return terminal(
          Object.freeze({
            ...accepted,
            nativeClassification: classification,
            canaryWorkflow: null,
          }),
          Object.freeze({
            kind: "mount_proved" as const,
            proof: workflow.proof,
          }),
        );
      }
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "close_admission",
          operationId: request.operationId,
          reason: "binding_invalid",
          evidenceDigest: sha256(
            new TextEncoder().encode(
              JSON.stringify({
                verification: request.evidenceDigest,
                locations: observation.evidenceDigest,
                sourceState: observation.source.state,
                targetState: observation.target.state,
              }),
            ),
          ),
        },
        {
          pendingNativeFailure: "native_binding_invalid",
          canaryWorkflow: null,
        },
      );
    }
    const pending = accepted.pendingNativeResolution;
    if (pending === null) return fail(accepted, "observation_mismatch");
    const classification = nativeClassificationFromLocations(
      pending,
      accepted.canaryReplayAuthority,
      observation,
    );
    const action =
      classification?.nativeCode === "atomic_publish_replay_completed"
        ? null
        : nativeFailureAction(
            pending.rawCode,
            classification === null,
          );
    if (
      classification !== null &&
      classification.outcome === "conflict"
    ) {
      const evidenceDigest = sha256(
        new TextEncoder().encode(
          JSON.stringify({
            rawCode: pending.rawCode,
            precheck: pending.nativePrecheckEvidenceDigest,
            locations: observation.evidenceDigest,
            reason: "binding_invalid",
          }),
        ),
      );
      return scheduleAtomicEffect(
        accepted,
        {
          kind: "close_admission",
          operationId: request.operationId,
          reason: "binding_invalid",
          evidenceDigest,
        },
        {
          pendingNativeResolution: null,
          nativeClassification: classification,
          pendingNativeFailure: "native_binding_invalid",
          canaryWorkflow: null,
        },
      );
    }
    if (classification !== null && action === null) {
      if (
        workflow !== null &&
        workflow.stage === "observe" &&
        classification.outcome === "published" &&
        observation.target.evidence !== null
      ) {
        const proof: AtomicCanaryProofV1 =
          workflow.action === "prove_mount"
            ? Object.freeze({
                ...workflow.proof,
                phase: "published" as const,
                publishedEvidence: observation.target.evidence,
                classification,
                sourceParentSynced: false,
                targetParentSynced: false,
              })
            : Object.freeze({
                ...workflow.proof,
                phase: "deleting" as const,
                privateDeletionEvidence: observation.target.evidence,
                sourceParentSynced: false,
                targetParentSynced: false,
              });
        return scheduleAtomicEffect(
          accepted,
          {
            kind: "fsync_directory",
            operationId: workflow.proof.operationId,
            role: workflow.sourceParentRole,
            objectId: workflow.sourceParentId,
            expected: workflow.sourceParentEvidence,
          },
          {
            pendingNativeResolution: null,
            nativeClassification: classification,
            canaryWorkflow: Object.freeze({
              ...workflow,
              stage: "sync_source" as const,
              proof,
            }),
            canaryReplayAuthority:
              canaryReplayAuthorityFromProof(proof),
          },
        );
      }
      return completed(
        Object.freeze({
          ...accepted,
          pendingNativeResolution: null,
          nativeClassification: classification,
        }),
      );
    }
    if (action === null) {
      return fail(accepted, "native_ambiguous");
    }
    const evidenceDigest = sha256(
      new TextEncoder().encode(
        JSON.stringify({
          rawCode: pending.rawCode,
          precheck: pending.nativePrecheckEvidenceDigest,
          locations: observation.evidenceDigest,
          reason: action.reason,
        }),
      ),
    );
    return scheduleAtomicEffect(
      accepted,
      {
        kind: "close_admission",
        operationId: request.operationId,
        reason: action.reason,
        evidenceDigest,
      },
      {
        pendingNativeResolution: null,
        nativeClassification: classification,
        pendingNativeFailure: action.failure,
      },
    );
  }
  if (
    observation.kind === "effect_completed" &&
    request.kind === "close_admission" &&
    accepted.pendingNativeFailure !== null
  ) {
    return fail(
      Object.freeze({
        ...accepted,
        admission: "closed" as const,
        pendingNativeFailure: null,
      }),
      accepted.pendingNativeFailure,
    );
  }
  return completed(accepted);
}
