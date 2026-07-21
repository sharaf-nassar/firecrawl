import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import {
  prepareBrowserStateCheckpoint,
  syncBrowserStateDirectory,
} from "./filesystem-store-internal";

const CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_READ_CHUNK_BYTES = 64 * 1024;
const STAGING_STALE_MS = 60 * 60 * 1000;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHECKPOINT_FILENAME = /^[a-f0-9-]{36}\.json$/;
const STAGING_FILENAME =
  /^\.checkpoint-([a-f0-9-]{36})-(\d+)-([a-f0-9]{32})-(\d+)\.staging$/;

class BrowserStateUnavailableError extends Error {
  readonly category = "browser_state_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(`browser_state_unavailable: ${message}`, options);
    this.name = "BrowserStateUnavailableError";
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new BrowserStateUnavailableError("state is not JSON serializable");
  }
  return serialized;
}

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new BrowserStateUnavailableError(`${label} is not a safe path ID`);
  }
}

function validatePathId(value: string): string[] {
  if (!value || path.isAbsolute(value) || value.includes("\\")) {
    throw new BrowserStateUnavailableError("path ID must be relative");
  }
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment, index) =>
        !SAFE_PATH_SEGMENT.test(segment) &&
        !(
          index === segments.length - 1 &&
          (CHECKPOINT_FILENAME.test(segment) ||
            segment === "storage-state.json")
        ),
    )
  ) {
    throw new BrowserStateUnavailableError("path ID contains unsafe segments");
  }
  return segments;
}

interface BrowserStateCheckpointPlan {
  generationId: string;
  pathId: string;
  byteSize: number;
  checksum: string;
}

interface ProcessIdentity {
  bootId: string;
  startTime: string;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class BrowserStateFilesystem {
  readonly #root: string;

  constructor(root: string) {
    if (
      !path.isAbsolute(root) ||
      path.resolve(root) === path.parse(root).root
    ) {
      throw new BrowserStateUnavailableError(
        "configured root must be absolute and non-root",
      );
    }
    this.#root = path.resolve(root);
  }

  async #ensureRoot(): Promise<string> {
    const filesystemRoot = path.parse(this.#root).root;
    const segments = path.relative(filesystemRoot, this.#root).split(path.sep);
    let current = filesystemRoot;
    for (const segment of segments) {
      const candidate = path.join(current, segment);
      let created = false;
      try {
        await mkdir(candidate, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new BrowserStateUnavailableError(
          "configured root path contains a symlink",
        );
      }
      if ((await realpath(candidate)) !== candidate) {
        throw new BrowserStateUnavailableError(
          "configured root path contains a symlink",
        );
      }
      if (created) {
        await syncBrowserStateDirectory(candidate, syncDirectory);
        await syncBrowserStateDirectory(current, syncDirectory);
      }
      current = candidate;
    }
    const stat = await lstat(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new BrowserStateUnavailableError(
        "configured root is not a directory",
      );
    }
    if ((stat.mode & 0o777) !== 0o700) {
      throw new BrowserStateUnavailableError(
        "configured root permissions must be 0700",
      );
    }
    const canonicalRoot = await realpath(this.#root);
    if (canonicalRoot !== this.#root) {
      throw new BrowserStateUnavailableError("configured root uses a symlink");
    }
    return canonicalRoot;
  }

  async #ensureDirectory(parent: string, segment: string): Promise<string> {
    validateSegment(segment, "directory");
    const candidate = path.join(parent, segment);
    let created = false;
    try {
      await mkdir(candidate, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new BrowserStateUnavailableError("state path contains a symlink");
    }
    const canonical = await realpath(candidate);
    if (canonical !== candidate || !this.#isBelowRoot(canonical)) {
      throw new BrowserStateUnavailableError(
        "state path escapes configured root",
      );
    }
    if ((stat.mode & 0o777) !== 0o700) {
      throw new BrowserStateUnavailableError(
        "state directory permissions must be 0700",
      );
    }
    if (created) {
      await syncBrowserStateDirectory(candidate, syncDirectory);
      await syncBrowserStateDirectory(parent, syncDirectory);
    }
    return candidate;
  }

  async #removeStaleStaging(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const currentUid = process.getuid?.();
    const bootId = await readBootId();
    for (const entry of entries) {
      const match = STAGING_FILENAME.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const candidate = path.join(directory, entry.name);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(candidate);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (currentUid !== undefined && stat.uid !== currentUid) ||
        Date.now() - stat.mtimeMs < STAGING_STALE_MS ||
        (await isSameProcessIdentity(
          Number(match[2]),
          match[3],
          match[4],
          bootId,
        ))
      ) {
        continue;
      }
      await rm(candidate, { force: true });
    }
  }

  #isBelowRoot(candidate: string): boolean {
    const relative = path.relative(this.#root, candidate);
    return (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".."
    );
  }

  async #resolveExisting(pathId: string): Promise<string> {
    const segments = validatePathId(pathId);
    let current = await this.#ensureRoot();
    for (const segment of segments) {
      const candidate = path.join(current, segment);
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new BrowserStateUnavailableError("state path contains a symlink");
      }
      const canonical = await realpath(candidate);
      if (canonical !== candidate || !this.#isBelowRoot(canonical)) {
        throw new BrowserStateUnavailableError(
          "state path escapes configured root",
        );
      }
      current = candidate;
    }
    return current;
  }

