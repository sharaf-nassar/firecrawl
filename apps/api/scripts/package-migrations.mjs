import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/**
 * Trust and atomicity model
 *
 * This is an offline build step. It assumes the canonical dist root and its
 * ancestors are controlled by the same cooperative build user. The lock
 * serializes cooperating packagers, and every mutation revalidates captured
 * ancestor identities while that lock is held.
 *
 * Pure Node does not expose fd-anchored renameat(2) or atomic directory
 * exchange. An uncooperative actor that renames paths between validation and a
 * mutation is outside this build-root trust boundary. Publication also has a
 * brief visibility gap while the old directory is moved into the private
 * transaction and the new directory is renamed into place.
 *
 * Before final destination verification, every failure rolls the old tree
 * back. Successful final verification is the commit point. Failure to remove
 * the private old-tree transaction after that point emits a recovery warning
 * and still returns success because the published destination is complete.
 */

const LOCK_FILENAME = ".migrations.package.lock";
const TRANSACTION_PREFIX = ".migrations.transaction-";

export class MigrationPackagingError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationPackagingError";
  }
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function isPathInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function pathsOverlap(first, second) {
  return (
    first === second ||
    isPathInside(first, second) ||
    isPathInside(second, first)
  );
}

async function inspectMigrationDirectory(
  directory,
  { allowMissing = false } = {},
) {
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new MigrationPackagingError(
      `Migration path must be a real directory: ${directory}`,
    );
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const invalidEntries = entries
    .filter(entry => !entry.isFile() || !entry.name.endsWith(".sql"))
    .map(entry => entry.name)
    .sort();

  if (invalidEntries.length > 0) {
    throw new MigrationPackagingError(
      `Migration directory contains non-SQL or non-file entries: ${invalidEntries.join(", ")}`,
    );
  }

  const filenames = entries.map(entry => entry.name).sort();
  const files = new Map();

  for (const filename of filenames) {
    const bytes = await readFile(join(directory, filename));
    if (bytes.length === 0) {
      throw new MigrationPackagingError(
        `Migration file must not be empty: ${filename}`,
      );
    }
    files.set(filename, bytes);
  }

  return { filenames, files };
}

async function capturePublicationPaths(
  sourceDir,
  destinationDir,
  trustedDistRoot,
) {
  const source = resolve(sourceDir);
  const destination = resolve(destinationDir);
  const trustedRoot = resolve(trustedDistRoot);
  const destinationParent = dirname(destination);

  const trustedRootStat = await lstat(trustedRoot);
  if (!trustedRootStat.isDirectory() || trustedRootStat.isSymbolicLink()) {
    throw new MigrationPackagingError(
      `Trusted dist root must be a real directory: ${trustedRoot}`,
    );
  }

  const canonicalTrustedRoot = await realpath(trustedRoot);
  if (canonicalTrustedRoot !== trustedRoot) {
    throw new MigrationPackagingError(
      `Trusted dist root must already be canonical: ${trustedRoot}`,
    );
  }

  if (!isPathInside(trustedRoot, destination)) {
    throw new MigrationPackagingError(
      `Migration destination escapes trusted dist root: ${destination}`,
    );
  }

  const parentFromRoot = relative(trustedRoot, destinationParent);
  const ancestorPaths = [trustedRoot];
  let currentPath = trustedRoot;

  for (const component of parentFromRoot.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, component);
    ancestorPaths.push(currentPath);
  }

  const ancestorIdentities = new Map();
  for (const ancestorPath of ancestorPaths) {
    const ancestorStat = await lstat(ancestorPath);
    if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
      throw new MigrationPackagingError(
        `Migration destination ancestor must be a real directory: ${ancestorPath}`,
      );
    }
    const canonicalAncestor = await realpath(ancestorPath);
    if (
      canonicalAncestor !== trustedRoot &&
      !isPathInside(trustedRoot, canonicalAncestor)
    ) {
      throw new MigrationPackagingError(
        `Migration destination resolves outside trusted dist root: ${destination}`,
      );
    }
    ancestorIdentities.set(ancestorPath, identity(ancestorStat));
  }

  const canonicalSource = await realpath(source);
  let canonicalDestination = destination;
  try {
    canonicalDestination = await realpath(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (pathsOverlap(canonicalSource, canonicalDestination)) {
    throw new MigrationPackagingError(
      "Migration source and destination must not alias or overlap",
    );
  }

  return {
    source,
    destination,
    destinationParent,
    trustedRoot,
    ancestorIdentities,
  };
}

async function assertPublicationAncestorsUnchanged(paths) {
  for (const [ancestorPath, expectedIdentity] of paths.ancestorIdentities) {
    const ancestorStat = await lstat(ancestorPath);
    if (
      !ancestorStat.isDirectory() ||
      ancestorStat.isSymbolicLink() ||
      !sameIdentity(identity(ancestorStat), expectedIdentity)
    ) {
      throw new MigrationPackagingError(
        `Migration destination ancestor identity changed: ${ancestorPath}`,
      );
    }

    const canonicalAncestor = await realpath(ancestorPath);
    if (
      canonicalAncestor !== paths.trustedRoot &&
      !isPathInside(paths.trustedRoot, canonicalAncestor)
    ) {
      throw new MigrationPackagingError(
        `Migration destination ancestor escaped trusted root: ${ancestorPath}`,
      );
    }
  }
}

async function assertOwnedDirectory(directory, expectedIdentity) {
  const directoryStat = await lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !sameIdentity(identity(directoryStat), expectedIdentity)
  ) {
    throw new MigrationPackagingError(
      `Owned migration transaction identity changed: ${directory}`,
    );
  }
}

