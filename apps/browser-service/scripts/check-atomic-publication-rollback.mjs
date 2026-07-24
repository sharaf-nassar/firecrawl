import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  resolve,
} from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const EXIT_SAFE = 0;
export const EXIT_UNRESOLVED = 20;
export const EXIT_INVALID = 30;
export const CURRENT_STATE_ROOT =
  "/var/lib/firecrawl-browser-volume/state";

const AUTHORIZED_UID = 1000n;
const AUTHORIZED_GID = 1000n;
const INTENT_MAX_BYTES = 16 * 1024;
const MANIFEST_MAX_BYTES = 33_554_432;
const MANIFEST_MAX_ENTRIES = 25_000;
const PROFILE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const PROFILE_PAYLOAD_MAX_BYTES = 268_435_456;
const DEFAULT_IO = Object.freeze({
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
});

const SAFE = Object.freeze({
  exitCode: EXIT_SAFE,
  category: "rollback_safe",
});
const UNRESOLVED = Object.freeze({
  exitCode: EXIT_UNRESOLVED,
  category: "rollback_state_unresolved",
});
const INVALID_LAYOUT = Object.freeze({
  exitCode: EXIT_INVALID,
  category: "rollback_layout_invalid",
});
const INVALID_INVOCATION = Object.freeze({
  exitCode: EXIT_INVALID,
  category: "rollback_invocation_invalid",
});

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`, "u");
const INTENT_STABLE_PATTERN = new RegExp(`^(${UUID})\\.json$`, "u");
const IDENTITY_STABLE_PATTERN = new RegExp(
  `^(${UUID})\\.identities\\.json$`,
  "u",
);
const INTENT_TEMP_PATTERN = new RegExp(
  `^(${UUID})\\.(allocated|building|aborting_prepublication|ready|classified|renamed|manifest_planned|manifest_published|source_deleting|adopted|discarding|manifest_deleting|cleaned)\\.(${UUID})\\.tmp$`,
  "u",
);
const IDENTITY_TEMP_PATTERN = new RegExp(
  `^(${UUID})\\.identities\\.(${UUID})\\.tmp$`,
  "u",
);
const INTENT_KINDS = new Set([
  "canary",
  "scaffold",
  "working",
  "prepare",
  "finalize",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const NATIVE_CODES = new Set([
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
const MANIFEST_SCOPES = new Set([
  "private_profile_payload",
  "private_canary_proof",
  "public_source",
  "private_profile_deletion",
  "private_canary_deletion",
  "wrapper_temp",
  "intent_temp",
]);
const INTENT_PHASES = new Set([
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

function procPath(fd, leaf = "") {
  return leaf === "" ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${leaf}`;
}

function lowMode(stat) {
  return Number(stat.mode & 0o7777n);
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isDirectory() === right.isDirectory() &&
    left.isFile() === right.isFile()
  );
}

function sameSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function validateReservedDirectoryMetadata(stat, device) {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.nlink > 0n &&
    stat.uid === AUTHORIZED_UID &&
    stat.gid === AUTHORIZED_GID &&
    lowMode(stat) === 0o700 &&
    (device === null || stat.dev === device)
  );
}

function validFile(stat, device) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    stat.uid === AUTHORIZED_UID &&
    stat.gid === AUTHORIZED_GID &&
    lowMode(stat) === 0o600 &&
    stat.dev === device
  );
}

function holdDirectory(context, parentFd, leaf, device) {
  const before = context.io.lstatSync(procPath(parentFd, leaf), {
    bigint: true,
  });
  if (!validateReservedDirectoryMetadata(before, device)) throw new Error();
  const fd = context.io.openSync(
    procPath(parentFd, leaf),
    DIRECTORY_FLAGS,
  );
  context.openFds.push(fd);
  const held = context.io.fstatSync(fd, { bigint: true });
  const rebound = context.io.lstatSync(procPath(parentFd, leaf), {
    bigint: true,
  });
  if (
    !validateReservedDirectoryMetadata(held, device) ||
    !sameIdentity(before, held) ||
    !sameIdentity(held, rebound)
  ) {
    throw new Error();
  }
  const record = { fd, stat: held, parentFd, leaf };
  context.directories.push(record);
  return record;
}

function holdFile(context, parentFd, leaf, device) {
  const before = context.io.lstatSync(procPath(parentFd, leaf), {
    bigint: true,
  });
  if (!validFile(before, device)) throw new Error();
  const fd = context.io.openSync(procPath(parentFd, leaf), FILE_FLAGS);
  context.openFds.push(fd);
  const held = context.io.fstatSync(fd, { bigint: true });
  const rebound = context.io.lstatSync(procPath(parentFd, leaf), {
    bigint: true,
  });
  if (
    !validFile(held, device) ||
    !sameIdentity(before, held) ||
    !sameIdentity(held, rebound)
  ) {
    throw new Error();
  }
  return { fd, stat: held, parentFd, leaf };
}

