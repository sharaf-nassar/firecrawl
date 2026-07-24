import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const ATOMIC_PUBLISH_INTENT_MAX_BYTES = 16 * 1024;
export const CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES = 25_000;
export const CLEANUP_IDENTITY_MANIFEST_MAX_BYTES = 33_554_432;
export const CLEANUP_IDENTITY_PATH_MAX_BYTES = 1_024;
export const CLEANUP_IDENTITY_PATH_MAX_SEGMENTS = 64;
export const CLEANUP_IDENTITY_SEGMENT_MAX_BYTES = 255;
export const PROFILE_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const PROFILE_PAYLOAD_MAX_BYTES = 268_435_456;

export type CanonicalUuid = string;
export type Sha256 = string;

export type HeldParentEvidenceV1 = Readonly<{
  dev: string;
  ino: string;
  mode: 448;
}>;

export type PublicationTargetV1 =
  | Readonly<{
      kind: "profile";
      profileId: CanonicalUuid;
      leaf: CanonicalUuid;
      parent: HeldParentEvidenceV1;
    }>
  | Readonly<{
      kind: "profile_state";
      profileId: CanonicalUuid;
      state: "working" | "staging" | "committed";
      generationId: CanonicalUuid;
      leaf: CanonicalUuid;
      parent: HeldParentEvidenceV1;
    }>
  | Readonly<{
      kind: "canary_parent";
      parentLocator:
        | Readonly<{ kind: "profiles" }>
        | Readonly<{
            kind: "profile_state";
            profileId: CanonicalUuid;
            state: "working" | "staging" | "committed";
          }>;
      parent: HeldParentEvidenceV1;
    }>;

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

export type AtomicPublishIntentV1 = Readonly<{
  version: 1;
  operationId: CanonicalUuid;
  kind: "canary" | "scaffold" | "working" | "prepare" | "finalize";
  phase: AtomicPublishPhaseV1;
  binding: Readonly<{
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: Sha256;
  }>;
  target: PublicationTargetV1;
  wrapper: Readonly<{
    dev: string;
    ino: string;
    mode: 448;
  }> | null;
  privateSource: Readonly<{
    dev: string;
    ino: string;
    mode: 448;
    checksum: Sha256;
    byteSize: number;
  }> | null;
  publicSource: Readonly<{
    profileId: CanonicalUuid;
    state: "working" | "staging";
    generationId: CanonicalUuid;
    dev: string;
    ino: string;
    mode: 448;
    checksum: Sha256;
    byteSize: number;
    capabilityDigest: Sha256;
  }> | null;
  classification: Readonly<{
    outcome: "unpublished" | "conflict" | "published" | "ambiguous";
    nativeCode:
      | "success"
      | "atomic_publish_replay_completed"
      | "atomic_publish_exists"
      | "atomic_publish_unsupported"
      | "atomic_publish_cross_device"
      | "atomic_publish_binding_invalid"
      | "atomic_publish_denied"
      | "atomic_publish_invalid_argument"
      | "atomic_publish_io";
    sourceMatches: boolean;
    targetMatches: boolean;
    targetOther: boolean;
    evidenceDigest: Sha256;
  }> | null;
  sourceDeletion: Readonly<{
    phase: "pending" | "moved_private" | "removing" | "removed";
    privateDeletionLeaf: `delete-${CanonicalUuid}`;
    evidenceDigest: Sha256;
    entryCount: number;
    nextIndex: number;
  }> | null;
  adoption: Readonly<{
    authority:
      | "scaffold"
      | "registry"
      | "prepare_token"
      | "reconciliation_snapshot";
    authorityDigest: Sha256;
  }> | null;
  cleanup: Readonly<{
    phase: "aborting_prepublication" | "discarding" | "cleaned";
    outcome:
      | "never_attempted"
      | "unpublished"
      | "conflict"
      | "released_to_reconciliation"
      | "adopted"
      | "canary_complete";
    evidenceDigest: Sha256;
    suffix:
      | "private_source_entries"
      | "private_source_root"
      | "wrapper_temps"
      | "wrapper_root"
      | "intent_temps"
      | "done";
    nextIndex: number;
  }> | null;
  canaryProof: Readonly<{
    attempt: 0;
    sourceLeaf: `proof-${CanonicalUuid}-0`;
    targetLeaf: `canary-${CanonicalUuid}-0`;
    deletionLeaf: `deletion-${CanonicalUuid}-0`;
    phase: "planned" | "published" | "deleting" | "cleaned";
    dev: string | null;
    ino: string | null;
    mode: 448 | null;
    evidenceDigest: Sha256 | null;
  }> | null;
  prepublicationAbort: Readonly<{
    outcome: "never_attempted";
    from: "allocated" | "building";
    evidenceDigest: Sha256;
  }> | null;
  identityManifest: Readonly<{
    phase: "planned" | "published" | "deleting";
    filename: `${CanonicalUuid}.identities.json`;
    tempFilename: `${CanonicalUuid}.identities.${CanonicalUuid}.tmp`;
    sha256: Sha256;
    entryCount: number;
    byteSize: number;
    dev: string | null;
    ino: string | null;
    mode: 384 | null;
  }> | null;
}>;

export type CleanupIdentityEntryV1 = Readonly<{
  index: number;
  scope:
    | "private_profile_payload"
    | "private_canary_proof"
    | "public_source"
    | "private_profile_deletion"
    | "private_canary_deletion"
    | "wrapper_temp"
    | "intent_temp";
  path: string;
  type: "file" | "directory";
  dev: string;
  ino: string;
  mode: number;
  size: number;
  contentSha256: Sha256 | null;
}>;

export type CleanupIdentityManifestV1 = Readonly<{
  version: 1;
  operationId: CanonicalUuid;
  binding: Readonly<{
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: Sha256;
  }>;
  targetLocatorDigest: Sha256;
  entries: readonly CleanupIdentityEntryV1[];
}>;

export type AtomicPublicationIntentLeafV1 =
  | Readonly<{
      kind: "intent_stable";
      operationId: CanonicalUuid;
    }>
  | Readonly<{
      kind: "intent_temp";
      operationId: CanonicalUuid;
      phase: AtomicPublishPhaseV1;
      transitionId: CanonicalUuid;
    }>
  | Readonly<{
      kind: "identity_stable";
      operationId: CanonicalUuid;
    }>
  | Readonly<{
      kind: "identity_temp";
      operationId: CanonicalUuid;
      transitionId: CanonicalUuid;
    }>;

