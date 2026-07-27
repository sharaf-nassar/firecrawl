import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MigrationPackagingError,
  assertExactMigrationPackage,
  packageMigrations,
} from "./package-migrations.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = dirname(scriptDirectory);
const temporaryDirectories = [];

async function fixture({ withDestination = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "firecrawl-migrations-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  const dist = join(root, "dist");
  const destinationParent = join(dist, "src", "db");
  const destination = join(destinationParent, "migrations");
  await mkdir(source);
  await mkdir(destinationParent, { recursive: true });
  if (withDestination) {
    await mkdir(destination);
  }
  return { root, source, dist, destinationParent, destination };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { recursive: true, force: true })),
  );
});

async function writeSource(source) {
  await writeFile(join(source, "0002_second.sql"), "SELECT 2;\n");
  await writeFile(join(source, "0001_first.sql"), "SELECT 1;\n");
}

async function directorySnapshot(directory) {
  const filenames = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      filenames.map(async filename => [
        filename,
        await readFile(join(directory, filename), "utf8"),
      ]),
    ),
  );
}

async function publicationArtifacts(destinationParent) {
  return (await readdir(destinationParent))
    .filter(
      entry =>
        entry === ".migrations.package.lock" ||
        entry.startsWith(".migrations.transaction-"),
    )
    .sort();
}

async function assertNoPublicationArtifacts(destinationParent) {
  assert.deepEqual(await publicationArtifacts(destinationParent), []);
}

test("publishes exact migrations and preserves unrelated siblings", async () => {
  const { source, dist, destinationParent, destination } = await fixture();
  await writeSource(source);
  await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
  const collisionSentinel = join(
    destinationParent,
    ".migrations.staging-collision.backup",
  );
  const unrelatedSibling = join(destinationParent, "keep-me");
  await writeFile(collisionSentinel, "sentinel");
  await mkdir(unrelatedSibling);
  await writeFile(join(unrelatedSibling, "data"), "keep");

  const filenames = await packageMigrations(source, destination, {
    trustedDistRoot: dist,
  });

  assert.deepEqual(filenames, ["0001_first.sql", "0002_second.sql"]);
  assert.deepEqual(await directorySnapshot(destination), {
    "0001_first.sql": "SELECT 1;\n",
    "0002_second.sql": "SELECT 2;\n",
  });
  assert.equal(await readFile(collisionSentinel, "utf8"), "sentinel");
  assert.equal(await readFile(join(unrelatedSibling, "data"), "utf8"), "keep");
  await assertNoPublicationArtifacts(destinationParent);
});

test("packages a fresh dist and routes production compile scripts through build", async () => {
  const { source, dist, destinationParent, destination } = await fixture({
    withDestination: false,
  });
  await writeSource(source);

  await packageMigrations(source, destination, { trustedDistRoot: dist });

  assert.deepEqual(await directorySnapshot(destination), {
    "0001_first.sql": "SELECT 1;\n",
    "0002_second.sql": "SELECT 2;\n",
  });
  await assertNoPublicationArtifacts(destinationParent);

  const packageJson = JSON.parse(
    await readFile(join(apiDirectory, "package.json"), "utf8"),
  );
  assert.match(packageJson.scripts.build, /package-migrations\.mjs/);
  assert.match(packageJson.scripts.start, /^pnpm run build && /);
  assert.match(packageJson.scripts["server:production"], /^pnpm run build && /);

  const dockerfile = await readFile(join(apiDirectory, "Dockerfile"), "utf8");
  assert.doesNotMatch(
    dockerfile,
    /COPY --from=build \/app\/src\/db\/migrations/,
  );
});