function stableDirectoryEntries(io, fd) {
  const before = io.fstatSync(fd, { bigint: true });
  const names = io
    .readdirSync(procPath(fd), { encoding: "utf8" })
    .sort();
  const after = io.fstatSync(fd, { bigint: true });
  if (!sameSnapshot(before, after)) throw new Error();
  return names;
}

function parseIntentLeaf(leaf) {
  let match = IDENTITY_STABLE_PATTERN.exec(leaf);
  if (match !== null) {
    return { type: "identity_stable", operationId: match[1] };
  }
  match = IDENTITY_TEMP_PATTERN.exec(leaf);
  if (match !== null) {
    return { type: "identity_temp", operationId: match[1] };
  }
  match = INTENT_TEMP_PATTERN.exec(leaf);
  if (match !== null) {
    return {
      type: "intent_temp",
      operationId: match[1],
      phase: match[2],
    };
  }
  match = INTENT_STABLE_PATTERN.exec(leaf);
  if (match !== null) {
    return { type: "intent_stable", operationId: match[1] };
  }
  throw new Error();
}

function failGrammar() {
  throw new Error();
}

function exactRecord(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    failGrammar();
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    failGrammar();
  }
  return value;
}

function oneOf(value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) failGrammar();
  return value;
}

function integer(value, minimum, maximum) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    failGrammar();
  }
  return value;
}

function canonicalUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    failGrammar();
  }
  return value;
}

function sha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    failGrammar();
  }
  return value;
}

function decimal(value) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    failGrammar();
  }
  return value;
}

function nonce(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    failGrammar();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== 32 ||
    decoded.toString("base64url") !== value
  ) {
    failGrammar();
  }
  return value;
}

function validateBinding(value) {
  const record = exactRecord(value, [
    "processNonce",
    "controlGenerationNonce",
    "snapshotDigest",
  ]);
  nonce(record.processNonce);
  nonce(record.controlGenerationNonce);
  sha256(record.snapshotDigest);
  return record;
}

function validateHeldParent(value) {
  const record = exactRecord(value, ["dev", "ino", "mode"]);
  decimal(record.dev);
  decimal(record.ino);
  if (record.mode !== 448) failGrammar();
  return record;
}

function validateTarget(value) {
  if (value?.kind === "profile") {
    const record = exactRecord(value, [
      "kind",
      "profileId",
      "leaf",
      "parent",
    ]);
    canonicalUuid(record.profileId);
    canonicalUuid(record.leaf);
    validateHeldParent(record.parent);
    return record;
  }
  if (value?.kind === "profile_state") {
    const record = exactRecord(value, [
      "kind",
      "profileId",
      "state",
      "generationId",
      "leaf",
      "parent",
    ]);
    canonicalUuid(record.profileId);
    oneOf(record.state, new Set(["working", "staging", "committed"]));
    canonicalUuid(record.generationId);
    canonicalUuid(record.leaf);
    validateHeldParent(record.parent);
    return record;
  }
  if (value?.kind === "canary_parent") {
    const record = exactRecord(value, [
      "kind",
      "parentLocator",
      "parent",
    ]);
    if (record.parentLocator?.kind === "profiles") {
      exactRecord(record.parentLocator, ["kind"]);
    } else if (record.parentLocator?.kind === "profile_state") {
      const locator = exactRecord(record.parentLocator, [
        "kind",
        "profileId",
        "state",
      ]);
      canonicalUuid(locator.profileId);
      oneOf(locator.state, new Set(["working", "staging", "committed"]));
    } else {
      failGrammar();
    }
    validateHeldParent(record.parent);
    return record;
  }
  failGrammar();
}

function validateWrapper(value) {
  if (value !== null) validateHeldParent(value);
  return value;
}

function validatePrivateSource(value) {
  if (value === null) return value;
  const record = exactRecord(value, [
    "dev",
    "ino",
    "mode",
    "checksum",
    "byteSize",
  ]);
  decimal(record.dev);
  decimal(record.ino);
  if (record.mode !== 448) failGrammar();
  sha256(record.checksum);
  integer(record.byteSize, 0, PROFILE_PAYLOAD_MAX_BYTES);
  return record;
}

function validatePublicSource(value) {
  if (value === null) return value;
  const record = exactRecord(value, [
    "profileId",
    "state",
    "generationId",
    "dev",
    "ino",
    "mode",
    "checksum",
    "byteSize",
    "capabilityDigest",
  ]);
  canonicalUuid(record.profileId);
  oneOf(record.state, new Set(["working", "staging"]));
  canonicalUuid(record.generationId);
  decimal(record.dev);
  decimal(record.ino);
  if (record.mode !== 448) failGrammar();
  sha256(record.checksum);
  integer(record.byteSize, 0, PROFILE_PAYLOAD_MAX_BYTES);
  sha256(record.capabilityDigest);
  return record;
}

function validateClassificationRecord(value) {
  if (value === null) return value;
  const record = exactRecord(value, [
    "outcome",
    "nativeCode",
    "sourceMatches",
    "targetMatches",
    "targetOther",
    "evidenceDigest",
  ]);
  oneOf(
    record.outcome,
    new Set(["unpublished", "conflict", "published", "ambiguous"]),
  );
  oneOf(record.nativeCode, NATIVE_CODES);
  if (
    typeof record.sourceMatches !== "boolean" ||
    typeof record.targetMatches !== "boolean" ||
    typeof record.targetOther !== "boolean"
  ) {
    failGrammar();
  }
  sha256(record.evidenceDigest);
  return record;
}

