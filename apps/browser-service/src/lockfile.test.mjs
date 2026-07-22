import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageRoot = new URL("..", import.meta.url);

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "browser-service-lock-"));
  try {
    await cp(new URL("package.json", packageRoot), join(root, "package.json"));
    await cp(
      new URL("pnpm-lock.yaml", packageRoot),
      join(root, "pnpm-lock.yaml"),
    );
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function frozenInstall(root) {
  return spawnSync(
    "corepack",
    ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: root, encoding: "utf8" },
  );
}

function assertExpectedFrozenFailure(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(
    result.status,
    null,
    "Corepack did not report an exit status",
  );
  assert.equal(
    Number.isInteger(result.status),
    true,
    `Corepack exit status is not an integer: ${String(result.status)}`,
  );
  assert.notEqual(result.status, 0, result.stdout || result.stderr);
}

test("spawn failure cannot satisfy an expected frozen rejection", () => {
  const error = Object.assign(new Error("spawn corepack ENOENT"), {
    code: "ENOENT",
  });
  assert.throws(
    () =>
      assertExpectedFrozenFailure({
        error,
        status: null,
        stdout: "",
        stderr: "",
      }),
    /ENOENT/,
  );
});

test("frozen install rejects package drift", async () => {
  await withFixture(async (root) => {
    const path = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(path, "utf8"));
    packageJson.dependencies["lockfile-mismatch-probe"] = "0.0.0";
    await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`);
    const result = frozenInstall(root);
    assertExpectedFrozenFailure(result);
  });
});

test("frozen install rejects a missing lockfile", async () => {
  await withFixture(async (root) => {
    await rm(join(root, "pnpm-lock.yaml"));
    const result = frozenInstall(root);
    assertExpectedFrozenFailure(result);
  });
});
