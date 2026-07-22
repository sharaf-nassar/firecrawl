import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

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
const PROFILE_STATES = new Set(["committed", "staging", "working"]);
const PLAN_FILES = new Set([
  "plan.tmp",
  "plan.json",
  "complete.tmp",
  "complete",
]);

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
  handleClosed?: (point: string) => void;
  directoryStreamOpened?: (bufferSize: number) => void;
  beforeFinalPromotionAnchors?: () => void | Promise<void>;
  overflowLookaheadRead?: (
    read: () => Promise<Dirent<string> | null>,
  ) => Promise<Dirent<string> | null>;
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
): Promise<FileHandle> {
  assertAdmitted(admission);
  await filesystemTestContext.getStore()?.beforeCall?.(point);
  assertAdmitted(admission);
  let handle: FileHandle | undefined;
  try {
    handle = await operation();
    assertAdmitted(admission);
    await filesystemTestContext.getStore()?.afterCall?.(point);
    assertAdmitted(admission);
    return handle;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await closeRaw(handle, `failed-${point}`);
      } catch {
        // Preserve the acquisition failure after attempting ownership cleanup.
      }
    }
    throw error;
  }
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
  try {
    await handle.close();
  } catch (error) {
    closeFailure = error;
  } finally {
    filesystemTestContext.getStore()?.handleClosed?.(point);
  }
  if (injected !== undefined) throw injected;
  if (closeFailure !== undefined) throw closeFailure;
}

async function closeAll(
  handles: readonly (readonly [FileHandle | undefined, string])[],
): Promise<void> {
  const results = await Promise.allSettled(
    handles
      .filter(
        (item): item is readonly [FileHandle, string] => item[0] !== undefined,
      )
      .map(([handle, point]) => closeRaw(handle, point)),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "descriptor cleanup failed");
  }
}

async function closeAllDirect(handles: readonly FileHandle[]): Promise<void> {
  const results = await Promise.allSettled(
    handles.map((handle) => handle.close()),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
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

class AnchoredRoot {
  readonly handle: FileHandle;
  readonly admission: ReconciliationExecutionAdmission;

  constructor(handle: FileHandle, admission: ReconciliationExecutionAdmission) {
    this.handle = handle;
    this.admission = admission;
  }

  async close(): Promise<void> {
    await closeRaw(this.handle, "root");
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
    const entries: Dirent<string>[] = [];
    try {
      while (true) {
        const reservation = budget.reserve(true);
        let entry: Dirent<string> | null;
        try {
          if (reservation.overflow) {
            const read = (): Promise<Dirent<string> | null> =>
              admittedFilesystemCall(this.admission, () => openedStream.read());
            entry = await call(
              this.admission,
              "read-overflow-lookahead",
              () =>
                filesystemTestContext
                  .getStore()
                  ?.overflowLookaheadRead?.(read) ?? read(),
            );
          } else {
            entry = await call(this.admission, "read-directory-entry", () =>
              openedStream.read(),
            );
          }
        } catch (error) {
          reservation.rollback();
          throw error;
        }
        if (entry === null) {
          reservation.rollback();
          break;
        }
        reservation.commit();
        await call(this.admission, "yield-directory-entry", async () => entry);
        entries.push(entry);
      }
      return entries;
    } finally {
      await openedStream.close();
    }
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
  const canonical = await call(admission, "root-realpath", () =>
    fs.realpath(configuredRoot),
  );
  if (canonical !== path.resolve(configuredRoot)) {
    throw err(
      "reconciliation_filesystem_unsafe",
      "state root is not canonical",
    );
  }
  const handle = await callOpen(admission, "open-root", () =>
    fs.open(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ),
  );
  try {
    const procCanonical = await call(admission, "verify-procfs", () =>
      fs.realpath(procPath(handle)),
    );
    if (procCanonical !== canonical) {
      throw err(
        "reconciliation_filesystem_unsafe",
        "procfs file descriptor anchoring is unavailable",
      );
    }
    return new AnchoredRoot(handle, admission);
  } catch (error) {
    await closeRaw(handle, "failed-root");
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
): Promise<{ parent: FileHandle; leaf: string; owned: FileHandle[] }> {
  const segments = relative.split("/");
  const leaf = segments.pop();
  if (leaf === undefined || leaf === "") {
    throw err("reconciliation_filesystem_unsafe", "profile path is invalid");
  }
  let current = directory;
  const owned: FileHandle[] = [];
  try {
    for (const segment of segments) {
      validateSegment(segment);
      const next = await callOpen(
        root.admission,
        "profile-evidence-open-parent",
        () =>
          fs.open(
            procPath(current, segment),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
      );
      owned.push(next);
      current = next;
    }
    return { parent: current, leaf, owned };
  } catch (error) {
    await closeAllDirect(owned);
    throw error;
  }
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
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const chunk = Buffer.allocUnsafe(
            Math.min(64 * 1024, PROFILE_FILE_MAX_BYTES + 1 - size),
          );
          const read = await call(root.admission, "profile-evidence-read", () =>
            held!.read(chunk, 0, chunk.length, size),
          );
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
          if (size > PROFILE_FILE_MAX_BYTES) {
            throw err(
              "reconciliation_filesystem_unsafe",
              "profile file changed after hashing",
            );
          }
          chunks.push(chunk.subarray(0, read.bytesRead));
        }
        const heldStat = await call(
          root.admission,
          "profile-evidence-file-stat",
          () => held!.stat({ bigint: true }),
        );
        const contentSha256 = sha256(Buffer.concat(chunks, size));
        if (
          !sameLeafIdentity(current, heldStat) ||
          BigInt(size) !== heldStat.size ||
          contentSha256 !== expected.sha256
        ) {
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

async function enumerateCandidates(
  root: AnchoredRoot,
  budget: Budget,
): Promise<{ candidates: Candidate[]; namespaces: Set<string> }> {
  const result: Candidate[] = [];
  const top = await root.readdir(root.handle, budget);
  const namespaces = new Set(top.map((entry) => entry.name));
  for (const entry of top) {
    if (
      !["replay", "profiles", "quarantine"].includes(entry.name) ||
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
  const stat = await call(root.admission, "revalidate-parent", () =>
    handle.stat({ bigint: true }),
  );
  if (
    !stat.isDirectory() ||
    !sameParentIdentity(expected, parentIdentity(expected.path, stat))
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

export async function reconcileBrowserState(
  canonicalRoot: string,
  input: ReconciliationRequestV1,
  deps: ReconciliationDependencies,
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