function validateSourceDeletion(value, operationId) {
  if (value === null) return value;
  const record = exactRecord(value, [
    "phase",
    "privateDeletionLeaf",
    "evidenceDigest",
    "entryCount",
    "nextIndex",
  ]);
  oneOf(
    record.phase,
    new Set(["pending", "moved_private", "removing", "removed"]),
  );
  if (record.privateDeletionLeaf !== `delete-${operationId}`) {
    failGrammar();
  }
  sha256(record.evidenceDigest);
  integer(record.entryCount, 0, MANIFEST_MAX_ENTRIES);
  integer(record.nextIndex, 0, MANIFEST_MAX_ENTRIES);
  return record;
}

function validateAdoptionRecord(value) {
  if (value === null) return value;
  const record = exactRecord(value, ["authority", "authorityDigest"]);
  oneOf(
    record.authority,
    new Set([
      "scaffold",
      "registry",
      "prepare_token",
      "reconciliation_snapshot",
    ]),
  );
  sha256(record.authorityDigest);
  return record;
}

function validateCleanupRecord(value) {
  if (value === null) return value;
  const record = exactRecord(value, [
    "phase",
    "outcome",
    "evidenceDigest",
    "suffix",
    "nextIndex",
  ]);
  oneOf(
    record.phase,
    new Set(["aborting_prepublication", "discarding", "cleaned"]),
  );
  oneOf(
    record.outcome,
    new Set([
      "never_attempted",
      "unpublished",
      "conflict",
      "released_to_reconciliation",
      "adopted",
      "canary_complete",
    ]),
  );
  sha256(record.evidenceDigest);
  oneOf(
    record.suffix,
    new Set([
      "private_source_entries",
      "private_source_root",
      "wrapper_temps",
      "wrapper_root",
      "intent_temps",
      "done",
    ]),
  );
  integer(record.nextIndex, 0, MANIFEST_MAX_ENTRIES);
  return record;
}

function validateCanaryProofRecord(value, operationId) {
  if (value === null) return value;
  const record = exactRecord(value, [
    "attempt",
    "sourceLeaf",
    "targetLeaf",
    "deletionLeaf",
    "phase",
    "dev",
    "ino",
    "mode",
    "evidenceDigest",
  ]);
  integer(record.attempt, 0, 0);
  if (
    record.sourceLeaf !== `proof-${operationId}-0` ||
    record.targetLeaf !== `canary-${operationId}-0` ||
    record.deletionLeaf !== `deletion-${operationId}-0`
  ) {
    failGrammar();
  }
  oneOf(
    record.phase,
    new Set(["planned", "published", "deleting", "cleaned"]),
  );
  if (record.phase === "planned") {
    if (
      record.dev !== null ||
      record.ino !== null ||
      record.mode !== null ||
      record.evidenceDigest !== null
    ) {
      failGrammar();
    }
  } else {
    decimal(record.dev);
    decimal(record.ino);
    if (record.mode !== 448) failGrammar();
    sha256(record.evidenceDigest);
  }
  return record;
}

function validatePrepublicationAbort(value) {
  if (value === null) return value;
  const record = exactRecord(value, ["outcome", "from", "evidenceDigest"]);
  if (record.outcome !== "never_attempted") failGrammar();
  oneOf(record.from, new Set(["allocated", "building"]));
  sha256(record.evidenceDigest);
  return record;
}

function validateIdentityManifestRecord(value, operationId) {
  if (value === null) return value;
  const record = exactRecord(value, [
    "phase",
    "filename",
    "tempFilename",
    "sha256",
    "entryCount",
    "byteSize",
    "dev",
    "ino",
    "mode",
  ]);
  if (record.filename !== `${operationId}.identities.json`) {
    failGrammar();
  }
  const prefix = `${operationId}.identities.`;
  if (
    typeof record.tempFilename !== "string" ||
    !record.tempFilename.startsWith(prefix) ||
    !record.tempFilename.endsWith(".tmp")
  ) {
    failGrammar();
  }
  canonicalUuid(
    record.tempFilename.slice(prefix.length, -".tmp".length),
  );
  oneOf(record.phase, new Set(["planned", "published", "deleting"]));
  sha256(record.sha256);
  integer(record.entryCount, 0, MANIFEST_MAX_ENTRIES);
  integer(record.byteSize, 1, MANIFEST_MAX_BYTES);
  if (record.phase === "planned") {
    if (
      record.dev !== null ||
      record.ino !== null ||
      record.mode !== null
    ) {
      failGrammar();
    }
  } else {
    decimal(record.dev);
    decimal(record.ino);
    if (record.mode !== 384) failGrammar();
  }
  return record;
}

function required(value) {
  if (value === null) failGrammar();
  return value;
}

function absent(value) {
  if (value !== null) failGrammar();
}