test("rejects malformed migration trees before publication", async t => {
  await t.test("empty migration", async () => {
    const { source, dist, destinationParent, destination } = await fixture();
    await writeFile(join(source, "0001_empty.sql"), "");
    await assert.rejects(
      packageMigrations(source, destination, { trustedDistRoot: dist }),
      MigrationPackagingError,
    );
    await assertNoPublicationArtifacts(destinationParent);
  });

  await t.test("non-SQL source entry", async () => {
    const { source, dist, destinationParent, destination } = await fixture();
    await writeFile(join(source, "README.md"), "unexpected");
    await assert.rejects(
      packageMigrations(source, destination, { trustedDistRoot: dist }),
      MigrationPackagingError,
    );
    await assertNoPublicationArtifacts(destinationParent);
  });

  await t.test("non-file source entry", async () => {
    const { source, dist, destinationParent, destination } = await fixture();
    await mkdir(join(source, "0001_nested.sql"));
    await assert.rejects(
      packageMigrations(source, destination, { trustedDistRoot: dist }),
      MigrationPackagingError,
    );
    await assertNoPublicationArtifacts(destinationParent);
  });

  await t.test("unexpected destination entry", async () => {
    const { source, dist, destinationParent, destination } = await fixture();
    await writeSource(source);
    await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
    await writeFile(join(destination, "unexpected.txt"), "keep");
    const before = await directorySnapshot(destination);

    await assert.rejects(
      packageMigrations(source, destination, { trustedDistRoot: dist }),
      MigrationPackagingError,
    );

    assert.deepEqual(await directorySnapshot(destination), before);
    await assertNoPublicationArtifacts(destinationParent);
  });
});

test("rejects escape, alias, and overlap without mutation", async t => {
  await t.test("symlinked destination ancestor", async () => {
    const { root, source, dist, destination } = await fixture();
    await writeSource(source);
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(dist, "linked"));

    await assert.rejects(
      packageMigrations(source, join(dist, "linked", "migrations"), {
        trustedDistRoot: dist,
      }),
      MigrationPackagingError,
    );

    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(destination), []);
  });

  await t.test("canonical escape", async () => {
    const { root, source, dist, destination } = await fixture();
    await writeSource(source);
    const escaped = join(root, "escaped");
    await mkdir(escaped);

    await assert.rejects(
      packageMigrations(source, join(dist, "..", "escaped", "migrations"), {
        trustedDistRoot: dist,
      }),
      MigrationPackagingError,
    );

    assert.deepEqual(await readdir(escaped), []);
    assert.deepEqual(await readdir(destination), []);
  });

  await t.test("source aliases destination", async () => {
    const { dist, destinationParent, destination } = await fixture();
    await writeFile(join(destination, "0001_first.sql"), "SELECT 1;\n");
    const before = await directorySnapshot(destination);

    await assert.rejects(
      packageMigrations(destination, destination, { trustedDistRoot: dist }),
      /must not alias or overlap/,
    );

    assert.deepEqual(await directorySnapshot(destination), before);
    await assertNoPublicationArtifacts(destinationParent);
  });

  await t.test("source overlaps destination", async () => {
    const { dist, destinationParent, destination } = await fixture();
    await writeFile(join(destination, "0001_first.sql"), "SELECT 1;\n");

    await assert.rejects(
      packageMigrations(destinationParent, destination, {
        trustedDistRoot: dist,
      }),
      /must not alias or overlap/,
    );

    assert.deepEqual(await directorySnapshot(destination), {
      "0001_first.sql": "SELECT 1;\n",
    });
    await assertNoPublicationArtifacts(destinationParent);
  });
});

test("rolls back the complete precommit fault matrix", async t => {
  const failureSteps = [
    "before-lock-create",
    "after-lock-created",
    "after-lock-acquired",
    "before-transaction-create",
    "before-write",
    "before-stage-verify",
    "before-old-move",
    "after-old-move",
    "before-new-publish",
    "after-new-publish",
    "before-final-verify",
  ];

  for (const failureStep of failureSteps) {
    await t.test(failureStep, async () => {
      const { source, dist, destinationParent, destination } = await fixture();
      await writeSource(source);
      await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
      const before = await directorySnapshot(destination);

      await assert.rejects(
        packageMigrations(source, destination, {
          trustedDistRoot: dist,
          faultHook(step, details) {
            if (
              step === failureStep &&
              (step !== "before-write" ||
                details.filename === "0002_second.sql")
            ) {
              throw new Error(`injected ${failureStep} failure`);
            }
          },
        }),
        new RegExp(`injected ${failureStep} failure`),
      );

      assert.deepEqual(await directorySnapshot(destination), before);
      await assertNoPublicationArtifacts(destinationParent);
    });
  }
});

