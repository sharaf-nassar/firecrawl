import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const CHECKPOINT_FILENAME = "storage-state.json";
const CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
        !(index === segments.length - 1 && segment === CHECKPOINT_FILENAME),
    )
  ) {
    throw new BrowserStateUnavailableError("path ID contains unsafe segments");
  }
  return segments;
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
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new BrowserStateUnavailableError(
        "configured root is not a directory",
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
    if (created) await chmod(candidate, 0o700);
    return candidate;
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

    const root = await this.#ensureRoot();
    const replay = await this.#ensureDirectory(root, "replay");
    const owner = await this.#ensureDirectory(replay, ownerId);
    const scrape = await this.#ensureDirectory(owner, scrapeId);
    const target = path.join(scrape, CHECKPOINT_FILENAME);
    const staging = path.join(scrape, `storage-state-${randomUUID()}.staging`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try {
        const existing = await lstat(target);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new BrowserStateUnavailableError(
            "checkpoint target is not a regular file",
          );
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }

      handle = await open(staging, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(staging, target);
      const directory = await open(scrape, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(staging, { force: true }).catch(() => undefined);
      if (error instanceof BrowserStateUnavailableError) throw error;
      throw new BrowserStateUnavailableError("checkpoint write failed", {
        cause: error,
      });
    }

    return {
      pathId: path.posix.join("replay", ownerId, scrapeId, CHECKPOINT_FILENAME),
      byteSize: bytes.byteLength,
      checksum: checksum(bytes),
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
      const stat = await lstat(file);
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > CHECKPOINT_MAX_BYTES
      ) {
        throw new BrowserStateUnavailableError("checkpoint file is invalid");
      }
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        bytes = await handle.readFile();
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
      if (isNodeError(error) && error.code === "ENOENT") return;
      if (
        error instanceof BrowserStateUnavailableError &&
        isNodeError(error.cause) &&
        error.cause.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    await rm(file);
    const scrapeDirectory = path.dirname(file);
    await rmdir(scrapeDirectory).catch(error => {
      if (
        !isNodeError(error) ||
        typeof error.code !== "string" ||
        !["ENOTEMPTY", "ENOENT"].includes(error.code)
      ) {
        throw error;
      }
    });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