function validateClassification(intent) {
  const value = intent.classification;
  if (value === null) return;
  const flags = [
    value.sourceMatches,
    value.targetMatches,
    value.targetOther,
  ];
  const same = expected =>
    flags.every((flag, index) => flag === expected[index]);
  if (
    (value.outcome === "unpublished" && !same([true, false, false])) ||
    (value.outcome === "conflict" && !same([true, false, true])) ||
    (value.outcome === "published" && !same([false, true, false])) ||
    (value.outcome === "ambiguous" &&
      (same([true, false, false]) ||
        same([true, false, true]) ||
        same([false, true, false])))
  ) {
    failGrammar();
  }
  if (value.nativeCode === "success" && value.outcome !== "published") {
    failGrammar();
  }
  if (
    value.nativeCode === "atomic_publish_replay_completed" &&
    (intent.kind !== "canary" || value.outcome !== "published")
  ) {
    failGrammar();
  }
  if (
    (value.nativeCode === "atomic_publish_exists") !==
    (value.outcome === "conflict")
  ) {
    failGrammar();
  }
}

function validateKindAndTarget(intent) {
  const target = intent.target;
  if (intent.kind === "canary") {
    if (target.kind !== "canary_parent") failGrammar();
  } else if (intent.kind === "scaffold") {
    if (
      target.kind !== "profile" ||
      target.leaf !== target.profileId
    ) {
      failGrammar();
    }
  } else {
    const expectedState =
      intent.kind === "working"
        ? "working"
        : intent.kind === "prepare"
          ? "staging"
          : "committed";
    if (
      target.kind !== "profile_state" ||
      target.state !== expectedState ||
      target.leaf !== target.generationId
    ) {
      failGrammar();
    }
  }
  if (intent.kind === "prepare" || intent.kind === "finalize") {
    const source = required(intent.publicSource);
    if (
      target.kind !== "profile_state" ||
      source.profileId !== target.profileId ||
      source.state !==
        (intent.kind === "prepare" ? "working" : "staging") ||
      source.generationId !== target.generationId
    ) {
      failGrammar();
    }
    if (
      intent.privateSource !== null &&
      (intent.privateSource.checksum !== source.checksum ||
        intent.privateSource.byteSize !== source.byteSize)
    ) {
      failGrammar();
    }
  } else {
    absent(intent.publicSource);
  }
  if (intent.kind === "canary") required(intent.canaryProof);
  else absent(intent.canaryProof);
}

function validateAdoption(intent) {
  const value = intent.adoption;
  if (value === null) return;
  if (intent.classification?.outcome !== "published") failGrammar();
  const allowed =
    (intent.kind === "scaffold" && value.authority === "scaffold") ||
    (intent.kind === "working" && value.authority === "registry") ||
    (intent.kind === "prepare" &&
      (value.authority === "prepare_token" ||
        value.authority === "reconciliation_snapshot")) ||
    (intent.kind === "finalize" &&
      value.authority === "reconciliation_snapshot");
  if (!allowed) failGrammar();
}

function validateCanaryProof(intent) {
  const proof = intent.canaryProof;
  if (proof === null) return;
  if (intent.classification === null) {
    if (proof.phase !== "planned") failGrammar();
    return;
  }
  if (intent.classification.outcome !== "published") {
    if (proof.phase !== "planned") failGrammar();
    return;
  }
  if (proof.phase === "planned") failGrammar();
  if (
    (proof.phase === "deleting" || proof.phase === "cleaned") &&
    !["discarding", "manifest_deleting", "cleaned"].includes(
      intent.phase,
    )
  ) {
    failGrammar();
  }
  if (
    (intent.phase === "manifest_deleting" ||
      intent.phase === "cleaned") &&
    proof.phase !== "cleaned"
  ) {
    failGrammar();
  }
}

function expectedCleanupOutcomes(intent) {
  if (intent.prepublicationAbort !== null) return ["never_attempted"];
  if (intent.classification?.outcome === "unpublished") {
    return ["unpublished"];
  }
  if (intent.classification?.outcome === "conflict") return ["conflict"];
  if (intent.classification?.outcome !== "published") return null;
  if (intent.kind === "canary") return ["canary_complete"];
  return intent.adoption === null
    ? ["released_to_reconciliation"]
    : ["adopted", "released_to_reconciliation"];
}

function initialAbortCleanup(value) {
  required(value);
  if (
    value.phase !== "aborting_prepublication" ||
    value.outcome !== "never_attempted" ||
    value.suffix !== "private_source_entries" ||
    value.nextIndex !== 0
  ) {
    failGrammar();
  }
}