  async #syncNearestExistingParent(pathId: string): Promise<void> {
    const segments = validatePathId(pathId);
    segments.pop();
    let current = await this.#ensureRoot();
    for (const segment of segments) {
      const candidate = path.join(current, segment);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(candidate);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          await syncBrowserStateDirectory(current, syncDirectory);
          return;
        }
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new BrowserStateUnavailableError("state path contains a symlink");
      }
      const canonical = await realpath(candidate);
      if (canonical !== candidate || !this.#isBelowRoot(canonical)) {
        throw new BrowserStateUnavailableError(
          "state path escapes configured root",
        );
      }
      current = candidate;
    }
    await syncBrowserStateDirectory(current, syncDirectory);
  }

  async writeCheckpoint(
    ownerId: string,
    scrapeId: string,
    storageState: unknown,
  ): Promise<{ pathId: string; byteSize: number; checksum: string }> {
    validateSegment(ownerId, "owner ID");
    validateSegment(scrapeId, "scrape ID");
    const bytes = Buffer.from(stableJson(storageState), "utf8");
    if (bytes.byteLength > CHECKPOINT_MAX_BYTES) {
      throw new BrowserStateUnavailableError("checkpoint exceeds 2 MiB");
    }
    const generationId = randomUUID();
    const filename = `${generationId}.json`;
    const plan = {
      generationId,
      pathId: path.posix.join("replay", ownerId, scrapeId, filename),
      byteSize: bytes.byteLength,
      checksum: checksum(bytes),
    } satisfies BrowserStateCheckpointPlan;
    await prepareBrowserStateCheckpoint(plan);

    const root = await this.#ensureRoot();
    const replay = await this.#ensureDirectory(root, "replay");
    const owner = await this.#ensureDirectory(replay, ownerId);
    const scrape = await this.#ensureDirectory(owner, scrapeId);
    await this.#removeStaleStaging(scrape);
    const target = path.join(scrape, filename);
    const identity = await readProcessIdentity(process.pid);
    const staging = path.join(
      scrape,
      `.checkpoint-${generationId}-${process.pid}-${identity.bootId}-${identity.startTime}.staging`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamedGeneration = false;
    try {
      handle = await open(staging, "wx", 0o600);
      await handle.writeFile(bytes);
      const staged = await handle.stat();
      if (
        !staged.isFile() ||
        staged.nlink !== 1 ||
        (staged.mode & 0o777) !== 0o600 ||
        staged.size !== bytes.byteLength
      ) {
        throw new BrowserStateUnavailableError("staging file is invalid");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(staging, target);
      renamedGeneration = true;
      await syncBrowserStateDirectory(scrape, syncDirectory);
    } catch (error) {
      const primary =
        error instanceof BrowserStateUnavailableError
          ? error
          : new BrowserStateUnavailableError("checkpoint write failed", {
              cause: error,
            });
      const cleanupErrors: unknown[] = [];
      if (handle) {
        await handle
          .close()
          .catch(closeError => cleanupErrors.push(closeError));
      }
      await rm(renamedGeneration ? target : staging, { force: true }).catch(
        removeError => cleanupErrors.push(removeError),
      );
      await syncBrowserStateDirectory(scrape, syncDirectory).catch(syncError =>
        cleanupErrors.push(syncError),
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primary, ...cleanupErrors],
          "Checkpoint write and durability cleanup failed",
        );
      }
      throw primary;
    }

    return {
      pathId: plan.pathId,
      byteSize: plan.byteSize,
      checksum: plan.checksum,
    };
  }

  async readCheckpoint(
    pathId: string,
    expectedChecksum: string,
  ): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) {
      throw new BrowserStateUnavailableError("checkpoint checksum is invalid");
    }
    let file: string;
    try {
      file = await this.#resolveExisting(pathId);
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          (before.mode & 0o777) !== 0o600 ||
          before.size > CHECKPOINT_MAX_BYTES
        ) {
          throw new BrowserStateUnavailableError("checkpoint file is invalid");
        }
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const buffer = Buffer.allocUnsafe(
            Math.min(
              CHECKPOINT_READ_CHUNK_BYTES,
              CHECKPOINT_MAX_BYTES + 1 - total,
            ),
          );
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > CHECKPOINT_MAX_BYTES) {
            throw new BrowserStateUnavailableError("checkpoint exceeds 2 MiB");
          }
          chunks.push(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          total !== before.size
        ) {
          throw new BrowserStateUnavailableError(
            "checkpoint changed while being read",
          );
        }
        bytes = Buffer.concat(chunks, total);
      } finally {
        await handle.close();
      }
      if (checksum(bytes) !== expectedChecksum) {
        throw new BrowserStateUnavailableError("checkpoint checksum mismatch");
      }
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof BrowserStateUnavailableError) throw error;
      if (error instanceof SyntaxError) {
        throw new BrowserStateUnavailableError("checkpoint JSON is invalid", {
          cause: error,
        });
      }
      throw new BrowserStateUnavailableError("checkpoint read failed", {
        cause: error,
      });
    }
  }

  async delete(pathId: string): Promise<void> {
    let file: string;
    try {
      file = await this.#resolveExisting(pathId);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.#syncNearestExistingParent(pathId);
        return;
      }
      if (
        error instanceof BrowserStateUnavailableError &&
        isNodeError(error.cause) &&
        error.cause.code === "ENOENT"
      ) {
        await this.#syncNearestExistingParent(pathId);
        return;
      }
      throw error;
    }
    await rm(file);
    const scrapeDirectory = path.dirname(file);
    await syncBrowserStateDirectory(scrapeDirectory, syncDirectory);
    let removedDirectory = false;
    await rmdir(scrapeDirectory)
      .then(() => {
        removedDirectory = true;
      })
      .catch(error => {
        if (
          !isNodeError(error) ||
          typeof error.code !== "string" ||
          !["ENOTEMPTY", "ENOENT"].includes(error.code)
        ) {
          throw error;
        }
      });
    if (removedDirectory) {
      await syncBrowserStateDirectory(
        path.dirname(scrapeDirectory),
        syncDirectory,
      );
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readBootId(): Promise<string> {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8"))
    .trim()
    .replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(bootId)) {
    throw new BrowserStateUnavailableError("process boot identity is invalid");
  }
  return bootId;
}

async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new BrowserStateUnavailableError("process identity is invalid");
  }
  const bootId = await readBootId();
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const endOfName = stat.lastIndexOf(")");
  const startTime = stat.slice(endOfName + 2).split(" ")[19];
  if (endOfName < 0 || !startTime || !/^\d+$/.test(startTime)) {
    throw new BrowserStateUnavailableError("process start identity is invalid");
  }
  return { bootId, startTime };
}

async function isSameProcessIdentity(
  pid: number,
  expectedBootId: string,
  expectedStartTime: string,
  currentBootId: string,
): Promise<boolean> {
  if (expectedBootId !== currentBootId) return false;
  try {
    const identity = await readProcessIdentity(pid);
    return (
      identity.bootId === expectedBootId &&
      identity.startTime === expectedStartTime
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    if (isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? "")) {
      return true;
    }
    throw error;
  }
}