test("rolls back an absent destination and an actual stage mismatch", async t => {
  await t.test("absent destination", async () => {
    const { source, dist, destinationParent, destination } = await fixture({
      withDestination: false,
    });
    await writeSource(source);

    await assert.rejects(
      packageMigrations(source, destination, {
        trustedDistRoot: dist,
        faultHook(step) {
          if (step === "after-new-publish") {
            throw new Error("injected publish failure");
          }
        },
      }),
      /injected publish failure/,
    );

    await assert.rejects(lstat(destination), error => error.code === "ENOENT");
    await assertNoPublicationArtifacts(destinationParent);
  });

  await t.test("stage byte mismatch", async () => {
    const { source, dist, destinationParent, destination } = await fixture();
    await writeSource(source);
    await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
    const before = await directorySnapshot(destination);

    await assert.rejects(
      packageMigrations(source, destination, {
        trustedDistRoot: dist,
        async faultHook(step, details) {
          if (step === "before-stage-verify") {
            await writeFile(
              join(details.newPath, "0001_first.sql"),
              "corrupt\n",
            );
          }
        },
      }),
      /bytes differ/,
    );

    assert.deepEqual(await directorySnapshot(destination), before);
    await assertNoPublicationArtifacts(destinationParent);
  });
});

test("treats final verification as commit despite old-tree cleanup failure", async () => {
  const { source, dist, destinationParent, destination } = await fixture();
  await writeSource(source);
  await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
  const warnings = [];
  let recoveryArtifact;

  const filenames = await packageMigrations(source, destination, {
    trustedDistRoot: dist,
    faultHook(step, details) {
      if (step === "before-postcommit-cleanup") {
        recoveryArtifact = details.transactionRoot;
        throw new Error("injected cleanup failure");
      }
    },
    onWarning(message) {
      warnings.push(message);
    },
  });

  assert.deepEqual(filenames, ["0001_first.sql", "0002_second.sql"]);
  assert.deepEqual(await directorySnapshot(destination), {
    "0001_first.sql": "SELECT 1;\n",
    "0002_second.sql": "SELECT 2;\n",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Published migrations are valid/);
  assert.match(warnings[0], /owned recovery artifact/);
  assert.match(
    warnings[0],
    new RegExp(recoveryArtifact.replaceAll(".", "\\.")),
  );
  assert.equal((await lstat(recoveryArtifact)).mode & 0o777, 0o700);
  assert.deepEqual(await publicationArtifacts(destinationParent), [
    recoveryArtifact.slice(destinationParent.length + 1),
  ]);
  assert.deepEqual(
    await directorySnapshot(join(recoveryArtifact, "old", "migrations")),
    { "0000_stale.sql": "SELECT 0;\n" },
  );
});

test("serializes cooperative concurrent publishers with the exclusive lock", async () => {
  const { source, dist, destinationParent, destination } = await fixture();
  await writeSource(source);
  await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
  let releaseFirst;
  const firstMayContinue = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let firstHasLock;
  const firstLocked = new Promise(resolve => {
    firstHasLock = resolve;
  });

  const first = packageMigrations(source, destination, {
    trustedDistRoot: dist,
    async faultHook(step) {
      if (step === "after-lock-acquired") {
        firstHasLock();
        await firstMayContinue;
      }
    },
  });
  await firstLocked;

  let secondSettled = false;
  const second = packageMigrations(source, destination, {
    trustedDistRoot: dist,
  }).finally(() => {
    secondSettled = true;
  });

  await delay(40);
  assert.equal(secondSettled, false);
  releaseFirst();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, ["0001_first.sql", "0002_second.sql"]);
  assert.deepEqual(secondResult, firstResult);
  assert.deepEqual(await directorySnapshot(destination), {
    "0001_first.sql": "SELECT 1;\n",
    "0002_second.sql": "SELECT 2;\n",
  });
  await assertNoPublicationArtifacts(destinationParent);
});