function validateIntentMatrix(intent) {
  validateKindAndTarget(intent);
  validateAdoption(intent);
  validateCanaryProof(intent);
  validateClassification(intent);
  const phase = intent.phase;
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
    failGrammar();
  }
  if (isAbort) {
    if (
      intent.classification !== null ||
      intent.sourceDeletion !== null ||
      intent.adoption !== null
    ) {
      failGrammar();
    }
    if (
      (intent.prepublicationAbort.from === "allocated" &&
        (intent.wrapper !== null || intent.privateSource !== null)) ||
      (intent.prepublicationAbort.from === "building" &&
        (intent.wrapper === null || intent.privateSource !== null))
    ) {
      failGrammar();
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
    required(intent.wrapper);
    required(intent.privateSource);
  }
  if (intent.sourceDeletion !== null) {
    if (
      !["prepare", "finalize"].includes(intent.kind) ||
      intent.classification?.outcome !== "published" ||
      intent.identityManifest === null ||
      intent.identityManifest.phase === "planned"
    ) {
      failGrammar();
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
    failGrammar();
  }
  if (
    intent.sourceDeletion !== null &&
    intent.sourceDeletion.phase !== "removing" &&
    intent.sourceDeletion.nextIndex !== 0
  ) {
    failGrammar();
  }
  if (
    intent.cleanup !== null &&
    ![
      "private_source_entries",
      "wrapper_temps",
      "intent_temps",
    ].includes(intent.cleanup.suffix) &&
    intent.cleanup.nextIndex !== 0
  ) {
    failGrammar();
  }
  if (["discarding", "manifest_deleting", "cleaned"].includes(phase)) {
    const needsRemoved =
      ["prepare", "finalize"].includes(intent.kind) &&
      !isAbort &&
      intent.classification?.outcome === "published";
    if (
      (needsRemoved && intent.sourceDeletion?.phase !== "removed") ||
      (!needsRemoved && intent.sourceDeletion !== null)
    ) {
      failGrammar();
    }
  }

  if (phase === "allocated") {
    [
      intent.wrapper,
      intent.privateSource,
      intent.classification,
      intent.sourceDeletion,
      intent.adoption,
      intent.cleanup,
      intent.prepublicationAbort,
      intent.identityManifest,
    ].forEach(absent);
  } else if (phase === "building") {
    required(intent.wrapper);
    [
      intent.privateSource,
      intent.classification,
      intent.sourceDeletion,
      intent.adoption,
      intent.cleanup,
      intent.prepublicationAbort,
      intent.identityManifest,
    ].forEach(absent);
  } else if (phase === "aborting_prepublication") {
    required(intent.prepublicationAbort);
    [
      intent.classification,
      intent.sourceDeletion,
      intent.adoption,
      intent.identityManifest,
    ].forEach(absent);
    initialAbortCleanup(intent.cleanup);
  } else if (phase === "ready") {
    required(intent.wrapper);
    required(intent.privateSource);
    [
      intent.classification,
      intent.sourceDeletion,
      intent.adoption,
      intent.cleanup,
      intent.prepublicationAbort,
      intent.identityManifest,
    ].forEach(absent);
  } else if (phase === "classified") {
    required(intent.wrapper);
    required(intent.privateSource);
    required(intent.classification);
    [
      intent.sourceDeletion,
      intent.adoption,
      intent.cleanup,
      intent.prepublicationAbort,
      intent.identityManifest,
    ].forEach(absent);
  } else if (phase === "renamed") {
    if (intent.classification?.outcome !== "published") failGrammar();
    [
      intent.sourceDeletion,
      intent.adoption,
      intent.cleanup,
      intent.prepublicationAbort,
      intent.identityManifest,
    ].forEach(absent);
  } else if (phase === "manifest_planned") {
    if (
      required(intent.identityManifest).phase !== "planned" ||
      (!isAbort && !classifiedNonAmbiguous)
    ) {
      failGrammar();
    }
    absent(intent.sourceDeletion);
    absent(intent.adoption);
    if (isAbort) initialAbortCleanup(intent.cleanup);
    else absent(intent.cleanup);
  } else if (phase === "manifest_published") {
    if (
      required(intent.identityManifest).phase !== "published" ||
      (!isAbort && !classifiedNonAmbiguous)
    ) {
      failGrammar();
    }
    absent(intent.sourceDeletion);
    absent(intent.adoption);
    if (isAbort) initialAbortCleanup(intent.cleanup);
    else absent(intent.cleanup);
  } else if (phase === "source_deleting") {
    if (
      !["prepare", "finalize"].includes(intent.kind) ||
      intent.classification?.outcome !== "published" ||
      intent.identityManifest?.phase !== "published"
    ) {
      failGrammar();
    }
    required(intent.sourceDeletion);
    absent(intent.adoption);
    absent(intent.cleanup);
    absent(intent.prepublicationAbort);
  } else if (phase === "adopted") {
    if (
      intent.kind === "canary" ||
      intent.classification?.outcome !== "published" ||
      intent.identityManifest?.phase !== "published"
    ) {
      failGrammar();
    }
    required(intent.adoption);
    absent(intent.cleanup);
    absent(intent.prepublicationAbort);
    if (
      ["prepare", "finalize"].includes(intent.kind) &&
      intent.sourceDeletion?.phase !== "removed"
    ) {
      failGrammar();
    }
    if (
      !["prepare", "finalize"].includes(intent.kind) &&
      intent.sourceDeletion !== null
    ) {
      failGrammar();
    }
  } else if (phase === "discarding") {
    const cleanup = required(intent.cleanup);
    const expected = expectedCleanupOutcomes(intent);
    if (
      cleanup.phase !== "discarding" ||
      (!isAbort && !classifiedNonAmbiguous) ||
      intent.identityManifest?.phase !== "published" ||
      expected === null ||
      !expected.includes(cleanup.outcome) ||
      (intent.sourceDeletion !== null &&
        intent.sourceDeletion.phase !== "removed")
    ) {
      failGrammar();
    }
  } else if (phase === "manifest_deleting") {
    const cleanup = required(intent.cleanup);
    const expected = expectedCleanupOutcomes(intent);
    if (
      cleanup.phase !== "cleaned" ||
      cleanup.suffix !== "done" ||
      intent.identityManifest?.phase !== "deleting" ||
      expected === null ||
      !expected.includes(cleanup.outcome) ||
      (intent.sourceDeletion !== null &&
        intent.sourceDeletion.phase !== "removed")
    ) {
      failGrammar();
    }
  } else if (phase === "cleaned") {
    const cleanup = required(intent.cleanup);
    const emptyAbort =
      isAbort &&
      intent.identityManifest === null &&
      intent.wrapper === null &&
      intent.privateSource === null;
    const expected = expectedCleanupOutcomes(intent);
    if (
      cleanup.phase !== "cleaned" ||
      cleanup.suffix !== "done" ||
      (!emptyAbort && intent.identityManifest?.phase !== "deleting") ||
      expected === null ||
      !expected.includes(cleanup.outcome) ||
      (intent.sourceDeletion !== null &&
        intent.sourceDeletion.phase !== "removed")
    ) {
      failGrammar();
    }
  }
}

function validateIntent(value) {
  const intent = exactRecord(value, [
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
  ]);
  if (intent.version !== 1) failGrammar();
  const operationId = canonicalUuid(intent.operationId);
  oneOf(intent.kind, INTENT_KINDS);
  oneOf(intent.phase, INTENT_PHASES);
  validateBinding(intent.binding);
  validateTarget(intent.target);
  validateWrapper(intent.wrapper);
  validatePrivateSource(intent.privateSource);
  validatePublicSource(intent.publicSource);
  validateClassificationRecord(intent.classification);
  validateSourceDeletion(intent.sourceDeletion, operationId);
  validateAdoptionRecord(intent.adoption);
  validateCleanupRecord(intent.cleanup);
  validateCanaryProofRecord(intent.canaryProof, operationId);
  validatePrepublicationAbort(intent.prepublicationAbort);
  validateIdentityManifestRecord(intent.identityManifest, operationId);
  validateIntentMatrix(intent);
  return intent;
}

function wellFormedNfc(value) {
  if (typeof value !== "string" || value.normalize("NFC") !== value) {
    failGrammar();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) failGrammar();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failGrammar();
    }
  }
  return value;
}