export async function assertExactMigrationPackage(sourceDir, destinationDir) {
  const source = await inspectMigrationDirectory(sourceDir);
  const destination = await inspectMigrationDirectory(destinationDir);

  if (source.filenames.length === 0) {
    throw new MigrationPackagingError("No source SQL migrations found");
  }

  const missing = source.filenames.filter(
    filename => !destination.files.has(filename),
  );
  const extra = destination.filenames.filter(
    filename => !source.files.has(filename),
  );

  if (missing.length > 0 || extra.length > 0) {
    throw new MigrationPackagingError(
      `Packaged migration set mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }

  for (const filename of source.filenames) {
    if (!source.files.get(filename).equals(destination.files.get(filename))) {
      throw new MigrationPackagingError(
        `Packaged migration bytes differ: ${filename}`,
      );
    }
  }

  return source.filenames;
}

async function runFaultHook(faultHook, step, details = {}) {
  if (faultHook) {
    await faultHook(step, details);
  }
}

function defaultWarningHandler(message) {
  process.emitWarning(message, { code: "FIRECRAWL_MIGRATION_PACKAGING" });
}

function emitWarningSafely(onWarning, message) {
  try {
    onWarning(message);
  } catch (warningError) {
    process.emitWarning(
      `${message}. Warning handler also failed: ${warningError.message}`,
      { code: "FIRECRAWL_MIGRATION_PACKAGING" },
    );
  }
}

async function acquirePublicationLock(
  paths,
  { faultHook, lockTimeoutMs, lockRetryMs },
) {
  const lockPath = join(paths.destinationParent, LOCK_FILENAME);
  const ownerToken = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + lockTimeoutMs;

  while (true) {
    await runFaultHook(faultHook, "before-lock-create", { lockPath });
    await assertPublicationAncestorsUnchanged(paths);

    try {
      const handle = await open(lockPath, "wx", 0o600);
      const lockIdentity = identity(await handle.stat());
      try {
        await handle.writeFile(`${ownerToken}\n`);
        await runFaultHook(faultHook, "after-lock-created", { lockPath });
        await assertPublicationAncestorsUnchanged(paths);
        return { handle, lockIdentity, lockPath, ownerToken };
      } catch (error) {
        await handle.close();
        const cleanupErrors = [];
        try {
          await assertPublicationAncestorsUnchanged(paths);
          const lockPathStat = await lstat(lockPath);
          if (
            !lockPathStat.isFile() ||
            lockPathStat.isSymbolicLink() ||
            !sameIdentity(identity(lockPathStat), lockIdentity)
          ) {
            throw new MigrationPackagingError(
              `Refusing to remove unowned failed lock: ${lockPath}`,
            );
          }
          await unlink(lockPath);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Migration lock acquisition failed and cleanup was incomplete",
          );
        }
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw error;
      }
      await delay(lockRetryMs);
    }
  }
}

async function releasePublicationLock(paths, lock) {
  let owned = false;
  try {
    await assertPublicationAncestorsUnchanged(paths);
    const lockPathStat = await lstat(lock.lockPath);
    const lockContents = await readFile(lock.lockPath, "utf8");
    owned =
      lockPathStat.isFile() &&
      !lockPathStat.isSymbolicLink() &&
      sameIdentity(identity(lockPathStat), lock.lockIdentity) &&
      lockContents === `${lock.ownerToken}\n`;
  } finally {
    await lock.handle.close();
  }

  if (!owned) {
    throw new MigrationPackagingError(
      `Refusing to remove unowned migration publication lock: ${lock.lockPath}`,
    );
  }

  await assertPublicationAncestorsUnchanged(paths);
  await unlink(lock.lockPath);
}

async function revalidateOwnedMutation(paths, transaction) {
  await assertPublicationAncestorsUnchanged(paths);
  if (transaction) {
    await assertOwnedDirectory(
      transaction.transactionRoot,
      transaction.transactionIdentity,
    );
  }
}

async function removeOwnedTransaction(paths, transaction) {
  await revalidateOwnedMutation(paths, transaction);
  await rm(transaction.transactionRoot, { recursive: true });
}

export async function packageMigrations(
  sourceDir,
  destinationDir,
  {
    trustedDistRoot = dirname(dirname(dirname(resolve(destinationDir)))),
    faultHook,
    lockTimeoutMs = 30_000,
    lockRetryMs = 10,
    onWarning = defaultWarningHandler,
  } = {},
) {
  const paths = await capturePublicationPaths(
    sourceDir,
    destinationDir,
    trustedDistRoot,
  );
  const source = await inspectMigrationDirectory(paths.source);
  if (source.filenames.length === 0) {
    throw new MigrationPackagingError("No source SQL migrations found");
  }

  const lock = await acquirePublicationLock(paths, {
    faultHook,
    lockRetryMs,
    lockTimeoutMs,
  });
  let transaction;
  let destinationMoved = false;
  let newTreePublished = false;
  let committed = false;
  let operationError;

  try {
    await runFaultHook(faultHook, "after-lock-acquired", {
      lockPath: lock.lockPath,
    });
    await assertPublicationAncestorsUnchanged(paths);

    const existingDestination = await inspectMigrationDirectory(
      paths.destination,
      { allowMissing: true },
    );
    const hadDestination = existingDestination !== null;

    await runFaultHook(faultHook, "before-transaction-create");
    await assertPublicationAncestorsUnchanged(paths);
    const transactionRoot = await mkdtemp(
      join(paths.destinationParent, TRANSACTION_PREFIX),
    );
    const transactionStat = await lstat(transactionRoot);
    transaction = {
      transactionRoot,
      transactionIdentity: identity(transactionStat),
      newParent: join(transactionRoot, "new"),
      newPath: join(transactionRoot, "new", basename(paths.destination)),
      oldParent: join(transactionRoot, "old"),
      oldPath: join(transactionRoot, "old", basename(paths.destination)),
      hadDestination,
    };
    if ((transactionStat.mode & 0o777) !== 0o700) {
      throw new MigrationPackagingError(
        `Migration transaction directory is not private: ${transactionRoot}`,
      );
    }

    await revalidateOwnedMutation(paths, transaction);
    await mkdir(transaction.newParent, { mode: 0o700 });
    await revalidateOwnedMutation(paths, transaction);
    await mkdir(transaction.oldParent, { mode: 0o700 });
    await revalidateOwnedMutation(paths, transaction);
    await mkdir(transaction.newPath, { mode: 0o755 });

    for (const filename of source.filenames) {
      await runFaultHook(faultHook, "before-write", {
        filename,
        transactionRoot,
      });
      await revalidateOwnedMutation(paths, transaction);
      await writeFile(
        join(transaction.newPath, filename),
        source.files.get(filename),
        { flag: "wx", mode: 0o644 },
      );
    }

    await runFaultHook(faultHook, "before-stage-verify", {
      newPath: transaction.newPath,
      transactionRoot,
    });
    await revalidateOwnedMutation(paths, transaction);
    await assertExactMigrationPackage(paths.source, transaction.newPath);

    if (hadDestination) {
      await runFaultHook(faultHook, "before-old-move", {
        oldPath: transaction.oldPath,
      });
      await revalidateOwnedMutation(paths, transaction);
      await rename(paths.destination, transaction.oldPath);
      destinationMoved = true;
      await runFaultHook(faultHook, "after-old-move", {
        oldPath: transaction.oldPath,
      });
    }

    await runFaultHook(faultHook, "before-new-publish", {
      newPath: transaction.newPath,
    });
    await revalidateOwnedMutation(paths, transaction);
    await rename(transaction.newPath, paths.destination);
    newTreePublished = true;
    await runFaultHook(faultHook, "after-new-publish", {
      destination: paths.destination,
    });

    await runFaultHook(faultHook, "before-final-verify", {
      destination: paths.destination,
    });
    await revalidateOwnedMutation(paths, transaction);
    await assertExactMigrationPackage(paths.source, paths.destination);
    committed = true;

    try {
      await runFaultHook(faultHook, "before-postcommit-cleanup", {
        transactionRoot,
      });
      await removeOwnedTransaction(paths, transaction);
      transaction = undefined;
    } catch (cleanupError) {
      emitWarningSafely(
        onWarning,
        `Published migrations are valid, but old-tree cleanup failed. ` +
          `Remove owned recovery artifact after inspection: ${transactionRoot}. ` +
          `Cause: ${cleanupError.message}`,
      );
    }

    return source.filenames;
  } catch (error) {
    operationError = error;

    if (transaction && !committed) {
      const rollbackErrors = [];

      if (newTreePublished) {
        try {
          await revalidateOwnedMutation(paths, transaction);
          await rename(paths.destination, transaction.newPath);
          newTreePublished = false;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (destinationMoved) {
        try {
          await revalidateOwnedMutation(paths, transaction);
          await rename(transaction.oldPath, paths.destination);
          destinationMoved = false;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (rollbackErrors.length === 0) {
        try {
          await removeOwnedTransaction(paths, transaction);
          transaction = undefined;
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError);
        }
      }

      if (rollbackErrors.length > 0) {
        operationError = new AggregateError(
          [error, ...rollbackErrors],
          "Migration publication failed and rollback was incomplete",
        );
      }
    }
  } finally {
    try {
      await releasePublicationLock(paths, lock);
    } catch (lockError) {
      if (committed) {
        emitWarningSafely(
          onWarning,
          `Published migrations are valid, but owned lock cleanup failed. ` +
            `Inspect recovery artifact: ${lock.lockPath}. ` +
            `Cause: ${lockError.message}`,
        );
      } else if (operationError) {
        operationError = new AggregateError(
          [operationError, lockError],
          "Migration publication and owned lock cleanup failed",
        );
      } else {
        operationError = lockError;
      }
    }
  }

  if (operationError) {
    throw operationError;
  }
  return source.filenames;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = dirname(scriptDirectory);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const filenames = await packageMigrations(
    join(apiDirectory, "src", "db", "migrations"),
    join(apiDirectory, "dist", "src", "db", "migrations"),
    { trustedDistRoot: join(apiDirectory, "dist") },
  );
  process.stdout.write(`Packaged ${filenames.length} SQL migrations\n`);
}