test("never removes an unowned lock or collision sentinel", async () => {
  const { source, dist, destinationParent, destination } = await fixture();
  await writeSource(source);
  const lockPath = join(destinationParent, ".migrations.package.lock");
  await writeFile(lockPath, "other-owner\n");

  await assert.rejects(
    packageMigrations(source, destination, {
      trustedDistRoot: dist,
      lockRetryMs: 2,
      lockTimeoutMs: 10,
    }),
    error => error.code === "EEXIST",
  );

  assert.equal(await readFile(lockPath, "utf8"), "other-owner\n");
  assert.deepEqual(await readdir(destination), []);
});

test("detects a parent-to-symlink swap and leaves outside target untouched", async () => {
  const { root, source, dist, destinationParent, destination } =
    await fixture();
  await writeSource(source);
  await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
  const outside = join(root, "outside");
  const displacedParent = `${destinationParent}-original`;
  await mkdir(outside);

  await assert.rejects(
    packageMigrations(source, destination, {
      trustedDistRoot: dist,
      async faultHook(step) {
        if (step === "after-lock-acquired") {
          await rename(destinationParent, displacedParent);
          await symlink(outside, destinationParent);
        }
      },
    }),
    /owned lock cleanup failed/,
  );

  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(
    await directorySnapshot(join(displacedParent, "migrations")),
    { "0000_stale.sql": "SELECT 0;\n" },
  );
});

test("does not unlink a replaced lock after a committed publication", async () => {
  const { source, dist, destinationParent, destination } = await fixture();
  await writeSource(source);
  await writeFile(join(destination, "0000_stale.sql"), "SELECT 0;\n");
  const warnings = [];
  let lockPath;

  const result = await packageMigrations(source, destination, {
    trustedDistRoot: dist,
    async faultHook(step, details) {
      if (step === "after-lock-acquired") {
        lockPath = details.lockPath;
      }
      if (step === "before-postcommit-cleanup") {
        await unlink(lockPath);
        await writeFile(lockPath, "replacement-owner\n");
      }
    },
    onWarning(message) {
      warnings.push(message);
    },
  });

  assert.deepEqual(result, ["0001_first.sql", "0002_second.sql"]);
  assert.equal(await readFile(lockPath, "utf8"), "replacement-owner\n");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /owned lock cleanup failed/);
  assert.deepEqual(await directorySnapshot(destination), {
    "0001_first.sql": "SELECT 1;\n",
    "0002_second.sql": "SELECT 2;\n",
  });
});

test("verification rejects missing, extra, and byte-different migrations", async t => {
  await t.test("missing migration", async () => {
    const { source, destination } = await fixture();
    await writeFile(join(source, "0001_first.sql"), "SELECT 1;\n");
    await assert.rejects(
      assertExactMigrationPackage(source, destination),
      /missing: 0001_first\.sql/,
    );
  });

  await t.test("extra migration", async () => {
    const { source, destination } = await fixture();
    await writeFile(join(source, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(destination, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(destination, "0002_extra.sql"), "SELECT 2;\n");
    await assert.rejects(
      assertExactMigrationPackage(source, destination),
      /extra: 0002_extra\.sql/,
    );
  });

  await t.test("different bytes", async () => {
    const { source, destination } = await fixture();
    await writeFile(join(source, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(destination, "0001_first.sql"), "SELECT 9;\n");
    await assert.rejects(
      assertExactMigrationPackage(source, destination),
      /bytes differ: 0001_first\.sql/,
    );
  });
});