function validateManifestPath(value) {
  const path = wellFormedNfc(value);
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Buffer.byteLength(path, "utf8") > 1024
  ) {
    failGrammar();
  }
  const segments = path.split("/");
  if (
    segments.length > 64 ||
    segments.some(
      segment =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 255 ||
        /[\\/\u0000-\u001f\u007f]/u.test(segment) ||
        segment.normalize("NFC") !== segment,
    )
  ) {
    failGrammar();
  }
  return path;
}

function validateManifestEntry(value, expectedIndex) {
  const entry = exactRecord(value, [
    "index",
    "scope",
    "path",
    "type",
    "dev",
    "ino",
    "mode",
    "size",
    "contentSha256",
  ]);
  if (
    integer(entry.index, 0, MANIFEST_MAX_ENTRIES - 1) !==
    expectedIndex
  ) {
    failGrammar();
  }
  oneOf(entry.scope, MANIFEST_SCOPES);
  validateManifestPath(entry.path);
  oneOf(entry.type, new Set(["file", "directory"]));
  decimal(entry.dev);
  decimal(entry.ino);
  integer(entry.mode, 0, 0o777);
  integer(
    entry.size,
    0,
    entry.type === "file" ? PROFILE_FILE_MAX_BYTES : 0,
  );
  if (entry.contentSha256 === null) {
    if (entry.type === "file") failGrammar();
  } else {
    sha256(entry.contentSha256);
    if (entry.type === "directory") failGrammar();
  }
  return entry;
}

function validateManifestSequence(entries) {
  const byPath = new Map();
  let previousDepth = Number.POSITIVE_INFINITY;
  let previousAtDepth = null;
  for (const entry of entries) {
    if (byPath.has(entry.path)) failGrammar();
    const depth = entry.path.split("/").length;
    const raw = Buffer.from(entry.path, "utf8");
    if (
      depth > previousDepth ||
      (depth === previousDepth &&
        previousAtDepth !== null &&
        Buffer.compare(previousAtDepth, raw) >= 0)
    ) {
      failGrammar();
    }
    if (depth !== previousDepth) previousAtDepth = null;
    previousDepth = depth;
    previousAtDepth = raw;
    byPath.set(entry.path, entry);
  }
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      if (
        byPath.get(segments.slice(0, length).join("/"))?.type ===
        "file"
      ) {
        failGrammar();
      }
    }
  }
}