export type AtomicPublicationWrapperLeafV1 = Readonly<{
  kind:
    | "profile_payload"
    | "profile_deletion"
    | "canary_proof"
    | "canary_deletion";
  leaf: string;
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

const INTENT_KEYS = [
  "version",
  "operationId",
  "kind",
  "phase",
  "binding",
  "target",
  "wrapper",
  "privateSource",
  "publicSource",
  "classification",
  "sourceDeletion",
  "adoption",
  "cleanup",
  "canaryProof",
  "prepublicationAbort",
  "identityManifest",
] as const;
const BINDING_KEYS = [
  "processNonce",
  "controlGenerationNonce",
  "snapshotDigest",
] as const;
const MANIFEST_KEYS = [
  "version",
  "operationId",
  "binding",
  "targetLocatorDigest",
  "entries",
] as const;
const ENTRY_KEYS = [
  "index",
  "scope",
  "path",
  "type",
  "dev",
  "ino",
  "mode",
  "size",
  "contentSha256",
] as const;

const PHASES = new Set<AtomicPublishPhaseV1>([
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
]);
const KINDS = new Set<AtomicPublishIntentV1["kind"]>([
  "canary",
  "scaffold",
  "working",
  "prepare",
  "finalize",
]);
const SCOPES = new Set<CleanupIdentityEntryV1["scope"]>([
  "private_profile_payload",
  "private_canary_proof",
  "public_source",
  "private_profile_deletion",
  "private_canary_deletion",
  "wrapper_temp",
  "intent_temp",
]);
const NATIVE_CODES = new Set<
  NonNullable<AtomicPublishIntentV1["classification"]>["nativeCode"]
>([
  "success",
  "atomic_publish_replay_completed",
  "atomic_publish_exists",
  "atomic_publish_unsupported",
  "atomic_publish_cross_device",
  "atomic_publish_binding_invalid",
  "atomic_publish_denied",
  "atomic_publish_invalid_argument",
  "atomic_publish_io",
]);
const CLEANUP_SUFFIX_ORDER = new Map<
  NonNullable<AtomicPublishIntentV1["cleanup"]>["suffix"],
  number
>([
  ["private_source_entries", 0],
  ["private_source_root", 1],
  ["wrapper_temps", 2],
  ["wrapper_root", 3],
  ["intent_temps", 4],
  ["done", 5],
]);
const SOURCE_DELETION_ORDER = new Map<
  NonNullable<AtomicPublishIntentV1["sourceDeletion"]>["phase"],
  number
>([
  ["pending", 0],
  ["moved_private", 1],
  ["removing", 2],
  ["removed", 3],
]);
const CANARY_PROOF_ORDER = new Map<
  NonNullable<AtomicPublishIntentV1["canaryProof"]>["phase"],
  number
>([
  ["planned", 0],
  ["published", 1],
  ["deleting", 2],
  ["cleaned", 3],
]);
const IDENTITY_MANIFEST_ORDER = new Map<
  NonNullable<AtomicPublishIntentV1["identityManifest"]>["phase"],
  number
>([
  ["planned", 0],
  ["published", 1],
  ["deleting", 2],
]);

function invalid(detail: string): never {
  throw new TypeError(`atomic_publication_manifest_invalid: ${detail}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    invalid(`${label} has unknown or missing fields`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalid(`${label}.${key} must be an enumerable data field`);
    }
  }
}

function exactArray(value: unknown[], label: string): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== value.length + 1) {
    invalid(`${label} has unknown, symbolic, or missing fields`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (actual[index] !== String(index)) {
      invalid(`${label} has unknown, symbolic, or missing fields`);
    }
  }
  if (actual[value.length] !== "length") {
    invalid(`${label} has unknown, symbolic, or missing fields`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalid(`${label}[${index}] must be an enumerable data field`);
    }
  }
}

function oneOf<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    invalid(`${label} is invalid`);
  }
  return value as T;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(`${label} must be a safe integer in range`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be boolean`);
  return value;
}

function canonicalUuid(value: unknown, label: string): CanonicalUuid {
  if (typeof value !== "string" || !UUID.test(value)) {
    invalid(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

function sha256(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !SHA256.test(value)) {
    invalid(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    invalid(`${label} must be a canonical nonnegative decimal`);
  }
  return value;
}

function token(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    invalid(`${label} must be a canonical 32-byte base64url token`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    invalid(`${label} must be a canonical 32-byte base64url token`);
  }
  return value;
}

function wellFormedNfc(value: unknown, label: string): string {
  if (typeof value !== "string" || value.normalize("NFC") !== value) {
    invalid(`${label} must be NFC text`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        invalid(`${label} contains malformed Unicode`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid(`${label} contains malformed Unicode`);
    }
  }
  return value;
}

function binding(value: unknown, label: string) {
  const record = asRecord(value, label);
  exactKeys(record, BINDING_KEYS, label);
  return {
    processNonce: token(record.processNonce, `${label}.processNonce`),
    controlGenerationNonce: token(
      record.controlGenerationNonce,
      `${label}.controlGenerationNonce`,
    ),
    snapshotDigest: sha256(record.snapshotDigest, `${label}.snapshotDigest`),
  } as const;
}

function heldParent(value: unknown, label: string): HeldParentEvidenceV1 {
  const record = asRecord(value, label);
  exactKeys(record, ["dev", "ino", "mode"], label);
  if (record.mode !== 448) invalid(`${label}.mode must be 448`);
  return {
    dev: decimal(record.dev, `${label}.dev`),
    ino: decimal(record.ino, `${label}.ino`),
    mode: 448,
  };
}

function target(value: unknown): PublicationTargetV1 {
  const record = asRecord(value, "target");
  if (record.kind === "profile") {
    exactKeys(record, ["kind", "profileId", "leaf", "parent"], "target");
    return {
      kind: "profile",
      profileId: canonicalUuid(record.profileId, "target.profileId"),
      leaf: canonicalUuid(record.leaf, "target.leaf"),
      parent: heldParent(record.parent, "target.parent"),
    };
  }
  if (record.kind === "profile_state") {
    exactKeys(
      record,
      ["kind", "profileId", "state", "generationId", "leaf", "parent"],
      "target",
    );
    return {
      kind: "profile_state",
      profileId: canonicalUuid(record.profileId, "target.profileId"),
      state: oneOf(
        record.state,
        new Set(["working", "staging", "committed"] as const),
        "target.state",
      ),
      generationId: canonicalUuid(record.generationId, "target.generationId"),
      leaf: canonicalUuid(record.leaf, "target.leaf"),
      parent: heldParent(record.parent, "target.parent"),
    };
  }
  if (record.kind === "canary_parent") {
    exactKeys(record, ["kind", "parentLocator", "parent"], "target");
    const locator = asRecord(record.parentLocator, "target.parentLocator");
    if (locator.kind === "profiles") {
      exactKeys(locator, ["kind"], "target.parentLocator");
      return {
        kind: "canary_parent",
        parentLocator: { kind: "profiles" },
        parent: heldParent(record.parent, "target.parent"),
      };
    }
    if (locator.kind === "profile_state") {
      exactKeys(
        locator,
        ["kind", "profileId", "state"],
        "target.parentLocator",
      );
      return {
        kind: "canary_parent",
        parentLocator: {
          kind: "profile_state",
          profileId: canonicalUuid(
            locator.profileId,
            "target.parentLocator.profileId",
          ),
          state: oneOf(
            locator.state,
            new Set(["working", "staging", "committed"] as const),
            "target.parentLocator.state",
          ),
        },
        parent: heldParent(record.parent, "target.parent"),
      };
    }
    invalid("target.parentLocator is invalid");
  }
  invalid("target.kind is invalid");
}

function wrapper(value: unknown) {
  if (value === null) return null;
  const normalized = heldParent(value, "wrapper");
  return { ...normalized };
}

function privateSource(value: unknown) {
  if (value === null) return null;
  const record = asRecord(value, "privateSource");
  exactKeys(
    record,
    ["dev", "ino", "mode", "checksum", "byteSize"],
    "privateSource",
  );
  if (record.mode !== 448) invalid("privateSource.mode must be 448");
  return {
    dev: decimal(record.dev, "privateSource.dev"),
    ino: decimal(record.ino, "privateSource.ino"),
    mode: 448 as const,
    checksum: sha256(record.checksum, "privateSource.checksum"),
    byteSize: integer(
      record.byteSize,
      0,
      PROFILE_PAYLOAD_MAX_BYTES,
      "privateSource.byteSize",
    ),
  };
}

function publicSource(value: unknown) {
  if (value === null) return null;
  const record = asRecord(value, "publicSource");
  exactKeys(
    record,
    [
      "profileId",
      "state",
      "generationId",
      "dev",
      "ino",
      "mode",
      "checksum",
      "byteSize",
      "capabilityDigest",
    ],
    "publicSource",
  );
  if (record.mode !== 448) invalid("publicSource.mode must be 448");
  return {
    profileId: canonicalUuid(record.profileId, "publicSource.profileId"),
    state: oneOf(
      record.state,
      new Set(["working", "staging"] as const),
      "publicSource.state",
    ),
    generationId: canonicalUuid(
      record.generationId,
      "publicSource.generationId",
    ),
    dev: decimal(record.dev, "publicSource.dev"),
    ino: decimal(record.ino, "publicSource.ino"),
    mode: 448 as const,
    checksum: sha256(record.checksum, "publicSource.checksum"),
    byteSize: integer(
      record.byteSize,
      0,
      PROFILE_PAYLOAD_MAX_BYTES,
      "publicSource.byteSize",
    ),
    capabilityDigest: sha256(
      record.capabilityDigest,
      "publicSource.capabilityDigest",
    ),
  };
}

function classification(value: unknown) {
  if (value === null) return null;
  const record = asRecord(value, "classification");
  exactKeys(
    record,
    [
      "outcome",
      "nativeCode",
      "sourceMatches",
      "targetMatches",
      "targetOther",
      "evidenceDigest",
    ],
    "classification",
  );
  return {
    outcome: oneOf(
      record.outcome,
      new Set(["unpublished", "conflict", "published", "ambiguous"] as const),
      "classification.outcome",
    ),
    nativeCode: oneOf(
      record.nativeCode,
      NATIVE_CODES,
      "classification.nativeCode",
    ),
    sourceMatches: boolean(
      record.sourceMatches,
      "classification.sourceMatches",
    ),
    targetMatches: boolean(
      record.targetMatches,
      "classification.targetMatches",
    ),
    targetOther: boolean(record.targetOther, "classification.targetOther"),
    evidenceDigest: sha256(
      record.evidenceDigest,
      "classification.evidenceDigest",
    ),
  };
}

function sourceDeletion(value: unknown, operationId: string) {
  if (value === null) return null;
  const record = asRecord(value, "sourceDeletion");
  exactKeys(
    record,
    [
      "phase",
      "privateDeletionLeaf",
      "evidenceDigest",
      "entryCount",
      "nextIndex",
    ],
    "sourceDeletion",
  );
  const leaf = `delete-${operationId}`;
  if (record.privateDeletionLeaf !== leaf) {
    invalid("sourceDeletion.privateDeletionLeaf does not bind operation");
  }
  return {
    phase: oneOf(
      record.phase,
      new Set(["pending", "moved_private", "removing", "removed"] as const),
      "sourceDeletion.phase",
    ),
    privateDeletionLeaf: leaf as `delete-${CanonicalUuid}`,
    evidenceDigest: sha256(
      record.evidenceDigest,
      "sourceDeletion.evidenceDigest",
    ),
    entryCount: integer(
      record.entryCount,
      0,
      CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES,
      "sourceDeletion.entryCount",
    ),
    nextIndex: integer(
      record.nextIndex,
      0,
      CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES,
      "sourceDeletion.nextIndex",
    ),
  };
}

function adoption(value: unknown) {
  if (value === null) return null;
  const record = asRecord(value, "adoption");
  exactKeys(record, ["authority", "authorityDigest"], "adoption");
  return {
    authority: oneOf(
      record.authority,
      new Set([
        "scaffold",
        "registry",
        "prepare_token",
        "reconciliation_snapshot",
      ] as const),
      "adoption.authority",
    ),
    authorityDigest: sha256(record.authorityDigest, "adoption.authorityDigest"),
  };
}

function cleanup(value: unknown) {
  if (value === null) return null;
  const record = asRecord(value, "cleanup");
  exactKeys(
    record,
    ["phase", "outcome", "evidenceDigest", "suffix", "nextIndex"],
    "cleanup",
  );
  return {
    phase: oneOf(
      record.phase,
      new Set(["aborting_prepublication", "discarding", "cleaned"] as const),
      "cleanup.phase",
    ),
    outcome: oneOf(
      record.outcome,
      new Set([
        "never_attempted",
        "unpublished",
        "conflict",
        "released_to_reconciliation",
        "adopted",
        "canary_complete",
      ] as const),
      "cleanup.outcome",
    ),
    evidenceDigest: sha256(record.evidenceDigest, "cleanup.evidenceDigest"),
    suffix: oneOf(
      record.suffix,
      new Set([
        "private_source_entries",
        "private_source_root",
        "wrapper_temps",
        "wrapper_root",
        "intent_temps",
        "done",
      ] as const),
      "cleanup.suffix",
    ),
    nextIndex: integer(
      record.nextIndex,
      0,
      CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES,
      "cleanup.nextIndex",
    ),
  };
}

function canaryProof(value: unknown, operationId: string) {
  if (value === null) return null;
  const record = asRecord(value, "canaryProof");
  exactKeys(
    record,
    [
      "attempt",
      "sourceLeaf",
      "targetLeaf",
      "deletionLeaf",
      "phase",
      "dev",
      "ino",
      "mode",
      "evidenceDigest",
    ],
    "canaryProof",
  );
  integer(record.attempt, 0, 0, "canaryProof.attempt");
  const sourceLeaf = `proof-${operationId}-0`;
  const targetLeaf = `canary-${operationId}-0`;
  const deletionLeaf = `deletion-${operationId}-0`;
  if (
    record.sourceLeaf !== sourceLeaf ||
    record.targetLeaf !== targetLeaf ||
    record.deletionLeaf !== deletionLeaf
  ) {
    invalid("canaryProof leaves do not bind operation");
  }
  const phase = oneOf(
    record.phase,
    new Set(["planned", "published", "deleting", "cleaned"] as const),
    "canaryProof.phase",
  );
  const evidenceIsNull =
    record.dev === null &&
    record.ino === null &&
    record.mode === null &&
    record.evidenceDigest === null;
  if (phase === "planned") {
    if (!evidenceIsNull) invalid("planned canaryProof must have null evidence");
  } else if (
    record.dev === null ||
    record.ino === null ||
    record.mode !== 448 ||
    record.evidenceDigest === null
  ) {
    invalid("published canaryProof requires complete evidence");
  }
  return {
    attempt: 0 as const,
    sourceLeaf: sourceLeaf as `proof-${CanonicalUuid}-0`,
    targetLeaf: targetLeaf as `canary-${CanonicalUuid}-0`,
    deletionLeaf: deletionLeaf as `deletion-${CanonicalUuid}-0`,
    phase,
    dev: record.dev === null ? null : decimal(record.dev, "canaryProof.dev"),
    ino: record.ino === null ? null : decimal(record.ino, "canaryProof.ino"),
    mode: record.mode === null ? null : (448 as const),
    evidenceDigest:
      record.evidenceDigest === null
        ? null
        : sha256(record.evidenceDigest, "canaryProof.evidenceDigest"),
  };
}

function prepublicationAbort(value: unknown) {
  if (value === null) return null;
  const record = asRecord(value, "prepublicationAbort");
  exactKeys(
    record,
    ["outcome", "from", "evidenceDigest"],
    "prepublicationAbort",
  );
  if (record.outcome !== "never_attempted") {
    invalid("prepublicationAbort.outcome is invalid");
  }
  return {
    outcome: "never_attempted" as const,
    from: oneOf(
      record.from,
      new Set(["allocated", "building"] as const),
      "prepublicationAbort.from",
    ),
    evidenceDigest: sha256(
      record.evidenceDigest,
      "prepublicationAbort.evidenceDigest",
    ),
  };
}

function identityManifest(value: unknown, operationId: string) {
  if (value === null) return null;
  const record = asRecord(value, "identityManifest");
  exactKeys(
    record,
    [
      "phase",
      "filename",
      "tempFilename",
      "sha256",
      "entryCount",
      "byteSize",
      "dev",
      "ino",
      "mode",
    ],
    "identityManifest",
  );
  if (record.filename !== `${operationId}.identities.json`) {
    invalid("identityManifest.filename does not bind operation");
  }
  if (typeof record.tempFilename !== "string") {
    invalid("identityManifest.tempFilename is invalid");
  }
  const prefix = `${operationId}.identities.`;
  const suffix = ".tmp";
  if (
    !record.tempFilename.startsWith(prefix) ||
    !record.tempFilename.endsWith(suffix)
  ) {
    invalid("identityManifest.tempFilename does not bind operation");
  }
  canonicalUuid(
    record.tempFilename.slice(prefix.length, -suffix.length),
    "identityManifest transition ID",
  );
  const phase = oneOf(
    record.phase,
    new Set(["planned", "published", "deleting"] as const),
    "identityManifest.phase",
  );
  const evidenceIsNull =
    record.dev === null && record.ino === null && record.mode === null;
  if (phase === "planned") {
    if (!evidenceIsNull) {
      invalid("planned identityManifest must have null inode evidence");
    }
  } else if (
    record.dev === null ||
    record.ino === null ||
    record.mode !== 384
  ) {
    invalid("stable identityManifest requires inode evidence with mode 384");
  }
  return {
    phase,
    filename: record.filename as `${CanonicalUuid}.identities.json`,
    tempFilename:
      record.tempFilename as `${CanonicalUuid}.identities.${CanonicalUuid}.tmp`,
    sha256: sha256(record.sha256, "identityManifest.sha256"),
    entryCount: integer(
      record.entryCount,
      0,
      CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES,
      "identityManifest.entryCount",
    ),
    byteSize: integer(
      record.byteSize,
      1,
      CLEANUP_IDENTITY_MANIFEST_MAX_BYTES,
      "identityManifest.byteSize",
    ),
    dev:
      record.dev === null ? null : decimal(record.dev, "identityManifest.dev"),
    ino:
      record.ino === null ? null : decimal(record.ino, "identityManifest.ino"),
    mode: record.mode === null ? null : (384 as const),
  };
}

function same(valueA: unknown, valueB: unknown): boolean {
  return JSON.stringify(valueA) === JSON.stringify(valueB);
}

function requireNull(
  value: unknown,
  label: string,
  phase: AtomicPublishPhaseV1,
): void {
  if (value !== null) invalid(`${label} is illegal in ${phase}`);
}

function requireSet<T>(
  value: T | null,
  label: string,
  phase: AtomicPublishPhaseV1,
): T {
  if (value === null) invalid(`${label} is required in ${phase}`);
  return value;
}

function validateClassification(
  intent: AtomicPublishIntentV1,
  value: NonNullable<AtomicPublishIntentV1["classification"]>,
): void {
  const flags = [
    value.sourceMatches,
    value.targetMatches,
    value.targetOther,
  ] as const;
  if (
    (value.outcome === "unpublished" && !same(flags, [true, false, false])) ||
    (value.outcome === "conflict" && !same(flags, [true, false, true])) ||
    (value.outcome === "published" && !same(flags, [false, true, false])) ||
    (value.outcome === "ambiguous" &&
      (same(flags, [true, false, false]) ||
        same(flags, [true, false, true]) ||
        same(flags, [false, true, false])))
  ) {
    invalid("classification outcome does not match location tuple");
  }
  if (value.nativeCode === "success" && value.outcome !== "published") {
    invalid("native success must classify published");
  }
  if (
    value.nativeCode === "atomic_publish_replay_completed" &&
    (intent.kind !== "canary" || value.outcome !== "published")
  ) {
    invalid("native replay completion is canary-published only");
  }
  if (
    value.nativeCode === "atomic_publish_exists" &&
    value.outcome !== "conflict"
  ) {
    invalid("native exists must classify conflict");
  }
  if (
    value.outcome === "conflict" &&
    value.nativeCode !== "atomic_publish_exists"
  ) {
    invalid("conflict classification requires native exists");
  }
}

function expectedCleanupOutcome(
  intent: AtomicPublishIntentV1,
): readonly NonNullable<AtomicPublishIntentV1["cleanup"]>["outcome"][] | null {
  if (intent.prepublicationAbort !== null) return ["never_attempted"];
  if (intent.classification?.outcome === "unpublished") return ["unpublished"];
  if (intent.classification?.outcome === "conflict") return ["conflict"];
  if (intent.classification?.outcome !== "published") return null;
  if (intent.kind === "canary") return ["canary_complete"];
  return intent.adoption === null
    ? ["released_to_reconciliation"]
    : ["adopted", "released_to_reconciliation"];
}

function requireInitialAbortCleanup(
  value: AtomicPublishIntentV1["cleanup"],
  phase: AtomicPublishPhaseV1,
): void {
  const cleanupValue = requireSet(value, "cleanup", phase);
  if (
    cleanupValue.phase !== "aborting_prepublication" ||
    cleanupValue.outcome !== "never_attempted" ||
    cleanupValue.suffix !== "private_source_entries" ||
    cleanupValue.nextIndex !== 0
  ) {
    invalid(`${phase} abort cleanup must remain at its initial cursor`);
  }
}

function validateKindAndTarget(intent: AtomicPublishIntentV1): void {
  const { kind, target: publicationTarget } = intent;
  if (kind === "canary") {
    if (publicationTarget.kind !== "canary_parent") {
      invalid("canary requires canary_parent target");
    }
  } else if (kind === "scaffold") {
    if (
      publicationTarget.kind !== "profile" ||
      publicationTarget.leaf !== publicationTarget.profileId
    ) {
      invalid("scaffold requires self-bound profile target");
    }
  } else {
    const expectedState =
      kind === "working"
        ? "working"
        : kind === "prepare"
          ? "staging"
          : "committed";
    if (
      publicationTarget.kind !== "profile_state" ||
      publicationTarget.state !== expectedState ||
      publicationTarget.leaf !== publicationTarget.generationId
    ) {
      invalid(`${kind} target does not match operation kind`);
    }
  }

  if (kind === "prepare" || kind === "finalize") {
    const source = requireSet(
      intent.publicSource,
      "publicSource",
      intent.phase,
    );
    if (
      publicationTarget.kind !== "profile_state" ||
      source.profileId !== publicationTarget.profileId ||
      source.state !== (kind === "prepare" ? "working" : "staging") ||
      source.generationId !== publicationTarget.generationId
    ) {
      invalid("publicSource does not bind source operation");
    }
    if (
      intent.privateSource !== null &&
      (intent.privateSource.checksum !== source.checksum ||
        intent.privateSource.byteSize !== source.byteSize)
    ) {
      invalid("privateSource does not match authenticated publicSource");
    }
  } else if (intent.publicSource !== null) {
    invalid("publicSource is prepare/finalize only");
  }
  if (kind === "canary") {
    requireSet(intent.canaryProof, "canaryProof", intent.phase);
  } else {
    requireNull(intent.canaryProof, "canaryProof", intent.phase);
  }
}

function validateAdoption(intent: AtomicPublishIntentV1): void {
  const value = intent.adoption;
  if (value === null) return;
  if (intent.classification?.outcome !== "published") {
    invalid("adoption requires published classification");
  }
  const allowed =
    intent.kind === "scaffold"
      ? value.authority === "scaffold"
      : intent.kind === "working"
        ? value.authority === "registry"
        : intent.kind === "prepare"
          ? value.authority === "prepare_token" ||
            value.authority === "reconciliation_snapshot"
          : intent.kind === "finalize"
            ? value.authority === "reconciliation_snapshot"
            : false;
  if (!allowed) invalid("adoption authority does not match operation kind");
}

function validateCanaryProof(intent: AtomicPublishIntentV1): void {
  const proof = intent.canaryProof;
  if (proof === null) return;
  const classificationValue = intent.classification;
  if (classificationValue === null) {
    if (proof.phase !== "planned") {
      invalid("unclassified canary proof must be planned");
    }
    return;
  }
  if (classificationValue.outcome !== "published") {
    if (proof.phase !== "planned") {
      invalid("unpublished canary proof must remain planned");
    }
    return;
  }
  if (proof.phase === "planned") {
    invalid("published canary requires published proof");
  }
  if (
    (proof.phase === "deleting" || proof.phase === "cleaned") &&
    !["discarding", "manifest_deleting", "cleaned"].includes(intent.phase)
  ) {
    invalid("canary deletion proof is illegal before discard");
  }
  if (
    (intent.phase === "manifest_deleting" || intent.phase === "cleaned") &&
    proof.phase !== "cleaned"
  ) {
    invalid("terminal canary cleanup requires cleaned proof");
  }
}

function validateIntentMatrix(intent: AtomicPublishIntentV1): void {
  validateKindAndTarget(intent);
  validateAdoption(intent);
  validateCanaryProof(intent);
  if (intent.classification !== null) {
    validateClassification(intent, intent.classification);
  }

  const { phase } = intent;
  const isAbort = intent.prepublicationAbort !== null;
  const classifiedNonAmbiguous =
    intent.classification !== null &&
    intent.classification.outcome !== "ambiguous";
  if (
    intent.identityManifest?.entryCount === 0 &&
    !(
      intent.prepublicationAbort?.from === "building" &&
      intent.wrapper !== null &&
      intent.privateSource === null
    )
  ) {
    invalid("empty identity manifest requires empty building abort");
  }
  if (isAbort) {
    if (
      intent.classification !== null ||
      intent.sourceDeletion !== null ||
      intent.adoption !== null
    ) {
      invalid("prepublication abort cannot carry publication authority");
    }
    if (
      (intent.prepublicationAbort?.from === "allocated" &&
        (intent.wrapper !== null || intent.privateSource !== null)) ||
      (intent.prepublicationAbort?.from === "building" &&
        (intent.wrapper === null || intent.privateSource !== null))
    ) {
      invalid("abort does not inherit its origin record");
    }
  } else if (
    [
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
    ].includes(phase)
  ) {
    requireSet(intent.wrapper, "wrapper", phase);
    requireSet(intent.privateSource, "privateSource", phase);
  }

  if (intent.sourceDeletion !== null) {
    if (
      (intent.kind !== "prepare" && intent.kind !== "finalize") ||
      intent.classification?.outcome !== "published" ||
      intent.identityManifest === null ||
      intent.identityManifest.phase === "planned"
    ) {
      invalid("sourceDeletion lacks published source authority");
    }
  }
  if (
    intent.identityManifest !== null &&
    ((intent.sourceDeletion !== null &&
      (intent.sourceDeletion.entryCount >
        intent.identityManifest.entryCount ||
        intent.sourceDeletion.nextIndex >
          intent.sourceDeletion.entryCount)) ||
      (intent.cleanup !== null &&
        intent.cleanup.nextIndex > intent.identityManifest.entryCount))
  ) {
    invalid("durable cursor exceeds identity manifest entryCount");
  }
  if (
    intent.sourceDeletion !== null &&
    intent.sourceDeletion.phase !== "removing" &&
    intent.sourceDeletion.nextIndex !== 0
  ) {
    invalid("sourceDeletion index is legal only while removing");
  }
  if (
    intent.cleanup !== null &&
    !["private_source_entries", "wrapper_temps", "intent_temps"].includes(
      intent.cleanup.suffix,
    ) &&
    intent.cleanup.nextIndex !== 0
  ) {
    invalid("cleanup index is illegal for this suffix");
  }
  if (["discarding", "manifest_deleting", "cleaned"].includes(phase)) {
    const requiresRemovedSource =
      (intent.kind === "prepare" || intent.kind === "finalize") &&
      intent.prepublicationAbort === null &&
      intent.classification?.outcome === "published";
    if (
      (requiresRemovedSource && intent.sourceDeletion?.phase !== "removed") ||
      (!requiresRemovedSource && intent.sourceDeletion !== null)
    ) {
      invalid("terminal cleanup has invalid sourceDeletion authority");
    }
  }

  switch (phase) {
    case "allocated":
      requireNull(intent.wrapper, "wrapper", phase);
      requireNull(intent.privateSource, "privateSource", phase);
      requireNull(intent.classification, "classification", phase);
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      requireNull(intent.cleanup, "cleanup", phase);
      requireNull(intent.prepublicationAbort, "prepublicationAbort", phase);
      requireNull(intent.identityManifest, "identityManifest", phase);
      break;
    case "building":
      requireSet(intent.wrapper, "wrapper", phase);
      requireNull(intent.privateSource, "privateSource", phase);
      requireNull(intent.classification, "classification", phase);
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      requireNull(intent.cleanup, "cleanup", phase);
      requireNull(intent.prepublicationAbort, "prepublicationAbort", phase);
      requireNull(intent.identityManifest, "identityManifest", phase);
      break;
    case "aborting_prepublication": {
      requireSet(intent.prepublicationAbort, "prepublicationAbort", phase);
      requireNull(intent.classification, "classification", phase);
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      requireNull(intent.identityManifest, "identityManifest", phase);
      requireInitialAbortCleanup(intent.cleanup, phase);
      break;
    }
    case "ready":
      requireSet(intent.wrapper, "wrapper", phase);
      requireSet(intent.privateSource, "privateSource", phase);
      requireNull(intent.classification, "classification", phase);
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      requireNull(intent.cleanup, "cleanup", phase);
      requireNull(intent.prepublicationAbort, "prepublicationAbort", phase);
      requireNull(intent.identityManifest, "identityManifest", phase);
      break;
    case "classified":
      requireSet(intent.wrapper, "wrapper", phase);
      requireSet(intent.privateSource, "privateSource", phase);
      requireSet(intent.classification, "classification", phase);
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      requireNull(intent.cleanup, "cleanup", phase);
      requireNull(intent.prepublicationAbort, "prepublicationAbort", phase);
      requireNull(intent.identityManifest, "identityManifest", phase);
      break;
    case "renamed":
      requireSet(intent.wrapper, "wrapper", phase);
      requireSet(intent.privateSource, "privateSource", phase);
      if (intent.classification?.outcome !== "published") {
        invalid("renamed requires published classification");
      }
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      requireNull(intent.cleanup, "cleanup", phase);
      requireNull(intent.prepublicationAbort, "prepublicationAbort", phase);
      requireNull(intent.identityManifest, "identityManifest", phase);
      break;
    case "manifest_planned": {
      const manifest = requireSet(
        intent.identityManifest,
        "identityManifest",
        phase,
      );
      if (manifest.phase !== "planned") {
        invalid("manifest_planned requires planned manifest");
      }
      if (!isAbort && !classifiedNonAmbiguous) {
        invalid("manifest planning requires classified or abort authority");
      }
      if (!isAbort) {
        requireSet(intent.wrapper, "wrapper", phase);
        requireSet(intent.privateSource, "privateSource", phase);
      }
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      if (isAbort) requireInitialAbortCleanup(intent.cleanup, phase);
      else requireNull(intent.cleanup, "cleanup", phase);
      break;
    }
    case "manifest_published": {
      const manifest = requireSet(
        intent.identityManifest,
        "identityManifest",
        phase,
      );
      if (manifest.phase !== "published") {
        invalid("manifest_published requires published manifest");
      }
      if (!isAbort && !classifiedNonAmbiguous) {
        invalid("manifest publication requires classified or abort authority");
      }
      if (!isAbort) {
        requireSet(intent.wrapper, "wrapper", phase);
        requireSet(intent.privateSource, "privateSource", phase);
      }
      requireNull(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      if (isAbort) requireInitialAbortCleanup(intent.cleanup, phase);
      else requireNull(intent.cleanup, "cleanup", phase);
      break;
    }
    case "source_deleting": {
      if (intent.kind !== "prepare" && intent.kind !== "finalize") {
        invalid("source_deleting is prepare/finalize only");
      }
      requireSet(intent.wrapper, "wrapper", phase);
      requireSet(intent.privateSource, "privateSource", phase);
      requireSet(intent.sourceDeletion, "sourceDeletion", phase);
      requireNull(intent.adoption, "adoption", phase);
      requireNull(intent.cleanup, "cleanup", phase);
      requireNull(intent.prepublicationAbort, "prepublicationAbort", phase);
      if (
        intent.classification?.outcome !== "published" ||
        intent.identityManifest?.phase !== "published"
      ) {
        invalid("source_deleting requires published destination and manifest");
      }
      break;
    }
    case "adopted":
      if (intent.kind === "canary") invalid("canary cannot be adopted");
      requireSet(intent.wrapper, "wrapper", phase);
      requireSet(intent.privateSource, "privateSource", phase);
      requireSet(intent.adoption, "adoption", phase);
      requireNull(intent.cleanup, "cleanup", phase);
      requireNull(intent.prepublicationAbort, "prepublicationAbort", phase);
      if (
        intent.classification?.outcome !== "published" ||
        intent.identityManifest?.phase !== "published"
      ) {
        invalid("adopted requires published destination and manifest");
      }
      if (
        (intent.kind === "prepare" || intent.kind === "finalize") &&
        intent.sourceDeletion?.phase !== "removed"
      ) {
        invalid("prepare/finalize adoption requires removed source");
      }
      if (
        intent.kind !== "prepare" &&
        intent.kind !== "finalize" &&
        intent.sourceDeletion !== null
      ) {
        invalid("sourceDeletion is illegal for this adoption");
      }
      break;
    case "discarding": {
      const cleanupValue = requireSet(intent.cleanup, "cleanup", phase);
      if (cleanupValue.phase !== "discarding") {
        invalid("discarding requires discarding cleanup");
      }
      if (!isAbort && !classifiedNonAmbiguous) {
        invalid("discarding requires classified or abort authority");
      }
      if (intent.identityManifest?.phase !== "published") {
        invalid("discarding requires published identity manifest");
      }
      const expected = expectedCleanupOutcome(intent);
      if (expected === null || !expected.includes(cleanupValue.outcome)) {
        invalid("cleanup outcome does not match durable authority");
      }
      if (
        intent.sourceDeletion !== null &&
        intent.sourceDeletion.phase !== "removed"
      ) {
        invalid("discarding requires completed source deletion");
      }
      break;
    }
    case "manifest_deleting": {
      const cleanupValue = requireSet(intent.cleanup, "cleanup", phase);
      if (cleanupValue.phase !== "cleaned" || cleanupValue.suffix !== "done") {
        invalid("manifest_deleting requires completed cleanup");
      }
      if (intent.identityManifest?.phase !== "deleting") {
        invalid("manifest_deleting requires deleting manifest");
      }
      const expected = expectedCleanupOutcome(intent);
      if (expected === null || !expected.includes(cleanupValue.outcome)) {
        invalid("terminal cleanup outcome does not match authority");
      }
      if (
        intent.sourceDeletion !== null &&
        intent.sourceDeletion.phase !== "removed"
      ) {
        invalid("manifest deletion requires completed source deletion");
      }
      break;
    }
    case "cleaned": {
      const cleanupValue = requireSet(intent.cleanup, "cleanup", phase);
      if (cleanupValue.phase !== "cleaned" || cleanupValue.suffix !== "done") {
        invalid("cleaned requires completed cleanup cursor");
      }
      const emptyAbort =
        isAbort &&
        intent.identityManifest === null &&
        intent.wrapper === null &&
        intent.privateSource === null;
      if (!emptyAbort && intent.identityManifest?.phase !== "deleting") {
        invalid("cleaned requires deleting manifest evidence");
      }
      const expected = expectedCleanupOutcome(intent);
      if (expected === null || !expected.includes(cleanupValue.outcome)) {
        invalid("cleaned outcome does not match durable authority");
      }
      if (
        intent.sourceDeletion !== null &&
        intent.sourceDeletion.phase !== "removed"
      ) {
        invalid("cleaned requires completed source deletion");
      }
      break;
    }
  }
}

function normalizeIntent(value: unknown): AtomicPublishIntentV1 {
  const record = asRecord(value, "intent");
  exactKeys(record, INTENT_KEYS, "intent");
  if (record.version !== 1) invalid("intent.version must be 1");
  const operationId = canonicalUuid(record.operationId, "intent.operationId");
  const kind = oneOf(record.kind, KINDS, "intent.kind");
  const phase = oneOf(record.phase, PHASES, "intent.phase");
  const normalized: AtomicPublishIntentV1 = {
    version: 1,
    operationId,
    kind,
    phase,
    binding: binding(record.binding, "intent.binding"),
    target: target(record.target),
    wrapper: wrapper(record.wrapper),
    privateSource: privateSource(record.privateSource),
    publicSource: publicSource(record.publicSource),
    classification: classification(record.classification),
    sourceDeletion: sourceDeletion(record.sourceDeletion, operationId),
    adoption: adoption(record.adoption),
    cleanup: cleanup(record.cleanup),
    canaryProof: canaryProof(record.canaryProof, operationId),
    prepublicationAbort: prepublicationAbort(record.prepublicationAbort),
    identityManifest: identityManifest(record.identityManifest, operationId),
  };
  validateIntentMatrix(normalized);
  return deepFreeze(normalized);
}

function validatePath(path: unknown): readonly string[] {
  const normalized = wellFormedNfc(path, "entry.path");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    Buffer.byteLength(normalized, "utf8") > CLEANUP_IDENTITY_PATH_MAX_BYTES
  ) {
    invalid("entry.path is invalid");
  }
  const segments = normalized.split("/");
  if (
    segments.length > CLEANUP_IDENTITY_PATH_MAX_SEGMENTS ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") >
          CLEANUP_IDENTITY_SEGMENT_MAX_BYTES ||
        /[\\/\u0000-\u001f\u007f]/u.test(segment) ||
        segment.normalize("NFC") !== segment,
    )
  ) {
    invalid("entry.path has an invalid segment");
  }
  return segments;
}

function normalizeEntry(
  value: unknown,
  expectedIndex: number,
): CleanupIdentityEntryV1 {
  const record = asRecord(value, `entries[${expectedIndex}]`);
  exactKeys(record, ENTRY_KEYS, `entries[${expectedIndex}]`);
  const index = integer(
    record.index,
    0,
    CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES - 1,
    `entries[${expectedIndex}].index`,
  );
  if (index !== expectedIndex)
    invalid("manifest entry index is not contiguous");
  const path = wellFormedNfc(record.path, `entries[${expectedIndex}].path`);
  validatePath(path);
  const type = oneOf(
    record.type,
    new Set(["file", "directory"] as const),
    `entries[${expectedIndex}].type`,
  );
  const size = integer(
    record.size,
    0,
    type === "file" ? PROFILE_FILE_MAX_BYTES : 0,
    `entries[${expectedIndex}].size`,
  );
  const contentSha256 =
    record.contentSha256 === null
      ? null
      : sha256(record.contentSha256, `entries[${expectedIndex}].contentSha256`);
  if (
    (type === "file" && contentSha256 === null) ||
    (type === "directory" && contentSha256 !== null)
  ) {
    invalid("entry checksum does not match entry type");
  }
  return {
    index,
    scope: oneOf(record.scope, SCOPES, `entries[${expectedIndex}].scope`),
    path,
    type,
    dev: decimal(record.dev, `entries[${expectedIndex}].dev`),
    ino: decimal(record.ino, `entries[${expectedIndex}].ino`),
    mode: integer(record.mode, 0, 0o777, `entries[${expectedIndex}].mode`),
    size,
    contentSha256,
  };
}

function validateEntrySequence(
  entries: readonly CleanupIdentityEntryV1[],
): void {
  const byPath = new Map<string, CleanupIdentityEntryV1>();
  let previousDepth = Number.POSITIVE_INFINITY;
  let previousAtDepth: Buffer | null = null;
  for (const entry of entries) {
    if (byPath.has(entry.path)) invalid("manifest contains duplicate path");
    const segments = entry.path.split("/");
    const depth = segments.length;
    const rawPath = Buffer.from(entry.path, "utf8");
    if (depth > previousDepth) {
      invalid("manifest entries are not in postorder");
    }
    if (
      depth === previousDepth &&
      previousAtDepth !== null &&
      Buffer.compare(previousAtDepth, rawPath) >= 0
    ) {
      invalid("manifest entries violate raw UTF-8 order");
    }
    if (depth !== previousDepth) previousAtDepth = null;
    previousDepth = depth;
    previousAtDepth = rawPath;
    byPath.set(entry.path, entry);
  }
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const parent = byPath.get(segments.slice(0, length).join("/"));
      if (parent?.type === "file") {
        invalid("manifest contains prefix/type conflict");
      }
    }
  }
}

function normalizeManifest(value: unknown): CleanupIdentityManifestV1 {
  const record = asRecord(value, "manifest");
  exactKeys(record, MANIFEST_KEYS, "manifest");
  if (record.version !== 1) invalid("manifest.version must be 1");
  if (!Array.isArray(record.entries)) invalid("manifest.entries must be array");
  if (record.entries.length > CLEANUP_IDENTITY_MANIFEST_MAX_ENTRIES) {
    invalid("manifest entry count exceeds limit");
  }
  exactArray(record.entries, "manifest.entries");
  const entries = record.entries.map((entry, index) =>
    normalizeEntry(entry, index),
  );
  validateEntrySequence(entries);
  return deepFreeze({
    version: 1,
    operationId: canonicalUuid(record.operationId, "manifest.operationId"),
    binding: binding(record.binding, "manifest.binding"),
    targetLocatorDigest: sha256(
      record.targetLocatorDigest,
      "manifest.targetLocatorDigest",
    ),
    entries,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundedCanonicalJsonByteLength(
  value: unknown,
  maximum: number,
): number {
  let total = 0;
  const add = (amount: number): void => {
    total += amount;
    if (total + 1 > maximum) {
      invalid("encoded size exceeds limit");
    }
  };
  const addString = (text: string): void => {
    add(2);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
      ) {
        add(2);
      } else if (code <= 0x1f) {
        add(6);
      } else if (code <= 0x7f) {
        add(1);
      } else if (code <= 0x7ff) {
        add(2);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        add(4);
        index += 1;
      } else {
        add(3);
      }
    }
  };
  const visit = (item: unknown): void => {
    if (item === null) {
      add(4);
    } else if (typeof item === "boolean") {
      add(item ? 4 : 5);
    } else if (typeof item === "number") {
      add(String(item).length);
    } else if (typeof item === "string") {
      addString(item);
    } else if (Array.isArray(item)) {
      add(1);
      item.forEach((child, index) => {
        if (index !== 0) add(1);
        visit(child);
      });
      add(1);
    } else if (typeof item === "object") {
      add(1);
      Object.entries(item).forEach(([key, child], index) => {
        if (index !== 0) add(1);
        addString(key);
        add(1);
        visit(child);
      });
      add(1);
    } else {
      invalid("value is not canonical JSON");
    }
  };
  visit(value);
  return total + 1;
}

function canonicalBytes(value: unknown, maximum: number): Buffer {
  const byteLength = boundedCanonicalJsonByteLength(value, maximum);
  const json = JSON.stringify(value);
  const bytes = Buffer.allocUnsafe(byteLength);
  const written = bytes.write(json, 0, byteLength - 1, "utf8");
  if (written !== byteLength - 1) {
    invalid("canonical JSON byte counter mismatch");
  }
  bytes[byteLength - 1] = 0x0a;
  return bytes;
}

function digest(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCanonical(
  bytes: Uint8Array,
  maximum: number,
  normalize: (value: unknown) => unknown,
  label: string,
): unknown {
  if (!(bytes instanceof Uint8Array)) invalid(`${label} bytes are invalid`);
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    invalid(`${label} encoded size exceeds limit`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid(`${label} is not valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid(`${label} is not valid JSON`);
  }
  const normalized = normalize(parsed);
  const canonical = canonicalBytes(normalized, maximum);
  if (
    canonical.byteLength !== bytes.byteLength ||
    !canonical.equals(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    )
  ) {
    invalid(`${label} bytes are not fixed-key canonical JSON`);
  }
  return normalized;
}

export function parseAtomicPublishIntent(
  bytes: Uint8Array,
): AtomicPublishIntentV1 {
  return decodeCanonical(
    bytes,
    ATOMIC_PUBLISH_INTENT_MAX_BYTES,
    normalizeIntent,
    "intent",
  ) as AtomicPublishIntentV1;
}

export function encodeAtomicPublishIntent(
  intent: AtomicPublishIntentV1,
): Readonly<{ bytes: Buffer; sha256: Sha256 }> {
  const normalized = normalizeIntent(intent);
  const bytes = canonicalBytes(normalized, ATOMIC_PUBLISH_INTENT_MAX_BYTES);
  return Object.freeze({ bytes, sha256: digest(bytes) });
}

export function parseCleanupIdentityManifest(
  bytes: Uint8Array,
): CleanupIdentityManifestV1 {
  return decodeCanonical(
    bytes,
    CLEANUP_IDENTITY_MANIFEST_MAX_BYTES,
    normalizeManifest,
    "manifest",
  ) as CleanupIdentityManifestV1;
}

export function encodeCleanupIdentityManifest(
  manifest: CleanupIdentityManifestV1,
): Readonly<{ bytes: Buffer; sha256: Sha256; entryCount: number }> {
  const normalized = normalizeManifest(manifest);
  const bytes = canonicalBytes(normalized, CLEANUP_IDENTITY_MANIFEST_MAX_BYTES);
  return Object.freeze({
    bytes,
    sha256: digest(bytes),
    entryCount: normalized.entries.length,
  });
}

function privateLeaf(value: unknown, label: string): string {
  const leaf = wellFormedNfc(value, label);
  if (
    leaf === "" ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(leaf) ||
    leaf.includes("/") ||
    leaf.includes("\\") ||
    Buffer.byteLength(leaf, "utf8") > 128
  ) {
    invalid(`${label} is not a canonical private leaf`);
  }
  return leaf;
}

export function parseAtomicPublicationIntentLeaf(
  value: string,
): AtomicPublicationIntentLeafV1 {
  const leaf = privateLeaf(value, "intent leaf");
  if (leaf.endsWith(".identities.json")) {
    const operationId = canonicalUuid(
      leaf.slice(0, -".identities.json".length),
      "identity stable operation ID",
    );
    return deepFreeze({ kind: "identity_stable", operationId });
  }
  if (leaf.endsWith(".tmp")) {
    const withoutSuffix = leaf.slice(0, -".tmp".length);
    const identityMarker = ".identities.";
    const identityOffset = withoutSuffix.indexOf(identityMarker);
    if (identityOffset !== -1) {
      if (
        identityOffset === 0 ||
        withoutSuffix.indexOf(
          identityMarker,
          identityOffset + identityMarker.length,
        ) !== -1
      ) {
        invalid("identity temp leaf grammar is invalid");
      }
      const operationId = canonicalUuid(
        withoutSuffix.slice(0, identityOffset),
        "identity temp operation ID",
      );
      const transitionId = canonicalUuid(
        withoutSuffix.slice(identityOffset + identityMarker.length),
        "identity temp transition ID",
      );
      return deepFreeze({
        kind: "identity_temp",
        operationId,
        transitionId,
      });
    }
    const pieces = withoutSuffix.split(".");
    if (pieces.length !== 3) invalid("intent temp leaf grammar is invalid");
    return deepFreeze({
      kind: "intent_temp",
      operationId: canonicalUuid(pieces[0], "intent temp operation ID"),
      phase: oneOf(pieces[1], PHASES, "intent temp phase"),
      transitionId: canonicalUuid(pieces[2], "intent temp transition ID"),
    });
  }
  if (leaf.endsWith(".json")) {
    return deepFreeze({
      kind: "intent_stable",
      operationId: canonicalUuid(
        leaf.slice(0, -".json".length),
        "intent stable operation ID",
      ),
    });
  }
  invalid("intent leaf grammar is invalid");
}

export function parseAtomicPublicationWrapperName(
  value: string,
): CanonicalUuid {
  return canonicalUuid(
    privateLeaf(value, "wrapper name"),
    "wrapper operation ID",
  );
}

export function parseAtomicPublicationWrapperLeaf(
  intentValue: AtomicPublishIntentV1,
  value: string,
): AtomicPublicationWrapperLeafV1 {
  const intent = normalizeIntent(intentValue);
  const leaf = privateLeaf(value, "wrapper leaf");
  if (intent.kind === "canary") {
    if (leaf === `proof-${intent.operationId}-0`) {
      return deepFreeze({ kind: "canary_proof", leaf });
    }
    if (leaf === `deletion-${intent.operationId}-0`) {
      return deepFreeze({ kind: "canary_deletion", leaf });
    }
    invalid("wrapper leaf is incompatible with canary operation");
  }
  if (leaf === "payload") {
    return deepFreeze({ kind: "profile_payload", leaf });
  }
  if (
    (intent.kind === "prepare" || intent.kind === "finalize") &&
    leaf === `delete-${intent.operationId}`
  ) {
    return deepFreeze({ kind: "profile_deletion", leaf });
  }
  invalid("wrapper leaf is incompatible with profile operation");
}

export function validateAtomicPublicationWrapperEntries(
  intentValue: AtomicPublishIntentV1,
  values: readonly string[],
): readonly AtomicPublicationWrapperLeafV1[] {
  if (!Array.isArray(values)) invalid("wrapper entries must be an array");
  if (values.length > 2) invalid("wrapper contains extra coexisting leaves");
  exactArray(values as string[], "wrapper entries");
  const seen = new Set<string>();
  const parsed = values.map((value) => {
    if (seen.has(value)) invalid("wrapper contains duplicate leaf");
    seen.add(value);
    return parseAtomicPublicationWrapperLeaf(intentValue, value);
  });
  return deepFreeze(parsed);
}

export function publicationTargetLocatorDigest(
  publicationTarget: PublicationTargetV1,
): Sha256 {
  return digest(
    canonicalBytes(target(publicationTarget), ATOMIC_PUBLISH_INTENT_MAX_BYTES),
  );
}

export function validateCleanupIdentityManifestBinding(
  intentValue: AtomicPublishIntentV1,
  manifestValue: CleanupIdentityManifestV1,
): CleanupIdentityManifestV1 {
  const intent = normalizeIntent(intentValue);
  const manifest = normalizeManifest(manifestValue);
  const bindingRecord = requireSet(
    intent.identityManifest,
    "identityManifest",
    intent.phase,
  );
  const encoded = encodeCleanupIdentityManifest(manifest);
  if (
    manifest.operationId !== intent.operationId ||
    !same(manifest.binding, intent.binding) ||
    manifest.targetLocatorDigest !==
      publicationTargetLocatorDigest(intent.target) ||
    encoded.sha256 !== bindingRecord.sha256 ||
    encoded.entryCount !== bindingRecord.entryCount ||
    encoded.bytes.byteLength !== bindingRecord.byteSize
  ) {
    invalid("cleanup manifest binding mismatch");
  }
  return manifest;
}

function immutableEqual(previous: unknown, next: unknown, label: string): void {
  if (!same(previous, next)) invalid(`${label} immutable field drift`);
}

function validateMonotonicRecord<T>(
  previous: T | null,
  next: T | null,
  label: string,
  validateExisting: (previousValue: T, nextValue: T) => void,
): void {
  if (previous === null) return;
  if (next === null) invalid(`${label} immutable field was cleared`);
  validateExisting(previous, next);
}

function phaseTransitionAllowed(
  previous: AtomicPublishIntentV1,
  next: AtomicPublishIntentV1,
): boolean {
  if (previous.phase === next.phase) {
    return (
      previous.phase === "source_deleting" || previous.phase === "discarding"
    );
  }
  switch (previous.phase) {
    case "allocated":
      return (
        next.phase === "building" || next.phase === "aborting_prepublication"
      );
    case "building":
      return next.phase === "ready" || next.phase === "aborting_prepublication";
    case "aborting_prepublication":
      return next.phase === "manifest_planned" || next.phase === "cleaned";
    case "ready":
      return next.phase === "classified";
    case "classified":
      if (previous.classification?.outcome === "published") {
        return next.phase === "renamed";
      }
      if (
        previous.classification?.outcome === "unpublished" ||
        previous.classification?.outcome === "conflict"
      ) {
        return next.phase === "manifest_planned";
      }
      return false;
    case "renamed":
      return next.phase === "manifest_planned";
    case "manifest_planned":
      return next.phase === "manifest_published";
    case "manifest_published":
      if (previous.prepublicationAbort !== null) {
        return next.phase === "discarding";
      }
      if (
        previous.classification?.outcome === "published" &&
        (previous.kind === "prepare" || previous.kind === "finalize")
      ) {
        return next.phase === "source_deleting";
      }
      if (
        previous.classification?.outcome === "published" &&
        previous.kind !== "canary"
      ) {
        return next.phase === "adopted" || next.phase === "discarding";
      }
      return next.phase === "discarding";
    case "source_deleting":
      return (
        previous.sourceDeletion?.phase === "removed" &&
        (next.phase === "adopted" || next.phase === "discarding")
      );
    case "adopted":
      return next.phase === "discarding";
    case "discarding":
      return (
        next.phase === "manifest_deleting" &&
        previous.cleanup?.phase === "discarding" &&
        previous.cleanup.suffix === "done" &&
        previous.cleanup.nextIndex === 0
      );
    case "manifest_deleting":
      return next.phase === "cleaned";
    case "cleaned":
      return false;
  }
}

export function validateAtomicPublishIntentTransition(
  previousValue: AtomicPublishIntentV1,
  nextValue: AtomicPublishIntentV1,
): AtomicPublishIntentV1 {
  const previous = normalizeIntent(previousValue);
  const next = normalizeIntent(nextValue);

  if (same(previous, next)) {
    invalid("lifecycle transition must make durable progress");
  }

  immutableEqual(previous.version, next.version, "version");
  immutableEqual(previous.operationId, next.operationId, "operationId");
  immutableEqual(previous.kind, next.kind, "kind");
  immutableEqual(previous.binding, next.binding, "binding");
  immutableEqual(previous.target, next.target, "target");
  immutableEqual(previous.publicSource, next.publicSource, "publicSource");

  if (!phaseTransitionAllowed(previous, next)) {
    invalid(`illegal lifecycle transition ${previous.phase} -> ${next.phase}`);
  }
  if (previous.phase === next.phase) {
    const progressUnits = [
      !same(previous.sourceDeletion, next.sourceDeletion),
      !same(previous.cleanup, next.cleanup),
      !same(previous.canaryProof, next.canaryProof),
    ].filter(Boolean).length;
    if (progressUnits !== 1) {
      invalid("same-phase transition must advance one durable progress unit");
    }
  }
  if (
    previous.sourceDeletion === null &&
    next.sourceDeletion !== null &&
    (next.sourceDeletion.phase !== "pending" ||
      next.sourceDeletion.nextIndex !== 0)
  ) {
    invalid("sourceDeletion must start at pending index zero");
  }
  if (previous.cleanup === null && next.cleanup !== null) {
    const startsAbort =
      next.phase === "aborting_prepublication" &&
      next.cleanup.phase === "aborting_prepublication" &&
      next.cleanup.outcome === "never_attempted" &&
      next.cleanup.suffix === "private_source_entries" &&
      next.cleanup.nextIndex === 0;
    const startsDiscard =
      next.phase === "discarding" &&
      next.cleanup.phase === "discarding" &&
      next.cleanup.suffix === "private_source_entries" &&
      next.cleanup.nextIndex === 0;
    if (!startsAbort && !startsDiscard) {
      invalid("cleanup must start at its exact initial cursor");
    }
  }
  if (
    previous.phase !== "discarding" &&
    next.phase === "discarding" &&
    (next.cleanup?.phase !== "discarding" ||
      next.cleanup.suffix !== "private_source_entries" ||
      next.cleanup.nextIndex !== 0)
  ) {
    invalid("discarding must enter at the first cleanup cursor");
  }
  if (
    previous.adoption === null &&
    next.adoption !== null &&
    next.phase !== "adopted"
  ) {
    invalid("adoption authority must first appear in adopted phase");
  }
  const emptyAbortJump =
    previous.phase === "aborting_prepublication" &&
    next.phase === "cleaned" &&
    previous.prepublicationAbort?.from === "allocated" &&
    previous.wrapper === null &&
    previous.privateSource === null &&
    next.identityManifest === null;

  validateMonotonicRecord(
    previous.wrapper,
    next.wrapper,
    "wrapper",
    (left, right) => immutableEqual(left, right, "wrapper"),
  );
  validateMonotonicRecord(
    previous.privateSource,
    next.privateSource,
    "privateSource",
    (left, right) => immutableEqual(left, right, "privateSource"),
  );
  validateMonotonicRecord(
    previous.classification,
    next.classification,
    "classification",
    (left, right) => immutableEqual(left, right, "classification"),
  );
  validateMonotonicRecord(
    previous.prepublicationAbort,
    next.prepublicationAbort,
    "prepublicationAbort",
    (left, right) => immutableEqual(left, right, "prepublicationAbort"),
  );
  validateMonotonicRecord(
    previous.adoption,
    next.adoption,
    "adoption",
    (left, right) => immutableEqual(left, right, "adoption"),
  );
  validateMonotonicRecord(
    previous.canaryProof,
    next.canaryProof,
    "canaryProof",
    (left, right) => {
      immutableEqual(left.attempt, right.attempt, "canaryProof.attempt");
      immutableEqual(
        left.sourceLeaf,
        right.sourceLeaf,
        "canaryProof.sourceLeaf",
      );
      immutableEqual(
        left.targetLeaf,
        right.targetLeaf,
        "canaryProof.targetLeaf",
      );
      immutableEqual(
        left.deletionLeaf,
        right.deletionLeaf,
        "canaryProof.deletionLeaf",
      );
      const leftOrder = CANARY_PROOF_ORDER.get(left.phase)!;
      const rightOrder = CANARY_PROOF_ORDER.get(right.phase)!;
      if (rightOrder < leftOrder || rightOrder > leftOrder + 1) {
        invalid("canaryProof phase skipped or moved backward");
      }
      if (left.phase !== "planned") {
        immutableEqual(left.dev, right.dev, "canaryProof.dev");
        immutableEqual(left.ino, right.ino, "canaryProof.ino");
        immutableEqual(left.mode, right.mode, "canaryProof.mode");
        immutableEqual(
          left.evidenceDigest,
          right.evidenceDigest,
          "canaryProof.evidenceDigest",
        );
      }
    },
  );
  validateMonotonicRecord(
    previous.identityManifest,
    next.identityManifest,
    "identityManifest",
    (left, right) => {
      immutableEqual(
        left.filename,
        right.filename,
        "identityManifest.filename",
      );
      immutableEqual(
        left.tempFilename,
        right.tempFilename,
        "identityManifest.tempFilename",
      );
      immutableEqual(left.sha256, right.sha256, "identityManifest.sha256");
      immutableEqual(
        left.entryCount,
        right.entryCount,
        "identityManifest.entryCount",
      );
      immutableEqual(
        left.byteSize,
        right.byteSize,
        "identityManifest.byteSize",
      );
      const leftOrder = IDENTITY_MANIFEST_ORDER.get(left.phase)!;
      const rightOrder = IDENTITY_MANIFEST_ORDER.get(right.phase)!;
      if (rightOrder < leftOrder) {
        invalid("identityManifest phase moved backward");
      }
      if (left.phase !== "planned") {
        immutableEqual(left.dev, right.dev, "identityManifest.dev");
        immutableEqual(left.ino, right.ino, "identityManifest.ino");
        immutableEqual(left.mode, right.mode, "identityManifest.mode");
      }
    },
  );
  validateMonotonicRecord(
    previous.sourceDeletion,
    next.sourceDeletion,
    "sourceDeletion",
    (left, right) => {
      immutableEqual(
        left.privateDeletionLeaf,
        right.privateDeletionLeaf,
        "sourceDeletion.privateDeletionLeaf",
      );
      immutableEqual(
        left.evidenceDigest,
        right.evidenceDigest,
        "sourceDeletion.evidenceDigest",
      );
      immutableEqual(
        left.entryCount,
        right.entryCount,
        "sourceDeletion.entryCount",
      );
      const leftOrder = SOURCE_DELETION_ORDER.get(left.phase)!;
      const rightOrder = SOURCE_DELETION_ORDER.get(right.phase)!;
      if (rightOrder < leftOrder || rightOrder > leftOrder + 1) {
        invalid("sourceDeletion phase or cursor skipped or moved backward");
      }
      if (
        rightOrder === leftOrder &&
        left.phase === "removing" &&
        (right.nextIndex < left.nextIndex ||
          right.nextIndex > left.nextIndex + 1)
      ) {
        invalid("sourceDeletion removing cursor skipped or moved backward");
      }
      if (
        left.phase === "removing" &&
        right.phase === "removed" &&
        left.nextIndex !== left.entryCount
      ) {
        invalid("sourceDeletion cannot finish before its entry cursor");
      }
    },
  );
  validateMonotonicRecord(
    previous.cleanup,
    next.cleanup,
    "cleanup",
    (left, right) => {
      immutableEqual(left.outcome, right.outcome, "cleanup.outcome");
      immutableEqual(
        left.evidenceDigest,
        right.evidenceDigest,
        "cleanup.evidenceDigest",
      );
      if (emptyAbortJump) {
        if (
          left.phase !== "aborting_prepublication" ||
          left.suffix !== "private_source_entries" ||
          left.nextIndex !== 0 ||
          right.phase !== "cleaned" ||
          right.suffix !== "done" ||
          right.nextIndex !== 0
        ) {
          invalid("empty abort cleanup jump is invalid");
        }
        return;
      }
      const leftOrder = CLEANUP_SUFFIX_ORDER.get(left.suffix)!;
      const rightOrder = CLEANUP_SUFFIX_ORDER.get(right.suffix)!;
      const cursorSuffix =
        left.suffix === "private_source_entries" ||
        left.suffix === "wrapper_temps" ||
        left.suffix === "intent_temps";
      if (
        rightOrder < leftOrder ||
        rightOrder > leftOrder + 1 ||
        (rightOrder === leftOrder &&
          cursorSuffix &&
          (right.nextIndex < left.nextIndex ||
            right.nextIndex > left.nextIndex + 1)) ||
        (rightOrder === leftOrder + 1 && right.nextIndex !== 0)
      ) {
        invalid("cleanup suffix or cursor skipped or moved backward");
      }
      if (
        rightOrder === leftOrder + 1 &&
        cursorSuffix &&
        left.nextIndex !== previous.identityManifest?.entryCount
      ) {
        invalid("cleanup cannot leave an incomplete entry cursor");
      }
    },
  );
  return next;
}
