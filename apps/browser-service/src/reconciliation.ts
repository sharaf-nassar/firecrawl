import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  statfsSync,
  statSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";

import type {
  AtomicEffectObservationV1,
  AtomicEffectRequestV1,
  AtomicEffectRequestDraftV1,
  AtomicCanaryProofV1,
  AtomicCanaryRecoveryInputV1,
  AtomicTerminalResultV1,
  AtomicLocationMoveV1,
  AtomicManifestPlannedRecoveryActionV1,
  AtomicManifestPlannedRecoveryObservationV1,
  AtomicManifestPlannedRecoveryStateV1,
  AtomicNativeClassificationV1,
  AtomicObjectEvidenceV1,
  AtomicObjectRoleV1,
  AtomicProtectedCleanupEntryV1,
  AtomicProtectedCleanupObservationV1,
  AtomicProtectedCleanupStateV1,
  AtomicProtectedCleanupTerminalObservationV1,
  AtomicProtectedCleanupTerminalStepV1,
  AtomicStartupRecoveryDecisionV1,
  AtomicStartupRecoveryTopologyV1,
  FlightEffectId,
  FlightPartialCreateId,
  FlightSemanticId,
} from "./atomic-directory-publication.js";
import {
  ATOMIC_MAX_ACTIVE_STABLE_INTENTS,
  ATOMIC_MAX_MANIFEST_BYTES,
  ATOMIC_MAX_METADATA_FILES,
  ATOMIC_MAX_OTHER_METADATA_BYTES,
  ATOMIC_MAX_PAYLOAD_BYTES,
  ATOMIC_MAX_PAYLOAD_ENTRIES,
  ATOMIC_MAX_RECOVERY_RECORDS,
  ATOMIC_MAX_SCRATCH_ENTRIES,
  ATOMIC_MAX_SCRATCH_METADATA_FILES,
  ATOMIC_MAX_SCRATCH_MANIFEST_BYTES,
  ATOMIC_MAX_SCRATCH_OTHER_METADATA_BYTES,
  ATOMIC_MAX_STABLE_METADATA_FILES,
  ATOMIC_MAX_STABLE_MANIFEST_BYTES,
  ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES,
  assertAtomicProfileSchemaV1,
  authorizeAtomicCanaryCleanupRemoval,
  completeAtomicCanaryCleanupRemoval,
  createAtomicReducerState,
  createAtomicCanaryReducerState,
  createAtomicManifestPlannedRecoveryState,
  createAtomicProtectedCleanupState,
  advanceAtomicManifestPlannedRecovery,
  advanceAtomicProtectedCleanupEntry,
  advanceAtomicProtectedCleanupTerminal,
  beginAtomicProtectedCleanupEntry,
  beginAtomicProtectedCleanupTerminal,
  isAtomicControlLeafV1,
  isAtomicCanaryProofV1,
  isAtomicPayloadLeafV1,
  reduceAtomicPublication,
  reduceAtomicStartupRecoveryV1,
} from "./atomic-directory-publication.js";
import { loadAtomicDirectoryPublicationNative } from "./atomic-directory-publication-native.js";
import {
  createAtomicPublicationObservability,
  type AtomicPublicationCounter,
  type AtomicPublicationObservability,
  type AtomicPublicationObservabilitySink,
} from "./atomic-publication-observability.js";
import {
  encodeAtomicPublishIntent,
  encodeCleanupIdentityManifest,
  parseAtomicPublicationIntentLeaf,
  parseAtomicPublishIntent,
  parseCleanupIdentityManifest,
  publicationTargetLocatorDigest,
  validateCleanupIdentityManifestBinding,
  validateAtomicPublishIntentTransition,
  type AtomicPublishIntentV1,
  type CleanupIdentityEntryV1,
  type CleanupIdentityManifestV1,
  type PublicationTargetV1,
} from "./atomic-publication-manifest.js";
import {
  MAX_RECONCILIATION_REFERENCES,
  canonicalJson,
  reconciliationRequestV1Schema,
  storageStateV1Schema,
  tokenSchema,
  type ReconciliationReferenceV1,
  type ReconciliationRequestV1,
  type ReconciliationResultV1,
} from "./contracts.js";
import { BrowserServiceError } from "./errors.js";
import type { ProfileStore } from "./profile-store.js";
import type { ReconciliationExecutionAdmission } from "./startup-state.js";

const CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024;
const PROFILE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const PROFILE_TOTAL_MAX_BYTES = 256 * 1024 * 1024;
const PROFILE_MAX_DEPTH = 64;
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_GRACE_PERIOD_MS = 10 * 60 * 1_000;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const UUID_FILE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/u;
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DELETION_TOMBSTONE =
  /^\.([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.deleting$/u;
const PROFILE_STATES = new Set(["committed", "staging", "working"]);
const PLAN_FILES = new Set([
  "plan.tmp",
  "plan.json",
  "complete.tmp",
  "complete",
]);
const ATOMIC_PROCFS_MAGIC = 0x9fa0n;
const ATOMIC_O_PATH = 0o10000000;
const ATOMIC_ALLOWED_FILESYSTEM_TYPES = new Set([
  0xef53n,
  0x58465342n,
  0x9123683en,
  0x01021994n,
  0x794c7630n,
]);
const ATOMIC_SEMANTIC_ID_LIMIT = 4_096;
const ATOMIC_PARTIAL_ID_LIMIT = 1_024;
const ATOMIC_DIRECTORY_PAGE_LIMIT = 256;
const ATOMIC_OBSERVATION_BYTE_LIMIT = 65_536;
const ATOMIC_HELD_PROFILE_HASH_IMPLEMENTATION =
  "reconciliation-private-held-profile-hash";

type Logger = {
  info(record: Record<string, unknown>): void;
  error(record: Record<string, unknown>): void;
};

export type ReconciliationDependencies = {
  admission: ReconciliationExecutionAdmission;
  freshAtomicCanary?: boolean;
  now?: () => Date;
  gracePeriodMs?: number;
  maxManagedEntries?: number;
  correlationId?: string;
  logger?: Pick<Logger, "info" | "error">;
  atomicPublicationSink?: AtomicPublicationObservabilitySink;
};

export type ReconciliationFilesystemTestContext = {
  beforeCall?: (point: string) => void | Promise<void>;
  afterCall?: (point: string) => void | Promise<void>;
  beforeClose?: (point: string) => void | Promise<void>;
  closeOperation?: (
    point: string,
    close: () => Promise<void>,
  ) => Promise<void>;
  handleClosed?: (point: string) => void;
  directoryStreamOpened?: (bufferSize: number) => void;
  beforeFinalPromotionAnchors?: () => void | Promise<void>;
  beforeCleanup?: (point: string) => void | Promise<void>;
  overflowLookaheadRead?: (
    read: () => Promise<Dirent<string> | null>,
  ) => Promise<Dirent<string> | null>;
  atomicGate?: (
    phase: "before" | "after",
    point: string,
  ) => void;
  atomicProcfsScenario?:
    | "missing"
    | "inaccessible"
    | "wrong_type"
    | "identity_mismatch"
    | "unsupported_operation";
  atomicStatfsScenario?: "disallowed" | "device_mismatch";
  atomicNativeBarrier?: (
    phase: "before" | "after",
    move: Extract<
      AtomicEffectRequestV1,
      { kind: "native_no_replace" }
    >["move"],
  ) => void;
  atomicPersistenceNative?: (
    phase: "before" | "after",
    move: "intent_publish" | "manifest_publish",
  ) => void;
  atomicOpenFlags?: (point: string, flags: number, mode?: number) => void;
  atomicOperationCompleted?: (point: string) => void;
  sealedGenerationClosing?: (locator: ProfileGenerationLocator) => void;
  atomicStartupRecoveryDecision?: (
    operationId: string,
    topology: AtomicStartupRecoveryTopologyV1,
    decision: AtomicStartupRecoveryDecisionV1,
  ) => void;
  atomicProtectedCleanupObservation?: (
    observation:
      | AtomicProtectedCleanupObservationV1
      | AtomicProtectedCleanupTerminalObservationV1,
  ) =>
    | AtomicProtectedCleanupObservationV1
    | AtomicProtectedCleanupTerminalObservationV1;
};

const filesystemTestContext =
  new AsyncLocalStorage<ReconciliationFilesystemTestContext>();

export async function runWithReconciliationFilesystemTestContext<T>(
  context: ReconciliationFilesystemTestContext,
  callback: () => Promise<T>,
): Promise<T> {
  return filesystemTestContext.run(Object.freeze({ ...context }), callback);
}

type ParentIdentityV1 = {
  path: string;
  dev: string;
  ino: string;
  mode: number;
};

type ReconciliationPlanEntryV1 = {
  sourcePath: string;
  destinationPath: string;
  recognizedType: "replay_checkpoint" | "profile_generation";
  identitySha256: string;
  bytes: number;
  sourceParent: ParentIdentityV1;
  destinationParent: ParentIdentityV1;
  phaseModel: 1;
};

type ReconciliationPlanV1 = {
  version: 1;
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
  retained: number;
  removed: number;
  entries: ReconciliationPlanEntryV1[];
};

type CompletionV1 = {
  version: 1;
  manifestSha256: string;
  retained: number;
  removed: number;
};

type Candidate = {
  sourcePath: string;
  recognizedType: ReconciliationPlanEntryV1["recognizedType"];
  identitySha256: string;
  bytes: number;
  maxMtimeMs: number;
  sourceParent: ParentIdentityV1;
};

type LoadedManifest = {
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
  directoryPath: string;
  plan: ReconciliationPlanV1;
  bytes: Buffer;
  checksum: string;
  completion: CompletionV1 | null;
  completionStorage: "temp" | "final" | null;
};

type CompletionOnlyRecord = {
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
  directoryPath: string;
  completion: CompletionV1;
};

type EmptyPlanSkeleton = {
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
  directoryPath: string;
};

type LoadedPlanRecord =
  | { kind: "manifest"; value: LoadedManifest }
  | { kind: "completion-only"; value: CompletionOnlyRecord }
  | { kind: "empty"; value: EmptyPlanSkeleton };

type ProfileTreeEntryV1 = {
  path: string;
  type: "directory" | "file";
  mode: number;
  size: number;
  sha256: string | null;
};

export type CanonicalProfileTree = {
  canonicalJson: string;
  checksum: string;
  byteSize: number;
  maxMtimeMs: number;
};

declare const anchoredProfileRootBrand: unique symbol;
declare const boundProfileGenerationBrand: unique symbol;
declare const internalReconciliationOutcomeBrand: unique symbol;
declare const installedReconciledAuthorityBrand: unique symbol;
declare const chromiumSessionAttachmentBrand: unique symbol;

export type ReconciledRootEvidence = Readonly<{
  canonicalAbsoluteComponents: readonly string[];
  componentIdentities: readonly Readonly<{
    dev: string;
    ino: string;
    mode: number;
  }>[];
  binding: ReadyProfileRootBinding;
}>;

export type AnchoredProfileRoot = Readonly<{
  [anchoredProfileRootBrand]: true;
}>;

export type InternalReconciliationOutcome = Readonly<{
  [internalReconciliationOutcomeBrand]: true;
}>;

export type InstalledReconciledAuthority = Readonly<{
  [installedReconciledAuthorityBrand]: true;
}>;

export type ProfileGenerationLocator = Readonly<{
  profileId: string;
  state: "working" | "staging" | "committed";
  generationId: string;
  openMode: "existing" | "create_exclusive";
}>;

export type ReadyProfileRootBinding = Readonly<{
  processNonce: string;
  controlGenerationNonce: string;
  snapshotDigest: string;
}>;

export type CanonicalProfileTreeEvidence = CanonicalProfileTree & {
  readonly entries: readonly Readonly<{
    path: string;
    type: "directory" | "file";
    dev: string;
    ino: string;
    nlink: string;
    mode: number;
    size: number;
    sha256: string | null;
  }>[];
  readonly fileCount: number;
};

export type BoundProfileGeneration = Readonly<{
  [boundProfileGenerationBrand]: true;
  transitionTo(
    state: "staging" | "committed",
  ): Promise<BoundProfileGeneration>;
  remove(): Promise<void>;
  close(): Promise<void>;
}>;

export type DeletePreparedProfileGenerationInput = Readonly<{
  binding: ReadyProfileRootBinding;
  expectedChecksum: string;
  authorityDigest: string;
}>;

export type ChromiumSessionAttachment = Readonly<{
  [chromiumSessionAttachmentBrand]: true;
  context: BrowserContext;
}>;

export class UnverifiedChromiumLaunchError extends Error {
  readonly cleanupUnverified = true;

  constructor(
    message: string,
    readonly attachment: ChromiumSessionAttachment,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UnverifiedChromiumLaunchError";
  }
}

export type InternalReconciliationInstall = Readonly<{
  publicResult: ReconciliationResultV1;
  authority: InstalledReconciledAuthority;
  root: AnchoredProfileRoot;
}>;

export type InternalReconciliationStartupInstall =
  InternalReconciliationInstall &
    Readonly<{
      binding: ReadyProfileRootBinding;
      profileStore: ProfileStore;
      sealedGenerationCount: number;
      sealedGenerations: readonly BoundProfileGeneration[];
    }>;

export type InternalReconciliationProfileStoreFactory = (
  root: AnchoredProfileRoot,
  binding: ReadyProfileRootBinding,
  sealedGenerationCount: number,
) => Promise<ProfileStore>;

export type ValidatedPersistentChromiumOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

type ProfileTreeEvidence = {
  path: string;
  type: "directory" | "file";
  stat: BigIntStats;
  sha256: string | null;
};

type ProfileHashResult = CanonicalProfileTree & {
  evidence: ProfileTreeEvidence[];
};

function err(
  category: ConstructorParameters<typeof BrowserServiceError>[0],
  message: string,
): BrowserServiceError {
  return new BrowserServiceError(category, message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function lowModeBigint(mode: bigint): number {
  return Number(mode & 0o777n);
}

function sameObjectIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory()
  );
}

function procPath(handle: FileHandle, leaf?: string): string {
  const base = `/proc/self/fd/${handle.fd}`;
  return leaf === undefined ? base : `${base}/${leaf}`;
}

function assertAdmitted(admission: ReconciliationExecutionAdmission): void {
  try {
    admission.signal.throwIfAborted();
    admission.assertAdmitted();
  } catch (error) {
    if (
      error instanceof BrowserServiceError &&
      error.category === "reconciliation_required"
    ) {
      throw error;
    }
    throw err("reconciliation_required", "reconciliation is not admitted");
  }
}

async function admittedFilesystemCall<T>(
  admission: ReconciliationExecutionAdmission,
  operation: () => Promise<T>,
): Promise<T> {
  assertAdmitted(admission);
  const result = await operation();
  assertAdmitted(admission);
  return result;
}

async function call<T>(
  admission: ReconciliationExecutionAdmission,
  point: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertAdmitted(admission);
  await filesystemTestContext.getStore()?.beforeCall?.(point);
  const result = await admittedFilesystemCall(admission, operation);
  await filesystemTestContext.getStore()?.afterCall?.(point);
  assertAdmitted(admission);
  return result;
}

async function callOpen(
  admission: ReconciliationExecutionAdmission,
  point: string,
  operation: () => Promise<FileHandle>,
  onAcquire?: (handle: FileHandle) => void,
): Promise<FileHandle> {
  assertAdmitted(admission);
  await filesystemTestContext.getStore()?.beforeCall?.(point);
  assertAdmitted(admission);
  let handle: FileHandle | undefined;
  try {
    handle = await operation();
    onAcquire?.(handle);
    assertAdmitted(admission);
    await filesystemTestContext.getStore()?.afterCall?.(point);
    assertAdmitted(admission);
    return handle;
  } catch (error) {
    if (handle !== undefined && onAcquire === undefined) {
      try {
        await closeRaw(handle, `failed-${point}`);
      } catch {
        // Preserve the acquisition failure after attempting ownership cleanup.
      }
    }
    throw error;
  }
}

async function callHeldMutation<T>(
  admission: ReconciliationExecutionAdmission,
  point: string,
  revalidate: () => Promise<void>,
  operation: () => Promise<T>,
  revalidateAfter: () => Promise<void> = revalidate,
): Promise<T> {
  assertAdmitted(admission);
  await filesystemTestContext.getStore()?.beforeCall?.(point);
  await revalidate();
  const result = await admittedFilesystemCall(admission, operation);
  await filesystemTestContext.getStore()?.afterCall?.(point);
  await revalidateAfter();
  assertAdmitted(admission);
  return result;
}

async function callHeldOpenMutation(
  admission: ReconciliationExecutionAdmission,
  point: string,
  revalidate: () => Promise<void>,
  operation: () => Promise<FileHandle>,
  ownership: Readonly<{
    cleanup: PartialCreateCleanupRecord;
    point: string;
  }>,
): Promise<FileHandle> {
  assertAdmitted(admission);
  await filesystemTestContext.getStore()?.beforeCall?.(point);
  await revalidate();
  const handle = await operation();
  ownership.cleanup.handles.set(handle, {
    point: ownership.point,
    closed: false,
  });
  assertAdmitted(admission);
  await filesystemTestContext.getStore()?.afterCall?.(point);
  await revalidate();
  assertAdmitted(admission);
  return handle;
}

async function callHeldExclusiveMkdir(
  admission: ReconciliationExecutionAdmission,
  point: string,
  revalidate: () => Promise<void>,
  operation: () => Promise<void>,
  onCreate: () => void,
): Promise<void> {
  assertAdmitted(admission);
  await filesystemTestContext.getStore()?.beforeCall?.(point);
  await revalidate();
  assertAdmitted(admission);
  await operation();
  // Transfer ownership synchronously before admission, hooks, or path
  // revalidation can fail after the exclusive namespace mutation.
  onCreate();
  assertAdmitted(admission);
}

async function finishHeldExclusiveMkdir(
  admission: ReconciliationExecutionAdmission,
  point: string,
  revalidate: () => Promise<void>,
): Promise<void> {
  await filesystemTestContext.getStore()?.afterCall?.(point);
  await revalidate();
  assertAdmitted(admission);
}

async function openInternal(
  admission: ReconciliationExecutionAdmission,
  operation: () => Promise<FileHandle>,
): Promise<FileHandle> {
  assertAdmitted(admission);
  let handle: FileHandle | undefined;
  try {
    handle = await operation();
    assertAdmitted(admission);
    return handle;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the acquisition failure after ownership cleanup.
      }
    }
    throw error;
  }
}

async function closeRaw(handle: FileHandle, point: string): Promise<void> {
  let injected: unknown;
  try {
    await filesystemTestContext.getStore()?.beforeClose?.(point);
  } catch (error) {
    injected = error;
  }
  let closeFailure: unknown;
  let closeVerified = false;
  try {
    const close = () => handle.close();
    const closeOperation = filesystemTestContext.getStore()?.closeOperation;
    if (closeOperation === undefined) await close();
    else await closeOperation(point, close);
    closeVerified = true;
  } catch (error) {
    closeFailure = error;
  } finally {
    if (closeVerified) filesystemTestContext.getStore()?.handleClosed?.(point);
  }
  if (injected !== undefined) throw injected;
  if (closeFailure !== undefined) throw closeFailure;
}

async function closeAll(
  handles: readonly (readonly [FileHandle | undefined, string])[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const [handle, point] of handles) {
    if (handle === undefined) continue;
    try {
      await closeRaw(handle, point);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "descriptor cleanup failed");
  }
}

async function closeAllDirect(handles: readonly FileHandle[]): Promise<void> {
  const failures: unknown[] = [];
  for (const handle of handles) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "descriptor cleanup failed");
  }
}

class Budget {
  readonly #maximum: number;
  #count = 0;
  readonly #namespaceRoots = new Set<string>();

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  take(): void {
    if (this.#count >= this.#maximum) {
      throw err(
        "reconciliation_snapshot_too_large",
        "managed state entry limit exceeded",
      );
    }
    this.#count += 1;
  }

  fresh(): Budget {
    return new Budget(this.#maximum);
  }

  reserve(allowEofProbe = false): {
    readonly overflow: boolean;
    commit(): void;
    rollback(): void;
  } {
    const overflow = this.#count >= this.#maximum;
    if (overflow && !allowEofProbe) {
      throw err(
        "reconciliation_snapshot_too_large",
        "managed state entry limit exceeded",
      );
    }
    this.#count += 1;
    let active = true;
    return {
      overflow,
      commit: (): void => {
        active = false;
        if (overflow) {
          this.#count -= 1;
          throw err(
            "reconciliation_snapshot_too_large",
            "managed state entry limit exceeded",
          );
        }
      },
      rollback: (): void => {
        if (!active) return;
        active = false;
        this.#count -= 1;
      },
    };
  }

  markNamespaceRoot(relative: string): void {
    this.#namespaceRoots.add(relative);
  }

  reserveNamespaceRoot(
    relative: string,
  ): { commit(): void; rollback(): void } | null {
    if (this.#namespaceRoots.has(relative)) return null;
    const reservation = this.reserve();
    return {
      commit: (): void => {
        reservation.commit();
        this.#namespaceRoots.add(relative);
      },
      rollback: (): void => reservation.rollback(),
    };
  }
}

async function collectHeldDirectoryEntries(
  stream: Awaited<ReturnType<typeof fs.opendir>>,
  budget: Budget,
  readEntry: (
    overflow: boolean,
  ) => Promise<Dirent<string> | null>,
  yieldEntry: (entry: Dirent<string>) => Promise<void>,
  closeStream: () => Promise<void>,
): Promise<Dirent<string>[]> {
  const entries: Dirent<string>[] = [];
  try {
    while (true) {
      const reservation = budget.reserve(true);
      let entry: Dirent<string> | null;
      try {
        entry = await readEntry(reservation.overflow);
      } catch (error) {
        reservation.rollback();
        throw error;
      }
      if (entry === null) {
        reservation.rollback();
        break;
      }
      reservation.commit();
      await yieldEntry(entry);
      entries.push(entry);
    }
    return entries;
  } finally {
    await closeStream();
  }
}

type HeldAbsoluteComponent = {
  name: string;
  handle: FileHandle;
  stat: BigIntStats;
};

class AnchoredRoot {
  readonly handle: FileHandle;
  readonly admission: ReconciliationExecutionAdmission;
  readonly components: readonly HeldAbsoluteComponent[];
  readonly canonicalPath: string;

  constructor(
    components: readonly HeldAbsoluteComponent[],
    canonicalPath: string,
    admission: ReconciliationExecutionAdmission,
  ) {
    const handle = components.at(-1)?.handle;
    if (handle === undefined) throw new TypeError("root chain is empty");
    this.handle = handle;
    this.components = components;
    this.canonicalPath = canonicalPath;
    this.admission = admission;
  }

  evidence(binding: ReadyProfileRootBinding): ReconciledRootEvidence {
    return Object.freeze({
      canonicalAbsoluteComponents: Object.freeze(
        this.components.map((component) => component.name),
      ),
      componentIdentities: Object.freeze(
        this.components.map((component) =>
          Object.freeze({
            dev: String(component.stat.dev),
            ino: String(component.stat.ino),
            mode: lowModeBigint(component.stat.mode),
          }),
        ),
      ),
      binding: Object.freeze({ ...binding }),
    });
  }

  async revalidate(): Promise<void> {
    for (let index = 0; index < this.components.length; index += 1) {
      const component = this.components[index]!;
      const held = await call(this.admission, "absolute-held-stat", () =>
        component.handle.stat({ bigint: true }),
      );
      if (!sameObjectIdentity(component.stat, held)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "absolute root handle changed",
        );
      }
      if (index === 0) continue;
      const parent = this.components[index - 1]!;
      const rebound = await call(this.admission, "absolute-parent-lstat", () =>
        fs.lstat(procPath(parent.handle, component.name), { bigint: true }),
      );
      if (!sameObjectIdentity(component.stat, rebound)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "absolute root binding changed",
        );
      }
    }
  }

  async close(): Promise<void> {
    const components = [...this.components].reverse();
    try {
      await closeAll(
        components.map(
          (component, index) =>
            [
              component.handle,
              index === 0 ? "root" : `root-chain-${index}`,
            ] as const,
        ),
      );
    } catch (error) {
      try {
        await closeAllDirect(components.map(component => component.handle));
      } catch (fallbackError) {
        throw new AggregateError(
          [error, fallbackError],
          "root descriptor cleanup failed",
        );
      }
      throw error;
    }
  }

  async openDirectory(relative: string): Promise<FileHandle> {
    const segments = relative === "" ? [] : relative.split("/");
    let current = this.handle;
    let ownsCurrent = false;
    try {
      for (const segment of segments) {
        validateSegment(segment);
        const next = await callOpen(this.admission, "open-directory", () =>
          fs.open(
            procPath(current, segment),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
        );
        try {
          if (ownsCurrent) await closeRaw(current, "walk-directory");
        } catch (error) {
          await closeRaw(next, "failed-next-directory");
          throw error;
        }
        current = next;
        ownsCurrent = true;
      }
      if (!ownsCurrent) {
        return callOpen(this.admission, "duplicate-root", () =>
          fs.open(
            procPath(this.handle, "."),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
        );
      }
      return current;
    } catch (error) {
      if (ownsCurrent) await closeRaw(current, "failed-directory-walk");
      if (
        isNodeError(error) &&
        (error.code === "ELOOP" || error.code === "ENOTDIR")
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "directory component is unsafe",
        );
      }
      throw error;
    }
  }

  async openParent(
    relative: string,
  ): Promise<{ parent: FileHandle; leaf: string }> {
    const segments = relative.split("/");
    const leaf = segments.pop();
    if (leaf === undefined || leaf === "") {
      throw err("reconciliation_filesystem_unsafe", "state path is invalid");
    }
    validateSegment(leaf);
    return { parent: await this.openDirectory(segments.join("/")), leaf };
  }

  async ensureDirectory(relative: string): Promise<FileHandle> {
    const segments = relative === "" ? [] : relative.split("/");
    let current = await this.openDirectory("");
    try {
      for (const segment of segments) {
        validateSegment(segment);
        let created = false;
        try {
          await call(this.admission, "mkdir", () =>
            fs.mkdir(procPath(current, segment), { mode: 0o700 }),
          );
          created = true;
        } catch (error) {
          const existing = await this.lstatOptional(current, segment);
          if (existing === null || !existing.isDirectory()) throw error;
          await call(this.admission, "repair-mkdir-parent", () =>
            current.sync(),
          );
          if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        }
        const next = await callOpen(
          this.admission,
          "open-created-directory",
          () =>
            fs.open(
              procPath(current, segment),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            ),
        );
        try {
          if (created) {
            await call(this.admission, "fsync-created-parent", () =>
              current.sync(),
            );
          } else {
            await call(this.admission, "repair-mkdir-parent", () =>
              current.sync(),
            );
          }
          await closeRaw(current, "ensure-directory-parent");
        } catch (error) {
          await closeRaw(next, "failed-created-directory");
          throw error;
        }
        current = next;
      }
      return current;
    } catch (error) {
      await closeRaw(current, "failed-ensure-directory");
      throw error;
    }
  }

  async readdir(
    directory: FileHandle,
    budget: Budget,
  ): Promise<Dirent<string>[]> {
    assertAdmitted(this.admission);
    await filesystemTestContext
      .getStore()
      ?.beforeCall?.("open-directory-stream");
    assertAdmitted(this.admission);
    let stream: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      const bufferSize = 32;
      stream = await fs.opendir(procPath(directory), { bufferSize });
      assertAdmitted(this.admission);
      filesystemTestContext.getStore()?.directoryStreamOpened?.(bufferSize);
      await filesystemTestContext
        .getStore()
        ?.afterCall?.("open-directory-stream");
      assertAdmitted(this.admission);
    } catch (error) {
      if (stream !== undefined) {
        try {
          await stream.close();
        } catch {
          // Preserve the acquisition failure after attempting cleanup.
        }
      }
      throw error;
    }
    const openedStream = stream;
    return collectHeldDirectoryEntries(
      openedStream,
      budget,
      (overflow) => {
        if (overflow) {
          const read = (): Promise<Dirent<string> | null> =>
            admittedFilesystemCall(this.admission, () => openedStream.read());
          return call(
            this.admission,
            "read-overflow-lookahead",
            () =>
              filesystemTestContext
                .getStore()
                ?.overflowLookaheadRead?.(read) ?? read(),
          );
        }
        return call(this.admission, "read-directory-entry", () =>
          openedStream.read(),
        );
      },
      (entry) =>
        call(
          this.admission,
          "yield-directory-entry",
          async () => entry,
        ).then(() => undefined),
      () => openedStream.close(),
    );
  }

  async lstat(parent: FileHandle, leaf: string) {
    return call(this.admission, "lstat", () =>
      fs.lstat(procPath(parent, leaf), { bigint: true }),
    );
  }

  async lstatOptional(parent: FileHandle, leaf: string) {
    try {
      return await this.lstat(parent, leaf);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

async function openDirectoryInternal(
  root: AnchoredRoot,
  relative: string,
): Promise<FileHandle> {
  const segments = relative === "" ? [] : relative.split("/");
  let current = root.handle;
  let ownsCurrent = false;
  try {
    for (const segment of segments) {
      validateSegment(segment);
      const next = await openInternal(root.admission, () =>
        fs.open(
          procPath(current, segment),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
      try {
        if (ownsCurrent) await current.close();
      } catch (error) {
        await next.close();
        throw error;
      }
      current = next;
      ownsCurrent = true;
    }
    if (!ownsCurrent) {
      return openInternal(root.admission, () =>
        fs.open(
          procPath(root.handle, "."),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
    }
    return current;
  } catch (error) {
    if (ownsCurrent) await current.close();
    if (
      isNodeError(error) &&
      (error.code === "ELOOP" || error.code === "ENOTDIR")
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "directory component is unsafe",
      );
    }
    throw error;
  }
}

function validateSegment(segment: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment !== segment.normalize("NFC") ||
    Buffer.byteLength(segment, "utf8") > 255 ||
    /[\\/\u0000-\u001f\u007f]/u.test(segment)
  ) {
    throw err("reconciliation_filesystem_unsafe", "state path is unsafe");
  }
}

function validateRelativePath(relative: string): void {
  if (
    relative === "" ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    Buffer.byteLength(relative, "utf8") > 1_024
  ) {
    throw err("reconciliation_filesystem_unsafe", "state path is unsafe");
  }
  for (const segment of relative.split("/")) validateSegment(segment);
}

async function openAnchoredRoot(
  configuredRoot: string,
  admission: ReconciliationExecutionAdmission,
): Promise<AnchoredRoot> {
  if (
    process.platform !== "linux" ||
    !path.isAbsolute(configuredRoot) ||
    path.resolve(configuredRoot) === path.parse(configuredRoot).root
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "Linux procfs state root is required",
    );
  }
  const canonical = path.resolve(configuredRoot);
  if (canonical !== configuredRoot) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "state root is not canonical",
    );
  }
  const components: HeldAbsoluteComponent[] = [];
  try {
    const slash = await callOpen(admission, "open-slash", () =>
      fs.open(
        path.parse(canonical).root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    );
    let slashStat: BigIntStats;
    try {
      slashStat = await call(admission, "stat-slash", () =>
        slash.stat({ bigint: true }),
      );
    } catch (error) {
      await slash.close().catch(() => undefined);
      throw error;
    }
    components.push({
      name: path.parse(canonical).root,
      handle: slash,
      stat: slashStat,
    });
    const absoluteNames = canonical.split(path.sep).filter(Boolean);
    for (const [index, name] of absoluteNames.entries()) {
      validateSegment(name);
      const parent = components.at(-1)!;
      const before = await call(admission, "absolute-component-lstat", () =>
        fs.lstat(procPath(parent.handle, name), { bigint: true }),
      );
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "absolute root component is unsafe",
        );
      }
      const handle = await callOpen(
        admission,
        index === absoluteNames.length - 1
          ? "open-root"
          : "open-absolute-component",
        () =>
          fs.open(
            procPath(parent.handle, name),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
      );
      let after: BigIntStats;
      try {
        after = await call(admission, "absolute-component-stat", () =>
          handle.stat({ bigint: true }),
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      if (!sameObjectIdentity(before, after)) {
        await closeRaw(handle, "failed-absolute-component");
        throw err(
          "reconciliation_filesystem_unsafe",
          "absolute root component binding changed",
        );
      }
      components.push({ name, handle, stat: after });
    }
    const anchored = new AnchoredRoot(components, canonical, admission);
    await anchored.revalidate();
    const procCanonical = await call(admission, "verify-procfs", () =>
      fs.realpath(procPath(anchored.handle)),
    );
    if (procCanonical !== canonical) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "procfs file descriptor anchoring is unavailable",
      );
    }
    return anchored;
  } catch (error) {
    await closeAll(
      components
        .reverse()
        .map((component, index) =>
          [component.handle, `failed-root-${index}`] as const,
        ),
    ).catch(() => undefined);
    throw error;
  }
}

function parentIdentity(
  pathValue: string,
  stat: BigIntStats,
): ParentIdentityV1 {
  return {
    path: pathValue,
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: lowModeBigint(stat.mode),
  };
}

async function identityForDirectory(
  root: AnchoredRoot,
  relative: string,
  budget: Budget,
): Promise<ParentIdentityV1> {
  budget.take();
  const handle = await root.openDirectory(relative);
  try {
    const stat = await call(root.admission, "directory-stat", () =>
      handle.stat({ bigint: true }),
    );
    if (!stat.isDirectory()) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "parent is not a directory",
      );
    }
    return parentIdentity(relative, stat);
  } finally {
    await closeRaw(handle, "identity-directory");
  }
}

function sameParentIdentity(
  expected: ParentIdentityV1,
  actual: ParentIdentityV1,
): boolean {
  return (
    expected.path === actual.path &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.mode === actual.mode
  );
}

async function readRegularFile(
  root: AnchoredRoot,
  relative: string,
  maximum: number,
  budget?: Budget,
): Promise<{
  bytes: Buffer;
  mode: number;
  size: number;
  mtimeMs: number;
  stat: BigIntStats;
}> {
  void budget;
  const { parent, leaf } = await root.openParent(relative);
  try {
    return await readRegularFileAt(root, parent, leaf, maximum);
  } finally {
    await closeRaw(parent, "regular-file-parent");
  }
}

async function readRegularFileAt(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
  maximum: number,
): Promise<{
  bytes: Buffer;
  mode: number;
  size: number;
  mtimeMs: number;
  stat: BigIntStats;
}> {
  let handle: FileHandle | undefined;
  try {
    const before = await root.lstat(parent, leaf);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximum)
    ) {
      throw err("reconciliation_filesystem_unsafe", "managed file is unsafe");
    }
    handle = await callOpen(root.admission, "open-file", () =>
      fs.open(
        procPath(parent, leaf),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ),
    );
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maximum + 1 - total),
      );
      const read = await call(root.admission, "read-file", () =>
        handle!.read(chunk, 0, chunk.length, null),
      );
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > maximum) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "managed file is too large",
        );
      }
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await call(root.admission, "file-stat-after-read", () =>
      handle!.stat({ bigint: true }),
    );
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1n ||
      !sameLeafIdentity(before, after) ||
      BigInt(total) !== before.size
    ) {
      throw err("reconciliation_filesystem_unsafe", "managed file changed");
    }
    const bound = await admittedFilesystemCall(root.admission, () =>
      fs.lstat(procPath(parent, leaf), { bigint: true }),
    );
    if (!sameLeafIdentity(after, bound)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "managed file binding changed",
      );
    }
    return {
      bytes: Buffer.concat(chunks, total),
      mode: lowModeBigint(after.mode),
      size: total,
      mtimeMs: Number(after.mtimeNs) / 1_000_000,
      stat: after,
    };
  } finally {
    if (handle !== undefined) await closeRaw(handle, "regular-file");
  }
}

async function hashProfileTree(
  root: AnchoredRoot,
  generationPath: string,
  budget: Budget,
  chargeRoot = true,
): Promise<CanonicalProfileTree> {
  validateRelativePath(generationPath);
  if (chargeRoot) budget.take();
  const { parent, leaf } = await root.openParent(generationPath);
  let directory: FileHandle | undefined;
  try {
    directory = await callOpen(root.admission, "open-profile-root", () =>
      fs.open(
        procPath(parent, leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    );
    const pinned = await call(root.admission, "profile-root-stat-before", () =>
      directory!.stat({ bigint: true }),
    );
    const tree = await hashProfileTreeAt(root, directory, budget);
    const after = await call(root.admission, "profile-root-stat-after", () =>
      directory!.stat({ bigint: true }),
    );
    const bound = await admittedFilesystemCall(root.admission, () =>
      fs.lstat(procPath(parent, leaf), { bigint: true }),
    );
    if (!sameLeafIdentity(pinned, after) || !sameLeafIdentity(after, bound)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "profile root binding changed",
      );
    }
    const finalTree = await validateProfileEvidenceRaw(
      root,
      directory,
      tree.evidence,
    );
    if (
      finalTree.checksum !== tree.checksum ||
      finalTree.byteSize !== tree.byteSize
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "profile tree changed after validation",
      );
    }
    return finalTree;
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOTDIR" || error.code === "ELOOP")
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "profile root is not a directory",
      );
    }
    throw error;
  } finally {
    await closeAllDirect(
      [directory, parent].filter(
        (handle): handle is FileHandle => handle !== undefined,
      ),
    );
  }
}

async function hashProfileTreeAt(
  root: AnchoredRoot,
  directory: FileHandle,
  budget: Budget,
): Promise<ProfileHashResult> {
  const entries: ProfileTreeEntryV1[] = [];
  const evidence: ProfileTreeEvidence[] = [];
  let total = 0;
  let maxMtimeMs = 0;

  async function walk(
    handle: FileHandle,
    relative: string,
    depth: number,
    expected?: BigIntStats,
  ): Promise<BigIntStats> {
    if (depth > PROFILE_MAX_DEPTH) {
      throw err("reconciliation_filesystem_unsafe", "profile tree is too deep");
    }
    const stat = await call(root.admission, "profile-directory-stat", () =>
      handle.stat({ bigint: true }),
    );
    if (!stat.isDirectory()) {
      throw err("reconciliation_filesystem_unsafe", "profile entry is unsafe");
    }
    if (expected !== undefined && !sameLeafIdentity(expected, stat)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "profile directory binding changed",
      );
    }
    maxMtimeMs = Math.max(maxMtimeMs, Number(stat.mtimeNs) / 1_000_000);
    entries.push({
      path: relative,
      type: "directory",
      mode: lowModeBigint(stat.mode),
      size: 0,
      sha256: null,
    });
    const children = await root.readdir(handle, budget);
    children.sort((left, right) => rawCompare(left.name, right.name));
    for (const child of children) {
      validateSegment(child.name);
      const childRelative =
        relative === "" ? child.name : `${relative}/${child.name}`;
      if (Buffer.byteLength(childRelative, "utf8") > 1_024) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "profile path is too long",
        );
      }
      const childStat = await root.lstat(handle, child.name);
      if (childStat.isSymbolicLink()) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "profile symlink is unsafe",
        );
      }
      if (childStat.isDirectory()) {
        if (depth >= PROFILE_MAX_DEPTH) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "profile tree is too deep",
          );
        }
        const childHandle = await callOpen(
          root.admission,
          "open-profile-directory",
          () =>
            fs.open(
              procPath(handle, child.name),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            ),
        );
        try {
          const childAfter = await walk(
            childHandle,
            childRelative,
            depth + 1,
            childStat,
          );
          const bound = await admittedFilesystemCall(root.admission, () =>
            fs.lstat(procPath(handle, child.name), { bigint: true }),
          );
          if (!sameLeafIdentity(childAfter, bound)) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "profile directory binding changed",
            );
          }
        } finally {
          await closeRaw(childHandle, "profile-directory");
        }
      } else if (childStat.isFile() && childStat.nlink === 1n) {
        if (childStat.size > BigInt(PROFILE_FILE_MAX_BYTES)) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "profile file is too large",
          );
        }
        const file = await readRegularFileAt(
          root,
          handle,
          child.name,
          Math.min(PROFILE_FILE_MAX_BYTES, PROFILE_TOTAL_MAX_BYTES - total),
        );
        total += file.size;
        if (total > PROFILE_TOTAL_MAX_BYTES) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "profile tree is too large",
          );
        }
        maxMtimeMs = Math.max(maxMtimeMs, file.mtimeMs);
        const contentSha256 = sha256(file.bytes);
        entries.push({
          path: childRelative,
          type: "file",
          mode: file.mode,
          size: file.size,
          sha256: contentSha256,
        });
        evidence.push({
          path: childRelative,
          type: "file",
          stat: file.stat,
          sha256: contentSha256,
        });
      } else {
        throw err(
          "reconciliation_filesystem_unsafe",
          "profile entry is special",
        );
      }
    }
    const after = await call(
      root.admission,
      "profile-directory-stat-after",
      () => handle.stat({ bigint: true }),
    );
    if (!sameLeafIdentity(stat, after)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "profile directory changed",
      );
    }
    evidence.push({
      path: relative,
      type: "directory",
      stat: after,
      sha256: null,
    });
    return after;
  }

  await walk(directory, "", 0);
  entries.sort((left, right) => rawCompare(left.path, right.path));
  const canonical = JSON.stringify({ version: 1, entries });
  return {
    canonicalJson: canonical,
    checksum: sha256(canonical),
    byteSize: total,
    maxMtimeMs,
    evidence,
  };
}

async function openRawProfileParent(
  root: AnchoredRoot,
  directory: FileHandle,
  relative: string,
): Promise<{
  parent: FileHandle;
  leaf: string;
  owned: FileHandle[];
  components: HeldRawProfileComponent[];
}> {
  const segments = relative.split("/");
  const leaf = segments.pop();
  if (leaf === undefined || leaf === "") {
    throw err("reconciliation_filesystem_unsafe", "profile path is invalid");
  }
  let current = directory;
  const owned: FileHandle[] = [];
  const components: HeldRawProfileComponent[] = [];
  try {
    for (const segment of segments) {
      validateSegment(segment);
      const before = await call(root.admission, "profile-parent-lstat", () =>
        fs.lstat(procPath(current, segment), { bigint: true }),
      );
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw unsafeCapability("profile parent component is unsafe");
      }
      const next = await callOpen(
        root.admission,
        "profile-evidence-open-parent",
        () =>
          fs.open(
            procPath(current, segment),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
      );
      const after = await call(root.admission, "profile-parent-fstat", () =>
        next.stat({ bigint: true }),
      );
      if (!sameObjectIdentity(before, after)) {
        await next.close();
        throw unsafeCapability("profile parent component changed");
      }
      owned.push(next);
      components.push({ parent: current, leaf: segment, handle: next, stat: after });
      current = next;
    }
    return { parent: current, leaf, owned, components };
  } catch (error) {
    await closeAllDirect(owned);
    throw error;
  }
}

type HeldRawProfileComponent = Readonly<{
  parent: FileHandle;
  leaf: string;
  handle: FileHandle;
  stat: BigIntStats;
}>;

async function revalidateRemovalLeaf(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
  expected: BigIntStats,
  held?: FileHandle,
): Promise<void> {
  const pinned =
    held === undefined
      ? expected
      : await call(root.admission, "removal-leaf-fstat", () =>
          held.stat({ bigint: true }),
        );
  const current = await call(root.admission, "removal-leaf-lstat", () =>
    fs.lstat(procPath(parent, leaf), { bigint: true }),
  );
  if (
    pinned.dev !== expected.dev ||
    pinned.ino !== expected.ino ||
    pinned.mode !== expected.mode ||
    pinned.nlink !== expected.nlink ||
    pinned.size !== expected.size ||
    pinned.isDirectory() !== expected.isDirectory() ||
    pinned.isFile() !== expected.isFile() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mode !== expected.mode ||
    current.nlink !== expected.nlink ||
    current.size !== expected.size ||
    current.isDirectory() !== expected.isDirectory() ||
    current.isFile() !== expected.isFile()
  ) {
    throw unsafeCapability("removal leaf changed");
  }
}

async function pinRemovalLeaf(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  const before = await call(root.admission, "removal-leaf-pin-lstat", () =>
    fs.lstat(procPath(parent, leaf), { bigint: true }),
  );
  if (!before.isDirectory() && !before.isFile()) {
    throw unsafeCapability("removal leaf type is unsafe");
  }
  const handle = await callOpen(root.admission, "removal-leaf-pin-open", () =>
    fs.open(
      procPath(parent, leaf),
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (before.isDirectory() ? constants.O_DIRECTORY : 0),
    ),
  );
  try {
    await revalidateRemovalLeaf(root, parent, leaf, before, handle);
    return { handle, stat: before };
  } catch (error) {
    try {
      await closeRaw(handle, "atomic-authority-failed-open");
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "atomic publication authority cleanup failed",
      );
    }
    throw error;
  }
}

async function revalidateRawProfileParent(
  root: AnchoredRoot,
  directory: FileHandle,
  directoryStat: BigIntStats,
  opened: Readonly<{ components: readonly HeldRawProfileComponent[] }>,
): Promise<void> {
  const base = await call(root.admission, "profile-parent-root-fstat", () =>
    directory.stat({ bigint: true }),
  );
  if (!sameObjectIdentity(directoryStat, base)) {
    throw unsafeCapability("profile parent root changed");
  }
  for (const component of opened.components) {
    const held = await call(root.admission, "profile-parent-held-fstat", () =>
      component.handle.stat({ bigint: true }),
    );
    const rebound = await call(root.admission, "profile-parent-rebound-lstat", () =>
      fs.lstat(procPath(component.parent, component.leaf), { bigint: true }),
    );
    if (
      !sameObjectIdentity(component.stat, held) ||
      !sameObjectIdentity(component.stat, rebound)
    ) {
      throw unsafeCapability("profile nested parent chain changed");
    }
  }
}

async function reconciliationPrivateHeldFileHash(
  handle: FileHandle,
  expected: BigIntStats,
  read: (
    buffer: Buffer,
    offset: number,
  ) => Promise<{ bytesRead: number }>,
  finalStat: () => Promise<BigIntStats>,
): Promise<{ contentSha256: string; stat: BigIntStats }> {
  if (
    !expected.isFile() ||
    expected.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "held file evidence is invalid",
    );
  }
  const expectedSize = Number(expected.size);
  const digest = createHash("sha256");
  let offset = 0;
  while (offset < expectedSize) {
    const chunk = Buffer.allocUnsafe(
      Math.min(64 * 1024, expectedSize - offset),
    );
    const result = await read(chunk, offset);
    if (result.bytesRead === 0) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "held file was truncated",
      );
    }
    digest.update(chunk.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const eof = await read(trailing, offset);
  const after = await finalStat();
  if (
    eof.bytesRead !== 0 ||
    !sameLeafIdentity(expected, after) ||
    after.size !== expected.size
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "held file changed while hashing",
    );
  }
  return { contentSha256: digest.digest("hex"), stat: after };
}

async function validateProfileEvidenceRaw(
  root: AnchoredRoot,
  directory: FileHandle,
  evidence: readonly ProfileTreeEvidence[],
): Promise<CanonicalProfileTree> {
  const entries: ProfileTreeEntryV1[] = [];
  let total = 0;
  let maxMtimeMs = 0;
  for (const expected of evidence) {
    if (expected.path === "") {
      const current = await call(
        root.admission,
        "profile-evidence-root-stat",
        () => directory.stat({ bigint: true }),
      );
      if (
        expected.type !== "directory" ||
        !sameLeafIdentity(expected.stat, current)
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "profile root changed after hashing",
        );
      }
      maxMtimeMs = Math.max(maxMtimeMs, Number(current.mtimeNs) / 1_000_000);
      entries.push({
        path: "",
        type: "directory",
        mode: lowModeBigint(current.mode),
        size: 0,
        sha256: null,
      });
      continue;
    }
    const opened = await openRawProfileParent(root, directory, expected.path);
    let held: FileHandle | undefined;
    try {
      const current = await call(root.admission, "profile-evidence-lstat", () =>
        fs.lstat(procPath(opened.parent, opened.leaf), { bigint: true }),
      );
      if (!sameLeafIdentity(expected.stat, current)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "profile descendant changed after hashing",
        );
      }
      if (expected.type === "directory") {
        held = await callOpen(
          root.admission,
          "profile-evidence-open-directory",
          () =>
            fs.open(
              procPath(opened.parent, opened.leaf),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            ),
        );
        const heldStat = await call(
          root.admission,
          "profile-evidence-directory-stat",
          () => held!.stat({ bigint: true }),
        );
        if (!sameLeafIdentity(current, heldStat)) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "profile directory binding changed after hashing",
          );
        }
        maxMtimeMs = Math.max(maxMtimeMs, Number(heldStat.mtimeNs) / 1_000_000);
        entries.push({
          path: expected.path,
          type: "directory",
          mode: lowModeBigint(heldStat.mode),
          size: 0,
          sha256: null,
        });
      } else {
        held = await callOpen(
          root.admission,
          "profile-evidence-open-file",
          () =>
            fs.open(
              procPath(opened.parent, opened.leaf),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            ),
        );
        const hashed = await reconciliationPrivateHeldFileHash(
          held,
          current,
          (chunk, offset) =>
            call(root.admission, "profile-evidence-read", () =>
              held!.read(chunk, 0, chunk.length, offset),
            ),
          () =>
            call(root.admission, "profile-evidence-file-stat", () =>
              held!.stat({ bigint: true }),
            ),
        );
        const heldStat = hashed.stat;
        const contentSha256 = hashed.contentSha256;
        const size = Number(heldStat.size);
        if (contentSha256 !== expected.sha256) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "profile file changed after hashing",
          );
        }
        total += size;
        if (total > PROFILE_TOTAL_MAX_BYTES) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "profile tree is too large",
          );
        }
        maxMtimeMs = Math.max(maxMtimeMs, Number(heldStat.mtimeNs) / 1_000_000);
        entries.push({
          path: expected.path,
          type: "file",
          mode: lowModeBigint(heldStat.mode),
          size,
          sha256: contentSha256,
        });
      }
    } finally {
      await closeAllDirect([
        ...(held === undefined ? [] : [held]),
        ...opened.owned,
      ]);
    }
  }
  const finalRoot = await call(
    root.admission,
    "profile-evidence-final-stat",
    () => directory.stat({ bigint: true }),
  );
  const rootEvidence = evidence.find((entry) => entry.path === "");
  if (
    rootEvidence === undefined ||
    !sameLeafIdentity(rootEvidence.stat, finalRoot)
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "profile root changed after hashing",
    );
  }
  entries.sort((left, right) => rawCompare(left.path, right.path));
  const canonicalJson = JSON.stringify({ version: 1, entries });
  return {
    canonicalJson,
    checksum: sha256(canonicalJson),
    byteSize: total,
    maxMtimeMs,
  };
}

export async function canonicalizeProfileTree(
  canonicalRoot: string,
  generationPath: string,
  admission: ReconciliationExecutionAdmission,
): Promise<CanonicalProfileTree> {
  const root = await openAnchoredRoot(canonicalRoot, admission);
  try {
    return await hashProfileTree(
      root,
      generationPath,
      new Budget(MAX_RECONCILIATION_REFERENCES),
    );
  } finally {
    await root.close();
  }
}

function checkpointIdentity(file: {
  bytes: Buffer;
  mode: number;
  size: number;
}): string {
  return sha256(
    JSON.stringify({
      type: "replay_checkpoint",
      mode: file.mode,
      size: file.size,
      contentSha256: sha256(file.bytes),
    }),
  );
}

function assertCheckpointPath(relative: string): void {
  const segments = relative.split("/");
  if (
    segments.length !== 4 ||
    segments[0] !== "replay" ||
    !SAFE_OWNER.test(segments[1] ?? "") ||
    !SAFE_OWNER.test(segments[2] ?? "") ||
    !UUID_FILE.test(segments[3] ?? "")
  ) {
    throw err("reconciliation_filesystem_unsafe", "checkpoint path is unsafe");
  }
}

function assertProfilePath(relative: string): void {
  const segments = relative.split("/");
  if (
    segments.length !== 4 ||
    segments[0] !== "profiles" ||
    !UUID.test(segments[1] ?? "") ||
    !PROFILE_STATES.has(segments[2] ?? "") ||
    !UUID.test(segments[3] ?? "")
  ) {
    throw err("reconciliation_filesystem_unsafe", "profile path is unsafe");
  }
}

export function canonicalizeReconciliationSnapshot(
  references: readonly ReconciliationReferenceV1[],
): { canonicalJson: string; snapshotDigest: string } {
  const ordered = references
    .map((reference) => ({
      kind: reference.kind,
      id: reference.id,
      path: reference.path,
      checksum: reference.checksum,
    }))
    .sort(
      (left, right) =>
        rawCompare(left.kind, right.kind) ||
        rawCompare(left.id, right.id) ||
        rawCompare(left.path, right.path),
    );
  const result = JSON.stringify({ version: 1, references: ordered });
  return { canonicalJson: result, snapshotDigest: sha256(result) };
}

async function validateAuthorities(
  root: AnchoredRoot,
  references: readonly ReconciliationReferenceV1[],
  budget: Budget,
  rootRecord?: RootCapabilityRecord,
): Promise<Set<string>> {
  const sealedByPath = new Map<string, GenerationCapabilityRecord>();
  if (rootRecord !== undefined) {
    for (const generation of rootRecord.sealedGenerations.values()) {
      const record = requireGeneration(generation);
      sealedByPath.set(
        `profiles/${record.locator.profileId}/${record.locator.state}/${record.locator.generationId}`,
        record,
      );
    }
  }
  const retained = new Set<string>();
  for (const reference of references) {
    if (
      reference.kind === "replay_checkpoint" ||
      reference.kind === "replay_checkpoint_cleanup_intent"
    ) {
      assertCheckpointPath(reference.path);
      budget.take();
      let file: Awaited<ReturnType<typeof readRegularFile>>;
      try {
        file = await readRegularFile(
          root,
          reference.path,
          CHECKPOINT_MAX_BYTES,
          budget,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          if (reference.kind === "replay_checkpoint_cleanup_intent") {
            continue;
          }
          throw err("reconciliation_reference_missing", "authority is missing");
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.bytes.toString("utf8"));
      } catch {
        throw err("reconciliation_reference_corrupt", "checkpoint is corrupt");
      }
      const state = storageStateV1Schema.safeParse(parsed);
      if (
        !state.success ||
        !Buffer.from(canonicalJson(state.data), "utf8").equals(file.bytes) ||
        sha256(file.bytes) !== reference.checksum
      ) {
        throw err("reconciliation_reference_corrupt", "checkpoint is corrupt");
      }
    } else {
      assertProfilePath(reference.path);
      let tree: CanonicalProfileTree;
      try {
        const sealed = sealedByPath.get(reference.path);
        tree =
          sealed === undefined
            ? await hashProfileTree(root, reference.path, budget)
            : await heldProfileHash(sealed);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw err("reconciliation_reference_missing", "authority is missing");
        }
        throw error;
      }
      if (tree.checksum !== reference.checksum) {
        throw err("reconciliation_reference_corrupt", "profile is corrupt");
      }
    }
    retained.add(reference.path);
  }
  return retained;
}

async function directoryEntriesOptional(
  root: AnchoredRoot,
  relative: string,
  budget: Budget,
  chargeRoot = false,
): Promise<Dirent<string>[]> {
  let handle: FileHandle;
  const reservation = chargeRoot ? budget.reserveNamespaceRoot(relative) : null;
  try {
    handle = await root.openDirectory(relative);
  } catch (error) {
    reservation?.rollback();
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  try {
    reservation?.commit();
    return await root.readdir(handle, budget);
  } finally {
    await closeRaw(handle, "optional-directory");
  }
}

async function checkpointCandidate(
  root: AnchoredRoot,
  relative: string,
  budget: Budget,
): Promise<Candidate> {
  const file = await readRegularFile(
    root,
    relative,
    CHECKPOINT_MAX_BYTES,
    budget,
  );
  return {
    sourcePath: relative,
    recognizedType: "replay_checkpoint",
    identitySha256: checkpointIdentity(file),
    bytes: file.size,
    maxMtimeMs: file.mtimeMs,
    sourceParent: await identityForDirectory(
      root,
      path.posix.dirname(relative),
      budget,
    ),
  };
}

async function profileCandidate(
  root: AnchoredRoot,
  relative: string,
  budget: Budget,
): Promise<Candidate> {
  const tree = await hashProfileTree(root, relative, budget, false);
  return {
    sourcePath: relative,
    recognizedType: "profile_generation",
    identitySha256: tree.checksum,
    bytes: tree.byteSize,
    maxMtimeMs: tree.maxMtimeMs,
    sourceParent: await identityForDirectory(
      root,
      path.posix.dirname(relative),
      budget,
    ),
  };
}

async function removeHeldDeletionTombstone(
  root: AnchoredRoot,
  stateRelative: string,
  tombstone: string,
  budget: Budget,
): Promise<void> {
  if (!DELETION_TOMBSTONE.test(tombstone)) {
    throw err("reconciliation_filesystem_unsafe", "deletion tombstone is invalid");
  }
  const expectedParent = await identityForDirectory(root, stateRelative, budget);
  const parent = await root.openDirectory(stateRelative);
  let generation: FileHandle | undefined;
  try {
    await assertParent(root, parent, expectedParent);
    generation = await callOpen(root.admission, "tombstone-open", () =>
      fs.open(
        procPath(parent, tombstone),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    );
    const tree = await hashProfileTreeAt(root, generation, budget);
    const generationStat = tree.evidence.find((entry) => entry.path === "")?.stat;
    if (generationStat === undefined) {
      throw err("reconciliation_filesystem_unsafe", "tombstone root is missing");
    }
    const entries = [...tree.evidence]
      .filter((entry) => entry.path !== "")
      .sort((left, right) => {
        const depth = right.path.split("/").length - left.path.split("/").length;
        if (depth !== 0) return depth;
        if (left.type !== right.type) return left.type === "file" ? -1 : 1;
        return rawCompare(left.path, right.path);
      });
    for (const entry of entries) {
      await assertParent(root, parent, expectedParent);
      const opened = await openRawProfileParent(root, generation, entry.path);
      let leafPin: FileHandle | undefined;
      try {
        await revalidateRawProfileParent(
          root,
          generation,
          generationStat,
          opened,
        );
        const rebound = await call(root.admission, "tombstone-entry-lstat", () =>
          fs.lstat(procPath(opened.parent, opened.leaf), { bigint: true }),
        );
        const matches =
          entry.type === "directory"
            ? sameObjectIdentity(entry.stat, rebound)
            : sameLeafIdentity(entry.stat, rebound);
        if (!matches) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "deletion tombstone entry changed",
          );
        }
        const pinned = await pinRemovalLeaf(
          root,
          opened.parent,
          opened.leaf,
        );
        leafPin = pinned.handle;
        await callHeldMutation(root.admission, "tombstone-entry-remove", async () => {
          await assertParent(root, parent, expectedParent);
          await revalidateRawProfileParent(root, generation!, generationStat, opened);
          await revalidateRemovalLeaf(
            root,
            opened.parent,
            opened.leaf,
            pinned.stat,
            pinned.handle,
          );
        }, () =>
          entry.type === "directory"
            ? fs.rmdir(procPath(opened.parent, opened.leaf))
            : fs.unlink(procPath(opened.parent, opened.leaf)),
        async () => {
          await assertParent(root, parent, expectedParent);
          await revalidateRawProfileParent(root, generation!, generationStat, opened);
        },
        );
        await revalidateRawProfileParent(
          root,
          generation,
          generationStat,
          opened,
        );
        await callHeldMutation(root.admission, "tombstone-entry-parent-sync", async () => {
          await assertParent(root, parent, expectedParent);
          await revalidateRawProfileParent(root, generation!, generationStat, opened);
        }, () =>
          opened.parent.sync(),
        );
        await revalidateRawProfileParent(
          root,
          generation,
          generationStat,
          opened,
        );
      } finally {
        await leafPin?.close().catch(() => undefined);
        await closeAllDirect(opened.owned);
      }
    }
    const finalGenerationStat = await call(
      root.admission,
      "tombstone-final-lstat",
      () => fs.lstat(procPath(parent, tombstone), { bigint: true }),
    );
    await assertParent(root, parent, expectedParent);
    await callHeldMutation(root.admission, "tombstone-remove", async () => {
      await assertParent(root, parent, expectedParent);
      await revalidateRemovalLeaf(
        root,
        parent,
        tombstone,
        finalGenerationStat,
        generation!,
      );
    }, () =>
      fs.rmdir(procPath(parent, tombstone)),
    () => assertParent(root, parent, expectedParent),
    );
    await closeRaw(generation, "tombstone-generation");
    generation = undefined;
    await callHeldMutation(root.admission, "tombstone-parent-sync", () =>
      assertParent(root, parent, expectedParent), () => parent.sync());
    await assertParent(root, parent, expectedParent);
  } finally {
    await closeAll([
      [generation, "tombstone-generation-finally"],
      [parent, "tombstone-parent"],
    ]);
  }
}

async function enumerateCandidates(
  root: AnchoredRoot,
  budget: Budget,
  excludedProfilePaths: ReadonlySet<string> = new Set(),
): Promise<{ candidates: Candidate[]; namespaces: Set<string> }> {
  const result: Candidate[] = [];
  const top = await root.readdir(root.handle, budget);
  const namespaces = new Set(top.map((entry) => entry.name));
  for (const entry of top) {
    if (
      ![
        "replay",
        "profiles",
        "quarantine",
        ".profile-publish-staging",
      ].includes(entry.name) ||
      !entry.isDirectory()
    ) {
      throw err("reconciliation_filesystem_unsafe", "unknown root entry");
    }
    budget.markNamespaceRoot(entry.name);
  }

  const replayOwners = namespaces.has("replay")
    ? await directoryEntriesOptional(root, "replay", budget)
    : [];
  for (const owner of replayOwners) {
    if (!owner.isDirectory() || !SAFE_OWNER.test(owner.name)) {
      throw err("reconciliation_filesystem_unsafe", "unknown replay owner");
    }
    for (const scrape of await directoryEntriesOptional(
      root,
      `replay/${owner.name}`,
      budget,
    )) {
      if (!scrape.isDirectory() || !SAFE_OWNER.test(scrape.name)) {
        throw err("reconciliation_filesystem_unsafe", "unknown replay scrape");
      }
      for (const file of await directoryEntriesOptional(
        root,
        `replay/${owner.name}/${scrape.name}`,
        budget,
      )) {
        if (!file.isFile() || !UUID_FILE.test(file.name)) {
          throw err("reconciliation_filesystem_unsafe", "unknown replay entry");
        }
        result.push(
          await checkpointCandidate(
            root,
            `replay/${owner.name}/${scrape.name}/${file.name}`,
            budget,
          ),
        );
      }
    }
  }

  const profiles = namespaces.has("profiles")
    ? await directoryEntriesOptional(root, "profiles", budget)
    : [];
  const namespaceBudget = budget.fresh();
  for (const profile of profiles) {
    if (!profile.isDirectory() || !UUID.test(profile.name)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "unknown profile namespace",
      );
    }
    const states = await directoryEntriesOptional(
      root,
      `profiles/${profile.name}`,
      namespaceBudget,
    );
    const stateNames = new Set(states.map((state) => state.name));
    if (
      states.some(
        (state) => !state.isDirectory() || !PROFILE_STATES.has(state.name),
      ) ||
      [...PROFILE_STATES].some((state) => !stateNames.has(state))
    ) {
      throw err("reconciliation_filesystem_unsafe", "unknown profile state");
    }
    for (const state of states) {
      const generations = await directoryEntriesOptional(
        root,
        `profiles/${profile.name}/${state.name}`,
        namespaceBudget,
      );
      for (const generation of generations) {
        const tombstone =
          state.name === "working" &&
          DELETION_TOMBSTONE.test(generation.name);
        if (
          !generation.isDirectory() ||
          (!UUID.test(generation.name) && !tombstone)
        ) {
          throw err("reconciliation_filesystem_unsafe", "unknown generation");
        }
      }
    }
  }
  for (const profile of profiles) {
    if (!profile.isDirectory() || !UUID.test(profile.name)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "unknown profile namespace",
      );
    }
    for (const state of await directoryEntriesOptional(
      root,
      `profiles/${profile.name}`,
      budget,
    )) {
      if (!state.isDirectory() || !PROFILE_STATES.has(state.name)) {
        throw err("reconciliation_filesystem_unsafe", "unknown profile state");
      }
      for (const generation of await directoryEntriesOptional(
        root,
        `profiles/${profile.name}/${state.name}`,
        budget,
      )) {
        if (
          state.name === "working" &&
          generation.isDirectory() &&
          DELETION_TOMBSTONE.test(generation.name)
        ) {
          await removeHeldDeletionTombstone(
            root,
            `profiles/${profile.name}/working`,
            generation.name,
            budget,
          );
          continue;
        }
        if (!generation.isDirectory() || !UUID.test(generation.name)) {
          throw err("reconciliation_filesystem_unsafe", "unknown generation");
        }
        const generationPath =
          `profiles/${profile.name}/${state.name}/${generation.name}`;
        if (excludedProfilePaths.has(generationPath)) continue;
        result.push(
          await profileCandidate(
            root,
            generationPath,
            budget,
          ),
        );
      }
      if (state.name === "working") {
        const workingState = await root.openDirectory(
          `profiles/${profile.name}/working`,
        );
        try {
          await call(root.admission, "tombstone-inventory-parent-sync", () =>
            workingState.sync(),
          );
        } finally {
          await closeRaw(workingState, "tombstone-inventory-parent");
        }
      }
    }
  }
  return { candidates: result, namespaces };
}

function encodeParent(value: ParentIdentityV1): ParentIdentityV1 {
  return { path: value.path, dev: value.dev, ino: value.ino, mode: value.mode };
}

function encodePlan(plan: ReconciliationPlanV1): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: plan.version,
      processNonce: plan.processNonce,
      controlGenerationNonce: plan.controlGenerationNonce,
      snapshotDigest: plan.snapshotDigest,
      retained: plan.retained,
      removed: plan.removed,
      entries: plan.entries.map((entry) => ({
        sourcePath: entry.sourcePath,
        destinationPath: entry.destinationPath,
        recognizedType: entry.recognizedType,
        identitySha256: entry.identitySha256,
        bytes: entry.bytes,
        sourceParent: encodeParent(entry.sourceParent),
        destinationParent: encodeParent(entry.destinationParent),
        phaseModel: 1,
      })),
    }),
    "utf8",
  );
}

function canonicalUnsigned(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function parseParent(value: unknown): ParentIdentityV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw err("reconciliation_filesystem_unsafe", "manifest parent is invalid");
  }
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).join(",") !== "path,dev,ino,mode" ||
    typeof item.path !== "string" ||
    !canonicalUnsigned(item.dev) ||
    !canonicalUnsigned(item.ino) ||
    !Number.isSafeInteger(item.mode) ||
    (item.mode as number) < 0 ||
    (item.mode as number) > 0o777
  ) {
    throw err("reconciliation_filesystem_unsafe", "manifest parent is invalid");
  }
  validateRelativePath(item.path);
  return {
    path: item.path,
    dev: item.dev,
    ino: item.ino,
    mode: item.mode as number,
  };
}

function parsePlan(bytes: Buffer): ReconciliationPlanV1 {
  if (bytes.byteLength > MANIFEST_MAX_BYTES) {
    throw err("reconciliation_filesystem_unsafe", "manifest is too large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw err("reconciliation_filesystem_unsafe", "manifest is invalid");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw err("reconciliation_filesystem_unsafe", "manifest is invalid");
  }
  const object = raw as Record<string, unknown>;
  if (
    Object.keys(object).join(",") !==
      "version,processNonce,controlGenerationNonce,snapshotDigest,retained,removed,entries" ||
    object.version !== 1 ||
    !tokenSchema.safeParse(object.processNonce).success ||
    !tokenSchema.safeParse(object.controlGenerationNonce).success ||
    typeof object.snapshotDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(object.snapshotDigest) ||
    !Number.isSafeInteger(object.retained) ||
    (object.retained as number) < 0 ||
    (object.retained as number) > MAX_RECONCILIATION_REFERENCES ||
    !Number.isSafeInteger(object.removed) ||
    (object.removed as number) < 0 ||
    (object.removed as number) > MAX_RECONCILIATION_REFERENCES ||
    !Array.isArray(object.entries) ||
    (object.removed as number) < object.entries.length ||
    object.entries.length > MAX_RECONCILIATION_REFERENCES
  ) {
    throw err("reconciliation_filesystem_unsafe", "manifest is invalid");
  }
  const entries: ReconciliationPlanEntryV1[] = object.entries.map(
    (rawEntry) => {
      if (
        rawEntry === null ||
        typeof rawEntry !== "object" ||
        Array.isArray(rawEntry)
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "manifest entry is invalid",
        );
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        Object.keys(entry).join(",") !==
          "sourcePath,destinationPath,recognizedType,identitySha256,bytes,sourceParent,destinationParent,phaseModel" ||
        typeof entry.sourcePath !== "string" ||
        typeof entry.destinationPath !== "string" ||
        !["replay_checkpoint", "profile_generation"].includes(
          entry.recognizedType as string,
        ) ||
        typeof entry.identitySha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.identitySha256) ||
        !Number.isSafeInteger(entry.bytes) ||
        (entry.bytes as number) < 0 ||
        entry.phaseModel !== 1
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "manifest entry is invalid",
        );
      }
      validateRelativePath(entry.sourcePath);
      validateRelativePath(entry.destinationPath);
      return {
        sourcePath: entry.sourcePath,
        destinationPath: entry.destinationPath,
        recognizedType:
          entry.recognizedType as ReconciliationPlanEntryV1["recognizedType"],
        identitySha256: entry.identitySha256,
        bytes: entry.bytes as number,
        sourceParent: parseParent(entry.sourceParent),
        destinationParent: parseParent(entry.destinationParent),
        phaseModel: 1,
      };
    },
  );
  const plan: ReconciliationPlanV1 = {
    version: 1,
    processNonce: object.processNonce as string,
    controlGenerationNonce: object.controlGenerationNonce as string,
    snapshotDigest: object.snapshotDigest,
    retained: object.retained as number,
    removed: object.removed as number,
    entries,
  };
  if (!encodePlan(plan).equals(bytes)) {
    throw err("reconciliation_filesystem_unsafe", "manifest is not canonical");
  }
  for (let index = 1; index < entries.length; index += 1) {
    const left = entries[index - 1]!;
    const right = entries[index]!;
    if (
      rawCompare(left.sourcePath, right.sourcePath) > 0 ||
      (left.sourcePath === right.sourcePath &&
        rawCompare(left.destinationPath, right.destinationPath) >= 0)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "manifest order is invalid",
      );
    }
  }
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const entry of entries) {
    if (
      sources.has(entry.sourcePath) ||
      destinations.has(entry.destinationPath)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "manifest paths are duplicated",
      );
    }
    sources.add(entry.sourcePath);
    destinations.add(entry.destinationPath);
  }
  return plan;
}

function encodeCompletion(completion: CompletionV1): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      manifestSha256: completion.manifestSha256,
      retained: completion.retained,
      removed: completion.removed,
    }),
    "utf8",
  );
}

function parseCompletionSyntax(bytes: Buffer): CompletionV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw err("reconciliation_filesystem_unsafe", "completion is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw err("reconciliation_filesystem_unsafe", "completion is invalid");
  }
  const item = value as Record<string, unknown>;
  const result: CompletionV1 = {
    version: 1,
    manifestSha256:
      typeof item.manifestSha256 === "string" ? item.manifestSha256 : "",
    retained: typeof item.retained === "number" ? item.retained : -1,
    removed: typeof item.removed === "number" ? item.removed : -1,
  };
  if (
    Object.keys(item).join(",") !== "version,manifestSha256,retained,removed" ||
    item.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(result.manifestSha256) ||
    !Number.isSafeInteger(result.retained) ||
    result.retained < 0 ||
    result.retained > MAX_RECONCILIATION_REFERENCES ||
    !Number.isSafeInteger(result.removed) ||
    result.removed < 0 ||
    result.removed > MAX_RECONCILIATION_REFERENCES ||
    !encodeCompletion(result).equals(bytes)
  ) {
    throw err("reconciliation_filesystem_unsafe", "completion is invalid");
  }
  return result;
}

function parseCompletion(
  bytes: Buffer,
  manifestSha256: string,
  plan: ReconciliationPlanV1,
): CompletionV1 {
  const result = parseCompletionSyntax(bytes);
  if (
    result.manifestSha256 !== manifestSha256 ||
    result.retained !== plan.retained ||
    result.removed !== plan.removed
  ) {
    throw err("reconciliation_filesystem_unsafe", "completion is invalid");
  }
  return result;
}

async function readAnchoredFile(
  root: AnchoredRoot,
  relative: string,
  maximum: number,
  budget: Budget,
): Promise<Buffer | null> {
  try {
    const file = await readRegularFile(root, relative, maximum, budget);
    if (file.mode !== 0o600) {
      throw err("reconciliation_filesystem_unsafe", "record mode is invalid");
    }
    return file.bytes;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

type BeforeRenameValidation = {
  finalizeAndRename(
    tempPin: PinnedLeaf,
    expectedBytes: Buffer,
    renameRaw: () => Promise<void>,
  ): Promise<void>;
  release(): Promise<void>;
};

async function publishTemp(
  root: AnchoredRoot,
  directoryPath: string,
  tempName: string,
  finalName: string,
  bytes: Buffer,
  validateBeforeRename?: (
    targetDirectory: FileHandle,
  ) => Promise<BeforeRenameValidation>,
): Promise<void> {
  const parent = await root.openDirectory(path.posix.dirname(directoryPath));
  let directory: FileHandle | undefined;
  let file: FileHandle | undefined;
  try {
    directory = await root.openDirectory(directoryPath);
    const targetDirectory = directory;
    const existingTemp = await root.lstatOptional(targetDirectory, tempName);
    const existingFinal = await root.lstatOptional(targetDirectory, finalName);
    if (existingFinal !== null) {
      const existing = await readRegularFileAt(
        root,
        targetDirectory,
        finalName,
        MANIFEST_MAX_BYTES,
      );
      if (existing.mode !== 0o600 || !existing.bytes.equals(bytes)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "published record changed",
        );
      }
      await call(root.admission, `repair-${finalName}-directory`, () =>
        targetDirectory.sync(),
      );
      await call(root.admission, `repair-${finalName}-parent`, () =>
        parent.sync(),
      );
      return;
    }
    if (existingTemp === null) {
      file = await callOpen(root.admission, `create-${tempName}`, () =>
        fs.open(
          procPath(targetDirectory, tempName),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        ),
      );
      await call(root.admission, `write-${tempName}`, () =>
        file!.writeFile(bytes),
      );
      await call(root.admission, `fsync-${tempName}`, () => file!.sync());
      await closeRaw(file, tempName);
      file = undefined;
    } else {
      const existing = await readRegularFileAt(
        root,
        targetDirectory,
        tempName,
        MANIFEST_MAX_BYTES,
      );
      if (existing.mode !== 0o600 || !existing.bytes.equals(bytes)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "temporary record changed",
        );
      }
      file = await callOpen(root.admission, `open-${tempName}`, () =>
        fs.open(
          procPath(targetDirectory, tempName),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        ),
      );
      await call(root.admission, `fsync-${tempName}`, () => file!.sync());
      await closeRaw(file, `recovered-${tempName}`);
      file = undefined;
    }
    await call(root.admission, `rename-${tempName}`, async () => {
      const temp = await readRegularFileAt(
        root,
        targetDirectory,
        tempName,
        MANIFEST_MAX_BYTES,
      );
      if (temp.mode !== 0o600 || !temp.bytes.equals(bytes)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "temporary record changed before promotion",
        );
      }
      const tempPin = await pinLeaf(root, targetDirectory, tempName);
      let validation: BeforeRenameValidation | undefined;
      try {
        if (!sameLeafIdentity(temp.stat, tempPin.stat)) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "temporary record binding changed before promotion",
          );
        }
        validation = await validateBeforeRename?.(targetDirectory);
        await assertRawPinnedLeaf(root, targetDirectory, tempName, tempPin);
        const renameRaw = (): Promise<void> =>
          fs.rename(
            procPath(targetDirectory, tempName),
            procPath(targetDirectory, finalName),
          );
        if (validation === undefined) {
          assertAdmitted(root.admission);
          await renameRaw();
        } else {
          await validation.finalizeAndRename(tempPin, bytes, renameRaw);
        }
      } finally {
        const cleanup = await Promise.allSettled([
          closeAll([[tempPin.handle, `promotion-${tempName}`]]),
          validation?.release() ?? Promise.resolve(),
        ]);
        const failures = cleanup
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "promotion cleanup failed");
        }
      }
    });
    await call(root.admission, `fsync-${finalName}-directory`, () =>
      targetDirectory.sync(),
    );
    await call(root.admission, `fsync-${finalName}-parent`, () =>
      parent.sync(),
    );
  } finally {
    await closeAll([
      [file, `failed-${tempName}`],
      [directory, `${finalName}-directory`],
      [parent, `${finalName}-parent`],
    ]);
  }
}

async function prepareCompletedPromotion(
  root: AnchoredRoot,
  manifest: LoadedManifest,
  targetDirectory: FileHandle,
): Promise<BeforeRenameValidation> {
  const handles: Array<readonly [FileHandle, string]> = [];
  try {
    const directoryBinding = await captureParentBinding(
      root,
      `${manifest.directoryPath}/complete.tmp`,
      targetDirectory,
    );
    handles.push([directoryBinding.holder, "promotion-directory-holder"]);
    const planParent = await root.openDirectory(manifest.directoryPath);
    handles.push([planParent, "promotion-plan-parent"]);
    const targetStat = await admittedFilesystemCall(root.admission, () =>
      targetDirectory.stat({ bigint: true }),
    );
    const planParentStat = await admittedFilesystemCall(root.admission, () =>
      planParent.stat({ bigint: true }),
    );
    if (!sameLeafIdentity(targetStat, planParentStat)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "promotion directory binding changed",
      );
    }
    const plan = await readRegularFileAt(
      root,
      planParent,
      "plan.json",
      MANIFEST_MAX_BYTES,
    );
    if (plan.mode !== 0o600 || !plan.bytes.equals(manifest.bytes)) {
      throw err("reconciliation_filesystem_unsafe", "promotion plan changed");
    }
    const planPin = await pinLeaf(root, planParent, "plan.json");
    handles.push([planPin.handle, "promotion-plan"]);
    if (!sameLeafIdentity(plan.stat, planPin.stat)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "promotion plan binding changed",
      );
    }

    for (const entry of manifest.plan.entries) {
      await call(root.admission, "promotion-entry-validation", async () => {
        let source: FileHandle | undefined;
        let destination: FileHandle | undefined;
        try {
          try {
            source = await root.openDirectory(entry.sourceParent.path);
          } catch (error) {
            if (
              isNodeError(error) &&
              (error.code === "ENOENT" ||
                error.code === "ENOTDIR" ||
                error.code === "ELOOP")
            ) {
              throw err(
                "reconciliation_filesystem_unsafe",
                "canonical source parent changed before promotion",
              );
            }
            throw error;
          }
          await assertRawParent(root, source, entry.sourceParent);
          await assertAdmittedAbsent(
            root,
            source,
            path.posix.basename(entry.sourcePath),
          );
          destination = await root.openDirectory(entry.destinationParent.path);
          await assertRawParent(root, destination, entry.destinationParent);
          await assertAdmittedAbsent(
            root,
            destination,
            path.posix.basename(entry.destinationPath),
          );
        } finally {
          await closeAll([
            [destination, "promotion-destination-parent"],
            [source, "promotion-source-parent"],
          ]);
        }
      });
    }

    await assertRawParentBinding(root, directoryBinding);
    await assertRawPinnedLeaf(root, planParent, "plan.json", planPin);
    return {
      finalizeAndRename: (tempPin, expectedBytes, renameRaw) =>
        finalizeCompletedPromotion(
          root,
          manifest,
          targetDirectory,
          directoryBinding,
          planParent,
          planPin,
          tempPin,
          expectedBytes,
          renameRaw,
        ),
      release: () => closeAll(handles),
    };
  } catch (error) {
    await closeAll(handles);
    throw error;
  }
}

async function openCompletedPromotionParentInternal(
  root: AnchoredRoot,
  expected: ParentIdentityV1,
): Promise<FileHandle> {
  try {
    return await openDirectoryInternal(root, expected.path);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" ||
        error.code === "ENOTDIR" ||
        error.code === "ELOOP")
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "canonical promotion parent changed",
      );
    }
    throw error;
  }
}

async function lstatPinnedEntryInternal(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
): Promise<BigIntStats> {
  try {
    return await admittedFilesystemCall(root.admission, () =>
      fs.lstat(procPath(parent, leaf), { bigint: true }),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw err(
        "reconciliation_filesystem_unsafe",
        "promotion anchor disappeared",
      );
    }
    throw error;
  }
}

async function readExactPinnedBytesInternal(
  root: AnchoredRoot,
  handle: FileHandle,
  expectedLength: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedLength + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await admittedFilesystemCall(root.admission, () =>
      handle.read(buffer, offset, buffer.length - offset, offset),
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== expectedLength) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "promotion anchor size changed",
    );
  }
  return buffer.subarray(0, offset);
}

async function validatePinnedBytesInternal(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
  pin: PinnedLeaf,
  expectedBytes: Buffer,
): Promise<Buffer> {
  const heldBefore = await admittedFilesystemCall(root.admission, () =>
    pin.handle.stat({ bigint: true }),
  );
  const entryBefore = await lstatPinnedEntryInternal(root, parent, leaf);
  if (
    !sameLeafIdentity(pin.stat, heldBefore) ||
    !sameLeafIdentity(heldBefore, entryBefore)
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "promotion anchor binding changed",
    );
  }
  const bytes = await readExactPinnedBytesInternal(
    root,
    pin.handle,
    expectedBytes.length,
  );
  const heldAfter = await admittedFilesystemCall(root.admission, () =>
    pin.handle.stat({ bigint: true }),
  );
  const entryAfter = await lstatPinnedEntryInternal(root, parent, leaf);
  if (
    !sameLeafIdentity(pin.stat, heldAfter) ||
    !sameLeafIdentity(heldBefore, heldAfter) ||
    !sameLeafIdentity(heldAfter, entryAfter) ||
    !bytes.equals(expectedBytes)
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "promotion anchor content changed",
    );
  }
  return bytes;
}

async function finalizeCompletedPromotion(
  root: AnchoredRoot,
  manifest: LoadedManifest,
  targetDirectory: FileHandle,
  directoryBinding: HeldParentBinding,
  planParent: FileHandle,
  planPin: PinnedLeaf,
  tempPin: PinnedLeaf,
  expectedMarkerBytes: Buffer,
  renameRaw: () => Promise<void>,
): Promise<void> {
  await filesystemTestContext.getStore()?.beforeFinalPromotionAnchors?.();
  const retainedEntryHandles: FileHandle[] = [];
  for (let index = 0; index < manifest.plan.entries.length; index += 1) {
    const entry = manifest.plan.entries[index]!;
    let source: FileHandle | undefined;
    let destination: FileHandle | undefined;
    try {
      source = await openCompletedPromotionParentInternal(
        root,
        entry.sourceParent,
      );
      await assertRawParent(root, source, entry.sourceParent);
      await assertAdmittedAbsent(
        root,
        source,
        path.posix.basename(entry.sourcePath),
      );
      destination = await openCompletedPromotionParentInternal(
        root,
        entry.destinationParent,
      );
      await assertRawParent(root, destination, entry.destinationParent);
      await assertAdmittedAbsent(
        root,
        destination,
        path.posix.basename(entry.destinationPath),
      );
    } catch (error) {
      await closeAllDirect(
        [destination, source].filter(
          (handle): handle is FileHandle => handle !== undefined,
        ),
      );
      throw error;
    }
    if (index === manifest.plan.entries.length - 1) {
      retainedEntryHandles.push(destination, source);
      break;
    }
    await closeAllDirect([destination, source]);
  }
  let canonicalDirectory: FileHandle | undefined;
  let bindingCurrent: FileHandle | undefined;
  try {
    canonicalDirectory = await openDirectoryInternal(
      root,
      manifest.directoryPath,
    );
    bindingCurrent = await openInternal(root.admission, () =>
      fs.open(
        procPath(directoryBinding.holder, directoryBinding.leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    );
    const targetDirectoryStat = await admittedFilesystemCall(
      root.admission,
      () => targetDirectory.stat({ bigint: true }),
    );
    const planParentStat = await admittedFilesystemCall(root.admission, () =>
      planParent.stat({ bigint: true }),
    );
    const canonicalDirectoryStat = await admittedFilesystemCall(
      root.admission,
      () => canonicalDirectory!.stat({ bigint: true }),
    );
    const bindingCurrentStat = await admittedFilesystemCall(
      root.admission,
      () => bindingCurrent!.stat({ bigint: true }),
    );
    if (
      !targetDirectoryStat.isDirectory() ||
      !sameLeafIdentity(directoryBinding.stat, targetDirectoryStat) ||
      !sameLeafIdentity(targetDirectoryStat, planParentStat) ||
      !sameLeafIdentity(targetDirectoryStat, canonicalDirectoryStat) ||
      !sameLeafIdentity(targetDirectoryStat, bindingCurrentStat)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "promotion directory binding changed",
      );
    }
    const planBytes = await validatePinnedBytesInternal(
      root,
      planParent,
      "plan.json",
      planPin,
      manifest.bytes,
    );
    const planHash = sha256(planBytes);
    if (planHash !== manifest.checksum) {
      throw err("reconciliation_filesystem_unsafe", "promotion plan changed");
    }

    const markerHeldBefore = await admittedFilesystemCall(root.admission, () =>
      tempPin.handle.stat({ bigint: true }),
    );
    const markerEntryBefore = await lstatPinnedEntryInternal(
      root,
      targetDirectory,
      "complete.tmp",
    );
    if (
      !sameLeafIdentity(tempPin.stat, markerHeldBefore) ||
      !sameLeafIdentity(markerHeldBefore, markerEntryBefore)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "completion marker binding changed",
      );
    }
    const markerBytes = await readExactPinnedBytesInternal(
      root,
      tempPin.handle,
      expectedMarkerBytes.length,
    );
    const markerHeldAfter = await admittedFilesystemCall(root.admission, () =>
      tempPin.handle.stat({ bigint: true }),
    );
    const markerEntryAfter = await lstatPinnedEntryInternal(
      root,
      targetDirectory,
      "complete.tmp",
    );
    if (
      !sameLeafIdentity(tempPin.stat, markerHeldAfter) ||
      !sameLeafIdentity(markerHeldBefore, markerHeldAfter) ||
      !sameLeafIdentity(markerHeldAfter, markerEntryAfter) ||
      !markerBytes.equals(expectedMarkerBytes) ||
      sha256(markerBytes) !== sha256(expectedMarkerBytes)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "completion marker content changed",
      );
    }
    parseCompletion(markerBytes, planHash, manifest.plan);
    assertAdmitted(root.admission);
    await renameRaw();
  } finally {
    await closeAllDirect(
      [bindingCurrent, canonicalDirectory, ...retainedEntryHandles].filter(
        (handle): handle is FileHandle => handle !== undefined,
      ),
    );
  }
}

async function loadManifestAt(
  root: AnchoredRoot,
  processNonce: string,
  generationNonce: string,
  digest: string,
  budget: Budget,
): Promise<LoadedPlanRecord> {
  const directoryPath = `quarantine/${processNonce}/${generationNonce}/.plans/${digest}`;
  const entries = await directoryEntriesOptional(root, directoryPath, budget);
  if (entries.length === 0) {
    return {
      kind: "empty",
      value: {
        processNonce,
        controlGenerationNonce: generationNonce,
        snapshotDigest: digest,
        directoryPath,
      },
    };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !PLAN_FILES.has(entry.name)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "plan directory is invalid",
      );
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  if (
    (names.has("plan.tmp") && names.has("plan.json")) ||
    (names.has("complete.tmp") && names.has("complete")) ||
    (names.has("plan.tmp") &&
      (names.has("complete.tmp") || names.has("complete")))
  ) {
    throw err("reconciliation_filesystem_unsafe", "plan state is ambiguous");
  }
  const publishedPlanBytes =
    (await readAnchoredFile(
      root,
      `${directoryPath}/plan.json`,
      MANIFEST_MAX_BYTES,
      budget,
    )) ??
    (await readAnchoredFile(
      root,
      `${directoryPath}/plan.tmp`,
      MANIFEST_MAX_BYTES,
      budget,
    ));
  const planBytes = publishedPlanBytes;
  if (planBytes === null) {
    if (names.size !== 1 || !names.has("complete")) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "plan directory has no manifest",
      );
    }
    const completionBytes = await readAnchoredFile(
      root,
      `${directoryPath}/complete`,
      4 * 1024,
      budget,
    );
    if (completionBytes === null) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "completion record disappeared",
      );
    }
    return {
      kind: "completion-only",
      value: {
        processNonce,
        controlGenerationNonce: generationNonce,
        snapshotDigest: digest,
        directoryPath,
        completion: parseCompletionSyntax(completionBytes),
      },
    };
  }
  const plan = parsePlan(planBytes);
  if (
    plan.processNonce !== processNonce ||
    plan.controlGenerationNonce !== generationNonce ||
    plan.snapshotDigest !== digest
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "manifest namespace mismatch",
    );
  }
  for (const entry of plan.entries) {
    if (entry.recognizedType === "replay_checkpoint") {
      assertCheckpointPath(entry.sourcePath);
    } else {
      assertProfilePath(entry.sourcePath);
    }
    const expectedDestination = `quarantine/${processNonce}/${generationNonce}/${entry.sourcePath}`;
    if (
      entry.destinationPath !== expectedDestination ||
      entry.sourceParent.path !== path.posix.dirname(entry.sourcePath) ||
      entry.destinationParent.path !== path.posix.dirname(entry.destinationPath)
    ) {
      throw err("reconciliation_filesystem_unsafe", "manifest path is invalid");
    }
  }
  const checksum = sha256(planBytes);
  const finalCompletionBytes = await readAnchoredFile(
    root,
    `${directoryPath}/complete`,
    4 * 1024,
    budget,
  );
  const tempCompletionBytes = await readAnchoredFile(
    root,
    `${directoryPath}/complete.tmp`,
    4 * 1024,
    budget,
  );
  const completionBytes = finalCompletionBytes ?? tempCompletionBytes;
  let completion: CompletionV1 | null = null;
  if (completionBytes !== null) {
    completion = parseCompletion(completionBytes, checksum, plan);
  }
  return {
    kind: "manifest",
    value: {
      processNonce,
      controlGenerationNonce: generationNonce,
      snapshotDigest: digest,
      directoryPath,
      plan,
      bytes: planBytes,
      checksum,
      completion,
      completionStorage:
        finalCompletionBytes !== null
          ? "final"
          : tempCompletionBytes !== null
            ? "temp"
            : null,
    },
  };
}

async function enumerateManifests(
  root: AnchoredRoot,
  budget: Budget,
  quarantinePresent: boolean,
): Promise<LoadedPlanRecord[]> {
  const result: LoadedPlanRecord[] = [];
  if (!quarantinePresent) return result;
  for (const processEntry of await directoryEntriesOptional(
    root,
    "quarantine",
    budget,
    true,
  )) {
    if (
      !processEntry.isDirectory() ||
      !tokenSchema.safeParse(processEntry.name).success
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "quarantine process is invalid",
      );
    }
    for (const generationEntry of await directoryEntriesOptional(
      root,
      `quarantine/${processEntry.name}`,
      budget,
    )) {
      if (
        !generationEntry.isDirectory() ||
        !tokenSchema.safeParse(generationEntry.name).success
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "quarantine generation is invalid",
        );
      }
      const base = `quarantine/${processEntry.name}/${generationEntry.name}`;
      for (const entry of await directoryEntriesOptional(root, base, budget)) {
        if (
          ![".plans", "replay", "profiles"].includes(entry.name) ||
          !entry.isDirectory()
        ) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "quarantine entry is invalid",
          );
        }
      }
      for (const digestEntry of await directoryEntriesOptional(
        root,
        `${base}/.plans`,
        budget,
      )) {
        if (
          !digestEntry.isDirectory() ||
          !/^[a-f0-9]{64}$/u.test(digestEntry.name)
        ) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "plan digest is invalid",
          );
        }
        const loaded = await loadManifestAt(
          root,
          processEntry.name,
          generationEntry.name,
          digestEntry.name,
          budget,
        );
        result.push(loaded);
      }
    }
  }
  return result.sort((left, right) =>
    rawCompare(left.value.directoryPath, right.value.directoryPath),
  );
}

async function repairManifestRecords(
  root: AnchoredRoot,
  manifests: readonly LoadedManifest[],
): Promise<void> {
  for (const manifest of manifests) {
    await publishTemp(
      root,
      manifest.directoryPath,
      "plan.tmp",
      "plan.json",
      manifest.bytes,
    );
    if (manifest.completion !== null) {
      await publishTemp(
        root,
        manifest.directoryPath,
        "complete.tmp",
        "complete",
        encodeCompletion(manifest.completion),
        (targetDirectory) =>
          prepareCompletedPromotion(root, manifest, targetDirectory),
      );
      manifest.completionStorage = "final";
    }
  }
}

async function cleanupEmptyOldPlanSkeletons(
  root: AnchoredRoot,
  request: ReconciliationRequestV1,
  budget: Budget,
): Promise<void> {
  for (const processEntry of await directoryEntriesOptional(
    root,
    "quarantine",
    budget,
    true,
  )) {
    if (
      !processEntry.isDirectory() ||
      !tokenSchema.safeParse(processEntry.name).success
    ) {
      continue;
    }
    for (const generationEntry of await directoryEntriesOptional(
      root,
      `quarantine/${processEntry.name}`,
      budget,
    )) {
      if (
        !generationEntry.isDirectory() ||
        !tokenSchema.safeParse(generationEntry.name).success
      ) {
        continue;
      }
      const generationPath = `quarantine/${processEntry.name}/${generationEntry.name}`;
      const plansPath = `${generationPath}/.plans`;
      let plansHandle: FileHandle | undefined;
      try {
        plansHandle = await root.openDirectory(plansPath);
        await call(
          root.admission,
          "cleanup-plan-digest-repair-parent-fsync",
          () => plansHandle!.sync(),
        );
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      } finally {
        if (plansHandle !== undefined) {
          await closeRaw(plansHandle, "cleanup-plans-repair");
        }
      }
      for (const digestEntry of await directoryEntriesOptional(
        root,
        plansPath,
        budget,
      )) {
        if (
          !digestEntry.isDirectory() ||
          !/^[a-f0-9]{64}$/u.test(digestEntry.name)
        ) {
          continue;
        }
        const isCurrent =
          processEntry.name === request.processNonce &&
          generationEntry.name === request.controlGenerationNonce &&
          digestEntry.name === request.snapshotDigest;
        if (isCurrent) continue;
        const digestPath = `${plansPath}/${digestEntry.name}`;
        if (
          (await directoryEntriesOptional(root, digestPath, budget)).length ===
          0
        ) {
          const digestHandle = await root.openDirectory(digestPath);
          try {
            await call(
              root.admission,
              "cleanup-plan.json-repair-parent-fsync",
              () => digestHandle.sync(),
            );
          } finally {
            await closeRaw(digestHandle, "cleanup-plan-digest-repair");
          }
          await removeEmptyDirectory(
            root,
            digestPath,
            "cleanup-empty-plan-digest",
          );
        }
      }
      if (
        processEntry.name !== request.processNonce ||
        generationEntry.name !== request.controlGenerationNonce
      ) {
        await removeEmptyDirectory(root, plansPath, "cleanup-empty-plans");
        await removeEmptyDirectory(
          root,
          generationPath,
          "cleanup-empty-generation",
        );
      }
    }
    if (processEntry.name !== request.processNonce) {
      await removeEmptyDirectory(
        root,
        `quarantine/${processEntry.name}`,
        "cleanup-empty-process",
      );
    }
  }
}

async function ensurePlanSkeleton(
  root: AnchoredRoot,
  processNonce: string,
  generationNonce: string,
  digest: string,
  candidates: readonly Candidate[],
): Promise<void> {
  const directories = new Set<string>([
    `quarantine/${processNonce}/${generationNonce}/.plans/${digest}`,
  ]);
  for (const candidate of candidates) {
    directories.add(
      path.posix.dirname(
        `quarantine/${processNonce}/${generationNonce}/${candidate.sourcePath}`,
      ),
    );
  }
  for (const directoryPath of [...directories].sort(rawCompare)) {
    const handle = await root.ensureDirectory(directoryPath);
    try {
      await call(root.admission, "fsync-skeleton", () => handle.sync());
    } finally {
      await closeRaw(handle, "skeleton");
    }
  }
}

async function buildCurrentManifest(
  root: AnchoredRoot,
  request: ReconciliationRequestV1,
  retained: number,
  removed: number,
  candidates: readonly Candidate[],
  budget: Budget,
): Promise<LoadedManifest> {
  await ensurePlanSkeleton(
    root,
    request.processNonce,
    request.controlGenerationNonce,
    request.snapshotDigest,
    candidates,
  );
  const entries: ReconciliationPlanEntryV1[] = [];
  for (const candidate of candidates) {
    const destinationPath =
      `quarantine/${request.processNonce}/${request.controlGenerationNonce}/` +
      candidate.sourcePath;
    const destinationParentPath = path.posix.dirname(destinationPath);
    entries.push({
      sourcePath: candidate.sourcePath,
      destinationPath,
      recognizedType: candidate.recognizedType,
      identitySha256: candidate.identitySha256,
      bytes: candidate.bytes,
      sourceParent: candidate.sourceParent,
      destinationParent: await identityForDirectory(
        root,
        destinationParentPath,
        budget,
      ),
      phaseModel: 1,
    });
  }
  entries.sort(
    (left, right) =>
      rawCompare(left.sourcePath, right.sourcePath) ||
      rawCompare(left.destinationPath, right.destinationPath),
  );
  const plan: ReconciliationPlanV1 = {
    version: 1,
    processNonce: request.processNonce,
    controlGenerationNonce: request.controlGenerationNonce,
    snapshotDigest: request.snapshotDigest,
    retained,
    removed,
    entries,
  };
  const bytes = encodePlan(plan);
  if (bytes.byteLength > MANIFEST_MAX_BYTES) {
    throw err("reconciliation_snapshot_too_large", "manifest is too large");
  }
  const directoryPath =
    `quarantine/${request.processNonce}/${request.controlGenerationNonce}/` +
    `.plans/${request.snapshotDigest}`;
  await publishTemp(root, directoryPath, "plan.tmp", "plan.json", bytes);
  return {
    processNonce: request.processNonce,
    controlGenerationNonce: request.controlGenerationNonce,
    snapshotDigest: request.snapshotDigest,
    directoryPath,
    plan,
    bytes,
    checksum: sha256(bytes),
    completion: null,
    completionStorage: null,
  };
}

async function identityAtParent(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
  recognizedType: ReconciliationPlanEntryV1["recognizedType"],
  budget: Budget,
  retainProfilePin = false,
): Promise<{
  identitySha256: string;
  bytes: number;
  stat: BigIntStats;
  pin?: PinnedLeaf;
} | null> {
  const reservation = budget.reserve();
  try {
    if (recognizedType === "replay_checkpoint") {
      const file = await readRegularFileAt(
        root,
        parent,
        leaf,
        CHECKPOINT_MAX_BYTES,
      );
      reservation.commit();
      return {
        identitySha256: checkpointIdentity(file),
        bytes: file.size,
        stat: file.stat,
      };
    }
    let directory: FileHandle | undefined;
    try {
      directory = await callOpen(root.admission, "open-profile-identity", () =>
        fs.open(
          procPath(parent, leaf),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
      const before = await call(root.admission, "profile-identity-stat", () =>
        directory!.stat({ bigint: true }),
      );
      const tree = await hashProfileTreeAt(root, directory, budget);
      const after = await call(
        root.admission,
        "profile-identity-stat-after",
        () => directory!.stat({ bigint: true }),
      );
      const bound = await admittedFilesystemCall(root.admission, () =>
        fs.lstat(procPath(parent, leaf), { bigint: true }),
      );
      if (!sameLeafIdentity(before, after) || !sameLeafIdentity(after, bound)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "profile identity binding changed",
        );
      }
      const finalTree = await validateProfileEvidenceRaw(
        root,
        directory,
        tree.evidence,
      );
      const rootEvidence = tree.evidence.find((item) => item.path === "");
      if (
        rootEvidence === undefined ||
        finalTree.checksum !== tree.checksum ||
        finalTree.byteSize !== tree.byteSize
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "profile identity changed after hashing",
        );
      }
      const finalRoot = rootEvidence.stat;
      const pin = retainProfilePin
        ? { handle: directory, stat: finalRoot }
        : undefined;
      if (retainProfilePin) {
        directory = undefined;
      } else {
        await directory.close();
        directory = undefined;
      }
      reservation.commit();
      return {
        identitySha256: finalTree.checksum,
        bytes: finalTree.byteSize,
        stat: finalRoot,
        ...(pin === undefined ? {} : { pin }),
      };
    } finally {
      if (directory !== undefined) {
        await closeRaw(directory, "profile-identity");
      }
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      reservation.rollback();
      return null;
    }
    reservation.commit();
    throw error;
  }
}

async function assertParent(
  root: AnchoredRoot,
  handle: FileHandle,
  expected: ParentIdentityV1,
): Promise<void> {
  await root.revalidate();
  const stat = await call(root.admission, "revalidate-parent", () =>
    handle.stat({ bigint: true }),
  );
  const rebound = await root.openDirectory(expected.path);
  let reboundStat: BigIntStats;
  try {
    reboundStat = await call(root.admission, "revalidate-parent-binding", () =>
      rebound.stat({ bigint: true }),
    );
  } finally {
    await closeRaw(rebound, "revalidate-parent-binding");
  }
  if (
    !stat.isDirectory() ||
    !sameParentIdentity(expected, parentIdentity(expected.path, stat)) ||
    !sameObjectIdentity(stat, reboundStat)
  ) {
    throw err("reconciliation_filesystem_unsafe", "parent identity changed");
  }
}

type PinnedLeaf = {
  handle: FileHandle;
  stat: BigIntStats;
};

async function pinLeaf(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
): Promise<PinnedLeaf> {
  const handle = await callOpen(root.admission, "open-pinned-leaf", () =>
    fs.open(procPath(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW),
  );
  try {
    const stat = await call(root.admission, "stat-pinned-leaf", () =>
      handle.stat({ bigint: true }),
    );
    return { handle, stat };
  } catch (error) {
    await closeRaw(handle, "failed-pinned-leaf");
    throw error;
  }
}

function sameLeafIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory()
  );
}

type HeldParentBinding = {
  holder: FileHandle;
  leaf: string;
  parent: FileHandle;
  stat: BigIntStats;
};

async function captureParentBinding(
  root: AnchoredRoot,
  relative: string,
  parent: FileHandle,
): Promise<HeldParentBinding> {
  const parentPath = path.posix.dirname(relative);
  const opened = await root.openParent(parentPath);
  let currentHandle: FileHandle | undefined;
  try {
    const stat = await call(root.admission, "cleanup-parent-pin-stat", () =>
      parent.stat({ bigint: true }),
    );
    currentHandle = await callOpen(
      root.admission,
      "cleanup-parent-current-open",
      () =>
        fs.open(
          procPath(opened.parent, opened.leaf),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
    );
    const current = await call(
      root.admission,
      "cleanup-parent-current-stat",
      () => currentHandle!.stat({ bigint: true }),
    );
    if (!sameLeafIdentity(stat, current)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "cleanup parent binding changed",
      );
    }
    await closeRaw(currentHandle, "cleanup-parent-current");
    currentHandle = undefined;
    return {
      holder: opened.parent,
      leaf: opened.leaf,
      parent,
      stat,
    };
  } catch (error) {
    await closeAll([
      [currentHandle, "failed-cleanup-parent-current"],
      [opened.parent, "failed-cleanup-parent-holder"],
    ]);
    throw error;
  }
}

async function assertRawParentBinding(
  root: AnchoredRoot,
  binding: HeldParentBinding,
): Promise<void> {
  let currentHandle: FileHandle | undefined;
  try {
    const held = await admittedFilesystemCall(root.admission, () =>
      binding.parent.stat({ bigint: true }),
    );
    currentHandle = await callOpen(
      root.admission,
      "cleanup-parent-revalidate-open",
      () =>
        fs.open(
          procPath(binding.holder, binding.leaf),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
    );
    const current = await admittedFilesystemCall(root.admission, () =>
      currentHandle!.stat({ bigint: true }),
    );
    if (
      !sameLeafIdentity(binding.stat, held) ||
      !sameLeafIdentity(held, current)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "cleanup parent binding changed",
      );
    }
  } finally {
    if (currentHandle !== undefined) await currentHandle.close();
  }
}

async function refreshParentBindingAfterMutation(
  root: AnchoredRoot,
  binding: HeldParentBinding,
): Promise<void> {
  let currentHandle: FileHandle | undefined;
  try {
    const held = await admittedFilesystemCall(root.admission, () =>
      binding.parent.stat({ bigint: true }),
    );
    currentHandle = await callOpen(
      root.admission,
      "cleanup-parent-refresh-open",
      () =>
        fs.open(
          procPath(binding.holder, binding.leaf),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
    );
    const current = await admittedFilesystemCall(root.admission, () =>
      currentHandle!.stat({ bigint: true }),
    );
    if (
      binding.stat.dev !== held.dev ||
      binding.stat.ino !== held.ino ||
      binding.stat.isDirectory() !== held.isDirectory() ||
      !sameLeafIdentity(held, current)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "cleanup parent binding changed",
      );
    }
    binding.stat = held;
  } finally {
    if (currentHandle !== undefined) await currentHandle.close();
  }
}

async function assertAdmittedAbsent(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
): Promise<void> {
  try {
    await admittedFilesystemCall(root.admission, () =>
      fs.lstat(procPath(parent, leaf), { bigint: true }),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw err("reconciliation_filesystem_unsafe", "cleanup leaf reappeared");
}

async function fsyncProvenAbsent(
  root: AnchoredRoot,
  binding: HeldParentBinding,
  parent: FileHandle,
  leaf: string,
  point: string,
): Promise<void> {
  await call(root.admission, point, async () => {
    await assertRawParentBinding(root, binding);
    await assertAdmittedAbsent(root, parent, leaf);
    await admittedFilesystemCall(root.admission, () => parent.sync());
    await assertRawParentBinding(root, binding);
    await assertAdmittedAbsent(root, parent, leaf);
  });
  await assertRawParentBinding(root, binding);
  await assertAdmittedAbsent(root, parent, leaf);
}

async function assertRawParent(
  root: AnchoredRoot,
  handle: FileHandle,
  expected: ParentIdentityV1,
): Promise<void> {
  const stat = await admittedFilesystemCall(root.admission, () =>
    handle.stat({ bigint: true }),
  );
  if (
    !stat.isDirectory() ||
    !sameParentIdentity(expected, parentIdentity(expected.path, stat))
  ) {
    throw err("reconciliation_filesystem_unsafe", "parent identity changed");
  }
}

async function assertRawPinnedLeaf(
  root: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
  pinned: PinnedLeaf,
  allowMetadataChange = false,
): Promise<void> {
  const current = await admittedFilesystemCall(root.admission, () =>
    fs.lstat(procPath(parent, leaf), { bigint: true }),
  );
  const held = await admittedFilesystemCall(root.admission, () =>
    pinned.handle.stat({ bigint: true }),
  );
  if (
    (!allowMetadataChange && !sameLeafIdentity(pinned.stat, held)) ||
    pinned.stat.dev !== held.dev ||
    pinned.stat.ino !== held.ino ||
    pinned.stat.isFile() !== held.isFile() ||
    pinned.stat.isDirectory() !== held.isDirectory() ||
    !sameLeafIdentity(held, current)
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "managed leaf binding changed",
    );
  }
}

async function assertPinnedContent(
  root: AnchoredRoot,
  pinned: PinnedLeaf,
  entry: ReconciliationPlanEntryV1,
  budget: Budget,
): Promise<void> {
  if (entry.recognizedType === "replay_checkpoint") {
    const before = await call(root.admission, "pinned-file-stat-before", () =>
      pinned.handle.stat({ bigint: true }),
    );
    if (
      !sameLeafIdentity(pinned.stat, before) ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(CHECKPOINT_MAX_BYTES)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "pinned checkpoint identity changed",
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, CHECKPOINT_MAX_BYTES + 1 - total),
      );
      const read = await call(root.admission, "read-pinned-file", () =>
        pinned.handle.read(chunk, 0, chunk.length, total),
      );
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > CHECKPOINT_MAX_BYTES) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "pinned checkpoint is too large",
        );
      }
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await call(root.admission, "pinned-file-stat-after", () =>
      pinned.handle.stat({ bigint: true }),
    );
    const file = {
      bytes: Buffer.concat(chunks, total),
      mode: lowModeBigint(after.mode),
      size: total,
    };
    if (
      !sameLeafIdentity(before, after) ||
      BigInt(total) !== after.size ||
      checkpointIdentity(file) !== entry.identitySha256 ||
      total !== entry.bytes
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "pinned checkpoint identity changed",
      );
    }
    return;
  }
  const tree = await hashProfileTreeAt(root, pinned.handle, budget);
  const finalTree = await validateProfileEvidenceRaw(
    root,
    pinned.handle,
    tree.evidence,
  );
  const rootEvidence = tree.evidence.find((item) => item.path === "");
  if (
    rootEvidence === undefined ||
    finalTree.checksum !== tree.checksum ||
    finalTree.byteSize !== tree.byteSize ||
    finalTree.checksum !== entry.identitySha256 ||
    finalTree.byteSize !== entry.bytes
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "pinned profile identity changed",
    );
  }
}

type CompletedSuffixProof = {
  handle: FileHandle;
  parent: FileHandle;
  leaf: string;
  path: string;
  stat: BigIntStats;
  absentLeaves: Set<string>;
};

async function openCompletedAbsentSuffix(
  root: AnchoredRoot,
  entry: ReconciliationPlanEntryV1,
): Promise<CompletedSuffixProof> {
  const destinationSegments = entry.destinationParent.path.split("/");
  if (
    destinationSegments.length < 4 ||
    destinationSegments[0] !== "quarantine"
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "completed destination hierarchy is invalid",
    );
  }
  const generationBase = destinationSegments.slice(0, 3).join("/");
  const suffix = destinationSegments.slice(3);
  let current: FileHandle | undefined;
  let parent: FileHandle | undefined;
  let next: FileHandle | undefined;
  let retired: FileHandle | undefined;
  let currentPath = generationBase;
  try {
    current = await callOpen(
      root.admission,
      "open-completed-cleanup-generation",
      () => root.openDirectory(generationBase),
    );
    parent = await callOpen(
      root.admission,
      "open-completed-cleanup-parent",
      () => root.openDirectory(path.posix.dirname(generationBase)),
    );
    for (let index = 0; index < suffix.length; index += 1) {
      const active = current;
      if (active === undefined || parent === undefined) {
        throw err(
          "reconciliation_cleanup_failed",
          "completed cleanup proof lost ownership",
        );
      }
      const segment = suffix[index]!;
      validateSegment(segment);
      try {
        next = await callOpen(
          root.admission,
          "open-completed-cleanup-suffix",
          () =>
            fs.open(
              procPath(active, segment),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            ),
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          if ((await root.lstatOptional(active, segment)) !== null) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "completed cleanup suffix changed",
            );
          }
          const stat = await call(
            root.admission,
            "completed-cleanup-surviving-stat",
            () => active.stat({ bigint: true }),
          );
          return {
            handle: active,
            parent,
            leaf: path.posix.basename(currentPath),
            path: currentPath,
            stat,
            absentLeaves: new Set([segment]),
          };
        }
        throw error;
      }
      retired = parent;
      parent = active;
      current = next;
      next = undefined;
      currentPath = `${currentPath}/${segment}`;
      await closeRaw(retired, "completed-cleanup-suffix-grandparent");
      retired = undefined;
    }
    throw err(
      "reconciliation_filesystem_unsafe",
      "completed cleanup suffix unexpectedly reappeared",
    );
  } catch (error) {
    await closeAll([
      [next, "failed-completed-cleanup-next"],
      [current, "failed-completed-cleanup-surviving-ancestor"],
      [parent, "failed-completed-cleanup-surviving-parent"],
      [retired, "failed-completed-cleanup-retired-parent"],
    ]);
    throw error;
  }
}

async function validateCompletedAbsentSuffix(
  root: AnchoredRoot,
  entry: ReconciliationPlanEntryV1,
): Promise<void> {
  const proof = await openCompletedAbsentSuffix(root, entry);
  await closeAll([
    [proof.handle, "completed-cleanup-surviving-ancestor"],
    [proof.parent, "completed-cleanup-surviving-parent"],
  ]);
}

async function assertCompletedSuffixProof(
  root: AnchoredRoot,
  proof: CompletedSuffixProof,
  allowMetadataChange = false,
): Promise<void> {
  const held = await admittedFilesystemCall(root.admission, () =>
    proof.handle.stat({ bigint: true }),
  );
  const current = await admittedFilesystemCall(root.admission, () =>
    fs.lstat(procPath(proof.parent, proof.leaf), { bigint: true }),
  );
  if (
    (!allowMetadataChange && !sameLeafIdentity(proof.stat, held)) ||
    proof.stat.dev !== held.dev ||
    proof.stat.ino !== held.ino ||
    proof.stat.isFile() !== held.isFile() ||
    proof.stat.isDirectory() !== held.isDirectory() ||
    !sameLeafIdentity(held, current)
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "completed cleanup suffix binding changed",
    );
  }
  proof.stat = held;
}

async function fsyncCompletedSuffixAbsence(
  root: AnchoredRoot,
  proof: CompletedSuffixProof,
  point: string,
): Promise<void> {
  await call(root.admission, point, async () => {
    await assertCompletedSuffixProof(root, proof);
    for (const absentLeaf of proof.absentLeaves) {
      await assertAdmittedAbsent(root, proof.handle, absentLeaf);
    }
    await admittedFilesystemCall(root.admission, () => proof.handle.sync());
    await assertCompletedSuffixProof(root, proof);
    for (const absentLeaf of proof.absentLeaves) {
      await assertAdmittedAbsent(root, proof.handle, absentLeaf);
    }
  });
  await assertCompletedSuffixProof(root, proof);
  for (const absentLeaf of proof.absentLeaves) {
    await assertAdmittedAbsent(root, proof.handle, absentLeaf);
  }
}

async function removeCompletedSuffixProof(
  root: AnchoredRoot,
  proof: CompletedSuffixProof,
  point: string,
): Promise<void> {
  await call(root.admission, point, async () => {
    await assertCompletedSuffixProof(root, proof);
    for (const absentLeaf of proof.absentLeaves) {
      await assertAdmittedAbsent(root, proof.handle, absentLeaf);
    }
    await admittedFilesystemCall(root.admission, () =>
      fs.rmdir(procPath(proof.parent, proof.leaf)),
    );
  });
  await assertAdmittedAbsent(root, proof.parent, proof.leaf);
  await call(root.admission, `${point}-parent-fsync`, async () => {
    await assertAdmittedAbsent(root, proof.parent, proof.leaf);
    await admittedFilesystemCall(root.admission, () => proof.parent.sync());
    await assertAdmittedAbsent(root, proof.parent, proof.leaf);
  });
  await assertAdmittedAbsent(root, proof.parent, proof.leaf);
}

async function validateManifestPhases(
  root: AnchoredRoot,
  manifests: readonly LoadedManifest[],
  budget: Budget,
): Promise<void> {
  for (const manifest of manifests) {
    const completionPhase = manifest.completion !== null;
    const suffixRecovery = manifest.completionStorage === "final";
    for (const entry of manifest.plan.entries) {
      const sourceLeaf = path.posix.basename(entry.sourcePath);
      const destinationLeaf = path.posix.basename(entry.destinationPath);
      let sourceParent: FileHandle | undefined;
      let destinationParent: FileHandle | undefined;
      try {
        try {
          sourceParent = await root.openDirectory(entry.sourceParent.path);
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            throw err(
              "reconciliation_filesystem_unsafe",
              "manifest source parent disappeared",
            );
          }
          throw error;
        }
        await assertParent(root, sourceParent, entry.sourceParent);
        const sourceStat = await root.lstatOptional(sourceParent, sourceLeaf);
        if (completionPhase && sourceStat !== null) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "completed manifest retains its source",
          );
        }
        try {
          destinationParent = await root.openDirectory(
            entry.destinationParent.path,
          );
        } catch (error) {
          if (suffixRecovery && isNodeError(error) && error.code === "ENOENT") {
            await validateCompletedAbsentSuffix(root, entry);
            continue;
          }
          if (isNodeError(error) && error.code === "ENOENT") {
            throw err(
              "reconciliation_filesystem_unsafe",
              "manifest destination parent disappeared",
            );
          }
          throw error;
        }
        await assertParent(root, destinationParent, entry.destinationParent);
        const destinationStat = await root.lstatOptional(
          destinationParent,
          destinationLeaf,
        );
        if (sourceStat !== null && destinationStat !== null) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "both manifest phases exist",
          );
        }
        if (completionPhase && destinationStat !== null) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "completed manifest retains quarantine bytes",
          );
        }
        if (sourceStat !== null && !completionPhase) {
          const actual = await identityAtParent(
            root,
            sourceParent,
            sourceLeaf,
            entry.recognizedType,
            budget,
          );
          if (
            actual === null ||
            actual.identitySha256 !== entry.identitySha256 ||
            actual.bytes !== entry.bytes
          ) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "source identity changed",
            );
          }
        } else if (destinationStat !== null) {
          const actual = await identityAtParent(
            root,
            destinationParent,
            destinationLeaf,
            entry.recognizedType,
            budget,
          );
          if (
            actual === null ||
            actual.identitySha256 !== entry.identitySha256 ||
            actual.bytes !== entry.bytes
          ) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "destination identity changed",
            );
          }
        }
      } finally {
        await closeAll([
          [destinationParent, "validation-destination-parent"],
          [sourceParent, "validation-source-parent"],
        ]);
      }
    }
  }
}

async function executeManifestEntry(
  root: AnchoredRoot,
  entry: ReconciliationPlanEntryV1,
  budget: Budget,
): Promise<void> {
  const sourceLeaf = path.posix.basename(entry.sourcePath);
  const destinationLeaf = path.posix.basename(entry.destinationPath);
  const sourceParent = await root.openDirectory(entry.sourceParent.path);
  let destinationParent: FileHandle | undefined;
  let sourcePin: PinnedLeaf | undefined;
  let destinationPin: PinnedLeaf | undefined;
  try {
    try {
      destinationParent = await root.openDirectory(
        entry.destinationParent.path,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw err(
          "reconciliation_filesystem_unsafe",
          "cleanup destination parent disappeared",
        );
      }
      throw error;
    }
    if (destinationParent === undefined) {
      throw err(
        "reconciliation_cleanup_failed",
        "cleanup destination parent was not opened",
      );
    }
    const destination = destinationParent;
    await assertParent(root, sourceParent, entry.sourceParent);
    await assertParent(root, destination, entry.destinationParent);
    const sourceStat = await root.lstatOptional(sourceParent, sourceLeaf);
    const destinationStat = await root.lstatOptional(
      destination,
      destinationLeaf,
    );
    if (sourceStat !== null && destinationStat !== null) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "both cleanup phases exist",
      );
    }
    if (sourceStat !== null) {
      const sourceIdentity = await identityAtParent(
        root,
        sourceParent,
        sourceLeaf,
        entry.recognizedType,
        budget,
        true,
      );
      sourcePin = sourceIdentity?.pin;
      if (
        sourceIdentity === null ||
        sourceIdentity.identitySha256 !== entry.identitySha256 ||
        sourceIdentity.bytes !== entry.bytes
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "source identity changed",
        );
      }
      sourcePin ??= await pinLeaf(root, sourceParent, sourceLeaf);
      if (!sameLeafIdentity(sourceIdentity.stat, sourcePin.stat)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "source identity changed before pinning",
        );
      }
      await assertParent(root, sourceParent, entry.sourceParent);
      await assertParent(root, destination, entry.destinationParent);
      await call(root.admission, "rename-candidate", async () => {
        await assertRawParent(root, sourceParent, entry.sourceParent);
        await assertRawParent(root, destination, entry.destinationParent);
        await assertRawPinnedLeaf(root, sourceParent, sourceLeaf, sourcePin!);
        await assertPinnedContent(root, sourcePin!, entry, budget);
        assertAdmitted(root.admission);
        await admittedFilesystemCall(root.admission, () =>
          fs.rename(
            procPath(sourceParent, sourceLeaf),
            procPath(destination, destinationLeaf),
          ),
        );
        await assertRawPinnedLeaf(
          root,
          destination,
          destinationLeaf,
          sourcePin!,
          true,
        );
        if ((await root.lstatOptional(sourceParent, sourceLeaf)) !== null) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "renamed source leaf still exists",
          );
        }
      });
      await call(root.admission, "fsync-source-parent", () =>
        sourceParent.sync(),
      );
      await call(root.admission, "fsync-destination-parent-after-rename", () =>
        destination.sync(),
      );
    } else if (destinationStat !== null) {
      await call(root.admission, "repair-source-parent-fsync", () =>
        sourceParent.sync(),
      );
      await call(root.admission, "repair-destination-parent-fsync", () =>
        destination.sync(),
      );
    } else {
      await call(root.admission, "repair-source-parent-fsync", () =>
        sourceParent.sync(),
      );
      await call(root.admission, "repair-destination-parent-fsync", () =>
        destination.sync(),
      );
      return;
    }

    const destinationIdentity = await identityAtParent(
      root,
      destination,
      destinationLeaf,
      entry.recognizedType,
      budget,
      true,
    );
    destinationPin = destinationIdentity?.pin;
    if (
      destinationIdentity === null ||
      destinationIdentity.identitySha256 !== entry.identitySha256 ||
      destinationIdentity.bytes !== entry.bytes
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "destination identity changed",
      );
    }
    destinationPin ??= await pinLeaf(root, destination, destinationLeaf);
    if (!sameLeafIdentity(destinationIdentity.stat, destinationPin.stat)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "destination identity changed before pinning",
      );
    }
    await assertParent(root, sourceParent, entry.sourceParent);
    await assertParent(root, destination, entry.destinationParent);
    await call(root.admission, "delete-candidate", async () => {
      await assertRawParent(root, sourceParent, entry.sourceParent);
      await assertRawParent(root, destination, entry.destinationParent);
      await assertRawPinnedLeaf(
        root,
        destination,
        destinationLeaf,
        destinationPin!,
      );
      await assertPinnedContent(root, destinationPin!, entry, budget);
      assertAdmitted(root.admission);
      await admittedFilesystemCall(root.admission, () =>
        fs.rm(procPath(destination, destinationLeaf), {
          recursive: entry.recognizedType === "profile_generation",
          force: false,
        }),
      );
      if ((await root.lstatOptional(destination, destinationLeaf)) !== null) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "deleted destination leaf still exists",
        );
      }
    });
    await call(root.admission, "fsync-destination-parent-after-delete", () =>
      destination.sync(),
    );
    return;
  } finally {
    await closeAll([
      [destinationPin?.handle, "destination-leaf"],
      [sourcePin?.handle, "source-leaf"],
      [destinationParent, "destination-parent"],
      [sourceParent, "source-parent"],
    ]);
  }
}

async function completeManifest(
  root: AnchoredRoot,
  manifest: LoadedManifest,
): Promise<CompletionV1> {
  const completion: CompletionV1 = {
    version: 1,
    manifestSha256: manifest.checksum,
    retained: manifest.plan.retained,
    removed: manifest.plan.removed,
  };
  await publishTemp(
    root,
    manifest.directoryPath,
    "complete.tmp",
    "complete",
    encodeCompletion(completion),
    (targetDirectory) =>
      prepareCompletedPromotion(root, manifest, targetDirectory),
  );
  manifest.completion = completion;
  manifest.completionStorage = "final";
  return completion;
}

async function scanDestinationLeaves(
  root: AnchoredRoot,
  processNonce: string,
  generationNonce: string,
  budget: Budget,
): Promise<{ leaves: Set<string>; directories: Set<string> }> {
  const base = `quarantine/${processNonce}/${generationNonce}`;
  const found = new Set<string>();
  const directories = new Set<string>();
  for (const owner of await directoryEntriesOptional(
    root,
    `${base}/replay`,
    budget,
  )) {
    if (!owner.isDirectory() || !SAFE_OWNER.test(owner.name)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "quarantine replay is invalid",
      );
    }
    directories.add(`${base}/replay/${owner.name}`);
    for (const scrape of await directoryEntriesOptional(
      root,
      `${base}/replay/${owner.name}`,
      budget,
    )) {
      if (!scrape.isDirectory() || !SAFE_OWNER.test(scrape.name)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "quarantine replay is invalid",
        );
      }
      directories.add(`${base}/replay/${owner.name}/${scrape.name}`);
      for (const file of await directoryEntriesOptional(
        root,
        `${base}/replay/${owner.name}/${scrape.name}`,
        budget,
      )) {
        if (!file.isFile() || !UUID_FILE.test(file.name)) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "quarantine replay is invalid",
          );
        }
        found.add(`${base}/replay/${owner.name}/${scrape.name}/${file.name}`);
      }
    }
  }
  for (const profile of await directoryEntriesOptional(
    root,
    `${base}/profiles`,
    budget,
  )) {
    if (!profile.isDirectory() || !UUID.test(profile.name)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "quarantine profile is invalid",
      );
    }
    directories.add(`${base}/profiles/${profile.name}`);
    for (const state of await directoryEntriesOptional(
      root,
      `${base}/profiles/${profile.name}`,
      budget,
    )) {
      if (!state.isDirectory() || !PROFILE_STATES.has(state.name)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "quarantine profile is invalid",
        );
      }
      directories.add(`${base}/profiles/${profile.name}/${state.name}`);
      for (const generation of await directoryEntriesOptional(
        root,
        `${base}/profiles/${profile.name}/${state.name}`,
        budget,
      )) {
        if (!generation.isDirectory() || !UUID.test(generation.name)) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "quarantine profile is invalid",
          );
        }
        directories.add(
          `${base}/profiles/${profile.name}/${state.name}/${generation.name}`,
        );
        found.add(
          `${base}/profiles/${profile.name}/${state.name}/${generation.name}`,
        );
      }
    }
  }
  return { leaves: found, directories };
}

async function validateManifestCoverage(
  root: AnchoredRoot,
  manifests: readonly LoadedManifest[],
  budget: Budget,
  emptyCurrent: EmptyPlanSkeleton | undefined,
  candidates: readonly Candidate[],
  quarantinePresent: boolean,
): Promise<void> {
  const grouped = new Map<string, Map<string, { completed: boolean }>>();
  for (const manifest of manifests) {
    const key = `${manifest.processNonce}\u0000${manifest.controlGenerationNonce}`;
    const expected =
      grouped.get(key) ?? new Map<string, { completed: boolean }>();
    for (const entry of manifest.plan.entries) {
      if (expected.has(entry.destinationPath)) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "duplicate manifest destination",
        );
      }
      expected.set(entry.destinationPath, {
        completed: manifest.completion !== null,
      });
    }
    grouped.set(key, expected);
  }
  if (!quarantinePresent) return;
  const processes = await directoryEntriesOptional(
    root,
    "quarantine",
    budget,
    true,
  );
  for (const processEntry of processes) {
    if (
      !processEntry.isDirectory() ||
      !tokenSchema.safeParse(processEntry.name).success
    )
      continue;
    for (const generationEntry of await directoryEntriesOptional(
      root,
      `quarantine/${processEntry.name}`,
      budget,
    )) {
      if (
        !generationEntry.isDirectory() ||
        !tokenSchema.safeParse(generationEntry.name).success
      )
        continue;
      const key = `${processEntry.name}\u0000${generationEntry.name}`;
      const generationBase = `quarantine/${processEntry.name}/${generationEntry.name}`;
      const scan = await scanDestinationLeaves(
        root,
        processEntry.name,
        generationEntry.name,
        budget,
      );
      const expected =
        grouped.get(key) ?? new Map<string, { completed: boolean }>();
      const generationEntries = await directoryEntriesOptional(
        root,
        generationBase,
        budget,
      );
      if (
        expected.size === 0 &&
        generationEntries.some((entry) =>
          ["replay", "profiles"].includes(entry.name),
        )
      ) {
        if (
          emptyCurrent === undefined ||
          emptyCurrent.processNonce !== processEntry.name ||
          emptyCurrent.controlGenerationNonce !== generationEntry.name
        ) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "quarantine hierarchy has no manifest",
          );
        }
        const allowed = new Set<string>();
        for (const candidate of candidates) {
          let current = path.posix.dirname(
            `${generationBase}/${candidate.sourcePath}`,
          );
          while (current !== generationBase) {
            allowed.add(current);
            current = path.posix.dirname(current);
          }
        }
        for (const entry of generationEntries) {
          if (
            ["replay", "profiles"].includes(entry.name) &&
            !allowed.has(`${generationBase}/${entry.name}`)
          ) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "pre-plan quarantine skeleton is unauthorized",
            );
          }
        }
        const validateEmptyTree = async (relative: string): Promise<void> => {
          for (const entry of await directoryEntriesOptional(
            root,
            relative,
            budget,
          )) {
            const child = `${relative}/${entry.name}`;
            if (!entry.isDirectory() || !allowed.has(child)) {
              throw err(
                "reconciliation_filesystem_unsafe",
                "pre-plan quarantine skeleton is unauthorized",
              );
            }
            await validateEmptyTree(child);
          }
        };
        for (const namespace of ["replay", "profiles"] as const) {
          const namespacePath = `${generationBase}/${namespace}`;
          if (allowed.has(namespacePath)) {
            await validateEmptyTree(namespacePath);
          }
        }
      }
      const allowedDirectories = new Set<string>();
      for (const destination of expected.keys()) {
        let current = path.posix.dirname(destination);
        while (current !== generationBase) {
          allowedDirectories.add(current);
          current = path.posix.dirname(current);
        }
      }
      for (const entry of generationEntries) {
        if (["replay", "profiles"].includes(entry.name)) {
          scan.directories.add(`${generationBase}/${entry.name}`);
        }
      }
      if (
        emptyCurrent === undefined ||
        key !==
          `${emptyCurrent.processNonce}\u0000${emptyCurrent.controlGenerationNonce}`
      ) {
        for (const directory of scan.directories) {
          if (!allowedDirectories.has(directory)) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "quarantine directory has no manifest authority",
            );
          }
        }
      }
      for (const destination of scan.leaves) {
        const record = expected.get(destination);
        if (record === undefined) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "quarantine bytes have no manifest",
          );
        }
        if (record.completed) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "completed manifest retains quarantine bytes",
          );
        }
      }
    }
  }
}

function validatePlanRecordTopology(
  records: readonly LoadedPlanRecord[],
  request: ReconciliationRequestV1,
): void {
  const grouped = new Map<string, LoadedPlanRecord[]>();
  for (const record of records) {
    const key =
      `${record.value.processNonce}\u0000` +
      record.value.controlGenerationNonce;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    const completionOnly = group.filter(
      (record) => record.kind === "completion-only",
    );
    if (completionOnly.length > 0 && group.length !== 1) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "completion-only skeleton has unauthorized siblings",
      );
    }
    if (completionOnly.length === 1) {
      const record = completionOnly[0]!.value;
      if (
        record.processNonce === request.processNonce &&
        record.controlGenerationNonce === request.controlGenerationNonce &&
        record.snapshotDigest === request.snapshotDigest
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "completion-only record cannot authenticate current replay",
        );
      }
    }
    for (const record of group) {
      if (
        record.kind === "empty" &&
        (record.value.processNonce !== request.processNonce ||
          record.value.controlGenerationNonce !==
            request.controlGenerationNonce ||
          record.value.snapshotDigest !== request.snapshotDigest)
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "unauthorized empty plan skeleton",
        );
      }
    }
  }
}

async function unlinkAnchoredFile(
  root: AnchoredRoot,
  relative: string,
  point: string,
  expectedBytes?: Buffer,
): Promise<void> {
  let opened: Awaited<ReturnType<AnchoredRoot["openParent"]>>;
  try {
    opened = await root.openParent(relative);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const { parent, leaf } = opened;
  let held: FileHandle | undefined;
  let parentBinding: HeldParentBinding | undefined;
  try {
    parentBinding = await captureParentBinding(root, relative, parent);
    const stat = await root.lstatOptional(parent, leaf);
    if (stat === null) {
      await fsyncProvenAbsent(
        root,
        parentBinding,
        parent,
        leaf,
        `${point}-repair-parent-fsync`,
      );
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw err("reconciliation_filesystem_unsafe", "cleanup record is unsafe");
    }
    held = await callOpen(root.admission, `${point}-pin`, () =>
      fs.open(
        procPath(parent, leaf),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ),
    );
    const heldBefore = await call(root.admission, `${point}-pin-stat`, () =>
      held!.stat({ bigint: true }),
    );
    if (!sameLeafIdentity(stat, heldBefore)) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "cleanup record binding changed",
      );
    }
    if (expectedBytes !== undefined) {
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, MANIFEST_MAX_BYTES + 1 - total),
        );
        const read = await call(root.admission, `${point}-pin-read`, () =>
          held!.read(chunk, 0, chunk.length, total),
        );
        if (read.bytesRead === 0) break;
        total += read.bytesRead;
        if (total > MANIFEST_MAX_BYTES) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "cleanup record is too large",
          );
        }
        chunks.push(chunk.subarray(0, read.bytesRead));
      }
      const heldAfter = await call(
        root.admission,
        `${point}-pin-stat-after`,
        () => held!.stat({ bigint: true }),
      );
      if (
        !sameLeafIdentity(heldBefore, heldAfter) ||
        !Buffer.concat(chunks, total).equals(expectedBytes)
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "cleanup record content changed",
        );
      }
    }
    await call(root.admission, point, async () => {
      await assertRawParentBinding(root, parentBinding!);
      const heldNow = await admittedFilesystemCall(root.admission, () =>
        held!.stat({ bigint: true }),
      );
      const current = await admittedFilesystemCall(root.admission, () =>
        fs.lstat(procPath(parent, leaf), { bigint: true }),
      );
      if (
        !sameLeafIdentity(heldBefore, heldNow) ||
        !sameLeafIdentity(heldNow, current)
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "cleanup record binding changed",
        );
      }
      await admittedFilesystemCall(root.admission, () =>
        fs.unlink(procPath(parent, leaf)),
      );
    });
    await refreshParentBindingAfterMutation(root, parentBinding);
    await assertAdmittedAbsent(root, parent, leaf);
    await fsyncProvenAbsent(
      root,
      parentBinding,
      parent,
      leaf,
      `${point}-parent-fsync`,
    );
  } finally {
    await closeAll([
      [held, `${point}-held`],
      [parent, `${point}-parent`],
      [parentBinding?.holder, `${point}-parent-holder`],
    ]);
  }
}

async function removeEmptyDirectory(
  root: AnchoredRoot,
  relative: string,
  point: string,
  expected?: ParentIdentityV1,
): Promise<boolean> {
  let opened: Awaited<ReturnType<AnchoredRoot["openParent"]>>;
  try {
    opened = await root.openParent(relative);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  const { parent, leaf } = opened;
  let held: FileHandle | undefined;
  let parentBinding: HeldParentBinding | undefined;
  try {
    parentBinding = await captureParentBinding(root, relative, parent);
    const initial = await root.lstatOptional(parent, leaf);
    if (initial === null) {
      await fsyncProvenAbsent(
        root,
        parentBinding,
        parent,
        leaf,
        `${point}-repair-parent-fsync`,
      );
      return true;
    }
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "cleanup directory is unsafe",
      );
    }
    held = await callOpen(root.admission, `${point}-pin`, () =>
      fs.open(
        procPath(parent, leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    );
    const heldBefore = await call(root.admission, `${point}-pin-stat`, () =>
      held!.stat({ bigint: true }),
    );
    if (
      !sameLeafIdentity(initial, heldBefore) ||
      (expected !== undefined &&
        !sameParentIdentity(
          expected,
          parentIdentity(expected.path, heldBefore),
        ))
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "cleanup directory identity changed",
      );
    }
    try {
      await call(root.admission, point, async () => {
        await assertRawParentBinding(root, parentBinding!);
        const heldNow = await admittedFilesystemCall(root.admission, () =>
          held!.stat({ bigint: true }),
        );
        const current = await admittedFilesystemCall(root.admission, () =>
          fs.lstat(procPath(parent, leaf), { bigint: true }),
        );
        if (
          !sameLeafIdentity(heldBefore, heldNow) ||
          !sameLeafIdentity(heldNow, current)
        ) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "cleanup directory identity changed",
          );
        }
        await admittedFilesystemCall(root.admission, () =>
          fs.rmdir(procPath(parent, leaf)),
        );
      });
    } catch (error) {
      if (
        isNodeError(error) &&
        ["ENOTEMPTY", "EEXIST"].includes(error.code ?? "")
      ) {
        return false;
      }
      throw error;
    }
    await refreshParentBindingAfterMutation(root, parentBinding);
    await assertAdmittedAbsent(root, parent, leaf);
    await fsyncProvenAbsent(
      root,
      parentBinding,
      parent,
      leaf,
      `${point}-parent-fsync`,
    );
    return true;
  } finally {
    await closeAll([
      [held, `${point}-held`],
      [parent, `${point}-parent`],
      [parentBinding?.holder, `${point}-parent-holder`],
    ]);
  }
}

async function removeRecordedEmptyDirectory(
  root: AnchoredRoot,
  expected: ParentIdentityV1,
  point: string,
): Promise<boolean> {
  return removeEmptyDirectory(root, expected.path, point, expected);
}

async function cleanupCompletedManifest(
  root: AnchoredRoot,
  manifest: LoadedManifest,
): Promise<void> {
  const generationBase = `quarantine/${manifest.processNonce}/${manifest.controlGenerationNonce}`;
  const suffixProofs = new Map<string, CompletedSuffixProof>();
  const allSuffixProofs: CompletedSuffixProof[] = [];
  const refreshProofParent = async (removedPath: string): Promise<void> => {
    const proof = suffixProofs.get(path.posix.dirname(removedPath));
    if (proof !== undefined) {
      await assertCompletedSuffixProof(root, proof, true);
    }
  };
  try {
    for (const entry of manifest.plan.entries) {
      let sourceParent: FileHandle | undefined;
      let destinationParent: FileHandle | undefined;
      let sourceBinding: HeldParentBinding | undefined;
      let destinationBinding: HeldParentBinding | undefined;
      try {
        sourceParent = await root.openDirectory(entry.sourceParent.path);
        await assertParent(root, sourceParent, entry.sourceParent);
        sourceBinding = await captureParentBinding(
          root,
          entry.sourcePath,
          sourceParent,
        );
        await fsyncProvenAbsent(
          root,
          sourceBinding,
          sourceParent,
          path.posix.basename(entry.sourcePath),
          "cleanup-source-parent-fsync",
        );
        try {
          destinationParent = await root.openDirectory(
            entry.destinationParent.path,
          );
          await assertParent(root, destinationParent, entry.destinationParent);
          destinationBinding = await captureParentBinding(
            root,
            entry.destinationPath,
            destinationParent,
          );
          await fsyncProvenAbsent(
            root,
            destinationBinding,
            destinationParent,
            path.posix.basename(entry.destinationPath),
            "cleanup-destination-parent-fsync",
          );
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          const proof = await openCompletedAbsentSuffix(root, entry);
          const existing = suffixProofs.get(proof.path);
          if (existing === undefined) {
            suffixProofs.set(proof.path, proof);
            allSuffixProofs.push(proof);
          } else {
            try {
              await assertCompletedSuffixProof(root, existing, true);
              await assertCompletedSuffixProof(root, proof, true);
              if (
                existing.stat.dev !== proof.stat.dev ||
                existing.stat.ino !== proof.stat.ino ||
                existing.stat.mode !== proof.stat.mode ||
                !existing.stat.isDirectory() ||
                !proof.stat.isDirectory()
              ) {
                throw err(
                  "reconciliation_filesystem_unsafe",
                  "completed cleanup suffix proofs conflict",
                );
              }
              for (const absentLeaf of proof.absentLeaves) {
                existing.absentLeaves.add(absentLeaf);
              }
            } finally {
              await closeAll([
                [proof.handle, "duplicate-cleanup-surviving-ancestor"],
                [proof.parent, "duplicate-cleanup-surviving-parent"],
              ]);
            }
          }
          const retained = suffixProofs.get(proof.path)!;
          await fsyncCompletedSuffixAbsence(
            root,
            retained,
            "cleanup-surviving-ancestor-fsync",
          );
        }
      } finally {
        await closeAll([
          [destinationBinding?.holder, "cleanup-destination-parent-holder"],
          [sourceBinding?.holder, "cleanup-source-parent-holder"],
          [destinationParent, "cleanup-destination-parent"],
          [sourceParent, "cleanup-source-parent"],
        ]);
      }
    }
    const candidateParents = new Map<string, ParentIdentityV1>();
    const cleanupPaths = new Set<string>();
    for (const entry of manifest.plan.entries) {
      const existing = candidateParents.get(entry.destinationParent.path);
      if (
        existing !== undefined &&
        !sameParentIdentity(existing, entry.destinationParent)
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "completed cleanup parent identities conflict",
        );
      }
      candidateParents.set(
        entry.destinationParent.path,
        entry.destinationParent,
      );
      let current = entry.destinationParent.path;
      while (
        current.startsWith(`${generationBase}/`) &&
        current !== generationBase
      ) {
        cleanupPaths.add(current);
        current = path.posix.dirname(current);
      }
    }
    const orderedCleanupPaths = [...cleanupPaths].sort((left, right) => {
      const depth = right.split("/").length - left.split("/").length;
      return depth === 0 ? rawCompare(right, left) : depth;
    });
    for (const current of orderedCleanupPaths) {
      const proof = suffixProofs.get(current);
      let removed: boolean;
      if (proof !== undefined) {
        await removeCompletedSuffixProof(
          root,
          proof,
          "cleanup-destination-directory",
        );
        suffixProofs.delete(current);
        removed = true;
      } else {
        const expected = candidateParents.get(current);
        removed =
          expected === undefined
            ? await removeEmptyDirectory(
                root,
                current,
                "cleanup-destination-ancestor",
              )
            : await removeRecordedEmptyDirectory(
                root,
                expected,
                "cleanup-destination-directory",
              );
      }
      if (!removed) {
        let opened: Awaited<ReturnType<AnchoredRoot["openParent"]>> | undefined;
        try {
          opened = await root.openParent(current);
          if ((await root.lstatOptional(opened.parent, opened.leaf)) !== null) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "completed cleanup directory is not empty",
            );
          }
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        } finally {
          if (opened !== undefined) {
            await closeRaw(opened.parent, "cleanup-absent-directory-parent");
          }
        }
      } else {
        await refreshProofParent(current);
      }
    }

    for (const name of ["plan.json", "complete"] as const) {
      await unlinkAnchoredFile(
        root,
        `${manifest.directoryPath}/${name}`,
        `cleanup-${name}`,
        name === "plan.json"
          ? manifest.bytes
          : encodeCompletion(manifest.completion!),
      );
    }
    const digestComplete = await removeEmptyDirectory(
      root,
      manifest.directoryPath,
      "cleanup-plan-digest",
    );
    if (!digestComplete) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "completed plan directory is not empty",
      );
    }
    await refreshProofParent(manifest.directoryPath);
    const plansDirectory = path.posix.dirname(manifest.directoryPath);
    const plansComplete = await removeEmptyDirectory(
      root,
      plansDirectory,
      "cleanup-plans-directory",
    );
    if (!plansComplete) return;
    await refreshProofParent(plansDirectory);
    const generationProof = suffixProofs.get(generationBase);
    let generationComplete = true;
    if (generationProof !== undefined) {
      await removeCompletedSuffixProof(
        root,
        generationProof,
        "cleanup-generation",
      );
      suffixProofs.delete(generationBase);
      await refreshProofParent(generationBase);
    } else {
      generationComplete = await removeEmptyDirectory(
        root,
        generationBase,
        "cleanup-generation",
      );
    }
    if (!generationComplete) return;
    await removeEmptyDirectory(
      root,
      path.posix.dirname(generationBase),
      "cleanup-process",
    );
  } finally {
    await closeAll(
      allSuffixProofs.flatMap((proof, index) => [
        [proof.handle, `cleanup-surviving-ancestor-${index}`] as const,
        [proof.parent, `cleanup-surviving-parent-${index}`] as const,
      ]),
    );
  }
}

async function cleanupCompletionOnlyRecord(
  root: AnchoredRoot,
  record: CompletionOnlyRecord,
): Promise<void> {
  await unlinkAnchoredFile(
    root,
    `${record.directoryPath}/complete`,
    "cleanup-complete",
    encodeCompletion(record.completion),
  );
  const generationBase = `quarantine/${record.processNonce}/${record.controlGenerationNonce}`;
  const digestComplete = await removeEmptyDirectory(
    root,
    record.directoryPath,
    "cleanup-plan-digest",
  );
  if (!digestComplete) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "completed plan directory is not empty",
    );
  }
  const plansComplete = await removeEmptyDirectory(
    root,
    path.posix.dirname(record.directoryPath),
    "cleanup-plans-directory",
  );
  if (!plansComplete) return;
  const generationComplete = await removeEmptyDirectory(
    root,
    generationBase,
    "cleanup-generation",
  );
  if (!generationComplete) return;
  await removeEmptyDirectory(
    root,
    path.posix.dirname(generationBase),
    "cleanup-process",
  );
}

function safeLog(
  correlationId: string | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event: "browser_state_reconciliation",
    ...(correlationId !== undefined &&
    /^[A-Za-z0-9._-]{1,128}$/u.test(correlationId)
      ? { correlationId }
      : {}),
    ...fields,
  };
}

function classifyRequest(
  input: ReconciliationRequestV1,
): ReconciliationRequestV1 {
  const raw = input as unknown as Record<string, unknown>;
  if (
    Array.isArray(raw.references) &&
    raw.references.length > MAX_RECONCILIATION_REFERENCES
  ) {
    throw err("reconciliation_snapshot_too_large", "snapshot is too large");
  }
  let encoded = 0;
  try {
    encoded = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    throw err("reconciliation_snapshot_invalid", "snapshot is invalid");
  }
  if (encoded > 16 * 1024 * 1024) {
    throw err("reconciliation_snapshot_too_large", "snapshot is too large");
  }
  const parsed = reconciliationRequestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw err("reconciliation_snapshot_invalid", "snapshot is invalid");
  }
  const canonical = canonicalizeReconciliationSnapshot(parsed.data.references);
  if (canonical.snapshotDigest !== parsed.data.snapshotDigest) {
    throw err("reconciliation_snapshot_invalid", "snapshot digest is invalid");
  }
  return parsed.data;
}

async function reconcileBrowserStateCore(
  rootRecord: RootCapabilityRecord,
  input: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
  sealEvidence?: (evidence: ReconciledRootEvidence) => void,
): Promise<ReconciliationResultV1> {
  const started = Date.now();
  let state = "validating";
  let retained = 0;
  let removed = 0;
  const root = rootRecord.anchored;
  try {
    assertAdmitted(deps.admission);
    const request = classifyRequest(input);
    const maximum = deps.maxManagedEntries ?? MAX_RECONCILIATION_REFERENCES;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > MAX_RECONCILIATION_REFERENCES
    ) {
      throw err("reconciliation_snapshot_invalid", "entry bound is invalid");
    }
    const budget = new Budget(maximum);
    const intentOwnedPaths = new Set(
      [...rootRecord.sealedGenerations.values()].map(generation => {
        const locator = requireGeneration(generation).locator;
        return `profiles/${locator.profileId}/${locator.state}/${locator.generationId}`;
      }),
    );
    const authoritativePaths = await validateAuthorities(
      root,
      request.references,
      budget,
      rootRecord,
    );
    retained = authoritativePaths.size;

    state = "recovering";
    const enumeration = await enumerateCandidates(
      root,
      budget,
      intentOwnedPaths,
    );
    const allCandidates = enumeration.candidates;
    const quarantinePresent = enumeration.namespaces.has("quarantine");
    const records = await enumerateManifests(root, budget, quarantinePresent);
    validatePlanRecordTopology(records, request);
    let manifests = records
      .filter(
        (record): record is Extract<LoadedPlanRecord, { kind: "manifest" }> =>
          record.kind === "manifest",
      )
      .map((record) => record.value);
    const completionOnlyRecords = records
      .filter(
        (
          record,
        ): record is Extract<LoadedPlanRecord, { kind: "completion-only" }> =>
          record.kind === "completion-only",
      )
      .map((record) => record.value);
    const emptyCurrent = records.find(
      (record) =>
        record.kind === "empty" &&
        record.value.processNonce === request.processNonce &&
        record.value.controlGenerationNonce ===
          request.controlGenerationNonce &&
        record.value.snapshotDigest === request.snapshotDigest,
    );
    await validateManifestCoverage(
      root,
      manifests,
      budget,
      emptyCurrent?.kind === "empty" ? emptyCurrent.value : undefined,
      allCandidates,
      quarantinePresent,
    );
    await validateManifestPhases(root, manifests, budget);
    const pendingManifestSources = new Set<string>();
    const pendingManifestDestinations = new Set<string>();
    for (const manifest of manifests) {
      if (manifest.completion === null) {
        for (const entry of manifest.plan.entries) {
          if (
            pendingManifestSources.has(entry.sourcePath) ||
            pendingManifestDestinations.has(entry.destinationPath)
          ) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "pending manifest paths are duplicated",
            );
          }
          pendingManifestSources.add(entry.sourcePath);
          pendingManifestDestinations.add(entry.destinationPath);
        }
      }
      if (
        manifest.completion === null &&
        manifest.plan.entries.some((entry) =>
          authoritativePaths.has(entry.sourcePath),
        )
      ) {
        throw err(
          "reconciliation_filesystem_unsafe",
          "pending manifest conflicts with authority",
        );
      }
    }
    let current = manifests.find(
      (manifest) =>
        manifest.processNonce === request.processNonce &&
        manifest.controlGenerationNonce === request.controlGenerationNonce &&
        manifest.snapshotDigest === request.snapshotDigest,
    );

    state = "planning";
    let activeManifest = current;
    if (activeManifest === undefined) {
      const now = (deps.now ?? (() => new Date()))().getTime();
      const grace = deps.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
      if (!Number.isFinite(now) || !Number.isSafeInteger(grace) || grace < 0) {
        throw err("reconciliation_snapshot_invalid", "timing is invalid");
      }
      const pendingOld = manifests.filter(
        (manifest) => manifest.completion === null,
      );
      const pendingSources = new Set<string>();
      const pendingDestinations = new Set<string>();
      for (const manifest of pendingOld) {
        for (const entry of manifest.plan.entries) {
          if (
            pendingSources.has(entry.sourcePath) ||
            pendingDestinations.has(entry.destinationPath)
          ) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "reconciliation plan paths are duplicated",
            );
          }
          pendingSources.add(entry.sourcePath);
          pendingDestinations.add(entry.destinationPath);
        }
      }
      const candidates = allCandidates
        .filter(
          (candidate) =>
            !authoritativePaths.has(candidate.sourcePath) &&
            now - candidate.maxMtimeMs > grace,
        )
        .sort((left, right) => rawCompare(left.sourcePath, right.sourcePath));
      for (const candidate of candidates) {
        const destination =
          `quarantine/${request.processNonce}/` +
          `${request.controlGenerationNonce}/${candidate.sourcePath}`;
        if (
          pendingSources.has(candidate.sourcePath) ||
          pendingDestinations.has(destination)
        ) {
          throw err(
            "reconciliation_filesystem_unsafe",
            "reconciliation plan paths are duplicated",
          );
        }
        pendingSources.add(candidate.sourcePath);
        pendingDestinations.add(destination);
      }
      if (pendingSources.size > MAX_RECONCILIATION_REFERENCES) {
        throw err(
          "reconciliation_snapshot_too_large",
          "reconciliation plan is too large",
        );
      }
      activeManifest = await buildCurrentManifest(
        root,
        request,
        retained,
        pendingSources.size,
        candidates,
        budget,
      );
      manifests = [...manifests, activeManifest];
      current = activeManifest;
    }

    await repairManifestRecords(root, manifests);

    state = "executing";
    const pending = manifests
      .filter((manifest) => manifest.completion === null)
      .sort((left, right) => {
        if (left === activeManifest) return 1;
        if (right === activeManifest) return -1;
        return rawCompare(left.directoryPath, right.directoryPath);
      });
    removed = activeManifest.plan.removed;
    for (const manifest of pending) {
      for (const entry of manifest.plan.entries) {
        await executeManifestEntry(root, entry, budget);
      }
      await completeManifest(root, manifest);
    }
    const completion = activeManifest.completion;
    if (completion === null) {
      throw err(
        "reconciliation_cleanup_failed",
        "completion was not published",
      );
    }
    for (const manifest of manifests) {
      if (
        manifest !== activeManifest &&
        manifest.completionStorage === "final"
      ) {
        await cleanupCompletedManifest(root, manifest);
      }
    }
    for (const record of completionOnlyRecords) {
      await cleanupCompletionOnlyRecord(root, record);
    }
    if (quarantinePresent && records.length > 0) {
      await cleanupEmptyOldPlanSkeletons(root, request, budget);
    }
    assertAdmitted(deps.admission);
    const result: ReconciliationResultV1 = {
      version: 1,
      processNonce: request.processNonce,
      controlGenerationNonce: request.controlGenerationNonce,
      snapshotDigest: request.snapshotDigest,
      retained: completion.retained,
      removed: completion.removed,
      missing: 0,
      corrupt: 0,
      ready: true,
    };
    await root.revalidate();
    sealEvidence?.(
      root.evidence({
        processNonce: request.processNonce,
        controlGenerationNonce: request.controlGenerationNonce,
        snapshotDigest: request.snapshotDigest,
      }),
    );
    deps.logger?.info(
      safeLog(deps.correlationId, {
        category: "reconciliation_complete",
        state: "complete",
        retained: result.retained,
        removed: result.removed,
        missing: 0,
        corrupt: 0,
        durationMs: Math.max(0, Date.now() - started),
        result: "ready",
      }),
    );
    return result;
  } catch (error) {
    const actual =
      error instanceof BrowserServiceError
        ? error
        : err("reconciliation_cleanup_failed", "reconciliation failed");
    deps.logger?.error(
      safeLog(deps.correlationId, {
        category: actual.category,
        state,
        retained,
        removed,
        missing: actual.category === "reconciliation_reference_missing" ? 1 : 0,
        corrupt: actual.category === "reconciliation_reference_corrupt" ? 1 : 0,
        durationMs: Math.max(0, Date.now() - started),
        result: "unready",
      }),
    );
    throw actual;
  }
}

export async function reconcileBrowserState(
  canonicalRoot: string,
  input: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
): Promise<ReconciliationResultV1> {
  const outcome = await reconcileBrowserStateWithAuthority(
    canonicalRoot,
    input,
    deps,
  );
  return disposePublicReconciliationOutcome(outcome);
}

type OutcomeRecord = {
  state: "fresh" | "consuming" | "consumed" | "cleanup_unverified";
  result: ReconciliationResultV1;
  evidence: ReconciledRootEvidence;
  admission: ReconciliationExecutionAdmission;
  observability: AtomicPublicationObservability | null;
  root: AnchoredProfileRoot;
  retainedCleanup?:
    | { kind: "root"; root: AnchoredProfileRoot }
    | { kind: "anchored"; anchored: AnchoredRoot };
};

type PartialCreateCleanupRecord = {
  directories: Array<{
    parent: FileHandle;
    parentIdentity: BigIntStats;
    leaf: string;
    phase: "created_unpinned" | "remove_pending" | "fsync_pending" | "done";
    creationIdentity?: BigIntStats;
    pinHandle?: FileHandle;
    created?: { handle: FileHandle; stat: BigIntStats };
  }>;
  handles: Map<FileHandle, { point: string; closed: boolean }>;
};

type RootCapabilityRecord = {
  state: "live" | "consuming" | "consumed" | "close_unverified" | "closed";
  token: AnchoredProfileRoot | null;
  anchored: AnchoredRoot;
  binding: ReadyProfileRootBinding;
  children: Set<GenerationCapabilityRecord>;
  sealedGenerations: Map<string, BoundProfileGeneration>;
  acceptingOperations: boolean;
  activeOperations: number;
  drainWaiters: Set<() => void>;
  childDrainWaiters: Set<() => void>;
  authorities: Set<AuthorityRecord>;
  partialCreateCleanups: Set<PartialCreateCleanupRecord>;
  observability: AtomicPublicationObservability | null;
};

type GenerationCapabilityRecord = {
  state: "live" | "consuming" | "consumed" | "close_unverified" | "closed";
  root: RootCapabilityRecord;
  locator: ProfileGenerationLocator;
  profiles: FileHandle;
  profile: FileHandle;
  stateHandle: FileHandle;
  generation: FileHandle;
  identities: readonly BigIntStats[];
  attachmentCount: number;
  deletionLeaf?: string;
  acceptingOperations: boolean;
  activeOperations: number;
  operationTail: Promise<void>;
  drainWaiters: Set<() => void>;
};

function signalCapabilityDrain(
  record: Pick<RootCapabilityRecord, "activeOperations" | "drainWaiters">,
): void {
  if (record.activeOperations !== 0) return;
  for (const resolve of record.drainWaiters) resolve();
  record.drainWaiters.clear();
}

async function waitCapabilityDrain(
  record: Pick<RootCapabilityRecord, "activeOperations" | "drainWaiters">,
): Promise<void> {
  if (record.activeOperations === 0) return;
  await new Promise<void>((resolve) => record.drainWaiters.add(resolve));
}

function acquireRootOperation(record: RootCapabilityRecord): () => void {
  if (!record.acceptingOperations || record.state !== "live") {
    throw unsafeCapability("anchored profile root is not accepting operations");
  }
  assertAdmitted(record.anchored.admission);
  record.activeOperations += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    record.activeOperations -= 1;
    signalCapabilityDrain(record);
  };
}

function acquireGenerationOperation(
  record: GenerationCapabilityRecord,
  revoke = false,
): Promise<() => void> {
  const releaseRoot = acquireRootOperation(record.root);
  if (!record.acceptingOperations || record.state !== "live") {
    releaseRoot();
    throw unsafeCapability("profile generation is not accepting operations");
  }
  if (revoke) record.acceptingOperations = false;
  record.activeOperations += 1;
  const predecessor = record.operationTail;
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  record.operationTail = predecessor.then(() => turn);
  return predecessor.then(() => {
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      releaseTurn();
      record.activeOperations -= 1;
      signalCapabilityDrain(record);
      releaseRoot();
    };
  });
}

function signalRootChildDrain(record: RootCapabilityRecord): void {
  if (
    record.children.size !== 0 &&
    ![...record.children].some((child) => child.state === "close_unverified")
  ) return;
  for (const resolve of record.childDrainWaiters) resolve();
  record.childDrainWaiters.clear();
}

async function waitRootChildDrain(record: RootCapabilityRecord): Promise<void> {
  while (record.children.size !== 0) {
    if ([...record.children].some((child) => child.state === "close_unverified")) {
      throw unsafeCapability("profile generation cleanup is unverified");
    }
    await new Promise<void>((resolve) => record.childDrainWaiters.add(resolve));
  }
}

type AuthorityRecord = {
  state: "live" | "closed";
  root: RootCapabilityRecord;
  binding: ReadyProfileRootBinding;
};

type AttachmentRecord = {
  state: "live" | "releasing" | "released" | "close_unverified";
  generation: GenerationCapabilityRecord;
  context: BrowserContext;
  contextClosePromise?: Promise<boolean>;
  contextCloseSettlement: "idle" | "pending" | "resolved" | "rejected";
  browser?: Browser | null;
  browserClosePromise?: Promise<boolean>;
  browserCloseSettlement:
    | "idle"
    | "pending"
    | "timed_out"
    | "resolved"
    | "rejected";
  browserCloseAttempt: number;
};

const outcomeRecords = new WeakMap<object, OutcomeRecord>();
const retainedOutcomeCleanupRecords = new Set<OutcomeRecord>();
let retainedOutcomeCleanupRetry: Promise<void> | null = null;
const rootCapabilityRecords = new WeakMap<object, RootCapabilityRecord>();
const generationCapabilityRecords = new WeakMap<
  object,
  GenerationCapabilityRecord
>();
const authorityRecords = new WeakMap<object, AuthorityRecord>();
const attachmentRecords = new WeakMap<object, AttachmentRecord>();
const transitionRecoveryRecords = new WeakMap<object, BoundProfileGeneration>();

export function consumeFailedGenerationTransition(
  error: unknown,
): BoundProfileGeneration | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return undefined;
  }
  const recovered = transitionRecoveryRecords.get(error);
  if (recovered !== undefined) transitionRecoveryRecords.delete(error);
  return recovered;
}

function unsafeCapability(message: string): BrowserServiceError {
  return err("reconciliation_filesystem_unsafe", message);
}

function sameReadyBinding(
  left: ReadyProfileRootBinding,
  right: ReadyProfileRootBinding,
): boolean {
  return (
    left.processNonce === right.processNonce &&
    left.controlGenerationNonce === right.controlGenerationNonce &&
    left.snapshotDigest === right.snapshotDigest
  );
}

export async function reconcileBrowserStateWithAuthority(
  canonicalRoot: string,
  input: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
): Promise<InternalReconciliationOutcome> {
  const observability =
    deps.atomicPublicationSink === undefined
      ? null
      : createAtomicPublicationObservability(deps.atomicPublicationSink);
  if (observability !== null) {
    let result: "ready" | "unsupported" | "failed" = "ready";
    let compiledNapiVersion = 0;
    try {
      compiledNapiVersion = loadAtomicDirectoryPublicationNative().napiVersion;
    } catch {
      result = "failed";
    }
    const runtimeNapiVersion = Number.parseInt(process.versions.napi ?? "0", 10);
    observability.preflight({
      platform: process.platform,
      architecture: process.arch,
      interfaceVersion: "1.0.0",
      compiledNapiVersion,
      runtimeNapiVersion: Number.isSafeInteger(runtimeNapiVersion)
        ? runtimeNapiVersion
        : 0,
      filesystem: "unknown",
      result,
    });
    if (result !== "ready") {
      observability.count("unsupported");
    }
  }
  const classifiedInput = classifyRequest(input);
  const binding: ReadyProfileRootBinding = Object.freeze({
    processNonce: classifiedInput.processNonce,
    controlGenerationNonce: classifiedInput.controlGenerationNonce,
    snapshotDigest: classifiedInput.snapshotDigest,
  });
  const anchored = await openAnchoredRoot(canonicalRoot, deps.admission);
  const rootRecord: RootCapabilityRecord = {
    state: "live",
    token: null,
    anchored,
    binding,
    children: new Set(),
    sealedGenerations: new Map(),
    acceptingOperations: true,
    activeOperations: 0,
    drainWaiters: new Set(),
    childDrainWaiters: new Set(),
    authorities: new Set(),
    partialCreateCleanups: new Set(),
    observability,
  };
  const root = Object.freeze({}) as AnchoredProfileRoot;
  rootRecord.token = root;
  rootCapabilityRecords.set(root as object, rootRecord);
  try {
    await recoverAtomicDurablePublicationsBeforeTask3(
      root,
      classifiedInput,
      deps,
      observability,
    );
    if (deps.freshAtomicCanary === true) {
      await runFreshAtomicDirectoryCanary(root, binding);
    }
    let evidence: ReconciledRootEvidence | undefined;
    const result = await reconcileBrowserStateCore(
      rootRecord,
      classifiedInput,
      deps,
      (sealed) => {
        evidence = sealed;
      },
    );
    if (evidence === undefined) {
      throw unsafeCapability("reconciliation authority was not sealed");
    }
    const token = Object.freeze({}) as InternalReconciliationOutcome;
    outcomeRecords.set(token, {
      state: "fresh",
      result: Object.freeze({ ...result }),
      evidence,
      admission: deps.admission,
      observability,
      root,
    });
    return token;
  } catch (error) {
    try {
      await closeAnchoredProfileRoot(root);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "reconciliation root cleanup failed",
      );
    }
    throw error;
  }
}

export async function consumeInternalReconciliationOutcome<T>(
  outcome: InternalReconciliationOutcome,
  binding: ReadyProfileRootBinding,
  consume: (install: InternalReconciliationInstall) => Promise<T>,
): Promise<T> {
  const record = outcomeRecords.get(outcome as object);
  if (
    record === undefined ||
    record.state !== "fresh" ||
    !sameReadyBinding(record.evidence.binding, binding)
  ) {
    throw unsafeCapability("reconciliation outcome is not consumable");
  }
  record.state = "consuming";
  const rootToken = record.root;
  try {
    assertAdmitted(record.admission);
    const rootRecord = requireRoot(rootToken);
    const currentEvidence = rootRecord.anchored.evidence(rootRecord.binding);
    if (
      JSON.stringify(currentEvidence.canonicalAbsoluteComponents) !==
        JSON.stringify(record.evidence.canonicalAbsoluteComponents) ||
      JSON.stringify(currentEvidence.componentIdentities) !==
        JSON.stringify(record.evidence.componentIdentities)
    ) {
      throw unsafeCapability("reconciled root authority changed");
    }
    assertAdmitted(record.admission);
    const authority = Object.freeze({}) as InstalledReconciledAuthority;
    const authorityRecord: AuthorityRecord = {
      state: "live",
      root: rootRecord,
      binding: rootRecord.binding,
    };
    authorityRecords.set(authority, authorityRecord);
    rootRecord.authorities.add(authorityRecord);
    const result = await consume(
      Object.freeze({
        publicResult: Object.freeze({ ...record.result }),
        authority,
        root: rootToken,
      }),
    );
    record.state = "consumed";
    return result;
  } catch (error) {
    record.state = "consumed";
    const retainedCleanup = { kind: "root", root: rootToken } as const;
    try {
      await closeAnchoredProfileRoot(retainedCleanup.root);
    } catch (closeError) {
      record.state = "cleanup_unverified";
      record.retainedCleanup = retainedCleanup;
      retainedOutcomeCleanupRecords.add(record);
      throw new AggregateError(
        [error, closeError],
        "reconciliation outcome cleanup failed",
      );
    }
    throw error;
  }
}

export async function consumeInternalReconciliationOutcomeForStartup<T>(
  outcome: InternalReconciliationOutcome,
  binding: ReadyProfileRootBinding,
  createProfileStore: InternalReconciliationProfileStoreFactory,
  compareAndSwapInstall: (
    install: InternalReconciliationStartupInstall,
  ) => T,
): Promise<T> {
  if (
    typeof createProfileStore !== "function" ||
    typeof compareAndSwapInstall !== "function"
  ) {
    throw unsafeCapability("reconciliation startup consumer is invalid");
  }
  return consumeInternalReconciliationOutcome(
    outcome,
    binding,
    async install => {
      if (
        install.publicResult.processNonce !== binding.processNonce ||
        install.publicResult.controlGenerationNonce !==
          binding.controlGenerationNonce ||
        install.publicResult.snapshotDigest !== binding.snapshotDigest
      ) {
        throw unsafeCapability(
          "reconciliation startup result identity does not match",
        );
      }
      const rootRecord = requireRoot(install.root);
      const sealedGenerationCount = rootRecord.sealedGenerations.size;
      const sealedGenerations = Object.freeze([
        ...rootRecord.sealedGenerations.values(),
      ]);
      let profileStore: ProfileStore | null = null;
      let installed = false;
      try {
        profileStore = await createProfileStore(
          install.root,
          binding,
          sealedGenerationCount,
        );
        assertAdmitted(rootRecord.anchored.admission);
        const bundle = Object.freeze({
          ...install,
          binding: Object.freeze({ ...binding }),
          profileStore,
          sealedGenerationCount,
          sealedGenerations,
        });
        const result = compareAndSwapInstall(bundle);
        installed = true;
        return result;
      } finally {
        if (!installed && profileStore !== null) {
          await profileStore.close();
        }
      }
    },
  );
}

async function drainFailedReconciliationOutcomeCleanups(): Promise<void> {
  const failures: unknown[] = [];
  for (const record of retainedOutcomeCleanupRecords) {
    const cleanup = record.retainedCleanup;
    if (cleanup === undefined) {
      retainedOutcomeCleanupRecords.delete(record);
      continue;
    }
    try {
      if (cleanup.kind === "root") {
        await closeAnchoredProfileRoot(cleanup.root);
      } else {
        await cleanup.anchored.close();
      }
      delete record.retainedCleanup;
      record.state = "consumed";
      retainedOutcomeCleanupRecords.delete(record);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "reconciliation outcome cleanup retry failed",
    );
  }
}

export function retryFailedReconciliationOutcomeCleanups(): Promise<void> {
  if (retainedOutcomeCleanupRetry !== null) {
    return retainedOutcomeCleanupRetry;
  }
  const operation = drainFailedReconciliationOutcomeCleanups();
  retainedOutcomeCleanupRetry = operation;
  void operation.then(
    () => {
      if (retainedOutcomeCleanupRetry === operation) {
        retainedOutcomeCleanupRetry = null;
      }
    },
    () => {
      if (retainedOutcomeCleanupRetry === operation) {
        retainedOutcomeCleanupRetry = null;
      }
    },
  );
  return operation;
}

async function disposePublicReconciliationOutcome(
  outcome: InternalReconciliationOutcome,
): Promise<ReconciliationResultV1> {
  const record = outcomeRecords.get(outcome as object);
  if (record === undefined || record.state !== "fresh") {
    throw unsafeCapability("public reconciliation outcome is unavailable");
  }
  return consumeInternalReconciliationOutcome(
    outcome,
    record.evidence.binding,
    async (install) => {
      const publicResult = Object.freeze({ ...install.publicResult });
      await closeAnchoredProfileRoot(install.root);
      return publicResult;
    },
  );
}

function requireRoot(root: AnchoredProfileRoot): RootCapabilityRecord {
  const record = rootCapabilityRecords.get(root as object);
  if (record === undefined || record.state !== "live") {
    throw unsafeCapability("anchored profile root is not live");
  }
  assertAdmitted(record.anchored.admission);
  return record;
}

export async function closeAnchoredProfileRoot(
  root: AnchoredProfileRoot,
): Promise<void> {
  const record = rootCapabilityRecords.get(root as object);
  if (
    record === undefined ||
    (record.state !== "live" && record.state !== "close_unverified")
  ) {
    throw unsafeCapability("anchored profile root is not live");
  }
  record.acceptingOperations = false;
  record.state = "consuming";
  try {
    // Runtime rollover revokes filesystem admission before draining owned
    // resources. Descriptor release must therefore remain possible after
    // revocation; only operational capability use is admission-gated.
    await waitCapabilityDrain(record);
    for (const generation of [
      ...record.sealedGenerations.values(),
    ].reverse()) {
      const generationRecord = generationCapabilityRecords.get(
        generation as object,
      );
      if (generationRecord === undefined) {
        throw unsafeCapability("sealed profile generation is unavailable");
      }
      filesystemTestContext
        .getStore()
        ?.sealedGenerationClosing?.(generationRecord.locator);
      await generation.close();
    }
    record.sealedGenerations.clear();
    await waitRootChildDrain(record);
    await retryRootPartialCreateCleanups(record);
    await record.anchored.close();
    for (const authority of record.authorities) authority.state = "closed";
    record.authorities.clear();
    record.state = "closed";
    rootCapabilityRecords.delete(root as object);
  } catch (error) {
    record.state = "close_unverified";
    throw error;
  }
}

export function transferSealedProfileGenerations(
  root: AnchoredProfileRoot,
  generations: readonly BoundProfileGeneration[],
  attach: (generations: readonly BoundProfileGeneration[]) => void,
): void {
  if (typeof attach !== "function") {
    throw unsafeCapability("sealed generation attachment is invalid");
  }
  const record = requireRoot(root);
  const requested = new Set(generations);
  if (requested.size !== generations.length) {
    throw unsafeCapability("sealed generation transfer is duplicated");
  }
  const entries = [...record.sealedGenerations.entries()].filter(([, token]) =>
    requested.has(token),
  );
  if (entries.length !== generations.length) {
    throw unsafeCapability("sealed generation transfer is unavailable");
  }
  const ordered = Object.freeze(entries.map(([, token]) => token));
  attach(ordered);
  for (const [operationId] of entries) {
    record.sealedGenerations.delete(operationId);
  }
}

export async function readHeldRootFile(
  root: AnchoredProfileRoot,
  relative: string,
  maximumBytes: number,
): Promise<Buffer> {
  const record = requireRoot(root);
  const release = acquireRootOperation(record);
  try {
  validateRelativePath(relative);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw unsafeCapability("held file byte limit is invalid");
  }
  await record.anchored.revalidate();
  const result = await readRegularFile(
    record.anchored,
    relative,
    maximumBytes,
  );
  await record.anchored.revalidate();
  return Buffer.from(result.bytes);
  } finally {
    release();
  }
}

export type PersistedReplayCheckpoint = Readonly<{
  statePath: string;
  checksum: string;
  byteSize: number;
}>;

function canonicalReplayCheckpointBytes(storageState: unknown): Buffer {
  const parsed = storageStateV1Schema.safeParse(storageState);
  if (!parsed.success) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "replay checkpoint storage state is invalid",
    );
  }
  const bytes = Buffer.from(canonicalJson(parsed.data), "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > CHECKPOINT_MAX_BYTES) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "replay checkpoint exceeds its byte limit",
    );
  }
  return bytes;
}

export async function persistHeldReplayCheckpoint(
  root: AnchoredProfileRoot,
  input: Readonly<{
    ownerId: string;
    scrapeId: string;
    checkpointId: string;
    storageState: unknown;
  }>,
): Promise<PersistedReplayCheckpoint> {
  if (
    !SAFE_OWNER.test(input.ownerId) ||
    !SAFE_OWNER.test(input.scrapeId) ||
    !UUID.test(input.checkpointId)
  ) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "replay checkpoint identity is invalid",
    );
  }
  const directoryPath = `replay/${input.ownerId}/${input.scrapeId}`;
  const statePath = `${directoryPath}/${input.checkpointId}.json`;
  const bytes = canonicalReplayCheckpointBytes(input.storageState);
  const record = requireRoot(root);
  const release = acquireRootOperation(record);
  try {
    await record.anchored.revalidate();
    const directory = await record.anchored.ensureDirectory(directoryPath);
    await closeRaw(directory, "replay-checkpoint-directory");
    await publishTemp(
      record.anchored,
      directoryPath,
      `.checkpoint-${input.checkpointId}.staging`,
      `${input.checkpointId}.json`,
      bytes,
    );
    await record.anchored.revalidate();
    return Object.freeze({
      statePath,
      checksum: sha256(bytes),
      byteSize: bytes.byteLength,
    });
  } finally {
    release();
  }
}

export async function deleteHeldReplayCheckpoint(
  root: AnchoredProfileRoot,
  input: Readonly<{ statePath: string; checksum: string }>,
): Promise<boolean> {
  assertCheckpointPath(input.statePath);
  if (!/^[a-f0-9]{64}$/u.test(input.checksum)) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "replay checkpoint checksum is invalid",
    );
  }
  const record = requireRoot(root);
  const release = acquireRootOperation(record);
  let parent: FileHandle | undefined;
  let pinned: PinnedLeaf | undefined;
  try {
    await record.anchored.revalidate();
    const opened = await record.anchored.openParent(input.statePath);
    parent = opened.parent;
    const existing = await record.anchored.lstatOptional(parent, opened.leaf);
    if (existing === null) {
      await call(record.anchored.admission, "repair-replay-parent", () =>
        parent!.sync(),
      );
      return false;
    }
    const file = await readRegularFileAt(
      record.anchored,
      parent,
      opened.leaf,
      CHECKPOINT_MAX_BYTES,
    );
    if (
      file.mode !== 0o600 ||
      sha256(file.bytes) !== input.checksum ||
      !Buffer.from(
        canonicalJson(
          storageStateV1Schema.parse(JSON.parse(file.bytes.toString("utf8"))),
        ),
        "utf8",
      ).equals(file.bytes)
    ) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "replay checkpoint deletion authority does not match",
      );
    }
    pinned = await pinLeaf(record.anchored, parent, opened.leaf);
    await assertRawPinnedLeaf(record.anchored, parent, opened.leaf, pinned);
    await call(record.anchored.admission, "delete-replay-checkpoint", () =>
      fs.unlink(procPath(parent!, opened.leaf)),
    );
    await call(record.anchored.admission, "fsync-replay-parent", () =>
      parent!.sync(),
    );
    await record.anchored.revalidate();
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return false;
    if (cause instanceof SyntaxError) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "replay checkpoint is corrupt",
      );
    }
    throw cause;
  } finally {
    await closeAll([
      [pinned?.handle, "replay-checkpoint-pin"],
      [parent, "replay-checkpoint-parent"],
    ]);
    release();
  }
}

export async function listHeldProfileGenerations(
  root: AnchoredProfileRoot,
  state: "working" | "staging" | "committed",
): Promise<readonly ProfileGenerationLocator[]> {
  const record = requireRoot(root);
  if (!PROFILE_STATES.has(state)) {
    throw unsafeCapability("profile inventory state is invalid");
  }
  const release = acquireRootOperation(record);
  try {
  await record.anchored.revalidate();
  let profiles: FileHandle | undefined;
  const results: ProfileGenerationLocator[] = [];
  try {
    try {
      profiles = (await openCapabilityDirectory(
        record,
        record.anchored.handle,
        "profiles",
      )).handle;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    results.push(...await validateProfileNamespaces(
      record,
      profiles,
      new Budget(MAX_RECONCILIATION_REFERENCES),
      state,
    ));
  } finally {
    if (profiles !== undefined) await profiles.close();
  }
  await record.anchored.revalidate();
  return Object.freeze(results.sort((left, right) =>
    rawCompare(
      `${left.profileId}/${left.generationId}`,
      `${right.profileId}/${right.generationId}`,
    ),
  ));
  } finally {
    release();
  }
}

export async function ensureAtomicPublicationNamespaces(
  root: AnchoredProfileRoot,
): Promise<void> {
  const record = requireRoot(root);
  const release = acquireRootOperation(record);
  const cleanup: PartialCreateCleanupRecord = {
    directories: [],
    handles: new Map(),
  };
  record.partialCreateCleanups.add(cleanup);
  try {
    await record.anchored.revalidate();
    const staging = await openOrCreateCapabilityDirectory(
      record,
      record.anchored.handle,
      ".profile-publish-staging",
      cleanup,
    );
    const stagingChain: readonly HeldCapabilityComponent[] = [
      {
        parent: record.anchored.handle,
        leaf: ".profile-publish-staging",
        handle: staging.handle,
        stat: staging.stat,
      },
    ];
    const intents = await openOrCreateCapabilityDirectory(
      record,
      staging.handle,
      "intents",
      cleanup,
      stagingChain,
    );
    const bundles = await openOrCreateCapabilityDirectory(
      record,
      staging.handle,
      "bundles",
      cleanup,
      stagingChain,
    );
    for (const directory of [staging, intents, bundles]) {
      if (
        directory.stat.uid !== atomicEffectiveUid() ||
        lowModeBigint(directory.stat.mode) !== 0o700 ||
        directory.stat.dev !== staging.stat.dev
      ) {
        throw atomicFailure("atomic publication namespace is invalid");
      }
    }
    cleanup.directories.length = 0;
    for (const handle of [bundles.handle, intents.handle, staging.handle]) {
      await closePartialCleanupHandle(
        cleanup,
        handle,
        "atomic-publication-namespace",
      );
    }
    record.partialCreateCleanups.delete(cleanup);
    await record.anchored.revalidate();
  } finally {
    try {
      await retryPartialCreateCleanup(record, cleanup);
    } finally {
      release();
    }
  }
}

async function openCapabilityDirectory(
  root: RootCapabilityRecord,
  parent: FileHandle,
  leaf: string,
  partialCleanup?: PartialCreateCleanupRecord,
): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  const before = await call(root.anchored.admission, "capability-lstat", () =>
    fs.lstat(procPath(parent, leaf), { bigint: true }),
  );
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw unsafeCapability("profile capability component is unsafe");
  }
  const handle = await callOpen(
    root.anchored.admission,
    "capability-open-directory",
    () =>
      fs.open(
        procPath(parent, leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
    partialCleanup === undefined
      ? undefined
      : (acquired) => {
          partialCleanup.handles.set(acquired, {
            point: "profile-create-cleanup",
            closed: false,
          });
        },
  );
  try {
    const after = await call(root.anchored.admission, "capability-stat", () =>
      handle.stat({ bigint: true }),
    );
    if (!sameObjectIdentity(before, after)) {
      throw unsafeCapability("profile capability binding changed");
    }
    return { handle, stat: after };
  } catch (error) {
    if (partialCleanup === undefined) {
      await closeRaw(handle, "capability-binding-failed");
    }
    throw error;
  }
}

async function removePinnedCreatedDirectory(
  directory: PartialCreateCleanupRecord["directories"][number],
  cleanup: PartialCreateCleanupRecord,
): Promise<void> {
  const cleanupCall = async <T>(point: string, operation: () => Promise<T>) => {
    await filesystemTestContext.getStore()?.beforeCleanup?.(point);
    return operation();
  };
  if (directory.phase === "created_unpinned") {
    const parentStat = await cleanupCall(
      "profile-create-cleanup-parent-stat",
      () => directory.parent.stat({ bigint: true }),
    );
    if (!sameObjectIdentity(directory.parentIdentity, parentStat)) {
      throw unsafeCapability("created profile parent identity changed");
    }
    let rebound: BigIntStats | undefined;
    try {
      rebound = await cleanupCall(
        "profile-create-cleanup-pin-lstat",
        () => fs.lstat(procPath(directory.parent, directory.leaf), {
          bigint: true,
        }),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        directory.phase = "fsync_pending";
      } else {
        throw error;
      }
    }
    if (directory.phase === "fsync_pending") {
      await cleanupCall("profile-create-cleanup-parent-sync", () =>
        directory.parent.sync(),
      );
      directory.phase = "done";
      return;
    }
    if (directory.creationIdentity === undefined) {
      throw unsafeCapability("created profile directory identity is unverified");
    }
    if (rebound === undefined) {
      throw unsafeCapability("created profile directory identity is unavailable");
    }
    if (!rebound.isDirectory() || rebound.isSymbolicLink()) {
      throw unsafeCapability("created profile directory type changed");
    }
    if (!sameObjectIdentity(directory.creationIdentity, rebound)) {
      throw unsafeCapability("created profile directory identity changed");
    }
    if (directory.pinHandle === undefined) {
      const handle = await cleanupCall(
        "profile-create-cleanup-pin-open",
        () => fs.open(
          procPath(directory.parent, directory.leaf),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      );
      directory.pinHandle = handle;
      cleanup.handles.set(handle, {
        point: "profile-create-cleanup",
        closed: false,
      });
    }
    const held = await cleanupCall(
      "profile-create-cleanup-pin-stat",
      () => directory.pinHandle!.stat({ bigint: true }),
    );
    if (!sameObjectIdentity(directory.creationIdentity, held)) {
      throw unsafeCapability("created profile directory binding changed");
    }
    directory.created = { handle: directory.pinHandle, stat: held };
    directory.phase = "remove_pending";
  }
  if (directory.phase === "remove_pending") {
    const created = directory.created;
    if (created === undefined) {
      throw unsafeCapability("created profile directory was not pinned");
    }
    const [held, rebound] = await Promise.all([
      cleanupCall("profile-create-cleanup-held-stat", () =>
        created.handle.stat({ bigint: true }),
      ),
      cleanupCall("profile-create-cleanup-rebound-stat", () =>
        fs.lstat(procPath(directory.parent, directory.leaf), { bigint: true }),
      ),
    ]);
    if (
      !sameObjectIdentity(created.stat, held) ||
      !sameObjectIdentity(held, rebound)
    ) {
      throw unsafeCapability("created profile directory identity changed");
    }
    await cleanupCall("profile-create-cleanup-remove", () =>
      fs.rmdir(procPath(directory.parent, directory.leaf)),
    );
    directory.phase = "fsync_pending";
  }
  if (directory.phase === "fsync_pending") {
    await cleanupCall("profile-create-cleanup-parent-sync", () =>
      directory.parent.sync(),
    );
    directory.phase = "done";
  }
}

const unverifiedProfileCleanupErrors = new WeakSet<object>();

export function isUnverifiedProfileCleanupError(error: unknown): boolean {
  return (
    (typeof error === "object" || typeof error === "function") &&
    error !== null &&
    unverifiedProfileCleanupErrors.has(error)
  );
}

function markUnverifiedProfileCleanup(
  cause: unknown,
): BrowserServiceError {
  const error = unsafeCapability("profile create cleanup is unverified");
  Object.defineProperty(error, "cause", { value: cause });
  unverifiedProfileCleanupErrors.add(error);
  return error;
}

async function retryPartialCreateCleanup(
  root: RootCapabilityRecord,
  cleanup: PartialCreateCleanupRecord,
): Promise<void> {
  const failures: unknown[] = [];
  for (const directory of [...cleanup.directories].reverse()) {
    if (directory.phase === "done") continue;
    try {
      await removePinnedCreatedDirectory(directory, cleanup);
    } catch (error) {
      failures.push(error);
    }
  }
  const cleanupDependencies = new Set<FileHandle>();
  for (const directory of cleanup.directories) {
    if (directory.phase === "created_unpinned") {
      cleanupDependencies.add(directory.parent);
      if (directory.pinHandle !== undefined) {
        cleanupDependencies.add(directory.pinHandle);
      }
    } else if (directory.phase === "remove_pending") {
      cleanupDependencies.add(directory.parent);
      if (directory.created !== undefined) {
        cleanupDependencies.add(directory.created.handle);
      }
    } else if (directory.phase === "fsync_pending") {
      cleanupDependencies.add(directory.parent);
    }
  }
  for (const [handle, owned] of cleanup.handles) {
    if (owned.closed || cleanupDependencies.has(handle)) continue;
    try {
      await closeRaw(handle, owned.point);
      owned.closed = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length !== 0) {
    root.acceptingOperations = false;
    throw markUnverifiedProfileCleanup(
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "partial profile create cleanup failed"),
    );
  }
  root.partialCreateCleanups.delete(cleanup);
}

async function closePartialCleanupHandle(
  cleanup: PartialCreateCleanupRecord,
  handle: FileHandle,
  point: string,
): Promise<void> {
  const owned = cleanup.handles.get(handle);
  if (owned === undefined || owned.closed) return;
  owned.point = point;
  await closeRaw(handle, point);
  owned.closed = true;
}

async function retryRootPartialCreateCleanups(
  root: RootCapabilityRecord,
): Promise<void> {
  const results = await Promise.allSettled(
    [...root.partialCreateCleanups].map((cleanup) =>
      retryPartialCreateCleanup(root, cleanup),
    ),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw markUnverifiedProfileCleanup(
      new AggregateError(failures, "profile create cleanup retry failed"),
    );
  }
}

type HeldCapabilityComponent = Readonly<{
  parent: FileHandle;
  leaf: string;
  handle: FileHandle;
  stat: BigIntStats;
}>;

async function revalidateCapabilityChain(
  root: RootCapabilityRecord,
  components: readonly HeldCapabilityComponent[],
): Promise<void> {
  await root.anchored.revalidate();
  for (const component of components) {
    const held = await call(root.anchored.admission, "capability-chain-stat", () =>
      component.handle.stat({ bigint: true }),
    );
    const rebound = await call(
      root.anchored.admission,
      "capability-chain-lstat",
      () => fs.lstat(procPath(component.parent, component.leaf), { bigint: true }),
    );
    if (
      !sameObjectIdentity(component.stat, held) ||
      !sameObjectIdentity(component.stat, rebound)
    ) {
      throw unsafeCapability("profile capability chain changed");
    }
  }
}

async function validateProfileNamespaces(
  root: RootCapabilityRecord,
  profiles: FileHandle,
  budget = new Budget(MAX_RECONCILIATION_REFERENCES),
  collectState?: "working" | "staging" | "committed",
  partialCleanup?: PartialCreateCleanupRecord,
): Promise<readonly ProfileGenerationLocator[]> {
  budget.take();
  const collected: ProfileGenerationLocator[] = [];
  const profilesEntries = await root.anchored.readdir(profiles, budget);
  for (const profileEntry of profilesEntries) {
    if (!UUID.test(profileEntry.name) || !profileEntry.isDirectory()) {
      throw unsafeCapability("profile namespace child is unsafe");
    }
    const profile = await openCapabilityDirectory(
      root,
      profiles,
      profileEntry.name,
      partialCleanup,
    );
    try {
      const stateEntries = await root.anchored.readdir(profile.handle, budget);
      const stateNames = new Set(stateEntries.map((entry) => entry.name));
      if (
        stateEntries.some(
          (entry) => !PROFILE_STATES.has(entry.name) || !entry.isDirectory(),
        ) ||
        [...PROFILE_STATES].some((state) => !stateNames.has(state))
      ) {
        throw unsafeCapability("profile state namespace is unsafe");
      }
      for (const stateEntry of stateEntries) {
        const state = await openCapabilityDirectory(
          root,
          profile.handle,
          stateEntry.name,
          partialCleanup,
        );
        try {
          const generations = await root.anchored.readdir(state.handle, budget);
          for (const generation of generations) {
            const tombstone =
              stateEntry.name === "working" &&
              DELETION_TOMBSTONE.test(generation.name);
            if (
              !generation.isDirectory() ||
              (!UUID.test(generation.name) && !tombstone)
            ) {
              throw unsafeCapability("profile generation namespace is unsafe");
            }
            if (
              stateEntry.name === collectState &&
              UUID.test(generation.name)
            ) {
              collected.push(Object.freeze({
                profileId: profileEntry.name,
                state: collectState,
                generationId: generation.name,
                openMode: "existing" as const,
              }));
            }
          }
        } finally {
          if (partialCleanup === undefined) await state.handle.close();
          else await closePartialCleanupHandle(
            partialCleanup,
            state.handle,
            "profile-validation-state",
          );
        }
      }
    } finally {
      if (partialCleanup === undefined) await profile.handle.close();
      else await closePartialCleanupHandle(
        partialCleanup,
        profile.handle,
        "profile-validation-profile",
      );
    }
  }
  return Object.freeze(collected);
}

async function openOrCreateCapabilityDirectory(
  root: RootCapabilityRecord,
  parent: FileHandle,
  leaf: string,
  partialCleanup: PartialCreateCleanupRecord,
  ancestors: readonly HeldCapabilityComponent[] = [],
): Promise<{ handle: FileHandle; stat: BigIntStats; created: boolean }> {
  await revalidateCapabilityChain(root, ancestors);
  const parentIdentity = await call(
    root.anchored.admission,
    "capability-create-parent-stat",
    () => parent.stat({ bigint: true }),
  );
  let created = false;
  let createdDirectory: { handle: FileHandle; stat: BigIntStats } | undefined;
  let provisional:
    | PartialCreateCleanupRecord["directories"][number]
    | undefined;
  try {
    await callHeldExclusiveMkdir(
      root.anchored.admission,
      "capability-mkdir-exclusive",
      () => revalidateCapabilityChain(root, ancestors),
      () =>
        fs.mkdir(procPath(parent, leaf), {
          recursive: false,
          mode: 0o700,
        }),
      () => {
        created = true;
        provisional = {
          parent,
          parentIdentity,
          leaf,
          phase: "created_unpinned",
        };
        partialCleanup.directories.push(provisional);
      },
    );
    const creationIdentity = await call(
      root.anchored.admission,
      "capability-lstat-created-directory",
      () => fs.lstat(procPath(parent, leaf), { bigint: true }),
    );
    if (!creationIdentity.isDirectory() || creationIdentity.isSymbolicLink()) {
      throw unsafeCapability("created profile directory type is unsafe");
    }
    provisional!.creationIdentity = creationIdentity;
    const handle = await callOpen(
      root.anchored.admission,
      "capability-open-created-directory",
      () => fs.open(
        procPath(parent, leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
      (acquired) => {
        provisional!.pinHandle = acquired;
        partialCleanup.handles.set(acquired, {
          point: "profile-create-cleanup",
          closed: false,
        });
      },
    );
    const stat = await call(
      root.anchored.admission,
      "capability-stat-created-directory",
      () => handle.stat({ bigint: true }),
    );
    if (!sameObjectIdentity(creationIdentity, stat)) {
      throw unsafeCapability("created profile directory binding changed");
    }
    createdDirectory = { handle, stat };
    provisional!.created = createdDirectory;
    provisional!.phase = "remove_pending";
    await finishHeldExclusiveMkdir(
      root.anchored.admission,
      "capability-mkdir-exclusive",
      () => revalidateCapabilityChain(root, ancestors),
    );
    await revalidateCapabilityChain(root, ancestors);
    await callHeldMutation(root.anchored.admission, "capability-mkdir-parent-sync", () =>
      revalidateCapabilityChain(root, ancestors), () =>
      parent.sync(),
    );
    await revalidateCapabilityChain(root, ancestors);
  } catch (error) {
    if (
      provisional !== undefined ||
      !isNodeError(error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const opened = createdDirectory ?? await openCapabilityDirectory(
    root,
    parent,
    leaf,
    partialCleanup,
  );
  try {
    await revalidateCapabilityChain(root, [
      ...ancestors,
      { parent, leaf, handle: opened.handle, stat: opened.stat },
    ]);
    return { ...opened, created };
  } catch (error) {
    throw error;
  }
}

function generationToken(
  record: GenerationCapabilityRecord,
): BoundProfileGeneration {
  const token = Object.freeze({
    transitionTo: async (state: "staging" | "committed") => {
      const current = requireGeneration(token);
      const release = await acquireGenerationOperation(current, true);
      try {
        return await transitionGeneration(token, state);
      } finally {
        release();
      }
    },
    remove: async () => {
      const current = requireGeneration(token);
      if (current.locator.state !== "working") {
        throw unsafeCapability("profile generation removal is not authorized");
      }
      const release = await acquireGenerationOperation(current, true);
      try {
        await removeGeneration(token);
      } finally {
        release();
      }
    },
    close: () => closeGeneration(token),
  }) as BoundProfileGeneration;
  generationCapabilityRecords.set(token, record);
  record.root.children.add(record);
  return token;
}

export async function bindProfileGeneration(
  root: AnchoredProfileRoot,
  locator: ProfileGenerationLocator,
): Promise<BoundProfileGeneration> {
  const rootRecord = requireRoot(root);
  if (
    !UUID.test(locator.profileId) ||
    !UUID.test(locator.generationId) ||
    !PROFILE_STATES.has(locator.state) ||
    (locator.openMode === "create_exclusive" && locator.state !== "working")
  ) {
    throw unsafeCapability("profile generation locator is invalid");
  }
  const releaseRootOperation = acquireRootOperation(rootRecord);
  const partialCleanup: PartialCreateCleanupRecord = {
    directories: [],
    handles: new Map(),
  };
  rootRecord.partialCreateCleanups.add(partialCleanup);
  const unusedStateHandles: FileHandle[] = [];
  let createdGeneration:
    | { handle: FileHandle; stat: BigIntStats }
    | undefined;
  let createdGenerationDirectory:
    | PartialCreateCleanupRecord["directories"][number]
    | undefined;
  try {
    await rootRecord.anchored.revalidate();
    const profiles =
      locator.openMode === "create_exclusive"
        ? await openOrCreateCapabilityDirectory(
            rootRecord,
            rootRecord.anchored.handle,
            "profiles",
            partialCleanup,
          )
        : await openCapabilityDirectory(
            rootRecord,
            rootRecord.anchored.handle,
            "profiles",
            partialCleanup,
          );
    await validateProfileNamespaces(
      rootRecord,
      profiles.handle,
      new Budget(MAX_RECONCILIATION_REFERENCES),
      undefined,
      partialCleanup,
    );
    const profile =
      locator.openMode === "create_exclusive"
        ? await openOrCreateCapabilityDirectory(
            rootRecord,
            profiles.handle,
            locator.profileId,
            partialCleanup,
            [
              {
                parent: rootRecord.anchored.handle,
                leaf: "profiles",
                handle: profiles.handle,
                stat: profiles.stat,
              },
            ],
          )
        : await openCapabilityDirectory(
            rootRecord,
            profiles.handle,
            locator.profileId,
            partialCleanup,
          );
    const profileCreated =
      locator.openMode === "create_exclusive" &&
      "created" in profile &&
      profile.created;
    if (locator.openMode === "create_exclusive" && !profileCreated) {
      await validateProfileNamespaces(
        rootRecord,
        profiles.handle,
        new Budget(MAX_RECONCILIATION_REFERENCES),
        undefined,
        partialCleanup,
      );
    }
    let state: { handle: FileHandle; stat: BigIntStats } | undefined;
    if (locator.openMode === "create_exclusive") {
      const profileChain: HeldCapabilityComponent[] = [
        {
          parent: rootRecord.anchored.handle,
          leaf: "profiles",
          handle: profiles.handle,
          stat: profiles.stat,
        },
        {
          parent: profiles.handle,
          leaf: locator.profileId,
          handle: profile.handle,
          stat: profile.stat,
        },
      ];
      for (const stateName of ["working", "staging", "committed"] as const) {
        const candidate = profileCreated
          ? await openOrCreateCapabilityDirectory(
              rootRecord,
              profile.handle,
              stateName,
              partialCleanup,
              profileChain,
            )
          : await openCapabilityDirectory(
              rootRecord,
              profile.handle,
              stateName,
              partialCleanup,
            );
        if (stateName === locator.state) {
          state = candidate;
        } else {
          unusedStateHandles.push(candidate.handle);
        }
      }
      // A complete three-state profile namespace is durable infrastructure,
      // even when generation creation later fails. Only partial namespace
      // construction is rolled back.
      partialCleanup.directories.length = 0;
    } else {
      state = await openCapabilityDirectory(
        rootRecord,
        profile.handle,
        locator.state,
        partialCleanup,
      );
    }
    if (state === undefined) throw unsafeCapability("profile state was not held");
    if (locator.openMode === "create_exclusive") {
      const stateChain: HeldCapabilityComponent[] = [
        {
          parent: rootRecord.anchored.handle,
          leaf: "profiles",
          handle: profiles.handle,
          stat: profiles.stat,
        },
        {
          parent: profiles.handle,
          leaf: locator.profileId,
          handle: profile.handle,
          stat: profile.stat,
        },
        {
          parent: profile.handle,
          leaf: locator.state,
          handle: state.handle,
          stat: state.stat,
        },
      ];
      await revalidateCapabilityChain(rootRecord, stateChain);
      await callHeldExclusiveMkdir(
        rootRecord.anchored.admission,
        "profile-mkdir-generation",
        () => revalidateCapabilityChain(rootRecord, stateChain),
        () =>
          fs.mkdir(procPath(state.handle, locator.generationId), {
            recursive: false,
            mode: 0o700,
          }),
        () => {
          createdGenerationDirectory = {
            parent: state.handle,
            parentIdentity: state.stat,
            leaf: locator.generationId,
            phase: "created_unpinned",
          };
          partialCleanup.directories.push(createdGenerationDirectory);
        },
      );
      const creationIdentity = await call(
        rootRecord.anchored.admission,
        "profile-lstat-created-generation",
        () => fs.lstat(
          procPath(state.handle, locator.generationId),
          { bigint: true },
        ),
      );
      if (
        !creationIdentity.isDirectory() ||
        creationIdentity.isSymbolicLink()
      ) {
        throw unsafeCapability("created profile generation type is unsafe");
      }
      createdGenerationDirectory!.creationIdentity = creationIdentity;
      const handle = await callOpen(
        rootRecord.anchored.admission,
        "profile-open-created-generation",
        () => fs.open(
          procPath(state.handle, locator.generationId),
          constants.O_RDONLY |
            constants.O_DIRECTORY |
            constants.O_NOFOLLOW,
        ),
        (acquired) => {
          createdGenerationDirectory!.pinHandle = acquired;
          partialCleanup.handles.set(acquired, {
            point: "profile-create-cleanup",
            closed: false,
          });
        },
      );
      const stat = await call(
        rootRecord.anchored.admission,
        "profile-stat-created-generation",
        () => handle.stat({ bigint: true }),
      );
      if (!sameObjectIdentity(creationIdentity, stat)) {
        throw unsafeCapability("created profile generation binding changed");
      }
      createdGeneration = { handle, stat };
      createdGenerationDirectory!.created = createdGeneration;
      createdGenerationDirectory!.phase = "remove_pending";
      await finishHeldExclusiveMkdir(
        rootRecord.anchored.admission,
        "profile-mkdir-generation",
        () => revalidateCapabilityChain(rootRecord, stateChain),
      );
      await revalidateCapabilityChain(rootRecord, stateChain);
      await revalidateCapabilityChain(rootRecord, [
        ...stateChain,
        {
          parent: state.handle,
          leaf: locator.generationId,
          handle: createdGeneration.handle,
          stat: createdGeneration.stat,
        },
      ]);
      await revalidateCapabilityChain(rootRecord, stateChain);
      await callHeldMutation(rootRecord.anchored.admission, "profile-fsync-state", () =>
        revalidateCapabilityChain(rootRecord, stateChain), () =>
        state.handle.sync(),
      );
      await revalidateCapabilityChain(rootRecord, stateChain);
    }
    const generation =
      createdGeneration ??
      (await openCapabilityDirectory(
        rootRecord,
        state.handle,
        locator.generationId,
        partialCleanup,
      ));
    await rootRecord.anchored.revalidate();
    await Promise.all(
      unusedStateHandles.map((handle) =>
        closePartialCleanupHandle(
          partialCleanup,
          handle,
          "unused-created-state",
        ),
      ),
    );
    partialCleanup.directories.length = 0;
    for (const handle of [
      profiles.handle,
      profile.handle,
      state.handle,
      generation.handle,
    ]) {
      partialCleanup.handles.delete(handle);
    }
    rootRecord.partialCreateCleanups.delete(partialCleanup);
    return generationToken({
      state: "live",
      root: rootRecord,
      locator: Object.freeze({ ...locator, openMode: "existing" }),
      profiles: profiles.handle,
      profile: profile.handle,
      stateHandle: state.handle,
      generation: generation.handle,
      identities: Object.freeze([
        profiles.stat,
        profile.stat,
        state.stat,
        generation.stat,
      ]),
      acceptingOperations: true,
      activeOperations: 0,
      operationTail: Promise.resolve(),
      drainWaiters: new Set(),
      attachmentCount: 0,
    });
  } catch (error) {
    try {
      await retryPartialCreateCleanup(rootRecord, partialCleanup);
    } catch (cleanupError) {
      rootRecord.acceptingOperations = false;
      throw markUnverifiedProfileCleanup(
        new AggregateError(
          [error, cleanupError],
          "profile acquisition cleanup failed",
        ),
      );
    }
    throw error;
  } finally {
    releaseRootOperation();
  }
}

function requireGeneration(
  generation: BoundProfileGeneration,
): GenerationCapabilityRecord {
  const record = generationCapabilityRecords.get(generation as object);
  if (record === undefined || record.state !== "live") {
    throw unsafeCapability("profile generation is not live");
  }
  if (record.root.state !== "live") {
    throw unsafeCapability("profile generation root is not live");
  }
  assertAdmitted(record.root.anchored.admission);
  return record;
}

async function revalidateGeneration(
  record: GenerationCapabilityRecord,
): Promise<void> {
  await record.root.anchored.revalidate();
  const chain = [
    record.profiles,
    record.profile,
    record.stateHandle,
    record.generation,
  ];
  const parents = [
    record.root.anchored.handle,
    record.profiles,
    record.profile,
    record.stateHandle,
  ];
  const leaves = [
    "profiles",
    record.locator.profileId,
    record.locator.state,
    record.deletionLeaf ?? record.locator.generationId,
  ];
  for (let index = 0; index < chain.length; index += 1) {
    const held = await call(
      record.root.anchored.admission,
      "generation-held-stat",
      () => chain[index]!.stat({ bigint: true }),
    );
    const rebound = await call(
      record.root.anchored.admission,
      "generation-parent-lstat",
      () => fs.lstat(procPath(parents[index]!, leaves[index]), { bigint: true }),
    );
    if (
      !sameObjectIdentity(record.identities[index]!, held) ||
      !sameObjectIdentity(record.identities[index]!, rebound)
    ) {
      throw unsafeCapability("profile generation chain changed");
    }
  }
}

async function revalidateGenerationParentChain(
  record: GenerationCapabilityRecord,
): Promise<void> {
  await record.root.anchored.revalidate();
  const chain = [record.profiles, record.profile, record.stateHandle];
  const parents = [
    record.root.anchored.handle,
    record.profiles,
    record.profile,
  ];
  const leaves = ["profiles", record.locator.profileId, record.locator.state];
  for (let index = 0; index < chain.length; index += 1) {
    const held = await call(
      record.root.anchored.admission,
      "generation-parent-chain-stat",
      () => chain[index]!.stat({ bigint: true }),
    );
    const rebound = await call(
      record.root.anchored.admission,
      "generation-parent-chain-lstat",
      () => fs.lstat(procPath(parents[index]!, leaves[index]), { bigint: true }),
    );
    if (
      !sameObjectIdentity(record.identities[index]!, held) ||
      !sameObjectIdentity(record.identities[index]!, rebound)
    ) {
      throw unsafeCapability("profile generation parent chain changed");
    }
  }
}

function publicTreeEvidence(tree: ProfileHashResult): CanonicalProfileTreeEvidence {
  return Object.freeze({
    canonicalJson: tree.canonicalJson,
    checksum: tree.checksum,
    byteSize: tree.byteSize,
    maxMtimeMs: tree.maxMtimeMs,
    entries: Object.freeze(
      tree.evidence.map((entry) =>
        Object.freeze({
          path: entry.path,
          type: entry.type,
          dev: String(entry.stat.dev),
          ino: String(entry.stat.ino),
          nlink: String(entry.stat.nlink),
          mode: lowModeBigint(entry.stat.mode),
          size: Number(entry.stat.size),
          sha256: entry.sha256,
        }),
      ),
    ),
    fileCount: tree.evidence.filter((entry) => entry.type === "file").length,
  });
}

async function heldProfileHash(
  record: GenerationCapabilityRecord,
): Promise<ProfileHashResult> {
  await revalidateGeneration(record);
  const budget = new Budget(MAX_RECONCILIATION_REFERENCES);
  budget.take();
  const first = await hashProfileTreeAt(
    record.root.anchored,
    record.generation,
    budget,
  );
  const final = await validateProfileEvidenceRaw(
    record.root.anchored,
    record.generation,
    first.evidence,
  );
  if (
    final.checksum !== first.checksum ||
    final.byteSize !== first.byteSize
  ) {
    throw unsafeCapability("held profile tree changed during hashing");
  }
  await revalidateGeneration(record);
  return { ...final, evidence: first.evidence };
}

export async function canonicalizeHeldProfileTree(
  generation: BoundProfileGeneration,
): Promise<CanonicalProfileTreeEvidence> {
  const record = requireGeneration(generation);
  const release = await acquireGenerationOperation(record);
  try {
    await validateProfileNamespaces(record.root, record.profiles);
    return publicTreeEvidence(await heldProfileHash(record));
  } finally {
    release();
  }
}

async function openEvidenceEntry(
  record: GenerationCapabilityRecord,
  entry: ProfileTreeEvidence,
): Promise<{
  handle: FileHandle;
  owned: FileHandle[];
  components: readonly HeldRawProfileComponent[];
}> {
  if (entry.path === "") {
    return { handle: record.generation, owned: [], components: [] };
  }
  const opened = await openRawProfileParent(
    record.root.anchored,
    record.generation,
    entry.path,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await callOpen(
      record.root.anchored.admission,
      "held-evidence-open",
      () =>
        fs.open(
          procPath(opened.parent, opened.leaf),
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            (entry.type === "directory" ? constants.O_DIRECTORY : 0),
        ),
    );
    const stat = await call(
      record.root.anchored.admission,
      "held-evidence-stat",
      () => handle!.stat({ bigint: true }),
    );
    if (!sameLeafIdentity(entry.stat, stat)) {
      throw unsafeCapability("held profile evidence changed");
    }
    return {
      handle,
      owned: [...opened.owned, handle],
      components: opened.components,
    };
  } catch (error) {
    await closeAllDirect([
      ...(handle === undefined ? [] : [handle]),
      ...opened.owned,
    ]).catch(() => undefined);
    throw error;
  }
}

async function syncAndCanonicalizeGenerationRecord(
  record: GenerationCapabilityRecord,
): Promise<CanonicalProfileTreeEvidence> {
  const before = await heldProfileHash(record);
  const ordered = [...before.evidence].sort((left, right) => {
    if (left.type !== right.type) return left.type === "file" ? -1 : 1;
    return right.path.split("/").length - left.path.split("/").length;
  });
  for (const entry of ordered) {
    const opened = await openEvidenceEntry(record, entry);
    try {
      const revalidateSyncChain = async (): Promise<void> => {
        await revalidateGeneration(record);
        await revalidateRawProfileParent(
          record.root.anchored,
          record.generation,
          record.identities[3]!,
          opened,
        );
      };
      await callHeldMutation(record.root.anchored.admission, "held-profile-sync", revalidateSyncChain, () =>
        opened.handle.sync(),
      );
      const after = await call(
        record.root.anchored.admission,
        "held-profile-sync-stat",
        () => opened.handle.stat({ bigint: true }),
      );
      if (!sameLeafIdentity(entry.stat, after)) {
        throw unsafeCapability("held profile changed during sync");
      }
    } finally {
      await closeAllDirect(opened.owned);
    }
  }
  const after = await heldProfileHash(record);
  if (
    after.checksum !== before.checksum ||
    after.byteSize !== before.byteSize ||
    after.evidence.some(
      (entry, index) =>
        before.evidence[index] === undefined ||
        !sameLeafIdentity(before.evidence[index]!.stat, entry.stat),
    )
  ) {
    throw unsafeCapability("held profile changed after sync");
  }
  return publicTreeEvidence(after);
}

export async function syncAndCanonicalizeHeldProfileTree(
  generation: BoundProfileGeneration,
): Promise<CanonicalProfileTreeEvidence> {
  const record = requireGeneration(generation);
  const release = await acquireGenerationOperation(record);
  try {
    await validateProfileNamespaces(record.root, record.profiles);
    return await syncAndCanonicalizeGenerationRecord(record);
  } finally {
    release();
  }
}

async function transitionGeneration(
  token: BoundProfileGeneration,
  destination: "staging" | "committed",
): Promise<BoundProfileGeneration> {
  const record = requireGeneration(token);
  if (
    (record.locator.state === "working" && destination !== "staging") ||
    (record.locator.state === "staging" && destination !== "committed") ||
    record.locator.state === "committed"
  ) {
    throw unsafeCapability("profile generation transition is invalid");
  }
  await validateProfileNamespaces(record.root, record.profiles);
  record.acceptingOperations = false;
  record.state = "consuming";
  let destinationState: FileHandle | undefined;
  let destinationStat: BigIntStats | undefined;
  let renamed = false;
  try {
    await revalidateGeneration(record);
    const opened = await openCapabilityDirectory(
      record.root,
      record.profile,
      destination,
    );
    destinationState = opened.handle;
    destinationStat = opened.stat;
    await revalidateGeneration(record);
    const revalidateTransitionPreChains = async (): Promise<void> => {
      await revalidateGeneration(record);
      await revalidateCapabilityChain(record.root, [
        {
          parent: record.root.anchored.handle,
          leaf: "profiles",
          handle: record.profiles,
          stat: record.identities[0]!,
        },
        {
          parent: record.profiles,
          leaf: record.locator.profileId,
          handle: record.profile,
          stat: record.identities[1]!,
        },
        {
          parent: record.profile,
          leaf: destination,
          handle: destinationState!,
          stat: destinationStat!,
        },
      ]);
    };
    await call(
      record.root.anchored.admission,
      "profile-state-transition",
      async () => {
        await revalidateTransitionPreChains();
        await fs.rename(
          procPath(record.stateHandle, record.locator.generationId),
          procPath(destinationState!, record.locator.generationId),
        );
        renamed = true;
      },
    );
    const revalidateTransitionChains = async (): Promise<void> => {
      const sourceStateStat = await call(
        record.root.anchored.admission,
        "profile-transition-source-state-stat",
        () => record.stateHandle.stat({ bigint: true }),
      );
      if (!sameObjectIdentity(record.identities[2]!, sourceStateStat)) {
        throw unsafeCapability("profile transition source state changed");
      }
      await revalidateGeneration({
        ...record,
        state: "live",
        locator: Object.freeze({
          ...record.locator,
          state: destination,
          openMode: "existing",
        }),
        stateHandle: destinationState!,
        identities: Object.freeze([
          record.identities[0]!,
          record.identities[1]!,
          destinationStat!,
          record.identities[3]!,
        ]),
      });
    };
    await revalidateTransitionChains();
    await call(record.root.anchored.admission, "profile-source-state-sync", () =>
      record.stateHandle.sync(),
    );
    await revalidateTransitionChains();
    await call(
      record.root.anchored.admission,
      "profile-destination-state-sync",
      () => destinationState!.sync(),
    );
    await revalidateTransitionChains();
    const generationStat = await call(
      record.root.anchored.admission,
      "profile-transition-generation-stat",
      () => record.generation.stat({ bigint: true }),
    );
    const rebound = await call(
      record.root.anchored.admission,
      "profile-transition-generation-lstat",
      () =>
        fs.lstat(
          procPath(destinationState!, record.locator.generationId),
          { bigint: true },
        ),
    );
    if (
      !sameObjectIdentity(record.identities[3]!, generationStat) ||
      !sameObjectIdentity(record.identities[3]!, rebound)
    ) {
      throw unsafeCapability("transitioned generation binding changed");
    }
    record.state = "consumed";
    record.root.children.delete(record);
    signalRootChildDrain(record.root);
    await closeRaw(record.stateHandle, "transition-source-state");
    const nextRecord: GenerationCapabilityRecord = {
      ...record,
      state: "live",
      locator: Object.freeze({
        ...record.locator,
        state: destination,
        openMode: "existing",
      }),
      stateHandle: destinationState,
      identities: Object.freeze([
        record.identities[0]!,
        record.identities[1]!,
        opened.stat,
        record.identities[3]!,
      ]),
      acceptingOperations: true,
      activeOperations: 0,
      operationTail: Promise.resolve(),
      drainWaiters: new Set(),
    };
    destinationState = undefined;
    return generationToken(nextRecord);
  } catch (error) {
    if (renamed && destinationState !== undefined && destinationStat !== undefined) {
      record.state = "consumed";
      record.root.children.delete(record);
      signalRootChildDrain(record.root);
      generationCapabilityRecords.delete(token as object);
      await record.stateHandle.close().catch(() => undefined);
      const recovered = generationToken({
        ...record,
        state: "live",
        locator: Object.freeze({
          ...record.locator,
          state: destination,
          openMode: "existing",
        }),
        stateHandle: destinationState,
        identities: Object.freeze([
          record.identities[0]!,
          record.identities[1]!,
          destinationStat,
          record.identities[3]!,
        ]),
        acceptingOperations: true,
        activeOperations: 0,
        operationTail: Promise.resolve(),
        drainWaiters: new Set(),
      });
      destinationState = undefined;
      const recoveryError = error instanceof Error ? error : unsafeCapability(
        "profile transition failed after rename",
      );
      transitionRecoveryRecords.set(recoveryError, recovered);
      throw recoveryError;
    }
    record.state = "live";
    record.acceptingOperations = true;
    await destinationState?.close().catch(() => undefined);
    throw error;
  }
}

async function closeGeneration(token: BoundProfileGeneration): Promise<void> {
  const record = generationCapabilityRecords.get(token as object);
  if (
    record === undefined ||
    (record.state !== "live" && record.state !== "close_unverified")
  ) {
    throw unsafeCapability("profile generation is not live");
  }
  if (record.attachmentCount !== 0) {
    throw unsafeCapability("profile generation has live Chromium attachments");
  }
  record.acceptingOperations = false;
  record.state = "consuming";
  try {
    await waitCapabilityDrain(record);
    await closeAll([
      [record.generation, "generation"],
      [record.stateHandle, "generation-state"],
      [record.profile, "generation-profile"],
      [record.profiles, "generation-profiles"],
    ]);
    record.state = "closed";
    record.root.children.delete(record);
    signalRootChildDrain(record.root);
    generationCapabilityRecords.delete(token as object);
  } catch (error) {
    record.state = "close_unverified";
    record.root.acceptingOperations = false;
    signalRootChildDrain(record.root);
    throw error;
  }
}

export async function copyHeldProfileTree(
  source: BoundProfileGeneration,
  destination: BoundProfileGeneration,
): Promise<CanonicalProfileTreeEvidence> {
  const sourceRecord = requireGeneration(source);
  const destinationRecord = requireGeneration(destination);
  if (
    sourceRecord.root !== destinationRecord.root ||
    sourceRecord.locator.state !== "committed" ||
    destinationRecord.locator.state !== "working"
  ) {
    throw unsafeCapability("profile copy capability states are invalid");
  }
  await validateProfileNamespaces(sourceRecord.root, sourceRecord.profiles);
  let sourceLease: Promise<() => void> | undefined;
  let destinationLease: Promise<() => void>;
  try {
    sourceLease = acquireGenerationOperation(sourceRecord);
    destinationLease = acquireGenerationOperation(destinationRecord);
  } catch (error) {
    if (sourceLease !== undefined) (await sourceLease)();
    throw error;
  }
  const [releaseSource, releaseDestination] = await Promise.all([
    sourceLease,
    destinationLease,
  ]);
  try {
  const revalidateCopyChains = async (): Promise<void> => {
    await revalidateGeneration(sourceRecord);
    await revalidateGeneration(destinationRecord);
  };
  await revalidateCopyChains();
  const sourceTree = await heldProfileHash(sourceRecord);
  const destinationBefore = await heldProfileHash(destinationRecord);
  if (
    destinationBefore.evidence.length !== 1 ||
    destinationBefore.evidence[0]?.path !== ""
  ) {
    throw unsafeCapability("profile copy destination is not empty");
  }
  const directories = sourceTree.evidence
    .filter((entry) => entry.type === "directory" && entry.path !== "")
    .sort(
      (left, right) =>
        left.path.split("/").length - right.path.split("/").length,
    );
  for (const entry of directories) {
    const sourceOpened = await openEvidenceEntry(sourceRecord, entry);
    const opened = await openRawProfileParent(
      destinationRecord.root.anchored,
      destinationRecord.generation,
      entry.path,
    );
    const directoryCleanup: PartialCreateCleanupRecord = {
      directories: [],
      handles: new Map(),
    };
    destinationRecord.root.partialCreateCleanups.add(directoryCleanup);
    let created: FileHandle | undefined;
    let provisional:
      | PartialCreateCleanupRecord["directories"][number]
      | undefined;
    try {
      const revalidateDirectoryChains = async (): Promise<void> => {
        await revalidateCopyChains();
        await revalidateRawProfileParent(
          sourceRecord.root.anchored,
          sourceRecord.generation,
          sourceRecord.identities[3]!,
          sourceOpened,
        );
        await revalidateRawProfileParent(
          destinationRecord.root.anchored,
          destinationRecord.generation,
          destinationRecord.identities[3]!,
          opened,
        );
      };
      await revalidateDirectoryChains();
      const parentIdentity = await call(
        destinationRecord.root.anchored.admission,
        "held-copy-create-parent-stat",
        () => opened.parent.stat({ bigint: true }),
      );
      await callHeldExclusiveMkdir(
        destinationRecord.root.anchored.admission,
        "held-copy-mkdir",
        revalidateDirectoryChains,
        () =>
          fs.mkdir(procPath(opened.parent, opened.leaf), {
            recursive: false,
            mode: lowModeBigint(entry.stat.mode),
          }),
        () => {
          provisional = {
            parent: opened.parent,
            parentIdentity,
            leaf: opened.leaf,
            phase: "created_unpinned",
          };
          directoryCleanup.directories.push(provisional);
        },
      );
      await revalidateDirectoryChains();
      const creationIdentity = await call(
        destinationRecord.root.anchored.admission,
        "held-copy-lstat-created-directory",
        () => fs.lstat(procPath(opened.parent, opened.leaf), { bigint: true }),
      );
      if (
        !creationIdentity.isDirectory() ||
        creationIdentity.isSymbolicLink()
      ) {
        throw unsafeCapability("copied profile directory type is unsafe");
      }
      provisional!.creationIdentity = creationIdentity;
      created = await callOpen(
        destinationRecord.root.anchored.admission,
        "held-copy-open-directory",
        () =>
          fs.open(
            procPath(opened.parent, opened.leaf),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
        (acquired) => {
          provisional!.pinHandle = acquired;
          directoryCleanup.handles.set(acquired, {
            point: "held-copy-directory",
            closed: false,
          });
        },
      );
      const createdStat = await call(
        destinationRecord.root.anchored.admission,
        "held-copy-stat-created-directory",
        () => created!.stat({ bigint: true }),
      );
      if (!sameObjectIdentity(creationIdentity, createdStat)) {
        throw unsafeCapability("copied profile directory binding changed");
      }
      provisional!.created = { handle: created, stat: createdStat };
      provisional!.phase = "remove_pending";
      await finishHeldExclusiveMkdir(
        destinationRecord.root.anchored.admission,
        "held-copy-mkdir",
        revalidateDirectoryChains,
      );
      await revalidateDirectoryChains();
      await callHeldMutation(
        destinationRecord.root.anchored.admission,
        "held-copy-directory-sync",
        revalidateDirectoryChains,
        () => created!.sync(),
      );
      await revalidateDirectoryChains();
      await callHeldMutation(
        destinationRecord.root.anchored.admission,
        "held-copy-parent-sync",
        revalidateDirectoryChains,
        () => opened.parent.sync(),
      );
      await revalidateDirectoryChains();
      directoryCleanup.directories.length = 0;
    } finally {
      const cleanupResults = await Promise.allSettled([
        retryPartialCreateCleanup(destinationRecord.root, directoryCleanup),
        closeAllDirect([...opened.owned, ...sourceOpened.owned]),
      ]);
      const cleanupFailures = cleanupResults
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      if (cleanupFailures.length > 1) {
        throw new AggregateError(
          cleanupFailures,
          "held copy directory cleanup failed",
        );
      }
    }
  }
  for (const entry of sourceTree.evidence.filter(
    (candidate) => candidate.type === "file",
  )) {
    const sourceOpened = await openEvidenceEntry(sourceRecord, entry);
    const destinationOpened = await openRawProfileParent(
      destinationRecord.root.anchored,
      destinationRecord.generation,
      entry.path,
    );
    const outputCleanup: PartialCreateCleanupRecord = {
      directories: [],
      handles: new Map(),
    };
    destinationRecord.root.partialCreateCleanups.add(outputCleanup);
    let output: FileHandle | undefined;
    try {
      const revalidateFileChains = async (): Promise<void> => {
        await revalidateCopyChains();
        await revalidateRawProfileParent(
          sourceRecord.root.anchored,
          sourceRecord.generation,
          sourceRecord.identities[3]!,
          sourceOpened,
        );
        await revalidateRawProfileParent(
          destinationRecord.root.anchored,
          destinationRecord.generation,
          destinationRecord.identities[3]!,
          destinationOpened,
        );
      };
      await revalidateFileChains();
      output = await callHeldOpenMutation(
        destinationRecord.root.anchored.admission,
        "held-copy-create-file",
        revalidateFileChains,
        () =>
          fs.open(
            procPath(destinationOpened.parent, destinationOpened.leaf),
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            lowModeBigint(entry.stat.mode),
          ),
        {
          cleanup: outputCleanup,
          point: "held-copy-output",
        },
      );
      await revalidateFileChains();
      const expected = Number(entry.stat.size);
      const digest = createHash("sha256");
      let offset = 0;
      while (offset < expected) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expected - offset));
        const read = await call(
          sourceRecord.root.anchored.admission,
          "held-copy-read",
          () => sourceOpened.handle.read(chunk, 0, chunk.length, offset),
        );
        await revalidateFileChains();
        if (read.bytesRead === 0) {
          throw unsafeCapability("profile copy source was truncated");
        }
        const bytes = chunk.subarray(0, read.bytesRead);
        digest.update(bytes);
        let written = 0;
        while (written < bytes.length) {
          const result = await callHeldMutation(
            destinationRecord.root.anchored.admission,
            "held-copy-write",
            revalidateFileChains,
            () =>
              output!.write(
                bytes,
                written,
                bytes.length - written,
                offset + written,
              ),
          );
          await revalidateFileChains();
          if (result.bytesWritten === 0) {
            throw unsafeCapability("profile copy write made no progress");
          }
          written += result.bytesWritten;
        }
        offset += read.bytesRead;
      }
      const eof = Buffer.allocUnsafe(1);
      const trailing = await call(
        sourceRecord.root.anchored.admission,
        "held-copy-eof",
        () => sourceOpened.handle.read(eof, 0, 1, offset),
      );
      if (
        trailing.bytesRead !== 0 ||
        digest.digest("hex") !== entry.sha256
      ) {
        throw unsafeCapability("profile copy source content changed");
      }
      const sourceAfterStream = await call(
        sourceRecord.root.anchored.admission,
        "held-copy-source-stat-after-stream",
        () => sourceOpened.handle.stat({ bigint: true }),
      );
      if (!sameLeafIdentity(entry.stat, sourceAfterStream)) {
        throw unsafeCapability("profile copy source identity changed");
      }
      await revalidateFileChains();
      await callHeldMutation(
        destinationRecord.root.anchored.admission,
        "held-copy-file-sync",
        revalidateFileChains,
        () => output!.sync(),
      );
      await revalidateFileChains();
      await callHeldMutation(
        destinationRecord.root.anchored.admission,
        "held-copy-file-parent-sync",
        revalidateFileChains,
        () => destinationOpened.parent.sync(),
      );
      await revalidateFileChains();
    } finally {
      const cleanupResults = await Promise.allSettled([
        retryPartialCreateCleanup(destinationRecord.root, outputCleanup),
        closeAllDirect([
          ...destinationOpened.owned,
          ...sourceOpened.owned,
        ]),
      ]);
      const cleanupFailures = cleanupResults
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      if (cleanupFailures.length > 1) {
        throw new AggregateError(cleanupFailures, "held copy cleanup failed");
      }
    }
  }
  const sourceAfter = await heldProfileHash(sourceRecord);
  const destinationAfter =
    await syncAndCanonicalizeGenerationRecord(destinationRecord);
  if (
    sourceAfter.checksum !== sourceTree.checksum ||
    sourceAfter.byteSize !== sourceTree.byteSize ||
    destinationAfter.checksum !== sourceTree.checksum ||
    destinationAfter.byteSize !== sourceTree.byteSize
  ) {
    throw unsafeCapability("held profile copy verification failed");
  }
  return destinationAfter;
  } finally {
    releaseDestination();
    releaseSource();
  }
}

/** Test fixture support; intentionally omitted from production barrels. */
export async function writeHeldProfileFixtureFile(
  working: BoundProfileGeneration,
  leaf: string,
  contents: string | Uint8Array,
): Promise<void> {
  const record = requireGeneration(working);
  if (record.locator.state !== "working") {
    throw unsafeCapability("fixture writes require a working generation");
  }
  const release = await acquireGenerationOperation(record);
  try {
  validateSegment(leaf);
  await revalidateGeneration(record);
  const outputCleanup: PartialCreateCleanupRecord = {
    directories: [],
    handles: new Map(),
  };
  record.root.partialCreateCleanups.add(outputCleanup);
  let handle: FileHandle | undefined;
  try {
    handle = await callHeldOpenMutation(
      record.root.anchored.admission,
      "fixture-file-create",
      () => revalidateGeneration(record),
      () =>
        fs.open(
          procPath(record.generation, leaf),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        ),
      {
        cleanup: outputCleanup,
        point: "fixture-file",
      },
    );
    await callHeldMutation(record.root.anchored.admission, "fixture-file-write", () =>
      revalidateGeneration(record), () =>
      handle!.writeFile(contents),
    );
    await callHeldMutation(record.root.anchored.admission, "fixture-file-sync", () =>
      revalidateGeneration(record), () =>
      handle!.sync(),
    );
  } finally {
    await retryPartialCreateCleanup(record.root, outputCleanup);
  }
  await revalidateGeneration(record);
  } finally {
    release();
  }
}

async function removeGeneration(
  token: BoundProfileGeneration,
): Promise<void> {
  const record = requireGeneration(token);
  if (record.locator.state !== "working") {
    throw unsafeCapability("profile generation removal is not authorized");
  }
  if (record.attachmentCount !== 0) {
    throw unsafeCapability("profile generation has live Chromium attachments");
  }
  await validateProfileNamespaces(record.root, record.profiles);
  record.acceptingOperations = false;
  record.state = "consuming";
  let generationRemoved = false;
  try {
    await revalidateGeneration(record);
    if (record.deletionLeaf === undefined) {
      const tombstone = `.${record.locator.generationId}.deleting`;
      await call(
        record.root.anchored.admission,
        "held-remove-tombstone-rename",
        async () => {
          await revalidateGeneration(record);
          await fs.rename(
            procPath(record.stateHandle, record.locator.generationId),
            procPath(record.stateHandle, tombstone),
          );
          record.deletionLeaf = tombstone;
        },
      );
      await revalidateGeneration(record);
      await callHeldMutation(
        record.root.anchored.admission,
        "held-remove-tombstone-sync",
        () => revalidateGeneration(record),
        () => record.stateHandle.sync(),
      );
      await revalidateGeneration(record);
    }
    const tree = await heldProfileHash(record);
    const entries = [...tree.evidence]
      .filter((entry) => entry.path !== "")
      .sort((left, right) => {
        const depth = right.path.split("/").length - left.path.split("/").length;
        if (depth !== 0) return depth;
        if (left.type !== right.type) return left.type === "file" ? -1 : 1;
        return rawCompare(left.path, right.path);
    });
    for (const entry of entries) {
      await revalidateGeneration(record);
      const opened = await openRawProfileParent(
        record.root.anchored,
        record.generation,
        entry.path,
      );
      let leafPin: FileHandle | undefined;
      try {
        const revalidateRemoveChains = async (): Promise<void> => {
          await revalidateGeneration(record);
          await revalidateRawProfileParent(
            record.root.anchored,
            record.generation,
            record.identities[3]!,
            opened,
          );
        };
        await revalidateRemoveChains();
        const rebound = await call(
          record.root.anchored.admission,
          "held-remove-lstat",
          () =>
            fs.lstat(procPath(opened.parent, opened.leaf), { bigint: true }),
        );
        if (
          !(entry.type === "directory"
            ? sameObjectIdentity(entry.stat, rebound)
            : sameLeafIdentity(entry.stat, rebound))
        ) {
          throw unsafeCapability("profile remove evidence changed");
        }
        const pinned = await pinRemovalLeaf(
          record.root.anchored,
          opened.parent,
          opened.leaf,
        );
        leafPin = pinned.handle;
        await callHeldMutation(
          record.root.anchored.admission,
          entry.type === "directory" ? "held-remove-directory" : "held-remove-file",
          async () => {
            await revalidateRemoveChains();
            await revalidateRemovalLeaf(
              record.root.anchored,
              opened.parent,
              opened.leaf,
              pinned.stat,
              pinned.handle,
            );
          },
          () =>
            entry.type === "directory"
              ? fs.rmdir(procPath(opened.parent, opened.leaf))
              : fs.unlink(procPath(opened.parent, opened.leaf)),
          revalidateRemoveChains,
        );
        await revalidateRemoveChains();
        await callHeldMutation(
          record.root.anchored.admission,
          "held-remove-parent-sync",
          revalidateRemoveChains,
          () => opened.parent.sync(),
        );
        await revalidateRemoveChains();
      } finally {
        await leafPin?.close().catch(() => undefined);
        await closeAllDirect(opened.owned);
      }
    }
    await revalidateGeneration(record);
    const finalGenerationStat = await call(
      record.root.anchored.admission,
      "held-remove-final-lstat",
      () =>
        fs.lstat(
          procPath(record.stateHandle, record.deletionLeaf!),
          { bigint: true },
        ),
    );
    await call(
      record.root.anchored.admission,
      "held-remove-generation",
      async () => {
        await revalidateGeneration(record);
        await revalidateRemovalLeaf(
          record.root.anchored,
          record.stateHandle,
          record.deletionLeaf!,
          finalGenerationStat,
          record.generation,
        );
        await fs.rmdir(procPath(record.stateHandle, record.deletionLeaf!));
        generationRemoved = true;
      },
    );
    await revalidateGenerationParentChain(record);
    await callHeldMutation(record.root.anchored.admission, "held-remove-state-sync", () =>
      revalidateGenerationParentChain(record), () =>
      record.stateHandle.sync(),
    );
    await revalidateGenerationParentChain(record);
    await closeAll([
      [record.generation, "removed-generation"],
      [record.stateHandle, "removed-state"],
      [record.profile, "removed-profile"],
      [record.profiles, "removed-profiles"],
    ]);
    record.state = "consumed";
    record.root.children.delete(record);
    signalRootChildDrain(record.root);
    generationCapabilityRecords.delete(token as object);
  } catch (error) {
    if (generationRemoved) {
      record.state = "close_unverified";
      record.acceptingOperations = false;
      record.root.acceptingOperations = false;
      signalRootChildDrain(record.root);
    } else {
      record.state = "live";
      record.acceptingOperations = true;
    }
    throw error;
  }
}

type PreparedDeletionEntryV1 = Readonly<{
  path: string;
  type: "directory" | "file";
  dev: string;
  ino: string;
  mode: number;
  size: number;
  sha256: string | null;
}>;

type PreparedDeletionManifestPayloadV1 = Readonly<{
  version: 1;
  operationId: string;
  binding: ReadyProfileRootBinding;
  authorityDigest: string;
  expectedChecksum: string;
  profileId: string;
  state: "staging" | "committed";
  generationId: string;
  source: Readonly<{ dev: string; ino: string; mode: 448 }>;
  phase: "planned" | "moved" | "removing";
  cursor: number;
  entries: readonly PreparedDeletionEntryV1[];
}>;

type PreparedDeletionManifestV1 = Readonly<{
  payload: PreparedDeletionManifestPayloadV1;
  digest: string;
}>;

function encodePreparedDeletionManifest(
  payload: PreparedDeletionManifestPayloadV1,
): Buffer {
  return Buffer.from(
    canonicalJson({
      payload,
      digest: sha256(canonicalJson(payload)),
    }),
    "utf8",
  );
}

function parsePreparedDeletionManifest(
  bytes: Uint8Array,
  operationId: string,
): PreparedDeletionManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw atomicFailure("prepared deletion manifest is invalid");
  }
  if (typeof value !== "object" || value === null) {
    throw atomicFailure("prepared deletion manifest is invalid");
  }
  const manifest = value as Partial<PreparedDeletionManifestV1>;
  const payload = manifest.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    payload.version !== 1 ||
    payload.operationId !== operationId ||
    !UUID.test(operationId) ||
    !UUID.test(payload.profileId ?? "") ||
    !UUID.test(payload.generationId ?? "") ||
    (payload.state !== "staging" && payload.state !== "committed") ||
    !/^[a-f0-9]{64}$/u.test(payload.authorityDigest ?? "") ||
    !/^[a-f0-9]{64}$/u.test(payload.expectedChecksum ?? "") ||
    (payload.phase !== "planned" &&
      payload.phase !== "moved" &&
      payload.phase !== "removing") ||
    !Number.isSafeInteger(payload.cursor) ||
    payload.cursor! < 0 ||
    !Array.isArray(payload.entries) ||
    payload.cursor! > payload.entries.length ||
    manifest.digest !== sha256(canonicalJson(payload))
  ) {
    throw atomicFailure("prepared deletion manifest is invalid");
  }
  for (const entry of payload.entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      (entry.type !== "file" && entry.type !== "directory") ||
      !/^[0-9]+$/u.test(entry.dev) ||
      !/^[0-9]+$/u.test(entry.ino) ||
      !Number.isSafeInteger(entry.mode) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.sha256 !== null && !/^[a-f0-9]{64}$/u.test(entry.sha256))
    ) {
      throw atomicFailure("prepared deletion manifest entry is invalid");
    }
  }
  return Object.freeze({
    payload: payload as PreparedDeletionManifestPayloadV1,
    digest: manifest.digest,
  });
}

async function persistPreparedDeletionManifest(
  anchored: AnchoredRoot,
  wrapper: FileHandle,
  payload: PreparedDeletionManifestPayloadV1,
): Promise<void> {
  const bytes = encodePreparedDeletionManifest(payload);
  let temporary: FileHandle | null = null;
  try {
    temporary = await call(anchored.admission, "prepared-delete-manifest-open", () =>
      fs.open(
        procPath(wrapper, ".manifest.next"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        0o600,
      ),
    );
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-manifest-write",
      () => anchored.revalidate(),
      () => temporary!.writeFile(bytes),
    );
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-manifest-sync",
      () => anchored.revalidate(),
      () => temporary!.sync(),
    );
    await closeRaw(temporary, "prepared-delete-manifest-temp");
    temporary = null;
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-manifest-publish",
      () => anchored.revalidate(),
      () =>
        fs.rename(
          procPath(wrapper, ".manifest.next"),
          procPath(wrapper, "manifest.json"),
        ),
    );
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-wrapper-sync",
      () => anchored.revalidate(),
      () => wrapper.sync(),
    );
  } finally {
    if (temporary !== null) {
      await temporary.close().catch(() => undefined);
    }
  }
}

async function readPreparedDeletionManifest(
  anchored: AnchoredRoot,
  wrapper: FileHandle,
  operationId: string,
): Promise<PreparedDeletionManifestV1> {
  const snapshot = await readRegularFileAt(
    anchored,
    wrapper,
    "manifest.json",
    ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES,
  );
  return parsePreparedDeletionManifest(snapshot.bytes, operationId);
}

async function openPreparedDeletionDirectory(
  anchored: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  const before = await call(anchored.admission, "prepared-delete-lstat", () =>
    fs.lstat(procPath(parent, leaf), { bigint: true }),
  );
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== BigInt(atomicEffectiveUid()) ||
    lowModeBigint(before.mode) !== 0o700
  ) {
    throw atomicFailure("prepared deletion directory is invalid");
  }
  const handle = await call(anchored.admission, "prepared-delete-open", () =>
    fs.open(
      procPath(parent, leaf),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ),
  );
  const after = await call(anchored.admission, "prepared-delete-fstat", () =>
    handle.stat({ bigint: true }),
  );
  if (!sameObjectIdentity(before, after)) {
    await handle.close().catch(() => undefined);
    throw atomicFailure("prepared deletion directory binding changed");
  }
  return { handle, stat: after };
}

async function observePreparedDeletionSource(
  anchored: AnchoredRoot,
  parent: FileHandle,
  leaf: string,
  expected: PreparedDeletionManifestPayloadV1["source"],
): Promise<{ handle: FileHandle; stat: BigIntStats } | null> {
  let observed: BigIntStats;
  try {
    observed = await call(anchored.admission, "prepared-delete-source-lstat", () =>
      fs.lstat(procPath(parent, leaf), { bigint: true }),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !observed.isDirectory() ||
    observed.isSymbolicLink() ||
    String(observed.dev) !== expected.dev ||
    String(observed.ino) !== expected.ino ||
    lowModeBigint(observed.mode) !== expected.mode
  ) {
    throw atomicFailure("prepared deletion source identity changed");
  }
  return openPreparedDeletionDirectory(anchored, parent, leaf);
}

async function removePreparedDeletionEntry(
  anchored: AnchoredRoot,
  generation: FileHandle,
  entry: PreparedDeletionEntryV1,
): Promise<void> {
  const opened = await openRawProfileParent(anchored, generation, entry.path);
  let pin: FileHandle | null = null;
  try {
    let observed: BigIntStats;
    try {
      observed = await call(anchored.admission, "prepared-delete-entry-lstat", () =>
        fs.lstat(procPath(opened.parent, opened.leaf), { bigint: true }),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (
      String(observed.dev) !== entry.dev ||
      String(observed.ino) !== entry.ino ||
      lowModeBigint(observed.mode) !== entry.mode ||
      (entry.type === "directory"
        ? !observed.isDirectory()
        : !observed.isFile() ||
          Number(observed.size) !== entry.size)
    ) {
      throw atomicFailure("prepared deletion entry identity changed");
    }
    if (entry.type === "file") {
      const snapshot = await readRegularFileAt(
        anchored,
        opened.parent,
        opened.leaf,
        PROFILE_FILE_MAX_BYTES,
      );
      if (
        sha256(snapshot.bytes) !== entry.sha256 ||
        String(snapshot.stat.dev) !== entry.dev ||
        String(snapshot.stat.ino) !== entry.ino
      ) {
        throw atomicFailure("prepared deletion file content changed");
      }
    }
    const pinned = await pinRemovalLeaf(
      anchored,
      opened.parent,
      opened.leaf,
    );
    pin = pinned.handle;
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-entry-remove",
      async () => {
        await anchored.revalidate();
        await revalidateRemovalLeaf(
          anchored,
          opened.parent,
          opened.leaf,
          observed,
          pinned.handle,
        );
      },
      () =>
        entry.type === "directory"
          ? fs.rmdir(procPath(opened.parent, opened.leaf))
          : fs.unlink(procPath(opened.parent, opened.leaf)),
      () => anchored.revalidate(),
    );
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-entry-parent-sync",
      () => anchored.revalidate(),
      () => opened.parent.sync(),
    );
  } finally {
    await pin?.close().catch(() => undefined);
    await closeAllDirect(opened.owned);
  }
}

async function executePreparedDeletionJournal(
  anchored: AnchoredRoot,
  bundles: FileHandle,
  wrapper: FileHandle,
  wrapperLeaf: string,
  initial: PreparedDeletionManifestV1,
): Promise<void> {
  let payload = initial.payload;
  const profiles = await openPreparedDeletionDirectory(
    anchored,
    anchored.handle,
    "profiles",
  );
  let profile: { handle: FileHandle; stat: BigIntStats } | null = null;
  let state: { handle: FileHandle; stat: BigIntStats } | null = null;
  let publicSource: { handle: FileHandle; stat: BigIntStats } | null = null;
  let privateSource: { handle: FileHandle; stat: BigIntStats } | null = null;
  try {
    profile = await openPreparedDeletionDirectory(
      anchored,
      profiles.handle,
      payload.profileId,
    );
    state = await openPreparedDeletionDirectory(
      anchored,
      profile.handle,
      payload.state,
    );
    publicSource = await observePreparedDeletionSource(
      anchored,
      state.handle,
      payload.generationId,
      payload.source,
    );
    privateSource = await observePreparedDeletionSource(
      anchored,
      wrapper,
      "source",
      payload.source,
    );
    if (publicSource !== null && privateSource !== null) {
      throw atomicFailure("prepared deletion source location is ambiguous");
    }
    if (publicSource !== null) {
      if (payload.phase !== "planned") {
        throw atomicFailure("prepared deletion durable phase is inconsistent");
      }
      await callHeldMutation(
        anchored.admission,
        "prepared-delete-source-move",
        async () => {
          await anchored.revalidate();
          const rebound = await fs.lstat(
            procPath(state!.handle, payload.generationId),
            { bigint: true },
          );
          if (!sameObjectIdentity(publicSource!.stat, rebound)) {
            throw atomicFailure("prepared deletion source binding changed");
          }
          try {
            await fs.lstat(procPath(wrapper, "source"), { bigint: true });
            throw atomicFailure(
              "prepared deletion private destination already exists",
            );
          } catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          }
        },
        async () => {
          loadAtomicDirectoryPublicationNative().renameNoReplace(
            state!.handle.fd,
            payload.generationId,
            wrapper.fd,
            "source",
          );
        },
        () => anchored.revalidate(),
      );
      await callHeldMutation(
        anchored.admission,
        "prepared-delete-source-parent-sync",
        () => anchored.revalidate(),
        () => state!.handle.sync(),
      );
      await callHeldMutation(
        anchored.admission,
        "prepared-delete-private-parent-sync",
        () => anchored.revalidate(),
        () => wrapper.sync(),
      );
      privateSource = publicSource;
      publicSource = null;
      payload = Object.freeze({ ...payload, phase: "moved" as const });
      await persistPreparedDeletionManifest(anchored, wrapper, payload);
    }
    if (privateSource === null) {
      if (payload.cursor !== payload.entries.length) {
        throw atomicFailure("prepared deletion private source is missing");
      }
    } else {
      if (payload.phase === "planned") {
        payload = Object.freeze({ ...payload, phase: "moved" as const });
        await persistPreparedDeletionManifest(anchored, wrapper, payload);
      }
      if (payload.phase === "moved") {
        payload = Object.freeze({ ...payload, phase: "removing" as const });
        await persistPreparedDeletionManifest(anchored, wrapper, payload);
      }
      for (
        let cursor = payload.cursor;
        cursor < payload.entries.length;
        cursor += 1
      ) {
        await removePreparedDeletionEntry(
          anchored,
          privateSource.handle,
          payload.entries[cursor]!,
        );
        payload = Object.freeze({ ...payload, cursor: cursor + 1 });
        await persistPreparedDeletionManifest(anchored, wrapper, payload);
      }
      const rebound = await call(
        anchored.admission,
        "prepared-delete-private-root-stat",
        () => privateSource!.handle.stat({ bigint: true }),
      );
      if (
        String(rebound.dev) !== payload.source.dev ||
        String(rebound.ino) !== payload.source.ino
      ) {
        throw atomicFailure("prepared deletion private root changed");
      }
      await privateSource.handle.close();
      privateSource = null;
      await callHeldMutation(
        anchored.admission,
        "prepared-delete-private-root-remove",
        () => anchored.revalidate(),
        () => fs.rmdir(procPath(wrapper, "source")),
      );
      await callHeldMutation(
        anchored.admission,
        "prepared-delete-private-root-parent-sync",
        () => anchored.revalidate(),
        () => wrapper.sync(),
      );
    }
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-manifest-remove",
      () => anchored.revalidate(),
      () => fs.unlink(procPath(wrapper, "manifest.json")),
    );
    await fs.unlink(procPath(wrapper, ".manifest.next")).catch(error => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-wrapper-final-sync",
      () => anchored.revalidate(),
      () => wrapper.sync(),
    );
    await wrapper.close();
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-wrapper-remove",
      () => anchored.revalidate(),
      () => fs.rmdir(procPath(bundles, wrapperLeaf)),
    );
    await callHeldMutation(
      anchored.admission,
      "prepared-delete-bundles-sync",
      () => anchored.revalidate(),
      () => bundles.sync(),
    );
  } finally {
    await privateSource?.handle.close().catch(() => undefined);
    await publicSource?.handle.close().catch(() => undefined);
    await state?.handle.close().catch(() => undefined);
    await profile?.handle.close().catch(() => undefined);
    await profiles.handle.close().catch(() => undefined);
  }
}

export async function deletePreparedProfileGenerationAtomically(
  source: BoundProfileGeneration,
  input: DeletePreparedProfileGenerationInput,
): Promise<void> {
  const record = requireGeneration(source);
  if (
    (record.locator.state !== "staging" &&
      record.locator.state !== "committed") ||
    !sameReadyBinding(record.root.binding, input.binding) ||
    !/^[a-f0-9]{64}$/u.test(input.expectedChecksum) ||
    !/^[a-f0-9]{64}$/u.test(input.authorityDigest)
  ) {
    throw unsafeCapability(
      "prepared profile generation deletion authority is invalid",
    );
  }
  const release = await acquireGenerationOperation(record, true);
  let staging: { handle: FileHandle; stat: BigIntStats } | null = null;
  let bundles: { handle: FileHandle; stat: BigIntStats } | null = null;
  let wrapper: FileHandle | null = null;
  let durable = false;
  try {
    const before = await heldProfileHash(record);
    if (before.checksum !== input.expectedChecksum) {
      throw unsafeCapability("prepared profile generation checksum changed");
    }
    const operationId = atomicUuidFromDigest(
      canonicalJson({
        authorityDigest: input.authorityDigest,
        checksum: input.expectedChecksum,
        profileId: record.locator.profileId,
        state: record.locator.state,
        generationId: record.locator.generationId,
        dev: String(record.identities[3]!.dev),
        ino: String(record.identities[3]!.ino),
      }),
    );
    const wrapperLeaf = `delete-${operationId}`;
    staging = await openPreparedDeletionDirectory(
      record.root.anchored,
      record.root.anchored.handle,
      ".profile-publish-staging",
    );
    bundles = await openPreparedDeletionDirectory(
      record.root.anchored,
      staging.handle,
      "bundles",
    );
    await callHeldMutation(
      record.root.anchored.admission,
      "prepared-delete-wrapper-create",
      () => record.root.anchored.revalidate(),
      () => fs.mkdir(procPath(bundles!.handle, wrapperLeaf), { mode: 0o700 }),
    );
    wrapper = (
      await openPreparedDeletionDirectory(
        record.root.anchored,
        bundles.handle,
        wrapperLeaf,
      )
    ).handle;
    const entries = Object.freeze(
      before.evidence
        .filter(entry => entry.path !== "")
        .sort((left, right) => {
          const depth =
            right.path.split("/").length - left.path.split("/").length;
          if (depth !== 0) return depth;
          if (left.type !== right.type) return left.type === "file" ? -1 : 1;
          return rawCompare(left.path, right.path);
        })
        .map(entry =>
          Object.freeze({
            path: entry.path,
            type: entry.type,
            dev: String(entry.stat.dev),
            ino: String(entry.stat.ino),
            mode: lowModeBigint(entry.stat.mode),
            size: entry.type === "file" ? Number(entry.stat.size) : 0,
            sha256: entry.sha256,
          }),
        ),
    );
    const payload: PreparedDeletionManifestPayloadV1 = Object.freeze({
      version: 1,
      operationId,
      binding: Object.freeze({ ...input.binding }),
      authorityDigest: input.authorityDigest,
      expectedChecksum: input.expectedChecksum,
      profileId: record.locator.profileId,
      state: record.locator.state,
      generationId: record.locator.generationId,
      source: Object.freeze({
        dev: String(record.identities[3]!.dev),
        ino: String(record.identities[3]!.ino),
        mode: 448 as const,
      }),
      phase: "planned",
      cursor: 0,
      entries,
    });
    await persistPreparedDeletionManifest(
      record.root.anchored,
      wrapper,
      payload,
    );
    await callHeldMutation(
      record.root.anchored.admission,
      "prepared-delete-planned-bundles-sync",
      () => record.root.anchored.revalidate(),
      () => bundles!.handle.sync(),
    );
    durable = true;
    await executePreparedDeletionJournal(
      record.root.anchored,
      bundles.handle,
      wrapper,
      wrapperLeaf,
      parsePreparedDeletionManifest(
        encodePreparedDeletionManifest(payload),
        operationId,
      ),
    );
    wrapper = null;
    await closeAll([
      [record.generation, "prepared-delete-generation"],
      [record.stateHandle, "prepared-delete-state"],
      [record.profile, "prepared-delete-profile"],
      [record.profiles, "prepared-delete-profiles"],
    ]);
    record.state = "consumed";
    record.root.children.delete(record);
    signalRootChildDrain(record.root);
    generationCapabilityRecords.delete(source as object);
  } catch (error) {
    record.state = durable ? "close_unverified" : "live";
    record.acceptingOperations = !durable;
    if (durable) record.root.acceptingOperations = false;
    throw error;
  } finally {
    await wrapper?.close().catch(() => undefined);
    await bundles?.handle.close().catch(() => undefined);
    await staging?.handle.close().catch(() => undefined);
    release();
  }
}

export async function launchPersistentChromiumForWorking(
  working: BoundProfileGeneration,
  binding: ReadyProfileRootBinding,
  options: ValidatedPersistentChromiumOptions,
): Promise<ChromiumSessionAttachment> {
  const record = requireGeneration(working);
  if (
    record.locator.state !== "working" ||
    !sameReadyBinding(record.root.binding, binding)
  ) {
    throw unsafeCapability("Chromium working authority is invalid");
  }
  const releaseOperation = await acquireGenerationOperation(record);
  try {
  await validateProfileNamespaces(record.root, record.profiles);
  await revalidateGeneration(record);
  const procfdPath = `/proc/${process.pid}/fd/${record.generation.fd}`;
  const procStat = await call(
    record.root.anchored.admission,
    "verify-procfd-generation",
    () => fs.stat(procfdPath, { bigint: true }),
  );
  if (!sameObjectIdentity(record.identities[3]!, procStat)) {
    throw unsafeCapability("Chromium procfd generation changed");
  }
  let context: BrowserContext | undefined;
  try {
    assertAdmitted(record.root.anchored.admission);
    context = await chromium.launchPersistentContext(procfdPath, options);
    assertAdmitted(record.root.anchored.admission);
    await revalidateGeneration(record);
    const attachment = Object.freeze({ context }) as ChromiumSessionAttachment;
    attachmentRecords.set(attachment, {
      state: "live",
      generation: record,
      context,
      contextCloseSettlement: "idle",
      browserCloseSettlement: "idle",
      browserCloseAttempt: 0,
    });
    record.attachmentCount += 1;
    return attachment;
  } catch (error) {
    if (context !== undefined) {
      const attachment = Object.freeze({ context }) as ChromiumSessionAttachment;
      attachmentRecords.set(attachment, {
        state: "live",
        generation: record,
        context,
        contextCloseSettlement: "idle",
        browserCloseSettlement: "idle",
        browserCloseAttempt: 0,
      });
      record.attachmentCount += 1;
      try {
        await releaseChromiumSessionAttachment(attachment);
      } catch (cleanupError) {
        throw new UnverifiedChromiumLaunchError(
          "Chromium launch cleanup is unverified",
          attachment,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    throw error;
  }
  } finally {
    releaseOperation();
  }
}

export async function releaseChromiumSessionAttachment(
  attachment: ChromiumSessionAttachment,
): Promise<void> {
  const record = attachmentRecords.get(attachment as object);
  if (
    record === undefined ||
    (record.state !== "live" && record.state !== "close_unverified")
  ) {
    throw unsafeCapability("Chromium attachment is not releasable");
  }
  record.state = "releasing";
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (record.contextClosePromise === undefined) {
      record.contextCloseSettlement = "pending";
      try {
        record.contextClosePromise = Promise.resolve(record.context.close()).then(
          () => {
            record.contextCloseSettlement = "resolved";
            return true;
          },
          () => {
            record.contextCloseSettlement = "rejected";
            return false;
          },
        );
      } catch {
        record.contextCloseSettlement = "rejected";
        record.contextClosePromise = Promise.resolve(false);
      }
    }
    if (record.contextCloseSettlement === "resolved") {
      closed = true;
    } else {
      closed = await Promise.race([
        record.contextClosePromise,
        new Promise<false>((resolve) => {
          timer = setTimeout(resolve, 5_000, false);
          timer.unref();
        }),
      ]);
    }
    if (!closed) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const browser = record.browser ?? record.context.browser();
      record.browser = browser;
      if (browser !== null) {
        if (!browser.isConnected()) {
          record.browserCloseSettlement = "resolved";
          closed = true;
        } else if (
          record.browserClosePromise === undefined ||
          record.browserCloseSettlement === "rejected" ||
          record.browserCloseSettlement === "timed_out"
        ) {
          record.browserCloseAttempt += 1;
          const attempt = record.browserCloseAttempt;
          record.browserCloseSettlement = "pending";
          try {
            record.browserClosePromise = Promise.resolve(browser.close()).then(
              () => {
                const disconnected = !browser.isConnected();
                if (record.browserCloseAttempt === attempt) {
                  record.browserCloseSettlement = disconnected
                    ? "resolved"
                    : "rejected";
                }
                return disconnected;
              },
              () => {
                if (record.browserCloseAttempt === attempt) {
                  record.browserCloseSettlement = "rejected";
                }
                return false;
              },
            );
          } catch {
            record.browserCloseSettlement = "rejected";
            record.browserClosePromise = Promise.resolve(false);
          }
        }
        if (!closed) {
          closed = await Promise.race([
            record.browserClosePromise!,
            new Promise<false>((resolve) => {
              timer = setTimeout(resolve, 5_000, false);
              timer.unref();
            }),
          ]);
          if (!closed && record.browserCloseSettlement === "pending") {
            record.browserCloseSettlement = "timed_out";
          }
        }
      }
    }
  } catch {
    closed = false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!closed) {
    record.state = "close_unverified";
    record.generation.root.acceptingOperations = false;
    throw unsafeCapability("Chromium attachment close is unverified");
  }
  record.state = "released";
  record.generation.attachmentCount -= 1;
}

declare const atomicEffectControllerBrand: unique symbol;
declare const preReadyRecoveryAuthorityBrand: unique symbol;

export type AtomicEffectControllerV1 = Readonly<{
  [atomicEffectControllerBrand]: true;
}>;

export type PreReadyRecoveryAuthority = Readonly<{
  [preReadyRecoveryAuthorityBrand]: true;
}>;

export type AtomicInitialAuthorityV1 = Readonly<{
  stateRootId: FlightSemanticId;
  profilesParentId: FlightSemanticId;
  stagingRootId: FlightSemanticId;
  bundlesParentId: FlightSemanticId;
  intentsParentId: FlightSemanticId;
  evidence: Readonly<{
    stateRoot: AtomicObjectEvidenceV1;
    profilesParent: AtomicObjectEvidenceV1;
    stagingRoot: AtomicObjectEvidenceV1;
    bundlesParent: AtomicObjectEvidenceV1;
    intentsParent: AtomicObjectEvidenceV1;
  }>;
}>;

export type AtomicPreReadyRecoveryLeaseV1 = Readonly<{
  controller: AtomicEffectControllerV1;
  authority: PreReadyRecoveryAuthority;
  initialAuthority: AtomicInitialAuthorityV1;
}>;

type AtomicHeldRecord = Readonly<{
  role: AtomicObjectRoleV1;
  operationId: string;
  parentId: FlightSemanticId | null;
  leaf: string | null;
  handle: FileHandle;
  binding: ReadyProfileRootBinding;
  evidence: AtomicObjectEvidenceV1;
  stat: BigIntStats;
  owned: boolean;
}>;

type AtomicPinnedContentState = {
  size: number;
  contentSha256: string;
  synced: boolean;
};

type AtomicPersistenceResolution = Readonly<{
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "persist_intent" | "persist_manifest" }
  >;
  rawCode: Extract<
    AtomicEffectObservationV1,
    { kind: "native_resolved" }
  >["rawCode"];
}>;

type AtomicPartialCreateRecord = {
  operationId: string;
  parentId: FlightSemanticId;
  leaf: string;
  role: AtomicObjectRoleV1;
  type: "file" | "directory";
  mode: 384 | 448;
  handle: FileHandle | null;
  stat: BigIntStats | null;
  evidence: AtomicObjectEvidenceV1 | null;
  used: boolean;
};

type AtomicReservationKind =
  | "payload_entries"
  | "payload_bytes"
  | "scratch_entries"
  | "stable_files"
  | "scratch_files"
  | "manifest_bytes"
  | "other_metadata_bytes";

type AtomicEffectFlightRecord = {
  state: "live" | "closing" | "closed" | "fail_stopped";
  operationId: string;
  epoch: object;
  root: RootCapabilityRecord;
  binding: ReadyProfileRootBinding;
  releaseRootOperation: () => void;
  registry: WeakMap<object, AtomicHeldRecord>;
  recordTokens: WeakMap<AtomicHeldRecord, FlightSemanticId>;
  records: Set<AtomicHeldRecord>;
  removedRecords: WeakSet<AtomicHeldRecord>;
  enumerationCursors: WeakMap<object, number>;
  populationCursors: WeakMap<object, number>;
  canonicalizationCursors: WeakMap<object, number>;
  profileEntries: WeakMap<object, AtomicHeldRecord[]>;
  partials: WeakMap<object, AtomicPartialCreateRecord>;
  livePartials: Set<AtomicPartialCreateRecord>;
  transientHandles: Set<{
    handle: { close(): Promise<void> };
    parent: AtomicHeldRecord;
    point: string;
  }>;
  seenEffects: WeakSet<object>;
  revalidatedHandles: WeakSet<object>;
  statfsHandles: WeakMap<
    object,
    Readonly<{
      device: string;
      filesystem: Extract<
        AtomicEffectObservationV1,
        { kind: "statfs_observed" }
      >["filesystem"];
    }>
  >;
  contentStates: WeakMap<object, AtomicPinnedContentState>;
  persistenceResolution: AtomicPersistenceResolution | null;
  semanticCount: number;
  partialCount: number;
  effectCount: number;
  activeStableIntents: number;
  recoveryRecords: number;
  reservations: Record<AtomicReservationKind, { count: number; byteSize: number }>;
  releaseCountCredits: Record<
    "payload_entries" | "scratch_entries" | "stable_files" | "scratch_files",
    number
  >;
  releaseByteCredits: Record<
    "payload_bytes" | "manifest_bytes" | "other_metadata_bytes",
    number
  >;
  claimedBytes: Record<
    "payload_bytes" | "manifest_bytes" | "other_metadata_bytes",
    number
  >;
  claimedScopedBytes: Record<
    | "stable_manifest"
    | "scratch_manifest"
    | "stable_other"
    | "scratch_other",
    number
  >;
  claimedCounts: Record<
    "payload_entries" | "scratch_entries" | "stable_files" | "scratch_files",
    number
  >;
  recordReservations: WeakMap<
    object,
    "payload_entries" | "scratch_entries" | "stable_files" | "scratch_files"
  >;
  recordByteReservations: WeakMap<
    object,
    Readonly<{
      reservation:
        | "payload_bytes"
        | "manifest_bytes"
        | "other_metadata_bytes";
      byteSize: number;
      scope:
        | "stable_manifest"
        | "scratch_manifest"
        | "stable_other"
        | "scratch_other"
        | null;
    }>
  >;
  intents: WeakMap<object, AtomicPublishIntentV1>;
  stableIntents: Map<
    string,
    Readonly<{
      contentSha256: string;
      intent: AtomicPublishIntentV1;
    }>
  >;
};

type PreReadyRecoveryAuthorityRecord = Readonly<{
  controller: AtomicEffectControllerV1;
  binding: ReadyProfileRootBinding;
  digest: string;
}>;

const atomicEffectFlightRecords = new WeakMap<
  object,
  AtomicEffectFlightRecord
>();
const preReadyRecoveryAuthorityRecords = new WeakMap<
  object,
  PreReadyRecoveryAuthorityRecord
>();

const ATOMIC_RESERVATION_LIMITS: Readonly<
  Record<AtomicReservationKind, Readonly<{ count: number; byteSize: number }>>
> = Object.freeze({
  payload_entries: Object.freeze({
    count: ATOMIC_MAX_PAYLOAD_ENTRIES,
    byteSize: 0,
  }),
  payload_bytes: Object.freeze({
    count: 0,
    byteSize: ATOMIC_MAX_PAYLOAD_BYTES,
  }),
  scratch_entries: Object.freeze({
    count: ATOMIC_MAX_SCRATCH_ENTRIES,
    byteSize: 0,
  }),
  stable_files: Object.freeze({
    count: ATOMIC_MAX_METADATA_FILES - ATOMIC_MAX_SCRATCH_METADATA_FILES,
    byteSize: 0,
  }),
  scratch_files: Object.freeze({
    count: ATOMIC_MAX_SCRATCH_METADATA_FILES,
    byteSize: 0,
  }),
  manifest_bytes: Object.freeze({
    count: 0,
    byteSize: ATOMIC_MAX_MANIFEST_BYTES,
  }),
  other_metadata_bytes: Object.freeze({
    count: 0,
    byteSize: ATOMIC_MAX_OTHER_METADATA_BYTES,
  }),
});

function atomicFailure(message: string): BrowserServiceError {
  return new BrowserServiceError(
    "reconciliation_filesystem_unsafe",
    message,
  );
}

function atomicEvidenceFromStat(
  stat: BigIntStats,
  contentSha256: string | null = null,
): AtomicObjectEvidenceV1 {
  const value = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: lowModeBigint(stat.mode),
    size: Number(stat.size),
    contentSha256,
  };
  return Object.freeze({
    ...value,
    evidenceDigest: sha256(JSON.stringify(value)),
  });
}

function sameAtomicEvidence(
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

function atomicEvidenceIsCanonical(value: AtomicObjectEvidenceV1): boolean {
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(value.dev) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.ino) ||
    !Number.isSafeInteger(value.mode) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    (value.contentSha256 !== null &&
      !/^[a-f0-9]{64}$/u.test(value.contentSha256))
  ) {
    return false;
  }
  const digest = sha256(
    JSON.stringify({
      dev: value.dev,
      ino: value.ino,
      mode: value.mode,
      size: value.size,
      contentSha256: value.contentSha256,
    }),
  );
  return value.evidenceDigest === digest;
}

function validateAtomicLeaf(role: AtomicObjectRoleV1, leaf: string): void {
  const valid =
    role === "payload_entry"
      ? isAtomicPayloadLeafV1(leaf)
      : isAtomicControlLeafV1(leaf);
  if (!valid) throw atomicFailure("atomic publication leaf is invalid");
}

function atomicFstat(handle: FileHandle): BigIntStats {
  return fstatSync(handle.fd, { bigint: true });
}

function atomicEffectiveUid(): bigint {
  if (typeof process.geteuid !== "function") {
    throw atomicFailure("atomic publication effective UID is unsupported");
  }
  return BigInt(process.geteuid());
}

function assertAtomicStat(
  expected: BigIntStats,
  current: BigIntStats,
  message: string,
): void {
  if (
    !sameObjectIdentity(expected, current) ||
    expected.uid !== current.uid ||
    expected.gid !== current.gid
  ) {
    throw atomicFailure(message);
  }
}

function assertAtomicAnchoredChain(record: AtomicEffectFlightRecord): void {
  assertAdmitted(record.root.anchored.admission);
  for (
    let index = 0;
    index < record.root.anchored.components.length;
    index += 1
  ) {
    const component = record.root.anchored.components[index]!;
    const held = atomicFstat(component.handle);
    assertAtomicStat(
      component.stat,
      held,
      "atomic publication root handle changed",
    );
    if (index === 0) continue;
    const parent = record.root.anchored.components[index - 1]!;
    const rebound = statSync(procPath(parent.handle, component.name), {
      bigint: true,
    });
    assertAtomicStat(
      component.stat,
      rebound,
      "atomic publication root binding changed",
    );
  }
}

function resolveAtomicRecord(
  flight: AtomicEffectFlightRecord,
  objectId: FlightSemanticId,
): AtomicHeldRecord {
  const record = flight.registry.get(objectId as object);
  if (
    record === undefined ||
    record.operationId !== flight.operationId ||
    !sameReadyBinding(record.binding, flight.binding)
  ) {
    throw atomicFailure("atomic publication semantic ID is invalid");
  }
  return record;
}

function assertAtomicHeldChain(
  flight: AtomicEffectFlightRecord,
  record: AtomicHeldRecord,
  seen = new Set<AtomicHeldRecord>(),
): void {
  if (seen.has(record)) {
    throw atomicFailure("atomic publication held chain is cyclic");
  }
  seen.add(record);
  if (record.parentId !== null) {
    const parent = resolveAtomicRecord(flight, record.parentId);
    assertAtomicHeldChain(flight, parent, seen);
    if (record.leaf === null) {
      throw atomicFailure("atomic publication held linkage is invalid");
    }
    if (!flight.removedRecords.has(record)) {
      const rebound = statSync(procPath(parent.handle, record.leaf), {
        bigint: true,
      });
      assertAtomicStat(
        record.stat,
        rebound,
        "atomic publication held binding changed",
      );
    }
  }
  const held = atomicFstat(record.handle);
  assertAtomicStat(
    record.stat,
    held,
    "atomic publication held handle changed",
  );
  if (
    record.evidence.dev !== String(held.dev) ||
    record.evidence.ino !== String(held.ino) ||
    record.evidence.mode !== lowModeBigint(held.mode)
  ) {
    throw atomicFailure("atomic publication held evidence changed");
  }
}

function atomicGate(
  flight: AtomicEffectFlightRecord,
  records: readonly AtomicHeldRecord[],
  phase: "before" | "after",
  point: string,
  allowCleanup = false,
): void {
  try {
    if (
      flight.state !== "live" &&
      (!allowCleanup ||
        (flight.state !== "fail_stopped" && flight.state !== "closing"))
    ) {
      throw atomicFailure("atomic publication controller is not live");
    }
    assertAtomicAnchoredChain(flight);
    for (const record of records) assertAtomicHeldChain(flight, record);
    filesystemTestContext.getStore()?.atomicGate?.(phase, point);
  } catch (error) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    if (error instanceof BrowserServiceError) throw error;
    throw atomicFailure("atomic publication binding is invalid");
  }
}

async function atomicAwait<T>(
  flight: AtomicEffectFlightRecord,
  records: readonly AtomicHeldRecord[],
  point: string,
  operation: () => Promise<T>,
  allowCleanup = false,
): Promise<T> {
  atomicGate(flight, records, "before", point, allowCleanup);
  try {
    await filesystemTestContext.getStore()?.beforeCall?.(point);
    atomicGate(flight, records, "before", point, allowCleanup);
    const result = await operation();
    filesystemTestContext.getStore()?.atomicOperationCompleted?.(point);
    return result;
  } finally {
    atomicGate(flight, records, "after", point, allowCleanup);
    await filesystemTestContext.getStore()?.afterCall?.(point);
    atomicGate(flight, records, "after", point, allowCleanup);
  }
}

function atomicCleanupAwait<T>(
  flight: AtomicEffectFlightRecord,
  records: readonly AtomicHeldRecord[],
  point: string,
  operation: () => Promise<T>,
): Promise<T> {
  return atomicAwait(flight, records, point, operation, true);
}

async function atomicVerifiedClose(
  flight: AtomicEffectFlightRecord,
  records: readonly AtomicHeldRecord[],
  point: string,
  close: () => Promise<void>,
  onClosed: () => void,
): Promise<void> {
  atomicGate(flight, records, "before", point, true);
  let injectedFailure: unknown;
  let closeFailure: unknown;
  let closed = false;
  try {
    try {
      await filesystemTestContext.getStore()?.beforeClose?.(point);
    } catch (error) {
      injectedFailure = error;
    }
    atomicGate(flight, records, "before", point, true);
    try {
      const closeOperation =
        filesystemTestContext.getStore()?.closeOperation;
      if (closeOperation === undefined) await close();
      else await closeOperation(point, close);
      closed = true;
      onClosed();
    } catch (error) {
      closeFailure = error;
    }
  } finally {
    try {
      atomicGate(flight, records, "after", point, true);
      if (closed) {
        filesystemTestContext.getStore()?.handleClosed?.(point);
      }
    } catch (error) {
      closeFailure ??= error;
    }
  }
  if (injectedFailure !== undefined || closeFailure !== undefined) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw atomicFailure("atomic publication close is unverified");
  }
}

type AtomicReservationRequirement = Readonly<{
  entry:
    | "payload_entries"
    | "scratch_entries"
    | "stable_files"
    | "scratch_files";
  bytes: "payload_bytes" | "manifest_bytes" | "other_metadata_bytes";
}>;

function atomicReservationRequirement(
  role: AtomicObjectRoleV1,
): AtomicReservationRequirement {
  switch (role) {
    case "payload_entry":
    case "public_source":
    case "public_target":
      return { entry: "payload_entries", bytes: "payload_bytes" };
    case "wrapper":
    case "private_source":
    case "private_deletion":
      return { entry: "scratch_entries", bytes: "other_metadata_bytes" };
    case "manifest_stable":
      return { entry: "stable_files", bytes: "manifest_bytes" };
    case "intent_stable":
      return { entry: "stable_files", bytes: "other_metadata_bytes" };
    case "manifest_temp":
      return { entry: "scratch_files", bytes: "manifest_bytes" };
    case "intent_temp":
      return { entry: "scratch_files", bytes: "other_metadata_bytes" };
    case "bundles_parent":
      return { entry: "stable_files", bytes: "manifest_bytes" };
    case "intents_parent":
    case "state_root":
    case "profiles_parent":
      return { entry: "stable_files", bytes: "other_metadata_bytes" };
    case "staging_root":
    case "trusted_parent":
      return { entry: "scratch_files", bytes: "other_metadata_bytes" };
  }
}

function atomicRoleClaimsReservation(role: AtomicObjectRoleV1): boolean {
  return (
    role !== "trusted_parent" &&
    role !== "state_root" &&
    role !== "profiles_parent" &&
    role !== "staging_root" &&
    role !== "intents_parent" &&
    role !== "bundles_parent" &&
    role !== "public_source" &&
    role !== "public_target"
  );
}

function atomicRoleIsRecoveryRecord(role: AtomicObjectRoleV1): boolean {
  return (
    role === "intent_temp" ||
    role === "intent_stable" ||
    role === "manifest_temp" ||
    role === "manifest_stable"
  );
}

function atomicReservationAvailable(
  flight: AtomicEffectFlightRecord,
  requirement: AtomicReservationRequirement,
  count: number,
  byteSize: number,
): boolean {
  return (
    flight.reservations[requirement.entry].count >= count &&
    flight.reservations[requirement.bytes].byteSize >= byteSize
  );
}

function atomicByteReservation(
  role: AtomicObjectRoleV1,
): "payload_bytes" | "manifest_bytes" | "other_metadata_bytes" | null {
  const reservation = atomicReservationRequirement(role).bytes;
  return reservation === "payload_bytes" ||
    reservation === "manifest_bytes" ||
    reservation === "other_metadata_bytes"
    ? reservation
    : null;
}

type AtomicMetadataByteScope =
  | "stable_manifest"
  | "scratch_manifest"
  | "stable_other"
  | "scratch_other";

function atomicMetadataByteScope(
  role: AtomicObjectRoleV1,
): AtomicMetadataByteScope | null {
  switch (role) {
    case "manifest_stable":
      return "stable_manifest";
    case "manifest_temp":
      return "scratch_manifest";
    case "intent_stable":
      return "stable_other";
    case "intent_temp":
      return "scratch_other";
    default:
      return null;
  }
}

function atomicMetadataByteScopeLimit(
  scope: AtomicMetadataByteScope,
): number {
  switch (scope) {
    case "stable_manifest":
      return ATOMIC_MAX_STABLE_MANIFEST_BYTES;
    case "scratch_manifest":
      return ATOMIC_MAX_SCRATCH_MANIFEST_BYTES;
    case "stable_other":
      return ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES;
    case "scratch_other":
      return ATOMIC_MAX_SCRATCH_OTHER_METADATA_BYTES;
  }
}

function atomicRecordBytesClaimAvailable(
  flight: AtomicEffectFlightRecord,
  objectId: FlightSemanticId,
  role: AtomicObjectRoleV1,
  byteSize: number,
): boolean {
  const reservation = atomicByteReservation(role);
  if (reservation === null) return true;
  const scope = atomicMetadataByteScope(role);
  const previous =
    flight.recordByteReservations.get(objectId as object)?.byteSize ?? 0;
  return (
    flight.claimedBytes[reservation] - previous + byteSize <=
      flight.reservations[reservation].byteSize &&
    (scope === null ||
      flight.claimedScopedBytes[scope] - previous + byteSize <=
        atomicMetadataByteScopeLimit(scope))
  );
}

function claimAtomicRecordBytes(
  flight: AtomicEffectFlightRecord,
  objectId: FlightSemanticId,
  role: AtomicObjectRoleV1,
  byteSize: number,
): void {
  const reservation = atomicByteReservation(role);
  if (reservation === null) return;
  const scope = atomicMetadataByteScope(role);
  const previous =
    flight.recordByteReservations.get(objectId as object)?.byteSize ?? 0;
  if (
    flight.claimedBytes[reservation] - previous + byteSize >
      flight.reservations[reservation].byteSize ||
    (scope !== null &&
      flight.claimedScopedBytes[scope] - previous + byteSize >
        atomicMetadataByteScopeLimit(scope))
  ) {
    throw atomicFailure("atomic publication byte reservation is exhausted");
  }
  const increase = Math.max(0, byteSize - previous);
  flight.releaseByteCredits[reservation] = Math.max(
    0,
    flight.releaseByteCredits[reservation] - increase,
  );
  flight.claimedBytes[reservation] =
    flight.claimedBytes[reservation] - previous + byteSize;
  if (scope !== null) {
    flight.claimedScopedBytes[scope] =
      flight.claimedScopedBytes[scope] - previous + byteSize;
  }
  flight.recordByteReservations.set(
    objectId as object,
    Object.freeze({ reservation, byteSize, scope }),
  );
}

function creditAtomicTransientBytes(
  flight: AtomicEffectFlightRecord,
  reservation: "payload_bytes" | "manifest_bytes" | "other_metadata_bytes",
  byteSize: number,
): void {
  flight.releaseByteCredits[reservation] = Math.min(
    flight.releaseByteCredits[reservation] + byteSize,
    Math.max(
      0,
      flight.reservations[reservation].byteSize -
        flight.claimedBytes[reservation],
    ),
  );
}

function mintAtomicSemanticId(
  flight: AtomicEffectFlightRecord,
  record: AtomicHeldRecord,
  claimReservation = false,
): FlightSemanticId {
  if (
    flight.semanticCount + flight.partialCount >= ATOMIC_SEMANTIC_ID_LIMIT
  ) {
    throw atomicFailure("atomic publication semantic ID limit exceeded");
  }
  const reservation = atomicReservationRequirement(record.role).entry;
  if (
    claimReservation &&
    flight.claimedCounts[reservation] + 1 >
      flight.reservations[reservation].count
  ) {
    throw atomicFailure("atomic publication reservation is exhausted");
  }
  if (
    claimReservation &&
    record.role === "intent_stable" &&
    flight.activeStableIntents >= ATOMIC_MAX_ACTIVE_STABLE_INTENTS
  ) {
    throw atomicFailure("atomic stable intent limit exceeded");
  }
  if (
    claimReservation &&
    atomicRoleIsRecoveryRecord(record.role) &&
    flight.recoveryRecords >= ATOMIC_MAX_RECOVERY_RECORDS
  ) {
    throw atomicFailure("atomic recovery record limit exceeded");
  }
  const token = Object.freeze({}) as FlightSemanticId;
  flight.registry.set(token as object, record);
  flight.recordTokens.set(record, token);
  flight.records.add(record);
  flight.semanticCount += 1;
  if (claimReservation) {
    if (flight.releaseCountCredits[reservation] > 0) {
      flight.releaseCountCredits[reservation] -= 1;
    }
    flight.claimedCounts[reservation] += 1;
    if (record.role === "intent_stable") {
      flight.activeStableIntents += 1;
    }
    if (atomicRoleIsRecoveryRecord(record.role)) {
      flight.recoveryRecords += 1;
    }
    flight.recordReservations.set(token as object, reservation);
  }
  return token;
}

function mintAtomicPartialId(
  flight: AtomicEffectFlightRecord,
  record: AtomicPartialCreateRecord,
): FlightPartialCreateId {
  if (
    flight.partialCount >= ATOMIC_PARTIAL_ID_LIMIT ||
    flight.semanticCount + flight.partialCount >= ATOMIC_SEMANTIC_ID_LIMIT
  ) {
    throw atomicFailure("atomic publication partial ID limit exceeded");
  }
  const token = Object.freeze({}) as FlightPartialCreateId;
  flight.partials.set(token as object, record);
  flight.livePartials.add(record);
  flight.partialCount += 1;
  return token;
}

function atomicPrivateSourceRootId(
  flight: AtomicEffectFlightRecord,
  record: AtomicHeldRecord,
): FlightSemanticId | null {
  let current = record;
  const seen = new Set<AtomicHeldRecord>();
  while (current.role !== "private_source") {
    if (seen.has(current) || current.parentId === null) return null;
    seen.add(current);
    const parent = flight.registry.get(current.parentId as object);
    if (parent === undefined) return null;
    current = parent;
  }
  return flight.recordTokens.get(current) ?? null;
}

function atomicObservationDigest(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1,
  suffix: string,
): string {
  flight.effectCount += 1;
  return sha256(
    `${flight.operationId}\n${request.kind}\n${flight.effectCount}\n${suffix}`,
  );
}

function atomicRejected(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1,
  code:
    | "budget_exceeded"
    | "binding_invalid"
    | "conflict"
    | "unsupported"
    | "denied"
    | "io"
    | "close_unverified",
): AtomicEffectObservationV1 {
  return Object.freeze({
    kind: "effect_rejected",
    effectId: request.effectId,
    requestKind: request.kind,
    code,
    evidenceDigest: atomicObservationDigest(flight, request, code),
  });
}

function mapAtomicErrno(
  error: unknown,
):
  | "binding_invalid"
  | "conflict"
  | "unsupported"
  | "denied"
  | "io"
  | null {
  if (!isNodeError(error) || typeof error.code !== "string") return null;
  if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
    return "conflict";
  }
  if (
    error.code === "ENOENT" ||
    error.code === "ELOOP" ||
    error.code === "ENOTDIR" ||
    error.code === "ESTALE" ||
    error.code === "EBADF"
  ) {
    return "binding_invalid";
  }
  if (error.code === "EACCES" || error.code === "EPERM") return "denied";
  if (
    error.code === "ENOSYS" ||
    error.code === "ENOTSUP" ||
    error.code === "EOPNOTSUPP"
  ) {
    return "unsupported";
  }
  if (
    error.code === "EIO" ||
    error.code === "ENOSPC" ||
    error.code === "EDQUOT" ||
    error.code === "EROFS"
  ) {
    return "io";
  }
  return null;
}

function rejectAtomicFilesystemError(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1,
  error: unknown,
): AtomicEffectObservationV1 {
  const mapped = mapAtomicErrno(error);
  if (mapped !== null) return atomicRejected(flight, request, mapped);
  flight.state = "fail_stopped";
  flight.root.acceptingOperations = false;
  throw atomicFailure("atomic publication filesystem operation failed");
}

function assertAtomicProcfs(root: FileHandle): void {
  let probe = -1;
  const scenario =
    process.env.VITEST === "true"
      ? filesystemTestContext.getStore()?.atomicProcfsScenario
      : undefined;
  try {
    if (scenario === "missing") {
      throw atomicFailure("atomic publication procfs is unsupported");
    }
    const proc =
      scenario === "wrong_type"
        ? { type: 0n }
        : statfsSync("/proc/self/fd", { bigint: true });
    if (proc.type !== ATOMIC_PROCFS_MAGIC) {
      throw atomicFailure("atomic publication procfs is unsupported");
    }
    if (scenario === "inaccessible") {
      throw atomicFailure("atomic publication procfs is unsupported");
    }
    probe = openSync(
      "/proc/self/fd",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (scenario === "unsupported_operation") {
      throw atomicFailure("atomic publication procfs is unsupported");
    }
    const probeStat = fstatSync(probe, { bigint: true });
    if (!probeStat.isDirectory()) {
      throw atomicFailure("atomic publication procfs is unsupported");
    }
    closeSync(probe);
    probe = -1;
    const expected = atomicFstat(root);
    const rebound = statSync(`/proc/self/fd/${root.fd}`, { bigint: true });
    if (
      expected.dev !== rebound.dev ||
      expected.ino !== rebound.ino ||
      expected.isDirectory() !== rebound.isDirectory() ||
      !expected.isDirectory() ||
      scenario === "identity_mismatch"
    ) {
      throw atomicFailure("atomic publication procfd identity is unsupported");
    }
  } catch {
    throw atomicFailure("atomic publication procfs is unsupported");
  } finally {
    if (probe >= 0) {
      try {
        closeSync(probe);
      } catch {
        throw atomicFailure("atomic publication procfs is unsupported");
      }
    }
  }
}

function atomicStatfsType(handle: FileHandle): bigint {
  const scenario =
    process.env.VITEST === "true"
      ? filesystemTestContext.getStore()?.atomicStatfsScenario
      : undefined;
  if (scenario === "disallowed") return 0x6969n;
  try {
    return statfsSync(`/proc/self/fd/${handle.fd}`, {
      bigint: true,
    }).type;
  } catch {
    throw atomicFailure("atomic publication filesystem is unsupported");
  }
}

function assertAtomicAllowedFilesystem(handle: FileHandle): void {
  if (!ATOMIC_ALLOWED_FILESYSTEM_TYPES.has(atomicStatfsType(handle))) {
    throw atomicFailure("atomic publication filesystem is unsupported");
  }
}

function assertAtomicMountPair(
  source: AtomicHeldRecord,
  target: AtomicHeldRecord,
): void {
  assertAtomicAllowedFilesystem(source.handle);
  assertAtomicAllowedFilesystem(target.handle);
  const scenario =
    process.env.VITEST === "true"
      ? filesystemTestContext.getStore()?.atomicStatfsScenario
      : undefined;
  if (
    source.stat.dev !== target.stat.dev ||
    scenario === "device_mismatch"
  ) {
    throw atomicFailure("atomic publication filesystem crosses devices");
  }
}

function atomicFilesystemName(
  magic: bigint,
): Extract<
  AtomicEffectObservationV1,
  { kind: "statfs_observed" }
>["filesystem"] | null {
  switch (magic) {
    case 0xef53n:
      return "ext";
    case 0x58465342n:
      return "xfs";
    case 0x9123683en:
      return "btrfs";
    case 0x01021994n:
      return "tmpfs";
    case 0x794c7630n:
      return "overlay";
    default:
      return null;
  }
}

async function acquireAtomicFixedDirectory(
  root: RootCapabilityRecord,
  parent: FileHandle,
  leaf: string,
): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  const before = await call(root.anchored.admission, "atomic-authority-lstat", () =>
    fs.lstat(procPath(parent, leaf), { bigint: true }),
  );
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.nlink <= 0n ||
    before.uid !== atomicEffectiveUid() ||
    lowModeBigint(before.mode) !== 0o700
  ) {
    throw atomicFailure("atomic publication authority is invalid");
  }
  const handle = await callOpen(
    root.anchored.admission,
    "atomic-authority-open",
    () =>
      fs.open(
        procPath(parent, leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
  );
  try {
    const after = await call(root.anchored.admission, "atomic-authority-fstat", () =>
      handle.stat({ bigint: true }),
    );
    assertAtomicStat(
      before,
      after,
      "atomic publication authority binding changed",
    );
    return { handle, stat: after };
  } catch (error) {
    try {
      await closeRaw(handle, "atomic-authority-failed-open");
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "atomic publication authority cleanup failed",
      );
    }
    throw error;
  }
}

async function acquireAtomicPreReadyRecoveryAuthorityForBinding(
  root: AnchoredProfileRoot,
  operationId: string,
  durableBinding: ReadyProfileRootBinding,
): Promise<AtomicPreReadyRecoveryLeaseV1> {
  if (!UUID.test(operationId)) {
    throw atomicFailure("atomic publication operation ID is invalid");
  }
  const rootRecord = requireRoot(root);
  const binding = Object.freeze({
    ...durableBinding,
  });
  if (
    !tokenSchema.safeParse(binding.processNonce).success ||
    !tokenSchema.safeParse(binding.controlGenerationNonce).success ||
    !/^[a-f0-9]{64}$/u.test(binding.snapshotDigest)
  ) {
    throw atomicFailure("atomic publication root binding is invalid");
  }
  const releaseRootOperation = acquireRootOperation(rootRecord);
  const opened: FileHandle[] = [];
  try {
    await rootRecord.anchored.revalidate();
    assertAtomicProcfs(rootRecord.anchored.handle);
    const stateStat = await call(
      rootRecord.anchored.admission,
      "atomic-state-root-stat",
      () => rootRecord.anchored.handle.stat({ bigint: true }),
    );
    if (
      !stateStat.isDirectory() ||
      stateStat.uid !== atomicEffectiveUid() ||
      lowModeBigint(stateStat.mode) !== 0o700
    ) {
      throw atomicFailure("atomic publication state root is invalid");
    }
    assertAtomicAllowedFilesystem(rootRecord.anchored.handle);
    const profiles = await acquireAtomicFixedDirectory(
      rootRecord,
      rootRecord.anchored.handle,
      "profiles",
    );
    opened.push(profiles.handle);
    const staging = await acquireAtomicFixedDirectory(
      rootRecord,
      rootRecord.anchored.handle,
      ".profile-publish-staging",
    );
    opened.push(staging.handle);
    const bundles = await acquireAtomicFixedDirectory(
      rootRecord,
      staging.handle,
      "bundles",
    );
    opened.push(bundles.handle);
    const intents = await acquireAtomicFixedDirectory(
      rootRecord,
      staging.handle,
      "intents",
    );
    opened.push(intents.handle);
    if (
      profiles.stat.dev !== stateStat.dev ||
      staging.stat.dev !== stateStat.dev ||
      bundles.stat.dev !== stateStat.dev ||
      intents.stat.dev !== stateStat.dev
    ) {
      throw atomicFailure("atomic publication authority device is invalid");
    }
    assertAtomicAllowedFilesystem(profiles.handle);
    assertAtomicAllowedFilesystem(staging.handle);
    assertAtomicAllowedFilesystem(bundles.handle);
    assertAtomicAllowedFilesystem(intents.handle);
    const controller = Object.freeze({}) as AtomicEffectControllerV1;
    const flight: AtomicEffectFlightRecord = {
      state: "live",
      operationId,
      epoch: Object.freeze({}),
      root: rootRecord,
      binding,
      releaseRootOperation,
      registry: new WeakMap(),
      recordTokens: new WeakMap(),
      records: new Set(),
      removedRecords: new WeakSet(),
      enumerationCursors: new WeakMap(),
      populationCursors: new WeakMap(),
      canonicalizationCursors: new WeakMap(),
      profileEntries: new WeakMap(),
      partials: new WeakMap(),
      livePartials: new Set(),
      transientHandles: new Set(),
      seenEffects: new WeakSet(),
      revalidatedHandles: new WeakSet(),
      statfsHandles: new WeakMap(),
      contentStates: new WeakMap(),
      persistenceResolution: null,
      semanticCount: 0,
      partialCount: 0,
      effectCount: 0,
      activeStableIntents: 0,
      recoveryRecords: 0,
      reservations: {
        payload_entries: { count: 0, byteSize: 0 },
        payload_bytes: { count: 0, byteSize: 0 },
        scratch_entries: { count: 0, byteSize: 0 },
        stable_files: { count: 0, byteSize: 0 },
        scratch_files: { count: 0, byteSize: 0 },
        manifest_bytes: { count: 0, byteSize: 0 },
        other_metadata_bytes: { count: 0, byteSize: 0 },
      },
      releaseCountCredits: {
        payload_entries: 0,
        scratch_entries: 0,
        stable_files: 0,
        scratch_files: 0,
      },
      releaseByteCredits: {
        payload_bytes: 0,
        manifest_bytes: 0,
        other_metadata_bytes: 0,
      },
      claimedBytes: {
        payload_bytes: 0,
        manifest_bytes: 0,
        other_metadata_bytes: 0,
      },
      claimedScopedBytes: {
        stable_manifest: 0,
        scratch_manifest: 0,
        stable_other: 0,
        scratch_other: 0,
      },
      claimedCounts: {
        payload_entries: 0,
        scratch_entries: 0,
        stable_files: 0,
        scratch_files: 0,
      },
      recordReservations: new WeakMap(),
      recordByteReservations: new WeakMap(),
      intents: new WeakMap(),
      stableIntents: new Map(),
    };
    atomicEffectFlightRecords.set(controller as object, flight);
    const stateRootRecord: AtomicHeldRecord = Object.freeze({
      role: "state_root",
      operationId,
      parentId: null,
      leaf: null,
      handle: rootRecord.anchored.handle,
      binding,
      evidence: atomicEvidenceFromStat(stateStat),
      stat: stateStat,
      owned: false,
    });
    const stateRootId = mintAtomicSemanticId(flight, stateRootRecord);
    const profilesRecord: AtomicHeldRecord = Object.freeze({
      role: "profiles_parent",
      operationId,
      parentId: stateRootId,
      leaf: "profiles",
      handle: profiles.handle,
      binding,
      evidence: atomicEvidenceFromStat(profiles.stat),
      stat: profiles.stat,
      owned: true,
    });
    const profilesParentId = mintAtomicSemanticId(flight, profilesRecord);
    const stagingRecord: AtomicHeldRecord = Object.freeze({
      role: "staging_root",
      operationId,
      parentId: stateRootId,
      leaf: ".profile-publish-staging",
      handle: staging.handle,
      binding,
      evidence: atomicEvidenceFromStat(staging.stat),
      stat: staging.stat,
      owned: true,
    });
    const stagingRootId = mintAtomicSemanticId(flight, stagingRecord);
    const bundlesRecord: AtomicHeldRecord = Object.freeze({
      role: "bundles_parent",
      operationId,
      parentId: stagingRootId,
      leaf: "bundles",
      handle: bundles.handle,
      binding,
      evidence: atomicEvidenceFromStat(bundles.stat),
      stat: bundles.stat,
      owned: true,
    });
    const bundlesParentId = mintAtomicSemanticId(flight, bundlesRecord);
    const intentsRecord: AtomicHeldRecord = Object.freeze({
      role: "intents_parent",
      operationId,
      parentId: stagingRootId,
      leaf: "intents",
      handle: intents.handle,
      binding,
      evidence: atomicEvidenceFromStat(intents.stat),
      stat: intents.stat,
      owned: true,
    });
    const intentsParentId = mintAtomicSemanticId(flight, intentsRecord);
    const authority = Object.freeze({}) as PreReadyRecoveryAuthority;
    preReadyRecoveryAuthorityRecords.set(authority as object, {
      controller,
      binding,
      digest: sha256(
        JSON.stringify({
          implementation: ATOMIC_HELD_PROFILE_HASH_IMPLEMENTATION,
          operationId,
          binding,
          state: stateRootRecord.evidence.evidenceDigest,
          profiles: profilesRecord.evidence.evidenceDigest,
          staging: stagingRecord.evidence.evidenceDigest,
          bundles: bundlesRecord.evidence.evidenceDigest,
          intents: intentsRecord.evidence.evidenceDigest,
        }),
      ),
    });
    return Object.freeze({
      controller,
      authority,
      initialAuthority: Object.freeze({
        stateRootId,
        profilesParentId,
        stagingRootId,
        bundlesParentId,
        intentsParentId,
        evidence: Object.freeze({
          stateRoot: stateRootRecord.evidence,
          profilesParent: profilesRecord.evidence,
          stagingRoot: stagingRecord.evidence,
          bundlesParent: bundlesRecord.evidence,
          intentsParent: intentsRecord.evidence,
        }),
      }),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    for (const [index, handle] of [...opened].reverse().entries()) {
      try {
        await closeRaw(handle, `atomic-authority-cleanup-${index}`);
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    releaseRootOperation();
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "atomic publication authority cleanup failed",
      );
    }
    throw error;
  }
}

export async function acquireAtomicPreReadyRecoveryAuthority(
  root: AnchoredProfileRoot,
  operationId: string,
): Promise<AtomicPreReadyRecoveryLeaseV1> {
  return acquireAtomicPreReadyRecoveryAuthorityForBinding(
    root,
    operationId,
    requireRoot(root).binding,
  );
}

export type AtomicCanonicalRootRecoveryLeaseV1 =
  AtomicPreReadyRecoveryLeaseV1 &
    Readonly<{
      closeRoot: () => Promise<void>;
    }>;

export async function acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
  canonicalRoot: string,
  binding: ReadyProfileRootBinding,
  admission: ReconciliationExecutionAdmission,
  operationId: string,
): Promise<AtomicCanonicalRootRecoveryLeaseV1> {
  if (
    !tokenSchema.safeParse(binding.processNonce).success ||
    !tokenSchema.safeParse(binding.controlGenerationNonce).success ||
    !/^[a-f0-9]{64}$/u.test(binding.snapshotDigest)
  ) {
    throw atomicFailure("atomic publication root binding is invalid");
  }
  const anchored = await openAnchoredRoot(canonicalRoot, admission);
  const rootRecord: RootCapabilityRecord = {
    state: "live",
    token: null,
    anchored,
    binding: Object.freeze({ ...binding }),
    children: new Set(),
    sealedGenerations: new Map(),
    acceptingOperations: true,
    activeOperations: 0,
    drainWaiters: new Set(),
    childDrainWaiters: new Set(),
    authorities: new Set(),
    partialCreateCleanups: new Set(),
    observability: null,
  };
  const root = Object.freeze({}) as AnchoredProfileRoot;
  rootRecord.token = root;
  rootCapabilityRecords.set(root as object, rootRecord);
  try {
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      root,
      operationId,
    );
    return Object.freeze({
      ...lease,
      closeRoot: () => closeAnchoredProfileRoot(root),
    });
  } catch (error) {
    try {
      await closeAnchoredProfileRoot(root);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "atomic publication root cleanup failed",
      );
    }
    throw error;
  }
}

function requireAtomicFlight(
  controller: AtomicEffectControllerV1,
  allowFailedCleanup = false,
): AtomicEffectFlightRecord {
  const flight = atomicEffectFlightRecords.get(controller as object);
  if (
    flight === undefined ||
    (flight.state !== "live" &&
      (!allowFailedCleanup || flight.state !== "fail_stopped"))
  ) {
    throw atomicFailure("atomic publication controller is not live");
  }
  return flight;
}

function assertAtomicRequest(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1,
): void {
  if (
    request.operationId !== flight.operationId ||
    typeof request.effectId !== "object" ||
    request.effectId === null ||
    flight.seenEffects.has(request.effectId as object)
  ) {
    throw atomicFailure("atomic publication effect is invalid");
  }
  flight.seenEffects.add(request.effectId as object);
}

async function applyAtomicReservation(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "reserve_budget" | "release_budget" }
  >,
): Promise<AtomicEffectObservationV1> {
  if (
    !Number.isSafeInteger(request.count) ||
    request.count < 0 ||
    !Number.isSafeInteger(request.byteSize) ||
    request.byteSize < 0
  ) {
    return atomicRejected(flight, request, "binding_invalid");
  }
  const current = flight.reservations[request.reservation];
  const limit = ATOMIC_RESERVATION_LIMITS[request.reservation];
  if (request.kind === "reserve_budget") {
    const nextTotalEntries =
      flight.reservations.payload_entries.count +
      flight.reservations.scratch_entries.count +
      flight.reservations.stable_files.count +
      flight.reservations.scratch_files.count +
      request.count;
    if (
      (limit.count > 0 && current.count + request.count > limit.count) ||
      (limit.byteSize > 0 &&
        current.byteSize + request.byteSize > limit.byteSize) ||
      nextTotalEntries >
        ATOMIC_MAX_PAYLOAD_ENTRIES +
          ATOMIC_MAX_SCRATCH_ENTRIES +
          ATOMIC_MAX_METADATA_FILES
    ) {
      return atomicRejected(flight, request, "budget_exceeded");
    }
    current.count += request.count;
    current.byteSize += request.byteSize;
  } else {
    if (
      request.count > current.count ||
      request.byteSize > current.byteSize ||
      (request.byteSize > 0 &&
        (request.reservation === "payload_bytes" ||
          request.reservation === "manifest_bytes" ||
          request.reservation === "other_metadata_bytes") &&
        request.byteSize >
          flight.releaseByteCredits[request.reservation]) ||
      (request.count > 0 &&
        (request.reservation === "payload_bytes" ||
          request.reservation === "manifest_bytes" ||
          request.reservation === "other_metadata_bytes" ||
          request.count >
            flight.releaseCountCredits[request.reservation]))
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    current.count -= request.count;
    current.byteSize -= request.byteSize;
    if (
      request.byteSize > 0 &&
      (request.reservation === "payload_bytes" ||
        request.reservation === "manifest_bytes" ||
        request.reservation === "other_metadata_bytes")
    ) {
      flight.releaseByteCredits[request.reservation] -= request.byteSize;
      flight.releaseByteCredits[request.reservation] = Math.min(
        flight.releaseByteCredits[request.reservation],
        current.byteSize - flight.claimedBytes[request.reservation],
      );
    }
    if (
      request.count > 0 &&
      request.reservation !== "payload_bytes" &&
      request.reservation !== "manifest_bytes" &&
      request.reservation !== "other_metadata_bytes"
    ) {
      flight.releaseCountCredits[request.reservation] -= request.count;
    }
  }
  return Object.freeze({
    kind: "effect_completed",
    effectId: request.effectId,
    requestKind: request.kind,
    evidenceDigest: atomicObservationDigest(flight, request, "budget"),
    count: request.count,
    byteSize: request.byteSize,
  });
}

async function applyAtomicCreate(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    {
      kind:
        | "create_and_pin_wrapper"
        | "create_and_pin_directory"
        | "create_and_pin_file"
        | "create_and_pin_temp_file";
    }
  >,
): Promise<AtomicEffectObservationV1> {
  let parent: AtomicHeldRecord;
  try {
    parent = resolveAtomicRecord(flight, request.parentId);
    validateAtomicLeaf(request.role, request.leaf);
    if (
      request.expectedAbsence !== true ||
      request.parentEvidenceDigest !== parent.evidence.evidenceDigest
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
  } catch {
    return atomicRejected(flight, request, "binding_invalid");
  }
  const directory =
    request.kind === "create_and_pin_wrapper" ||
    request.kind === "create_and_pin_directory";
  if (
    (directory && request.mode !== 0o700) ||
    (!directory && request.mode !== 0o600)
  ) {
    return atomicRejected(flight, request, "binding_invalid");
  }
  if (
    !atomicReservationAvailable(
      flight,
      atomicReservationRequirement(request.role),
      1,
      0,
    )
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  if (
    flight.partialCount >= ATOMIC_PARTIAL_ID_LIMIT ||
    flight.semanticCount + flight.partialCount >=
      ATOMIC_SEMANTIC_ID_LIMIT
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  let entryCreated = false;
  let handle: FileHandle | null = null;
  let stat: BigIntStats | null = null;
  try {
    if (directory) {
      await atomicAwait(flight, [parent], "atomic-create-mkdir", async () => {
        await fs.mkdir(procPath(parent.handle, request.leaf), {
          mode: 0o700,
          recursive: false,
        });
        entryCreated = true;
      });
      handle = await atomicAwait(
        flight,
        [parent],
        "atomic-create-open",
        async () => {
          filesystemTestContext.getStore()?.atomicOpenFlags?.(
            "atomic-create-open",
            constants.O_RDONLY |
              constants.O_DIRECTORY |
              constants.O_NOFOLLOW,
          );
          const acquired = await fs.open(
          procPath(parent.handle, request.leaf),
          constants.O_RDONLY |
            constants.O_DIRECTORY |
            constants.O_NOFOLLOW,
          );
          handle = acquired;
          return acquired;
        },
      );
    } else {
      handle = await atomicAwait(
        flight,
        [parent],
        "atomic-create-open",
        async () => {
          filesystemTestContext.getStore()?.atomicOpenFlags?.(
            "atomic-create-open",
            constants.O_RDWR |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          const acquired = await fs.open(
          procPath(parent.handle, request.leaf),
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
          );
          handle = acquired;
          entryCreated = true;
          return acquired;
        },
      );
    }
    stat = await atomicAwait(
      flight,
      [parent],
      "atomic-create-fstat",
      async () => {
        const observed = await handle!.stat({ bigint: true });
        stat = observed;
        return observed;
      },
    );
    if (
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.isSymbolicLink() ||
      (directory ? stat.nlink <= 0n : stat.nlink !== 1n) ||
      lowModeBigint(stat.mode) !== request.mode ||
      stat.uid !== atomicEffectiveUid()
    ) {
      throw atomicFailure("atomic publication created object is invalid");
    }
    const evidence = atomicEvidenceFromStat(stat);
    const held: AtomicHeldRecord = Object.freeze({
      role: request.role,
      operationId: request.operationId,
      parentId: request.parentId,
      leaf: request.leaf,
      handle,
      binding: parent.binding,
      evidence,
      stat,
      owned: true,
    });
    const handleId = mintAtomicSemanticId(flight, held, true);
    if (!directory) {
      flight.contentStates.set(handleId as object, {
        size: 0,
        contentSha256: sha256(Buffer.alloc(0)),
        synced: false,
      });
    }
    if (request.role === "private_source") {
      flight.profileEntries.set(handleId as object, []);
    } else if (request.role === "payload_entry") {
      const rootId = atomicPrivateSourceRootId(flight, held);
      if (rootId !== null) {
        const entries = flight.profileEntries.get(rootId as object);
        entries?.push(held);
      }
    }
    return Object.freeze({
      kind: "create_and_pin_completed",
      effectId: request.effectId,
      requestKind: request.kind,
      handleId,
      evidence,
    });
  } catch (error) {
    const mapped = mapAtomicErrno(error);
    if (!entryCreated) {
      if (mapped === null) {
        flight.state = "fail_stopped";
        flight.root.acceptingOperations = false;
        if (error instanceof BrowserServiceError) throw error;
        throw atomicFailure("atomic publication filesystem operation failed");
      }
      return atomicRejected(flight, request, mapped);
    }
    if (mapped === null) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
    }
    const evidence = stat === null ? null : atomicEvidenceFromStat(stat);
    const partialId = mintAtomicPartialId(flight, {
      operationId: request.operationId,
      parentId: request.parentId,
      leaf: request.leaf,
      role: request.role,
      type: directory ? "directory" : "file",
      mode: request.mode,
      handle,
      stat,
      evidence,
      used: false,
    });
    return Object.freeze({
      kind: "create_and_pin_partial",
      effectId: request.effectId,
      requestKind: request.kind,
      partialId,
      stage:
        handle === null
          ? "entry_created"
          : stat === null
            ? "fstat_failed"
            : "handle_opened",
      entryCreated: true,
      handleOpened: handle !== null,
      evidence,
      code: mapped === "denied" ? "denied" : mapped === "binding_invalid"
        ? "binding_invalid"
        : "io",
      evidenceDigest: atomicObservationDigest(flight, request, "partial"),
    });
  }
}

function atomicPartialFailure(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "cleanup_partial_create" }
  >,
  stage:
    | "close"
    | "identity_verify"
    | "remove"
    | "absence_verify"
    | "parent_fsync",
  state: "present" | "unknown" | "absent_unsynced",
  code: "binding_invalid" | "denied" | "io" | "close_unverified",
): AtomicEffectObservationV1 {
  flight.state = "fail_stopped";
  flight.root.acceptingOperations = false;
  return Object.freeze({
    kind: "partial_create_cleanup_failed",
    effectId: request.effectId,
    partialId: request.partialId,
    stage,
    state,
    parentSynced: false,
    code,
    evidenceDigest: atomicObservationDigest(flight, request, stage),
  });
}

async function applyAtomicPartialCleanup(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "cleanup_partial_create" }
  >,
): Promise<AtomicEffectObservationV1> {
  const partial = flight.partials.get(request.partialId as object);
  if (
    partial === undefined ||
    partial.used ||
    partial.operationId !== request.operationId
  ) {
    return atomicRejected(flight, request, "binding_invalid");
  }
  partial.used = true;
  const parent = resolveAtomicRecord(flight, partial.parentId);
  if (partial.handle !== null) {
    try {
      const handle = partial.handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        "atomic-partial-close",
        () => handle.close(),
        () => {
          partial.handle = null;
        },
      );
    } catch {
      return atomicPartialFailure(
        flight,
        request,
        "close",
        "unknown",
        "close_unverified",
      );
    }
  }
  let before: BigIntStats;
  let pin: FileHandle | null = null;
  try {
    try {
      before = await atomicCleanupAwait(
        flight,
        [parent],
        "atomic-partial-lstat",
        () => fs.lstat(procPath(parent.handle, partial.leaf), { bigint: true }),
      );
    } catch {
      return atomicPartialFailure(
        flight,
        request,
        "identity_verify",
        "unknown",
        "binding_invalid",
      );
    }
    if (
      (partial.type === "directory"
        ? !before.isDirectory()
        : !before.isFile()) ||
      before.isSymbolicLink() ||
      lowModeBigint(before.mode) !== partial.mode ||
      (partial.stat !== null &&
        !sameObjectIdentity(partial.stat, before))
    ) {
      return atomicPartialFailure(
        flight,
        request,
        "identity_verify",
        "present",
        "binding_invalid",
      );
    }
    let pinned: BigIntStats;
    let recheck: BigIntStats;
    try {
      pin = await atomicCleanupAwait(
        flight,
        [parent],
        "atomic-partial-open",
        async () => {
          const acquired = await fs.open(
            procPath(parent.handle, partial.leaf),
            constants.O_RDONLY |
              constants.O_NOFOLLOW |
              (partial.type === "directory" ? constants.O_DIRECTORY : 0),
          );
          pin = acquired;
          return acquired;
        },
      );
      pinned = await atomicCleanupAwait(
        flight,
        [parent],
        "atomic-partial-fstat",
        () => pin!.stat({ bigint: true }),
      );
      recheck = await atomicCleanupAwait(
        flight,
        [parent],
        "atomic-partial-recheck",
        () => fs.lstat(procPath(parent.handle, partial.leaf), { bigint: true }),
      );
    } catch {
      return atomicPartialFailure(
        flight,
        request,
        "identity_verify",
        "present",
        "binding_invalid",
      );
    }
    if (!sameObjectIdentity(before, pinned)) {
      return atomicPartialFailure(
        flight,
        request,
        "identity_verify",
        "present",
        "binding_invalid",
      );
    }
    if (!sameObjectIdentity(before, recheck)) {
      return atomicPartialFailure(
        flight,
        request,
        "identity_verify",
        "present",
        "binding_invalid",
      );
    }
    try {
      await atomicCleanupAwait(
        flight,
        [parent],
        "atomic-partial-remove",
        () =>
          partial.type === "directory"
            ? fs.rmdir(procPath(parent.handle, partial.leaf))
            : fs.unlink(procPath(parent.handle, partial.leaf)),
      );
    } catch (error) {
      const code = mapAtomicErrno(error);
      return atomicPartialFailure(
        flight,
        request,
        "remove",
        "unknown",
        code === "denied" ? "denied" : code === "binding_invalid"
          ? "binding_invalid"
          : "io",
      );
    }
    try {
      const handle = pin;
      await atomicVerifiedClose(
        flight,
        [parent],
        "atomic-partial-pin-close",
        () => handle.close(),
        () => {
          pin = null;
        },
      );
    } catch {
      return atomicPartialFailure(
        flight,
        request,
        "close",
        "absent_unsynced",
        "close_unverified",
      );
    }
    try {
      await atomicCleanupAwait(
        flight,
        [parent],
        "atomic-partial-absence",
        async () => {
          try {
            await fs.lstat(procPath(parent.handle, partial.leaf), {
              bigint: true,
            });
          } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return;
            throw error;
          }
          throw atomicFailure("atomic partial create still exists");
        },
      );
    } catch {
      return atomicPartialFailure(
        flight,
        request,
        "absence_verify",
        "unknown",
        "binding_invalid",
      );
    }
    try {
      await atomicCleanupAwait(
        flight,
        [parent],
        "atomic-partial-parent-fsync",
        () => parent.handle.sync(),
      );
    } catch {
      return atomicPartialFailure(
        flight,
        request,
        "parent_fsync",
        "absent_unsynced",
        "io",
      );
    }
    flight.partials.delete(request.partialId as object);
    flight.livePartials.delete(partial);
    return Object.freeze({
      kind: "partial_create_cleanup_observed",
      effectId: request.effectId,
      partialId: request.partialId,
      state: "absent",
      parentSynced: true,
      evidenceDigest: atomicObservationDigest(flight, request, "cleaned"),
    });
  } finally {
    if (pin !== null) {
      try {
        const handle = pin;
        await atomicVerifiedClose(
          flight,
          [parent],
          "atomic-partial-final-close",
          () => handle.close(),
          () => {
            pin = null;
          },
        );
      } catch {
        return atomicPartialFailure(
          flight,
          request,
          "close",
          "unknown",
          "close_unverified",
        );
      }
    }
  }
}

async function atomicHeldFileContentSha256(
  flight: AtomicEffectFlightRecord,
  records: readonly AtomicHeldRecord[],
  handle: FileHandle,
  expected: BigIntStats,
  point: string,
): Promise<string> {
  const hashed = await reconciliationPrivateHeldFileHash(
    handle,
    expected,
    (chunk, offset) =>
      atomicAwait(
        flight,
        records,
        `${point}-read`,
        () => handle.read(chunk, 0, chunk.byteLength, offset),
      ),
    () =>
      atomicAwait(
        flight,
        records,
        `${point}-stat`,
        () => handle.stat({ bigint: true }),
      ),
  );
  return hashed.contentSha256;
}

async function applyAtomicOpen(
  flight: AtomicEffectFlightRecord,
  request: Extract<AtomicEffectRequestV1, { kind: "open_pin_handle" }>,
): Promise<AtomicEffectObservationV1> {
  let parent: AtomicHeldRecord;
  try {
    parent = resolveAtomicRecord(flight, request.parentId);
    validateAtomicLeaf(request.role, request.leaf);
    if (!atomicEvidenceIsCanonical(request.expected)) {
      return atomicRejected(flight, request, "binding_invalid");
    }
  } catch {
    return atomicRejected(flight, request, "binding_invalid");
  }
  const directory = request.flags === "directory_nofollow";
  const writable = request.flags === "file_write_nofollow";
  if (
    flight.semanticCount + flight.partialCount >=
    ATOMIC_SEMANTIC_ID_LIMIT
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  const openRequirement = atomicReservationRequirement(request.role);
  if (
    atomicRoleClaimsReservation(request.role) &&
    !atomicReservationAvailable(flight, openRequirement, 1, 0)
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  if (
    !directory &&
    !atomicReservationAvailable(
      flight,
      openRequirement,
      0,
      request.expected.size,
    )
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  const openByteReservation = atomicByteReservation(request.role);
  const openByteScope = atomicMetadataByteScope(request.role);
  if (
    !directory &&
    openByteReservation !== null &&
    flight.claimedBytes[openByteReservation] + request.expected.size >
      flight.reservations[openByteReservation].byteSize
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  if (
    !directory &&
    openByteScope !== null &&
    flight.claimedScopedBytes[openByteScope] + request.expected.size >
      atomicMetadataByteScopeLimit(openByteScope)
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  const flags =
    (writable ? constants.O_RDWR : constants.O_RDONLY) |
    constants.O_NOFOLLOW |
    (directory ? constants.O_DIRECTORY : 0);
  let handle: FileHandle | null = null;
  try {
    handle = await atomicAwait(
      flight,
      [parent],
      "atomic-open-existing",
      async () => {
        filesystemTestContext.getStore()?.atomicOpenFlags?.(
          "atomic-open-existing",
          flags,
        );
        const acquired = await fs.open(
          procPath(parent.handle, request.leaf),
          flags,
        );
        handle = acquired;
        return acquired;
      },
    );
    let stat: BigIntStats | null = null;
    stat = await atomicAwait(
      flight,
      [parent],
      "atomic-open-existing-fstat",
      async () => {
        const observed = await handle!.stat({ bigint: true });
        stat = observed;
        return observed;
      },
    );
    if (
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.isSymbolicLink() ||
      (!directory && stat.nlink !== 1n) ||
      (directory
        ? request.expected.contentSha256 !== null
        : request.expected.contentSha256 === null)
    ) {
      throw atomicFailure("atomic publication existing object is invalid");
    }
    const contentSha256 = directory
      ? null
      : await atomicHeldFileContentSha256(
        flight,
        [parent],
        handle,
        stat,
        "atomic-open-existing-hash",
      );
    const evidence =
      directory && request.expected.size === 0
        ? atomicEvidenceFromStat(
            {
              ...stat,
              size: 0n,
            } as BigIntStats,
            contentSha256,
          )
        : atomicEvidenceFromStat(stat, contentSha256);
    if (!sameAtomicEvidence(request.expected, evidence)) {
      throw atomicFailure("atomic publication existing object is invalid");
    }
    const held: AtomicHeldRecord = Object.freeze({
      role: request.role,
      operationId: request.operationId,
      parentId: request.parentId,
      leaf: request.leaf,
      handle,
      binding: parent.binding,
      evidence,
      stat,
      owned: true,
    });
    const handleId = mintAtomicSemanticId(
      flight,
      held,
      atomicRoleClaimsReservation(held.role),
    );
    if (!directory && contentSha256 !== null) {
      flight.contentStates.set(handleId as object, {
        size: Number(stat.size),
        contentSha256,
        synced: true,
      });
      claimAtomicRecordBytes(
        flight,
        handleId,
        request.role,
        Number(stat.size),
      );
      if (request.role === "intent_stable") {
        const stable = flight.stableIntents.get(request.leaf);
        if (
          stable !== undefined &&
          stable.contentSha256 === contentSha256
        ) {
          flight.intents.set(handleId as object, stable.intent);
        }
      }
    }
    return Object.freeze({
      kind: "existing_handle_pinned",
      effectId: request.effectId,
      handleId,
      evidence,
    });
  } catch (error) {
    if (handle !== null) {
      const acquired = handle;
      try {
        await atomicVerifiedClose(
          flight,
          [parent],
          "atomic-open-existing-close",
          () => acquired.close(),
          () => {
            handle = null;
          },
        );
      } catch {
        return atomicRejected(flight, request, "close_unverified");
      }
    }
    if (error instanceof BrowserServiceError && flight.state === "live") {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const mapped = mapAtomicErrno(error);
    if (mapped !== null) return atomicRejected(flight, request, mapped);
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw atomicFailure("atomic publication filesystem operation failed");
  }
}

async function applyAtomicRevalidateOrSync(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1 & {
    kind:
      | "revalidate_handle"
      | "fsync_file"
      | "fsync_directory"
      | "fsync_parent";
  },
): Promise<AtomicEffectObservationV1> {
  let record: AtomicHeldRecord;
  try {
    record = resolveAtomicRecord(flight, request.objectId);
    if (
      record.role !== request.role ||
      !sameAtomicEvidence(record.evidence, request.expected)
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
  } catch {
    return atomicRejected(flight, request, "binding_invalid");
  }
  try {
    if (request.kind === "revalidate_handle") {
      atomicGate(flight, [record], "before", "atomic-revalidate");
      if (record.stat.isDirectory()) {
        assertAtomicAllowedFilesystem(record.handle);
      }
      atomicGate(flight, [record], "after", "atomic-revalidate");
      flight.revalidatedHandles.add(request.objectId as object);
    } else {
      await atomicAwait(flight, [record], "atomic-fsync", () =>
        record.handle.sync(),
      );
      if (request.kind === "fsync_file") {
        const content = flight.contentStates.get(
          request.objectId as object,
        );
        if (content !== undefined) content.synced = true;
      }
    }
    return Object.freeze({
      kind: "effect_completed",
      effectId: request.effectId,
      requestKind: request.kind,
      evidenceDigest: atomicObservationDigest(
        flight,
        request,
        "validated",
      ),
      count: 1,
      byteSize: 0,
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

function applyAtomicStatfs(
  flight: AtomicEffectFlightRecord,
  request: Extract<AtomicEffectRequestV1, { kind: "statfs_parent" }>,
): AtomicEffectObservationV1 {
  let record: AtomicHeldRecord;
  try {
    record = resolveAtomicRecord(flight, request.objectId);
    if (
      record.role !== request.role ||
      !record.stat.isDirectory() ||
      !sameAtomicEvidence(record.evidence, request.expected)
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    atomicGate(flight, [record], "before", "atomic-statfs");
    const magic = atomicStatfsType(record.handle);
    const filesystem = atomicFilesystemName(magic);
    atomicGate(flight, [record], "after", "atomic-statfs");
    if (filesystem === null) {
      return atomicRejected(flight, request, "unsupported");
    }
    flight.statfsHandles.set(
      request.objectId as object,
      Object.freeze({
        device: String(record.stat.dev),
        filesystem,
      }),
    );
    return Object.freeze({
      kind: "statfs_observed",
      effectId: request.effectId,
      objectId: request.objectId,
      filesystem,
      magic: `0x${magic.toString(16)}`,
      device: String(record.stat.dev),
      evidenceDigest: atomicObservationDigest(
        flight,
        request,
        `${filesystem}:${magic.toString(16)}:${record.stat.dev}`,
      ),
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function applyAtomicClose(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1 & { kind: "close_handle" },
): Promise<AtomicEffectObservationV1> {
  let record: AtomicHeldRecord;
  try {
    record = resolveAtomicRecord(flight, request.objectId);
    const content = flight.contentStates.get(request.objectId as object);
    const currentEvidence =
      record.stat.isFile()
        ? atomicPinnedContentEvidence(flight, request.objectId, record) ??
          record.evidence
        : record.evidence;
    if (
      !record.owned ||
      record.role !== request.role ||
      !sameAtomicEvidence(currentEvidence, request.expected)
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const parent =
      record.parentId === null
        ? null
        : resolveAtomicRecord(flight, record.parentId);
    await atomicVerifiedClose(
      flight,
      parent === null ? [] : [parent],
      "atomic-close",
      () => record.handle.close(),
      () => {
        flight.registry.delete(request.objectId as object);
        flight.recordTokens.delete(record);
        flight.records.delete(record);
        flight.contentStates.delete(request.objectId as object);
        const entry = flight.recordReservations.get(
          request.objectId as object,
        );
        if (entry !== undefined) {
          flight.recordReservations.delete(request.objectId as object);
          flight.claimedCounts[entry] -= 1;
          flight.releaseCountCredits[entry] += 1;
          if (record.role === "intent_stable") {
            flight.activeStableIntents -= 1;
          }
          if (atomicRoleIsRecoveryRecord(record.role)) {
            flight.recoveryRecords -= 1;
          }
        }
        const byteClaim = flight.recordByteReservations.get(
          request.objectId as object,
        );
        if (byteClaim !== undefined) {
          flight.recordByteReservations.delete(request.objectId as object);
          flight.claimedBytes[byteClaim.reservation] -= byteClaim.byteSize;
          if (byteClaim.scope !== null) {
            flight.claimedScopedBytes[byteClaim.scope] -=
              byteClaim.byteSize;
          }
          flight.releaseByteCredits[byteClaim.reservation] +=
            byteClaim.byteSize;
        }
      },
    );
    return Object.freeze({
      kind: "effect_completed",
      effectId: request.effectId,
      requestKind: request.kind,
      evidenceDigest: atomicObservationDigest(flight, request, "closed"),
      count: 1,
      byteSize: 0,
    });
  } catch {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    return atomicRejected(flight, request, "close_unverified");
  }
}

async function applyAtomicRead(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1 & { kind: "read_file_chunk" },
): Promise<AtomicEffectObservationV1> {
  let record: AtomicHeldRecord;
  try {
    record = resolveAtomicRecord(flight, request.objectId);
    if (
      record.role !== request.role ||
      !sameAtomicEvidence(record.evidence, request.expected) ||
      !Number.isSafeInteger(request.cursor) ||
      request.cursor < 0 ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength < 0 ||
      request.byteLength > ATOMIC_OBSERVATION_BYTE_LIMIT
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
  } catch {
    return atomicRejected(flight, request, "binding_invalid");
  }
  const requirement = atomicReservationRequirement(record.role);
  if (
    !atomicReservationAvailable(
      flight,
      requirement,
      0,
      request.byteLength,
    )
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  try {
    const bytes = Buffer.alloc(request.byteLength);
    const read = await atomicAwait(flight, [record], "atomic-read-chunk", () =>
      record.handle.read(bytes, 0, bytes.length, request.cursor),
    );
    const chunk = bytes.subarray(0, read.bytesRead);
    creditAtomicTransientBytes(
      flight,
      atomicReservationRequirement(record.role).bytes,
      request.byteLength,
    );
    return Object.freeze({
      kind: "file_chunk_observed",
      effectId: request.effectId,
      cursor: request.cursor,
      byteSize: chunk.byteLength,
      bytesBase64: chunk.toString("base64"),
      contentDigest: sha256(chunk),
      eof: request.cursor + chunk.byteLength >= record.evidence.size,
      evidenceDigest: atomicObservationDigest(flight, request, "read"),
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function applyAtomicHashChunk(
  flight: AtomicEffectFlightRecord,
  request: Extract<AtomicEffectRequestV1, { kind: "hash_content_chunk" }>,
): Promise<AtomicEffectObservationV1> {
  let record: AtomicHeldRecord;
  try {
    record = resolveAtomicRecord(flight, request.objectId);
    if (
      request.evidenceDigest !== record.evidence.evidenceDigest ||
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength < 0 ||
      request.byteLength > ATOMIC_OBSERVATION_BYTE_LIMIT
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
  } catch {
    return atomicRejected(flight, request, "binding_invalid");
  }
  const requirement = atomicReservationRequirement(record.role);
  if (
    !atomicReservationAvailable(
      flight,
      requirement,
      0,
      request.byteLength,
    )
  ) {
    return atomicRejected(flight, request, "budget_exceeded");
  }
  try {
    const bytes = Buffer.alloc(request.byteLength);
    const read = await atomicAwait(flight, [record], "atomic-hash-chunk", () =>
      record.handle.read(bytes, 0, bytes.length, request.offset),
    );
    const chunk = bytes.subarray(0, read.bytesRead);
    creditAtomicTransientBytes(
      flight,
      atomicReservationRequirement(record.role).bytes,
      request.byteLength,
    );
    return Object.freeze({
      kind: "content_observed",
      effectId: request.effectId,
      requestKind: request.kind,
      cursor: request.offset,
      byteSize: chunk.byteLength,
      contentDigest: sha256(chunk),
      evidenceDigest: atomicObservationDigest(flight, request, "hash"),
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function applyAtomicPopulatePayloadEntry(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1 & { kind: "populate_payload_entry" },
): Promise<AtomicEffectObservationV1> {
  let root: AtomicHeldRecord;
  try {
    root = resolveAtomicRecord(flight, request.rootId);
    const expectedCursor =
      flight.populationCursors.get(request.rootId as object) ?? 0;
    if (
      (root.role !== "private_source" &&
        root.role !== "payload_entry") ||
      !root.stat.isDirectory() ||
      request.cursor !== expectedCursor
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const current = await atomicAwait(
      flight,
      [root],
      "atomic-populate-entry-step",
      () => root.handle.stat({ bigint: true }),
    );
    assertAtomicStat(
      root.stat,
      current,
      "atomic publication population root changed",
    );
    flight.populationCursors.set(
      request.rootId as object,
      request.cursor + 1,
    );
    return Object.freeze({
      kind: "effect_completed",
      effectId: request.effectId,
      requestKind: request.kind,
      evidenceDigest: atomicObservationDigest(
        flight,
        request,
        request.evidenceDigest,
      ),
      count: 1,
      byteSize: 0,
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function applyAtomicCanonicalizeTreeStep(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1 & { kind: "canonicalize_tree_step" },
): Promise<AtomicEffectObservationV1> {
  let root: AtomicHeldRecord;
  try {
    root = resolveAtomicRecord(flight, request.rootId);
    const entries = flight.profileEntries.get(request.rootId as object);
    const expectedCursor =
      flight.canonicalizationCursors.get(request.rootId as object) ?? 0;
    if (
      root.role !== "private_source" ||
      !root.stat.isDirectory() ||
      entries === undefined ||
      request.cursor !== expectedCursor
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const selected =
      request.cursor === 0 ? root : entries[request.cursor - 1];
    if (selected === undefined) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const current = await atomicAwait(
      flight,
      selected === root ? [root] : [root, selected],
      "atomic-canonicalize-tree-step",
      () => selected.handle.stat({ bigint: true }),
    );
    assertAtomicStat(
      selected.stat,
      current,
      "atomic publication canonical entry changed",
    );
    const segments: string[] = [];
    let cursorRecord = selected;
    while (cursorRecord !== root) {
      if (cursorRecord.leaf === null || cursorRecord.parentId === null) {
        return atomicRejected(flight, request, "binding_invalid");
      }
      segments.push(cursorRecord.leaf);
      const parent = flight.registry.get(cursorRecord.parentId as object);
      if (parent === undefined) {
        return atomicRejected(flight, request, "binding_invalid");
      }
      cursorRecord = parent;
    }
    const content = flight.contentStates.get(
      (flight.recordTokens.get(selected) ?? request.rootId) as object,
    );
    const canonicalEntry = {
      path: segments.reverse().join("/"),
      type: selected.stat.isDirectory()
        ? ("directory" as const)
        : ("file" as const),
      mode: lowModeBigint(current.mode),
      size: selected.stat.isDirectory()
        ? 0
        : (content?.size ?? Number(current.size)),
      sha256: selected.stat.isDirectory()
        ? null
        : (content?.contentSha256 ?? null),
    };
    const canonicalDigest = sha256(JSON.stringify(canonicalEntry));
    if (
      canonicalDigest !== request.evidenceDigest ||
      (canonicalEntry.type === "file" && canonicalEntry.sha256 === null)
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    flight.canonicalizationCursors.set(
      request.rootId as object,
      request.cursor + 1,
    );
    return Object.freeze({
      kind: "content_observed",
      effectId: request.effectId,
      requestKind: request.kind,
      cursor: request.cursor,
      byteSize: 1,
      contentDigest: canonicalDigest,
      evidenceDigest: atomicObservationDigest(
        flight,
        request,
        request.evidenceDigest,
      ),
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function applyAtomicWrite(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "copy_payload_chunk" | "write_file_chunk" }
  >,
): Promise<AtomicEffectObservationV1> {
  let destination: AtomicHeldRecord;
  try {
    destination = resolveAtomicRecord(flight, request.destinationFileId);
    const hasSource = request.sourceFileId !== null;
    const hasInline = request.inlineBytes !== null;
    if (
      hasSource === hasInline ||
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength < 0 ||
      request.byteLength > ATOMIC_OBSERVATION_BYTE_LIMIT ||
      !/^[a-f0-9]{64}$/u.test(request.expectedChunkSha256) ||
      !/^[a-f0-9]{64}$/u.test(request.expectedResultSha256)
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    let chunk: Buffer;
    if (request.inlineBytes !== null) {
      if (request.inlineBytes.byteLength !== request.byteLength) {
        return atomicRejected(flight, request, "binding_invalid");
      }
      chunk = Buffer.from(request.inlineBytes);
    } else {
      const source = resolveAtomicRecord(flight, request.sourceFileId!);
      if (
        !atomicReservationAvailable(
          flight,
          atomicReservationRequirement(source.role),
          0,
          request.byteLength,
        )
      ) {
        return atomicRejected(flight, request, "budget_exceeded");
      }
      const buffer = Buffer.alloc(request.byteLength);
      const read = await atomicAwait(
        flight,
        [source],
        "atomic-copy-read",
        () => source.handle.read(buffer, 0, buffer.length, request.offset),
      );
      if (read.bytesRead !== request.byteLength) {
        return atomicRejected(flight, request, "binding_invalid");
      }
      chunk = buffer;
    }
    if (sha256(chunk) !== request.expectedChunkSha256) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const destinationBefore = await atomicAwait(
      flight,
      [destination],
      "atomic-write-result-stat-before",
      () => destination.handle.stat({ bigint: true }),
    );
    if (
      !destinationBefore.isFile() ||
      destinationBefore.nlink !== 1n ||
      destinationBefore.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    assertAtomicStat(
      destination.stat,
      destinationBefore,
      "atomic publication write destination changed",
    );
    const expectedResultSize = Math.max(
      Number(destinationBefore.size),
      request.offset + request.byteLength,
    );
    if (
      !Number.isSafeInteger(expectedResultSize) ||
      !atomicReservationAvailable(
        flight,
        atomicReservationRequirement(destination.role),
        0,
        expectedResultSize,
      ) ||
      !atomicRecordBytesClaimAvailable(
        flight,
        request.destinationFileId,
        destination.role,
        expectedResultSize,
      )
    ) {
      return atomicRejected(flight, request, "budget_exceeded");
    }
    const written = await atomicAwait(
      flight,
      [destination],
      "atomic-write-chunk",
      () =>
        destination.handle.write(
          chunk,
          0,
          chunk.byteLength,
          request.offset,
        ),
    );
    if (written.bytesWritten !== chunk.byteLength) {
      return atomicRejected(flight, request, "io");
    }
    const destinationAfter = await atomicAwait(
      flight,
      [destination],
      "atomic-write-result-stat-after",
      () => destination.handle.stat({ bigint: true }),
    );
    if (
      !sameObjectIdentity(destinationBefore, destinationAfter) ||
      destinationAfter.size !== BigInt(expectedResultSize)
    ) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      return atomicRejected(flight, request, "binding_invalid");
    }
    const result = await reconciliationPrivateHeldFileHash(
      destination.handle,
      destinationAfter,
      (buffer, offset) =>
        atomicAwait(
          flight,
          [destination],
          "atomic-write-result-read",
          () =>
            destination.handle.read(
              buffer,
              0,
              buffer.byteLength,
              offset,
            ),
        ),
      () =>
        atomicAwait(
          flight,
          [destination],
          "atomic-write-result-final-stat",
          () => destination.handle.stat({ bigint: true }),
        ),
    );
    if (result.contentSha256 !== request.expectedResultSha256) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      return atomicRejected(flight, request, "binding_invalid");
    }
    flight.contentStates.set(request.destinationFileId as object, {
      size: expectedResultSize,
      contentSha256: result.contentSha256,
      synced: false,
    });
    claimAtomicRecordBytes(
      flight,
      request.destinationFileId,
      destination.role,
      expectedResultSize,
    );
    return Object.freeze({
      kind: "effect_completed",
      effectId: request.effectId,
      requestKind: request.kind,
      evidenceDigest: atomicObservationDigest(flight, request, "written"),
      count: 1,
      byteSize: chunk.byteLength,
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function applyAtomicEnumerate(
  flight: AtomicEffectFlightRecord,
  request: AtomicEffectRequestV1 & { kind: "enumerate_directory" },
): Promise<AtomicEffectObservationV1> {
  let directory: AtomicHeldRecord;
  let stream: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  let streamCloseAttempted = false;
  let retainedStream:
    | {
        handle: Awaited<ReturnType<typeof fs.opendir>>;
        parent: AtomicHeldRecord;
        point: string;
      }
    | null = null;
  const provisional: Array<{
    entry: Dirent<string>;
    type: "file" | "directory";
    handle: FileHandle;
    stat: BigIntStats | null;
    evidence: AtomicObjectEvidenceV1 | null;
    retained: {
      handle: FileHandle;
      parent: AtomicHeldRecord;
      point: string;
    };
  }> = [];
  try {
    directory = resolveAtomicRecord(flight, request.objectId);
    if (
      directory.role !== request.role ||
      !sameAtomicEvidence(directory.evidence, request.expected) ||
      !Number.isSafeInteger(request.cursor) ||
      request.cursor < 0 ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength < 0 ||
      request.byteLength > ATOMIC_OBSERVATION_BYTE_LIMIT
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const expectedCursor =
      flight.enumerationCursors.get(request.objectId as object) ?? 0;
    if (request.cursor !== expectedCursor) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const requirement =
      directory.role === "profiles_parent" ||
      directory.role === "private_source" ||
      directory.role === "payload_entry"
        ? ({
            entry: "payload_entries",
            bytes: "payload_bytes",
          } as const)
        : atomicReservationRequirement(directory.role);
    const discoveryCapacity =
      flight.reservations[requirement.entry].count;
    if (
      discoveryCapacity < 1 ||
      request.byteLength < 1 ||
      !atomicReservationAvailable(
        flight,
        requirement,
        1,
        request.byteLength,
      )
    ) {
      return atomicRejected(flight, request, "budget_exceeded");
    }
    stream = await atomicAwait(
      flight,
      [directory],
      "atomic-enumerate-open-stream",
      async () => {
        const acquired = await fs.opendir(procPath(directory.handle), {
          bufferSize: 32,
          encoding: "utf8",
        });
        stream = acquired;
        retainedStream = {
          handle: acquired,
          parent: directory,
          point: "atomic-enumerate-retained-stream-close",
        };
        flight.transientHandles.add(retainedStream);
        filesystemTestContext.getStore()?.directoryStreamOpened?.(32);
        return acquired;
      },
    );
    const openedStream = stream;
    const names = await collectHeldDirectoryEntries(
      openedStream,
      new Budget(discoveryCapacity),
      (overflow) => {
        const read = () =>
          atomicAwait(
            flight,
            [directory],
            overflow
              ? "atomic-enumerate-lookahead"
              : "atomic-enumerate-read",
            () => openedStream.read(),
          );
        return overflow
          ? filesystemTestContext.getStore()?.overflowLookaheadRead?.(read) ??
              read()
          : read();
      },
      (entry) =>
        atomicAwait(
          flight,
          [directory],
          "atomic-enumerate-yield",
          async () => entry,
        ).then(() => undefined),
      () => {
        streamCloseAttempted = true;
        return atomicVerifiedClose(
          flight,
          [directory],
          "atomic-enumerate-close-stream",
          () => openedStream.close(),
          () => {
            stream = null;
            if (retainedStream !== null) {
              flight.transientHandles.delete(retainedStream);
              retainedStream = null;
            }
          },
        );
      },
    );
    names.sort((left, right) => rawCompare(left.name, right.name));
    const page = names.slice(
      request.cursor,
      request.cursor + ATOMIC_DIRECTORY_PAGE_LIMIT,
    );
    while (page.length > 0) {
      const encodedBytes = Buffer.byteLength(
        JSON.stringify(
          page.map((value) => ({
            leaf: value.name,
            role: "payload_entry",
            objectId: {},
            type: value.isDirectory() ? "directory" : "file",
            evidenceDigest: "0".repeat(64),
          })),
        ),
        "utf8",
      );
      if (encodedBytes <= request.byteLength) break;
      page.pop();
    }
    if (page.length === 0 && request.cursor < names.length) {
      return atomicRejected(flight, request, "budget_exceeded");
    }
    const done = request.cursor + page.length >= names.length;
    if (
      flight.semanticCount +
        flight.partialCount +
        page.length >
      ATOMIC_SEMANTIC_ID_LIMIT
    ) {
      return atomicRejected(flight, request, "budget_exceeded");
    }
    for (const entry of page) {
      validateAtomicLeaf("payload_entry", entry.name);
      const type: "file" | "directory" | null =
        entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : null;
      if (type === null) {
        throw atomicFailure("atomic publication discovered type is invalid");
      }
      const opened = await atomicAwait(
        flight,
        [directory],
        "atomic-enumerate-open",
        async () => {
          const acquired = await fs.open(
            procPath(directory.handle, entry.name),
            constants.O_RDONLY |
              constants.O_NOFOLLOW |
              (type === "directory" ? constants.O_DIRECTORY : 0),
          );
          const retained = {
            handle: acquired,
            parent: directory,
            point: "atomic-enumerate-retained-close",
          };
          const owned = {
            entry,
            type,
            handle: acquired,
            stat: null as BigIntStats | null,
            evidence: null as AtomicObjectEvidenceV1 | null,
            retained,
          };
          provisional.push(owned);
          flight.transientHandles.add(retained);
          return owned;
        },
      );
      let stat: BigIntStats | null = null;
      stat = await atomicAwait(
        flight,
        [directory],
        "atomic-enumerate-fstat",
        async () => {
          const observed = await opened.handle.stat({ bigint: true });
          stat = observed;
          return observed;
        },
      );
      if (
        (type === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
        (type === "file" && stat.nlink !== 1n)
      ) {
        throw atomicFailure("atomic publication discovered object is invalid");
      }
      const evidence = atomicEvidenceFromStat(stat);
      opened.stat = stat;
      opened.evidence = evidence;
    }
    const encodedObservationBytes = Buffer.byteLength(
      JSON.stringify(
        provisional.map((opened) => ({
          leaf: opened.entry.name,
          role: "payload_entry",
          objectId: {},
          type: opened.type,
          evidenceDigest: opened.evidence!.evidenceDigest,
        })),
      ),
      "utf8",
    );
    if (
      encodedObservationBytes > request.byteLength ||
      encodedObservationBytes > ATOMIC_OBSERVATION_BYTE_LIMIT
    ) {
      throw atomicFailure("atomic publication directory page is oversized");
    }
    const entries: Array<{
      leaf: string;
      role: AtomicObjectRoleV1;
      objectId: FlightSemanticId;
      type: "file" | "directory";
      evidenceDigest: string;
    }> = [];
    for (const opened of provisional) {
      if (opened.stat === null || opened.evidence === null) {
        throw atomicFailure(
          "atomic publication discovered evidence is incomplete",
        );
      }
      const objectId = mintAtomicSemanticId(
        flight,
        Object.freeze({
          role: "payload_entry",
          operationId: request.operationId,
          parentId: request.objectId,
          leaf: opened.entry.name,
          handle: opened.handle,
          binding: directory.binding,
          evidence: opened.evidence,
          stat: opened.stat,
          owned: true,
        }),
        true,
      );
      flight.transientHandles.delete(opened.retained);
      entries.push({
        leaf: opened.entry.name,
        role: "payload_entry",
        objectId,
        type: opened.type,
        evidenceDigest: opened.evidence.evidenceDigest,
      });
    }
    provisional.length = 0;
    if (done) {
      flight.enumerationCursors.set(request.objectId as object, -1);
    } else {
      flight.enumerationCursors.set(
        request.objectId as object,
        request.cursor + entries.length,
      );
    }
    creditAtomicTransientBytes(
      flight,
      requirement.bytes,
      request.byteLength,
    );
    return Object.freeze({
      kind: "directory_observed",
      effectId: request.effectId,
      cursor: request.cursor,
      entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
      done,
      evidenceDigest: atomicObservationDigest(flight, request, "directory"),
    });
  } catch (error) {
    let closeFailed = false;
    if (stream !== null) {
      if (streamCloseAttempted) {
        closeFailed = true;
      } else {
        streamCloseAttempted = true;
        const openedStream = stream;
        try {
          await atomicVerifiedClose(
            flight,
            [directory!],
            "atomic-enumerate-close-stream",
            () => openedStream.close(),
            () => {
              stream = null;
              if (retainedStream !== null) {
                flight.transientHandles.delete(retainedStream);
                retainedStream = null;
              }
            },
          );
        } catch {
          closeFailed = true;
        }
      }
    }
    for (const opened of provisional.reverse()) {
      try {
        await atomicVerifiedClose(
          flight,
          [directory!],
          "atomic-enumerate-close-provisional",
          () => opened.handle.close(),
          () => {
            flight.transientHandles.delete(opened.retained);
          },
        );
      } catch {
        closeFailed = true;
      }
    }
    if (closeFailed) {
      return atomicRejected(flight, request, "close_unverified");
    }
    const mapped = mapAtomicErrno(error);
    if (mapped !== null) return atomicRejected(flight, request, mapped);
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw atomicFailure("atomic publication filesystem operation failed");
  }
}

async function applyAtomicRemove(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    {
      kind:
        | "remove_intent"
        | "remove_manifest"
        | "remove_file"
        | "remove_directory"
        | "remove_root";
    }
  >,
): Promise<AtomicEffectObservationV1> {
  const treeRemoval = "parentId" in request;
  const parentId = treeRemoval
    ? request.parentId
    : request.stableParentId;
  const objectId = treeRemoval
    ? request.objectId
    : request.stableObjectId;
  const leaf = treeRemoval ? request.leaf : request.stableLeaf;
  const expected = treeRemoval
    ? request.expected
    : request.expectedStable;
  let parent: AtomicHeldRecord;
  let object: AtomicHeldRecord;
  try {
    parent = resolveAtomicRecord(flight, parentId);
    object = resolveAtomicRecord(flight, objectId);
    validateAtomicLeaf(object.role, leaf);
    if (
      object.parentId !== parentId ||
      object.leaf !== leaf ||
      !sameAtomicEvidence(object.evidence, expected)
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
  } catch {
    return atomicRejected(flight, request, "binding_invalid");
  }
  const directory = object.stat.isDirectory();
  if (
    request.kind === "remove_file"
      ? directory
      : request.kind === "remove_directory" || request.kind === "remove_root"
        ? !directory
        : directory
  ) {
    return atomicRejected(flight, request, "binding_invalid");
  }
  let pin: FileHandle | null = null;
  let retainedPin:
    | { handle: FileHandle; parent: AtomicHeldRecord; point: string }
    | null = null;
  try {
    const before = await atomicAwait(
      flight,
      [parent, object],
      "atomic-remove-lstat",
      () => fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
    );
    pin = await atomicAwait(
      flight,
      [parent, object],
      "atomic-remove-open",
      async () => {
        const removeFlags =
          constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (directory ? constants.O_DIRECTORY : 0);
        filesystemTestContext.getStore()?.atomicOpenFlags?.(
          "atomic-remove-open",
          removeFlags,
        );
        const acquired = await fs.open(
          procPath(parent.handle, leaf),
          removeFlags,
        );
        pin = acquired;
        retainedPin = {
          handle: acquired,
          parent,
          point: "atomic-remove-retained-close",
        };
        flight.transientHandles.add(retainedPin);
        return acquired;
      },
    );
    const pinned = await atomicAwait(
      flight,
      [parent, object],
      "atomic-remove-fstat",
      () => pin!.stat({ bigint: true }),
    );
    if (
      !sameObjectIdentity(object.stat, before) ||
      !sameObjectIdentity(object.stat, pinned)
    ) {
      throw atomicFailure("atomic publication removal identity changed");
    }
    const recheck = await atomicAwait(
      flight,
      [parent, object],
      "atomic-remove-recheck",
      () => fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
    );
    if (!sameObjectIdentity(object.stat, recheck)) {
      throw atomicFailure("atomic publication removal identity changed");
    }
    await atomicAwait(flight, [parent], "atomic-remove-mutate", () =>
      directory
        ? fs.rmdir(procPath(parent.handle, leaf))
        : fs.unlink(procPath(parent.handle, leaf)),
    );
    const pinnedHandle = pin;
    await atomicVerifiedClose(
      flight,
      [parent],
      "atomic-remove-pin-close",
      () => pinnedHandle.close(),
      () => {
        pin = null;
        if (retainedPin !== null) {
          flight.transientHandles.delete(retainedPin);
          retainedPin = null;
        }
      },
    );
    await atomicAwait(flight, [parent], "atomic-remove-absence", async () => {
      try {
        await fs.lstat(procPath(parent.handle, leaf), { bigint: true });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return;
        throw error;
      }
      throw atomicFailure("atomic publication removed entry remains");
    });
    await atomicAwait(flight, [parent], "atomic-remove-parent-fsync", () =>
      parent.handle.sync(),
    );
    flight.removedRecords.add(object);
    return Object.freeze({
      kind: "removal_observed",
      effectId: request.effectId,
      requestKind: request.kind,
      objectId,
      removedEvidence: object.evidence,
      state: "absent",
      parentSynced: true,
      evidenceDigest: atomicObservationDigest(flight, request, "removed"),
    });
  } catch (error) {
    const mapped = mapAtomicErrno(error);
    if (mapped !== null) return atomicRejected(flight, request, mapped);
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw atomicFailure("atomic publication filesystem operation failed");
  } finally {
    if (pin !== null) {
      try {
        const pinnedHandle = pin;
        await atomicVerifiedClose(
          flight,
          [parent],
          "atomic-remove-final-close",
          () => pinnedHandle.close(),
          () => {
            pin = null;
            if (retainedPin !== null) {
              flight.transientHandles.delete(retainedPin);
              retainedPin = null;
            }
          },
        );
      } catch {
        flight.state = "fail_stopped";
        flight.root.acceptingOperations = false;
        return atomicRejected(flight, request, "close_unverified");
      }
    }
  }
}

function atomicNativeCode(error: unknown): Extract<
  AtomicEffectObservationV1,
  { kind: "native_resolved" }
>["rawCode"] {
  if (isNodeError(error) && typeof error.code === "string") {
    switch (error.code) {
      case "atomic_publish_exists":
      case "atomic_publish_source_missing":
      case "atomic_publish_unsupported":
      case "atomic_publish_cross_device":
      case "atomic_publish_binding_invalid":
      case "atomic_publish_denied":
      case "atomic_publish_invalid_argument":
      case "atomic_publish_io":
        return error.code;
    }
  }
  return "atomic_publish_io";
}

function atomicPinnedContentEvidence(
  flight: AtomicEffectFlightRecord,
  objectId: FlightSemanticId,
  record: AtomicHeldRecord,
): AtomicObjectEvidenceV1 | null {
  const content = flight.contentStates.get(objectId as object);
  if (content === undefined || !content.synced) return null;
  const value = {
    dev: String(record.stat.dev),
    ino: String(record.stat.ino),
    mode: lowModeBigint(record.stat.mode),
    size: content.size,
    contentSha256: content.contentSha256,
  };
  return Object.freeze({
    ...value,
    evidenceDigest: sha256(JSON.stringify(value)),
  });
}

function atomicPersistenceRequestValid(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "persist_intent" | "persist_manifest" | "replace_intent" }
  >,
  tempParent: AtomicHeldRecord,
  temp: AtomicHeldRecord,
  stableParent: AtomicHeldRecord,
): boolean {
  const expectedTempRole =
    request.kind === "persist_manifest" ? "manifest_temp" : "intent_temp";
  const tempRequirement = atomicReservationRequirement(expectedTempRole);
  const stableRequirement = atomicReservationRequirement(
    request.kind === "persist_manifest"
      ? "manifest_stable"
      : "intent_stable",
  );
  if (
    tempParent.role !== "intents_parent" ||
    stableParent.role !== "intents_parent" ||
    temp.role !== expectedTempRole ||
    flight.removedRecords.has(temp) ||
    temp.parentId !== request.tempParentId ||
    temp.leaf !== request.tempLeaf ||
    request.canonicalBytes.byteLength !== request.expectedTemp.size ||
    request.contentDigest !== sha256(request.canonicalBytes) ||
    request.expectedTemp.contentSha256 !== request.contentDigest ||
    !atomicReservationAvailable(flight, tempRequirement, 1, 0) ||
    !atomicReservationAvailable(flight, stableRequirement, 1, 0) ||
    tempRequirement.bytes !== stableRequirement.bytes ||
    flight.reservations[tempRequirement.bytes].byteSize <
      (request.kind === "replace_intent"
        ? flight.claimedBytes[tempRequirement.bytes]
        : request.canonicalBytes.byteLength * 2)
  ) {
    return false;
  }
  const current = atomicPinnedContentEvidence(
    flight,
    request.tempObjectId,
    temp,
  );
  if (
    current === null ||
    !sameAtomicEvidence(current, request.expectedTemp)
  ) {
    return false;
  }
  try {
    const tempLeaf = parseAtomicPublicationIntentLeaf(request.tempLeaf);
    const stableLeaf = parseAtomicPublicationIntentLeaf(request.stableLeaf);
    if (request.kind === "persist_manifest") {
      const manifest = parseCleanupIdentityManifest(request.canonicalBytes);
      const intentLeaf = `${request.operationId}.json`;
      const durableIntent = flight.stableIntents.get(intentLeaf);
      const heldDurableIntent = [...flight.records].some(
        record =>
          !flight.removedRecords.has(record) &&
          record.role === "intent_stable" &&
          record.leaf === intentLeaf &&
          record.evidence.contentSha256 === durableIntent?.contentSha256,
      );
      if (durableIntent === undefined) return false;
      validateCleanupIdentityManifestBinding(
        durableIntent.intent,
        manifest,
      );
      return (
        tempLeaf.kind === "identity_temp" &&
        stableLeaf.kind === "identity_stable" &&
        tempLeaf.operationId === request.operationId &&
        stableLeaf.operationId === request.operationId &&
        manifest.operationId === request.operationId &&
        request.expectedPhase === "manifest_planned" &&
        durableIntent.intent.phase === "manifest_planned" &&
        heldDurableIntent
      );
    }
    const intent = parseAtomicPublishIntent(request.canonicalBytes);
    return (
      tempLeaf.kind === "intent_temp" &&
      stableLeaf.kind === "intent_stable" &&
      tempLeaf.operationId === request.operationId &&
      stableLeaf.operationId === request.operationId &&
      tempLeaf.phase === intent.phase &&
      intent.operationId === request.operationId &&
      (request.kind === "replace_intent" ||
        (request.expectedPhase === null && intent.phase === "allocated"))
    );
  } catch {
    return false;
  }
}

function withAtomicNativeOperands(
  sourceParent: AtomicHeldRecord,
  sourceLeaf: string,
  targetParent: AtomicHeldRecord,
  targetLeaf: string,
  callback: (
    sourceDirectoryFd: number,
    sourceLeaf: string,
    targetDirectoryFd: number,
    targetLeaf: string,
  ) => void,
): void {
  callback(
    sourceParent.handle.fd,
    sourceLeaf,
    targetParent.handle.fd,
    targetLeaf,
  );
}

async function applyAtomicPersistence(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "persist_intent" | "persist_manifest" }
  >,
): Promise<AtomicEffectObservationV1> {
  let tempParent: AtomicHeldRecord;
  let temp: AtomicHeldRecord;
  let stableParent: AtomicHeldRecord;
  try {
    if (flight.persistenceResolution !== null) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    tempParent = resolveAtomicRecord(flight, request.tempParentId);
    temp = resolveAtomicRecord(flight, request.tempObjectId);
    stableParent = resolveAtomicRecord(flight, request.stableParentId);
    if (
      !("absent" in request.expectedStable) ||
      !atomicPersistenceRequestValid(
        flight,
        request,
        tempParent,
        temp,
        stableParent,
      )
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    assertAtomicMountPair(tempParent, stableParent);
  } catch {
    return atomicRejected(flight, request, "binding_invalid");
  }
  let rawCode: Extract<
    AtomicEffectObservationV1,
    { kind: "native_resolved" }
  >["rawCode"] = "success";
  const nativePrecheckEvidenceDigest = sha256(
    JSON.stringify({
      requestKind: request.kind,
      operationId: request.operationId,
      sourceParent: tempParent.evidence.evidenceDigest,
      source: request.expectedTemp.evidenceDigest,
      targetParent: stableParent.evidence.evidenceDigest,
      contentDigest: request.contentDigest,
    }),
  );
  let renamed = false;
  try {
    atomicGate(
      flight,
      [tempParent, stableParent],
      "before",
      "atomic-persist-no-replace",
    );
    withAtomicNativeOperands(
      tempParent,
      request.tempLeaf,
      stableParent,
      request.stableLeaf,
      (sourceDirectoryFd, sourceLeaf, targetDirectoryFd, targetLeaf) => {
        filesystemTestContext.getStore()?.atomicPersistenceNative?.(
          "before",
          request.kind === "persist_intent"
            ? "intent_publish"
            : "manifest_publish",
        );
        loadAtomicDirectoryPublicationNative().renameNoReplace(
          sourceDirectoryFd,
          sourceLeaf,
          targetDirectoryFd,
          targetLeaf,
        );
        filesystemTestContext.getStore()?.atomicPersistenceNative?.(
          "after",
          request.kind === "persist_intent"
            ? "intent_publish"
            : "manifest_publish",
        );
      },
    );
    renamed = true;
    flight.removedRecords.add(temp);
  } catch (error) {
    if (renamed) flight.removedRecords.add(temp);
    rawCode = atomicNativeCode(error);
  } finally {
    try {
      atomicGate(
        flight,
        [tempParent, stableParent],
        "after",
        "atomic-persist-no-replace",
      );
    } catch {
      rawCode = "atomic_publish_binding_invalid";
    }
  }
  flight.persistenceResolution = Object.freeze({ request, rawCode });
  const evidenceDigest = atomicObservationDigest(
    flight,
    request,
    `${rawCode}:${nativePrecheckEvidenceDigest}`,
  );
  return request.kind === "persist_intent"
    ? Object.freeze({
        kind: "native_resolved",
        effectId: request.effectId,
        requestKind: "persist_intent",
        operationId: request.operationId,
        move: "intent_publish",
        sourceObjectId: request.tempObjectId,
        sourceEvidence: request.expectedTemp,
        rawCode,
        nativePrecheckEvidenceDigest,
        evidenceDigest,
      })
    : Object.freeze({
        kind: "native_resolved",
        effectId: request.effectId,
        requestKind: "persist_manifest",
        operationId: request.operationId,
        move: "manifest_publish",
        sourceObjectId: request.tempObjectId,
        sourceEvidence: request.expectedTemp,
        rawCode,
        nativePrecheckEvidenceDigest,
        evidenceDigest,
      });
}

async function applyAtomicReplaceIntent(
  flight: AtomicEffectFlightRecord,
  request: Extract<AtomicEffectRequestV1, { kind: "replace_intent" }>,
): Promise<AtomicEffectObservationV1> {
  let tempParent: AtomicHeldRecord;
  let temp: AtomicHeldRecord;
  let stableParent: AtomicHeldRecord;
  let stable: AtomicHeldRecord | undefined;
  let stableId: FlightSemanticId | undefined;
  try {
    if (flight.persistenceResolution !== null) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    tempParent = resolveAtomicRecord(flight, request.tempParentId);
    temp = resolveAtomicRecord(flight, request.tempObjectId);
    stableParent = resolveAtomicRecord(flight, request.stableParentId);
    stable = resolveAtomicRecord(flight, request.stableObjectId);
    stableId = flight.recordTokens.get(stable);
    if (
      stable === undefined ||
      stableId === undefined ||
      flight.removedRecords.has(stable) ||
      stable.role !== "intent_stable" ||
      stable.parentId !== request.stableParentId ||
      stable.leaf !== request.stableLeaf ||
      !sameAtomicEvidence(stable.evidence, request.expectedStable) ||
      flight.intents.get(stableId as object)?.phase !==
        request.expectedPhase ||
      !atomicPersistenceRequestValid(
        flight,
        request,
        tempParent,
        temp,
        stableParent,
      )
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const previousIntent = flight.intents.get(stableId as object);
    if (previousIntent === undefined) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    const nextIntent = validateAtomicPublishIntentTransition(
      previousIntent,
      parseAtomicPublishIntent(request.canonicalBytes),
    );
    await atomicAwait(
      flight,
      [tempParent, temp, stableParent, stable],
      "atomic-replace-intent",
      async () => {
        await fs.rename(
          procPath(tempParent.handle, request.tempLeaf),
          procPath(stableParent.handle, request.stableLeaf),
        );
        flight.removedRecords.add(temp);
        flight.removedRecords.add(stable!);
      },
    );
    flight.stableIntents.set(
      request.stableLeaf,
      Object.freeze({
        contentSha256: request.contentDigest,
        intent: nextIntent,
      }),
    );
    return Object.freeze({
      kind: "effect_completed",
      effectId: request.effectId,
      requestKind: request.kind,
      evidenceDigest: atomicObservationDigest(
        flight,
        request,
        "replaced",
      ),
      count: 1,
      byteSize: request.canonicalBytes.byteLength,
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

function atomicNativeMoveValid(
  request: Extract<AtomicEffectRequestV1, { kind: "native_no_replace" }>,
  source: AtomicHeldRecord,
  targetParent: AtomicHeldRecord,
): boolean {
  if (
    source.parentId !== request.sourceParentId ||
    source.leaf !== request.sourceLeaf ||
    !sameAtomicEvidence(source.evidence, request.expectedSource) ||
    !("absent" in request.expectedTarget)
  ) {
    return false;
  }
  switch (request.move) {
    case "profile_publish":
      return (
        source.role === "private_source" &&
        request.sourceLeaf === "payload" &&
        (targetParent.role === "profiles_parent" ||
          targetParent.role === "public_target")
      );
    case "canary_publish":
      return (
        source.role === "private_source" &&
        request.sourceLeaf === `proof-${request.operationId}-0` &&
        request.targetLeaf === `canary-${request.operationId}-0` &&
        (targetParent.role === "profiles_parent" ||
          targetParent.role === "public_target")
      );
    case "profile_source_to_private":
      return (
        (source.role === "public_source" ||
          source.role === "public_target") &&
        targetParent.role === "wrapper" &&
        request.targetLeaf === `delete-${request.operationId}`
      );
    case "canary_source_to_private":
      return (
        (source.role === "public_source" ||
          source.role === "public_target") &&
        targetParent.role === "wrapper" &&
        request.sourceLeaf === `canary-${request.operationId}-0` &&
        request.targetLeaf === `deletion-${request.operationId}-0`
      );
  }
}

function atomicMissingCanaryReplayMoveValid(
  request: Extract<AtomicEffectRequestV1, { kind: "native_no_replace" }>,
  sourceParent: AtomicHeldRecord,
  targetParent: AtomicHeldRecord,
): boolean {
  if (!("absent" in request.expectedTarget)) return false;
  if (request.move === "canary_publish") {
    return (
      sourceParent.role === "wrapper" &&
      request.sourceLeaf === `proof-${request.operationId}-0` &&
      request.targetLeaf === `canary-${request.operationId}-0` &&
      (targetParent.role === "profiles_parent" ||
        targetParent.role === "public_target")
    );
  }
  return (
    request.move === "canary_source_to_private" &&
    (sourceParent.role === "profiles_parent" ||
      sourceParent.role === "public_target") &&
    targetParent.role === "wrapper" &&
    request.sourceLeaf === `canary-${request.operationId}-0` &&
    request.targetLeaf === `deletion-${request.operationId}-0`
  );
}

async function applyAtomicNativeNoReplace(
  flight: AtomicEffectFlightRecord,
  request: Extract<AtomicEffectRequestV1, { kind: "native_no_replace" }>,
): Promise<AtomicEffectObservationV1> {
  let sourceParent: AtomicHeldRecord;
  let source: AtomicHeldRecord | null = null;
  let targetParent: AtomicHeldRecord;
  try {
    sourceParent = resolveAtomicRecord(flight, request.sourceParentId);
    targetParent = resolveAtomicRecord(flight, request.targetParentId);
  } catch {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    return atomicRejected(flight, request, "binding_invalid");
  }
  try {
    source = resolveAtomicRecord(flight, request.sourceId);
  } catch {
    source = null;
  }
  if (source === null) {
    try {
      await atomicAwait(
        flight,
        [sourceParent],
        "atomic-native-replay-source-absence",
        () => fs.lstat(procPath(sourceParent.handle, request.sourceLeaf)),
      );
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      return atomicRejected(flight, request, "binding_invalid");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        flight.state = "fail_stopped";
        flight.root.acceptingOperations = false;
        return atomicRejected(flight, request, "binding_invalid");
      }
    }
  }
  const sourceStatfs = flight.statfsHandles.get(
    request.sourceParentId as object,
  );
  const targetStatfs = flight.statfsHandles.get(
    request.targetParentId as object,
  );
  if (
    !flight.revalidatedHandles.has(request.sourceParentId as object) ||
    !flight.revalidatedHandles.has(request.targetParentId as object) ||
    sourceStatfs === undefined ||
    targetStatfs === undefined ||
    sourceStatfs.device !== targetStatfs.device ||
    (source === null
      ? !atomicMissingCanaryReplayMoveValid(
          request,
          sourceParent,
          targetParent,
        )
      : !atomicNativeMoveValid(request, source, targetParent))
  ) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    return atomicRejected(flight, request, "binding_invalid");
  }
  flight.revalidatedHandles.delete(request.sourceParentId as object);
  flight.revalidatedHandles.delete(request.targetParentId as object);
  flight.statfsHandles.delete(request.sourceParentId as object);
  flight.statfsHandles.delete(request.targetParentId as object);

  let rawCode: Extract<
    AtomicEffectObservationV1,
    { kind: "native_resolved" }
  >["rawCode"] = "success";
  let renamed = false;
  let gated = false;
  const precheckValue = {
    sourceParent: sourceParent.evidence.evidenceDigest,
    source:
      source === null
        ? request.expectedSource.evidenceDigest
        : source.evidence.evidenceDigest,
    targetParent: targetParent.evidence.evidenceDigest,
  };
  const nativePrecheckEvidenceDigest = sha256(
    JSON.stringify(precheckValue),
  );
  try {
    atomicGate(
      flight,
      source === null
        ? [sourceParent, targetParent]
        : [sourceParent, source, targetParent],
      "before",
      "atomic-native-no-replace",
    );
    gated = true;
    assertAtomicMountPair(sourceParent, targetParent);
    filesystemTestContext
      .getStore()
      ?.atomicNativeBarrier?.("before", request.move);
    loadAtomicDirectoryPublicationNative().renameNoReplace(
      sourceParent.handle.fd,
      request.sourceLeaf,
      targetParent.handle.fd,
      request.targetLeaf,
    );
    renamed = true;
    if (source !== null) flight.removedRecords.add(source);
    filesystemTestContext
      .getStore()
      ?.atomicNativeBarrier?.("after", request.move);
  } catch (error) {
    if (renamed && source !== null) flight.removedRecords.add(source);
    if (
      error instanceof BrowserServiceError &&
      error.message === "atomic publication filesystem is unsupported"
    ) {
      rawCode = "atomic_publish_unsupported";
    } else if (
      error instanceof BrowserServiceError &&
      error.message === "atomic publication filesystem crosses devices"
    ) {
      rawCode = "atomic_publish_cross_device";
    } else {
      rawCode = atomicNativeCode(error);
    }
  } finally {
    if (gated) {
      try {
        atomicGate(
          flight,
          source === null
            ? [sourceParent, targetParent]
            : [sourceParent, source, targetParent],
          "after",
          "atomic-native-no-replace",
        );
      } catch {
        rawCode = "atomic_publish_binding_invalid";
      }
    }
  }
  return Object.freeze({
    kind: "native_resolved",
    effectId: request.effectId,
    requestKind: "native_no_replace",
    operationId: request.operationId,
    move: request.move,
    sourceObjectId: request.sourceId,
    sourceEvidence: request.expectedSource,
    rawCode,
    nativePrecheckEvidenceDigest,
    evidenceDigest: atomicObservationDigest(
      flight,
      request,
      `${rawCode}:${nativePrecheckEvidenceDigest}`,
    ),
  });
}

type AtomicObservedLocation = Readonly<{
  location: Extract<
    AtomicEffectObservationV1,
    { kind: "locations_observed" }
  >["source"];
  objectId: FlightSemanticId | null;
}>;

async function observeAtomicChild(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "observe_locations"; requestKind: "native_no_replace" }
  >,
  parent: AtomicHeldRecord,
  parentId: FlightSemanticId,
  leaf: string,
  expected: AtomicObjectEvidenceV1,
  sourceSide: boolean,
): Promise<AtomicObservedLocation> {
  let before: BigIntStats;
  try {
    before = await atomicAwait(
      flight,
      [parent],
      `atomic-observe-${sourceSide ? "source" : "target"}-lstat`,
      () => fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const value = {
        state: "absent" as const,
        objectId: null,
        dev: null,
        ino: null,
        mode: null,
        evidence: null,
      };
      return Object.freeze({
        objectId: null,
        location: Object.freeze({
          ...value,
          evidenceDigest: sha256(JSON.stringify(value)),
        }),
      });
    }
    throw error;
  }
  const flags = before.isDirectory()
    ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    : ATOMIC_O_PATH | constants.O_NOFOLLOW;
  let handle: FileHandle | null = await atomicAwait(
    flight,
    [parent],
    `atomic-observe-${sourceSide ? "source" : "target"}-open`,
    () => fs.open(procPath(parent.handle, leaf), flags),
  );
  try {
    const stat = await atomicAwait(
      flight,
      [parent],
      `atomic-observe-${sourceSide ? "source" : "target"}-fstat`,
      () => handle!.stat({ bigint: true }),
    );
    assertAtomicStat(
      before,
      stat,
      "atomic publication observed location changed",
    );
    const evidence = atomicEvidenceFromStat(stat);
    const matches = sameAtomicEvidence(evidence, expected);
    if (sourceSide && matches && request.sourceId !== null) {
      const observed = handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        "atomic-observe-source-close",
        () => observed.close(),
        () => {
          handle = null;
        },
      );
      const value = {
        state: "match" as const,
        objectId: request.sourceId,
        dev: evidence.dev,
        ino: evidence.ino,
        mode: evidence.mode,
        evidence,
      };
      return Object.freeze({
        objectId: request.sourceId,
        location: Object.freeze({
          ...value,
          evidenceDigest: sha256(
            JSON.stringify({
              ...value,
              objectId: "requested-source",
            }),
          ),
        }),
      });
    }
    const observedRole: AtomicObjectRoleV1 = sourceSide
      ? "public_source"
      : request.move === "profile_source_to_private" ||
          request.move === "canary_source_to_private"
        ? "private_deletion"
        : "public_target";
    const existing = [...flight.records].find(
      record =>
        !flight.removedRecords.has(record) &&
        record.role === observedRole &&
        record.parentId === parentId &&
        record.leaf === leaf &&
        sameAtomicEvidence(record.evidence, evidence),
    );
    if (existing !== undefined) {
      const existingId = flight.recordTokens.get(existing);
      if (existingId === undefined) {
        throw atomicFailure("atomic publication held token is missing");
      }
      const retained = handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        "atomic-observe-existing-close",
        () => retained.close(),
        () => {
          handle = null;
        },
      );
      const value = {
        state: matches ? ("match" as const) : ("other" as const),
        objectId: existingId,
        dev: evidence.dev,
        ino: evidence.ino,
        mode: evidence.mode,
        evidence,
      };
      return Object.freeze({
        objectId: existingId,
        location: Object.freeze({
          ...value,
          evidenceDigest: sha256(
            JSON.stringify({
              ...value,
              objectId: matches ? "observed-match" : "observed-other",
            }),
          ),
        }),
      });
    }
    const held: AtomicHeldRecord = Object.freeze({
      role: observedRole,
      operationId: request.operationId,
      parentId,
      leaf,
      handle,
      binding: parent.binding,
      evidence,
      stat,
      owned: true,
    });
    const objectId = mintAtomicSemanticId(flight, held, true);
    handle = null;
    const value = {
      state: matches ? ("match" as const) : ("other" as const),
      objectId,
      dev: evidence.dev,
      ino: evidence.ino,
      mode: evidence.mode,
      evidence,
    };
    return Object.freeze({
      objectId,
      location: Object.freeze({
        ...value,
        evidenceDigest: sha256(
          JSON.stringify({
            ...value,
            objectId: matches ? "observed-match" : "observed-other",
          }),
        ),
      }),
    });
  } finally {
    if (handle !== null) {
      const retained = handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        "atomic-observe-failed-close",
        () => retained.close(),
        () => {
          handle = null;
        },
      );
    }
  }
}

async function applyAtomicObserveLocations(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "observe_locations"; requestKind: "native_no_replace" }
  >,
): Promise<AtomicEffectObservationV1> {
  let sourceParent: AtomicHeldRecord;
  let targetParent: AtomicHeldRecord;
  try {
    sourceParent = resolveAtomicRecord(flight, request.sourceParentId);
    targetParent = resolveAtomicRecord(flight, request.targetParentId);
    assertAtomicMountPair(sourceParent, targetParent);
    const source = await observeAtomicChild(
      flight,
      request,
      sourceParent,
      request.sourceParentId,
      request.sourceLeaf,
      request.expectedSource,
      true,
    );
    const target = await observeAtomicChild(
      flight,
      request,
      targetParent,
      request.targetParentId,
      request.targetLeaf,
      request.expectedSource,
      false,
    );
    const evidenceDigest = sha256(
      JSON.stringify({
        move: request.move,
        source: source.location.evidenceDigest,
        target: target.location.evidenceDigest,
      }),
    );
    return Object.freeze({
      kind: "locations_observed",
      effectId: request.effectId,
      requestKind: "native_no_replace",
      operationId: request.operationId,
      move: request.move,
      sourceParentId: request.sourceParentId,
      sourceLeaf: request.sourceLeaf,
      targetParentId: request.targetParentId,
      targetLeaf: request.targetLeaf,
      requestedSourceObjectId: request.sourceId,
      sourceObjectId: source.objectId,
      targetObjectId: target.objectId,
      source: source.location,
      target: target.location,
      evidenceDigest,
    });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function observeAtomicPersistenceChild(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    {
      kind: "observe_locations";
      requestKind: "persist_intent" | "persist_manifest";
    }
  >,
  parent: AtomicHeldRecord,
  parentId: FlightSemanticId,
  leaf: string,
  sourceSide: boolean,
): Promise<AtomicObservedLocation> {
  let before: BigIntStats;
  try {
    before = await atomicAwait(
      flight,
      [parent],
      `atomic-persist-observe-${sourceSide ? "source" : "target"}-lstat`,
      () => fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const value = {
        state: "absent" as const,
        objectId: null,
        dev: null,
        ino: null,
        mode: null,
        evidence: null,
      };
      return Object.freeze({
        objectId: null,
        location: Object.freeze({
          ...value,
          evidenceDigest: sha256(JSON.stringify(value)),
        }),
      });
    }
    throw error;
  }
  let handle: FileHandle | null = await atomicAwait(
    flight,
    [parent],
    `atomic-persist-observe-${sourceSide ? "source" : "target"}-open`,
    () =>
      fs.open(
        procPath(parent.handle, leaf),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ),
  );
  try {
    const stat = await atomicAwait(
      flight,
      [parent],
      `atomic-persist-observe-${sourceSide ? "source" : "target"}-fstat`,
      () => handle!.stat({ bigint: true }),
    );
    assertAtomicStat(
      before,
      stat,
      "atomic persistence observed location changed",
    );
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      lowModeBigint(stat.mode) !== 0o600
    ) {
      throw atomicFailure("atomic persistence target is invalid");
    }
    const contentSha256 = await atomicHeldFileContentSha256(
      flight,
      [parent],
      handle,
      stat,
      "atomic-persist-observe-hash",
    );
    const evidence = atomicEvidenceFromStat(stat, contentSha256);
    const matches = sameAtomicEvidence(evidence, request.expectedTemp);
    if (sourceSide && matches) {
      const retained = handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        "atomic-persist-observe-source-close",
        () => retained.close(),
        () => {
          handle = null;
        },
      );
      const value = {
        state: "match" as const,
        objectId: request.tempObjectId,
        dev: evidence.dev,
        ino: evidence.ino,
        mode: evidence.mode,
        evidence,
      };
      return Object.freeze({
        objectId: request.tempObjectId,
        location: Object.freeze({
          ...value,
          evidenceDigest: sha256(
            JSON.stringify({
              ...value,
              objectId: "requested-source",
            }),
          ),
        }),
      });
    }
    const observedRole =
      request.requestKind === "persist_intent"
        ? ("intent_stable" as const)
        : ("manifest_stable" as const);
    const byteReservation = atomicByteReservation(observedRole);
    const byteScope = atomicMetadataByteScope(observedRole);
    if (
      byteReservation !== null &&
      flight.claimedBytes[byteReservation] + Number(stat.size) >
        flight.reservations[byteReservation].byteSize
    ) {
      throw atomicFailure("atomic publication byte reservation is exhausted");
    }
    if (
      byteScope !== null &&
      flight.claimedScopedBytes[byteScope] + Number(stat.size) >
        atomicMetadataByteScopeLimit(byteScope)
    ) {
      throw atomicFailure("atomic publication byte scope is exhausted");
    }
    const held: AtomicHeldRecord = Object.freeze({
      role: observedRole,
      operationId: request.operationId,
      parentId,
      leaf,
      handle,
      binding: parent.binding,
      evidence,
      stat,
      owned: true,
    });
    const objectId = mintAtomicSemanticId(flight, held, true);
    flight.contentStates.set(objectId as object, {
      size: Number(stat.size),
      contentSha256,
      synced: true,
    });
    claimAtomicRecordBytes(
      flight,
      objectId,
      observedRole,
      Number(stat.size),
    );
    handle = null;
    const value = {
      state: matches ? ("match" as const) : ("other" as const),
      objectId,
      dev: evidence.dev,
      ino: evidence.ino,
      mode: evidence.mode,
      evidence,
    };
    return Object.freeze({
      objectId,
      location: Object.freeze({
        ...value,
        evidenceDigest: sha256(
          JSON.stringify({
            ...value,
            objectId: matches ? "observed-match" : "observed-other",
          }),
        ),
      }),
    });
  } finally {
    if (handle !== null) {
      const retained = handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        "atomic-persist-observe-failed-close",
        () => retained.close(),
        () => {
          handle = null;
        },
      );
    }
  }
}

async function applyAtomicObservePersistence(
  flight: AtomicEffectFlightRecord,
  request: Extract<
    AtomicEffectRequestV1,
    {
      kind: "observe_locations";
      requestKind: "persist_intent" | "persist_manifest";
    }
  >,
): Promise<AtomicEffectObservationV1> {
  const pending = flight.persistenceResolution;
  if (
    pending === null ||
    pending.request.kind !== request.requestKind ||
    pending.request.operationId !== request.operationId ||
    pending.request.tempParentId !== request.tempParentId ||
    pending.request.tempLeaf !== request.tempLeaf ||
    pending.request.tempObjectId !== request.tempObjectId ||
    !sameAtomicEvidence(
      pending.request.expectedTemp,
      request.expectedTemp,
    ) ||
    pending.request.stableParentId !== request.stableParentId ||
    pending.request.stableLeaf !== request.stableLeaf ||
    !("absent" in pending.request.expectedStable) ||
    !("absent" in request.expectedTargetBefore) ||
    !sameAtomicEvidence(
      request.expectedTargetAfter,
      request.expectedTemp,
    )
  ) {
    return atomicRejected(flight, request, "binding_invalid");
  }
  try {
    const tempParent = resolveAtomicRecord(flight, request.tempParentId);
    const stableParent = resolveAtomicRecord(flight, request.stableParentId);
    assertAtomicMountPair(tempParent, stableParent);
    const source = await observeAtomicPersistenceChild(
      flight,
      request,
      tempParent,
      request.tempParentId,
      request.tempLeaf,
      true,
    );
    const target = await observeAtomicPersistenceChild(
      flight,
      request,
      stableParent,
      request.stableParentId,
      request.stableLeaf,
      false,
    );
    if (
      request.requestKind === "persist_intent" &&
      target.objectId !== null &&
      target.location.state === "match"
    ) {
      const intent = parseAtomicPublishIntent(
        pending.request.canonicalBytes,
      );
      flight.intents.set(target.objectId as object, intent);
      flight.stableIntents.set(
        request.stableLeaf,
        Object.freeze({
          contentSha256: pending.request.contentDigest,
          intent,
        }),
      );
    }
    flight.persistenceResolution = null;
    const evidenceDigest = sha256(
      JSON.stringify({
        requestKind: request.requestKind,
        move: request.move,
        source: source.location.evidenceDigest,
        target: target.location.evidenceDigest,
      }),
    );
    return request.requestKind === "persist_intent"
      ? Object.freeze({
          kind: "locations_observed",
          effectId: request.effectId,
          requestKind: "persist_intent",
          operationId: request.operationId,
          move: "intent_publish",
          tempParentId: request.tempParentId,
          tempLeaf: request.tempLeaf,
          stableParentId: request.stableParentId,
          stableLeaf: request.stableLeaf,
          requestedSourceObjectId: request.tempObjectId,
          sourceObjectId: source.objectId,
          targetObjectId: target.objectId,
          source: source.location,
          target: target.location,
          evidenceDigest,
        })
      : Object.freeze({
          kind: "locations_observed",
          effectId: request.effectId,
          requestKind: "persist_manifest",
          operationId: request.operationId,
          move: "manifest_publish",
          tempParentId: request.tempParentId,
          tempLeaf: request.tempLeaf,
          stableParentId: request.stableParentId,
          stableLeaf: request.stableLeaf,
          requestedSourceObjectId: request.tempObjectId,
          sourceObjectId: source.objectId,
          targetObjectId: target.objectId,
          source: source.location,
          target: target.location,
          evidenceDigest,
        });
  } catch (error) {
    return rejectAtomicFilesystemError(flight, request, error);
  }
}

async function applyAtomicEffectRaw(
  controller: AtomicEffectControllerV1,
  request: AtomicEffectRequestV1,
): Promise<AtomicEffectObservationV1> {
  const flight = requireAtomicFlight(
    controller,
    request.kind === "cleanup_partial_create",
  );
  assertAtomicRequest(flight, request);
  switch (request.kind) {
    case "persist_canary_phase":
      return atomicRejected(flight, request, "unsupported");
    case "reserve_budget":
    case "release_budget":
      return applyAtomicReservation(flight, request);
    case "create_and_pin_wrapper":
    case "create_and_pin_directory":
    case "create_and_pin_file":
    case "create_and_pin_temp_file":
      return applyAtomicCreate(flight, request);
    case "cleanup_partial_create":
      return applyAtomicPartialCleanup(flight, request);
    case "open_pin_handle":
      return applyAtomicOpen(flight, request);
    case "revalidate_handle":
    case "fsync_file":
    case "fsync_directory":
    case "fsync_parent":
      return applyAtomicRevalidateOrSync(
        flight,
        request as AtomicEffectRequestV1 & {
          kind:
            | "revalidate_handle"
            | "fsync_file"
            | "fsync_directory"
            | "fsync_parent";
        },
      );
    case "statfs_parent":
      return applyAtomicStatfs(flight, request);
    case "close_handle":
      return applyAtomicClose(
        flight,
        request as AtomicEffectRequestV1 & { kind: "close_handle" },
      );
    case "enumerate_directory":
      return applyAtomicEnumerate(
        flight,
        request as AtomicEffectRequestV1 & {
          kind: "enumerate_directory";
        },
      );
    case "read_file_chunk":
      return applyAtomicRead(
        flight,
        request as AtomicEffectRequestV1 & { kind: "read_file_chunk" },
      );
    case "copy_payload_chunk":
    case "write_file_chunk":
      return applyAtomicWrite(flight, request);
    case "hash_content_chunk":
      return applyAtomicHashChunk(flight, request);
    case "canonicalize_tree_step":
      return applyAtomicCanonicalizeTreeStep(
        flight,
        request as AtomicEffectRequestV1 & {
          kind: "canonicalize_tree_step";
        },
      );
    case "remove_intent":
    case "remove_manifest":
    case "remove_file":
    case "remove_directory":
    case "remove_root":
      return applyAtomicRemove(flight, request);
    case "populate_payload_entry":
      return applyAtomicPopulatePayloadEntry(
        flight,
        request as AtomicEffectRequestV1 & {
          kind: "populate_payload_entry";
        },
      );
    case "close_admission": {
      flight.root.acceptingOperations = false;
      const observation: AtomicEffectObservationV1 = Object.freeze({
        kind: "effect_completed",
        effectId: request.effectId,
        requestKind: request.kind,
        evidenceDigest: atomicObservationDigest(
          flight,
          request,
          request.reason,
        ),
        count: 1,
        byteSize: 0,
      });
      flight.state = "fail_stopped";
      return observation;
    }
    case "persist_intent":
    case "persist_manifest":
      return applyAtomicPersistence(flight, request);
    case "replace_intent":
      return applyAtomicReplaceIntent(flight, request);
    case "native_no_replace":
      return applyAtomicNativeNoReplace(flight, request);
    case "observe_locations":
      return request.requestKind === "native_no_replace"
        ? applyAtomicObserveLocations(flight, request)
        : applyAtomicObservePersistence(flight, request);
    case "resolve_adoption":
    case "adopt_generation":
    case "release_publication":
      return atomicRejected(flight, request, "unsupported");
  }
}

function atomicObservationCounter(
  observation: AtomicEffectObservationV1,
): AtomicPublicationCounter | null {
  if (observation.kind === "native_resolved") {
    switch (observation.rawCode) {
      case "success":
        return "success";
      case "atomic_publish_exists":
        return "conflict";
      case "atomic_publish_unsupported":
        return "unsupported";
      case "atomic_publish_cross_device":
        return "cross_device";
      case "atomic_publish_binding_invalid":
      case "atomic_publish_source_missing":
      case "atomic_publish_invalid_argument":
        return "binding_invalid";
      case "atomic_publish_denied":
        return "denied";
      case "atomic_publish_io":
        return "io";
    }
  }
  if (observation.kind === "effect_rejected") {
    switch (observation.code) {
      case "binding_invalid":
        return "binding_invalid";
      case "conflict":
        return "conflict";
      case "unsupported":
        return "unsupported";
      case "denied":
        return "denied";
      case "io":
        return "io";
      case "close_unverified":
        return "close_unverified";
      case "budget_exceeded":
        return null;
    }
  }
  return null;
}

export async function applyAtomicEffect(
  controller: AtomicEffectControllerV1,
  request: AtomicEffectRequestV1,
): Promise<AtomicEffectObservationV1> {
  const flight = requireAtomicFlight(
    controller,
    request.kind === "cleanup_partial_create",
  );
  if (request.kind === "native_no_replace") {
    flight.root.observability?.count("attempts");
  }
  const observation = await applyAtomicEffectRaw(controller, request);
  const counter = atomicObservationCounter(observation);
  if (counter !== null) flight.root.observability?.count(counter);
  if (request.kind === "close_admission") {
    const mapped: AtomicPublicationCounter | null =
      request.reason === "ambiguous"
        ? "ambiguous"
        : request.reason === "cross_device"
          ? "cross_device"
          : request.reason === "binding_invalid"
            ? "binding_invalid"
            : request.reason === "unsupported"
              ? "unsupported"
              : request.reason === "denied"
                ? "denied"
                : request.reason === "io"
                  ? "io"
                  : "close_unverified";
    flight.root.observability?.count(mapped);
  }
  return observation;
}

type AtomicProtocolRunResult = Readonly<{
  observations: readonly AtomicEffectObservationV1[];
  classification: AtomicNativeClassificationV1 | null;
}>;

async function runAtomicReducerRequest(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  request: AtomicEffectRequestDraftV1,
  semanticIds: readonly FlightSemanticId[],
): Promise<AtomicProtocolRunResult> {
  const uniqueSemanticIds = [...new Set(semanticIds)];
  let step = reduceAtomicPublication(
    createAtomicReducerState({
      flightNonce,
      request,
      semanticIds: uniqueSemanticIds,
      ...((request.kind === "canonicalize_tree_step"
        ? { cursors: { content: request.cursor } }
        : request.kind === "hash_content_chunk"
          ? { cursors: { content: request.offset } }
          : request.kind === "enumerate_directory"
            ? { cursors: { directory: request.cursor } }
            : request.kind === "read_file_chunk"
              ? { cursors: { file: request.cursor } }
              : {}) satisfies Partial<
        Parameters<typeof createAtomicReducerState>[0]
      >),
    }),
    null,
  );
  const observations: AtomicEffectObservationV1[] = [];
  for (let count = 0; count < 8; count += 1) {
    if (step.kind === "terminal") {
      if (step.result.kind !== "protocol_complete") {
        throw atomicFailure(
          `atomic publication protocol failed: ${
            step.result.kind === "fail_stop"
              ? step.result.code
              : step.result.kind
          } after ${request.kind} (${observations
            .map(observation =>
              observation.kind === "native_resolved"
                ? `${observation.kind}:${observation.rawCode}`
                : observation.kind === "locations_observed"
                  ? `${observation.kind}:${observation.source.state}/${observation.target.state}`
                  : observation.kind,
            )
            .join(",")})`,
        );
      }
      return Object.freeze({
        observations: Object.freeze([...observations]),
        classification: step.state.nativeClassification,
      });
    }
    const observation = await applyAtomicEffect(
      controller,
      step.request,
    );
    observations.push(observation);
    step = reduceAtomicPublication(step.state, observation);
  }
  throw atomicFailure("atomic publication protocol exceeded effect bound");
}

export type AtomicPinnedPersistenceProtocolInputV1 = Readonly<{
  flightNonce: string;
  request: Extract<
    AtomicEffectRequestDraftV1,
    { kind: "persist_intent" | "persist_manifest" }
  >;
  stableParentRole: "intents_parent";
  stableParentEvidence: AtomicObjectEvidenceV1;
}>;

export type AtomicPinnedPersistenceProtocolResultV1 = Readonly<{
  stableObjectId: FlightSemanticId;
  stableEvidence: AtomicObjectEvidenceV1;
}>;

export async function runAtomicPinnedPersistenceProtocol(
  controller: AtomicEffectControllerV1,
  input: AtomicPinnedPersistenceProtocolInputV1,
): Promise<AtomicPinnedPersistenceProtocolResultV1> {
  const semanticIds = [
    input.request.tempParentId,
    input.request.tempObjectId,
    input.request.stableParentId,
  ];
  const persisted = await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:persist`,
    input.request,
    semanticIds,
  );
  const locations = persisted.observations.find(
    (
      observation,
    ): observation is Extract<
      AtomicEffectObservationV1,
      {
        kind: "locations_observed";
        requestKind: "persist_intent" | "persist_manifest";
      }
    > =>
      observation.kind === "locations_observed" &&
      observation.requestKind !== "native_no_replace",
  );
  if (
    locations === undefined ||
    locations.source.state !== "absent" ||
    locations.sourceObjectId !== null ||
    locations.target.state !== "match" ||
    locations.targetObjectId === null ||
    locations.target.evidence === null ||
    !sameAtomicEvidence(
      locations.target.evidence,
      input.request.expectedTemp,
    )
  ) {
    throw atomicFailure("atomic persistence location proof is invalid");
  }
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:sync-parent`,
    {
      kind: "fsync_parent",
      operationId: input.request.operationId,
      role: input.stableParentRole,
      objectId: input.request.stableParentId,
      expected: input.stableParentEvidence,
    },
    [input.request.stableParentId],
  );
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:close-temp`,
    {
      kind: "close_handle",
      operationId: input.request.operationId,
      role:
        input.request.kind === "persist_manifest"
          ? "manifest_temp"
          : "intent_temp",
      objectId: input.request.tempObjectId,
      cursor: 0,
      byteLength: 0,
      expected: input.request.expectedTemp,
    },
    [input.request.tempObjectId],
  );
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:release-temp-file`,
    {
      kind: "release_budget",
      operationId: input.request.operationId,
      reservation: "scratch_files",
      count: 1,
      byteSize: 0,
    },
    [],
  );
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:release-temp-bytes`,
    {
      kind: "release_budget",
      operationId: input.request.operationId,
      reservation:
        input.request.kind === "persist_manifest"
          ? "manifest_bytes"
          : "other_metadata_bytes",
      count: 0,
      byteSize: input.request.canonicalBytes.byteLength,
    },
    [],
  );
  return Object.freeze({
    stableObjectId: locations.targetObjectId,
    stableEvidence: locations.target.evidence,
  });
}

export type AtomicCreateAndPersistRecordProtocolInputV1 = Readonly<{
  flightNonce: string;
  operationId: string;
  publication:
    | Readonly<{
        kind: "persist_intent";
        expectedPhase: null;
      }>
    | Readonly<{
        kind: "persist_manifest";
        expectedPhase: "manifest_planned";
      }>;
  canonicalBytes: Uint8Array;
  contentDigest: string;
  tempParentId: FlightSemanticId;
  tempParentEvidence: AtomicObjectEvidenceV1;
  tempLeaf: string;
  stableParentId: FlightSemanticId;
  stableParentEvidence: AtomicObjectEvidenceV1;
  stableLeaf: string;
}>;

export async function runAtomicCreateAndPersistRecordProtocol(
  controller: AtomicEffectControllerV1,
  input: AtomicCreateAndPersistRecordProtocolInputV1,
): Promise<AtomicPinnedPersistenceProtocolResultV1> {
  if (
    input.canonicalBytes.byteLength === 0 ||
    sha256(input.canonicalBytes) !== input.contentDigest
  ) {
    throw atomicFailure("canonical persistence bytes are invalid");
  }
  const byteReservation =
    input.publication.kind === "persist_manifest"
      ? "manifest_bytes"
      : "other_metadata_bytes";
  const reservations: ReadonlyArray<
    Readonly<{
      reservation: AtomicReservationKind;
      count: number;
      byteSize: number;
    }>
  > = [
    ...(input.publication.kind === "persist_manifest"
      ? [
          {
            reservation: "stable_files" as const,
            count: 1,
            byteSize: 0,
          },
        ]
      : []),
    {
      reservation: "scratch_files" as const,
      count: 1,
      byteSize: 0,
    },
    {
      reservation: byteReservation,
      count: 0,
      byteSize: input.canonicalBytes.byteLength * 2,
    },
  ];
  for (const reservation of reservations) {
    await runAtomicReducerRequest(
      controller,
      `${input.flightNonce}:reserve:${reservation.reservation}`,
      {
        kind: "reserve_budget",
        operationId: input.operationId,
        ...reservation,
      },
      [],
    );
  }
  const tempRole =
    input.publication.kind === "persist_manifest"
      ? ("manifest_temp" as const)
      : ("intent_temp" as const);
  const created = await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:create-temp`,
    {
      kind: "create_and_pin_temp_file",
      operationId: input.operationId,
      role: tempRole,
      parentId: input.tempParentId,
      leaf: input.tempLeaf,
      parentEvidenceDigest: input.tempParentEvidence.evidenceDigest,
      mode: 384,
      expectedAbsence: true,
    },
    [input.tempParentId],
  );
  const temp = created.observations.find(
    (
      observation,
    ): observation is Extract<
      AtomicEffectObservationV1,
      { kind: "create_and_pin_completed" }
    > => observation.kind === "create_and_pin_completed",
  );
  if (temp === undefined) {
    throw atomicFailure("atomic persistence temp creation is invalid");
  }
  for (
    let offset = 0;
    offset < input.canonicalBytes.byteLength;
    offset += ATOMIC_OBSERVATION_BYTE_LIMIT
  ) {
    const end = Math.min(
      input.canonicalBytes.byteLength,
      offset + ATOMIC_OBSERVATION_BYTE_LIMIT,
    );
    const chunk = input.canonicalBytes.slice(offset, end);
    await runAtomicReducerRequest(
      controller,
      `${input.flightNonce}:write-temp:${offset}`,
      {
        kind: "write_file_chunk",
        operationId: input.operationId,
        sourceFileId: null,
        inlineBytes: chunk,
        destinationFileId: temp.handleId,
        offset,
        byteLength: chunk.byteLength,
        expectedChunkSha256: sha256(chunk),
        expectedResultSha256: sha256(input.canonicalBytes.slice(0, end)),
      },
      [temp.handleId],
    );
  }
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:sync-temp`,
    {
      kind: "fsync_file",
      operationId: input.operationId,
      role: tempRole,
      objectId: temp.handleId,
      expected: temp.evidence,
    },
    [temp.handleId],
  );
  const tempValue = {
    dev: temp.evidence.dev,
    ino: temp.evidence.ino,
    mode: temp.evidence.mode,
    size: input.canonicalBytes.byteLength,
    contentSha256: input.contentDigest,
  };
  const expectedTemp = Object.freeze({
    ...tempValue,
    evidenceDigest: sha256(JSON.stringify(tempValue)),
  });
  const request =
    input.publication.kind === "persist_manifest"
      ? ({
          kind: "persist_manifest",
          operationId: input.operationId,
          expectedPhase: "manifest_planned",
          canonicalBytes: input.canonicalBytes,
          contentDigest: input.contentDigest,
          tempParentId: input.tempParentId,
          tempLeaf: input.tempLeaf,
          tempObjectId: temp.handleId,
          expectedTemp,
          stableParentId: input.stableParentId,
          stableLeaf: input.stableLeaf,
          expectedStable: { absent: true as const },
        } satisfies Extract<
          AtomicEffectRequestDraftV1,
          { kind: "persist_manifest" }
        >)
      : ({
          kind: "persist_intent",
          operationId: input.operationId,
          expectedPhase: null,
          canonicalBytes: input.canonicalBytes,
          contentDigest: input.contentDigest,
          tempParentId: input.tempParentId,
          tempLeaf: input.tempLeaf,
          tempObjectId: temp.handleId,
          expectedTemp,
          stableParentId: input.stableParentId,
          stableLeaf: input.stableLeaf,
          expectedStable: { absent: true as const },
        } satisfies Extract<
          AtomicEffectRequestDraftV1,
          { kind: "persist_intent" }
        >);
  return runAtomicPinnedPersistenceProtocol(controller, {
    flightNonce: `${input.flightNonce}:publish`,
    request,
    stableParentRole: "intents_parent",
    stableParentEvidence: input.stableParentEvidence,
  });
}

export type AtomicIntentReplacementProtocolInputV1 = Readonly<{
  flightNonce: string;
  request: Extract<
    AtomicEffectRequestDraftV1,
    { kind: "replace_intent" }
  >;
  stableParentRole: "intents_parent";
  stableParentEvidence: AtomicObjectEvidenceV1;
}>;

export type AtomicIntentReplacementProtocolResultV1 = Readonly<{
  stableObjectId: FlightSemanticId;
  stableEvidence: AtomicObjectEvidenceV1;
}>;

export async function runAtomicIntentReplacementProtocol(
  controller: AtomicEffectControllerV1,
  input: AtomicIntentReplacementProtocolInputV1,
): Promise<AtomicIntentReplacementProtocolResultV1> {
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:replace`,
    input.request,
    [
      input.request.tempParentId,
      input.request.tempObjectId,
      input.request.stableParentId,
      input.request.stableObjectId,
    ],
  );
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:close-old-stable`,
    {
      kind: "close_handle",
      operationId: input.request.operationId,
      role: "intent_stable",
      objectId: input.request.stableObjectId,
      cursor: 0,
      byteLength: 0,
      expected: input.request.expectedStable,
    },
    [input.request.stableObjectId],
  );
  const opened = await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:open-new-stable`,
    {
      kind: "open_pin_handle",
      operationId: input.request.operationId,
      role: "intent_stable",
      parentId: input.request.stableParentId,
      leaf: input.request.stableLeaf,
      flags: "file_read_nofollow",
      expected: input.request.expectedTemp,
    },
    [input.request.stableParentId],
  );
  const stable = opened.observations.find(
    (
      observation,
    ): observation is Extract<
      AtomicEffectObservationV1,
      { kind: "existing_handle_pinned" }
    > => observation.kind === "existing_handle_pinned",
  );
  if (
    stable === undefined ||
    !sameAtomicEvidence(stable.evidence, input.request.expectedTemp)
  ) {
    throw atomicFailure("replacement stable intent proof is invalid");
  }
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:sync-parent`,
    {
      kind: "fsync_parent",
      operationId: input.request.operationId,
      role: input.stableParentRole,
      objectId: input.request.stableParentId,
      expected: input.stableParentEvidence,
    },
    [input.request.stableParentId],
  );
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:close-temp`,
    {
      kind: "close_handle",
      operationId: input.request.operationId,
      role: "intent_temp",
      objectId: input.request.tempObjectId,
      cursor: 0,
      byteLength: 0,
      expected: input.request.expectedTemp,
    },
    [input.request.tempObjectId],
  );
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:release-temp-file`,
    {
      kind: "release_budget",
      operationId: input.request.operationId,
      reservation: "scratch_files",
      count: 1,
      byteSize: 0,
    },
    [],
  );
  await runAtomicReducerRequest(
    controller,
    `${input.flightNonce}:release-temp-bytes`,
    {
      kind: "release_budget",
      operationId: input.request.operationId,
      reservation: "other_metadata_bytes",
      count: 0,
      byteSize: input.request.expectedStable.size,
    },
    [],
  );
  return Object.freeze({
    stableObjectId: stable.handleId,
    stableEvidence: stable.evidence,
  });
}

export type AtomicPrivateProfileEntryV1 =
  | Readonly<{
      path: string;
      type: "directory";
    }>
  | Readonly<{
      path: string;
      type: "file";
      bytes: Uint8Array;
      sourceFileId?: FlightSemanticId;
      sourceEvidence?: AtomicObjectEvidenceV1;
    }>;

export type AtomicPrivateProfilePublicationInputV1 = Readonly<{
  flightNonce: string;
  operationId: string;
  kind: "scaffold" | "working" | "prepare" | "finalize";
  binding: ReadyProfileRootBinding;
  target: PublicationTargetV1;
  bundlesParentId: FlightSemanticId;
  bundlesParentEvidence: AtomicObjectEvidenceV1;
  intentsParentId: FlightSemanticId;
  intentsParentEvidence: AtomicObjectEvidenceV1;
  targetParentId: FlightSemanticId;
  targetParentRole: "profiles_parent" | "public_target";
  targetParentEvidence: AtomicObjectEvidenceV1;
  entries?: readonly AtomicPrivateProfileEntryV1[];
  publicSource?: AtomicPublishIntentV1["publicSource"];
  cleanupEntries?: readonly CleanupIdentityEntryV1[];
}>;

export type AtomicPrivateProfilePublicationResultV1 = Readonly<{
  outcome: "published" | "conflict";
  phases: readonly (
    | "allocated"
    | "building"
    | "ready"
    | "classified"
    | "renamed"
    | "manifest_planned"
    | "manifest_published"
  )[];
  tree: CanonicalProfileTreeEvidence;
  targetObjectId: FlightSemanticId | null;
  targetEvidence: AtomicObjectEvidenceV1 | null;
  wrapperObjectId: FlightSemanticId;
  wrapperEvidence: AtomicObjectEvidenceV1;
  privateSourceObjectId: FlightSemanticId;
  privateSourceEvidence: AtomicObjectEvidenceV1;
  intentObjectId: FlightSemanticId;
  intentEvidence: AtomicObjectEvidenceV1;
  manifestObjectId: FlightSemanticId;
  manifestEvidence: AtomicObjectEvidenceV1;
  cleanupManifest: CleanupIdentityManifestV1;
  cleanupObjects: ReadonlyArray<
    Readonly<{
      index: number;
      path: string;
      type: "file" | "directory";
      role: "payload_entry" | "private_source";
      objectId: FlightSemanticId;
      evidence: AtomicObjectEvidenceV1;
    }>
  >;
}>;

type AtomicPublishedIntentRecord = {
  intent: AtomicPublishIntentV1;
  objectId: FlightSemanticId;
  evidence: AtomicObjectEvidenceV1;
};

type AtomicConstructedEntry = {
  path: string;
  type: "directory" | "file";
  objectId: FlightSemanticId;
  evidence: AtomicObjectEvidenceV1;
  mode: 384 | 448;
  size: number;
  contentSha256: string | null;
};

function atomicTransitionId(operationId: string, label: string): string {
  const value = sha256(`${operationId}\n${label}`).slice(0, 32).split("");
  value[12] = "4";
  value[16] = "8";
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function atomicIntentTempLeaf(
  operationId: string,
  phase: AtomicPublishIntentV1["phase"],
): string {
  return `${operationId}.${phase}.${atomicTransitionId(operationId, `intent:${phase}`)}.tmp`;
}

function normalizeAtomicPrivateEntries(
  kind: "scaffold" | "working" | "prepare" | "finalize",
  supplied: readonly AtomicPrivateProfileEntryV1[] | undefined,
): readonly AtomicPrivateProfileEntryV1[] {
  const entries =
    kind === "scaffold"
      ? ([
          { path: "committed", type: "directory" },
          { path: "staging", type: "directory" },
          { path: "working", type: "directory" },
        ] as const)
      : (supplied ?? []);
  if (kind === "scaffold" && supplied !== undefined) {
    throw atomicFailure("atomic scaffold schema is fixed");
  }
  const normalized = [...entries].sort((left, right) =>
    rawCompare(left.path, right.path),
  );
  const seen = new Set<string>();
  const types = new Map<string, "directory" | "file">();
  for (const entry of normalized) {
    if (
      typeof entry.path !== "string" ||
      entry.path.normalize("NFC") !== entry.path ||
      entry.path === "" ||
      Buffer.byteLength(entry.path, "utf8") > 1_024
    ) {
      throw atomicFailure("atomic profile path is invalid");
    }
    const segments = entry.path.split("/");
    if (
      segments.length > PROFILE_MAX_DEPTH ||
      segments.some(segment => !isAtomicPayloadLeafV1(segment))
    ) {
      throw atomicFailure("atomic profile path is invalid");
    }
    if (seen.has(entry.path)) {
      throw atomicFailure("atomic profile path is duplicated");
    }
    seen.add(entry.path);
    const parent = segments.slice(0, -1).join("/");
    if (parent !== "" && types.get(parent) !== "directory") {
      throw atomicFailure("atomic profile parent is missing");
    }
    if (
      entry.type === "file" &&
      (!(entry.bytes instanceof Uint8Array) ||
        entry.bytes.byteLength > PROFILE_FILE_MAX_BYTES ||
        ((entry.sourceFileId === undefined) !==
          (entry.sourceEvidence === undefined)) ||
        (entry.sourceEvidence !== undefined &&
          (entry.sourceEvidence.size !== entry.bytes.byteLength ||
            entry.sourceEvidence.contentSha256 !== sha256(entry.bytes))))
    ) {
      throw atomicFailure("atomic profile file schema is invalid");
    }
    types.set(entry.path, entry.type);
  }
  const byteSize = normalized.reduce(
    (total, entry) =>
      total + (entry.type === "file" ? entry.bytes.byteLength : 0),
    0,
  );
  assertAtomicProfileSchemaV1(
    kind === "scaffold"
      ? "scaffold"
      : kind === "working"
        ? "initial_working"
        : "writer",
    normalized.length + 1,
    byteSize,
  );
  return Object.freeze(normalized.map(entry => Object.freeze({ ...entry })));
}

async function runAtomicRequest(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  request: AtomicEffectRequestDraftV1,
  semanticIds: readonly FlightSemanticId[],
): Promise<AtomicProtocolRunResult> {
  return runAtomicReducerRequest(
    controller,
    flightNonce,
    request,
    semanticIds,
  );
}

function atomicCreatedObservation(
  result: AtomicProtocolRunResult,
): Extract<
  AtomicEffectObservationV1,
  { kind: "create_and_pin_completed" }
> {
  const created = result.observations.find(
    (
      observation,
    ): observation is Extract<
      AtomicEffectObservationV1,
      { kind: "create_and_pin_completed" }
    > => observation.kind === "create_and_pin_completed",
  );
  if (created === undefined) {
    throw atomicFailure("atomic publication create did not complete");
  }
  return created;
}

async function reserveAtomicBudget(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  operationId: string,
  reservation: AtomicReservationKind,
  count: number,
  byteSize: number,
): Promise<void> {
  await runAtomicRequest(
    controller,
    flightNonce,
    {
      kind: "reserve_budget",
      operationId,
      reservation,
      count,
      byteSize,
    },
    [],
  );
}

async function releaseAtomicBudget(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  operationId: string,
  reservation: AtomicReservationKind,
  count: number,
  byteSize: number,
): Promise<void> {
  await runAtomicRequest(
    controller,
    flightNonce,
    {
      kind: "release_budget",
      operationId,
      reservation,
      count,
      byteSize,
    },
    [],
  );
}

async function syncAtomicHeld(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  operationId: string,
  kind: "fsync_file" | "fsync_directory" | "fsync_parent",
  role: AtomicObjectRoleV1,
  objectId: FlightSemanticId,
  expected: AtomicObjectEvidenceV1,
): Promise<void> {
  await runAtomicRequest(
    controller,
    flightNonce,
    { kind, operationId, role, objectId, expected },
    [objectId],
  );
}

function atomicContentEvidence(
  evidence: AtomicObjectEvidenceV1,
  size: number,
  contentSha256: string,
): AtomicObjectEvidenceV1 {
  const value = {
    dev: evidence.dev,
    ino: evidence.ino,
    mode: evidence.mode,
    size,
    contentSha256,
  };
  return Object.freeze({
    ...value,
    evidenceDigest: sha256(JSON.stringify(value)),
  });
}

async function createAndReplaceAtomicIntent(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  current: AtomicPublishedIntentRecord,
  next: AtomicPublishIntentV1,
  intentsParentId: FlightSemanticId,
  intentsParentEvidence: AtomicObjectEvidenceV1,
): Promise<AtomicPublishedIntentRecord> {
  const encoded = encodeAtomicPublishIntent(next);
  const growthReservation = Math.max(
    0,
    encoded.bytes.byteLength - current.evidence.size,
  );
  await reserveAtomicBudget(
    controller,
    `${flightNonce}:reserve-file`,
    next.operationId,
    "scratch_files",
    1,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${flightNonce}:reserve-bytes`,
    next.operationId,
    "other_metadata_bytes",
    0,
    encoded.bytes.byteLength + growthReservation,
  );
  const tempLeaf = atomicIntentTempLeaf(next.operationId, next.phase);
  const temp = atomicCreatedObservation(
    await runAtomicRequest(
      controller,
      `${flightNonce}:create`,
      {
        kind: "create_and_pin_temp_file",
        operationId: next.operationId,
        role: "intent_temp",
        parentId: intentsParentId,
        leaf: tempLeaf,
        parentEvidenceDigest: intentsParentEvidence.evidenceDigest,
        mode: 384,
        expectedAbsence: true,
      },
      [intentsParentId],
    ),
  );
  for (
    let offset = 0;
    offset < encoded.bytes.byteLength;
    offset += ATOMIC_OBSERVATION_BYTE_LIMIT
  ) {
    const chunk = encoded.bytes.subarray(
      offset,
      Math.min(encoded.bytes.byteLength, offset + ATOMIC_OBSERVATION_BYTE_LIMIT),
    );
    await runAtomicRequest(
      controller,
      `${flightNonce}:write:${offset}`,
      {
        kind: "write_file_chunk",
        operationId: next.operationId,
        sourceFileId: null,
        inlineBytes: chunk,
        destinationFileId: temp.handleId,
        offset,
        byteLength: chunk.byteLength,
        expectedChunkSha256: sha256(chunk),
        expectedResultSha256: sha256(encoded.bytes.subarray(0, offset + chunk.byteLength)),
      },
      [temp.handleId],
    );
  }
  await syncAtomicHeld(
    controller,
    `${flightNonce}:sync`,
    next.operationId,
    "fsync_file",
    "intent_temp",
    temp.handleId,
    temp.evidence,
  );
  const expectedTemp = atomicContentEvidence(
    temp.evidence,
    encoded.bytes.byteLength,
    encoded.sha256,
  );
  const replaced = await runAtomicIntentReplacementProtocol(controller, {
    flightNonce: `${flightNonce}:replace`,
    request: {
      kind: "replace_intent",
      operationId: next.operationId,
      expectedPhase: current.intent.phase,
      canonicalBytes: encoded.bytes,
      contentDigest: encoded.sha256,
      tempParentId: intentsParentId,
      tempLeaf,
      tempObjectId: temp.handleId,
      expectedTemp,
      stableParentId: intentsParentId,
      stableLeaf: `${next.operationId}.json`,
      stableObjectId: current.objectId,
      expectedStable: current.evidence,
    },
    stableParentRole: "intents_parent",
    stableParentEvidence: intentsParentEvidence,
  });
  if (growthReservation > 0) {
    await releaseAtomicBudget(
      controller,
      `${flightNonce}:release-growth`,
      next.operationId,
      "other_metadata_bytes",
      0,
      growthReservation,
    );
  }
  return {
    intent: next,
    objectId: replaced.stableObjectId,
    evidence: replaced.stableEvidence,
  };
}

function requireAtomicParentRecord(
  flight: AtomicEffectFlightRecord,
  record: AtomicHeldRecord,
): AtomicHeldRecord {
  if (record.parentId === null) {
    throw atomicFailure("atomic profile held ancestry is invalid");
  }
  return resolveAtomicRecord(flight, record.parentId);
}

function assertAtomicPrivateControlAuthority(
  flight: AtomicEffectFlightRecord,
  input: AtomicPrivateProfilePublicationInputV1,
): AtomicHeldRecord {
  if (!sameReadyBinding(input.binding, flight.binding)) {
    throw atomicFailure("atomic private publication binding is invalid");
  }
  const bundlesParent = resolveAtomicRecord(flight, input.bundlesParentId);
  const intentsParent = resolveAtomicRecord(flight, input.intentsParentId);
  const targetParent = resolveAtomicRecord(flight, input.targetParentId);
  if (
    bundlesParent.role !== "bundles_parent" ||
    bundlesParent.leaf !== "bundles" ||
    !bundlesParent.stat.isDirectory() ||
    !sameAtomicEvidence(
      bundlesParent.evidence,
      input.bundlesParentEvidence,
    ) ||
    intentsParent.role !== "intents_parent" ||
    intentsParent.leaf !== "intents" ||
    !intentsParent.stat.isDirectory() ||
    !sameAtomicEvidence(
      intentsParent.evidence,
      input.intentsParentEvidence,
    ) ||
    targetParent.role !== input.targetParentRole ||
    !targetParent.stat.isDirectory() ||
    !sameAtomicEvidence(
      targetParent.evidence,
      input.targetParentEvidence,
    )
  ) {
    throw atomicFailure("atomic private publication control authority is invalid");
  }
  const bundlesStaging = requireAtomicParentRecord(flight, bundlesParent);
  const intentsStaging = requireAtomicParentRecord(flight, intentsParent);
  if (
    bundlesStaging !== intentsStaging ||
    bundlesStaging.role !== "staging_root" ||
    bundlesStaging.leaf !== ".profile-publish-staging" ||
    !bundlesStaging.stat.isDirectory()
  ) {
    throw atomicFailure("atomic private publication control ancestry is invalid");
  }
  const controlStateRoot = requireAtomicParentRecord(
    flight,
    bundlesStaging,
  );
  if (
    controlStateRoot.role !== "state_root" ||
    controlStateRoot.parentId !== null ||
    controlStateRoot.leaf !== null ||
    !controlStateRoot.stat.isDirectory()
  ) {
    throw atomicFailure("atomic private publication control ancestry is invalid");
  }

  let targetProfilesParent: AtomicHeldRecord;
  if (input.kind === "scaffold") {
    targetProfilesParent = targetParent;
  } else {
    const profileParent = requireAtomicParentRecord(flight, targetParent);
    targetProfilesParent = requireAtomicParentRecord(flight, profileParent);
  }
  if (
    targetProfilesParent.role !== "profiles_parent" ||
    targetProfilesParent.leaf !== "profiles" ||
    !targetProfilesParent.stat.isDirectory() ||
    requireAtomicParentRecord(flight, targetProfilesParent) !==
      controlStateRoot
  ) {
    throw atomicFailure("atomic private publication target ancestry is invalid");
  }
  for (const record of [bundlesParent, intentsParent, targetParent]) {
    assertAtomicHeldChain(flight, record);
  }
  return controlStateRoot;
}

function assertAtomicPrivateProfileHeldAuthority(
  flight: AtomicEffectFlightRecord,
  input: AtomicPrivateProfilePublicationInputV1,
  entries: readonly AtomicPrivateProfileEntryV1[],
  stateRoot: AtomicHeldRecord,
): void {
  if (input.kind !== "scaffold") {
    const targetParent = resolveAtomicRecord(flight, input.targetParentId);
    const profileParent = requireAtomicParentRecord(flight, targetParent);
    const profilesParent = requireAtomicParentRecord(flight, profileParent);
    if (
      input.target.kind !== "profile_state" ||
      input.target.state !==
        (input.kind === "working"
          ? "working"
          : input.kind === "prepare"
            ? "staging"
            : "committed") ||
      targetParent.role !== "public_target" ||
      targetParent.leaf !== input.target.state ||
      !targetParent.stat.isDirectory() ||
      !sameAtomicEvidence(targetParent.evidence, input.targetParentEvidence) ||
      profileParent.role !== "public_target" ||
      profileParent.leaf !== input.target.profileId ||
      !profileParent.stat.isDirectory() ||
      profilesParent.role !== "profiles_parent" ||
      profilesParent.leaf !== "profiles" ||
      requireAtomicParentRecord(flight, profilesParent) !== stateRoot
    ) {
      throw atomicFailure(
        input.kind === "working"
          ? "atomic working target authority is invalid"
          : "atomic profile target authority is invalid",
      );
    }
  }

  for (const entry of entries) {
    if (
      entry.type !== "file" ||
      entry.sourceFileId === undefined ||
      entry.sourceEvidence === undefined
    ) {
      continue;
    }
    const source = resolveAtomicRecord(flight, entry.sourceFileId);
    if (
      source.role !== "public_source" ||
      !source.stat.isFile() ||
      !sameAtomicEvidence(source.evidence, entry.sourceEvidence)
    ) {
      throw atomicFailure("atomic committed copy authority is invalid");
    }
    let cursor = source;
    let committedParent: AtomicHeldRecord | null = null;
    const seen = new Set<AtomicHeldRecord>();
    while (cursor.parentId !== null) {
      if (seen.has(cursor)) {
        throw atomicFailure("atomic committed copy authority is invalid");
      }
      seen.add(cursor);
      const parent = resolveAtomicRecord(flight, cursor.parentId);
      if (parent.role === "public_target" && parent.leaf === "committed") {
        committedParent = parent;
        break;
      }
      if (parent.role !== "public_source") {
        throw atomicFailure("atomic committed copy authority is invalid");
      }
      cursor = parent;
    }
    if (committedParent === null || !committedParent.stat.isDirectory()) {
      throw atomicFailure("atomic committed copy authority is invalid");
    }
    const profileParent = requireAtomicParentRecord(flight, committedParent);
    const profilesParent = requireAtomicParentRecord(flight, profileParent);
    if (
      input.target.kind !== "profile_state" ||
      profileParent.role !== "public_target" ||
      profileParent.leaf !== input.target.profileId ||
      !profileParent.stat.isDirectory() ||
      profilesParent.role !== "profiles_parent" ||
      profilesParent.leaf !== "profiles" ||
      requireAtomicParentRecord(flight, profilesParent) !== stateRoot
    ) {
      throw atomicFailure("atomic committed copy authority is invalid");
    }
  }
}

async function proveAtomicPrivateProfileTree(
  flight: AtomicEffectFlightRecord,
  objectId: FlightSemanticId,
  evidence: AtomicObjectEvidenceV1,
  role: "private_source" | "public_target",
  expected: CanonicalProfileTreeEvidence,
): Promise<void> {
  const record = resolveAtomicRecord(flight, objectId);
  if (
    record.role !== role ||
    !record.stat.isDirectory() ||
    !sameAtomicEvidence(record.evidence, evidence)
  ) {
    throw atomicFailure("atomic published profile tree authority is invalid");
  }
  assertAtomicHeldChain(flight, record);
  const budget = new Budget(MAX_RECONCILIATION_REFERENCES);
  budget.take();
  const first = await hashProfileTreeAt(
    flight.root.anchored,
    record.handle,
    budget,
  );
  const final = await validateProfileEvidenceRaw(
    flight.root.anchored,
    record.handle,
    first.evidence,
  );
  if (
    first.checksum !== final.checksum ||
    first.byteSize !== final.byteSize
  ) {
    throw atomicFailure("atomic published profile tree changed during proof");
  }
  assertAtomicHeldChain(flight, record);
  const observed = publicTreeEvidence({ ...final, evidence: first.evidence });
  if (
    observed.canonicalJson !== expected.canonicalJson ||
    observed.checksum !== expected.checksum ||
    observed.byteSize !== expected.byteSize ||
    observed.fileCount !== expected.fileCount ||
    observed.entries.length !== expected.entries.length
  ) {
    throw atomicFailure("atomic published profile tree proof is invalid");
  }
  const observedByPath = new Map(
    observed.entries.map(entry => [entry.path, entry] as const),
  );
  for (const entry of expected.entries) {
    const actual = observedByPath.get(entry.path);
    if (
      actual === undefined ||
      actual.type !== entry.type ||
      actual.dev !== entry.dev ||
      actual.ino !== entry.ino ||
      actual.mode !== entry.mode ||
      actual.sha256 !== entry.sha256 ||
      (entry.type === "file" &&
        (actual.size !== entry.size || actual.nlink !== "1"))
    ) {
      throw atomicFailure("atomic published profile tree proof is invalid");
    }
  }
}

export async function runAtomicPrivateProfilePublication(
  controller: AtomicEffectControllerV1,
  input: AtomicPrivateProfilePublicationInputV1,
): Promise<AtomicPrivateProfilePublicationResultV1> {
  const flight = requireAtomicFlight(controller);
  const profileTarget =
    input.target.kind === "profile_state" ? input.target : null;
  if (
    input.operationId !== flight.operationId ||
    !UUID.test(input.operationId) ||
    input.target.parent.dev !== input.targetParentEvidence.dev ||
    input.target.parent.ino !== input.targetParentEvidence.ino ||
    input.target.parent.mode !== input.targetParentEvidence.mode ||
    (input.kind === "scaffold" &&
      (input.target.kind !== "profile" ||
        input.targetParentRole !== "profiles_parent" ||
        input.target.leaf !== input.target.profileId)) ||
    (input.kind === "working" &&
      (input.target.kind !== "profile_state" ||
        input.targetParentRole !== "public_target" ||
        input.target.state !== "working" ||
        input.target.leaf !== input.target.generationId)) ||
    (input.kind === "prepare" &&
      (input.target.kind !== "profile_state" ||
        input.targetParentRole !== "public_target" ||
        input.target.state !== "staging" ||
        input.target.leaf !== input.target.generationId ||
        input.publicSource?.state !== "working")) ||
    (input.kind === "finalize" &&
      (input.target.kind !== "profile_state" ||
        input.targetParentRole !== "public_target" ||
        input.target.state !== "committed" ||
        input.target.leaf !== input.target.generationId ||
        input.publicSource?.state !== "staging")) ||
    ((input.kind === "prepare" || input.kind === "finalize") &&
      (input.publicSource == null ||
        profileTarget === null ||
        input.publicSource.profileId !== profileTarget.profileId ||
        input.publicSource.generationId !== profileTarget.generationId)) ||
    ((input.kind === "scaffold" || input.kind === "working") &&
      input.publicSource !== undefined)
  ) {
    throw atomicFailure("atomic private publication authority is invalid");
  }
  const entries = normalizeAtomicPrivateEntries(input.kind, input.entries);
  const stateRoot = assertAtomicPrivateControlAuthority(flight, input);
  assertAtomicPrivateProfileHeldAuthority(
    flight,
    input,
    entries,
    stateRoot,
  );
  const totalBytes = entries.reduce(
    (total, entry) =>
      total + (entry.type === "file" ? entry.bytes.byteLength : 0),
    0,
  );
  const phases: AtomicPrivateProfilePublicationResultV1["phases"][number][] =
    [];
  const baseIntent: AtomicPublishIntentV1 = {
    version: 1,
    operationId: input.operationId,
    kind: input.kind,
    phase: "allocated",
    binding: input.binding,
    target: input.target,
    wrapper: null,
    privateSource: null,
    publicSource: input.publicSource ?? null,
    classification: null,
    sourceDeletion: null,
    adoption: null,
    cleanup: null,
    canaryProof: null,
    prepublicationAbort: null,
    identityManifest: null,
  };
  const allocatedBytes = encodeAtomicPublishIntent(baseIntent);
  await reserveAtomicBudget(
    controller,
    `${input.flightNonce}:allocated:stable`,
    input.operationId,
    "stable_files",
    1,
    0,
  );
  const allocatedRecord = await runAtomicCreateAndPersistRecordProtocol(
    controller,
    {
      flightNonce: `${input.flightNonce}:allocated`,
      operationId: input.operationId,
      publication: { kind: "persist_intent", expectedPhase: null },
      canonicalBytes: allocatedBytes.bytes,
      contentDigest: allocatedBytes.sha256,
      tempParentId: input.intentsParentId,
      tempParentEvidence: input.intentsParentEvidence,
      tempLeaf: atomicIntentTempLeaf(input.operationId, "allocated"),
      stableParentId: input.intentsParentId,
      stableParentEvidence: input.intentsParentEvidence,
      stableLeaf: `${input.operationId}.json`,
    },
  );
  let stableIntent: AtomicPublishedIntentRecord = {
    intent: baseIntent,
    objectId: allocatedRecord.stableObjectId,
    evidence: allocatedRecord.stableEvidence,
  };
  phases.push("allocated");

  await reserveAtomicBudget(
    controller,
    `${input.flightNonce}:reserve:scratch`,
    input.operationId,
    "scratch_entries",
    2,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${input.flightNonce}:reserve:entries`,
    input.operationId,
    "payload_entries",
    entries.length + 1,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${input.flightNonce}:reserve:bytes`,
    input.operationId,
    "payload_bytes",
    0,
    totalBytes,
  );

  const wrapper = atomicCreatedObservation(
    await runAtomicRequest(
      controller,
      `${input.flightNonce}:wrapper:create`,
      {
        kind: "create_and_pin_wrapper",
        operationId: input.operationId,
        role: "wrapper",
        parentId: input.bundlesParentId,
        leaf: input.operationId,
        parentEvidenceDigest: input.bundlesParentEvidence.evidenceDigest,
        mode: 448,
        expectedAbsence: true,
      },
      [input.bundlesParentId],
    ),
  );
  await syncAtomicHeld(
    controller,
    `${input.flightNonce}:wrapper:parent-sync`,
    input.operationId,
    "fsync_parent",
    "bundles_parent",
    input.bundlesParentId,
    input.bundlesParentEvidence,
  );
  const buildingIntent: AtomicPublishIntentV1 = {
    ...stableIntent.intent,
    phase: "building",
    wrapper: {
      dev: wrapper.evidence.dev,
      ino: wrapper.evidence.ino,
      mode: 448,
    },
  };
  stableIntent = await createAndReplaceAtomicIntent(
    controller,
    `${input.flightNonce}:building`,
    stableIntent,
    buildingIntent,
    input.intentsParentId,
    input.intentsParentEvidence,
  );
  phases.push("building");

  const source = atomicCreatedObservation(
    await runAtomicRequest(
      controller,
      `${input.flightNonce}:source:create`,
      {
        kind: "create_and_pin_directory",
        operationId: input.operationId,
        role: "private_source",
        parentId: wrapper.handleId,
        leaf: "payload",
        parentEvidenceDigest: wrapper.evidence.evidenceDigest,
        mode: 448,
        expectedAbsence: true,
      },
      [wrapper.handleId],
    ),
  );
  await syncAtomicHeld(
    controller,
    `${input.flightNonce}:source:parent-sync`,
    input.operationId,
    "fsync_parent",
    "wrapper",
    wrapper.handleId,
    wrapper.evidence,
  );

  const constructed = new Map<string, AtomicConstructedEntry>();
  constructed.set("", {
    path: "",
    type: "directory",
    objectId: source.handleId,
    evidence: source.evidence,
    mode: 448,
    size: 0,
    contentSha256: null,
  });
  for (const [cursor, entry] of entries.entries()) {
    await runAtomicRequest(
      controller,
      `${input.flightNonce}:populate:${cursor}`,
      {
        kind: "populate_payload_entry",
        operationId: input.operationId,
        rootId: source.handleId,
        cursor,
        evidenceDigest: sha256(
          JSON.stringify({
            path: entry.path,
            type: entry.type,
            size: entry.type === "file" ? entry.bytes.byteLength : 0,
          }),
        ),
      },
      [source.handleId],
    );
    const separator = entry.path.lastIndexOf("/");
    const parentPath = separator === -1 ? "" : entry.path.slice(0, separator);
    const leaf = separator === -1 ? entry.path : entry.path.slice(separator + 1);
    const parent = constructed.get(parentPath);
    if (parent === undefined || parent.type !== "directory") {
      throw atomicFailure("atomic profile construction parent is invalid");
    }
    const created = atomicCreatedObservation(
      await runAtomicRequest(
        controller,
        `${input.flightNonce}:entry:${cursor}:create`,
        {
          kind:
            entry.type === "directory"
              ? "create_and_pin_directory"
              : "create_and_pin_file",
          operationId: input.operationId,
          role: "payload_entry",
          parentId: parent.objectId,
          leaf,
          parentEvidenceDigest: parent.evidence.evidenceDigest,
          mode: entry.type === "directory" ? 448 : 384,
          expectedAbsence: true,
        },
        [parent.objectId],
      ),
    );
    await syncAtomicHeld(
      controller,
      `${input.flightNonce}:entry:${cursor}:parent-sync`,
      input.operationId,
      "fsync_parent",
      parentPath === "" ? "private_source" : "payload_entry",
      parent.objectId,
      parent.evidence,
    );
    if (entry.type === "directory") {
      constructed.set(entry.path, {
        path: entry.path,
        type: "directory",
        objectId: created.handleId,
        evidence: created.evidence,
        mode: 448,
        size: 0,
        contentSha256: null,
      });
      continue;
    }
    for (
      let offset = 0;
      offset < entry.bytes.byteLength;
      offset += ATOMIC_OBSERVATION_BYTE_LIMIT
    ) {
      const chunk = entry.bytes.subarray(
        offset,
        Math.min(entry.bytes.byteLength, offset + ATOMIC_OBSERVATION_BYTE_LIMIT),
      );
      if (
        entry.sourceFileId !== undefined &&
        entry.sourceEvidence !== undefined
      ) {
        const sourceHash = await runAtomicRequest(
          controller,
          `${input.flightNonce}:entry:${cursor}:source-hash:${offset}`,
          {
            kind: "hash_content_chunk",
            operationId: input.operationId,
            objectId: entry.sourceFileId,
            offset,
            byteLength: chunk.byteLength,
            evidenceDigest: entry.sourceEvidence.evidenceDigest,
          },
          [entry.sourceFileId],
        );
        const sourceContent = sourceHash.observations.find(
          observation => observation.kind === "content_observed",
        );
        if (
          sourceContent?.kind !== "content_observed" ||
          sourceContent.contentDigest !== sha256(chunk)
        ) {
          throw atomicFailure("atomic profile copy source proof is invalid");
        }
      }
      await runAtomicRequest(
        controller,
        `${input.flightNonce}:entry:${cursor}:write:${offset}`,
        {
          kind:
            entry.sourceFileId === undefined
              ? "write_file_chunk"
              : "copy_payload_chunk",
          operationId: input.operationId,
          sourceFileId: entry.sourceFileId ?? null,
          inlineBytes: entry.sourceFileId === undefined ? chunk : null,
          destinationFileId: created.handleId,
          offset,
          byteLength: chunk.byteLength,
          expectedChunkSha256: sha256(chunk),
          expectedResultSha256: sha256(
            entry.bytes.subarray(0, offset + chunk.byteLength),
          ),
        },
        entry.sourceFileId === undefined
          ? [created.handleId]
          : [entry.sourceFileId, created.handleId],
      );
      const hashed = await runAtomicRequest(
        controller,
        `${input.flightNonce}:entry:${cursor}:hash:${offset}`,
        {
          kind: "hash_content_chunk",
          operationId: input.operationId,
          objectId: created.handleId,
          offset,
          byteLength: chunk.byteLength,
          evidenceDigest: created.evidence.evidenceDigest,
        },
        [created.handleId],
      );
      const content = hashed.observations.find(
        observation => observation.kind === "content_observed",
      );
      if (
        content?.kind !== "content_observed" ||
        content.contentDigest !== sha256(chunk)
      ) {
        throw atomicFailure("atomic profile content proof is invalid");
      }
    }
    await syncAtomicHeld(
      controller,
      `${input.flightNonce}:entry:${cursor}:file-sync`,
      input.operationId,
      "fsync_file",
      "payload_entry",
      created.handleId,
      created.evidence,
    );
    const contentSha256 = sha256(entry.bytes);
    constructed.set(entry.path, {
      path: entry.path,
      type: "file",
      objectId: created.handleId,
      evidence: created.evidence,
      mode: 384,
      size: entry.bytes.byteLength,
      contentSha256,
    });
  }

  const postorderDirectories = [...constructed.values()]
    .filter(
      (entry): entry is AtomicConstructedEntry & { type: "directory" } =>
        entry.type === "directory",
    )
    .sort((left, right) => {
      const depth =
        right.path.split("/").length - left.path.split("/").length;
      return depth !== 0 ? depth : rawCompare(left.path, right.path);
    });
  for (const [index, directory] of postorderDirectories.entries()) {
    await syncAtomicHeld(
      controller,
      `${input.flightNonce}:directory-sync:${index}`,
      input.operationId,
      "fsync_directory",
      directory.path === "" ? "private_source" : "payload_entry",
      directory.objectId,
      directory.evidence,
    );
  }

  const canonicalEntries = [...constructed.values()]
    .map(entry =>
      Object.freeze({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        size: entry.size,
        sha256: entry.contentSha256,
      }),
    )
    .sort((left, right) => rawCompare(left.path, right.path));
  for (const [cursor, entry] of canonicalEntries.entries()) {
    const entryDigest = sha256(JSON.stringify(entry));
    const canonical = await runAtomicRequest(
      controller,
      `${input.flightNonce}:canonical:${cursor}`,
      {
        kind: "canonicalize_tree_step",
        operationId: input.operationId,
        rootId: source.handleId,
        cursor,
        evidenceDigest: entryDigest,
      },
      [source.handleId],
    );
    const content = canonical.observations.find(
      observation => observation.kind === "content_observed",
    );
    if (
      content?.kind !== "content_observed" ||
      content.contentDigest !== entryDigest
    ) {
      throw atomicFailure("atomic profile canonical step is invalid");
    }
  }
  const closeOrder = [...constructed.values()]
    .filter(entry => entry.path !== "")
    .sort((left, right) => {
      const leftDepth = left.path.split("/").length;
      const rightDepth = right.path.split("/").length;
      if (leftDepth !== rightDepth) return rightDepth - leftDepth;
      if (left.type !== right.type) return left.type === "file" ? -1 : 1;
      return rawCompare(left.path, right.path);
    });
  for (const [index, entry] of closeOrder.entries()) {
    await runAtomicRequest(
      controller,
      `${input.flightNonce}:close-entry:${index}`,
      {
        kind: "close_handle",
        operationId: input.operationId,
        role: "payload_entry",
        objectId: entry.objectId,
        cursor: 0,
        byteLength: 0,
        expected:
          entry.type === "file" && entry.contentSha256 !== null
            ? atomicContentEvidence(
                entry.evidence,
                entry.size,
                entry.contentSha256,
              )
            : entry.evidence,
      },
      [entry.objectId],
    );
    await releaseAtomicBudget(
      controller,
      `${input.flightNonce}:release-entry:${index}`,
      input.operationId,
      "payload_entries",
      1,
      0,
    );
    if (entry.type === "file" && entry.size > 0) {
      await releaseAtomicBudget(
        controller,
        `${input.flightNonce}:release-entry-bytes:${index}`,
        input.operationId,
        "payload_bytes",
        0,
        entry.size,
      );
    }
  }
  const canonicalJson = JSON.stringify({
    version: 1,
    entries: canonicalEntries,
  });
  const tree: CanonicalProfileTreeEvidence = Object.freeze({
    canonicalJson,
    checksum: sha256(canonicalJson),
    byteSize: totalBytes,
    maxMtimeMs: 0,
    entries: Object.freeze(
      [...constructed.values()]
        .sort((left, right) => rawCompare(left.path, right.path))
        .map(entry =>
          Object.freeze({
            path: entry.path,
            type: entry.type,
            dev: entry.evidence.dev,
            ino: entry.evidence.ino,
            nlink: "1",
            mode: entry.mode,
            size: entry.size,
            sha256: entry.contentSha256,
          }),
        ),
    ),
    fileCount: entries.filter(entry => entry.type === "file").length,
  });
  const readyIntent: AtomicPublishIntentV1 = {
    ...stableIntent.intent,
    phase: "ready",
    privateSource: {
      dev: source.evidence.dev,
      ino: source.evidence.ino,
      mode: 448,
      checksum: tree.checksum,
      byteSize: tree.byteSize,
    },
  };
  stableIntent = await createAndReplaceAtomicIntent(
    controller,
    `${input.flightNonce}:ready`,
    stableIntent,
    readyIntent,
    input.intentsParentId,
    input.intentsParentEvidence,
  );
  phases.push("ready");

  for (const [label, role, objectId, evidence] of [
    ["source-parent", "wrapper", wrapper.handleId, wrapper.evidence],
    [
      "target-parent",
      input.targetParentRole,
      input.targetParentId,
      input.targetParentEvidence,
    ],
  ] as const) {
    await runAtomicRequest(
      controller,
      `${input.flightNonce}:native:${label}:revalidate`,
      {
        kind: "revalidate_handle",
        operationId: input.operationId,
        role,
        objectId,
        cursor: 0,
        byteLength: 0,
        expected: evidence,
      },
      [objectId],
    );
    await runAtomicRequest(
      controller,
      `${input.flightNonce}:native:${label}:statfs`,
      {
        kind: "statfs_parent",
        operationId: input.operationId,
        role,
        objectId,
        expected: evidence,
      },
      [objectId],
    );
  }
  const native = await runAtomicRequest(
    controller,
    `${input.flightNonce}:native`,
    {
      kind: "native_no_replace",
      operationId: input.operationId,
      move: "profile_publish",
      sourceParentId: wrapper.handleId,
      sourceId: source.handleId,
      sourceLeaf: "payload",
      targetParentId: input.targetParentId,
      targetLeaf: (
        input.target as Extract<
          PublicationTargetV1,
          { kind: "profile" | "profile_state" }
        >
      ).leaf,
      expectedSource: source.evidence,
      expectedTarget: { absent: true },
      evidenceDigest: sha256(
        JSON.stringify({
          source: source.evidence.evidenceDigest,
          target: input.targetParentEvidence.evidenceDigest,
        }),
      ),
    },
    [wrapper.handleId, source.handleId, input.targetParentId],
  );
  const classification = native.classification;
  if (
    classification === null ||
    (classification.outcome !== "published" &&
      classification.outcome !== "conflict")
  ) {
    throw atomicFailure("atomic profile publication was not classified");
  }
  const locations = native.observations.find(
    (
      observation,
    ): observation is Extract<
      AtomicEffectObservationV1,
      { kind: "locations_observed"; requestKind: "native_no_replace" }
    > =>
      observation.kind === "locations_observed" &&
      observation.requestKind === "native_no_replace",
  );
  if (locations === undefined) {
    throw atomicFailure("atomic profile location proof is missing");
  }
  if (classification.outcome === "published") {
    if (
      locations.targetObjectId === null ||
      locations.target.evidence === null ||
      locations.target.state !== "match"
    ) {
      throw atomicFailure("atomic profile target proof is invalid");
    }
    await proveAtomicPrivateProfileTree(
      flight,
      locations.targetObjectId,
      locations.target.evidence,
      "public_target",
      tree,
    );
  } else {
    if (
      locations.sourceObjectId === null ||
      locations.source.evidence === null ||
      locations.source.state !== "match"
    ) {
      throw atomicFailure("atomic profile source proof is invalid");
    }
    await proveAtomicPrivateProfileTree(
      flight,
      locations.sourceObjectId,
      locations.source.evidence,
      "private_source",
      tree,
    );
  }
  const durableClassification: NonNullable<
    AtomicPublishIntentV1["classification"]
  > = {
    outcome: classification.outcome,
    nativeCode: classification.nativeCode,
    sourceMatches: classification.sourceMatches,
    targetMatches: classification.targetMatches,
    targetOther: classification.targetOther,
    evidenceDigest: sha256(
      JSON.stringify({
        precheck: classification.nativePrecheckEvidenceDigest,
        locations: classification.locationEvidenceDigest,
      }),
    ),
  };
  const classifiedIntent: AtomicPublishIntentV1 = {
    ...stableIntent.intent,
    phase: "classified",
    classification: durableClassification,
  };
  stableIntent = await createAndReplaceAtomicIntent(
    controller,
    `${input.flightNonce}:classified`,
    stableIntent,
    classifiedIntent,
    input.intentsParentId,
    input.intentsParentEvidence,
  );
  phases.push("classified");

  let targetObjectId: FlightSemanticId | null = null;
  let targetEvidence: AtomicObjectEvidenceV1 | null = null;
  if (classification.outcome === "published") {
    if (
      locations.targetObjectId === null ||
      locations.target.evidence === null
    ) {
      throw atomicFailure("atomic profile target proof is invalid");
    }
    targetObjectId = locations.targetObjectId;
    targetEvidence = locations.target.evidence;
    await syncAtomicHeld(
      controller,
      `${input.flightNonce}:renamed:source-parent`,
      input.operationId,
      "fsync_parent",
      "wrapper",
      wrapper.handleId,
      wrapper.evidence,
    );
    await syncAtomicHeld(
      controller,
      `${input.flightNonce}:renamed:target-parent`,
      input.operationId,
      "fsync_parent",
      input.targetParentRole,
      input.targetParentId,
      input.targetParentEvidence,
    );
    stableIntent = await createAndReplaceAtomicIntent(
      controller,
      `${input.flightNonce}:renamed`,
      stableIntent,
      {
        ...stableIntent.intent,
        phase: "renamed",
      },
      input.intentsParentId,
      input.intentsParentEvidence,
    );
    phases.push("renamed");
  }

  const cleanupEntries: CleanupIdentityEntryV1[] = [...constructed.values()]
    .sort((left, right) => {
      const leftDepth = left.path === "" ? 0 : left.path.split("/").length;
      const rightDepth =
        right.path === "" ? 0 : right.path.split("/").length;
      return rightDepth !== leftDepth
        ? rightDepth - leftDepth
        : rawCompare(left.path, right.path);
    })
    .map(entry => ({
      index: 0,
      scope: "private_profile_payload",
      path: entry.path === "" ? "payload" : `payload/${entry.path}`,
      type: entry.type,
      dev: entry.evidence.dev,
      ino: entry.evidence.ino,
      mode: entry.mode,
      size: entry.size,
      contentSha256: entry.contentSha256,
    }));
  if (classification.outcome === "published") {
    cleanupEntries.push(...(input.cleanupEntries ?? []));
  }
  cleanupEntries.sort((left, right) => {
    const leftDepth = left.path.split("/").length;
    const rightDepth = right.path.split("/").length;
    return rightDepth !== leftDepth
      ? rightDepth - leftDepth
      : rawCompare(left.path, right.path);
  });
  for (const [index, entry] of cleanupEntries.entries()) {
    cleanupEntries[index] = Object.freeze({ ...entry, index });
  }
  const manifest: CleanupIdentityManifestV1 = {
    version: 1,
    operationId: input.operationId,
    binding: input.binding,
    targetLocatorDigest: publicationTargetLocatorDigest(input.target),
    entries: cleanupEntries,
  };
  const manifestBytes = encodeCleanupIdentityManifest(manifest);
  const manifestTransitionId = atomicTransitionId(
    input.operationId,
    "manifest",
  );
  const manifestTempLeaf =
    `${input.operationId}.identities.${manifestTransitionId}.tmp` as
      `${string}.identities.${string}.tmp`;
  const manifestBinding: NonNullable<
    AtomicPublishIntentV1["identityManifest"]
  > = {
    phase: "planned",
    filename: `${input.operationId}.identities.json`,
    tempFilename: manifestTempLeaf,
    sha256: manifestBytes.sha256,
    entryCount: manifestBytes.entryCount,
    byteSize: manifestBytes.bytes.byteLength,
    dev: null,
    ino: null,
    mode: null,
  };
  stableIntent = await createAndReplaceAtomicIntent(
    controller,
    `${input.flightNonce}:manifest-planned`,
    stableIntent,
    {
      ...stableIntent.intent,
      phase: "manifest_planned",
      identityManifest: manifestBinding,
    },
    input.intentsParentId,
    input.intentsParentEvidence,
  );
  phases.push("manifest_planned");
  const publishedManifest = await runAtomicCreateAndPersistRecordProtocol(
    controller,
    {
      flightNonce: `${input.flightNonce}:manifest`,
      operationId: input.operationId,
      publication: {
        kind: "persist_manifest",
        expectedPhase: "manifest_planned",
      },
      canonicalBytes: manifestBytes.bytes,
      contentDigest: manifestBytes.sha256,
      tempParentId: input.intentsParentId,
      tempParentEvidence: input.intentsParentEvidence,
      tempLeaf: manifestTempLeaf,
      stableParentId: input.intentsParentId,
      stableParentEvidence: input.intentsParentEvidence,
      stableLeaf: `${input.operationId}.identities.json`,
    },
  );
  stableIntent = await createAndReplaceAtomicIntent(
    controller,
    `${input.flightNonce}:manifest-published`,
    stableIntent,
    {
      ...stableIntent.intent,
      phase: "manifest_published",
      identityManifest: {
        ...manifestBinding,
        phase: "published",
        dev: publishedManifest.stableEvidence.dev,
        ino: publishedManifest.stableEvidence.ino,
        mode: 384,
      },
    },
    input.intentsParentId,
    input.intentsParentEvidence,
  );
  phases.push("manifest_published");
  const manifestIndexByPath = new Map(
    cleanupEntries
      .filter(entry => entry.scope === "private_profile_payload")
      .map(entry => [entry.path, entry.index] as const),
  );
  const cleanupObjects = [...constructed.values()]
    .map(entry => {
      const path = entry.path === "" ? "payload" : `payload/${entry.path}`;
      const index = manifestIndexByPath.get(path);
      if (index === undefined) {
        throw atomicFailure("atomic cleanup object is missing from manifest");
      }
      return Object.freeze({
        index,
        path,
        type: entry.type,
        role:
          entry.path === ""
            ? ("private_source" as const)
            : ("payload_entry" as const),
        objectId: entry.objectId,
        evidence:
          entry.type === "file" && entry.contentSha256 !== null
            ? atomicContentEvidence(
                entry.evidence,
                entry.size,
                entry.contentSha256,
              )
            : entry.evidence,
      });
    })
    .sort((left, right) => left.index - right.index);
  return Object.freeze({
    outcome: classification.outcome,
    phases: Object.freeze(phases),
    tree,
    targetObjectId,
    targetEvidence,
    wrapperObjectId: wrapper.handleId,
    wrapperEvidence: wrapper.evidence,
    privateSourceObjectId: source.handleId,
    privateSourceEvidence: source.evidence,
    intentObjectId: stableIntent.objectId,
    intentEvidence: stableIntent.evidence,
    manifestObjectId: publishedManifest.stableObjectId,
    manifestEvidence: publishedManifest.stableEvidence,
    cleanupManifest: manifest,
    cleanupObjects: Object.freeze(cleanupObjects),
  });
}

export type AtomicHeldGenerationPublicationResultV1 = Readonly<{
  generation: BoundProfileGeneration;
  tree: CanonicalProfileTreeEvidence;
  operationId: string;
}>;

export type AtomicPreReadyHeldGenerationPublicationResultV1 = Readonly<{
  sealed: true;
  tree: CanonicalProfileTreeEvidence;
  operationId: string;
}>;

type AtomicTransitionSourceSnapshot = Readonly<{
  tree: CanonicalProfileTreeEvidence;
  entries: readonly AtomicPrivateProfileEntryV1[];
  cleanupEntries: readonly CleanupIdentityEntryV1[];
}>;

function atomicUuidFromDigest(value: string): string {
  const bytes = sha256(value).slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = "8";
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readAtomicTransitionFile(
  record: GenerationCapabilityRecord,
  entry: ProfileTreeEvidence,
): Promise<Buffer> {
  if (entry.type !== "file") {
    throw atomicFailure("atomic transition source entry is not a file");
  }
  const size = Number(entry.stat.size);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > PROFILE_FILE_MAX_BYTES
  ) {
    throw atomicFailure("atomic transition source file is out of bounds");
  }
  const opened = await openEvidenceEntry(record, entry);
  try {
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(ATOMIC_OBSERVATION_BYTE_LIMIT, size - offset);
      const read = await call(
        record.root.anchored.admission,
        "atomic-transition-source-read",
        () => opened.handle.read(bytes, offset, length, offset),
      );
      if (read.bytesRead <= 0) {
        throw atomicFailure("atomic transition source file was truncated");
      }
      offset += read.bytesRead;
    }
    if (sha256(bytes) !== entry.sha256) {
      throw atomicFailure("atomic transition source content changed");
    }
    return bytes;
  } finally {
    await closeAllDirect(opened.owned);
  }
}

async function snapshotAtomicTransitionSource(
  record: GenerationCapabilityRecord,
): Promise<AtomicTransitionSourceSnapshot> {
  const synced = await syncAndCanonicalizeGenerationRecord(record);
  if (synced.fileCount === 0 || synced.byteSize === 0) {
    throw atomicFailure("writer profile schema is empty");
  }
  const first = await heldProfileHash(record);
  const entries: AtomicPrivateProfileEntryV1[] = [];
  for (const entry of [...first.evidence].sort((left, right) =>
    rawCompare(left.path, right.path),
  )) {
    if (entry.path === "") continue;
    if (entry.type === "directory") {
      entries.push(Object.freeze({ path: entry.path, type: "directory" }));
    } else {
      entries.push(
        Object.freeze({
          path: entry.path,
          type: "file",
          bytes: await readAtomicTransitionFile(record, entry),
        }),
      );
    }
  }
  const final = await heldProfileHash(record);
  if (
    first.checksum !== final.checksum ||
    first.byteSize !== final.byteSize ||
    first.evidence.length !== final.evidence.length ||
    first.evidence.some((entry, index) => {
      const current = final.evidence[index];
      return (
        current === undefined ||
        entry.path !== current.path ||
        entry.type !== current.type ||
        !sameLeafIdentity(entry.stat, current.stat) ||
        entry.sha256 !== current.sha256
      );
    })
  ) {
    throw atomicFailure("atomic transition source changed during copy");
  }
  const cleanupEntries = [...first.evidence]
    .sort((left, right) => {
      const leftDepth = left.path === "" ? 0 : left.path.split("/").length;
      const rightDepth =
        right.path === "" ? 0 : right.path.split("/").length;
      return rightDepth !== leftDepth
        ? rightDepth - leftDepth
        : rawCompare(left.path, right.path);
    })
    .map((entry, index) =>
      Object.freeze({
        index,
        scope: "public_source" as const,
        path: entry.path === "" ? "source" : `source/${entry.path}`,
        type: entry.type,
        dev: String(entry.stat.dev),
        ino: String(entry.stat.ino),
        mode: lowModeBigint(entry.stat.mode),
        size: entry.type === "file" ? Number(entry.stat.size) : 0,
        contentSha256: entry.sha256,
      }),
    );
  return Object.freeze({
    tree: publicTreeEvidence(first),
    entries: Object.freeze(entries),
    cleanupEntries: Object.freeze(cleanupEntries),
  });
}

async function openAtomicExpectedChild(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  operationId: string,
  role: AtomicObjectRoleV1,
  parentId: FlightSemanticId,
  leaf: string,
  expected: AtomicObjectEvidenceV1,
  flags: Extract<
    AtomicEffectRequestDraftV1,
    { kind: "open_pin_handle" }
  >["flags"],
): Promise<Extract<
  AtomicEffectObservationV1,
  { kind: "existing_handle_pinned" }
>> {
  const result = await runAtomicRequest(
    controller,
    flightNonce,
    {
      kind: "open_pin_handle",
      operationId,
      role,
      parentId,
      leaf,
      flags,
      expected,
    },
    [parentId],
  );
  const opened = result.observations.find(
    (
      observation,
    ): observation is Extract<
      AtomicEffectObservationV1,
      { kind: "existing_handle_pinned" }
    > => observation.kind === "existing_handle_pinned",
  );
  if (opened === undefined) {
    throw atomicFailure("atomic transition child was not pinned");
  }
  return opened;
}

async function getAtomicInitialControlChild(
  controller: AtomicEffectControllerV1,
  parentId: FlightSemanticId,
  role: "bundles_parent" | "intents_parent",
  leaf: "bundles" | "intents",
  flightNonce: string,
  operationId: string,
): Promise<
  Readonly<{
    handleId: FlightSemanticId;
    evidence: AtomicObjectEvidenceV1;
  }>
> {
  const flight = requireAtomicFlight(controller);
  const record = [...flight.records].find(
    value =>
      value.parentId === parentId &&
      value.role === role &&
      value.leaf === leaf &&
      value.operationId === operationId,
  );
  const handleId =
    record === undefined ? undefined : flight.recordTokens.get(record);
  if (record === undefined || handleId === undefined) {
    void flightNonce;
    throw atomicFailure("atomic initial control authority is unavailable");
  }
  return Object.freeze({ handleId, evidence: record.evidence });
}

function atomicIntentRecord(
  controller: AtomicEffectControllerV1,
  objectId: FlightSemanticId,
  evidence: AtomicObjectEvidenceV1,
): AtomicPublishedIntentRecord {
  const flight = requireAtomicFlight(controller);
  const record = resolveAtomicRecord(flight, objectId);
  const intent = flight.intents.get(objectId as object);
  if (
    record.role !== "intent_stable" ||
    intent === undefined ||
    !sameAtomicEvidence(record.evidence, evidence)
  ) {
    throw atomicFailure("atomic transition intent authority is invalid");
  }
  return { intent, objectId, evidence };
}

async function closeAndReleaseAtomicRecord(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  operationId: string,
  role: AtomicObjectRoleV1,
  objectId: FlightSemanticId,
  evidence: AtomicObjectEvidenceV1,
  reservation:
    | Readonly<{
        kind: AtomicReservationKind;
        count: number;
        byteSize: number;
      }>
    | undefined,
): Promise<void> {
  await runAtomicRequest(
    controller,
    `${flightNonce}:close`,
    {
      kind: "close_handle",
      operationId,
      role,
      objectId,
      cursor: 0,
      byteLength: 0,
      expected: evidence,
    },
    [objectId],
  );
  if (reservation !== undefined) {
    await releaseAtomicBudget(
      controller,
      `${flightNonce}:release`,
      operationId,
      reservation.kind,
      reservation.count,
      reservation.byteSize,
    );
  }
}

function detachAtomicRecord(
  flight: AtomicEffectFlightRecord,
  objectId: FlightSemanticId,
): AtomicHeldRecord {
  const record = resolveAtomicRecord(flight, objectId);
  flight.registry.delete(objectId as object);
  flight.recordTokens.delete(record);
  flight.records.delete(record);
  flight.contentStates.delete(objectId as object);
  const reservation = flight.recordReservations.get(objectId as object);
  if (reservation !== undefined) {
    flight.recordReservations.delete(objectId as object);
    flight.claimedCounts[reservation] -= 1;
    if (record.role === "intent_stable") flight.activeStableIntents -= 1;
    if (atomicRoleIsRecoveryRecord(record.role)) flight.recoveryRecords -= 1;
  }
  const bytes = flight.recordByteReservations.get(objectId as object);
  if (bytes !== undefined) {
    flight.recordByteReservations.delete(objectId as object);
    flight.claimedBytes[bytes.reservation] -= bytes.byteSize;
    if (bytes.scope !== null) {
      flight.claimedScopedBytes[bytes.scope] -= bytes.byteSize;
    }
  }
  return record;
}

function adoptAtomicPublishedGeneration(
  controller: AtomicEffectControllerV1,
  targetObjectId: FlightSemanticId,
  locator: Omit<ProfileGenerationLocator, "openMode">,
  sealOperationId: string | null = null,
): BoundProfileGeneration | null {
  const flight = requireAtomicFlight(controller);
  const generation = resolveAtomicRecord(flight, targetObjectId);
  const state = requireAtomicParentRecord(flight, generation);
  const profile = requireAtomicParentRecord(flight, state);
  const profiles = requireAtomicParentRecord(flight, profile);
  if (
    generation.role !== "public_target" ||
    generation.leaf !== locator.generationId ||
    state.role !== "public_target" ||
    state.leaf !== locator.state ||
    profile.role !== "public_target" ||
    profile.leaf !== locator.profileId ||
    profiles.role !== "profiles_parent" ||
    profiles.leaf !== "profiles"
  ) {
    throw atomicFailure("atomic adopted generation ancestry is invalid");
  }
  for (const record of [profiles, profile, state, generation]) {
    if (!record.owned) {
      throw atomicFailure("atomic adopted generation is not transferable");
    }
    assertAtomicHeldChain(flight, record);
  }
  const generationRecord = detachAtomicRecord(flight, targetObjectId);
  const stateId = generation.parentId!;
  const stateRecord = detachAtomicRecord(flight, stateId);
  const profileId = state.parentId!;
  const profileRecord = detachAtomicRecord(flight, profileId);
  const profilesId = profile.parentId!;
  const profilesRecord = detachAtomicRecord(flight, profilesId);
  const token = generationToken({
    state: "live",
    root: flight.root,
    locator: Object.freeze({ ...locator, openMode: "existing" }),
    profiles: profilesRecord.handle,
    profile: profileRecord.handle,
    stateHandle: stateRecord.handle,
    generation: generationRecord.handle,
    identities: Object.freeze([
      profilesRecord.stat,
      profileRecord.stat,
      stateRecord.stat,
      generationRecord.stat,
    ]),
    acceptingOperations: true,
    activeOperations: 0,
    operationTail: Promise.resolve(),
    drainWaiters: new Set(),
    attachmentCount: 0,
  });
  if (sealOperationId === null) return token;
  if (flight.root.sealedGenerations.has(sealOperationId)) {
    throw atomicFailure("atomic sealed generation already exists");
  }
  flight.root.sealedGenerations.set(sealOperationId, token);
  return null;
}

export type AtomicHeldGenerationTransitionInputV1 = Readonly<{
  binding: ReadyProfileRootBinding;
  kind: "prepare" | "finalize";
  authorityDigest: string;
  adoptionMode?: "runtime";
}>;

export type AtomicPreReadyHeldGenerationTransitionInputV1 = Readonly<{
  binding: ReadyProfileRootBinding;
  kind: "prepare" | "finalize";
  authorityDigest: string;
  adoptionMode: "pre_ready";
}>;

function atomicEvidenceFromManifestEntry(
  entry: CleanupIdentityEntryV1,
): AtomicObjectEvidenceV1 {
  const value = {
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    size: entry.size,
    contentSha256: entry.contentSha256,
  };
  return Object.freeze({
    ...value,
    evidenceDigest: sha256(JSON.stringify(value)),
  });
}

async function replaceAtomicCleanupCursor(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  stable: AtomicPublishedIntentRecord,
  suffix: NonNullable<AtomicPublishIntentV1["cleanup"]>["suffix"],
  nextIndex: number,
  intentsParentId: FlightSemanticId,
  intentsParentEvidence: AtomicObjectEvidenceV1,
): Promise<AtomicPublishedIntentRecord> {
  if (stable.intent.cleanup === null) {
    throw atomicFailure("atomic cleanup cursor authority is missing");
  }
  return createAndReplaceAtomicIntent(
    controller,
    flightNonce,
    stable,
    {
      ...stable.intent,
      cleanup: {
        ...stable.intent.cleanup,
        suffix,
        nextIndex,
      },
    },
    intentsParentId,
    intentsParentEvidence,
  );
}

type AtomicProtectedOpenedRemovalV1 = Readonly<{
  objectId: FlightSemanticId;
  evidence: AtomicObjectEvidenceV1;
  role: "payload_entry" | "private_deletion";
}>;

function atomicProtectedCleanupObservation<
  T extends
    | AtomicProtectedCleanupObservationV1
    | AtomicProtectedCleanupTerminalObservationV1,
>(observation: T): T {
  return (
    filesystemTestContext
      .getStore()
      ?.atomicProtectedCleanupObservation?.(observation) ?? observation
  ) as T;
}

async function executeAtomicProtectedBudgetRelease(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  operationId: string,
  reservation: AtomicReservationKind,
  count: number,
  byteSize: number,
  byteReservation:
    | "payload_bytes"
    | "manifest_bytes"
    | "other_metadata_bytes",
): Promise<string> {
  const countResult = await runAtomicRequest(
    controller,
    `${flightNonce}:count`,
    {
      kind: "release_budget",
      operationId,
      reservation,
      count,
      byteSize: 0,
    },
    [],
  );
  const countCompleted = countResult.observations.find(
    observation => observation.kind === "effect_completed",
  );
  if (countCompleted === undefined) {
    throw atomicFailure("atomic protected count release is unobserved");
  }
  let evidenceDigest = countCompleted.evidenceDigest;
  if (byteSize > 0) {
    const bytesResult = await runAtomicRequest(
      controller,
      `${flightNonce}:bytes`,
      {
        kind: "release_budget",
        operationId,
        reservation: byteReservation,
        count: 0,
        byteSize,
      },
      [],
    );
    const bytesCompleted = bytesResult.observations.find(
      observation => observation.kind === "effect_completed",
    );
    if (bytesCompleted === undefined) {
      throw atomicFailure("atomic protected byte release is unobserved");
    }
    evidenceDigest = bytesCompleted.evidenceDigest;
  }
  return evidenceDigest;
}

async function executeAtomicProtectedCleanupEntry(
  controller: AtomicEffectControllerV1,
  stable: AtomicPublishedIntentRecord,
  intents: Readonly<{
    handleId: FlightSemanticId;
    evidence: AtomicObjectEvidenceV1;
  }>,
  state: AtomicProtectedCleanupStateV1,
  entry: AtomicProtectedCleanupEntryV1,
  persistCursor: boolean,
  cursorAuthority: "source_deletion" | "cleanup",
): Promise<Readonly<{
  stable: AtomicPublishedIntentRecord;
  state: AtomicProtectedCleanupStateV1;
}>> {
  let step = beginAtomicProtectedCleanupEntry(state, entry);
  const persist = step.action;
  if (persist?.kind !== "persist_cursor") {
    throw atomicFailure("atomic protected cleanup cursor action is invalid");
  }
  let nextStable = stable;
  if (persistCursor) {
    if (cursorAuthority === "source_deletion") {
      if (stable.intent.sourceDeletion === null) {
        throw atomicFailure("atomic protected source cursor is missing");
      }
      nextStable = await createAndReplaceAtomicIntent(
        controller,
        `${entry.operationId}:protected-source-cursor:${persist.nextIndex}`,
        stable,
        {
          ...stable.intent,
          sourceDeletion: {
            ...stable.intent.sourceDeletion,
            nextIndex: persist.nextIndex,
          },
        },
        intents.handleId,
        intents.evidence,
      );
    } else {
      nextStable = await replaceAtomicCleanupCursor(
        controller,
        `${entry.operationId}:protected-cleanup-cursor:${persist.nextIndex}`,
        stable,
        persist.suffix,
        persist.nextIndex,
        intents.handleId,
        intents.evidence,
      );
    }
  } else if (
    (cursorAuthority === "source_deletion"
      ? stable.intent.sourceDeletion?.nextIndex
      : stable.intent.cleanup?.nextIndex) !== persist.nextIndex
  ) {
    throw atomicFailure("atomic protected replay cursor is invalid");
  }
  step = advanceAtomicProtectedCleanupEntry(
    step.state,
    atomicProtectedCleanupObservation({
      kind: "cursor_persisted",
      operationId: persist.operationId,
      manifestSha256: persist.manifestSha256,
      suffix: persist.suffix,
      previousCursor: persist.previousCursor,
      nextIndex: persist.nextIndex,
      entryDigest: persist.entryDigest,
      evidenceDigest: nextStable.evidence.evidenceDigest,
    }),
  );
  const remove = step.action;
  if (remove?.kind !== "remove") {
    throw atomicFailure("atomic protected cleanup remove action is invalid");
  }
  const removed = await runAtomicRequest(
    controller,
    `${entry.operationId}:protected-source-remove:${remove.cursor}`,
    remove.request,
    [entry.parentId, entry.objectId],
  );
  const removal = removed.observations.find(
    (
      observation,
    ): observation is Extract<
      AtomicEffectObservationV1,
      { kind: "removal_observed" }
    > => observation.kind === "removal_observed",
  );
  if (removal === undefined) {
    throw atomicFailure("atomic protected cleanup removal is unobserved");
  }
  step = advanceAtomicProtectedCleanupEntry(
    step.state,
    atomicProtectedCleanupObservation({
      kind: "removal_observed",
      operationId: remove.operationId,
      manifestSha256: remove.manifestSha256,
      cursor: remove.cursor,
      entryDigest: remove.entryDigest,
      requestKind: entry.requestKind,
      objectId: entry.objectId,
      removedEvidence: removal.removedEvidence,
      state: removal.state,
      parentSynced: removal.parentSynced,
      evidenceDigest: removal.evidenceDigest,
    }),
  );
  const close = step.action;
  if (close?.kind !== "close") {
    throw atomicFailure("atomic protected cleanup close action is invalid");
  }
  const closed = await runAtomicRequest(
    controller,
    `${entry.operationId}:protected-source-close:${close.cursor}`,
    close.request,
    [entry.objectId],
  );
  const closedEffect = closed.observations.find(
    observation => observation.kind === "effect_completed",
  );
  if (closedEffect === undefined) {
    throw atomicFailure("atomic protected cleanup close is unobserved");
  }
  step = advanceAtomicProtectedCleanupEntry(
    step.state,
    atomicProtectedCleanupObservation({
      kind: "handle_closed",
      operationId: close.operationId,
      manifestSha256: close.manifestSha256,
      cursor: close.cursor,
      entryDigest: close.entryDigest,
      role: entry.role,
      objectId: entry.objectId,
      closedEvidence: entry.expected,
      evidenceDigest: closedEffect.evidenceDigest,
    }),
  );
  const release = step.action;
  if (release?.kind !== "release") {
    throw atomicFailure("atomic protected cleanup release action is invalid");
  }
  const releaseDigest = await executeAtomicProtectedBudgetRelease(
    controller,
    `${entry.operationId}:protected-source-release:${release.cursor}`,
    entry.operationId,
    entry.release.reservation,
    entry.release.count,
    entry.release.byteSize,
    entry.scope === "intent_temp" ? "other_metadata_bytes" : "payload_bytes",
  );
  step = advanceAtomicProtectedCleanupEntry(
    step.state,
    atomicProtectedCleanupObservation({
      kind: "reservation_released",
      operationId: release.operationId,
      manifestSha256: release.manifestSha256,
      cursor: release.cursor,
      entryDigest: release.entryDigest,
      reservation: entry.release.reservation,
      count: entry.release.count,
      byteSize: entry.release.byteSize,
      evidenceDigest: releaseDigest,
    }),
  );
  if (step.action !== null || step.state.stage !== "ready") {
    throw atomicFailure("atomic protected cleanup entry is incomplete");
  }
  return Object.freeze({ stable: nextStable, state: step.state });
}

async function executeAtomicProtectedSourceCleanup(
  controller: AtomicEffectControllerV1,
  stable: AtomicPublishedIntentRecord,
  intents: Readonly<{
    handleId: FlightSemanticId;
    evidence: AtomicObjectEvidenceV1;
  }>,
  manifest: CleanupIdentityManifestV1,
  openedByPath: Map<string, AtomicProtectedOpenedRemovalV1>,
  privateRootParentId: FlightSemanticId,
): Promise<Readonly<{
  stable: AtomicPublishedIntentRecord;
  privateRootRemoved: boolean;
}>> {
  const deletion = stable.intent.sourceDeletion;
  if (deletion?.phase !== "removing") {
    throw atomicFailure("atomic protected source cleanup is not removing");
  }
  const entries = manifest.entries.filter(
    entry => entry.scope === "public_source",
  );
  if (
    deletion.entryCount !== entries.length ||
    deletion.nextIndex > entries.length
  ) {
    throw atomicFailure("atomic protected source cleanup count is invalid");
  }
  const entryDigests = entries.map((entry, index) =>
    sha256(JSON.stringify({ index, entry })),
  );
  const stateAt = (cursor: number) =>
    createAtomicProtectedCleanupState({
      operationId: stable.intent.operationId,
      manifestSha256: stable.intent.identityManifest!.sha256,
      entryCount: entries.length,
      entryCounts: {
        privateSourceEntries: entries.length,
        wrapperTemps: 0,
        intentTemps: 0,
      },
      entryDigests,
      cursor,
      suffix: "private_source_entries",
    });
  let currentStable = stable;
  let privateRootRemoved = false;
  const execute = async (
    logicalIndex: number,
    persistCursor: boolean,
  ): Promise<void> => {
    const manifestEntry = entries[logicalIndex]!;
    const opened = openedByPath.get(manifestEntry.path);
    if (opened === undefined) {
      if (persistCursor) {
        throw atomicFailure("atomic protected cleanup entry is missing");
      }
      return;
    }
    const isRoot = manifestEntry.path === "source";
    const separator = manifestEntry.path.lastIndexOf("/");
    const parentId = isRoot
      ? privateRootParentId
      : openedByPath.get(
          manifestEntry.path.slice(0, separator),
        )?.objectId;
    if (parentId === undefined) {
      throw atomicFailure("atomic protected cleanup parent is missing");
    }
    const result = await executeAtomicProtectedCleanupEntry(
      controller,
      currentStable,
      intents,
      stateAt(logicalIndex),
      {
        operationId: stable.intent.operationId,
        manifestSha256: stable.intent.identityManifest!.sha256,
        index: logicalIndex,
        suffix: "private_source_entries",
        scope: "public_source",
        entryDigest: entryDigests[logicalIndex]!,
        requestKind: isRoot
          ? "remove_root"
          : manifestEntry.type === "file"
            ? "remove_file"
            : "remove_directory",
        role: opened.role,
        parentId,
        leaf: isRoot
          ? deletion.privateDeletionLeaf
          : manifestEntry.path.slice(separator + 1),
        objectId: opened.objectId,
        expected: opened.evidence,
        release: {
          reservation: isRoot
            ? "scratch_entries"
            : "payload_entries",
          count: 1,
          byteSize:
            manifestEntry.type === "file" ? manifestEntry.size : 0,
        },
      },
      persistCursor,
      "source_deletion",
    );
    currentStable = result.stable;
    openedByPath.delete(manifestEntry.path);
    if (isRoot) privateRootRemoved = true;
  };
  if (deletion.nextIndex > 0) {
    await execute(deletion.nextIndex - 1, false);
  }
  for (
    let logicalIndex = deletion.nextIndex;
    logicalIndex < entries.length;
    logicalIndex += 1
  ) {
    await execute(logicalIndex, true);
  }
  return Object.freeze({ stable: currentStable, privateRootRemoved });
}

function atomicProtectedStableCleanupRecord(
  role: "manifest_stable" | "intent_stable",
  parentId: FlightSemanticId,
  operationId: string,
  objectId: FlightSemanticId,
  expected: AtomicObjectEvidenceV1,
) {
  return Object.freeze({
    role,
    parentId,
    leaf:
      role === "manifest_stable"
        ? `${operationId}.identities.json`
        : `${operationId}.json`,
    objectId,
    expected,
    release: Object.freeze({
      reservation: "stable_files" as const,
      count: 1 as const,
      byteSize: expected.size,
    }),
  });
}

async function executeAtomicProtectedCleanupTerminal(
  controller: AtomicEffectControllerV1,
  cleanup: AtomicProtectedCleanupStateV1,
  stable: AtomicPublishedIntentRecord,
  intents: Readonly<{
    handleId: FlightSemanticId;
    evidence: AtomicObjectEvidenceV1;
  }>,
  manifest: Readonly<{
    objectId: FlightSemanticId;
    evidence: AtomicObjectEvidenceV1;
  }>,
): Promise<void> {
  let currentStable = stable;
  let step: AtomicProtectedCleanupTerminalStepV1 =
    beginAtomicProtectedCleanupTerminal(cleanup, {
      manifest: atomicProtectedStableCleanupRecord(
        "manifest_stable",
        intents.handleId,
        stable.intent.operationId,
        manifest.objectId,
        manifest.evidence,
      ),
      intent: atomicProtectedStableCleanupRecord(
        "intent_stable",
        intents.handleId,
        stable.intent.operationId,
        stable.objectId,
        stable.evidence,
      ),
    });
  if (stable.intent.phase === "manifest_deleting") {
    step = advanceAtomicProtectedCleanupTerminal(
      step.state,
      atomicProtectedCleanupObservation({
        kind: "phase_persisted",
        operationId: stable.intent.operationId,
        manifestSha256: cleanup.manifestSha256,
        cursor: cleanup.cursor,
        phase: "manifest_deleting",
        intent: atomicProtectedStableCleanupRecord(
          "intent_stable",
          intents.handleId,
          stable.intent.operationId,
          stable.objectId,
          stable.evidence,
        ),
        evidenceDigest: stable.evidence.evidenceDigest,
      }),
    );
  } else if (stable.intent.phase !== "discarding") {
    throw atomicFailure("atomic protected terminal phase is invalid");
  }
  for (let count = 0; count < 8 && step.action !== null; count += 1) {
    const action = step.action;
    let observation: AtomicProtectedCleanupTerminalObservationV1;
    if (action.kind === "persist_phase") {
      const nextIntent =
        action.phase === "manifest_deleting"
          ? {
              ...currentStable.intent,
              phase: "manifest_deleting" as const,
              identityManifest: {
                ...currentStable.intent.identityManifest!,
                phase: "deleting" as const,
              },
              cleanup: {
                ...currentStable.intent.cleanup!,
                phase: "cleaned" as const,
              },
            }
          : {
              ...currentStable.intent,
              phase: "cleaned" as const,
            };
      currentStable = await createAndReplaceAtomicIntent(
        controller,
        `${action.operationId}:protected-terminal:${action.phase}`,
        currentStable,
        nextIntent,
        intents.handleId,
        intents.evidence,
      );
      observation = {
        kind: "phase_persisted",
        operationId: action.operationId,
        manifestSha256: action.manifestSha256,
        cursor: action.cursor,
        phase: action.phase,
        intent: atomicProtectedStableCleanupRecord(
          "intent_stable",
          intents.handleId,
          action.operationId,
          currentStable.objectId,
          currentStable.evidence,
        ),
        evidenceDigest: currentStable.evidence.evidenceDigest,
      };
    } else if (action.kind === "remove_stable") {
      const result = await runAtomicRequest(
        controller,
        `${action.operationId}:protected-terminal:remove:${action.role}`,
        action.request,
        [action.request.stableParentId, action.request.stableObjectId],
      );
      const removed = result.observations.find(
        (
          candidate,
        ): candidate is Extract<
          AtomicEffectObservationV1,
          { kind: "removal_observed" }
        > => candidate.kind === "removal_observed",
      );
      if (removed === undefined) {
        throw atomicFailure("atomic protected stable removal is unobserved");
      }
      observation = {
        kind: "removal_observed",
        operationId: action.operationId,
        manifestSha256: action.manifestSha256,
        cursor: action.cursor,
        role: action.role,
        objectId: action.request.stableObjectId,
        removedEvidence: removed.removedEvidence,
        state: removed.state,
        parentSynced: removed.parentSynced,
        evidenceDigest: removed.evidenceDigest,
      };
    } else if (action.kind === "close_stable") {
      const result = await runAtomicRequest(
        controller,
        `${action.operationId}:protected-terminal:close:${action.role}`,
        action.request,
        [action.request.objectId],
      );
      const closed = result.observations.find(
        candidate => candidate.kind === "effect_completed",
      );
      if (closed === undefined) {
        throw atomicFailure("atomic protected stable close is unobserved");
      }
      observation = {
        kind: "handle_closed",
        operationId: action.operationId,
        manifestSha256: action.manifestSha256,
        cursor: action.cursor,
        role: action.role,
        objectId: action.request.objectId,
        closedEvidence: action.request.expected,
        evidenceDigest: closed.evidenceDigest,
      };
    } else {
      const evidenceDigest = await executeAtomicProtectedBudgetRelease(
        controller,
        `${action.operationId}:protected-terminal:release:${action.role}`,
        action.operationId,
        action.request.reservation,
        action.request.count,
        action.request.byteSize,
        action.role === "manifest_stable"
          ? "manifest_bytes"
          : "other_metadata_bytes",
      );
      observation = {
        kind: "reservation_released",
        operationId: action.operationId,
        manifestSha256: action.manifestSha256,
        cursor: action.cursor,
        role: action.role,
        reservation: action.request.reservation,
        count: action.request.count as 1,
        byteSize: action.request.byteSize,
        evidenceDigest,
      };
    }
    step = advanceAtomicProtectedCleanupTerminal(
      step.state,
      atomicProtectedCleanupObservation(observation),
    );
  }
  if (step.action !== null || step.state.stage !== "complete") {
    throw atomicFailure("atomic protected terminal cleanup is incomplete");
  }
}

async function discardAtomicConflictedPublication(
  controller: AtomicEffectControllerV1,
  operationId: string,
  published: AtomicPrivateProfilePublicationResultV1,
  bundles: Readonly<{
    handleId: FlightSemanticId;
    evidence: AtomicObjectEvidenceV1;
  }>,
  intents: Readonly<{
    handleId: FlightSemanticId;
    evidence: AtomicObjectEvidenceV1;
  }>,
): Promise<void> {
  const flight = requireAtomicFlight(controller);
  let stable = atomicIntentRecord(
    controller,
    published.intentObjectId,
    published.intentEvidence,
  );
  const manifestSha256 = stable.intent.identityManifest?.sha256;
  if (
    published.outcome !== "conflict" ||
    manifestSha256 === undefined ||
    manifestSha256 !== published.manifestEvidence.contentSha256
  ) {
    throw atomicFailure("atomic conflict cleanup authority is invalid");
  }
  try {
  const cleanupDigest = sha256(
    JSON.stringify({
      operationId,
      manifestSha256,
      outcome: "conflict",
    }),
  );
  stable = await createAndReplaceAtomicIntent(
    controller,
    `${operationId}:conflict-discarding`,
    stable,
    {
      ...stable.intent,
      phase: "discarding",
      cleanup: {
        phase: "discarding",
        outcome: "conflict",
        evidenceDigest: cleanupDigest,
        suffix: "private_source_entries",
        nextIndex: 0,
      },
    },
    intents.handleId,
    intents.evidence,
  );

  const children = published.cleanupObjects.filter(
    entry => entry.role === "payload_entry",
  );
  const childBytes = children.reduce(
    (total, entry) =>
      total + (entry.type === "file" ? entry.evidence.size : 0),
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:conflict-entry-reserve`,
    operationId,
    "payload_entries",
    children.length,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:conflict-byte-reserve`,
    operationId,
    "payload_bytes",
    0,
    childBytes,
  );
  const openedByPath = new Map<
    string,
    Readonly<{
      objectId: FlightSemanticId;
      evidence: AtomicObjectEvidenceV1;
      role: "payload_entry" | "private_source";
    }>
  >();
  openedByPath.set("payload", {
    objectId: published.privateSourceObjectId,
    evidence: published.privateSourceEvidence,
    role: "private_source",
  });
  for (const entry of [...children].sort((left, right) => {
    const depth =
      left.path.split("/").length - right.path.split("/").length;
    return depth !== 0 ? depth : rawCompare(left.path, right.path);
  })) {
    const separator = entry.path.lastIndexOf("/");
    const parent = openedByPath.get(entry.path.slice(0, separator));
    if (parent === undefined) {
      throw atomicFailure("atomic conflict cleanup parent is missing");
    }
    const opened = await openAtomicExpectedChild(
      controller,
      `${operationId}:conflict-open:${entry.index}`,
      operationId,
      "payload_entry",
      parent.objectId,
      entry.path.slice(separator + 1),
      entry.evidence,
      entry.type === "directory"
        ? "directory_nofollow"
        : "file_read_nofollow",
    );
    openedByPath.set(entry.path, {
      objectId: opened.handleId,
      evidence: opened.evidence,
      role: "payload_entry",
    });
  }

  const cleanupEntryDigests = published.cleanupObjects.map(
    (entry, index) =>
      sha256(
        JSON.stringify({
          index,
          entry: {
            index: entry.index,
            path: entry.path,
            type: entry.type,
            role: entry.role,
            evidence: entry.evidence,
          },
        }),
      ),
  );
    for (const [logicalIndex, entry] of
      published.cleanupObjects.entries()) {
      const opened = openedByPath.get(entry.path);
      if (opened === undefined) {
        throw atomicFailure("atomic conflict cleanup object is not pinned");
      }
      const isRoot = entry.role === "private_source";
      const separator = entry.path.lastIndexOf("/");
      const parentId = isRoot
        ? published.wrapperObjectId
        : openedByPath.get(entry.path.slice(0, separator))?.objectId;
      if (parentId === undefined) {
        throw atomicFailure(
          "atomic conflict cleanup parent is not pinned",
        );
      }
      const result = await executeAtomicProtectedCleanupEntry(
        controller,
        stable,
        intents,
        createAtomicProtectedCleanupState({
          operationId,
          manifestSha256,
          entryCount: published.cleanupObjects.length,
          entryCounts: {
            privateSourceEntries: published.cleanupObjects.length,
            wrapperTemps: 0,
            intentTemps: 0,
          },
          entryDigests: cleanupEntryDigests,
          cursor: logicalIndex,
          suffix: "private_source_entries",
        }),
        {
          operationId,
          manifestSha256,
          index: logicalIndex,
          suffix: "private_source_entries",
          scope: "private_profile_payload",
          entryDigest: cleanupEntryDigests[logicalIndex]!,
          requestKind: isRoot
            ? "remove_root"
            : entry.type === "file"
              ? "remove_file"
              : "remove_directory",
          role: opened.role,
          parentId,
          leaf: isRoot
            ? "payload"
            : entry.path.slice(separator + 1),
          objectId: opened.objectId,
          expected: opened.evidence,
          release: {
            reservation: isRoot
              ? "scratch_entries"
              : "payload_entries",
            count: 1,
            byteSize:
              entry.type === "file" ? entry.evidence.size : 0,
          },
        },
        true,
        "cleanup",
      );
      stable = result.stable;
    }

    for (const suffix of ["private_source_root", "wrapper_temps"] as const) {
      stable = await replaceAtomicCleanupCursor(
        controller,
        `${operationId}:conflict-cleanup:${suffix}`,
        stable,
        suffix,
        0,
        intents.handleId,
        intents.evidence,
      );
    }
    for (
      let cursor = 0;
      cursor < published.cleanupManifest.entries.length;
      cursor += 1
    ) {
      stable = await replaceAtomicCleanupCursor(
        controller,
        `${operationId}:conflict-cleanup:wrapper-temp:${cursor + 1}`,
        stable,
        "wrapper_temps",
        cursor + 1,
        intents.handleId,
        intents.evidence,
      );
    }
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:conflict-cleanup:wrapper-root`,
      stable,
      "wrapper_root",
      0,
      intents.handleId,
      intents.evidence,
    );
    await runAtomicRequest(
      controller,
      `${operationId}:conflict-remove-wrapper`,
      {
        kind: "remove_root",
        operationId,
        role: "wrapper",
        parentId: bundles.handleId,
        leaf: operationId,
        objectId: published.wrapperObjectId,
        expected: published.wrapperEvidence,
        manifestSha256,
        cursor: 0,
      },
      [bundles.handleId, published.wrapperObjectId],
    );
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:conflict-close-wrapper`,
      operationId,
      "wrapper",
      published.wrapperObjectId,
      published.wrapperEvidence,
      { kind: "scratch_entries", count: 1, byteSize: 0 },
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:conflict-cleanup:intent-temps`,
      stable,
      "intent_temps",
      0,
      intents.handleId,
      intents.evidence,
    );
    for (
      let cursor = 0;
      cursor < published.cleanupManifest.entries.length;
      cursor += 1
    ) {
      stable = await replaceAtomicCleanupCursor(
        controller,
        `${operationId}:conflict-cleanup:intent-temp:${cursor + 1}`,
        stable,
        "intent_temps",
        cursor + 1,
        intents.handleId,
        intents.evidence,
      );
    }
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:conflict-cleanup:done`,
      stable,
      "done",
      0,
      intents.handleId,
      intents.evidence,
    );
    await executeAtomicProtectedCleanupTerminal(
      controller,
      createAtomicProtectedCleanupState({
        operationId,
        manifestSha256,
        entryCount: published.cleanupObjects.length,
        entryCounts: {
          privateSourceEntries: published.cleanupObjects.length,
          wrapperTemps: 0,
          intentTemps: 0,
        },
        entryDigests: cleanupEntryDigests,
        cursor: published.cleanupObjects.length,
        suffix: "done",
      }),
      stable,
      {
        handleId: intents.handleId,
        evidence: intents.evidence,
      },
      {
        objectId: published.manifestObjectId,
        evidence: published.manifestEvidence,
      },
    );
  } catch (error) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw error;
  }
}

type AtomicManifestPlannedRecoveredAuthorityV1 = Readonly<{
  intent: AtomicPublishIntentV1;
  intentObjectId: FlightSemanticId;
  intentEvidence: AtomicObjectEvidenceV1;
  manifest: CleanupIdentityManifestV1;
  manifestObjectId: FlightSemanticId;
  manifestEvidence: AtomicObjectEvidenceV1;
}>;

export type AtomicManifestPlannedRecoveryResultV1 = Readonly<{
  authority: AtomicManifestPlannedRecoveredAuthorityV1;
  reconstructedManifestBytes: Uint8Array;
}>;

type AtomicManifestPlannedFileSnapshot = Readonly<{
  bytes: Uint8Array;
  evidence: AtomicObjectEvidenceV1;
}>;

async function snapshotAtomicManifestPlannedFile(
  flight: AtomicEffectFlightRecord,
  parent: AtomicHeldRecord,
  leaf: string,
  maximumBytes: number,
  point: string,
): Promise<AtomicManifestPlannedFileSnapshot | null> {
  let handle: FileHandle | null = null;
  try {
    let before: BigIntStats;
    try {
      before = await atomicAwait(flight, [parent], `${point}:lstat`, () =>
        fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.uid !== atomicEffectiveUid() ||
      lowModeBigint(before.mode) !== 0o600 ||
      before.size <= 0n ||
      before.size > BigInt(maximumBytes)
    ) {
      throw atomicFailure("atomic recovery metadata file is invalid");
    }
    handle = await atomicAwait(flight, [parent], `${point}:open`, () =>
      fs.open(
        procPath(parent.handle, leaf),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ),
    );
    const afterOpen = await atomicAwait(
      flight,
      [parent],
      `${point}:fstat`,
      () => handle!.stat({ bigint: true }),
    );
    assertAtomicStat(
      before,
      afterOpen,
      "atomic recovery metadata binding changed",
    );
    const bytes = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await atomicAwait(
        flight,
        [parent],
        `${point}:read`,
        () => handle!.read(bytes, offset, bytes.byteLength - offset, offset),
      );
      if (read.bytesRead <= 0) {
        throw atomicFailure("atomic recovery metadata read was truncated");
      }
      offset += read.bytesRead;
    }
    const afterRead = await atomicAwait(
      flight,
      [parent],
      `${point}:restat`,
      () => handle!.stat({ bigint: true }),
    );
    const rebound = await atomicAwait(
      flight,
      [parent],
      `${point}:relstat`,
      () => fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
    );
    assertAtomicStat(
      before,
      afterRead,
      "atomic recovery metadata changed during read",
    );
    assertAtomicStat(
      before,
      rebound,
      "atomic recovery metadata location changed during read",
    );
    return Object.freeze({
      bytes,
      evidence: atomicEvidenceFromStat(before, sha256(bytes)),
    });
  } finally {
    if (handle !== null) {
      const retained = handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        `${point}:close`,
        () => retained.close(),
        () => {
          handle = null;
        },
      );
    }
  }
}

type AtomicRecoveryDirectory = Readonly<{
  handle: FileHandle;
  stat: BigIntStats;
}>;

type AtomicPinnedAuthority = Readonly<{
  handleId: FlightSemanticId;
  evidence: AtomicObjectEvidenceV1;
}>;

async function openAtomicRecoveryDirectory(
  flight: AtomicEffectFlightRecord,
  parent: AtomicHeldRecord | AtomicRecoveryDirectory,
  leaf: string,
  expected:
    | Readonly<{ dev: string; ino: string; mode: 448 }>
    | null,
  point: string,
): Promise<AtomicRecoveryDirectory> {
  const records =
    "role" in parent ? ([parent] as const) : ([] as const);
  const before = await atomicAwait(flight, records, `${point}:lstat`, () =>
    fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
  );
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.nlink <= 0n ||
    before.uid !== atomicEffectiveUid() ||
    lowModeBigint(before.mode) !== 0o700 ||
    (expected !== null &&
      (String(before.dev) !== expected.dev ||
        String(before.ino) !== expected.ino ||
        expected.mode !== 448))
  ) {
    throw atomicFailure("atomic recovery directory binding is invalid");
  }
  let handle: FileHandle | null = await atomicAwait(
    flight,
    records,
    `${point}:open`,
    () =>
      fs.open(
        procPath(parent.handle, leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
  );
  try {
    const after = await atomicAwait(
      flight,
      records,
      `${point}:fstat`,
      () => handle!.stat({ bigint: true }),
    );
    assertAtomicStat(
      before,
      after,
      "atomic recovery directory binding changed",
    );
    const result = Object.freeze({ handle, stat: after });
    handle = null;
    return result;
  } finally {
    if (handle !== null) await closeRaw(handle, `${point}:failed-close`);
  }
}

async function closeAtomicRecoveryDirectories(
  directories: readonly AtomicRecoveryDirectory[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const [index, directory] of [...directories].reverse().entries()) {
    try {
      await closeRaw(directory.handle, `atomic-recovery-directory-${index}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "atomic recovery directory close is unverified",
    );
  }
}

async function atomicRecoveryTreeEntries(
  flight: AtomicEffectFlightRecord,
  root: AtomicRecoveryDirectory,
  scope: "private_profile_payload" | "private_canary_proof" | "public_source",
  prefix: string,
  expectedChecksum: string | null,
  expectedByteSize: number | null,
): Promise<readonly CleanupIdentityEntryV1[]> {
  const budget = new Budget(MAX_RECONCILIATION_REFERENCES);
  budget.take();
  const first = await hashProfileTreeAt(
    flight.root.anchored,
    root.handle,
    budget,
  );
  const second = await validateProfileEvidenceRaw(
    flight.root.anchored,
    root.handle,
    first.evidence,
  );
  if (
    (expectedChecksum !== null && first.checksum !== expectedChecksum) ||
    (expectedByteSize !== null && first.byteSize !== expectedByteSize) ||
    second.checksum !== first.checksum ||
    second.byteSize !== first.byteSize
  ) {
    throw atomicFailure("atomic recovery profile tree binding changed");
  }
  return Object.freeze(
    [...first.evidence]
      .sort((left, right) => {
        const leftDepth = left.path === "" ? 0 : left.path.split("/").length;
        const rightDepth =
          right.path === "" ? 0 : right.path.split("/").length;
        return rightDepth !== leftDepth
          ? rightDepth - leftDepth
          : rawCompare(left.path, right.path);
      })
      .map(entry =>
        Object.freeze({
          index: 0,
          scope,
          path: entry.path === "" ? prefix : `${prefix}/${entry.path}`,
          type: entry.type,
          dev: String(entry.stat.dev),
          ino: String(entry.stat.ino),
          mode: lowModeBigint(entry.stat.mode),
          size: entry.type === "file" ? Number(entry.stat.size) : 0,
          contentSha256: entry.sha256,
        }),
      ),
  );
}

function atomicPrivateRecoverySource(intent: AtomicPublishIntentV1): Readonly<{
  leaf: string;
  prefix: string;
  scope: "private_profile_payload" | "private_canary_proof";
}> {
  if (intent.kind === "canary") {
    if (intent.target.kind !== "canary_parent" || intent.canaryProof === null) {
      throw atomicFailure("atomic canary recovery source is invalid");
    }
    return Object.freeze({
      leaf: intent.canaryProof.sourceLeaf,
      prefix: intent.canaryProof.sourceLeaf,
      scope: "private_canary_proof" as const,
    });
  }
  if (intent.target.kind === "canary_parent" || intent.canaryProof !== null) {
    throw atomicFailure("atomic profile recovery source is invalid");
  }
  return Object.freeze({
    leaf: "payload",
    prefix: "payload",
    scope: "private_profile_payload" as const,
  });
}

async function atomicBuildingRecoveryIntentTemps(
  flight: AtomicEffectFlightRecord,
  intents: AtomicHeldRecord,
  intent: AtomicPublishIntentV1,
): Promise<readonly CleanupIdentityEntryV1[]> {
  const expectedBuilding = encodeAtomicPublishIntent({
    ...intent,
    phase: "building",
    prepublicationAbort: null,
    cleanup: null,
    identityManifest: null,
  });
  const entries = await atomicAwait(
    flight,
    [intents],
    "atomic-building-recovery-intent-temp-list",
    () => fs.readdir(procPath(intents.handle), { withFileTypes: true }),
  );
  const recovered: CleanupIdentityEntryV1[] = [];
  for (const entry of entries) {
    const leaf = parseAtomicPublicationIntentLeaf(entry.name);
    if (
      leaf.operationId !== intent.operationId ||
      leaf.kind !== "intent_temp"
    ) {
      continue;
    }
    if (!entry.isFile() || leaf.phase !== "building") {
      throw atomicFailure("atomic building recovery intent temp is invalid");
    }
    const snapshot = await snapshotAtomicManifestPlannedFile(
      flight,
      intents,
      entry.name,
      ATOMIC_MAX_SCRATCH_OTHER_METADATA_BYTES,
      "atomic-building-recovery-intent-temp",
    );
    if (
      snapshot === null ||
      snapshot.evidence.contentSha256 !== expectedBuilding.sha256 ||
      snapshot.bytes.byteLength !== expectedBuilding.bytes.byteLength
    ) {
      throw atomicFailure("atomic building recovery intent temp is invalid");
    }
    recovered.push(
      Object.freeze({
        index: 0,
        scope: "intent_temp" as const,
        path: entry.name,
        type: "file" as const,
        dev: snapshot.evidence.dev,
        ino: snapshot.evidence.ino,
        mode: snapshot.evidence.mode,
        size: snapshot.evidence.size,
        contentSha256: snapshot.evidence.contentSha256,
      }),
    );
  }
  return Object.freeze(
    recovered.sort((left, right) => rawCompare(left.path, right.path)),
  );
}

async function reconstructAtomicManifestPlannedBytes(
  controller: AtomicEffectControllerV1,
  intent: AtomicPublishIntentV1,
  bundles: AtomicPinnedAuthority,
  intents: AtomicPinnedAuthority,
  profilesParentId: FlightSemanticId,
): Promise<Readonly<{
  manifest: CleanupIdentityManifestV1;
  bytes: Uint8Array;
}>> {
  if (
    intent.phase !== "manifest_planned" ||
    intent.identityManifest?.phase !== "planned" ||
    intent.wrapper === null ||
    (intent.prepublicationAbort === null &&
      (intent.privateSource === null || intent.classification === null)) ||
    (intent.target.kind === "canary_parent" &&
      (intent.kind !== "canary" ||
        intent.prepublicationAbort?.from !== "building"))
  ) {
    throw atomicFailure("atomic recovery intent is not reconstructible");
  }
  const privateRecoverySource = atomicPrivateRecoverySource(intent);
  const flight = requireAtomicFlight(controller);
  const bundlesRecord = resolveAtomicRecord(flight, bundles.handleId);
  const intentsRecord = resolveAtomicRecord(flight, intents.handleId);
  const profilesRecord = resolveAtomicRecord(flight, profilesParentId);
  const opened: AtomicRecoveryDirectory[] = [];
  try {
    const wrapper = await openAtomicRecoveryDirectory(
      flight,
      bundlesRecord,
      intent.operationId,
      intent.wrapper,
      "atomic-recovery-wrapper",
    );
    opened.push(wrapper);
    let payload: AtomicRecoveryDirectory | null;
    if (intent.classification?.outcome === "published") {
      if (intent.privateSource === null) {
        throw atomicFailure("atomic recovery published source is missing");
      }
      if (intent.target.kind === "profile") {
        payload = await openAtomicRecoveryDirectory(
          flight,
          profilesRecord,
          intent.target.leaf,
          intent.privateSource,
          "atomic-recovery-target-profile",
        );
        opened.push(payload);
      } else if (intent.target.kind === "profile_state") {
        const profile = await openAtomicRecoveryDirectory(
          flight,
          profilesRecord,
          intent.target.profileId,
          null,
          "atomic-recovery-target-profile-parent",
        );
        opened.push(profile);
        const state = await openAtomicRecoveryDirectory(
          flight,
          profile,
          intent.target.state,
          intent.target.parent,
          "atomic-recovery-target-state",
        );
        opened.push(state);
        payload = await openAtomicRecoveryDirectory(
          flight,
          state,
          intent.target.leaf,
          intent.privateSource,
          "atomic-recovery-target-generation",
        );
        opened.push(payload);
      } else {
        throw atomicFailure("atomic recovery published target is invalid");
      }
    } else {
      try {
        payload = await openAtomicRecoveryDirectory(
          flight,
          wrapper,
          privateRecoverySource.leaf,
          intent.privateSource,
          "atomic-recovery-private-payload",
        );
        opened.push(payload);
      } catch (error) {
        if (
          intent.prepublicationAbort?.from === "building" &&
          intent.privateSource === null &&
          isNodeError(error) &&
          error.code === "ENOENT"
        ) {
          payload = null;
        } else {
          throw error;
        }
      }
    }
    const entries: CleanupIdentityEntryV1[] =
      payload === null
        ? []
        : [
            ...(await atomicRecoveryTreeEntries(
              flight,
              payload,
              privateRecoverySource.scope,
              privateRecoverySource.prefix,
              intent.privateSource?.checksum ?? null,
              intent.privateSource?.byteSize ?? null,
            )),
          ];
    if (intent.prepublicationAbort?.from === "building") {
      entries.push(
        ...(await atomicBuildingRecoveryIntentTemps(
          flight,
          intentsRecord,
          intent,
        )),
      );
    }
    if (
      intent.classification?.outcome === "published" &&
      intent.publicSource !== null
    ) {
      const sourceProfile = await openAtomicRecoveryDirectory(
        flight,
        profilesRecord,
        intent.publicSource.profileId,
        null,
        "atomic-recovery-source-profile",
      );
      opened.push(sourceProfile);
      const sourceState = await openAtomicRecoveryDirectory(
        flight,
        sourceProfile,
        intent.publicSource.state,
        null,
        "atomic-recovery-source-state",
      );
      opened.push(sourceState);
      const source = await openAtomicRecoveryDirectory(
        flight,
        sourceState,
        intent.publicSource.generationId,
        {
          dev: intent.publicSource.dev,
          ino: intent.publicSource.ino,
          mode: intent.publicSource.mode,
        },
        "atomic-recovery-public-source",
      );
      opened.push(source);
      entries.push(
        ...(await atomicRecoveryTreeEntries(
          flight,
          source,
          "public_source",
          "source",
          intent.publicSource.checksum,
          intent.publicSource.byteSize,
        )),
      );
    }
    entries.sort((left, right) => {
      if (left.scope === "intent_temp" && right.scope !== "intent_temp") {
        return 1;
      }
      if (left.scope !== "intent_temp" && right.scope === "intent_temp") {
        return -1;
      }
      const leftDepth = left.path.split("/").length;
      const rightDepth = right.path.split("/").length;
      return rightDepth !== leftDepth
        ? rightDepth - leftDepth
        : rawCompare(left.path, right.path);
    });
    const indexed = entries.map((entry, index) =>
      Object.freeze({ ...entry, index }),
    );
    const manifest: CleanupIdentityManifestV1 = Object.freeze({
      version: 1,
      operationId: intent.operationId,
      binding: intent.binding,
      targetLocatorDigest: publicationTargetLocatorDigest(intent.target),
      entries: Object.freeze(indexed),
    });
    const encoded = encodeCleanupIdentityManifest(manifest);
    if (
      encoded.sha256 !== intent.identityManifest.sha256 ||
      encoded.bytes.byteLength !== intent.identityManifest.byteSize ||
      encoded.entryCount !== intent.identityManifest.entryCount
    ) {
      throw atomicFailure("atomic recovery reconstructed manifest is invalid");
    }
    validateCleanupIdentityManifestBinding(intent, manifest);
    return Object.freeze({
      manifest,
      bytes: Uint8Array.from(encoded.bytes),
    });
  } finally {
    await closeAtomicRecoveryDirectories(opened);
  }
}

async function createAtomicRecoveredManifestTemp(
  controller: AtomicEffectControllerV1,
  operationId: string,
  parentId: FlightSemanticId,
  parentEvidence: AtomicObjectEvidenceV1,
  leaf: string,
  bytes: Uint8Array,
): Promise<Readonly<{
  objectId: FlightSemanticId;
  evidence: AtomicObjectEvidenceV1;
}>> {
  const created = atomicCreatedObservation(
    await runAtomicRequest(
      controller,
      `${operationId}:manifest-recovery:create`,
      {
        kind: "create_and_pin_temp_file",
        operationId,
        role: "manifest_temp",
        parentId,
        leaf,
        parentEvidenceDigest: parentEvidence.evidenceDigest,
        mode: 384,
        expectedAbsence: true,
      },
      [parentId],
    ),
  );
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += ATOMIC_OBSERVATION_BYTE_LIMIT
  ) {
    const chunk = bytes.subarray(
      offset,
      Math.min(bytes.byteLength, offset + ATOMIC_OBSERVATION_BYTE_LIMIT),
    );
    await runAtomicRequest(
      controller,
      `${operationId}:manifest-recovery:write:${offset}`,
      {
        kind: "write_file_chunk",
        operationId,
        sourceFileId: null,
        inlineBytes: chunk,
        destinationFileId: created.handleId,
        offset,
        byteLength: chunk.byteLength,
        expectedChunkSha256: sha256(chunk),
        expectedResultSha256: sha256(
          bytes.subarray(0, offset + chunk.byteLength),
        ),
      },
      [created.handleId],
    );
  }
  await syncAtomicHeld(
    controller,
    `${operationId}:manifest-recovery:sync`,
    operationId,
    "fsync_file",
    "manifest_temp",
    created.handleId,
    created.evidence,
  );
  return Object.freeze({
    objectId: created.handleId,
    evidence: atomicContentEvidence(
      created.evidence,
      bytes.byteLength,
      sha256(bytes),
    ),
  });
}

function atomicManifestRecoveryObservationBinding(
  operationId: string,
  manifest: NonNullable<AtomicPublishIntentV1["identityManifest"]>,
  intentsParentId: FlightSemanticId,
): Pick<
  AtomicManifestPlannedRecoveryObservationV1,
  | "operationId"
  | "manifestSha256"
  | "manifestByteSize"
  | "entryCount"
  | "intentsParentId"
  | "tempLeaf"
  | "stableLeaf"
> {
  return {
    operationId,
    manifestSha256: manifest.sha256,
    manifestByteSize: manifest.byteSize,
    entryCount: manifest.entryCount,
    intentsParentId,
    tempLeaf: manifest.tempFilename,
    stableLeaf: manifest.filename,
  };
}

function atomicManifestRecoveryLocation(
  leaf: string,
  opened:
    | Extract<
        AtomicEffectObservationV1,
        { kind: "existing_handle_pinned" }
      >
    | null,
  exact: boolean,
) {
  return opened === null
    ? Object.freeze({
        state: "absent" as const,
        leaf,
        objectId: null,
        evidence: null,
      })
    : Object.freeze({
        state: exact ? ("present" as const) : ("other" as const),
        leaf,
        objectId: opened.handleId,
        evidence: opened.evidence,
      });
}

export async function recoverAtomicManifestPlannedPublication(
  lease: AtomicPreReadyRecoveryLeaseV1,
): Promise<AtomicManifestPlannedRecoveryResultV1> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const bundles = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "bundles_parent",
    "bundles",
    `${operationId}:manifest-recovery:bundles`,
    operationId,
  );
  const intents = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "intents_parent",
    "intents",
    `${operationId}:manifest-recovery:intents`,
    operationId,
  );
  const intentsRecord = resolveAtomicRecord(flight, intents.handleId);
  const intentLeaf = `${operationId}.json`;
  const snapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    intentLeaf,
    ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES,
    "atomic-manifest-recovery-intent",
  );
  if (snapshot === null) {
    throw atomicFailure("atomic recovery stable intent is missing");
  }
  const intent = parseAtomicPublishIntent(snapshot.bytes);
  if (
    intent.operationId !== operationId ||
    intent.phase !== "manifest_planned" ||
    intent.identityManifest?.phase !== "planned" ||
    !sameReadyBinding(intent.binding, flight.binding)
  ) {
    throw atomicFailure("atomic recovery stable intent is invalid");
  }
  const reconstructed = await reconstructAtomicManifestPlannedBytes(
    controller,
    intent,
    bundles,
    intents,
    lease.initialAuthority.profilesParentId,
  );
  const manifestBinding = intent.identityManifest;
  await reserveAtomicBudget(
    controller,
    `${operationId}:manifest-recovery:stable-files`,
    operationId,
    "stable_files",
    2,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:manifest-recovery:scratch-files`,
    operationId,
    "scratch_files",
    1,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:manifest-recovery:manifest-bytes`,
    operationId,
    "manifest_bytes",
    0,
    manifestBinding.byteSize * 2,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:manifest-recovery:intent-bytes`,
    operationId,
    "other_metadata_bytes",
    0,
    snapshot.bytes.byteLength,
  );
  flight.stableIntents.set(intentLeaf, {
    contentSha256: snapshot.evidence.contentSha256!,
    intent,
  });
  const stableIntentOpened = await openAtomicExpectedChild(
    controller,
    `${operationId}:manifest-recovery:open-intent`,
    operationId,
    "intent_stable",
    intents.handleId,
    intentLeaf,
    snapshot.evidence,
    "file_read_nofollow",
  );
  let stableIntent: AtomicPublishedIntentRecord = {
    intent,
    objectId: stableIntentOpened.handleId,
    evidence: stableIntentOpened.evidence,
  };
  const tempSnapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    manifestBinding.tempFilename,
    ATOMIC_MAX_SCRATCH_MANIFEST_BYTES,
    "atomic-manifest-recovery-temp",
  );
  const stableSnapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    manifestBinding.filename,
    ATOMIC_MAX_STABLE_MANIFEST_BYTES,
    "atomic-manifest-recovery-stable",
  );
  const tempOpened =
    tempSnapshot === null
      ? null
      : await openAtomicExpectedChild(
          controller,
          `${operationId}:manifest-recovery:open-temp`,
          operationId,
          "manifest_temp",
          intents.handleId,
          manifestBinding.tempFilename,
          tempSnapshot.evidence,
          "file_read_nofollow",
        );
  let stableOpened =
    stableSnapshot === null
      ? null
      : await openAtomicExpectedChild(
          controller,
          `${operationId}:manifest-recovery:open-stable`,
          operationId,
          "manifest_stable",
          intents.handleId,
          manifestBinding.filename,
          stableSnapshot.evidence,
          "file_read_nofollow",
        );
  if (stableOpened !== null) {
    await syncAtomicHeld(
      controller,
      `${operationId}:manifest-recovery:stable-parent-sync`,
      operationId,
      "fsync_parent",
      "intents_parent",
      intents.handleId,
      intents.evidence,
    );
  }
  const exact = (evidence: AtomicObjectEvidenceV1): boolean =>
    evidence.mode === 384 &&
    evidence.size === manifestBinding.byteSize &&
    evidence.contentSha256 === manifestBinding.sha256;
  const observationBinding = atomicManifestRecoveryObservationBinding(
    operationId,
    manifestBinding,
    intents.handleId,
  );
  const publicationProof =
    tempOpened !== null && stableOpened !== null
      ? Object.freeze({
          operationId,
          tempObjectId: tempOpened.handleId,
          stableObjectId: stableOpened.handleId,
          tempEvidence: tempOpened.evidence,
          stableEvidence: stableOpened.evidence,
          sourceState: "present" as const,
          targetState: "present" as const,
          stableParentSynced: true as const,
          evidenceDigest: sha256(
            JSON.stringify({
              operationId,
              temp: tempOpened.evidence.evidenceDigest,
              stable: stableOpened.evidence.evidenceDigest,
            }),
          ),
        })
      : null;
  let step = createAtomicManifestPlannedRecoveryState({
    operationId,
    canonicalBytes: reconstructed.bytes,
    manifestSha256: manifestBinding.sha256,
    manifestByteSize: manifestBinding.byteSize,
    entryCount: manifestBinding.entryCount,
    intentsParentId: intents.handleId,
    tempLeaf: manifestBinding.tempFilename,
    stableLeaf: manifestBinding.filename,
  });
  step = advanceAtomicManifestPlannedRecovery(step.state, {
    kind: "manifest_locations_observed",
    ...observationBinding,
    temp: atomicManifestRecoveryLocation(
      manifestBinding.tempFilename,
      tempOpened,
      tempOpened !== null && exact(tempOpened.evidence),
    ),
    stable: atomicManifestRecoveryLocation(
      manifestBinding.filename,
      stableOpened,
      stableOpened !== null && exact(stableOpened.evidence),
    ),
    stableParentSynced: stableOpened !== null,
    publicationProof,
  });
  let recreatedTemp:
    | Readonly<{
        objectId: FlightSemanticId;
        evidence: AtomicObjectEvidenceV1;
      }>
    | null = null;
  while (step.result === null) {
    const action: AtomicManifestPlannedRecoveryActionV1 | null = step.action;
    if (action === null) {
      throw atomicFailure("atomic manifest recovery action is missing");
    }
    let observation: AtomicManifestPlannedRecoveryObservationV1;
    switch (action.kind) {
      case "observe_manifest_locations":
        throw atomicFailure("atomic manifest recovery observation repeated");
      case "recreate_manifest_temp": {
        recreatedTemp = await createAtomicRecoveredManifestTemp(
          controller,
          operationId,
          intents.handleId,
          intents.evidence,
          action.tempLeaf,
          action.canonicalBytes,
        );
        observation = {
          kind: "manifest_temp_recreated",
          ...observationBinding,
          tempObjectId: recreatedTemp.objectId,
          tempEvidence: recreatedTemp.evidence,
          tempParentSynced: true,
        };
        break;
      }
      case "publish_manifest_temp": {
        const published = await runAtomicPinnedPersistenceProtocol(
          controller,
          {
            flightNonce: `${operationId}:manifest-recovery:publish`,
            request: {
              kind: "persist_manifest",
              operationId,
              expectedPhase: "manifest_planned",
              canonicalBytes: reconstructed.bytes,
              contentDigest: manifestBinding.sha256,
              tempParentId: intents.handleId,
              tempLeaf: action.tempLeaf,
              tempObjectId: action.tempObjectId,
              expectedTemp: action.expectedTemp,
              stableParentId: intents.handleId,
              stableLeaf: action.stableLeaf,
              expectedStable: { absent: true },
            },
            stableParentRole: "intents_parent",
            stableParentEvidence: intents.evidence,
          },
        );
        stableOpened = {
          kind: "existing_handle_pinned",
          effectId: Object.freeze({}) as FlightEffectId,
          handleId: published.stableObjectId,
          evidence: published.stableEvidence,
        };
        observation = {
          kind: "manifest_publication_observed",
          ...observationBinding,
          tempObjectId: action.tempObjectId,
          tempEvidence: action.expectedTemp,
          stableObjectId: published.stableObjectId,
          stableEvidence: published.stableEvidence,
          sourceState: "absent",
          targetState: "present",
          stableParentSynced: true,
        };
        break;
      }
      case "authorize_manifest_temp_cleanup":
        observation = {
          kind: "manifest_temp_cleanup_authorized",
          ...observationBinding,
          authorizationDigest: action.authorizationDigest,
        };
        break;
      case "remove_manifest_temp": {
        await runAtomicRequest(
          controller,
          `${operationId}:manifest-recovery:remove-temp`,
          {
            kind: "remove_file",
            operationId,
            role: "manifest_temp",
            parentId: intents.handleId,
            leaf: action.tempLeaf,
            objectId: action.tempObjectId,
            manifestSha256: manifestBinding.sha256,
            cursor: 0,
            expected: action.expectedTemp,
          },
          [intents.handleId, action.tempObjectId],
        );
        await closeAndReleaseAtomicRecord(
          controller,
          `${operationId}:manifest-recovery:close-temp`,
          operationId,
          "manifest_temp",
          action.tempObjectId,
          action.expectedTemp,
          { kind: "scratch_files", count: 1, byteSize: 0 },
        );
        await releaseAtomicBudget(
          controller,
          `${operationId}:manifest-recovery:release-temp-bytes`,
          operationId,
          "manifest_bytes",
          0,
          action.expectedTemp.size,
        );
        observation = {
          kind: "manifest_temp_removed",
          ...observationBinding,
          tempObjectId: action.tempObjectId,
          removedEvidence: action.expectedTemp,
          state: "absent",
          parentSynced: true,
          authorizationDigest: action.authorizationDigest,
        };
        break;
      }
      case "persist_manifest_published": {
        stableIntent = await createAndReplaceAtomicIntent(
          controller,
          `${operationId}:manifest-recovery:persist-phase`,
          stableIntent,
          {
            ...stableIntent.intent,
            phase: "manifest_published",
            identityManifest: {
              ...manifestBinding,
              phase: "published",
              dev: action.expectedStable.dev,
              ino: action.expectedStable.ino,
              mode: 384,
            },
          },
          intents.handleId,
          intents.evidence,
        );
        observation = {
          kind: "manifest_published_persisted",
          ...observationBinding,
          phase: "manifest_published",
          stableObjectId: action.stableObjectId,
          stableEvidence: action.expectedStable,
          stableParentSynced: true,
        };
        break;
      }
    }
    step = advanceAtomicManifestPlannedRecovery(step.state, observation);
  }
  if (
    step.result.kind !== "complete" ||
    stableOpened === null ||
    stableIntent.intent.phase !== "manifest_published"
  ) {
    throw atomicFailure(
      `atomic manifest recovery failed: ${
        step.result.kind === "fail_stop" ? step.result.code : "incomplete"
      }`,
    );
  }
  return Object.freeze({
    authority: Object.freeze({
      intent: stableIntent.intent,
      intentObjectId: stableIntent.objectId,
      intentEvidence: stableIntent.evidence,
      manifest: reconstructed.manifest,
      manifestObjectId: stableOpened.handleId,
      manifestEvidence: stableOpened.evidence,
    }),
    reconstructedManifestBytes: Uint8Array.from(reconstructed.bytes),
  });
}

export async function recoverAtomicManifestPlannedPublicationFromCanonicalRoot(
  canonicalRoot: string,
  binding: ReadyProfileRootBinding,
  admission: ReconciliationExecutionAdmission,
  operationId: string,
): Promise<Readonly<{
  intent: AtomicPublishIntentV1;
  manifest: CleanupIdentityManifestV1;
  reconstructedManifestBytes: Uint8Array;
}>> {
  const lease = await acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
    canonicalRoot,
    binding,
    admission,
    operationId,
  );
  try {
    const result = await recoverAtomicManifestPlannedPublication(lease);
    return Object.freeze({
      intent: result.authority.intent,
      manifest: result.authority.manifest,
      reconstructedManifestBytes: result.reconstructedManifestBytes,
    });
  } finally {
    const failures: unknown[] = [];
    try {
      await closeAtomicEffectController(lease.controller);
    } catch (error) {
      failures.push(error);
    }
    try {
      await lease.closeRoot();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "atomic canonical recovery close is unverified",
      );
    }
  }
}

type AtomicDurablePublicationAuthorityV1 = Readonly<{
  bundles: AtomicPinnedAuthority;
  intents: AtomicPinnedAuthority;
  stable: AtomicPublishedIntentRecord;
  manifest: CleanupIdentityManifestV1 | null;
  manifestObjectId: FlightSemanticId | null;
  manifestEvidence: AtomicObjectEvidenceV1 | null;
}>;

async function loadAtomicDurablePublicationAuthority(
  lease: AtomicPreReadyRecoveryLeaseV1,
): Promise<AtomicDurablePublicationAuthorityV1> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const bundles = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "bundles_parent",
    "bundles",
    `${operationId}:continuation:bundles`,
    operationId,
  );
  const intents = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "intents_parent",
    "intents",
    `${operationId}:continuation:intents`,
    operationId,
  );
  const intentsRecord = resolveAtomicRecord(flight, intents.handleId);
  const intentLeaf = `${operationId}.json`;
  const intentSnapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    intentLeaf,
    ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES,
    "atomic-continuation-intent",
  );
  if (intentSnapshot === null) {
    throw atomicFailure("atomic continuation stable intent is missing");
  }
  const intent = parseAtomicPublishIntent(intentSnapshot.bytes);
  if (
    intent.operationId !== operationId ||
    !sameReadyBinding(intent.binding, flight.binding) ||
    intent.identityManifest === null ||
    intent.phase === "manifest_planned"
  ) {
    throw atomicFailure("atomic continuation stable intent is invalid");
  }
  await reserveAtomicBudget(
    controller,
    `${operationId}:continuation:stable-files`,
    operationId,
    "stable_files",
    2,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:continuation:scratch-files`,
    operationId,
    "scratch_files",
    1,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:continuation:intent-bytes`,
    operationId,
    "other_metadata_bytes",
    0,
    intentSnapshot.bytes.byteLength,
  );
  flight.stableIntents.set(intentLeaf, {
    contentSha256: intentSnapshot.evidence.contentSha256!,
    intent,
  });
  const intentOpened = await openAtomicExpectedChild(
    controller,
    `${operationId}:continuation:open-intent`,
    operationId,
    "intent_stable",
    intents.handleId,
    intentLeaf,
    intentSnapshot.evidence,
    "file_read_nofollow",
  );
  let manifest: CleanupIdentityManifestV1 | null = null;
  let manifestObjectId: FlightSemanticId | null = null;
  let manifestEvidence: AtomicObjectEvidenceV1 | null = null;
  const manifestSnapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    intent.identityManifest.filename,
    ATOMIC_MAX_STABLE_MANIFEST_BYTES,
    "atomic-continuation-manifest",
  );
  if (manifestSnapshot === null) {
    if (
      intent.phase !== "manifest_deleting" &&
      intent.phase !== "cleaned"
    ) {
      throw atomicFailure("atomic continuation stable manifest is missing");
    }
  } else {
    if (
      manifestSnapshot.evidence.mode !== 384 ||
      manifestSnapshot.evidence.size !== intent.identityManifest.byteSize ||
      manifestSnapshot.evidence.contentSha256 !== intent.identityManifest.sha256 ||
      (intent.identityManifest.dev !== null &&
        manifestSnapshot.evidence.dev !== intent.identityManifest.dev) ||
      (intent.identityManifest.ino !== null &&
        manifestSnapshot.evidence.ino !== intent.identityManifest.ino)
    ) {
      throw atomicFailure("atomic continuation manifest binding is invalid");
    }
    manifest = parseCleanupIdentityManifest(manifestSnapshot.bytes);
    validateCleanupIdentityManifestBinding(intent, manifest);
    await reserveAtomicBudget(
      controller,
      `${operationId}:continuation:manifest-bytes`,
      operationId,
      "manifest_bytes",
      0,
      manifestSnapshot.bytes.byteLength,
    );
    const manifestOpened = await openAtomicExpectedChild(
      controller,
      `${operationId}:continuation:open-manifest`,
      operationId,
      "manifest_stable",
      intents.handleId,
      intent.identityManifest.filename,
      manifestSnapshot.evidence,
      "file_read_nofollow",
    );
    manifestObjectId = manifestOpened.handleId;
    manifestEvidence = manifestOpened.evidence;
  }
  return Object.freeze({
    bundles,
    intents,
    stable: {
      intent,
      objectId: intentOpened.handleId,
      evidence: intentOpened.evidence,
    },
    manifest,
    manifestObjectId,
    manifestEvidence,
  });
}

type AtomicDiscoveredDurableIntent = Readonly<{
  operationId: string;
  intent: AtomicPublishIntentV1;
  topology: AtomicStartupRecoveryTopologyV1;
}>;

type AtomicDiscoveredDirectoryEntry = Extract<
  AtomicEffectObservationV1,
  { kind: "directory_observed" }
>["entries"][number];

async function runAtomicDiscoveryReducerRequest(
  controller: AtomicEffectControllerV1,
  flightNonce: string,
  request: Readonly<{
    kind: "enumerate_directory" | "read_file_chunk";
    operationId: string;
    role: AtomicObjectRoleV1;
    objectId: FlightSemanticId;
    cursor: number;
    byteLength: number;
    expected: AtomicObjectEvidenceV1;
  }>,
  semanticIds: readonly FlightSemanticId[],
): Promise<AtomicEffectObservationV1> {
  let step = reduceAtomicPublication(
    createAtomicReducerState({
      flightNonce,
      request: request as AtomicEffectRequestDraftV1,
      semanticIds,
      reservations:
        request.kind === "enumerate_directory"
          ? {
              directoryEntries: ATOMIC_DIRECTORY_PAGE_LIMIT,
              directoryBytes: ATOMIC_OBSERVATION_BYTE_LIMIT,
              fileBytes: 0,
            }
          : {
              directoryEntries: 0,
              directoryBytes: 0,
              fileBytes: request.byteLength,
            },
      cursors:
        request.kind === "enumerate_directory"
          ? { directory: request.cursor }
          : { file: request.cursor },
    }),
    null,
  );
  if (step.kind !== "effect") {
    throw atomicFailure("atomic discovery reducer did not emit an effect");
  }
  const observation = await applyAtomicEffect(controller, step.request);
  step = reduceAtomicPublication(step.state, observation);
  if (
    step.kind !== "terminal" ||
    step.result.kind !== "protocol_complete"
  ) {
    throw atomicFailure("atomic discovery reducer did not complete");
  }
  return observation;
}

async function discoverAtomicDirectoryEntries(
  controller: AtomicEffectControllerV1,
  operationId: string,
  directory: AtomicPinnedAuthority,
  role: AtomicObjectRoleV1,
  label: string,
): Promise<readonly AtomicDiscoveredDirectoryEntry[]> {
  const discovered: AtomicDiscoveredDirectoryEntry[] = [];
  let cursor = 0;
  for (let page = 0; page <= ATOMIC_MAX_METADATA_FILES; page += 1) {
    const observation = await runAtomicDiscoveryReducerRequest(
      controller,
      `${operationId}:discovery:${label}:${cursor}`,
      {
        kind: "enumerate_directory",
        operationId,
        role,
        objectId: directory.handleId,
        cursor,
        byteLength: ATOMIC_OBSERVATION_BYTE_LIMIT,
        expected: directory.evidence,
      },
      [directory.handleId],
    );
    if (observation.kind !== "directory_observed") {
      throw atomicFailure("atomic directory discovery observation is invalid");
    }
    discovered.push(...observation.entries);
    cursor += observation.entries.length;
    if (observation.done) {
      return Object.freeze(discovered);
    }
  }
  throw atomicFailure("atomic directory discovery bound exceeded");
}

async function discoverAtomicDurablePublicationIntents(
  root: AnchoredProfileRoot,
  binding: ReadyProfileRootBinding,
): Promise<readonly AtomicDiscoveredDurableIntent[]> {
  const operationId = atomicUuidFromDigest(
    `startup-recovery-discovery\0${binding.processNonce}\0${binding.controlGenerationNonce}\0${binding.snapshotDigest}`,
  );
  const lease = await acquireAtomicPreReadyRecoveryAuthority(
    root,
    operationId,
  );
  try {
    const controller = lease.controller;
    const flight = requireAtomicFlight(controller);
    const intents = await getAtomicInitialControlChild(
      controller,
      lease.initialAuthority.stagingRootId,
      "intents_parent",
      "intents",
      `${operationId}:discovery:intents`,
      operationId,
    );
    const bundles = await getAtomicInitialControlChild(
      controller,
      lease.initialAuthority.stagingRootId,
      "bundles_parent",
      "bundles",
      `${operationId}:discovery:bundles`,
      operationId,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:discovery:stable-files`,
      operationId,
      "stable_files",
      ATOMIC_MAX_STABLE_METADATA_FILES,
      0,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:discovery:payload-entries`,
      operationId,
      "payload_entries",
      ATOMIC_MAX_METADATA_FILES,
      0,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:discovery:metadata-bytes`,
      operationId,
      "other_metadata_bytes",
      0,
      ATOMIC_MAX_OTHER_METADATA_BYTES,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:discovery:manifest-bytes`,
      operationId,
      "manifest_bytes",
      0,
      ATOMIC_MAX_MANIFEST_BYTES,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:discovery:payload-bytes`,
      operationId,
      "payload_bytes",
      0,
      ATOMIC_MAX_PAYLOAD_BYTES,
    );
    const discovered = await discoverAtomicDirectoryEntries(
      controller,
      operationId,
      intents,
      "intents_parent",
      "intents",
    );
    const discoveredBundles = await discoverAtomicDirectoryEntries(
      controller,
      operationId,
      bundles,
      "bundles_parent",
      "bundles",
    );
    const parsed = discovered.map(entry => ({
      entry,
      leaf: parseAtomicPublicationIntentLeaf(entry.leaf),
    }));
    const results: AtomicDiscoveredDurableIntent[] = [];
    const operationIds = [
      ...new Set(parsed.map(value => value.leaf.operationId)),
    ].sort(rawCompare);
    for (const discoveredOperationId of operationIds) {
      const artifacts = parsed.filter(
        candidate =>
          candidate.leaf.operationId === discoveredOperationId,
      );
      const value =
        artifacts.find(
          candidate => candidate.leaf.kind === "intent_stable",
        ) ??
        artifacts.find(
          candidate => candidate.leaf.kind === "intent_temp",
        );
      if (value === undefined) {
        flight.root.observability?.count("orphan_temp");
        throw atomicFailure(
          "atomic publication orphan metadata is unresolved",
        );
      }
      const record = resolveAtomicRecord(flight, value.entry.objectId);
      if (!record.stat.isFile() || record.evidence.size <= 0) {
        throw atomicFailure("atomic durable intent is invalid");
      }
      const bytes = Buffer.alloc(record.evidence.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const byteLength = Math.min(
          ATOMIC_OBSERVATION_BYTE_LIMIT,
          bytes.byteLength - offset,
        );
        const observation = await runAtomicDiscoveryReducerRequest(
          controller,
          `${operationId}:discovery:read:${discoveredOperationId}:${offset}`,
          {
            kind: "read_file_chunk",
            operationId,
            role: "payload_entry",
            objectId: value.entry.objectId,
            cursor: offset,
            byteLength,
            expected: record.evidence,
          },
          [value.entry.objectId],
        );
        if (
          observation.kind !== "file_chunk_observed" ||
          observation.cursor !== offset
        ) {
          throw atomicFailure("atomic durable intent read is invalid");
        }
        const chunk = Buffer.from(observation.bytesBase64, "base64");
        chunk.copy(bytes, offset);
        offset += chunk.byteLength;
        if (chunk.byteLength === 0 && offset < bytes.byteLength) {
          throw atomicFailure("atomic durable intent was truncated");
        }
      }
      const intent = parseAtomicPublishIntent(bytes);
      if (intent.operationId !== discoveredOperationId) {
        throw atomicFailure("atomic durable intent identity mismatched");
      }
      const identityStable = artifacts.some(
        candidate => candidate.leaf.kind === "identity_stable",
      );
      const identityTemp = artifacts.some(
        candidate => candidate.leaf.kind === "identity_temp",
      );
      const wrapper = discoveredBundles.some(
        entry =>
          entry.leaf === intent.operationId && entry.type === "directory",
      );
      const targetOther =
        intent.classification?.targetOther === true ||
        (intent.classification?.outcome === "conflict" &&
          intent.classification.targetMatches === false);
      const targetMatches =
        intent.classification?.targetMatches === true ||
        intent.classification?.outcome === "published" ||
        intent.phase === "renamed" ||
        intent.phase === "manifest_planned" ||
        intent.phase === "manifest_published" ||
        intent.phase === "source_deleting" ||
        intent.phase === "adopted" ||
        intent.phase === "discarding" ||
        intent.phase === "manifest_deleting" ||
        intent.phase === "cleaned";
      results.push(
        Object.freeze({
          operationId: intent.operationId,
          intent,
          topology: Object.freeze({
            stableIntent: artifacts.some(
              candidate => candidate.leaf.kind === "intent_stable",
            ),
            intentTemp: artifacts.some(
              candidate => candidate.leaf.kind === "intent_temp",
            ),
            wrapper,
            privateSource:
              intent.privateSource !== null ||
              (wrapper && intent.phase !== "allocated"),
            publicSource:
              intent.publicSource !== null &&
              intent.sourceDeletion?.phase !== "removed",
            publicTarget: targetOther
              ? ("other" as const)
              : targetMatches
                ? ("match" as const)
                : ("absent" as const),
            manifest:
              identityStable && identityTemp
                ? ("both" as const)
                : identityStable
                  ? ("stable" as const)
                  : identityTemp
                    ? ("temp" as const)
                    : ("absent" as const),
          }),
        }),
      );
    }
    return Object.freeze(
      results.sort((left, right) =>
        rawCompare(left.operationId, right.operationId),
      ),
    );
  } finally {
    try {
      const flight = atomicEffectFlightRecords.get(lease.controller as object);
      if (flight?.state === "live") {
        await closeAtomicOwnedRecordsThroughReducer(lease.controller);
      }
    } finally {
      await closeAtomicEffectController(lease.controller);
    }
  }
}

type AtomicStartupHeldDirectory = AtomicPinnedAuthority &
  Readonly<{ role: AtomicObjectRoleV1 }>;

function atomicIntentIdentityMatches(
  evidence: AtomicObjectEvidenceV1 | null,
  identity: Readonly<{ dev: string; ino: string; mode: number }> | null,
): boolean {
  return (
    evidence !== null &&
    identity !== null &&
    evidence.dev === identity.dev &&
    evidence.ino === identity.ino &&
    evidence.mode === identity.mode
  );
}

async function observeAtomicStartupRecoveryTopology(
  root: AnchoredProfileRoot,
  durable: AtomicDiscoveredDurableIntent,
): Promise<AtomicStartupRecoveryTopologyV1> {
  const intent = durable.intent;
  const lease = await acquireAtomicPreReadyRecoveryAuthorityForBinding(
    root,
    durable.operationId,
    intent.binding,
  );
  try {
    const controller = lease.controller;
    const flight = requireAtomicFlight(controller);
    for (const reservation of [
      {
        kind: "stable_files" as const,
        count: ATOMIC_MAX_STABLE_METADATA_FILES,
        byteSize: 0,
      },
      {
        kind: "payload_entries" as const,
        count: ATOMIC_MAX_METADATA_FILES,
        byteSize: 0,
      },
      {
        kind: "other_metadata_bytes" as const,
        count: 0,
        byteSize: ATOMIC_MAX_OTHER_METADATA_BYTES,
      },
      {
        kind: "manifest_bytes" as const,
        count: 0,
        byteSize: ATOMIC_MAX_MANIFEST_BYTES,
      },
      {
        kind: "payload_bytes" as const,
        count: 0,
        byteSize: ATOMIC_MAX_PAYLOAD_BYTES,
      },
    ]) {
      await reserveAtomicBudget(
        controller,
        `${durable.operationId}:topology:${reservation.kind}`,
        durable.operationId,
        reservation.kind,
        reservation.count,
        reservation.byteSize,
      );
    }
    const bundles: AtomicStartupHeldDirectory = {
      handleId: lease.initialAuthority.bundlesParentId,
      evidence: lease.initialAuthority.evidence.bundlesParent,
      role: "bundles_parent",
    };
    const profiles: AtomicStartupHeldDirectory = {
      handleId: lease.initialAuthority.profilesParentId,
      evidence: lease.initialAuthority.evidence.profilesParent,
      role: "profiles_parent",
    };
    const cache = new WeakMap<
      object,
      readonly AtomicDiscoveredDirectoryEntry[]
    >();
    const entries = async (
      directory: AtomicStartupHeldDirectory,
    ): Promise<readonly AtomicDiscoveredDirectoryEntry[]> => {
      const cached = cache.get(directory.handleId as object);
      if (cached !== undefined) return cached;
      const discovered = await discoverAtomicDirectoryEntries(
        controller,
        durable.operationId,
        directory,
        directory.role,
        `topology:${directory.role}`,
      );
      cache.set(directory.handleId as object, discovered);
      return discovered;
    };
    const child = async (
      directory: AtomicStartupHeldDirectory,
      leaf: string,
    ): Promise<AtomicStartupHeldDirectory | null> => {
      const entry = (await entries(directory)).find(
        candidate => candidate.leaf === leaf,
      );
      if (entry === undefined || entry.type !== "directory") return null;
      return {
        handleId: entry.objectId,
        evidence: resolveAtomicRecord(flight, entry.objectId).evidence,
        role: "payload_entry",
      };
    };
    const profileState = async (
      profileId: string,
      state: string,
    ): Promise<AtomicStartupHeldDirectory | null> => {
      const profile = await child(profiles, profileId);
      return profile === null ? null : child(profile, state);
    };

    const wrapper = await child(bundles, durable.operationId);
    const wrapperMatches = atomicIntentIdentityMatches(
      wrapper?.evidence ?? null,
      intent.wrapper,
    );
    const privatePayload =
      wrapper === null ? null : await child(wrapper, "payload");

    let targetParent: AtomicStartupHeldDirectory | null;
    if (intent.target.kind === "profile") {
      targetParent = profiles;
    } else if (intent.target.kind === "profile_state") {
      targetParent = await profileState(
        intent.target.profileId,
        intent.target.state,
      );
    } else {
      targetParent = null;
    }
    const targetLeaf =
      intent.target.kind === "canary_parent"
        ? null
        : intent.target.leaf;
    const target =
      targetParent === null || targetLeaf === null
        ? null
        : await child(targetParent, targetLeaf);

    let sourceEvidence = privatePayload?.evidence ?? null;
    if (sourceEvidence === null) sourceEvidence = target?.evidence ?? null;
    if (sourceEvidence === null) {
      const value = {
        dev: intent.privateSource?.dev ?? "0",
        ino: intent.privateSource?.ino ?? "0",
        mode: intent.privateSource?.mode ?? 448,
        size: 0,
        contentSha256: null,
      };
      sourceEvidence = Object.freeze({
        ...value,
        evidenceDigest: sha256(JSON.stringify(value)),
      });
    }

    let privateSource = atomicIntentIdentityMatches(
      privatePayload?.evidence ?? null,
      intent.privateSource,
    );
    let publicTarget: AtomicStartupRecoveryTopologyV1["publicTarget"] =
      target === null
        ? "absent"
        : atomicIntentIdentityMatches(
              target.evidence,
              intent.privateSource,
            )
          ? "match"
          : "other";
    if (targetParent !== null && targetLeaf !== null) {
      const sourceParent = wrapper ?? targetParent;
      const observed = await runAtomicRequest(
        controller,
        `${durable.operationId}:topology:locations`,
        {
          kind: "observe_locations",
          requestKind: "native_no_replace",
          operationId: durable.operationId,
          move: "profile_publish",
          sourceParentId: sourceParent.handleId,
          sourceId: null,
          sourceLeaf: "payload",
          targetParentId: targetParent.handleId,
          targetLeaf,
          expectedSource: sourceEvidence,
          expectedTarget: { absent: true },
          evidenceDigest: sha256(
            JSON.stringify({
              operationId: durable.operationId,
              source: sourceEvidence.evidenceDigest,
              targetParent: targetParent.evidence.evidenceDigest,
            }),
          ),
        },
        [sourceParent.handleId, targetParent.handleId],
      );
      const locations = observed.observations.find(
        (
          observation,
        ): observation is Extract<
          AtomicEffectObservationV1,
          {
            kind: "locations_observed";
            requestKind: "native_no_replace";
          }
        > =>
          observation.kind === "locations_observed" &&
          observation.requestKind === "native_no_replace",
      );
      if (locations === undefined) {
        throw atomicFailure(
          "atomic startup topology location observation is missing",
        );
      }
      privateSource =
        locations.source.state === "match" &&
        atomicIntentIdentityMatches(
          locations.source.evidence,
          intent.privateSource,
        );
      publicTarget =
        locations.target.state === "absent"
          ? "absent"
          : atomicIntentIdentityMatches(
                locations.target.evidence,
                intent.privateSource,
              )
            ? "match"
            : "other";
    }

    let publicSource = false;
    if (intent.publicSource !== null) {
      const sourceState = await profileState(
        intent.publicSource.profileId,
        intent.publicSource.state,
      );
      const source =
        sourceState === null
          ? null
          : await child(sourceState, intent.publicSource.generationId);
      publicSource = atomicIntentIdentityMatches(
        source?.evidence ?? null,
        intent.publicSource,
      );
    }

    await closeAtomicOwnedRecordsThroughReducer(controller);
    return Object.freeze({
      ...durable.topology,
      wrapper: wrapperMatches,
      privateSource,
      publicSource,
      publicTarget,
    });
  } finally {
    await closeAtomicEffectController(lease.controller);
  }
}

async function planAtomicBuildingAbortManifest(
  lease: AtomicPreReadyRecoveryLeaseV1,
): Promise<void> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const bundles = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "bundles_parent",
    "bundles",
    `${operationId}:building-recovery:bundles`,
    operationId,
  );
  const intents = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "intents_parent",
    "intents",
    `${operationId}:building-recovery:intents`,
    operationId,
  );
  const intentsRecord = resolveAtomicRecord(flight, intents.handleId);
  const snapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    `${operationId}.json`,
    ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES,
    "atomic-building-recovery-intent",
  );
  if (snapshot === null) {
    throw atomicFailure("atomic building recovery intent is missing");
  }
  const parsed = parseAtomicPublishIntent(snapshot.bytes);
  if (
    parsed.operationId !== operationId ||
    (parsed.phase !== "building" &&
      !(
        parsed.phase === "aborting_prepublication" &&
        parsed.prepublicationAbort?.from === "building"
      )) ||
    parsed.wrapper === null ||
    parsed.privateSource !== null
  ) {
    throw atomicFailure("atomic building recovery intent is invalid");
  }
  await reserveAtomicBudget(
    controller,
    `${operationId}:building-recovery:stable-files`,
    operationId,
    "stable_files",
    1,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:building-recovery:intent-bytes`,
    operationId,
    "other_metadata_bytes",
    0,
    snapshot.bytes.byteLength,
  );
  flight.stableIntents.set(`${operationId}.json`, {
    contentSha256: snapshot.evidence.contentSha256!,
    intent: parsed,
  });
  const opened = await openAtomicExpectedChild(
    controller,
    `${operationId}:building-recovery:open-intent`,
    operationId,
    "intent_stable",
    intents.handleId,
    `${operationId}.json`,
    snapshot.evidence,
    "file_read_nofollow",
  );
  let stable: AtomicPublishedIntentRecord = {
    intent: parsed,
    objectId: opened.handleId,
    evidence: opened.evidence,
  };
  const bundlesRecord = resolveAtomicRecord(flight, bundles.handleId);
  const recoveryDirectories: AtomicRecoveryDirectory[] = [];
  try {
    const privateRecoverySource = atomicPrivateRecoverySource(stable.intent);
    const wrapper = await openAtomicRecoveryDirectory(
      flight,
      bundlesRecord,
      operationId,
      parsed.wrapper,
      "atomic-building-recovery-wrapper",
    );
    recoveryDirectories.push(wrapper);
    let entries: readonly CleanupIdentityEntryV1[] = [];
    try {
      const payload = await openAtomicRecoveryDirectory(
        flight,
        wrapper,
        privateRecoverySource.leaf,
        null,
        "atomic-building-recovery-payload",
      );
      recoveryDirectories.push(payload);
      entries = await atomicRecoveryTreeEntries(
        flight,
        payload,
        privateRecoverySource.scope,
        privateRecoverySource.prefix,
        null,
        null,
      );
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
    entries = Object.freeze([
      ...entries,
      ...(await atomicBuildingRecoveryIntentTemps(
        flight,
        intentsRecord,
        stable.intent,
      )),
    ]);
    if (stable.intent.phase === "building") {
      const evidenceDigest = sha256(
        JSON.stringify({
          operationId,
          from: "building",
          outcome: "never_attempted",
        }),
      );
      stable = await createAndReplaceAtomicIntent(
        controller,
        `${operationId}:building-recovery:abort`,
        stable,
        {
          ...stable.intent,
          phase: "aborting_prepublication",
          prepublicationAbort: {
            outcome: "never_attempted",
            from: "building",
            evidenceDigest,
          },
          cleanup: {
            phase: "aborting_prepublication",
            outcome: "never_attempted",
            evidenceDigest,
            suffix: "private_source_entries",
            nextIndex: 0,
          },
        },
        intents.handleId,
        intents.evidence,
      );
    }
    const indexed = entries.map((entry, index) =>
      Object.freeze({ ...entry, index }),
    );
    const manifest: CleanupIdentityManifestV1 = Object.freeze({
      version: 1,
      operationId,
      binding: stable.intent.binding,
      targetLocatorDigest: publicationTargetLocatorDigest(
        stable.intent.target,
      ),
      entries: Object.freeze(indexed),
    });
    const encoded = encodeCleanupIdentityManifest(manifest);
    const transitionId = atomicTransitionId(
      operationId,
      "building-recovery-manifest",
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:building-recovery:manifest-planned`,
      stable,
      {
        ...stable.intent,
        phase: "manifest_planned",
        identityManifest: {
          phase: "planned",
          filename: `${operationId}.identities.json`,
          tempFilename:
            `${operationId}.identities.${transitionId}.tmp`,
          sha256: encoded.sha256,
          entryCount: encoded.entryCount,
          byteSize: encoded.bytes.byteLength,
          dev: null,
          ino: null,
          mode: null,
        },
      },
      intents.handleId,
      intents.evidence,
    );
  } finally {
    await closeAtomicRecoveryDirectories(recoveryDirectories);
  }
}

async function openAtomicRecoveryTargetParent(
  lease: AtomicPreReadyRecoveryLeaseV1,
  intent: AtomicPublishIntentV1,
): Promise<Readonly<{
  handleId: FlightSemanticId;
  evidence: AtomicObjectEvidenceV1;
  role: "profiles_parent" | "public_target";
}>> {
  if (intent.target.kind === "canary_parent") {
    throw atomicFailure("atomic profile target parent is invalid");
  }
  if (intent.target.kind === "profile") {
    return Object.freeze({
      handleId: lease.initialAuthority.profilesParentId,
      evidence: lease.initialAuthority.evidence.profilesParent,
      role: "profiles_parent" as const,
    });
  }
  const target = intent.target;
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const profiles = resolveAtomicRecord(
    flight,
    lease.initialAuthority.profilesParentId,
  );
  const profileStat = await atomicAwait(
    flight,
    [profiles],
    "atomic-early-profile-stat",
    () =>
      fs.lstat(procPath(profiles.handle, target.profileId), {
        bigint: true,
      }),
  );
  const profile = await openAtomicExpectedChild(
    controller,
    `${intent.operationId}:early:profile`,
    intent.operationId,
    "public_target",
    lease.initialAuthority.profilesParentId,
    target.profileId,
    atomicEvidenceFromStat(profileStat),
    "directory_nofollow",
  );
  const profileRecord = resolveAtomicRecord(flight, profile.handleId);
  const stateStat = await atomicAwait(
    flight,
    [profileRecord],
    "atomic-early-state-stat",
    () =>
      fs.lstat(procPath(profileRecord.handle, target.state), {
        bigint: true,
      }),
  );
  const state = await openAtomicExpectedChild(
    controller,
    `${intent.operationId}:early:state`,
    intent.operationId,
    "public_target",
    profile.handleId,
    target.state,
    atomicEvidenceFromStat(stateStat),
    "directory_nofollow",
  );
  if (
    state.evidence.dev !== target.parent.dev ||
    state.evidence.ino !== target.parent.ino ||
    state.evidence.mode !== target.parent.mode
  ) {
    throw atomicFailure("atomic early target parent drifted");
  }
  return Object.freeze({
    handleId: state.handleId,
    evidence: state.evidence,
    role: "public_target" as const,
  });
}

async function planAtomicEarlyProfileManifest(
  lease: AtomicPreReadyRecoveryLeaseV1,
  startupTopology: AtomicStartupRecoveryTopologyV1,
): Promise<AtomicPublishIntentV1> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const bundles = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "bundles_parent",
    "bundles",
    `${operationId}:early:bundles`,
    operationId,
  );
  const intents = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "intents_parent",
    "intents",
    `${operationId}:early:intents`,
    operationId,
  );
  const intentsRecord = resolveAtomicRecord(flight, intents.handleId);
  const snapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    `${operationId}.json`,
    ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES,
    "atomic-early-intent",
  );
  if (snapshot === null) {
    throw atomicFailure("atomic early intent is missing");
  }
  const parsed = parseAtomicPublishIntent(snapshot.bytes);
  if (
    parsed.operationId !== operationId ||
    !["ready", "classified", "renamed"].includes(parsed.phase) ||
    parsed.wrapper === null ||
    parsed.privateSource === null ||
    parsed.target.kind === "canary_parent"
  ) {
    throw atomicFailure("atomic early intent is invalid");
  }
  await reserveAtomicBudget(
    controller,
    `${operationId}:early:stable-files`,
    operationId,
    "stable_files",
    1,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:early:intent-bytes`,
    operationId,
    "other_metadata_bytes",
    0,
    snapshot.bytes.byteLength,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:early:scratch-entries`,
    operationId,
    "scratch_entries",
    2,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:early:payload-entries`,
    operationId,
    "payload_entries",
    4,
    0,
  );
  flight.stableIntents.set(`${operationId}.json`, {
    contentSha256: snapshot.evidence.contentSha256!,
    intent: parsed,
  });
  const openedIntent = await openAtomicExpectedChild(
    controller,
    `${operationId}:early:open-intent`,
    operationId,
    "intent_stable",
    intents.handleId,
    `${operationId}.json`,
    snapshot.evidence,
    "file_read_nofollow",
  );
  let stable: AtomicPublishedIntentRecord = {
    intent: parsed,
    objectId: openedIntent.handleId,
    evidence: openedIntent.evidence,
  };
  const wrapperLocation = await observeAtomicContinuationDirectory(
    flight,
    resolveAtomicRecord(flight, bundles.handleId),
    operationId,
    "atomic-early-wrapper",
  );
  if (
    wrapperLocation.state !== "present" ||
    wrapperLocation.evidence!.dev !== parsed.wrapper.dev ||
    wrapperLocation.evidence!.ino !== parsed.wrapper.ino ||
    wrapperLocation.evidence!.mode !== parsed.wrapper.mode
  ) {
    throw atomicFailure("atomic early wrapper identity mismatched");
  }
  const wrapper = await openAtomicExpectedChild(
    controller,
    `${operationId}:early:open-wrapper`,
    operationId,
    "wrapper",
    bundles.handleId,
    operationId,
    wrapperLocation.evidence!,
    "directory_nofollow",
  );
  const targetParent = await openAtomicRecoveryTargetParent(lease, parsed);
  if (stable.intent.phase === "ready") {
    let classification: AtomicNativeClassificationV1;
    if (
      !startupTopology.privateSource &&
      startupTopology.publicTarget === "match"
    ) {
      classification = Object.freeze({
        outcome: "published",
        nativeCode: "success",
        sourceMatches: false,
        targetMatches: true,
        targetOther: false,
        nativePrecheckEvidenceDigest: sha256(
          JSON.stringify({
            operationId,
            recovery: "ready_after_native_success",
          }),
        ),
        locationEvidenceDigest: sha256(
          JSON.stringify(startupTopology),
        ),
      });
    } else {
      const sourceLocation = await observeAtomicContinuationDirectory(
        flight,
        resolveAtomicRecord(flight, wrapper.handleId),
        "payload",
        "atomic-early-source",
      );
      if (
        !startupTopology.privateSource ||
        sourceLocation.state !== "present" ||
        sourceLocation.evidence!.dev !== parsed.privateSource.dev ||
        sourceLocation.evidence!.ino !== parsed.privateSource.ino ||
        sourceLocation.evidence!.mode !== parsed.privateSource.mode
      ) {
        throw atomicFailure("atomic early source identity mismatched");
      }
      const source = await openAtomicExpectedChild(
        controller,
        `${operationId}:early:open-source`,
        operationId,
        "private_source",
        wrapper.handleId,
        "payload",
        sourceLocation.evidence!,
        "directory_nofollow",
      );
      for (const [label, role, objectId, evidence] of [
        ["source-parent", "wrapper", wrapper.handleId, wrapper.evidence],
        [
          "target-parent",
          targetParent.role,
          targetParent.handleId,
          targetParent.evidence,
        ],
      ] as const) {
        await runAtomicRequest(
          controller,
          `${operationId}:early:${label}:revalidate`,
          {
            kind: "revalidate_handle",
            operationId,
            role,
            objectId,
            cursor: 0,
            byteLength: 0,
            expected: evidence,
          },
          [objectId],
        );
        await runAtomicRequest(
          controller,
          `${operationId}:early:${label}:statfs`,
          {
            kind: "statfs_parent",
            operationId,
            role,
            objectId,
            expected: evidence,
          },
          [objectId],
        );
      }
      const native = await runAtomicRequest(
        controller,
        `${operationId}:early:native`,
        {
          kind: "native_no_replace",
          operationId,
          move: "profile_publish",
          sourceParentId: wrapper.handleId,
          sourceId: source.handleId,
          sourceLeaf: "payload",
          targetParentId: targetParent.handleId,
          targetLeaf: parsed.target.leaf,
          expectedSource: source.evidence,
          expectedTarget: { absent: true },
          evidenceDigest: sha256(
            JSON.stringify({
              source: source.evidence.evidenceDigest,
              target: targetParent.evidence.evidenceDigest,
            }),
          ),
        },
        [wrapper.handleId, source.handleId, targetParent.handleId],
      );
      if (native.classification === null) {
        throw atomicFailure("atomic early publication is ambiguous");
      }
      classification = native.classification;
    }
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:early:classified`,
      stable,
      {
        ...stable.intent,
        phase: "classified",
        classification: {
          outcome: classification.outcome,
          nativeCode: classification.nativeCode,
          sourceMatches: classification.sourceMatches,
          targetMatches: classification.targetMatches,
          targetOther: classification.targetOther,
          evidenceDigest: sha256(
            JSON.stringify({
              precheck: classification.nativePrecheckEvidenceDigest,
              locations: classification.locationEvidenceDigest,
            }),
          ),
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  if (
    stable.intent.phase === "classified" &&
    stable.intent.classification?.outcome === "published"
  ) {
    await syncAtomicHeld(
      controller,
      `${operationId}:early:source-parent-sync`,
      operationId,
      "fsync_parent",
      "wrapper",
      wrapper.handleId,
      wrapper.evidence,
    );
    await syncAtomicHeld(
      controller,
      `${operationId}:early:target-parent-sync`,
      operationId,
      "fsync_parent",
      targetParent.role,
      targetParent.handleId,
      targetParent.evidence,
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:early:renamed`,
      stable,
      { ...stable.intent, phase: "renamed" },
      intents.handleId,
      intents.evidence,
    );
  }
  const recoveryDirectories: AtomicRecoveryDirectory[] = [];
  const target = stable.intent.target;
  const privateSource = stable.intent.privateSource;
  if (target.kind === "canary_parent" || privateSource === null) {
    throw atomicFailure("atomic early manifest authority is invalid");
  }
  try {
    const wrapperDirectory = await openAtomicRecoveryDirectory(
      flight,
      resolveAtomicRecord(flight, bundles.handleId),
      operationId,
      parsed.wrapper,
      "atomic-early-manifest-wrapper",
    );
    recoveryDirectories.push(wrapperDirectory);
    let payload: AtomicRecoveryDirectory;
    if (stable.intent.classification?.outcome === "published") {
      const profiles = resolveAtomicRecord(
        flight,
        lease.initialAuthority.profilesParentId,
      );
      if (target.kind === "profile") {
        payload = await openAtomicRecoveryDirectory(
          flight,
          profiles,
          target.leaf,
          privateSource,
          "atomic-early-manifest-target",
        );
        recoveryDirectories.push(payload);
      } else {
        const profile = await openAtomicRecoveryDirectory(
          flight,
          profiles,
          target.profileId,
          null,
          "atomic-early-manifest-profile",
        );
        recoveryDirectories.push(profile);
        const state = await openAtomicRecoveryDirectory(
          flight,
          profile,
          target.state,
          target.parent,
          "atomic-early-manifest-state",
        );
        recoveryDirectories.push(state);
        payload = await openAtomicRecoveryDirectory(
          flight,
          state,
          target.leaf,
          privateSource,
          "atomic-early-manifest-target",
        );
        recoveryDirectories.push(payload);
      }
    } else {
      payload = await openAtomicRecoveryDirectory(
        flight,
        wrapperDirectory,
        "payload",
        privateSource,
        "atomic-early-manifest-source",
      );
      recoveryDirectories.push(payload);
    }
    const entries = [
      ...(await atomicRecoveryTreeEntries(
        flight,
        payload,
        "private_profile_payload",
        "payload",
        privateSource.checksum,
        privateSource.byteSize,
      )),
    ];
    if (
      stable.intent.classification?.outcome === "published" &&
      stable.intent.publicSource !== null
    ) {
      const profiles = resolveAtomicRecord(
        flight,
        lease.initialAuthority.profilesParentId,
      );
      const profile = await openAtomicRecoveryDirectory(
        flight,
        profiles,
        stable.intent.publicSource.profileId,
        null,
        "atomic-early-source-profile",
      );
      recoveryDirectories.push(profile);
      const state = await openAtomicRecoveryDirectory(
        flight,
        profile,
        stable.intent.publicSource.state,
        null,
        "atomic-early-source-state",
      );
      recoveryDirectories.push(state);
      const source = await openAtomicRecoveryDirectory(
        flight,
        state,
        stable.intent.publicSource.generationId,
        {
          dev: stable.intent.publicSource.dev,
          ino: stable.intent.publicSource.ino,
          mode: stable.intent.publicSource.mode,
        },
        "atomic-early-public-source",
      );
      recoveryDirectories.push(source);
      entries.push(
        ...(await atomicRecoveryTreeEntries(
          flight,
          source,
          "public_source",
          "source",
          stable.intent.publicSource.checksum,
          stable.intent.publicSource.byteSize,
        )),
      );
    }
    entries.sort((left, right) => {
      const depth =
        right.path.split("/").length - left.path.split("/").length;
      return depth !== 0 ? depth : rawCompare(left.path, right.path);
    });
    const indexed = entries.map((entry, index) =>
      Object.freeze({ ...entry, index }),
    );
    const manifest: CleanupIdentityManifestV1 = Object.freeze({
      version: 1,
      operationId,
      binding: stable.intent.binding,
      targetLocatorDigest: publicationTargetLocatorDigest(
        stable.intent.target,
      ),
      entries: Object.freeze(indexed),
    });
    const encoded = encodeCleanupIdentityManifest(manifest);
    const transitionId = atomicTransitionId(
      operationId,
      "early-recovery-manifest",
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:early:manifest-planned`,
      stable,
      {
        ...stable.intent,
        phase: "manifest_planned",
        identityManifest: {
          phase: "planned",
          filename: `${operationId}.identities.json`,
          tempFilename:
            `${operationId}.identities.${transitionId}.tmp`,
          sha256: encoded.sha256,
          entryCount: encoded.entryCount,
          byteSize: encoded.bytes.byteLength,
          dev: null,
          ino: null,
          mode: null,
        },
      },
      intents.handleId,
      intents.evidence,
    );
    return stable.intent;
  } finally {
    await closeAtomicRecoveryDirectories(recoveryDirectories);
  }
}

async function withAtomicRecoveryLease<T>(
  root: AnchoredProfileRoot,
  binding: ReadyProfileRootBinding,
  operationId: string,
  run: (lease: AtomicPreReadyRecoveryLeaseV1) => Promise<T>,
): Promise<T> {
  const lease = await acquireAtomicPreReadyRecoveryAuthorityForBinding(
    root,
    operationId,
    binding,
  );
  try {
    const result = await run(lease);
    await closeAtomicOwnedRecordsThroughReducer(lease.controller);
    return result;
  } finally {
    await closeAtomicEffectController(lease.controller);
  }
}

async function closeAtomicOwnedRecordsThroughReducer(
  controller: AtomicEffectControllerV1,
): Promise<void> {
  const flight = requireAtomicFlight(controller);
  const owned = [...flight.records]
    .filter(record => record.owned)
    .sort(
      (left, right) =>
        atomicRecordDepth(flight, right) - atomicRecordDepth(flight, left),
    );
  for (const record of owned) {
    const objectId = flight.recordTokens.get(record);
    if (objectId === undefined) {
      throw atomicFailure("atomic owned handle identity is unavailable");
    }
    const expected =
      record.stat.isFile()
        ? atomicPinnedContentEvidence(flight, objectId, record) ??
          record.evidence
        : record.evidence;
    await runAtomicRequest(
      controller,
      `${flight.operationId}:close-owned:${record.role}`,
      {
        kind: "close_handle",
        operationId: flight.operationId,
        role: record.role,
        objectId,
        cursor: 0,
        byteLength: 0,
        expected,
      },
      [objectId],
    );
  }
}

async function recoverPreparedDeletionJournals(
  root: AnchoredProfileRoot,
): Promise<void> {
  const record = requireRoot(root);
  let staging: { handle: FileHandle; stat: BigIntStats } | null = null;
  let bundles: { handle: FileHandle; stat: BigIntStats } | null = null;
  try {
    try {
      staging = await openPreparedDeletionDirectory(
        record.anchored,
        record.anchored.handle,
        ".profile-publish-staging",
      );
      bundles = await openPreparedDeletionDirectory(
        record.anchored,
        staging.handle,
        "bundles",
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    const leaves = await call(
      record.anchored.admission,
      "prepared-delete-journal-enumerate",
      () => fs.readdir(procPath(bundles!.handle)),
    );
    for (const leaf of leaves.sort(rawCompare)) {
      const match =
        /^delete-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
          leaf,
        );
      if (match === null) continue;
      const operationId = match[1]!;
      const opened = await openPreparedDeletionDirectory(
        record.anchored,
        bundles.handle,
        leaf,
      );
      let handedOff = false;
      try {
        let manifest: PreparedDeletionManifestV1;
        try {
          manifest = await readPreparedDeletionManifest(
            record.anchored,
            opened.handle,
            operationId,
          );
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          const entries = await fs.readdir(procPath(opened.handle));
          if (
            entries.some(
              entry =>
                entry !== ".manifest.next" && entry !== "manifest.json",
            )
          ) {
            throw atomicFailure(
              "prepared deletion journal authority is missing",
            );
          }
          await fs.unlink(procPath(opened.handle, ".manifest.next")).catch(
            unlinkError => {
              if (
                !isNodeError(unlinkError) ||
                unlinkError.code !== "ENOENT"
              ) {
                throw unlinkError;
              }
            },
          );
          await opened.handle.close();
          await fs.rmdir(procPath(bundles.handle, leaf));
          await bundles.handle.sync();
          continue;
        }
        handedOff = true;
        await executePreparedDeletionJournal(
          record.anchored,
          bundles.handle,
          opened.handle,
          leaf,
          manifest,
        );
      } finally {
        if (!handedOff) {
          await opened.handle.close().catch(() => undefined);
        }
      }
    }
  } finally {
    await bundles?.handle.close().catch(() => undefined);
    await staging?.handle.close().catch(() => undefined);
  }
}

async function recoverAtomicDurablePublicationsBeforeTask3(
  root: AnchoredProfileRoot,
  request: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
  observability: AtomicPublicationObservability | null,
): Promise<void> {
  await recoverPreparedDeletionJournals(root);
  const binding: ReadyProfileRootBinding = Object.freeze({
    processNonce: request.processNonce,
    controlGenerationNonce: request.controlGenerationNonce,
    snapshotDigest: request.snapshotDigest,
  });
  let intents: readonly AtomicDiscoveredDurableIntent[];
  try {
    intents = await discoverAtomicDurablePublicationIntents(root, binding);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  for (const durable of intents) {
    const intent = durable.intent;
    const topology = await observeAtomicStartupRecoveryTopology(
      root,
      durable,
    );
    const staleBinding = !sameReadyBinding(intent.binding, binding);
    const recoveryBinding: ReadyProfileRootBinding = Object.freeze({
      ...intent.binding,
    });
    const targetPath =
      intent.target.kind === "profile_state"
        ? `profiles/${intent.target.profileId}/${intent.target.state}/${intent.target.generationId}`
        : intent.target.kind === "profile"
          ? `profiles/${intent.target.profileId}`
          : null;
    const authorizedByFreshSnapshot =
      targetPath !== null &&
      intent.privateSource !== null &&
      request.references.some(
        reference =>
          reference.kind === "profile_generation" &&
          reference.path === targetPath &&
          reference.checksum === intent.privateSource!.checksum,
      );
    const durablyAdopted =
      intent.phase === "adopted" ||
      intent.adoption !== null ||
      intent.cleanup?.outcome === "adopted";
    const reducerAuthorized =
      !staleBinding &&
      (authorizedByFreshSnapshot ||
        intent.kind === "scaffold" ||
        durablyAdopted);
    const decision = reduceAtomicStartupRecoveryV1({
      kind: intent.kind,
      phase: intent.phase,
      classification: intent.classification?.outcome ?? null,
      authorizedByFreshSnapshot: reducerAuthorized,
      topology,
    });
    filesystemTestContext
      .getStore()
      ?.atomicStartupRecoveryDecision?.(
        durable.operationId,
        topology,
        decision,
      );
    if (decision.kind === "fail_stop") {
      observability?.count(
        decision.reason === "orphan_temp"
          ? "orphan_temp"
          : decision.reason === "ambiguous"
            ? "ambiguous"
            : "binding_invalid",
      );
      throw atomicFailure(
        `atomic startup recovery fail-stopped: ${decision.reason}`,
      );
    }
    const reducerDisposition =
      decision.kind === "recover_published"
        ? decision.disposition
        : decision.kind === "resume_cleanup"
          ? reducerAuthorized
            ? ("adopt" as const)
            : ("release_to_reconciliation" as const)
          : null;
    if (
      intent.phase === "building" ||
      (intent.phase === "aborting_prepublication" &&
        intent.prepublicationAbort?.from === "building")
    ) {
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        planAtomicBuildingAbortManifest,
      );
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        recoverAtomicManifestPlannedPublication,
      );
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        recoverAtomicBuildingAbortPublication,
      );
      observability?.count("recovered_unpublished");
      continue;
    }
    if (
      intent.phase === "ready" ||
      intent.phase === "classified" ||
      intent.phase === "renamed"
    ) {
      const planned = await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        lease => planAtomicEarlyProfileManifest(lease, topology),
      );
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        recoverAtomicManifestPlannedPublication,
      );
      if (planned.classification?.outcome === "published") {
        const disposition =
          reducerDisposition ??
          (decision.kind === "recover_unpublished"
            ? reducerAuthorized &&
              planned.kind !== "working" &&
              planned.kind !== "canary"
              ? ("adopt" as const)
              : ("release_to_reconciliation" as const)
            : null);
        if (disposition === null) {
          throw atomicFailure(
            "atomic startup recovery decision forbids publication",
          );
        }
        if (
          planned.kind === "scaffold" ||
          planned.kind === "working"
        ) {
          await withAtomicRecoveryLease(
            root,
            recoveryBinding,
            durable.operationId,
            lease =>
              recoverAtomicPublishedProfilePublication(lease, disposition),
          );
        } else {
          await withAtomicRecoveryLease(
            root,
            recoveryBinding,
            durable.operationId,
            lease =>
              recoverAtomicProtectedPublication(lease, disposition),
          );
        }
        observability?.count(
          disposition === "adopt"
            ? "recovered_published"
            : "recovered_unpublished",
        );
      } else {
        await withAtomicRecoveryLease(
          root,
          recoveryBinding,
          durable.operationId,
          recoverAtomicBuildingAbortPublication,
        );
        observability?.count("recovered_unpublished");
      }
      continue;
    }
    if (intent.phase === "manifest_planned") {
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        recoverAtomicManifestPlannedPublication,
      );
    }
    if (
      intent.prepublicationAbort?.from === "building" &&
      (intent.phase === "manifest_planned" ||
        intent.phase === "manifest_published")
    ) {
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        recoverAtomicBuildingAbortPublication,
      );
      observability?.count("recovered_unpublished");
      continue;
    }
    if (
      (intent.kind === "scaffold" || intent.kind === "working") &&
      intent.classification?.outcome === "published" &&
      (intent.phase === "manifest_planned" ||
        intent.phase === "manifest_published")
    ) {
      if (reducerDisposition === null) {
        throw atomicFailure(
          "atomic startup recovery decision forbids publication",
        );
      }
      const disposition = reducerDisposition;
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        lease =>
          recoverAtomicPublishedProfilePublication(lease, disposition),
      );
      observability?.count(
        disposition === "adopt"
          ? "recovered_published"
          : "recovered_unpublished",
      );
      continue;
    }
    if (
      intent.phase === "allocated" ||
      (intent.phase === "aborting_prepublication" &&
        intent.prepublicationAbort?.from === "allocated")
    ) {
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        recoverAtomicAllocatedPublication,
      );
      observability?.count("recovered_unpublished");
      continue;
    }
    if (
      intent.phase === "manifest_planned" ||
      intent.phase === "manifest_published" ||
      intent.phase === "source_deleting" ||
      intent.phase === "adopted" ||
      intent.phase === "discarding" ||
      intent.phase === "manifest_deleting" ||
      intent.phase === "cleaned"
    ) {
      if (reducerDisposition === null) {
        throw atomicFailure(
          "atomic startup recovery decision forbids protected cleanup",
        );
      }
      const disposition = reducerDisposition;
      await withAtomicRecoveryLease(
        root,
        recoveryBinding,
        durable.operationId,
        lease =>
          recoverAtomicProtectedPublication(lease, disposition),
      );
      observability?.count(
        disposition === "adopt"
          ? "recovered_published"
          : "recovered_unpublished",
      );
      continue;
    }
    if (
      intent.phase === "aborting_prepublication" ||
      intent.phase === "ready"
    ) {
      observability?.count(
        intent.classification?.outcome === "published"
          ? "ambiguous"
          : "recovered_unpublished",
      );
      throw atomicFailure(
        "atomic publication early durable phase requires protected recovery",
      );
    }
  }
}

async function recoverAtomicAllocatedPublication(
  lease: AtomicPreReadyRecoveryLeaseV1,
): Promise<void> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const intents = await getAtomicInitialControlChild(
    controller,
    lease.initialAuthority.stagingRootId,
    "intents_parent",
    "intents",
    `${operationId}:allocated-recovery:intents`,
    operationId,
  );
  const intentsRecord = resolveAtomicRecord(flight, intents.handleId);
  const snapshot = await snapshotAtomicManifestPlannedFile(
    flight,
    intentsRecord,
    `${operationId}.json`,
    ATOMIC_MAX_STABLE_OTHER_METADATA_BYTES,
    "atomic-allocated-recovery-intent",
  );
  if (snapshot === null) {
    throw atomicFailure("atomic allocated recovery intent is missing");
  }
  const parsed = parseAtomicPublishIntent(snapshot.bytes);
  if (
    parsed.operationId !== operationId ||
    (parsed.phase !== "allocated" &&
      !(
        parsed.phase === "aborting_prepublication" &&
        parsed.prepublicationAbort?.from === "allocated"
      ))
  ) {
    throw atomicFailure("atomic allocated recovery intent is invalid");
  }
  await reserveAtomicBudget(
    controller,
    `${operationId}:allocated-recovery:stable`,
    operationId,
    "stable_files",
    1,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:allocated-recovery:bytes`,
    operationId,
    "other_metadata_bytes",
    0,
    snapshot.bytes.byteLength,
  );
  flight.stableIntents.set(`${operationId}.json`, {
    contentSha256: snapshot.evidence.contentSha256!,
    intent: parsed,
  });
  const opened = await openAtomicExpectedChild(
    controller,
    `${operationId}:allocated-recovery:open`,
    operationId,
    "intent_stable",
    intents.handleId,
    `${operationId}.json`,
    snapshot.evidence,
    "file_read_nofollow",
  );
  let stable: AtomicPublishedIntentRecord = {
    intent: parsed,
    objectId: opened.handleId,
    evidence: opened.evidence,
  };
  if (stable.intent.phase === "allocated") {
    const evidenceDigest = sha256(
      JSON.stringify({
        operationId,
        from: "allocated",
        outcome: "never_attempted",
      }),
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:allocated-recovery:abort`,
      stable,
      {
        ...stable.intent,
        phase: "aborting_prepublication",
        prepublicationAbort: {
          outcome: "never_attempted",
          from: "allocated",
          evidenceDigest,
        },
        cleanup: {
          phase: "aborting_prepublication",
          outcome: "never_attempted",
          evidenceDigest,
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  stable = await createAndReplaceAtomicIntent(
    controller,
    `${operationId}:allocated-recovery:cleaned`,
    stable,
    {
      ...stable.intent,
      phase: "cleaned",
      cleanup: {
        ...stable.intent.cleanup!,
        phase: "cleaned",
        suffix: "done",
        nextIndex: 0,
      },
    },
    intents.handleId,
    intents.evidence,
  );
  await runAtomicRequest(
    controller,
    `${operationId}:allocated-recovery:remove-intent`,
    {
      kind: "remove_intent",
      operationId,
      stableParentId: intents.handleId,
      stableLeaf: `${operationId}.json`,
      stableObjectId: stable.objectId,
      expectedStable: stable.evidence,
    },
    [intents.handleId, stable.objectId],
  );
  await closeAndReleaseAtomicRecord(
    controller,
    `${operationId}:allocated-recovery:close-intent`,
    operationId,
    "intent_stable",
    stable.objectId,
    stable.evidence,
    { kind: "stable_files", count: 1, byteSize: 0 },
  );
  await releaseAtomicBudget(
    controller,
    `${operationId}:allocated-recovery:release-bytes`,
    operationId,
    "other_metadata_bytes",
    0,
    stable.evidence.size,
  );
}

async function recoverAtomicBuildingAbortPublication(
  lease: AtomicPreReadyRecoveryLeaseV1,
): Promise<void> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const authority = await loadAtomicDurablePublicationAuthority(lease);
  let stable = authority.stable;
  const manifest = authority.manifest;
  const cleanupOutcome =
    stable.intent.prepublicationAbort?.from === "building"
      ? ("never_attempted" as const)
      : stable.intent.classification?.outcome === "unpublished"
        ? ("unpublished" as const)
        : stable.intent.classification?.outcome === "conflict"
          ? ("conflict" as const)
          : null;
  const privateRecoverySource = atomicPrivateRecoverySource(stable.intent);
  const privateEntries =
    manifest?.entries.filter(
      entry => entry.scope === privateRecoverySource.scope,
    ) ?? [];
  const intentTempEntries =
    manifest?.entries.filter(entry => entry.scope === "intent_temp") ?? [];
  if (
    stable.intent.phase !== "manifest_published" ||
    cleanupOutcome === null ||
    (cleanupOutcome === "never_attempted"
      ? stable.intent.cleanup?.outcome !== "never_attempted"
      : stable.intent.cleanup !== null) ||
    manifest === null ||
    authority.manifestObjectId === null ||
    authority.manifestEvidence === null ||
    manifest.entries.some(
      entry =>
        entry.scope !== privateRecoverySource.scope &&
        entry.scope !== "intent_temp",
    ) ||
    [...privateEntries, ...intentTempEntries].some(
      (entry, index) => entry.index !== index,
    )
  ) {
    throw atomicFailure("atomic building abort authority is invalid");
  }
  const wrapperExpected = stable.intent.wrapper;
  if (wrapperExpected === null) {
    throw atomicFailure("atomic building abort wrapper is missing");
  }
  await reserveAtomicBudget(
    controller,
    `${operationId}:building-abort:scratch-entries`,
    operationId,
    "scratch_entries",
    2,
    0,
  );
  const children = privateEntries.filter(
    entry => entry.path !== privateRecoverySource.prefix,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:building-abort:payload-entries`,
    operationId,
    "payload_entries",
    children.length,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:building-abort:payload-bytes`,
    operationId,
    "payload_bytes",
    0,
    children.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.size : 0),
      0,
    ),
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:building-abort:intent-temp-files`,
    operationId,
    "scratch_files",
    intentTempEntries.length,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:building-abort:intent-temp-bytes`,
    operationId,
    "other_metadata_bytes",
    0,
    intentTempEntries.reduce((total, entry) => total + entry.size, 0),
  );
  const wrapperLocation = await observeAtomicContinuationDirectory(
    flight,
    resolveAtomicRecord(flight, authority.bundles.handleId),
    operationId,
    "atomic-building-abort-wrapper",
  );
  if (
    wrapperLocation.state !== "present" ||
    wrapperLocation.evidence!.dev !== wrapperExpected.dev ||
    wrapperLocation.evidence!.ino !== wrapperExpected.ino ||
    wrapperLocation.evidence!.mode !== wrapperExpected.mode
  ) {
    throw atomicFailure("atomic building abort wrapper identity mismatched");
  }
  const wrapper = await openAtomicExpectedChild(
    controller,
    `${operationId}:building-abort:open-wrapper`,
    operationId,
    "wrapper",
    authority.bundles.handleId,
    operationId,
    wrapperLocation.evidence!,
    "directory_nofollow",
  );
  const openedByPath = new Map<
    string,
    Readonly<{
      objectId: FlightSemanticId;
      evidence: AtomicObjectEvidenceV1;
      role: "private_source" | "payload_entry";
    }>
  >();
  for (const entry of [...privateEntries].sort((left, right) => {
    const depth = left.path.split("/").length - right.path.split("/").length;
    return depth !== 0 ? depth : rawCompare(left.path, right.path);
  })) {
    const isRoot = entry.path === privateRecoverySource.prefix;
    const separator = entry.path.lastIndexOf("/");
    const parentId = isRoot
      ? wrapper.handleId
      : openedByPath.get(entry.path.slice(0, separator))?.objectId;
    if (parentId === undefined) {
      throw atomicFailure("atomic building abort parent is missing");
    }
    const opened = await openAtomicExpectedChild(
      controller,
      `${operationId}:building-abort:open:${entry.index}`,
      operationId,
      isRoot ? "private_source" : "payload_entry",
      parentId,
      isRoot ? privateRecoverySource.leaf : entry.path.slice(separator + 1),
      atomicEvidenceFromManifestEntry(entry),
      entry.type === "directory"
        ? "directory_nofollow"
        : "file_read_nofollow",
    );
    openedByPath.set(entry.path, {
      objectId: opened.handleId,
      evidence: opened.evidence,
      role: isRoot ? "private_source" : "payload_entry",
    });
  }
  stable = await createAndReplaceAtomicIntent(
    controller,
    `${operationId}:building-abort:discarding`,
    stable,
    {
      ...stable.intent,
      phase: "discarding",
      cleanup: {
        phase: "discarding",
        outcome: cleanupOutcome,
        evidenceDigest:
          stable.intent.cleanup?.evidenceDigest ??
          sha256(
            JSON.stringify({
              operationId,
              manifestSha256: stable.intent.identityManifest!.sha256,
              outcome: cleanupOutcome,
            }),
          ),
        suffix: "private_source_entries",
        nextIndex: 0,
      },
    },
    authority.intents.handleId,
    authority.intents.evidence,
  );
  const entryDigests = manifest.entries.map((entry, index) =>
    sha256(JSON.stringify({ index, entry })),
  );
  const entryCounts = {
    privateSourceEntries: privateEntries.length,
    wrapperTemps: 0,
    intentTemps: intentTempEntries.length,
  } as const;
  for (const [logicalIndex, entry] of privateEntries.entries()) {
    const opened = openedByPath.get(entry.path);
    if (opened === undefined) {
      throw atomicFailure("atomic building abort entry is missing");
    }
    const isRoot = entry.path === privateRecoverySource.prefix;
    const separator = entry.path.lastIndexOf("/");
    const parentId = isRoot
      ? wrapper.handleId
      : openedByPath.get(entry.path.slice(0, separator))?.objectId;
    if (parentId === undefined) {
      throw atomicFailure("atomic building abort deletion parent is missing");
    }
    const result = await executeAtomicProtectedCleanupEntry(
      controller,
      stable,
      authority.intents,
      createAtomicProtectedCleanupState({
        operationId,
        manifestSha256: stable.intent.identityManifest!.sha256,
        entryCount: manifest.entries.length,
        entryCounts,
        entryDigests,
        cursor: logicalIndex,
        suffix: "private_source_entries",
      }),
      {
        operationId,
        manifestSha256: stable.intent.identityManifest!.sha256,
        index: logicalIndex,
        suffix: "private_source_entries",
        scope: privateRecoverySource.scope,
        entryDigest: entryDigests[logicalIndex]!,
        requestKind: isRoot
          ? "remove_root"
          : entry.type === "file"
            ? "remove_file"
            : "remove_directory",
        role: opened.role,
        parentId,
        leaf: isRoot
          ? privateRecoverySource.leaf
          : entry.path.slice(separator + 1),
        objectId: opened.objectId,
        expected: opened.evidence,
        release: {
          reservation: isRoot ? "scratch_entries" : "payload_entries",
          count: 1,
          byteSize: entry.type === "file" ? entry.size : 0,
        },
      },
      true,
      "cleanup",
    );
    stable = result.stable;
  }
  for (
    let cursor = privateEntries.length;
    cursor < manifest.entries.length;
    cursor += 1
  ) {
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:building-abort:private-padding:${cursor + 1}`,
      stable,
      "private_source_entries",
      cursor + 1,
      authority.intents.handleId,
      authority.intents.evidence,
    );
  }
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:building-abort:private-source-root`,
    stable,
    "private_source_root",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:building-abort:wrapper-temps`,
    stable,
    "wrapper_temps",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  for (let cursor = 0; cursor < manifest.entries.length; cursor += 1) {
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:building-abort:wrapper-padding:${cursor + 1}`,
      stable,
      "wrapper_temps",
      cursor + 1,
      authority.intents.handleId,
      authority.intents.evidence,
    );
  }
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:building-abort:wrapper-root`,
    stable,
    "wrapper_root",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  await runAtomicRequest(
    controller,
    `${operationId}:building-abort:remove-wrapper`,
    {
      kind: "remove_root",
      operationId,
      role: "wrapper",
      parentId: authority.bundles.handleId,
      leaf: operationId,
      objectId: wrapper.handleId,
      expected: wrapper.evidence,
      manifestSha256: stable.intent.identityManifest!.sha256,
      cursor: 0,
    },
    [authority.bundles.handleId, wrapper.handleId],
  );
  await closeAndReleaseAtomicRecord(
    controller,
    `${operationId}:building-abort:close-wrapper`,
    operationId,
    "wrapper",
    wrapper.handleId,
    wrapper.evidence,
    { kind: "scratch_entries", count: 1, byteSize: 0 },
  );
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:building-abort:intent-temps`,
    stable,
    "intent_temps",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  let intentCursor = 0;
  for (const entry of intentTempEntries) {
    while (intentCursor < entry.index) {
      intentCursor += 1;
      stable = await replaceAtomicCleanupCursor(
        controller,
        `${operationId}:building-abort:intent-padding:${intentCursor}`,
        stable,
        "intent_temps",
        intentCursor,
        authority.intents.handleId,
        authority.intents.evidence,
      );
    }
    const opened = await openAtomicExpectedChild(
      controller,
      `${operationId}:building-abort:open-intent-temp:${entry.index}`,
      operationId,
      "intent_temp",
      authority.intents.handleId,
      entry.path,
      atomicEvidenceFromManifestEntry(entry),
      "file_read_nofollow",
    );
    const result = await executeAtomicProtectedCleanupEntry(
      controller,
      stable,
      authority.intents,
      createAtomicProtectedCleanupState({
        operationId,
        manifestSha256: stable.intent.identityManifest!.sha256,
        entryCount: manifest.entries.length,
        entryCounts,
        entryDigests,
        cursor: entry.index,
        suffix: "intent_temps",
      }),
      {
        operationId,
        manifestSha256: stable.intent.identityManifest!.sha256,
        index: entry.index,
        suffix: "intent_temps",
        scope: "intent_temp",
        entryDigest: entryDigests[entry.index]!,
        requestKind: "remove_file",
        role: "intent_temp",
        parentId: authority.intents.handleId,
        leaf: entry.path,
        objectId: opened.handleId,
        expected: opened.evidence,
        release: {
          reservation: "scratch_files",
          count: 1,
          byteSize: entry.size,
        },
      },
      true,
      "cleanup",
    );
    stable = result.stable;
    intentCursor = entry.index + 1;
  }
  while (intentCursor < manifest.entries.length) {
    intentCursor += 1;
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:building-abort:intent-padding:${intentCursor}`,
      stable,
      "intent_temps",
      intentCursor,
      authority.intents.handleId,
      authority.intents.evidence,
    );
  }
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:building-abort:done`,
    stable,
    "done",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  await executeAtomicProtectedCleanupTerminal(
    controller,
    createAtomicProtectedCleanupState({
      operationId,
      manifestSha256: stable.intent.identityManifest!.sha256,
      entryCount: manifest.entries.length,
      entryCounts,
      entryDigests,
      cursor: manifest.entries.length,
      suffix: "done",
    }),
    stable,
    authority.intents,
    {
      objectId: authority.manifestObjectId,
      evidence: authority.manifestEvidence,
    },
  );
}

async function recoverAtomicPublishedProfilePublication(
  lease: AtomicPreReadyRecoveryLeaseV1,
  disposition: "adopt" | "release_to_reconciliation",
): Promise<void> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const authority = await loadAtomicDurablePublicationAuthority(lease);
  let stable = authority.stable;
  const manifest = authority.manifest;
  if (
    stable.intent.phase !== "manifest_published" ||
    stable.intent.classification?.outcome !== "published" ||
    (stable.intent.kind !== "scaffold" &&
      stable.intent.kind !== "working") ||
    manifest === null ||
    authority.manifestObjectId === null ||
    authority.manifestEvidence === null ||
    manifest.entries.some(
      entry => entry.scope !== "private_profile_payload",
    )
  ) {
    throw atomicFailure("atomic published profile authority is invalid");
  }
  await reserveAtomicBudget(
    controller,
    `${operationId}:published-profile:scratch`,
    operationId,
    "scratch_entries",
    2,
    0,
  );
  await reserveAtomicBudget(
    controller,
    `${operationId}:published-profile:payload`,
    operationId,
    "payload_entries",
    4,
    0,
  );
  const wrapperExpected = stable.intent.wrapper!;
  const wrapperLocation = await observeAtomicContinuationDirectory(
    flight,
    resolveAtomicRecord(flight, authority.bundles.handleId),
    operationId,
    "atomic-published-profile-wrapper",
  );
  if (
    wrapperLocation.state !== "present" ||
    wrapperLocation.evidence!.dev !== wrapperExpected.dev ||
    wrapperLocation.evidence!.ino !== wrapperExpected.ino
  ) {
    throw atomicFailure("atomic published profile wrapper drifted");
  }
  const wrapper = await openAtomicExpectedChild(
    controller,
    `${operationId}:published-profile:open-wrapper`,
    operationId,
    "wrapper",
    authority.bundles.handleId,
    operationId,
    wrapperLocation.evidence!,
    "directory_nofollow",
  );
  const targetParent = await openAtomicRecoveryTargetParent(
    lease,
    stable.intent,
  );
  const rootEntry = manifest.entries.find(
    entry =>
      entry.scope === "private_profile_payload" &&
      entry.path === "payload",
  );
  if (rootEntry === undefined || stable.intent.target.kind === "canary_parent") {
    throw atomicFailure("atomic published profile target is unbound");
  }
  const target = await openAtomicExpectedChild(
    controller,
    `${operationId}:published-profile:open-target`,
    operationId,
    "public_target",
    targetParent.handleId,
    stable.intent.target.leaf,
    atomicEvidenceFromManifestEntry(rootEntry),
    "directory_nofollow",
  );
  const targetRecord = resolveAtomicRecord(flight, target.handleId);
  await atomicRecoveryTreeEntries(
    flight,
    { handle: targetRecord.handle, stat: targetRecord.stat },
    "private_profile_payload",
    "payload",
    stable.intent.privateSource!.checksum,
    stable.intent.privateSource!.byteSize,
  );
  if (disposition === "adopt") {
    const adoption = {
      authority:
        stable.intent.kind === "scaffold"
          ? ("scaffold" as const)
          : ("registry" as const),
      authorityDigest: sha256(
        JSON.stringify({
          operationId,
          binding: stable.intent.binding,
          target: publicationTargetLocatorDigest(stable.intent.target),
        }),
      ),
    };
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:published-profile:adopted`,
      stable,
      { ...stable.intent, phase: "adopted", adoption },
      authority.intents.handleId,
      authority.intents.evidence,
    );
    if (
      stable.intent.kind === "working" &&
      stable.intent.target.kind === "profile_state"
    ) {
      adoptAtomicPublishedGeneration(
        controller,
        target.handleId,
        {
          profileId: stable.intent.target.profileId,
          state: stable.intent.target.state,
          generationId: stable.intent.target.generationId,
        },
        operationId,
      );
    }
  }
  const outcome =
    disposition === "adopt"
      ? ("adopted" as const)
      : ("released_to_reconciliation" as const);
  stable = await createAndReplaceAtomicIntent(
    controller,
    `${operationId}:published-profile:discarding`,
    stable,
    {
      ...stable.intent,
      phase: "discarding",
      cleanup: {
        phase: "discarding",
        outcome,
        evidenceDigest: sha256(
          JSON.stringify({
            operationId,
            manifestSha256: stable.intent.identityManifest!.sha256,
            outcome,
          }),
        ),
        suffix: "private_source_entries",
        nextIndex: 0,
      },
    },
    authority.intents.handleId,
    authority.intents.evidence,
  );
  for (let cursor = 0; cursor < manifest.entries.length; cursor += 1) {
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:published-profile:private:${cursor + 1}`,
      stable,
      "private_source_entries",
      cursor + 1,
      authority.intents.handleId,
      authority.intents.evidence,
    );
  }
  for (const suffix of ["private_source_root", "wrapper_temps"] as const) {
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:published-profile:${suffix}`,
      stable,
      suffix,
      0,
      authority.intents.handleId,
      authority.intents.evidence,
    );
  }
  for (let cursor = 0; cursor < manifest.entries.length; cursor += 1) {
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:published-profile:wrapper-temp:${cursor + 1}`,
      stable,
      "wrapper_temps",
      cursor + 1,
      authority.intents.handleId,
      authority.intents.evidence,
    );
  }
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:published-profile:wrapper-root`,
    stable,
    "wrapper_root",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  await runAtomicRequest(
    controller,
    `${operationId}:published-profile:remove-wrapper`,
    {
      kind: "remove_root",
      operationId,
      role: "wrapper",
      parentId: authority.bundles.handleId,
      leaf: operationId,
      objectId: wrapper.handleId,
      expected: wrapper.evidence,
      manifestSha256: stable.intent.identityManifest!.sha256,
      cursor: 0,
    },
    [authority.bundles.handleId, wrapper.handleId],
  );
  await closeAndReleaseAtomicRecord(
    controller,
    `${operationId}:published-profile:close-wrapper`,
    operationId,
    "wrapper",
    wrapper.handleId,
    wrapper.evidence,
    { kind: "scratch_entries", count: 1, byteSize: 0 },
  );
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:published-profile:intent-temps`,
    stable,
    "intent_temps",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  for (let cursor = 0; cursor < manifest.entries.length; cursor += 1) {
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:published-profile:intent-temp:${cursor + 1}`,
      stable,
      "intent_temps",
      cursor + 1,
      authority.intents.handleId,
      authority.intents.evidence,
    );
  }
  stable = await replaceAtomicCleanupCursor(
    controller,
    `${operationId}:published-profile:done`,
    stable,
    "done",
    0,
    authority.intents.handleId,
    authority.intents.evidence,
  );
  await executeAtomicProtectedCleanupTerminal(
    controller,
    createAtomicProtectedCleanupState({
      operationId,
      manifestSha256: stable.intent.identityManifest!.sha256,
      entryCount: manifest.entries.length,
      entryCounts: {
        privateSourceEntries: manifest.entries.length,
        wrapperTemps: 0,
        intentTemps: 0,
      },
      entryDigests: manifest.entries.map((entry, index) =>
        sha256(JSON.stringify({ index, entry })),
      ),
      cursor: manifest.entries.length,
      suffix: "done",
    }),
    stable,
    authority.intents,
    {
      objectId: authority.manifestObjectId,
      evidence: authority.manifestEvidence,
    },
  );
}

type AtomicContinuationDirectoryLocationV1 = Readonly<{
  state: "absent" | "present";
  evidence: AtomicObjectEvidenceV1 | null;
}>;

async function observeAtomicContinuationDirectory(
  flight: AtomicEffectFlightRecord,
  parent: AtomicHeldRecord,
  leaf: string,
  point: string,
): Promise<AtomicContinuationDirectoryLocationV1> {
  let before: BigIntStats;
  try {
    before = await atomicAwait(flight, [parent], `${point}:lstat`, () =>
      fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return Object.freeze({ state: "absent", evidence: null });
    }
    throw error;
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.nlink <= 0n ||
    before.uid !== atomicEffectiveUid() ||
    lowModeBigint(before.mode) !== 0o700
  ) {
    throw atomicFailure("atomic continuation directory is invalid");
  }
  let handle: FileHandle | null = await atomicAwait(
    flight,
    [parent],
    `${point}:open`,
    () =>
      fs.open(
        procPath(parent.handle, leaf),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
  );
  try {
    const after = await atomicAwait(
      flight,
      [parent],
      `${point}:fstat`,
      () => handle!.stat({ bigint: true }),
    );
    const rebound = await atomicAwait(
      flight,
      [parent],
      `${point}:relstat`,
      () => fs.lstat(procPath(parent.handle, leaf), { bigint: true }),
    );
    assertAtomicStat(
      before,
      after,
      "atomic continuation directory binding changed",
    );
    assertAtomicStat(
      before,
      rebound,
      "atomic continuation directory location changed",
    );
    return Object.freeze({
      state: "present",
      evidence: atomicEvidenceFromStat(before),
    });
  } finally {
    if (handle !== null) {
      const retained = handle;
      await atomicVerifiedClose(
        flight,
        [parent],
        `${point}:close`,
        () => retained.close(),
        () => {
          handle = null;
        },
      );
    }
  }
}

type AtomicContinuationProfileAuthorityV1 = Readonly<{
  profile: Extract<
    AtomicEffectObservationV1,
    { kind: "existing_handle_pinned" }
  >;
  targetState: Extract<
    AtomicEffectObservationV1,
    { kind: "existing_handle_pinned" }
  >;
  target: Extract<
    AtomicEffectObservationV1,
    { kind: "existing_handle_pinned" }
  >;
  sourceState: Extract<
    AtomicEffectObservationV1,
    { kind: "existing_handle_pinned" }
  >;
}>;

async function openAtomicContinuationProfileAuthority(
  lease: AtomicPreReadyRecoveryLeaseV1,
  intent: AtomicPublishIntentV1,
  manifest: CleanupIdentityManifestV1 | null,
): Promise<AtomicContinuationProfileAuthorityV1> {
  if (
    intent.target.kind !== "profile_state" ||
    intent.publicSource === null ||
    intent.privateSource === null
  ) {
    throw atomicFailure("atomic continuation profile intent is invalid");
  }
  const targetLocator = intent.target;
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = intent.operationId;
  const profilesRecord = resolveAtomicRecord(
    flight,
    lease.initialAuthority.profilesParentId,
  );
  const profileStat = await atomicAwait(
    flight,
    [profilesRecord],
    "atomic-continuation-profile-stat",
    () =>
      fs.lstat(
        procPath(profilesRecord.handle, targetLocator.profileId),
        { bigint: true },
      ),
  );
  const profile = await openAtomicExpectedChild(
    controller,
    `${operationId}:continuation:profile`,
    operationId,
    "public_target",
    lease.initialAuthority.profilesParentId,
    targetLocator.profileId,
    atomicEvidenceFromStat(profileStat),
    "directory_nofollow",
  );
  const targetState = await openAtomicExpectedChild(
    controller,
    `${operationId}:continuation:target-state`,
    operationId,
    "public_target",
    profile.handleId,
    targetLocator.state,
    atomicEvidenceFromStat(
      await fs.lstat(
        procPath(
          resolveAtomicRecord(flight, profile.handleId).handle,
          targetLocator.state,
        ),
        { bigint: true },
      ),
    ),
    "directory_nofollow",
  );
  if (
    targetState.evidence.dev !== targetLocator.parent.dev ||
    targetState.evidence.ino !== targetLocator.parent.ino
  ) {
    throw atomicFailure("atomic continuation target parent drifted");
  }
  const payloadRoot = manifest?.entries.find(
    entry =>
      entry.scope === "private_profile_payload" && entry.path === "payload",
  );
  const targetStateRecord = resolveAtomicRecord(
    flight,
    targetState.handleId,
  );
  const targetStat =
    payloadRoot === undefined
      ? await atomicAwait(
          flight,
          [targetStateRecord],
          "atomic-continuation-target-stat",
          () =>
            fs.lstat(
              procPath(targetStateRecord.handle, targetLocator.leaf),
              { bigint: true },
            ),
        )
      : null;
  const targetEvidence =
    payloadRoot === undefined
      ? atomicEvidenceFromStat(
          { ...targetStat!, size: 0n } as BigIntStats,
        )
      : atomicEvidenceFromManifestEntry(payloadRoot);
  if (
    targetEvidence.dev !== intent.privateSource.dev ||
    targetEvidence.ino !== intent.privateSource.ino ||
    targetEvidence.mode !== intent.privateSource.mode
  ) {
    throw atomicFailure("atomic continuation target identity is missing");
  }
  const target = await openAtomicExpectedChild(
    controller,
    `${operationId}:continuation:target`,
    operationId,
    "public_target",
    targetState.handleId,
    targetLocator.leaf,
    targetEvidence,
    "directory_nofollow",
  );
  const targetRecord = resolveAtomicRecord(flight, target.handleId);
  await atomicRecoveryTreeEntries(
    flight,
    { handle: targetRecord.handle, stat: targetRecord.stat },
    "private_profile_payload",
    "payload",
    intent.privateSource.checksum,
    intent.privateSource.byteSize,
  );
  const sourceStateName = intent.publicSource.state;
  const sourceState = await openAtomicExpectedChild(
    controller,
    `${operationId}:continuation:source-state`,
    operationId,
    "public_target",
    profile.handleId,
    sourceStateName,
    atomicEvidenceFromStat(
      await fs.lstat(
        procPath(
          resolveAtomicRecord(flight, profile.handleId).handle,
          sourceStateName,
        ),
        { bigint: true },
      ),
    ),
    "directory_nofollow",
  );
  return Object.freeze({ profile, targetState, target, sourceState });
}

export type AtomicProtectedPublicationRecoveryResultV1 = Readonly<{
  sealed: true;
  operationId: string;
  phase: "cleaned";
}>;

async function executeAtomicProtectedPublicationRecovery(
  lease: AtomicPreReadyRecoveryLeaseV1,
  disposition: "adopt" | "release_to_reconciliation" = "adopt",
): Promise<AtomicProtectedPublicationRecoveryResultV1> {
  const controller = lease.controller;
  const flight = requireAtomicFlight(controller);
  const operationId = flight.operationId;
  const authority = await loadAtomicDurablePublicationAuthority(lease);
  let stable = authority.stable;
  const intents = authority.intents;
  const manifest = authority.manifest;
  const manifestSha256 = stable.intent.identityManifest!.sha256;
  if (
    stable.intent.phase === "cleaned" ||
    (stable.intent.phase === "manifest_deleting" &&
      manifest === null)
  ) {
    const cleanedProfile = await openAtomicContinuationProfileAuthority(
      lease,
      stable.intent,
      null,
    );
    const cleanedPublicSource = stable.intent.publicSource;
    if (cleanedPublicSource === null) {
      throw atomicFailure("atomic cleaned source locator is invalid");
    }
    const cleanedSourceLocation =
      await observeAtomicContinuationDirectory(
        flight,
        resolveAtomicRecord(
          flight,
          cleanedProfile.sourceState.handleId,
        ),
        cleanedPublicSource.generationId,
        "atomic-continuation-cleaned-source",
      );
    const cleanedWrapperLocation =
      await observeAtomicContinuationDirectory(
        flight,
        resolveAtomicRecord(flight, authority.bundles.handleId),
        operationId,
        "atomic-continuation-cleaned-wrapper",
      );
    if (
      cleanedSourceLocation.state !== "absent" ||
      cleanedWrapperLocation.state !== "absent"
    ) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw atomicFailure("atomic cleaned continuation is ambiguous");
    }
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:continuation:close-cleaned-source-state`,
      operationId,
      "public_target",
      cleanedProfile.sourceState.handleId,
      cleanedProfile.sourceState.evidence,
      undefined,
    );
    if (
      disposition === "adopt" &&
      !flight.root.sealedGenerations.has(operationId)
    ) {
      if (stable.intent.target.kind !== "profile_state") {
        throw atomicFailure("atomic cleaned target locator is invalid");
      }
      adoptAtomicPublishedGeneration(
        controller,
        cleanedProfile.target.handleId,
        {
          profileId: stable.intent.target.profileId,
          state: stable.intent.target.state,
          generationId: stable.intent.target.generationId,
        },
        operationId,
      );
    }
    if (stable.intent.phase === "manifest_deleting") {
      await syncAtomicHeld(
        controller,
        `${operationId}:continuation:missing-manifest-parent-sync`,
        operationId,
        "fsync_parent",
        "intents_parent",
        intents.handleId,
        intents.evidence,
      );
      stable = await createAndReplaceAtomicIntent(
        controller,
        `${operationId}:continuation:missing-manifest-cleaned`,
        stable,
        { ...stable.intent, phase: "cleaned" },
        intents.handleId,
        intents.evidence,
      );
    }
    await runAtomicRequest(
      controller,
      `${operationId}:continuation:remove-cleaned-intent`,
      {
        kind: "remove_intent",
        operationId,
        stableParentId: intents.handleId,
        stableLeaf: `${operationId}.json`,
        stableObjectId: stable.objectId,
        expectedStable: stable.evidence,
      },
      [intents.handleId, stable.objectId],
    );
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:continuation:close-cleaned-intent`,
      operationId,
      "intent_stable",
      stable.objectId,
      stable.evidence,
      { kind: "stable_files", count: 1, byteSize: 0 },
    );
    await releaseAtomicBudget(
      controller,
      `${operationId}:continuation:release-cleaned-intent`,
      operationId,
      "other_metadata_bytes",
      0,
      stable.evidence.size,
    );
    return Object.freeze({ sealed: true, operationId, phase: "cleaned" });
  }
  if (manifest === null) {
    throw atomicFailure("atomic continuation manifest authority is missing");
  }
  const profileAuthority = await openAtomicContinuationProfileAuthority(
    lease,
    stable.intent,
    manifest,
  );
  const bundlesRecord = resolveAtomicRecord(
    flight,
    authority.bundles.handleId,
  );
  const wrapperLocation = await observeAtomicContinuationDirectory(
    flight,
    bundlesRecord,
    operationId,
    "atomic-continuation-wrapper",
  );
  const wrapperExpected = stable.intent.wrapper;
  if (
    wrapperLocation.state === "present" &&
    (wrapperExpected === null ||
      wrapperLocation.evidence!.dev !== wrapperExpected.dev ||
      wrapperLocation.evidence!.ino !== wrapperExpected.ino ||
      wrapperLocation.evidence!.mode !== wrapperExpected.mode)
  ) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw atomicFailure("atomic continuation wrapper identity mismatched");
  }
  await reserveAtomicBudget(
    controller,
    `${operationId}:continuation:scratch-entries`,
    operationId,
    "scratch_entries",
    2,
    0,
  );
  const wrapper =
    wrapperLocation.state === "absent"
      ? null
      : await openAtomicExpectedChild(
          controller,
          `${operationId}:continuation:open-wrapper`,
          operationId,
          "wrapper",
          authority.bundles.handleId,
          operationId,
          wrapperLocation.evidence!,
          "directory_nofollow",
        );
  const publicSource = stable.intent.publicSource;
  const sourceDeletion = stable.intent.sourceDeletion;
  const sourceRootEntry = manifest.entries.find(
    entry => entry.scope === "public_source" && entry.path === "source",
  );
  if (
    publicSource === null ||
    sourceRootEntry === undefined ||
    (stable.intent.phase === "source_deleting" && sourceDeletion === null)
  ) {
    throw atomicFailure("atomic continuation source authority is invalid");
  }
  const expectedSourceEvidence = atomicEvidenceFromManifestEntry(
    sourceRootEntry,
  );
  if (
    expectedSourceEvidence.dev !== publicSource.dev ||
    expectedSourceEvidence.ino !== publicSource.ino ||
    expectedSourceEvidence.mode !== publicSource.mode
  ) {
    throw atomicFailure("atomic continuation source identity mismatched");
  }
  const sourceStateRecord = resolveAtomicRecord(
    flight,
    profileAuthority.sourceState.handleId,
  );
  const publicLocation = await observeAtomicContinuationDirectory(
    flight,
    sourceStateRecord,
    publicSource.generationId,
    "atomic-continuation-public-source",
  );
  const privateLocation =
    wrapper === null
      ? Object.freeze({
          state: "absent" as const,
          evidence: null,
        })
      : await observeAtomicContinuationDirectory(
          flight,
          resolveAtomicRecord(flight, wrapper.handleId),
          sourceDeletion?.privateDeletionLeaf ??
            `delete-${operationId}`,
          "atomic-continuation-private-source",
        );
  for (const location of [publicLocation, privateLocation]) {
    if (
      location.state === "present" &&
      (location.evidence!.dev !== expectedSourceEvidence.dev ||
        location.evidence!.ino !== expectedSourceEvidence.ino ||
        location.evidence!.mode !== expectedSourceEvidence.mode ||
        location.evidence!.contentSha256 !== null)
    ) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw atomicFailure("atomic continuation source location mismatched");
    }
  }
  if (
    publicLocation.state === "present" &&
    privateLocation.state === "present"
  ) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw atomicFailure("atomic protected source move is ambiguous");
  }
  let publicSourceOpened =
    publicLocation.state === "present"
      ? await openAtomicExpectedChild(
          controller,
          `${operationId}:continuation:open-public-source`,
          operationId,
          "public_source",
          profileAuthority.sourceState.handleId,
          publicSource.generationId,
          publicLocation.evidence!,
          "directory_nofollow",
        )
      : null;
  let privateSourceOpened =
    privateLocation.state === "present" && wrapper !== null
      ? await openAtomicExpectedChild(
          controller,
          `${operationId}:continuation:open-private-source`,
          operationId,
          "private_deletion",
          wrapper.handleId,
          sourceDeletion?.privateDeletionLeaf ??
            `delete-${operationId}`,
          privateLocation.evidence!,
          "directory_nofollow",
        )
      : null;

  if (stable.intent.phase === "manifest_published") {
    const deletionDigest = sha256(
      JSON.stringify({
        operationId,
        manifestSha256,
        publicSource,
        privateDeletionLeaf: `delete-${operationId}`,
      }),
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:continuation:source-pending`,
      stable,
      {
        ...stable.intent,
        phase: "source_deleting",
        sourceDeletion: {
          phase: "pending",
          privateDeletionLeaf: `delete-${operationId}`,
          evidenceDigest: deletionDigest,
          entryCount: manifest.entries.filter(
            entry => entry.scope === "public_source",
          ).length,
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  if (
    stable.intent.phase === "source_deleting" &&
    stable.intent.sourceDeletion?.phase === "pending"
  ) {
    if (
      publicSourceOpened === null &&
      privateSourceOpened === null
    ) {
      throw atomicFailure("atomic protected source move is ambiguous");
    }
    if (publicSourceOpened !== null) {
      if (wrapper === null || privateSourceOpened !== null) {
        throw atomicFailure("atomic protected source move is ambiguous");
      }
      for (const [label, role, objectId, evidence] of [
        [
          "source-parent",
          "public_target",
          profileAuthority.sourceState.handleId,
          profileAuthority.sourceState.evidence,
        ],
        [
          "private-parent",
          "wrapper",
          wrapper.handleId,
          wrapper.evidence,
        ],
      ] as const) {
        await runAtomicRequest(
          controller,
          `${operationId}:continuation:${label}:revalidate`,
          {
            kind: "revalidate_handle",
            operationId,
            role,
            objectId,
            cursor: 0,
            byteLength: 0,
            expected: evidence,
          },
          [objectId],
        );
        await runAtomicRequest(
          controller,
          `${operationId}:continuation:${label}:statfs`,
          {
            kind: "statfs_parent",
            operationId,
            role,
            objectId,
            expected: evidence,
          },
          [objectId],
        );
      }
      const moved = await runAtomicRequest(
        controller,
        `${operationId}:continuation:source-move`,
        {
          kind: "native_no_replace",
          operationId,
          move: "profile_source_to_private",
          sourceParentId: profileAuthority.sourceState.handleId,
          sourceId: publicSourceOpened.handleId,
          sourceLeaf: publicSource.generationId,
          targetParentId: wrapper.handleId,
          targetLeaf: stable.intent.sourceDeletion.privateDeletionLeaf,
          expectedSource: publicSourceOpened.evidence,
          expectedTarget: { absent: true },
          evidenceDigest: stable.intent.sourceDeletion.evidenceDigest,
        },
        [
          profileAuthority.sourceState.handleId,
          publicSourceOpened.handleId,
          wrapper.handleId,
        ],
      );
      const locations = moved.observations.find(
        (
          observation,
        ): observation is Extract<
          AtomicEffectObservationV1,
          {
            kind: "locations_observed";
            requestKind: "native_no_replace";
          }
        > =>
          observation.kind === "locations_observed" &&
          observation.requestKind === "native_no_replace",
      );
      if (
        moved.classification?.outcome !== "published" ||
        locations?.source.state !== "absent" ||
        locations.target.state !== "match" ||
        locations.targetObjectId === null ||
        locations.target.evidence === null
      ) {
        throw atomicFailure("atomic protected source move is ambiguous");
      }
      privateSourceOpened = {
        kind: "existing_handle_pinned",
        effectId: Object.freeze({}) as FlightEffectId,
        handleId: locations.targetObjectId,
        evidence: locations.target.evidence,
      };
      await closeAndReleaseAtomicRecord(
        controller,
        `${operationId}:continuation:close-public-source`,
        operationId,
        "public_source",
        publicSourceOpened.handleId,
        publicSourceOpened.evidence,
        undefined,
      );
      publicSourceOpened = null;
    }
    await syncAtomicHeld(
      controller,
      `${operationId}:continuation:source-parent-sync`,
      operationId,
      "fsync_parent",
      "public_target",
      profileAuthority.sourceState.handleId,
      profileAuthority.sourceState.evidence,
    );
    if (wrapper === null || privateSourceOpened === null) {
      throw atomicFailure("atomic continuation private source is missing");
    }
    await syncAtomicHeld(
      controller,
      `${operationId}:continuation:private-parent-sync`,
      operationId,
      "fsync_parent",
      "wrapper",
      wrapper.handleId,
      wrapper.evidence,
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:continuation:moved-private`,
      stable,
      {
        ...stable.intent,
        sourceDeletion: {
          ...stable.intent.sourceDeletion!,
          phase: "moved_private",
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  if (
    stable.intent.phase === "source_deleting" &&
    stable.intent.sourceDeletion?.phase === "moved_private"
  ) {
    if (publicSourceOpened !== null || privateSourceOpened === null) {
      throw atomicFailure("atomic continuation moved source is ambiguous");
    }
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:continuation:removing`,
      stable,
      {
        ...stable.intent,
        sourceDeletion: {
          ...stable.intent.sourceDeletion,
          phase: "removing",
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  if (
    stable.intent.phase === "source_deleting" &&
    stable.intent.sourceDeletion?.phase === "removing"
  ) {
    const cursor = stable.intent.sourceDeletion.nextIndex;
    const publicEntries = manifest.entries.filter(
      entry => entry.scope === "public_source",
    );
    const rootIndex = publicEntries.findIndex(
      entry => entry.path === "source",
    );
    if (
      cursor <= rootIndex &&
      privateSourceOpened === null
    ) {
      throw atomicFailure("atomic continuation private source is missing");
    }
    const remainingChildren = publicEntries.filter(
      (entry, logicalIndex) =>
        entry.path !== "source" &&
        logicalIndex >= Math.max(0, cursor - 1),
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:continuation:payload-entries`,
      operationId,
      "payload_entries",
      remainingChildren.length,
      0,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:continuation:payload-bytes`,
      operationId,
      "payload_bytes",
      0,
      remainingChildren.reduce(
        (total, entry) =>
          total + (entry.type === "file" ? entry.size : 0),
        0,
      ),
    );
    const openedByPath = new Map<
      string,
      AtomicProtectedOpenedRemovalV1
    >();
    if (privateSourceOpened !== null) {
      openedByPath.set("source", {
        objectId: privateSourceOpened.handleId,
        evidence: privateSourceOpened.evidence,
        role: "private_deletion",
      });
    }
    for (const entry of [...remainingChildren].sort((left, right) => {
      const difference =
        left.path.split("/").length - right.path.split("/").length;
      return difference !== 0 ? difference : rawCompare(left.path, right.path);
    })) {
      const separator = entry.path.lastIndexOf("/");
      const parent = openedByPath.get(entry.path.slice(0, separator));
      if (parent === undefined) {
        throw atomicFailure("atomic continuation deletion parent is missing");
      }
      if (publicEntries.indexOf(entry) === cursor - 1) {
        const parentRecord = resolveAtomicRecord(
          flight,
          parent.objectId,
        );
        const leaf = entry.path.slice(separator + 1);
        const observed =
          entry.type === "file"
            ? await snapshotAtomicManifestPlannedFile(
                flight,
                parentRecord,
                leaf,
                PROFILE_FILE_MAX_BYTES,
                `atomic-continuation-authorized:${entry.index}`,
              )
            : await observeAtomicContinuationDirectory(
                flight,
                parentRecord,
                leaf,
                `atomic-continuation-authorized:${entry.index}`,
              );
        if (
          observed === null ||
          ("state" in observed && observed.state === "absent")
        ) {
          continue;
        }
        const observedEvidence =
          "state" in observed
            ? observed.evidence!
            : observed.evidence;
        const expectedEvidence =
          atomicEvidenceFromManifestEntry(entry);
        if (
          observedEvidence.dev !== expectedEvidence.dev ||
          observedEvidence.ino !== expectedEvidence.ino ||
          observedEvidence.mode !== expectedEvidence.mode ||
          (entry.type === "file" &&
            (observedEvidence.size !== expectedEvidence.size ||
              observedEvidence.contentSha256 !==
                expectedEvidence.contentSha256))
        ) {
          flight.state = "fail_stopped";
          flight.root.acceptingOperations = false;
          throw atomicFailure(
            "atomic continuation authorized entry mismatched",
          );
        }
      }
      const opened = await openAtomicExpectedChild(
        controller,
        `${operationId}:continuation:open-delete:${entry.index}`,
        operationId,
        "payload_entry",
        parent.objectId,
        entry.path.slice(separator + 1),
        atomicEvidenceFromManifestEntry(entry),
        entry.type === "directory"
          ? "directory_nofollow"
          : "file_read_nofollow",
      );
      openedByPath.set(entry.path, {
        objectId: opened.handleId,
        evidence: opened.evidence,
        role: "payload_entry",
      });
    }
    if (cursor > 0) {
      const authorized = publicEntries[cursor - 1]!;
      if (openedByPath.get(authorized.path) === undefined) {
        const isRoot = authorized.path === "source";
        const separator = authorized.path.lastIndexOf("/");
        const parentId = isRoot
          ? wrapper?.handleId
          : openedByPath.get(
              authorized.path.slice(0, separator),
            )?.objectId;
        if (parentId === undefined) {
          throw atomicFailure(
            "atomic continuation authorized parent is missing",
          );
        }
        const parentRecord = resolveAtomicRecord(flight, parentId);
        await syncAtomicHeld(
          controller,
          `${operationId}:continuation:authorized-absent-sync`,
          operationId,
          "fsync_parent",
          parentRecord.role,
          parentId,
          parentRecord.evidence,
        );
      }
    }
    const sourceCleanup = await executeAtomicProtectedSourceCleanup(
      controller,
      stable,
      intents,
      manifest,
      openedByPath,
      wrapper!.handleId,
    );
    stable = sourceCleanup.stable;
    if (sourceCleanup.privateRootRemoved) privateSourceOpened = null;
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:continuation:source-removed`,
      stable,
      {
        ...stable.intent,
        sourceDeletion: {
          ...stable.intent.sourceDeletion!,
          phase: "removed",
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  if (
    stable.intent.phase === "source_deleting" &&
    stable.intent.sourceDeletion?.phase === "removed"
  ) {
    if (publicSourceOpened !== null || privateSourceOpened !== null) {
      throw atomicFailure("atomic continuation removed source is ambiguous");
    }
    if (disposition === "adopt") {
      const adoption = {
        authority:
          stable.intent.kind === "prepare"
            ? ("prepare_token" as const)
            : ("reconciliation_snapshot" as const),
        authorityDigest: publicSource.capabilityDigest,
      };
      stable = await createAndReplaceAtomicIntent(
        controller,
        `${operationId}:continuation:adopted`,
        stable,
        { ...stable.intent, phase: "adopted", adoption },
        intents.handleId,
        intents.evidence,
      );
    } else {
      const evidenceDigest = sha256(
        JSON.stringify({
          operationId,
          manifestSha256,
          outcome: "released_to_reconciliation",
        }),
      );
      stable = await createAndReplaceAtomicIntent(
        controller,
        `${operationId}:continuation:released`,
        stable,
        {
          ...stable.intent,
          phase: "discarding",
          cleanup: {
            phase: "discarding",
            outcome: "released_to_reconciliation",
            evidenceDigest,
            suffix: "private_source_entries",
            nextIndex: 0,
          },
        },
        intents.handleId,
        intents.evidence,
      );
    }
  }
  if (
    stable.intent.phase === "adopted" ||
    stable.intent.phase === "discarding" ||
    stable.intent.phase === "manifest_deleting"
  ) {
    if (
      publicSourceOpened !== null ||
      privateSourceOpened !== null
    ) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw atomicFailure(
        "atomic continuation source cleanup is ambiguous",
      );
    }
    if (
      flight.registry.has(
        profileAuthority.sourceState.handleId as object,
      )
    ) {
      await closeAndReleaseAtomicRecord(
        controller,
        `${operationId}:continuation:close-source-state`,
        operationId,
        "public_target",
        profileAuthority.sourceState.handleId,
        profileAuthority.sourceState.evidence,
        undefined,
      );
    }
    if (
      disposition === "adopt" &&
      !flight.root.sealedGenerations.has(operationId)
    ) {
      adoptAtomicPublishedGeneration(
        controller,
        profileAuthority.target.handleId,
        {
          profileId: stable.intent.target.kind === "profile_state"
            ? stable.intent.target.profileId
            : "",
          state: stable.intent.target.kind === "profile_state"
            ? stable.intent.target.state
            : "staging",
          generationId: stable.intent.target.kind === "profile_state"
            ? stable.intent.target.generationId
            : "",
        },
        operationId,
      );
    }
  }
  if (stable.intent.phase === "adopted") {
    const cleanupOutcome =
      disposition === "adopt"
        ? ("adopted" as const)
        : ("released_to_reconciliation" as const);
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:continuation:discarding`,
      stable,
      {
        ...stable.intent,
        phase: "discarding",
        cleanup: {
          phase: "discarding",
          outcome: cleanupOutcome,
          evidenceDigest: sha256(
            JSON.stringify(
              cleanupOutcome === "adopted"
                ? {
                    operationId,
                    manifestSha256,
                    outcome: cleanupOutcome,
                    authority: stable.intent.adoption!.authorityDigest,
                  }
                : {
                    operationId,
                    manifestSha256,
                    outcome: cleanupOutcome,
                  },
            ),
          ),
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  if (
    stable.intent.phase === "discarding" &&
    disposition === "release_to_reconciliation" &&
    stable.intent.cleanup?.outcome === "adopted"
  ) {
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:continuation:released`,
      stable,
      {
        ...stable.intent,
        cleanup: {
          ...stable.intent.cleanup,
          outcome: "released_to_reconciliation",
          evidenceDigest: sha256(
            JSON.stringify({
              operationId,
              manifestSha256,
              outcome: "released_to_reconciliation",
            }),
          ),
        },
      },
      intents.handleId,
      intents.evidence,
    );
  }
  if (stable.intent.phase === "discarding") {
    if (
      (disposition === "adopt" &&
        !flight.root.sealedGenerations.has(operationId)) ||
      (disposition === "release_to_reconciliation" &&
        stable.intent.cleanup?.outcome !==
          "released_to_reconciliation") ||
      manifest.entries.some(
        entry =>
          entry.scope === "wrapper_temp" ||
          entry.scope === "intent_temp",
      )
    ) {
      throw atomicFailure("atomic continuation cleanup authority is invalid");
    }
    while (stable.intent.cleanup?.suffix !== "done") {
      const cleanup = stable.intent.cleanup!;
      if (
        cleanup.suffix === "private_source_entries" ||
        cleanup.suffix === "wrapper_temps" ||
        cleanup.suffix === "intent_temps"
      ) {
        for (
          let cursor = cleanup.nextIndex;
          cursor < manifest.entries.length;
          cursor += 1
        ) {
          stable = await replaceAtomicCleanupCursor(
            controller,
            `${operationId}:continuation:cleanup:${cleanup.suffix}:${cursor + 1}`,
            stable,
            cleanup.suffix,
            cursor + 1,
            intents.handleId,
            intents.evidence,
          );
        }
      }
      const suffix = stable.intent.cleanup!.suffix;
      if (suffix === "private_source_entries") {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:continuation:private-root`,
          stable,
          "private_source_root",
          0,
          intents.handleId,
          intents.evidence,
        );
      } else if (suffix === "private_source_root") {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:continuation:wrapper-temps`,
          stable,
          "wrapper_temps",
          0,
          intents.handleId,
          intents.evidence,
        );
      } else if (suffix === "wrapper_temps") {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:continuation:wrapper-root`,
          stable,
          "wrapper_root",
          0,
          intents.handleId,
          intents.evidence,
        );
      } else if (suffix === "wrapper_root") {
        if (wrapper !== null) {
          await runAtomicRequest(
            controller,
            `${operationId}:continuation:remove-wrapper`,
            {
              kind: "remove_root",
              operationId,
              role: "wrapper",
              parentId: authority.bundles.handleId,
              leaf: operationId,
              objectId: wrapper.handleId,
              expected: wrapper.evidence,
              manifestSha256,
              cursor: 0,
            },
            [authority.bundles.handleId, wrapper.handleId],
          );
          await closeAndReleaseAtomicRecord(
            controller,
            `${operationId}:continuation:close-wrapper`,
            operationId,
            "wrapper",
            wrapper.handleId,
            wrapper.evidence,
            { kind: "scratch_entries", count: 1, byteSize: 0 },
          );
        }
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:continuation:intent-temps`,
          stable,
          "intent_temps",
          0,
          intents.handleId,
          intents.evidence,
        );
      } else if (suffix === "intent_temps") {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:continuation:done`,
          stable,
          "done",
          0,
          intents.handleId,
          intents.evidence,
        );
      } else {
        throw atomicFailure("atomic continuation cleanup suffix is invalid");
      }
    }
    if (
      authority.manifestObjectId === null ||
      authority.manifestEvidence === null
    ) {
      throw atomicFailure("atomic continuation manifest is missing");
    }
    const protectedEntries = manifest.entries.filter(
      entry => entry.scope === "public_source",
    );
    await executeAtomicProtectedCleanupTerminal(
      controller,
      createAtomicProtectedCleanupState({
        operationId,
        manifestSha256,
        entryCount: protectedEntries.length,
        entryCounts: {
          privateSourceEntries: protectedEntries.length,
          wrapperTemps: 0,
          intentTemps: 0,
        },
        entryDigests: protectedEntries.map((entry, index) =>
          sha256(JSON.stringify({ index, entry })),
        ),
        cursor: protectedEntries.length,
        suffix: "done",
      }),
      stable,
      intents,
      {
        objectId: authority.manifestObjectId,
        evidence: authority.manifestEvidence,
      },
    );
    return Object.freeze({
      sealed: true,
      operationId,
      phase: "cleaned",
    });
  }
  if (stable.intent.phase === "manifest_deleting") {
    if (
      authority.manifestObjectId === null ||
      authority.manifestEvidence === null
    ) {
      await syncAtomicHeld(
        controller,
        `${operationId}:continuation:missing-manifest-parent-sync`,
        operationId,
        "fsync_parent",
        "intents_parent",
        intents.handleId,
        intents.evidence,
      );
    } else {
      const protectedEntries = manifest.entries.filter(
        entry => entry.scope === "public_source",
      );
      await executeAtomicProtectedCleanupTerminal(
        controller,
        createAtomicProtectedCleanupState({
          operationId,
          manifestSha256,
          entryCount: protectedEntries.length,
          entryCounts: {
            privateSourceEntries: protectedEntries.length,
            wrapperTemps: 0,
            intentTemps: 0,
          },
          entryDigests: protectedEntries.map((entry, index) =>
            sha256(JSON.stringify({ index, entry })),
          ),
          cursor: protectedEntries.length,
          suffix: "done",
        }),
        stable,
        intents,
        {
          objectId: authority.manifestObjectId,
          evidence: authority.manifestEvidence,
        },
      );
      return Object.freeze({
        sealed: true,
        operationId,
        phase: "cleaned",
      });
    }
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:continuation:cleaned`,
      stable,
      { ...stable.intent, phase: "cleaned" },
      intents.handleId,
      intents.evidence,
    );
  }
  if (stable.intent.phase !== "cleaned") {
    throw atomicFailure("atomic continuation did not reach cleaned phase");
  }
  await runAtomicRequest(
    controller,
    `${operationId}:continuation:remove-intent`,
    {
      kind: "remove_intent",
      operationId,
      stableParentId: intents.handleId,
      stableLeaf: `${operationId}.json`,
      stableObjectId: stable.objectId,
      expectedStable: stable.evidence,
    },
    [intents.handleId, stable.objectId],
  );
  await closeAndReleaseAtomicRecord(
    controller,
    `${operationId}:continuation:close-intent`,
    operationId,
    "intent_stable",
    stable.objectId,
    stable.evidence,
    { kind: "stable_files", count: 1, byteSize: 0 },
  );
  await releaseAtomicBudget(
    controller,
    `${operationId}:continuation:release-intent`,
    operationId,
    "other_metadata_bytes",
    0,
    stable.evidence.size,
  );
  return Object.freeze({ sealed: true, operationId, phase: "cleaned" });
}

export async function recoverAtomicProtectedPublication(
  lease: AtomicPreReadyRecoveryLeaseV1,
  disposition: "adopt" | "release_to_reconciliation" = "adopt",
): Promise<AtomicProtectedPublicationRecoveryResultV1> {
  const flight = requireAtomicFlight(lease.controller);
  try {
    return await executeAtomicProtectedPublicationRecovery(
      lease,
      disposition,
    );
  } catch (error) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw error;
  }
}

export async function recoverAtomicProtectedPublicationFromCanonicalRoot(
  canonicalRoot: string,
  binding: ReadyProfileRootBinding,
  admission: ReconciliationExecutionAdmission,
  operationId: string,
  disposition: "adopt" | "release_to_reconciliation" = "adopt",
): Promise<AtomicProtectedPublicationRecoveryResultV1> {
  const lease = await acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
    canonicalRoot,
    binding,
    admission,
    operationId,
  );
  try {
    return await recoverAtomicProtectedPublication(lease, disposition);
  } finally {
    const failures: unknown[] = [];
    try {
      await closeAtomicEffectController(lease.controller);
    } catch (error) {
      failures.push(error);
    }
    try {
      await lease.closeRoot();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "atomic protected continuation close is unverified",
      );
    }
  }
}

export function transitionHeldProfileGenerationAtomically(
  source: BoundProfileGeneration,
  input: AtomicHeldGenerationTransitionInputV1,
): Promise<AtomicHeldGenerationPublicationResultV1>;
export function transitionHeldProfileGenerationAtomically(
  source: BoundProfileGeneration,
  input: AtomicPreReadyHeldGenerationTransitionInputV1,
): Promise<AtomicPreReadyHeldGenerationPublicationResultV1>;
export async function transitionHeldProfileGenerationAtomically(
  source: BoundProfileGeneration,
  input:
    | AtomicHeldGenerationTransitionInputV1
    | AtomicPreReadyHeldGenerationTransitionInputV1,
): Promise<
  | AtomicHeldGenerationPublicationResultV1
  | AtomicPreReadyHeldGenerationPublicationResultV1
> {
  const sourceRecord = requireGeneration(source);
  const expectedSourceState =
    input.kind === "prepare" ? "working" : "staging";
  const targetState = input.kind === "prepare" ? "staging" : "committed";
  if (
    sourceRecord.locator.state !== expectedSourceState ||
    !sameReadyBinding(sourceRecord.root.binding, input.binding) ||
    !/^[a-f0-9]{64}$/u.test(input.authorityDigest)
  ) {
    throw atomicFailure("atomic transition generation authority is invalid");
  }
  let releaseSource = await acquireGenerationOperation(sourceRecord, true);
  let sourceOperationReleased = false;
  let lease: AtomicPreReadyRecoveryLeaseV1 | null = null;
  let adopted: BoundProfileGeneration | null = null;
  let sealed = false;
  let sourceMoved = false;
  try {
    if (sourceRecord.root.token === null) {
      throw atomicFailure("atomic transition root authority is missing");
    }
    const snapshot = await snapshotAtomicTransitionSource(sourceRecord);
    const operationId = atomicUuidFromDigest(
      JSON.stringify({
        binding: input.binding,
        kind: input.kind,
        profileId: sourceRecord.locator.profileId,
        generationId: sourceRecord.locator.generationId,
        checksum: snapshot.tree.checksum,
        sourceDev: String(sourceRecord.identities[3]!.dev),
        sourceIno: String(sourceRecord.identities[3]!.ino),
      }),
    );
    lease = await acquireAtomicPreReadyRecoveryAuthority(
      sourceRecord.root.token,
      operationId,
    );
    const controller = lease.controller;
    const flight = requireAtomicFlight(controller);
    const bundles = await getAtomicInitialControlChild(
      controller,
      lease.initialAuthority.stagingRootId,
      "bundles_parent",
      "bundles",
      `${operationId}:bundles`,
      operationId,
    );
    const intents = await getAtomicInitialControlChild(
      controller,
      lease.initialAuthority.stagingRootId,
      "intents_parent",
      "intents",
      `${operationId}:intents`,
      operationId,
    );
    const transferableProfiles = await openAtomicExpectedChild(
      controller,
      `${operationId}:profiles`,
      operationId,
      "profiles_parent",
      lease.initialAuthority.stateRootId,
      "profiles",
      atomicEvidenceFromStat(sourceRecord.identities[0]!),
      "directory_nofollow",
    );
    const profile = await openAtomicExpectedChild(
      controller,
      `${operationId}:profile`,
      operationId,
      "public_target",
      transferableProfiles.handleId,
      sourceRecord.locator.profileId,
      atomicEvidenceFromStat(sourceRecord.identities[1]!),
      "directory_nofollow",
    );
    const sourceState = await openAtomicExpectedChild(
      controller,
      `${operationId}:source-state`,
      operationId,
      "public_target",
      profile.handleId,
      expectedSourceState,
      atomicEvidenceFromStat(sourceRecord.identities[2]!),
      "directory_nofollow",
    );
    const atomicSource = await openAtomicExpectedChild(
      controller,
      `${operationId}:source`,
      operationId,
      "public_source",
      sourceState.handleId,
      sourceRecord.locator.generationId,
      atomicEvidenceFromStat(sourceRecord.identities[3]!),
      "directory_nofollow",
    );
    const profileRecord = resolveAtomicRecord(flight, profile.handleId);
    const targetStateStat = await atomicAwait(
      flight,
      [profileRecord],
      "atomic-transition-target-state-evidence",
      () => fs.lstat(procPath(profileRecord.handle, targetState), { bigint: true }),
    );
    const targetParent = await openAtomicExpectedChild(
      controller,
      `${operationId}:target-state`,
      operationId,
      "public_target",
      profile.handleId,
      targetState,
      atomicEvidenceFromStat(targetStateStat),
      "directory_nofollow",
    );
    const publicSource: NonNullable<AtomicPublishIntentV1["publicSource"]> =
      Object.freeze({
        profileId: sourceRecord.locator.profileId,
        state: expectedSourceState,
        generationId: sourceRecord.locator.generationId,
        dev: atomicSource.evidence.dev,
        ino: atomicSource.evidence.ino,
        mode: 448,
        checksum: snapshot.tree.checksum,
        byteSize: snapshot.tree.byteSize,
        capabilityDigest: input.authorityDigest,
      });
    const published = await runAtomicPrivateProfilePublication(controller, {
      flightNonce: `${operationId}:publish`,
      operationId,
      kind: input.kind,
      binding: input.binding,
      target: {
        kind: "profile_state",
        profileId: sourceRecord.locator.profileId,
        state: targetState,
        generationId: sourceRecord.locator.generationId,
        leaf: sourceRecord.locator.generationId,
        parent: {
          dev: targetParent.evidence.dev,
          ino: targetParent.evidence.ino,
          mode: 448,
        },
      },
      bundlesParentId: bundles.handleId,
      bundlesParentEvidence: bundles.evidence,
      intentsParentId: intents.handleId,
      intentsParentEvidence: intents.evidence,
      targetParentId: targetParent.handleId,
      targetParentRole: "public_target",
      targetParentEvidence: targetParent.evidence,
      entries: snapshot.entries,
      publicSource,
      cleanupEntries: snapshot.cleanupEntries,
    });
    if (published.outcome === "conflict") {
      await discardAtomicConflictedPublication(
        controller,
        operationId,
        published,
        bundles,
        intents,
      );
      await closeAtomicEffectController(controller);
      lease = null;
      throw atomicFailure("atomic transition destination conflicted");
    }
    if (
      published.targetObjectId === null ||
      published.targetEvidence === null
    ) {
      throw atomicFailure("atomic transition destination conflicted");
    }
    let stable = atomicIntentRecord(
      controller,
      published.intentObjectId,
      published.intentEvidence,
    );
    const manifestSha256 = stable.intent.identityManifest?.sha256;
    if (manifestSha256 === undefined) {
      throw atomicFailure("atomic transition cleanup manifest is missing");
    }
    const deletionDigest = sha256(
      JSON.stringify({
        operationId,
        manifestSha256,
        publicSource,
        privateDeletionLeaf: `delete-${operationId}`,
      }),
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:source-deleting-pending`,
      stable,
      {
        ...stable.intent,
        phase: "source_deleting",
        sourceDeletion: {
          phase: "pending",
          privateDeletionLeaf: `delete-${operationId}`,
          evidenceDigest: deletionDigest,
          entryCount: published.cleanupManifest.entries.filter(
            entry => entry.scope === "public_source",
          ).length,
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:private-deletion-reserve`,
      operationId,
      "scratch_entries",
      1,
      0,
    );
    for (const [label, role, objectId, evidence] of [
      [
        "source-parent",
        "public_target",
        sourceState.handleId,
        sourceState.evidence,
      ],
      [
        "target-parent",
        "wrapper",
        published.wrapperObjectId,
        published.wrapperEvidence,
      ],
    ] as const) {
      await runAtomicRequest(
        controller,
        `${operationId}:source-move:${label}:revalidate`,
        {
          kind: "revalidate_handle",
          operationId,
          role,
          objectId,
          cursor: 0,
          byteLength: 0,
          expected: evidence,
        },
        [objectId],
      );
      await runAtomicRequest(
        controller,
        `${operationId}:source-move:${label}:statfs`,
        { kind: "statfs_parent", operationId, role, objectId, expected: evidence },
        [objectId],
      );
    }
    let moved: Awaited<ReturnType<typeof runAtomicRequest>>;
    try {
      moved = await runAtomicRequest(
        controller,
        `${operationId}:source-move`,
        {
          kind: "native_no_replace",
          operationId,
          move: "profile_source_to_private",
          sourceParentId: sourceState.handleId,
          sourceId: atomicSource.handleId,
          sourceLeaf: sourceRecord.locator.generationId,
          targetParentId: published.wrapperObjectId,
          targetLeaf: `delete-${operationId}`,
          expectedSource: atomicSource.evidence,
          expectedTarget: { absent: true },
          evidenceDigest: deletionDigest,
        },
        [
          sourceState.handleId,
          atomicSource.handleId,
          published.wrapperObjectId,
        ],
      );
    } catch (error) {
      sourceMoved = flight.removedRecords.has(
        resolveAtomicRecord(flight, atomicSource.handleId),
      );
      throw error;
    }
    sourceMoved = flight.removedRecords.has(
      resolveAtomicRecord(flight, atomicSource.handleId),
    );
    const movedLocations = moved.observations.find(
      (
        observation,
      ): observation is Extract<
        AtomicEffectObservationV1,
        { kind: "locations_observed"; requestKind: "native_no_replace" }
      > =>
        observation.kind === "locations_observed" &&
        observation.requestKind === "native_no_replace",
    );
    if (
      moved.classification?.outcome !== "published" ||
      movedLocations?.source.state !== "absent" ||
      movedLocations.target.state !== "match" ||
      movedLocations.targetObjectId === null ||
      movedLocations.target.evidence === null
    ) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw atomicFailure("atomic protected source move is ambiguous");
    }
    sourceMoved = true;
    await syncAtomicHeld(
      controller,
      `${operationId}:source-parent-sync`,
      operationId,
      "fsync_parent",
      "public_target",
      sourceState.handleId,
      sourceState.evidence,
    );
    await syncAtomicHeld(
      controller,
      `${operationId}:deletion-parent-sync`,
      operationId,
      "fsync_parent",
      "wrapper",
      published.wrapperObjectId,
      published.wrapperEvidence,
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:source-moved-private`,
      stable,
      {
        ...stable.intent,
        sourceDeletion: {
          ...stable.intent.sourceDeletion!,
          phase: "moved_private",
        },
      },
      intents.handleId,
      intents.evidence,
    );
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:close-public-source`,
      operationId,
      "public_source",
      atomicSource.handleId,
      atomicSource.evidence,
      undefined,
    );

    const sourceManifestEntries = published.cleanupManifest.entries.filter(
      entry => entry.scope === "public_source",
    );
    const childEntries = sourceManifestEntries.filter(
      entry => entry.path !== "source",
    );
    const childBytes = childEntries.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.size : 0),
      0,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:deletion-entry-reserve`,
      operationId,
      "payload_entries",
      childEntries.length,
      0,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:deletion-byte-reserve`,
      operationId,
      "payload_bytes",
      0,
      childBytes,
    );
    const openedByPath = new Map<
      string,
      AtomicProtectedOpenedRemovalV1
    >();
    openedByPath.set("source", {
      objectId: movedLocations.targetObjectId,
      evidence: movedLocations.target.evidence,
      role: "private_deletion",
    });
    for (const entry of [...childEntries].sort((left, right) => {
      const depth =
        left.path.split("/").length - right.path.split("/").length;
      return depth !== 0 ? depth : rawCompare(left.path, right.path);
    })) {
      const separator = entry.path.lastIndexOf("/");
      const parentPath = entry.path.slice(0, separator);
      const parent = openedByPath.get(parentPath);
      if (parent === undefined) {
        throw atomicFailure("atomic deletion manifest parent is missing");
      }
      const opened = await openAtomicExpectedChild(
        controller,
        `${operationId}:deletion-open:${entry.index}`,
        operationId,
        "payload_entry",
        parent.objectId,
        entry.path.slice(separator + 1),
        atomicEvidenceFromManifestEntry(entry),
        entry.type === "directory"
          ? "directory_nofollow"
          : "file_read_nofollow",
      );
      openedByPath.set(entry.path, {
        objectId: opened.handleId,
        evidence: opened.evidence,
        role: "payload_entry",
      });
    }
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:source-removing`,
      stable,
      {
        ...stable.intent,
        sourceDeletion: {
          ...stable.intent.sourceDeletion!,
          phase: "removing",
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
    const sourceCleanup = await executeAtomicProtectedSourceCleanup(
      controller,
      stable,
      intents,
      published.cleanupManifest,
      openedByPath,
      published.wrapperObjectId,
    );
    stable = sourceCleanup.stable;
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:source-removed`,
      stable,
      {
        ...stable.intent,
        sourceDeletion: {
          ...stable.intent.sourceDeletion!,
          phase: "removed",
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:close-source-state`,
      operationId,
      "public_target",
      sourceState.handleId,
      sourceState.evidence,
      undefined,
    );
    const adoption = Object.freeze({
      authority:
        input.kind === "prepare"
          ? ("prepare_token" as const)
          : ("reconciliation_snapshot" as const),
      authorityDigest: input.authorityDigest,
    });
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:adopted`,
      stable,
      { ...stable.intent, phase: "adopted", adoption },
      intents.handleId,
      intents.evidence,
    );
    adopted = adoptAtomicPublishedGeneration(
      controller,
      published.targetObjectId,
      {
        profileId: sourceRecord.locator.profileId,
        state: targetState,
        generationId: sourceRecord.locator.generationId,
      },
      input.adoptionMode === "pre_ready" ? operationId : null,
    );
    sealed = input.adoptionMode === "pre_ready";
    releaseSource();
    sourceOperationReleased = true;
    await closeGeneration(source);

    const cleanupDigest = sha256(
      JSON.stringify({
        operationId,
        manifestSha256,
        outcome: "adopted",
        authority: input.authorityDigest,
      }),
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:discarding`,
      stable,
      {
        ...stable.intent,
        phase: "discarding",
        cleanup: {
          phase: "discarding",
          outcome: "adopted",
          evidenceDigest: cleanupDigest,
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      },
      intents.handleId,
      intents.evidence,
    );
    for (const suffix of [
      "private_source_entries",
      "wrapper_temps",
      "intent_temps",
    ] as const) {
      if (stable.intent.cleanup?.suffix !== suffix) {
        const currentSuffix = stable.intent.cleanup?.suffix;
        if (
          !(
            suffix === "wrapper_temps" &&
            currentSuffix === "private_source_root"
          )
        ) {
          throw atomicFailure("atomic cleanup suffix is invalid");
        }
      }
      for (
        let cursor = stable.intent.cleanup?.nextIndex ?? 0;
        cursor < published.cleanupManifest.entries.length;
        cursor += 1
      ) {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:cleanup:${suffix}:${cursor + 1}`,
          stable,
          suffix,
          cursor + 1,
          intents.handleId,
          intents.evidence,
        );
      }
      if (suffix === "private_source_entries") {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:cleanup:private-root`,
          stable,
          "private_source_root",
          0,
          intents.handleId,
          intents.evidence,
        );
        await closeAndReleaseAtomicRecord(
          controller,
          `${operationId}:close-private-source`,
          operationId,
          "private_source",
          published.privateSourceObjectId,
          published.privateSourceEvidence,
          { kind: "scratch_entries", count: 1, byteSize: 0 },
        );
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:cleanup:wrapper-temps`,
          stable,
          "wrapper_temps",
          0,
          intents.handleId,
          intents.evidence,
        );
      } else if (suffix === "wrapper_temps") {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:cleanup:wrapper-root`,
          stable,
          "wrapper_root",
          0,
          intents.handleId,
          intents.evidence,
        );
        await runAtomicRequest(
          controller,
          `${operationId}:remove-wrapper`,
          {
            kind: "remove_root",
            operationId,
            role: "wrapper",
            parentId: bundles.handleId,
            leaf: operationId,
            objectId: published.wrapperObjectId,
            expected: published.wrapperEvidence,
            manifestSha256,
            cursor: 0,
          },
          [bundles.handleId, published.wrapperObjectId],
        );
        await closeAndReleaseAtomicRecord(
          controller,
          `${operationId}:close-wrapper`,
          operationId,
          "wrapper",
          published.wrapperObjectId,
          published.wrapperEvidence,
          { kind: "scratch_entries", count: 1, byteSize: 0 },
        );
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:cleanup:intent-temps`,
          stable,
          "intent_temps",
          0,
          intents.handleId,
          intents.evidence,
        );
      } else {
        stable = await replaceAtomicCleanupCursor(
          controller,
          `${operationId}:cleanup:done`,
          stable,
          "done",
          0,
          intents.handleId,
          intents.evidence,
        );
      }
    }
    const protectedEntries =
      published.cleanupManifest.entries.filter(
        entry => entry.scope === "public_source",
      );
    await executeAtomicProtectedCleanupTerminal(
      controller,
      createAtomicProtectedCleanupState({
        operationId,
        manifestSha256,
        entryCount: protectedEntries.length,
        entryCounts: {
          privateSourceEntries: protectedEntries.length,
          wrapperTemps: 0,
          intentTemps: 0,
        },
        entryDigests: protectedEntries.map((entry, index) =>
          sha256(JSON.stringify({ index, entry })),
        ),
        cursor: protectedEntries.length,
        suffix: "done",
      }),
      stable,
      intents,
      {
        objectId: published.manifestObjectId,
        evidence: published.manifestEvidence,
      },
    );
    await closeAtomicEffectController(controller);
    lease = null;
    return input.adoptionMode === "pre_ready"
      ? Object.freeze({
          sealed: true as const,
          tree: published.tree,
          operationId,
        })
      : Object.freeze({
          generation: adopted!,
          tree: published.tree,
          operationId,
        });
  } catch (error) {
    if (sourceMoved) sourceRecord.root.acceptingOperations = false;
    if (adopted !== null && !sealed) {
      await adopted.close().catch(() => {
        sourceRecord.root.acceptingOperations = false;
      });
      adopted = null;
    }
    throw error;
  } finally {
    if (!sourceOperationReleased) {
      if (!sourceMoved && sourceRecord.root.acceptingOperations) {
        sourceRecord.acceptingOperations = true;
      }
      releaseSource();
    }
    if (lease !== null) {
      await closeAtomicEffectController(lease.controller).catch(() => {
        sourceRecord.root.acceptingOperations = false;
      });
    }
  }
}

export type AtomicCanaryRecoveryRunnerInputV1 = Omit<
  AtomicCanaryRecoveryInputV1,
  "unresolvedForTargetParent"
> &
  Readonly<{
    durableCanaryInventory: ReadonlyArray<AtomicCanaryProofV1>;
    expectedTargetParentLocatorDigest: string;
  }>;

export type PersistAtomicCanaryPhaseV1 = (
  request: Extract<
    AtomicEffectRequestV1,
    { kind: "persist_canary_phase" }
  >,
) => Promise<void>;

async function runAtomicCanaryRecoveryCore(
  controller: AtomicEffectControllerV1,
  input: AtomicCanaryRecoveryRunnerInputV1,
  persistCanaryPhase: PersistAtomicCanaryPhaseV1,
): Promise<
  Extract<
    AtomicTerminalResultV1,
    { kind: "mount_proved" | "cleanup_pending" }
  >
> {
  if (
    input.durableCanaryInventory.some(
      proof => !isAtomicCanaryProofV1(proof),
    )
  ) {
    throw atomicFailure("atomic canary inventory is invalid");
  }
  const unresolved = input.durableCanaryInventory.filter(
    proof =>
      proof.phase !== "cleaned" &&
      proof.targetParentLocatorDigest ===
        input.proof.targetParentLocatorDigest,
  );
  if (
    input.proof.targetParentLocatorDigest !==
      input.expectedTargetParentLocatorDigest ||
    unresolved.length > 1 ||
    (unresolved.length === 1 &&
      !sameAtomicCanaryProof(unresolved[0]!, input.proof)) ||
    (unresolved.length === 0 && input.proof.phase !== "planned")
  ) {
    throw atomicFailure("atomic canary inventory conflicts");
  }
  let step = reduceAtomicPublication(
    createAtomicCanaryReducerState({
      ...input,
      unresolvedForTargetParent: unresolved,
    }),
    null,
  );
  let privateDeletionObjectId: FlightSemanticId | null = null;
  for (let count = 0; count < 64; count += 1) {
    if (step.kind === "terminal") {
      if (
        step.result.kind === "mount_proved" ||
        step.result.kind === "cleanup_pending"
      ) {
        return step.result.kind === "cleanup_pending"
          ? Object.freeze({
              ...step.result,
              privateDeletionObjectId,
            })
          : step.result;
      }
      throw atomicFailure(
        `atomic canary recovery failed: ${step.result.kind === "fail_stop" ? step.result.code : step.result.kind}`,
      );
    }
    let observation: AtomicEffectObservationV1;
    if (step.request.kind === "persist_canary_phase") {
      await persistCanaryPhase(step.request);
      observation = Object.freeze({
        kind: "effect_completed",
        effectId: step.request.effectId,
        requestKind: "persist_canary_phase",
        evidenceDigest: step.request.evidenceDigest,
        count: 1,
        byteSize: 0,
      });
    } else {
      observation = await applyAtomicEffect(controller, step.request);
    }
    if (
      input.action === "cleanup" &&
      observation.kind === "locations_observed" &&
      observation.requestKind === "native_no_replace" &&
      observation.targetObjectId !== null
    ) {
      privateDeletionObjectId = observation.targetObjectId;
    }
    step = reduceAtomicPublication(step.state, observation);
  }
  throw atomicFailure("atomic canary recovery exceeded effect bound");
}

type AtomicCanaryRecoveryClaim = {
  proof: AtomicCanaryProofV1;
  persistence: "reserved" | "durable" | "uncertain";
  tail: Promise<void>;
};

const atomicCanaryRecoveryClaims = new WeakMap<
  RootCapabilityRecord,
  Map<string, AtomicCanaryRecoveryClaim>
>();

function sameAtomicCanaryProof(
  left: AtomicCanaryProofV1,
  right: AtomicCanaryProofV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runAtomicCanaryRecovery(
  controller: AtomicEffectControllerV1,
  input: AtomicCanaryRecoveryRunnerInputV1,
  persistCanaryPhase: PersistAtomicCanaryPhaseV1,
): Promise<
  Extract<
    AtomicTerminalResultV1,
    { kind: "mount_proved" | "cleanup_pending" }
  >
> {
  const flight = requireAtomicFlight(controller);
  if (
    !isAtomicCanaryProofV1(input.proof) ||
    input.durableCanaryInventory.some(
      proof => !isAtomicCanaryProofV1(proof),
    )
  ) {
    throw atomicFailure("atomic canary inventory is invalid");
  }
  const supplied = input.durableCanaryInventory.filter(
    proof =>
      proof.phase !== "cleaned" &&
      proof.targetParentLocatorDigest ===
        input.proof.targetParentLocatorDigest,
  );
  if (
    input.proof.targetParentLocatorDigest !==
      input.expectedTargetParentLocatorDigest ||
    supplied.length > 1 ||
    (supplied.length === 1 &&
      !sameAtomicCanaryProof(supplied[0]!, input.proof)) ||
    (supplied.length === 0 && input.proof.phase !== "planned")
  ) {
    throw atomicFailure("atomic canary inventory conflicts");
  }
  let claims = atomicCanaryRecoveryClaims.get(flight.root);
  if (claims === undefined) {
    claims = new Map();
    atomicCanaryRecoveryClaims.set(flight.root, claims);
  }
  const key = input.expectedTargetParentLocatorDigest;
  const existing = claims.get(key);
  const previous = existing?.tail ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  const claim: AtomicCanaryRecoveryClaim =
    existing ?? {
      proof: input.proof,
      persistence: supplied.length === 0 ? "reserved" : "durable",
      tail,
    };
  claim.tail = tail;
  claims.set(key, claim);
  await previous;
  try {
    if (
      existing !== undefined &&
      (!sameAtomicCanaryProof(claim.proof, input.proof) ||
        claim.persistence === "uncertain")
    ) {
      throw atomicFailure("atomic canary inventory conflicts");
    } else if (
      existing !== undefined &&
      supplied.length === 1 &&
      !sameAtomicCanaryProof(supplied[0]!, claim.proof)
    ) {
      throw atomicFailure("atomic canary inventory conflicts");
    }
    return await runAtomicCanaryRecoveryCore(
      controller,
      {
        ...input,
        durableCanaryInventory:
          claim.persistence === "durable" ? [claim.proof] : [],
      },
      async request => {
        try {
          await persistCanaryPhase(request);
        } catch (error) {
          claim.persistence = "uncertain";
          throw error;
        }
        claim.proof = request.proof;
        claim.persistence = "durable";
      },
    );
  } finally {
    release();
  }
}

export type AtomicCanaryPrivateCleanupInputV1 = Readonly<{
  proof: AtomicCanaryProofV1;
  privateDeletion:
    | Readonly<{
        state: "present";
        parentId: FlightSemanticId;
        parentEvidence: AtomicObjectEvidenceV1;
        objectId: FlightSemanticId;
        evidence: AtomicObjectEvidenceV1;
      }>
    | Readonly<{
        state: "absent";
        parentId: FlightSemanticId;
        parentEvidence: AtomicObjectEvidenceV1;
        parentSynced: true;
      }>;
}>;

export type PersistAtomicCanaryCleanupProofV1 = (
  proof: AtomicCanaryProofV1,
) => Promise<void>;

export async function runAtomicCanaryPrivateCleanup(
  controller: AtomicEffectControllerV1,
  input: AtomicCanaryPrivateCleanupInputV1,
  persistProof: PersistAtomicCanaryCleanupProofV1,
): Promise<AtomicCanaryProofV1> {
  const flight = requireAtomicFlight(controller);
  let proof = input.proof;
  if (
    !isAtomicCanaryProofV1(proof) ||
    proof.phase !== "deleting" ||
    proof.privateDeletionEvidence === null ||
    proof.manifestSha256 === null ||
    proof.cleanupEntryCount !== 1 ||
    proof.cleanupNextIndex > 1 ||
    (input.privateDeletion.state === "present" &&
      input.privateDeletion.parentId === input.privateDeletion.objectId) ||
    !sameAtomicEvidence(
      input.privateDeletion.parentEvidence,
      proof.wrapperEvidence,
    )
  ) {
    throw atomicFailure("atomic canary cleanup authority is invalid");
  }
  const manifestSha256 = proof.manifestSha256;
  const privateDeletionEvidence = proof.privateDeletionEvidence;
  if (proof.cleanupNextIndex === 0) {
    if (input.privateDeletion.state !== "present") {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw atomicFailure("atomic canary deletion location is ambiguous");
    }
    proof = authorizeAtomicCanaryCleanupRemoval(proof, manifestSha256);
    await persistProof(proof);
  }
  if (input.privateDeletion.state === "present") {
    if (
      !sameAtomicEvidence(
        input.privateDeletion.evidence,
        privateDeletionEvidence,
      )
    ) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw atomicFailure("atomic canary deletion binding changed");
    }
    try {
      await runAtomicRequest(
        controller,
        `${proof.operationId}:canary-cleanup:remove`,
        {
          kind: "remove_root",
          operationId: proof.operationId,
          role: "private_deletion",
          parentId: input.privateDeletion.parentId,
          leaf: proof.deletionLeaf,
          objectId: input.privateDeletion.objectId,
          expected: input.privateDeletion.evidence,
          manifestSha256,
          cursor: proof.cleanupNextIndex,
        },
        [input.privateDeletion.parentId, input.privateDeletion.objectId],
      );
      await closeAndReleaseAtomicRecord(
        controller,
        `${proof.operationId}:canary-cleanup`,
        proof.operationId,
        "private_deletion",
        input.privateDeletion.objectId,
        input.privateDeletion.evidence,
        { kind: "scratch_entries", count: 1, byteSize: 0 },
      );
    } catch (error) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw error;
    }
  } else if (input.privateDeletion.parentSynced !== true) {
    flight.state = "fail_stopped";
    flight.root.acceptingOperations = false;
    throw atomicFailure("atomic canary deletion absence is unverified");
  }
  const cleaned = completeAtomicCanaryCleanupRemoval(proof, {
    operationId: proof.operationId,
    manifestSha256,
    privateDeletionAbsent: true,
    sourceParentSynced: true,
    targetParentSynced: true,
    evidenceDigest: sha256(
      JSON.stringify({
        operationId: proof.operationId,
        manifestSha256,
        cursor: proof.cleanupNextIndex,
        absent: true,
      }),
    ),
  });
  await persistProof(cleaned);
  return cleaned;
}

function atomicIntentCanaryProof(
  proof: AtomicCanaryProofV1,
): NonNullable<AtomicPublishIntentV1["canaryProof"]> {
  return Object.freeze({
    attempt: 0,
    sourceLeaf: proof.sourceLeaf as `proof-${string}-0`,
    targetLeaf: proof.targetLeaf as `canary-${string}-0`,
    deletionLeaf: proof.deletionLeaf as `deletion-${string}-0`,
    phase: proof.phase,
    dev: proof.publishedEvidence?.dev ?? null,
    ino: proof.publishedEvidence?.ino ?? null,
    mode: proof.publishedEvidence === null ? null : 448,
    evidenceDigest: proof.publishedEvidence?.evidenceDigest ?? null,
  });
}

function atomicIntentCanaryClassification(
  classification: AtomicNativeClassificationV1,
): NonNullable<AtomicPublishIntentV1["classification"]> {
  return Object.freeze({
    outcome: classification.outcome,
    nativeCode: classification.nativeCode,
    sourceMatches: classification.sourceMatches,
    targetMatches: classification.targetMatches,
    targetOther: classification.targetOther,
    evidenceDigest: sha256(
      JSON.stringify({
        precheck: classification.nativePrecheckEvidenceDigest,
        locations: classification.locationEvidenceDigest,
      }),
    ),
  });
}

async function runFreshAtomicDirectoryCanary(
  root: AnchoredProfileRoot,
  binding: ReadyProfileRootBinding,
): Promise<void> {
  const operationId = atomicUuidFromDigest(
    [
      "fresh-reconciliation-canary",
      binding.processNonce,
      binding.controlGenerationNonce,
      binding.snapshotDigest,
    ].join("\n"),
  );
  const lease = await acquireAtomicPreReadyRecoveryAuthority(
    root,
    operationId,
  );
  const { controller, initialAuthority } = lease;
  const flight = requireAtomicFlight(controller);
  const profilesEvidence = initialAuthority.evidence.profilesParent;
  const bundlesEvidence = initialAuthority.evidence.bundlesParent;
  const intentsEvidence = initialAuthority.evidence.intentsParent;
  const target: PublicationTargetV1 = Object.freeze({
    kind: "canary_parent",
    parentLocator: Object.freeze({ kind: "profiles" }),
    parent: Object.freeze({
      dev: profilesEvidence.dev,
      ino: profilesEvidence.ino,
      mode: 448,
    }),
  });
  const targetLocatorDigest = publicationTargetLocatorDigest(target);
  const sourceLeaf = `proof-${operationId}-0` as const;
  const targetLeaf = `canary-${operationId}-0` as const;
  const deletionLeaf = `deletion-${operationId}-0` as const;
  let controllerClosed = false;
  let stable: AtomicPublishedIntentRecord | null = null;
  try {
    const baseIntent: AtomicPublishIntentV1 = {
      version: 1,
      operationId,
      kind: "canary",
      phase: "allocated",
      binding,
      target,
      wrapper: null,
      privateSource: null,
      publicSource: null,
      classification: null,
      sourceDeletion: null,
      adoption: null,
      cleanup: null,
      canaryProof: {
        attempt: 0,
        sourceLeaf,
        targetLeaf,
        deletionLeaf,
        phase: "planned",
        dev: null,
        ino: null,
        mode: null,
        evidenceDigest: null,
      },
      prepublicationAbort: null,
      identityManifest: null,
    };
    const allocated = encodeAtomicPublishIntent(baseIntent);
    await reserveAtomicBudget(
      controller,
      `${operationId}:fresh-canary:stable`,
      operationId,
      "stable_files",
      1,
      0,
    );
    const publishedIntent = await runAtomicCreateAndPersistRecordProtocol(
      controller,
      {
        flightNonce: `${operationId}:fresh-canary:allocated`,
        operationId,
        publication: { kind: "persist_intent", expectedPhase: null },
        canonicalBytes: allocated.bytes,
        contentDigest: allocated.sha256,
        tempParentId: initialAuthority.intentsParentId,
        tempParentEvidence: intentsEvidence,
        tempLeaf: atomicIntentTempLeaf(operationId, "allocated"),
        stableParentId: initialAuthority.intentsParentId,
        stableParentEvidence: intentsEvidence,
        stableLeaf: `${operationId}.json`,
      },
    );
    stable = {
      intent: baseIntent,
      objectId: publishedIntent.stableObjectId,
      evidence: publishedIntent.stableEvidence,
    };
    await reserveAtomicBudget(
      controller,
      `${operationId}:fresh-canary:scratch`,
      operationId,
      "scratch_entries",
      3,
      0,
    );
    await reserveAtomicBudget(
      controller,
      `${operationId}:fresh-canary:target`,
      operationId,
      "payload_entries",
      1,
      0,
    );
    const wrapper = atomicCreatedObservation(
      await runAtomicRequest(
        controller,
        `${operationId}:fresh-canary:wrapper`,
        {
          kind: "create_and_pin_wrapper",
          operationId,
          role: "wrapper",
          parentId: initialAuthority.bundlesParentId,
          leaf: operationId,
          parentEvidenceDigest: bundlesEvidence.evidenceDigest,
          mode: 448,
          expectedAbsence: true,
        },
        [initialAuthority.bundlesParentId],
      ),
    );
    await syncAtomicHeld(
      controller,
      `${operationId}:fresh-canary:wrapper-sync`,
      operationId,
      "fsync_parent",
      "bundles_parent",
      initialAuthority.bundlesParentId,
      bundlesEvidence,
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:fresh-canary:building`,
      stable,
      {
        ...stable.intent,
        phase: "building",
        wrapper: {
          dev: wrapper.evidence.dev,
          ino: wrapper.evidence.ino,
          mode: 448,
        },
      },
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    const source = atomicCreatedObservation(
      await runAtomicRequest(
        controller,
        `${operationId}:fresh-canary:source`,
        {
          kind: "create_and_pin_directory",
          operationId,
          role: "private_source",
          parentId: wrapper.handleId,
          leaf: sourceLeaf,
          parentEvidenceDigest: wrapper.evidence.evidenceDigest,
          mode: 448,
          expectedAbsence: true,
        },
        [wrapper.handleId],
      ),
    );
    await syncAtomicHeld(
      controller,
      `${operationId}:fresh-canary:source-sync`,
      operationId,
      "fsync_parent",
      "wrapper",
      wrapper.handleId,
      wrapper.evidence,
    );
    const sourceTree = await hashProfileTreeAt(
      flight.root.anchored,
      resolveAtomicRecord(flight, source.handleId).handle,
      new Budget(MAX_RECONCILIATION_REFERENCES),
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:fresh-canary:ready`,
      stable,
      {
        ...stable.intent,
        phase: "ready",
        privateSource: {
          dev: source.evidence.dev,
          ino: source.evidence.ino,
          mode: 448,
          checksum: sourceTree.checksum,
          byteSize: sourceTree.byteSize,
        },
      },
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    let proof: AtomicCanaryProofV1 = Object.freeze({
      version: 1,
      operationId,
      targetParentLocatorDigest: targetLocatorDigest,
      targetParentEvidence: profilesEvidence,
      wrapperEvidence: wrapper.evidence,
      attempt: 0,
      sourceLeaf,
      targetLeaf,
      deletionLeaf,
      phase: "planned",
      privateSourceEvidence: source.evidence,
      publishedEvidence: null,
      privateDeletionEvidence: null,
      classification: null,
      manifestSha256: null,
      cleanupNextIndex: 0,
      cleanupEntryCount: 0,
      sourceParentSynced: false,
      targetParentSynced: false,
    });
    const proved = await runAtomicCanaryRecovery(
      controller,
      {
        flightNonce: `${operationId}:fresh-canary:prove`,
        action: "prove_mount",
        proof,
        durableCanaryInventory: [],
        expectedTargetParentLocatorDigest: targetLocatorDigest,
        sourceParentId: wrapper.handleId,
        sourceParentRole: "wrapper",
        sourceParentEvidence: wrapper.evidence,
        sourceId: source.handleId,
        targetParentId: initialAuthority.profilesParentId,
        targetParentRole: "profiles_parent",
        targetParentEvidence: profilesEvidence,
        cleanupManifest: null,
      },
      async request => {
        proof = request.proof;
        const classification = request.proof.classification;
        if (classification === null) return;
        stable = await createAndReplaceAtomicIntent(
          controller,
          `${operationId}:fresh-canary:persist-${request.proof.phase}`,
          stable!,
          {
            ...stable!.intent,
            phase: "classified",
            classification: atomicIntentCanaryClassification(classification),
            canaryProof: atomicIntentCanaryProof(request.proof),
          },
          initialAuthority.intentsParentId,
          intentsEvidence,
        );
      },
    );
    proof = proved.proof;
    if (
      proof.phase !== "published" ||
      proof.publishedEvidence === null ||
      proof.classification?.outcome !== "published"
    ) {
      throw atomicFailure("fresh atomic canary publication was not proved");
    }
    const publishedRecord = [...flight.records].find(
      record =>
        record.role === "public_target" &&
        record.parentId === initialAuthority.profilesParentId &&
        record.leaf === targetLeaf &&
        sameAtomicEvidence(record.evidence, proof.publishedEvidence!),
    );
    const publishedObjectId =
      publishedRecord === undefined
        ? undefined
        : flight.recordTokens.get(publishedRecord);
    if (publishedObjectId === undefined) {
      throw atomicFailure("fresh atomic canary target authority is missing");
    }
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:fresh-canary:renamed`,
      stable,
      { ...stable.intent, phase: "renamed" },
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    const manifest: CleanupIdentityManifestV1 = {
      version: 1,
      operationId,
      binding,
      targetLocatorDigest,
      entries: [
        {
          index: 0,
          scope: "private_canary_deletion",
          path: deletionLeaf,
          type: "directory",
          dev: proof.publishedEvidence.dev,
          ino: proof.publishedEvidence.ino,
          mode: 448,
          size: 0,
          contentSha256: null,
        },
      ],
    };
    const encodedManifest = encodeCleanupIdentityManifest(manifest);
    const manifestTempLeaf =
      `${operationId}.identities.${atomicTransitionId(operationId, "manifest")}.tmp` as
        `${string}.identities.${string}.tmp`;
    const manifestBinding: NonNullable<
      AtomicPublishIntentV1["identityManifest"]
    > = {
      phase: "planned",
      filename: `${operationId}.identities.json`,
      tempFilename: manifestTempLeaf,
      sha256: encodedManifest.sha256,
      entryCount: 1,
      byteSize: encodedManifest.bytes.byteLength,
      dev: null,
      ino: null,
      mode: null,
    };
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:fresh-canary:manifest-planned`,
      stable,
      {
        ...stable.intent,
        phase: "manifest_planned",
        identityManifest: manifestBinding,
      },
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    const publishedManifest = await runAtomicCreateAndPersistRecordProtocol(
      controller,
      {
        flightNonce: `${operationId}:fresh-canary:manifest`,
        operationId,
        publication: {
          kind: "persist_manifest",
          expectedPhase: "manifest_planned",
        },
        canonicalBytes: encodedManifest.bytes,
        contentDigest: encodedManifest.sha256,
        tempParentId: initialAuthority.intentsParentId,
        tempParentEvidence: intentsEvidence,
        tempLeaf: manifestTempLeaf,
        stableParentId: initialAuthority.intentsParentId,
        stableParentEvidence: intentsEvidence,
        stableLeaf: `${operationId}.identities.json`,
      },
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:fresh-canary:manifest-published`,
      stable,
      {
        ...stable.intent,
        phase: "manifest_published",
        identityManifest: {
          ...manifestBinding,
          phase: "published",
          dev: publishedManifest.stableEvidence.dev,
          ino: publishedManifest.stableEvidence.ino,
          mode: 384,
        },
      },
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    stable = await createAndReplaceAtomicIntent(
      controller,
      `${operationId}:fresh-canary:discarding`,
      stable,
      {
        ...stable.intent,
        phase: "discarding",
        cleanup: {
          phase: "discarding",
          outcome: "canary_complete",
          evidenceDigest: sha256(
            JSON.stringify({
              operationId,
              manifestSha256: encodedManifest.sha256,
              outcome: "canary_complete",
            }),
          ),
          suffix: "private_source_entries",
          nextIndex: 0,
        },
      },
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    const cleanup = await runAtomicCanaryRecovery(
      controller,
      {
        flightNonce: `${operationId}:fresh-canary:cleanup`,
        action: "cleanup",
        proof,
        durableCanaryInventory: [proof],
        expectedTargetParentLocatorDigest: targetLocatorDigest,
        sourceParentId: initialAuthority.profilesParentId,
        sourceParentRole: "profiles_parent",
        sourceParentEvidence: profilesEvidence,
        sourceId: publishedObjectId,
        targetParentId: wrapper.handleId,
        targetParentRole: "wrapper",
        targetParentEvidence: wrapper.evidence,
        cleanupManifest: {
          sha256: encodedManifest.sha256,
          entryCount: 1,
          nextIndex: 0,
        },
      },
      async request => {
        proof = request.proof;
        const nextCanaryProof = atomicIntentCanaryProof(request.proof);
        if (
          JSON.stringify(stable!.intent.canaryProof) ===
          JSON.stringify(nextCanaryProof)
        ) {
          return;
        }
        stable = await createAndReplaceAtomicIntent(
          controller,
          `${operationId}:fresh-canary:persist-deleting`,
          stable!,
          {
            ...stable!.intent,
            canaryProof: nextCanaryProof,
          },
          initialAuthority.intentsParentId,
          intentsEvidence,
        );
      },
    );
    proof = cleanup.proof;
    if (
      cleanup.kind !== "cleanup_pending" ||
      cleanup.privateDeletionObjectId === null ||
      proof.privateDeletionEvidence === null
    ) {
      throw atomicFailure("fresh atomic canary cleanup was not proved");
    }
    proof = await runAtomicCanaryPrivateCleanup(
      controller,
      {
        proof,
        privateDeletion: {
          state: "present",
          parentId: wrapper.handleId,
          parentEvidence: wrapper.evidence,
          objectId: cleanup.privateDeletionObjectId,
          evidence: proof.privateDeletionEvidence,
        },
      },
      async persisted => {
        proof = persisted;
        stable = await createAndReplaceAtomicIntent(
          controller,
          `${operationId}:fresh-canary:persist-cleanup-${persisted.cleanupNextIndex}`,
          stable!,
          {
            ...stable!.intent,
            canaryProof: atomicIntentCanaryProof(persisted),
            cleanup: {
              ...stable!.intent.cleanup!,
              nextIndex: persisted.cleanupNextIndex,
            },
          },
          initialAuthority.intentsParentId,
          intentsEvidence,
        );
      },
    );
    if (proof.phase !== "cleaned") {
      throw atomicFailure("fresh atomic canary cleanup did not complete");
    }
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:fresh-canary:close-source`,
      operationId,
      "private_source",
      source.handleId,
      source.evidence,
      { kind: "scratch_entries", count: 1, byteSize: 0 },
    );
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:fresh-canary:close-target`,
      operationId,
      "public_target",
      publishedObjectId,
      proof.publishedEvidence!,
      { kind: "payload_entries", count: 1, byteSize: 0 },
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:fresh-canary:private-root`,
      stable,
      "private_source_root",
      0,
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:fresh-canary:wrapper-temps`,
      stable,
      "wrapper_temps",
      0,
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:fresh-canary:wrapper-temps-complete`,
      stable,
      "wrapper_temps",
      1,
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:fresh-canary:wrapper-root`,
      stable,
      "wrapper_root",
      0,
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    await runAtomicRequest(
      controller,
      `${operationId}:fresh-canary:remove-wrapper`,
      {
        kind: "remove_root",
        operationId,
        role: "wrapper",
        parentId: initialAuthority.bundlesParentId,
        leaf: operationId,
        objectId: wrapper.handleId,
        expected: wrapper.evidence,
        manifestSha256: encodedManifest.sha256,
        cursor: 0,
      },
      [initialAuthority.bundlesParentId, wrapper.handleId],
    );
    await closeAndReleaseAtomicRecord(
      controller,
      `${operationId}:fresh-canary:close-wrapper`,
      operationId,
      "wrapper",
      wrapper.handleId,
      wrapper.evidence,
      { kind: "scratch_entries", count: 1, byteSize: 0 },
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:fresh-canary:intent-temps`,
      stable,
      "intent_temps",
      0,
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:fresh-canary:intent-temps-complete`,
      stable,
      "intent_temps",
      1,
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    stable = await replaceAtomicCleanupCursor(
      controller,
      `${operationId}:fresh-canary:done`,
      stable,
      "done",
      0,
      initialAuthority.intentsParentId,
      intentsEvidence,
    );
    const entryDigest = sha256(
      JSON.stringify({ index: 0, entry: manifest.entries[0] }),
    );
    await executeAtomicProtectedCleanupTerminal(
      controller,
      createAtomicProtectedCleanupState({
        operationId,
        manifestSha256: encodedManifest.sha256,
        entryCount: 1,
        entryCounts: {
          privateSourceEntries: 1,
          wrapperTemps: 0,
          intentTemps: 0,
        },
        entryDigests: [entryDigest],
        cursor: 1,
        suffix: "done",
      }),
      stable,
      {
        handleId: initialAuthority.intentsParentId,
        evidence: intentsEvidence,
      },
      {
        objectId: publishedManifest.stableObjectId,
        evidence: publishedManifest.stableEvidence,
      },
    );
    await closeAtomicEffectController(controller);
    controllerClosed = true;
  } finally {
    if (!controllerClosed) {
      await closeAtomicEffectController(controller).catch(() => {
        flight.root.acceptingOperations = false;
      });
    }
  }
}

function atomicRecordDepth(
  flight: AtomicEffectFlightRecord,
  record: AtomicHeldRecord,
): number {
  let depth = 0;
  let current: AtomicHeldRecord | undefined = record;
  const seen = new Set<AtomicHeldRecord>();
  while (current.parentId !== null) {
    if (seen.has(current)) return Number.MAX_SAFE_INTEGER;
    seen.add(current);
    current = flight.registry.get(current.parentId as object);
    if (current === undefined) return Number.MAX_SAFE_INTEGER;
    depth += 1;
  }
  return depth;
}

export async function closeAtomicEffectController(
  controller: AtomicEffectControllerV1,
): Promise<void> {
  const flight = atomicEffectFlightRecords.get(controller as object);
  if (
    flight === undefined ||
    (flight.state !== "live" && flight.state !== "fail_stopped")
  ) {
    throw atomicFailure("atomic publication controller is not closable");
  }
  try {
    flight.state = "closing";
    const owned = [...flight.records]
      .filter((record) => record.owned)
      .sort(
        (left, right) =>
          atomicRecordDepth(flight, right) - atomicRecordDepth(flight, left),
      );
    const failures: unknown[] = [];
    for (const retained of flight.transientHandles) {
      try {
        await atomicVerifiedClose(
          flight,
          [retained.parent],
          retained.point,
          () => retained.handle.close(),
          () => {
            flight.transientHandles.delete(retained);
          },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    for (const partial of flight.livePartials) {
      if (partial.handle === null) continue;
      try {
        const parent = resolveAtomicRecord(flight, partial.parentId);
        const handle = partial.handle;
        await atomicVerifiedClose(
          flight,
          [parent],
          "atomic-controller-partial-close",
          () => handle.close(),
          () => {
            partial.handle = null;
          },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    for (const record of owned) {
      try {
        const parent =
          record.parentId === null
            ? null
            : resolveAtomicRecord(flight, record.parentId);
        await atomicVerifiedClose(
          flight,
          parent === null ? [] : [parent],
          "atomic-controller-close",
          () => record.handle.close(),
          () => {
            flight.records.delete(record);
          },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length !== 0) {
      flight.state = "fail_stopped";
      flight.root.acceptingOperations = false;
      throw atomicFailure("atomic publication close is unverified");
    }
    flight.records.clear();
    flight.livePartials.clear();
    flight.state = "closed";
    atomicEffectFlightRecords.delete(controller as object);
  } finally {
    flight.releaseRootOperation();
  }
}

export function atomicHeldProfileHashImplementationIdentityForTest(): string {
  if (process.env.VITEST !== "true") {
    throw atomicFailure("atomic publication test seam is unavailable");
  }
  return ATOMIC_HELD_PROFILE_HASH_IMPLEMENTATION;
}

export function atomicSealedGenerationCountForTest(
  root: AnchoredProfileRoot,
): number {
  if (process.env.VITEST !== "true") {
    throw atomicFailure("atomic publication test seam is unavailable");
  }
  return requireRoot(root).sealedGenerations.size;
}