function validateManifest(value) {
  const manifest = exactRecord(value, [
    "version",
    "operationId",
    "binding",
    "targetLocatorDigest",
    "entries",
  ]);
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > MANIFEST_MAX_ENTRIES
  ) {
    failGrammar();
  }
  canonicalUuid(manifest.operationId);
  validateBinding(manifest.binding);
  sha256(manifest.targetLocatorDigest);
  const entries = manifest.entries.map(validateManifestEntry);
  validateManifestSequence(entries);
  return manifest;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateManifestBinding(intent, manifestRecord) {
  const authority = required(intent.identityManifest);
  const manifest = manifestRecord.value;
  const expectedLeaf =
    manifestRecord.type === "identity_stable"
      ? authority.filename
      : authority.tempFilename;
  const targetBytes = Buffer.from(
    `${JSON.stringify(intent.target)}\n`,
    "utf8",
  );
  if (
    manifestRecord.leaf !== expectedLeaf ||
    manifest.operationId !== intent.operationId ||
    JSON.stringify(manifest.binding) !==
      JSON.stringify(intent.binding) ||
    manifest.targetLocatorDigest !== digest(targetBytes) ||
    digest(manifestRecord.bytes) !== authority.sha256 ||
    manifest.entries.length !== authority.entryCount ||
    manifestRecord.bytes.byteLength !== authority.byteSize
  ) {
    failGrammar();
  }
}

function decodeDurableRecord(bytes, maximumBytes, validator) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    failGrammar();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failGrammar();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    failGrammar();
  }
  const value = validator(parsed);
  const canonical = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (!canonical.equals(bytes)) failGrammar();
  return value;
}

function readRecord(context, file, maximumBytes, validator) {
  if (
    file.stat.size < 0n ||
    file.stat.size > BigInt(maximumBytes)
  ) {
    throw new Error();
  }
  const bytes = context.io.readFileSync(file.fd);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength !== Number(file.stat.size)
  ) {
    throw new Error();
  }
  const value = decodeDurableRecord(bytes, maximumBytes, validator);
  const held = context.io.fstatSync(file.fd, { bigint: true });
  const rebound = context.io.lstatSync(
    procPath(file.parentFd, file.leaf),
    { bigint: true },
  );
  if (
    !validFile(held, file.stat.dev) ||
    !sameSnapshot(file.stat, held) ||
    !sameIdentity(held, rebound)
  ) {
    throw new Error();
  }
  return { value, bytes };
}

function operationRecord(operations, operationId) {
  let record = operations.get(operationId);
  if (record === undefined) {
    record = {
      stableKind: null,
      observedKind: null,
      stableIntent: null,
      manifests: [],
    };
    operations.set(operationId, record);
  }
  return record;
}

function inspectIntents(context, intents, device) {
  const names = stableDirectoryEntries(context.io, intents.fd);
  const operations = new Map();
  for (const leaf of names) {
    const parsed = parseIntentLeaf(leaf);
    const file = holdFile(context, intents.fd, leaf, device);
    const identity = parsed.type.startsWith("identity_");
    const decoded = readRecord(
      context,
      file,
      identity ? MANIFEST_MAX_BYTES : INTENT_MAX_BYTES,
      identity ? validateManifest : validateIntent,
    );
    const value = decoded.value;
    if (
      value.version !== 1 ||
      value.operationId !== parsed.operationId
    ) {
      throw new Error();
    }
    const record = operationRecord(operations, parsed.operationId);
    if (identity) {
      record.manifests.push({
        leaf,
        type: parsed.type,
        value,
        bytes: decoded.bytes,
      });
      continue;
    }
    if (
      !INTENT_KINDS.has(value.kind) ||
      !INTENT_PHASES.has(value.phase) ||
      (parsed.type === "intent_temp" &&
        value.phase !== parsed.phase) ||
      (record.observedKind !== null &&
        record.observedKind !== value.kind)
    ) {
      throw new Error();
    }
    record.observedKind = value.kind;
    if (parsed.type === "intent_stable") {
      if (record.stableKind !== null) throw new Error();
      record.stableKind = value.kind;
      record.stableIntent = value;
    }
  }
  for (const record of operations.values()) {
    if (record.manifests.length > 0 && record.stableIntent === null) {
      throw new Error();
    }
    for (const manifest of record.manifests) {
      validateManifestBinding(record.stableIntent, manifest);
    }
  }
  return { hasEntries: names.length > 0, operations };
}

function wrapperLeavesValid(kind, operationId, leaves) {
  if (leaves.length > 2 || new Set(leaves).size !== leaves.length) {
    return false;
  }
  let allowed;
  if (kind === "canary") {
    allowed = new Set([
      `proof-${operationId}-0`,
      `deletion-${operationId}-0`,
    ]);
  } else if (kind === "prepare" || kind === "finalize") {
    allowed = new Set(["payload", `delete-${operationId}`]);
  } else {
    allowed = new Set(["payload"]);
  }
  return leaves.every(leaf => allowed.has(leaf));
}

