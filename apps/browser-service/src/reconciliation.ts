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
  AtomicCanaryProofV1,
  AtomicCanaryRecoveryInputV1,
  AtomicTerminalResultV1,
  AtomicLocationMoveV1,
  AtomicObjectEvidenceV1,
  AtomicObjectRoleV1,
  FlightEffectId,
  FlightPartialCreateId,
  FlightSemanticId,
} from "./atomic-directory-publication.js";
import {
  createAtomicCanaryReducerState,
  isAtomicControlLeafV1,
  isAtomicCanaryProofV1,
  isAtomicPayloadLeafV1,
  reduceAtomicPublication,
} from "./atomic-directory-publication.js";
import { loadAtomicDirectoryPublicationNative } from "./atomic-directory-publication-native.js";
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
  now?: () => Date;
  gracePeriodMs?: number;
  maxManagedEntries?: number;
  correlationId?: string;
  logger?: Pick<Logger, "info" | "error">;
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
  atomicOpenFlags?: (point: string, flags: number, mode?: number) => void;
  atomicOperationCompleted?: (point: string) => void;
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
    await closeAll(
      [...this.components]
        .reverse()
        .map(
          (component, index) =>
            [
              component.handle,
              index === 0 ? "root" : `root-chain-${index}`,
            ] as const,
        ),
    );
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
): Promise<Set<string>> {
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
        tree = await hashProfileTree(root, reference.path, budget);
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
        result.push(
          await profileCandidate(
            root,
            `profiles/${profile.name}/${state.name}/${generation.name}`,
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
          "reconciliation_execution_failed",
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
        "reconciliation_execution_failed",
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
  canonicalRoot: string,
  input: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
  sealEvidence?: (evidence: ReconciledRootEvidence) => void,
): Promise<ReconciliationResultV1> {
  const started = Date.now();
  let state = "validating";
  let retained = 0;
  let removed = 0;
  let root: AnchoredRoot | undefined;
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
    root = await openAnchoredRoot(canonicalRoot, deps.admission);
    const authoritativePaths = await validateAuthorities(
      root,
      request.references,
      budget,
    );
    retained = authoritativePaths.size;

    state = "recovering";
    const enumeration = await enumerateCandidates(root, budget);
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
        : err(
            state === "planning" ||
              state === "executing" ||
              state === "recovering"
              ? "reconciliation_cleanup_failed"
              : "reconciliation_execution_failed",
            "reconciliation failed",
          );
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
  } finally {
    if (root !== undefined) await root.close();
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
  anchored: AnchoredRoot;
  binding: ReadyProfileRootBinding;
  children: Set<GenerationCapabilityRecord>;
  acceptingOperations: boolean;
  activeOperations: number;
  drainWaiters: Set<() => void>;
  childDrainWaiters: Set<() => void>;
  authorities: Set<AuthorityRecord>;
  partialCreateCleanups: Set<PartialCreateCleanupRecord>;
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

async function reacquireRootFromEvidence(
  evidence: ReconciledRootEvidence,
  admission: ReconciliationExecutionAdmission,
): Promise<AnchoredRoot> {
  const names = evidence.canonicalAbsoluteComponents;
  if (names.length < 2 || names[0] !== path.parse(path.sep).root) {
    throw unsafeCapability("reconciled root evidence is invalid");
  }
  const canonical = path.join(path.sep, ...names.slice(1));
  const anchored = await openAnchoredRoot(canonical, admission);
  try {
    const current = anchored.evidence(evidence.binding);
    if (
      JSON.stringify(current.canonicalAbsoluteComponents) !==
        JSON.stringify(evidence.canonicalAbsoluteComponents) ||
      JSON.stringify(current.componentIdentities) !==
        JSON.stringify(evidence.componentIdentities)
    ) {
      throw unsafeCapability("reconciled root authority changed");
    }
    return anchored;
  } catch (error) {
    await anchored.close();
    throw error;
  }
}

export async function reconcileBrowserStateWithAuthority(
  canonicalRoot: string,
  input: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
): Promise<InternalReconciliationOutcome> {
  let evidence: ReconciledRootEvidence | undefined;
  const result = await reconcileBrowserStateCore(
    canonicalRoot,
    input,
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
  });
  return token;
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
  let anchored: AnchoredRoot | undefined;
  let rootToken: AnchoredProfileRoot | undefined;
  let authority: InstalledReconciledAuthority | undefined;
  try {
    assertAdmitted(record.admission);
    anchored = await reacquireRootFromEvidence(record.evidence, record.admission);
    assertAdmitted(record.admission);
    const rootRecord: RootCapabilityRecord = {
      state: "live",
      anchored,
      binding: Object.freeze({ ...binding }),
      children: new Set(),
      acceptingOperations: true,
      activeOperations: 0,
      drainWaiters: new Set(),
      childDrainWaiters: new Set(),
      authorities: new Set(),
      partialCreateCleanups: new Set(),
    };
    rootToken = Object.freeze({}) as AnchoredProfileRoot;
    rootCapabilityRecords.set(rootToken, rootRecord);
    authority = Object.freeze({}) as InstalledReconciledAuthority;
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
    const retainedCleanup =
      rootToken !== undefined
        ? ({ kind: "root", root: rootToken } as const)
        : anchored !== undefined
          ? ({ kind: "anchored", anchored } as const)
          : undefined;
    try {
      if (retainedCleanup?.kind === "root") {
        await closeAnchoredProfileRoot(retainedCleanup.root);
      } else if (retainedCleanup?.kind === "anchored") {
        await retainedCleanup.anchored.close();
      }
    } catch (closeError) {
      if (retainedCleanup !== undefined) {
        record.state = "cleanup_unverified";
        record.retainedCleanup = retainedCleanup;
        retainedOutcomeCleanupRecords.add(record);
      }
      throw new AggregateError(
        [error, closeError],
        "reconciliation outcome cleanup failed",
      );
    }
    throw error;
  }
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

async function removeGeneration(token: BoundProfileGeneration): Promise<void> {
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
  evidence: Readonly<{
    stateRoot: AtomicObjectEvidenceV1;
    profilesParent: AtomicObjectEvidenceV1;
    stagingRoot: AtomicObjectEvidenceV1;
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
  | "stable_files"
  | "scratch_files"
  | "manifest_bytes"
  | "other_metadata_bytes";

type AtomicEffectFlightRecord = {
  state: "live" | "closing" | "closed" | "fail_stopped";
  operationId: string;
  epoch: object;
  root: RootCapabilityRecord;
  releaseRootOperation: () => void;
  registry: WeakMap<object, AtomicHeldRecord>;
  records: Set<AtomicHeldRecord>;
  removedRecords: WeakSet<AtomicHeldRecord>;
  enumerationCursors: WeakMap<object, number>;
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
  semanticCount: number;
  partialCount: number;
  effectCount: number;
  reservations: Record<AtomicReservationKind, { count: number; byteSize: number }>;
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
  payload_entries: Object.freeze({ count: 25_000, byteSize: 0 }),
  payload_bytes: Object.freeze({ count: 0, byteSize: 1_073_741_824 }),
  stable_files: Object.freeze({ count: 3_072, byteSize: 0 }),
  scratch_files: Object.freeze({ count: 1_024, byteSize: 0 }),
  manifest_bytes: Object.freeze({ count: 0, byteSize: 134_217_728 }),
  other_metadata_bytes: Object.freeze({ count: 0, byteSize: 16_777_216 }),
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
    !sameReadyBinding(record.binding, flight.root.binding)
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
  entry: "payload_entries" | "stable_files" | "scratch_files";
  bytes: "payload_bytes" | "manifest_bytes" | "other_metadata_bytes";
}>;

function atomicReservationRequirement(
  role: AtomicObjectRoleV1,
): AtomicReservationRequirement {
  switch (role) {
    case "payload_entry":
    case "private_source":
    case "public_source":
    case "public_target":
    case "wrapper":
      return { entry: "payload_entries", bytes: "payload_bytes" };
    case "manifest_stable":
    case "bundles_parent":
      return { entry: "stable_files", bytes: "manifest_bytes" };
    case "intent_stable":
    case "intents_parent":
    case "state_root":
    case "profiles_parent":
      return { entry: "stable_files", bytes: "other_metadata_bytes" };
    case "manifest_temp":
      return { entry: "scratch_files", bytes: "manifest_bytes" };
    case "intent_temp":
    case "private_deletion":
    case "staging_root":
    case "trusted_parent":
      return { entry: "scratch_files", bytes: "other_metadata_bytes" };
  }
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

function mintAtomicSemanticId(
  flight: AtomicEffectFlightRecord,
  record: AtomicHeldRecord,
): FlightSemanticId {
  if (
    flight.semanticCount + flight.partialCount >= ATOMIC_SEMANTIC_ID_LIMIT
  ) {
    throw atomicFailure("atomic publication semantic ID limit exceeded");
  }
  const token = Object.freeze({}) as FlightSemanticId;
  flight.registry.set(token as object, record);
  flight.records.add(record);
  flight.semanticCount += 1;
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

export async function acquireAtomicPreReadyRecoveryAuthority(
  root: AnchoredProfileRoot,
  operationId: string,
): Promise<AtomicPreReadyRecoveryLeaseV1> {
  if (!UUID.test(operationId)) {
    throw atomicFailure("atomic publication operation ID is invalid");
  }
  const rootRecord = requireRoot(root);
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
    if (
      profiles.stat.dev !== stateStat.dev ||
      staging.stat.dev !== stateStat.dev
    ) {
      throw atomicFailure("atomic publication authority device is invalid");
    }
    assertAtomicAllowedFilesystem(profiles.handle);
    assertAtomicAllowedFilesystem(staging.handle);
    const controller = Object.freeze({}) as AtomicEffectControllerV1;
    const flight: AtomicEffectFlightRecord = {
      state: "live",
      operationId,
      epoch: Object.freeze({}),
      root: rootRecord,
      releaseRootOperation,
      registry: new WeakMap(),
      records: new Set(),
      removedRecords: new WeakSet(),
      enumerationCursors: new WeakMap(),
      partials: new WeakMap(),
      livePartials: new Set(),
      transientHandles: new Set(),
      seenEffects: new WeakSet(),
      revalidatedHandles: new WeakSet(),
      statfsHandles: new WeakMap(),
      semanticCount: 0,
      partialCount: 0,
      effectCount: 0,
      reservations: {
        payload_entries: { count: 0, byteSize: 0 },
        payload_bytes: { count: 0, byteSize: 0 },
        stable_files: { count: 0, byteSize: 0 },
        scratch_files: { count: 0, byteSize: 0 },
        manifest_bytes: { count: 0, byteSize: 0 },
        other_metadata_bytes: { count: 0, byteSize: 0 },
      },
    };
    atomicEffectFlightRecords.set(controller as object, flight);
    const binding = rootRecord.binding;
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
        evidence: Object.freeze({
          stateRoot: stateRootRecord.evidence,
          profilesParent: profilesRecord.evidence,
          stagingRoot: stagingRecord.evidence,
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
    anchored,
    binding: Object.freeze({ ...binding }),
    children: new Set(),
    acceptingOperations: true,
    activeOperations: 0,
    drainWaiters: new Set(),
    childDrainWaiters: new Set(),
    authorities: new Set(),
    partialCreateCleanups: new Set(),
  };
  const root = Object.freeze({}) as AnchoredProfileRoot;
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
    if (
      (limit.count > 0 && current.count + request.count > limit.count) ||
      (limit.byteSize > 0 &&
        current.byteSize + request.byteSize > limit.byteSize)
    ) {
      return atomicRejected(flight, request, "budget_exceeded");
    }
    current.count += request.count;
    current.byteSize += request.byteSize;
  } else {
    if (
      request.count > current.count ||
      request.byteSize > current.byteSize
    ) {
      return atomicRejected(flight, request, "binding_invalid");
    }
    current.count -= request.count;
    current.byteSize -= request.byteSize;
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
    const handleId = mintAtomicSemanticId(flight, held);
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
  if (!atomicReservationAvailable(flight, openRequirement, 1, 0)) {
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
    const evidence = atomicEvidenceFromStat(stat, contentSha256);
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
    const handleId = mintAtomicSemanticId(flight, held);
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
    if (
      !record.owned ||
      record.role !== request.role ||
      !sameAtomicEvidence(record.evidence, request.expected)
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
        flight.records.delete(record);
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
    const requirement = atomicReservationRequirement(directory.role);
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
    const held: AtomicHeldRecord = Object.freeze({
      role: sourceSide
        ? "public_source"
        : request.move === "profile_source_to_private" ||
            request.move === "canary_source_to_private"
          ? "private_deletion"
          : "public_target",
      operationId: request.operationId,
      parentId,
      leaf,
      handle,
      binding: parent.binding,
      evidence,
      stat,
      owned: true,
    });
    const objectId = mintAtomicSemanticId(flight, held);
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

export async function applyAtomicEffect(
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
      return atomicRejected(flight, request, "unsupported");
    case "remove_intent":
    case "remove_manifest":
    case "remove_file":
    case "remove_directory":
    case "remove_root":
      return applyAtomicRemove(flight, request);
    case "populate_payload_entry":
      return atomicRejected(flight, request, "unsupported");
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
    case "replace_intent":
    case "persist_manifest":
      return atomicRejected(flight, request, "unsupported");
    case "native_no_replace":
      return applyAtomicNativeNoReplace(flight, request);
    case "observe_locations":
      return request.requestKind === "native_no_replace"
        ? applyAtomicObserveLocations(flight, request)
        : atomicRejected(flight, request, "unsupported");
    case "resolve_adoption":
    case "adopt_generation":
    case "release_publication":
      return atomicRejected(flight, request, "unsupported");
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
  for (let count = 0; count < 64; count += 1) {
    if (step.kind === "terminal") {
      if (
        step.result.kind === "mount_proved" ||
        step.result.kind === "cleanup_pending"
      ) {
        return step.result;
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
  flight.releaseRootOperation();
}

export function atomicHeldProfileHashImplementationIdentityForTest(): string {
  if (process.env.VITEST !== "true") {
    throw atomicFailure("atomic publication test seam is unavailable");
  }
  return ATOMIC_HELD_PROFILE_HASH_IMPLEMENTATION;
}