function inspectBundles(context, bundles, device, operations) {
  const names = stableDirectoryEntries(context.io, bundles.fd);
  for (const operationId of names) {
    if (!UUID_PATTERN.test(operationId)) throw new Error();
    const operation = operations.get(operationId);
    if (operation?.stableKind === null || operation === undefined) {
      throw new Error();
    }
    const wrapper = holdDirectory(
      context,
      bundles.fd,
      operationId,
      device,
    );
    const leaves = stableDirectoryEntries(context.io, wrapper.fd);
    if (
      !wrapperLeavesValid(
        operation.stableKind,
        operationId,
        leaves,
      )
    ) {
      throw new Error();
    }
    for (const leaf of leaves) {
      holdDirectory(context, wrapper.fd, leaf, device);
    }
  }
  return names.length > 0;
}

function canonicalStateRoot(value) {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value &&
    resolve(value) === value &&
    basename(value) === "state" &&
    dirname(value) !== value
  );
}

export function checkAtomicPublicationRollback(stateRoot, hooks = {}) {
  if (!canonicalStateRoot(stateRoot)) return INVALID_INVOCATION;

  const context = {
    io: hooks.io ?? DEFAULT_IO,
    openFds: [],
    directories: [],
  };
  let result = INVALID_LAYOUT;
  let closeFailed = false;
  try {
    if (context.io.realpathSync(stateRoot) !== stateRoot) {
      throw new Error();
    }
    const parentPath = dirname(stateRoot);
    const parentFd = context.io.openSync(parentPath, DIRECTORY_FLAGS);
    context.openFds.push(parentFd);
    const parentStat = context.io.fstatSync(parentFd, {
      bigint: true,
    });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error();
    }

    const state = holdDirectory(context, parentFd, "state", null);
    const device = state.stat.dev;
    const rootNames = stableDirectoryEntries(context.io, state.fd);
    const rootSet = new Set(rootNames);
    const knownRootNames = new Set([
      ".profile-publish-staging",
      "profiles",
      "quarantine",
      "replay",
    ]);
    if (
      !rootSet.has("profiles") ||
      !rootSet.has(".profile-publish-staging") ||
      rootNames.some(leaf => !knownRootNames.has(leaf))
    ) {
      throw new Error();
    }
    const profiles = holdDirectory(
      context,
      state.fd,
      "profiles",
      device,
    );
    const staging = holdDirectory(
      context,
      state.fd,
      ".profile-publish-staging",
      device,
    );
    for (const optional of ["quarantine", "replay"]) {
      if (rootSet.has(optional)) {
        holdDirectory(context, state.fd, optional, device);
      }
    }
    const bundles = holdDirectory(
      context,
      staging.fd,
      "bundles",
      device,
    );
    const intents = holdDirectory(
      context,
      staging.fd,
      "intents",
      device,
    );
    void profiles;

    if (typeof hooks.afterLayoutHeld === "function") {
      hooks.afterLayoutHeld();
    }

    const stagingNames = stableDirectoryEntries(context.io, staging.fd);
    if (
      stagingNames.length !== 2 ||
      stagingNames[0] !== "bundles" ||
      stagingNames[1] !== "intents"
    ) {
      throw new Error();
    }

    const intentState = inspectIntents(context, intents, device);
    const hasBundles = inspectBundles(
      context,
      bundles,
      device,
      intentState.operations,
    );

    for (const held of context.directories) {
      const current = context.io.fstatSync(held.fd, {
        bigint: true,
      });
      const rebound = context.io.lstatSync(
        procPath(held.parentFd, held.leaf),
        { bigint: true },
      );
      if (
        !validateReservedDirectoryMetadata(current, device) ||
        !sameSnapshot(held.stat, current) ||
        !sameIdentity(current, rebound)
      ) {
        throw new Error();
      }
    }

    const parentRebound = context.io.lstatSync(
      procPath(parentFd, "state"),
      {
        bigint: true,
      },
    );
    const pathRebound = context.io.lstatSync(stateRoot, {
      bigint: true,
    });
    if (
      !sameIdentity(state.stat, parentRebound) ||
      !sameIdentity(state.stat, pathRebound) ||
      context.io.realpathSync(stateRoot) !== stateRoot
    ) {
      throw new Error();
    }

    result =
      intentState.hasEntries || hasBundles ? UNRESOLVED : SAFE;
  } catch {
    result = INVALID_LAYOUT;
  } finally {
    for (
      let index = context.openFds.length - 1;
      index >= 0;
      index -= 1
    ) {
      try {
        context.io.closeSync(context.openFds[index]);
      } catch {
        closeFailed = true;
      }
    }
  }
  return closeFailed ? INVALID_LAYOUT : result;
}

function run() {
  const result =
    process.argv.length === 3 &&
    process.argv[2] === CURRENT_STATE_ROOT
      ? checkAtomicPublicationRollback(CURRENT_STATE_ROOT)
      : INVALID_INVOCATION;
  process.stderr.write(`${result.category}\n`);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
