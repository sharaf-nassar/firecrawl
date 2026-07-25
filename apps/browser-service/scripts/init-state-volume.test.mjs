import assert from "node:assert/strict";
import {
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const moduleUrl = new URL("./init-state-volume.mjs", import.meta.url);
const marker = ".firecrawl-browser-initialized-v1";
const stateLeaf = "state";
const stagingLeaf = ".profile-publish-staging";
const directories = [
  stateLeaf,
  `${stateLeaf}/profiles`,
  `${stateLeaf}/${stagingLeaf}`,
  `${stateLeaf}/${stagingLeaf}/intents`,
  `${stateLeaf}/${stagingLeaf}/bundles`,
];

async function loadInitializer() {
  return import(moduleUrl.href);
}

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "firecrawl-browser-volume-"));
  const root = join(temporary, "volume");
  await mkdir(root, { mode: 0o755 });
  return {
    root,
    policy: {
      parentUid: process.getuid(),
      parentGid: process.getgid(),
      childUid: process.getuid(),
      childGid: process.getgid(),
      markerUid: process.getuid(),
      markerGid: process.getgid(),
    },
    async cleanup() {
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

function comparable(status) {
  return {
    dev: status.dev,
    ino: status.ino,
    uid: status.uid,
    gid: status.gid,
    mode: status.mode,
    size: status.size,
    mtimeNs: status.mtimeNs,
    ctimeNs: status.ctimeNs,
  };
}

async function snapshot(root) {
  const result = new Map();
  const pending = [[".", root]];
  while (pending.length !== 0) {
    const [relative, current] = pending.pop();
    const status = await lstat(current, { bigint: true });
    result.set(relative, comparable(status));
    if (status.isFile()) {
      result.set(`${relative}:bytes`, await readFile(current));
    }
    if (status.isDirectory() && !status.isSymbolicLink()) {
      for (const name of await readdir(current)) {
        pending.push([
          relative === "." ? name : `${relative}/${name}`,
          join(current, name),
        ]);
      }
    }
  }
  return result;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

test("initializes an empty held parent and validates without mutation", async t => {
  const state = await fixture();
  t.after(state.cleanup);
  const { initializeStateVolumeForTest } = await loadInitializer();

  assert.equal(
    await initializeStateVolumeForTest(state.root, state.policy),
    "initialized",
  );
  assert.deepEqual(
    (await readdir(state.root)).sort(),
    [stateLeaf, marker].sort(),
  );
  assert.deepEqual(
    (await readdir(join(state.root, stateLeaf))).sort(),
    ["profiles", stagingLeaf].sort(),
  );
  assert.deepEqual(
    (await readdir(join(state.root, stateLeaf, stagingLeaf))).sort(),
    ["intents", "bundles"].sort(),
  );
  for (const relative of directories) {
    const status = await lstat(join(state.root, relative));
    assert.equal(status.isDirectory(), true, relative);
    assert.equal(status.isSymbolicLink(), false, relative);
    assert.equal(status.mode & 0o7777, 0o700, relative);
    assert.equal(status.uid, state.policy.childUid, relative);
    assert.equal(status.gid, state.policy.childGid, relative);
  }
  const parentStatus = await lstat(state.root);
  assert.equal(parentStatus.mode & 0o7777, 0o750);
  assert.equal(parentStatus.uid, state.policy.parentUid);
  assert.equal(parentStatus.gid, state.policy.parentGid);
  const markerStatus = await lstat(join(state.root, marker));
  assert.equal(markerStatus.mode & 0o7777, 0o600);
  assert.equal(await readFile(join(state.root, marker), "utf8"), "firecrawl-browser-volume-v1\n");

  const before = await snapshot(state.root);
  assert.equal(
    await initializeStateVolumeForTest(state.root, state.policy),
    "validated",
  );
  assert.deepEqual(await snapshot(state.root), before);
});

for (const optionalLeaves of [
  [],
  ["replay"],
  ["quarantine"],
  ["quarantine", "replay"],
]) {
  test(
    `validates and preserves restart state with ${
      optionalLeaves.length === 0 ? "no optional directories" : optionalLeaves.join("+")
    }`,
    async t => {
      const state = await fixture();
      t.after(state.cleanup);
      const { initializeStateVolumeForTest } = await loadInitializer();
      await initializeStateVolumeForTest(state.root, state.policy);
      for (const leaf of optionalLeaves) {
        const optional = join(state.root, stateLeaf, leaf);
        await mkdir(optional, { mode: 0o700 });
        await mkdir(join(optional, "payload"), { mode: 0o700 });
        await writeFile(join(optional, "payload", "bytes.bin"), `${leaf}\n`, {
          mode: 0o600,
        });
      }
      const before = await snapshot(state.root);
      assert.equal(
        await initializeStateVolumeForTest(state.root, state.policy),
        "validated",
      );
      assert.deepEqual(await snapshot(state.root), before);
    },
  );
}

test("rejects partial and unknown layouts", async t => {
  const { initializeStateVolumeForTest } = await loadInitializer();

  const partial = await fixture();
  t.after(partial.cleanup);
  await mkdir(join(partial.root, "state"));
  await assert.rejects(
    initializeStateVolumeForTest(partial.root, partial.policy),
    /layout/i,
  );

  const unknown = await fixture();
  t.after(unknown.cleanup);
  await writeFile(join(unknown.root, "foreign"), "foreign");
  await assert.rejects(
    initializeStateVolumeForTest(unknown.root, unknown.policy),
    /layout/i,
  );

  const nested = await fixture();
  t.after(nested.cleanup);
  await initializeStateVolumeForTest(nested.root, nested.policy);
  await mkdir(join(nested.root, stateLeaf, "foreign"), { mode: 0o700 });
  const before = await snapshot(nested.root);
  await assert.rejects(
    initializeStateVolumeForTest(nested.root, nested.policy),
    /state layout/i,
  );
  assert.deepEqual(await snapshot(nested.root), before);

  await rm(join(nested.root, stateLeaf, "foreign"), { recursive: true });
  await mkdir(
    join(nested.root, stateLeaf, stagingLeaf, "foreign"),
    { mode: 0o700 },
  );
  const stagingBefore = await snapshot(nested.root);
  await assert.rejects(
    initializeStateVolumeForTest(nested.root, nested.policy),
    /profile-publish-staging.*layout/i,
  );
  assert.deepEqual(await snapshot(nested.root), stagingBefore);
});

test("rejects a no-follow child in an otherwise valid layout", async t => {
  const { initializeStateVolumeForTest } = await loadInitializer();
  const linked = await fixture();
  t.after(linked.cleanup);
  await initializeStateVolumeForTest(linked.root, linked.policy);
  const held = `${linked.root}-profiles-held`;
  await mkdir(held, { mode: 0o700 });
  await rm(join(linked.root, stateLeaf, "profiles"), { recursive: true });
  await symlink(held, join(linked.root, stateLeaf, "profiles"));
  const before = await snapshot(linked.root);
  await assert.rejects(
    initializeStateVolumeForTest(linked.root, linked.policy),
    error =>
      error?.category === "browser_volume_initialization_failed" &&
      /ELOOP|ENOTDIR|symbolic link|identity/i.test(error.message),
  );
  assert.deepEqual(await snapshot(linked.root), before);
});

test("rejects unsafe optional managed directories without repair", async t => {
  const { initializeStateVolumeForTest } = await loadInitializer();

  const linked = await fixture();
  t.after(linked.cleanup);
  await initializeStateVolumeForTest(linked.root, linked.policy);
  const replayTarget = `${linked.root}-replay-held`;
  await mkdir(replayTarget, { mode: 0o700 });
  await writeFile(join(replayTarget, "bytes.bin"), "preserve\n", {
    mode: 0o600,
  });
  await symlink(replayTarget, join(linked.root, stateLeaf, "replay"));
  const linkedBefore = await snapshot(linked.root);
  await assert.rejects(
    initializeStateVolumeForTest(linked.root, linked.policy),
    error =>
      error?.category === "browser_volume_initialization_failed" &&
      /ELOOP|ENOTDIR|symbolic link|identity/i.test(error.message),
  );
  assert.deepEqual(await snapshot(linked.root), linkedBefore);

  const wrongMode = await fixture();
  t.after(wrongMode.cleanup);
  await initializeStateVolumeForTest(wrongMode.root, wrongMode.policy);
  await mkdir(join(wrongMode.root, stateLeaf, "quarantine"), { mode: 0o755 });
  const modeBefore = await snapshot(wrongMode.root);
  await assert.rejects(
    initializeStateVolumeForTest(wrongMode.root, wrongMode.policy),
    /quarantine.*mode/i,
  );
  assert.deepEqual(await snapshot(wrongMode.root), modeBefore);

  const replaced = await fixture();
  t.after(replaced.cleanup);
  await initializeStateVolumeForTest(replaced.root, replaced.policy);
  const replay = join(replaced.root, stateLeaf, "replay");
  await mkdir(replay, { mode: 0o700 });
  await writeFile(join(replay, "original.bin"), "original\n", { mode: 0o600 });
  const displaced = `${replaced.root}-replay-held`;
  let swapped = false;
  await assert.rejects(
    initializeStateVolumeForTest(replaced.root, replaced.policy, {
      afterDirectoryOpen({ relative }) {
        if (relative !== "state/replay" || swapped) return;
        swapped = true;
        renameSync(replay, displaced);
        mkdirSync(replay, { mode: 0o700 });
        writeFileSync(join(replay, "replacement.bin"), "replacement\n", {
          mode: 0o600,
        });
      },
    }),
    /replay.*changed during validation/i,
  );
  assert.equal(swapped, true);
  assert.equal(await readFile(join(displaced, "original.bin"), "utf8"), "original\n");
  assert.equal(
    await readFile(join(replay, "replacement.bin"), "utf8"),
    "replacement\n",
  );
});

test("rejects descendant and root swaps during held validation", async t => {
  const { initializeStateVolumeForTest } = await loadInitializer();

  const descendant = await fixture();
  t.after(descendant.cleanup);
  await initializeStateVolumeForTest(descendant.root, descendant.policy);
  let descendantSwapped = false;
  await assert.rejects(
    initializeStateVolumeForTest(descendant.root, descendant.policy, {
      afterDirectoryOpen({ relative }) {
        if (descendantSwapped || relative !== "state/profiles") return;
        descendantSwapped = true;
        const displaced = `${descendant.root}-profiles-held`;
        renameSync(
          join(descendant.root, stateLeaf, "profiles"),
          displaced,
        );
        symlinkSync(displaced, join(descendant.root, stateLeaf, "profiles"));
      },
    }),
    error =>
      error?.category === "browser_volume_initialization_failed" &&
      /changed during validation/i.test(error.message),
  );
  assert.equal(descendantSwapped, true);

  const rootSwap = await fixture();
  t.after(rootSwap.cleanup);
  await initializeStateVolumeForTest(rootSwap.root, rootSwap.policy);
  let rootSwapped = false;
  await assert.rejects(
    initializeStateVolumeForTest(rootSwap.root, rootSwap.policy, {
      beforeFinalParentValidation({ root }) {
        rootSwapped = true;
        const displaced = `${root}-held`;
        renameSync(root, displaced);
        symlinkSync(displaced, root);
      },
    }),
    error =>
      error?.category === "browser_volume_initialization_failed" &&
      /parent changed during validation/i.test(error.message),
  );
  assert.equal(rootSwapped, true);
});

test("rejects an empty parent with untrusted metadata", async t => {
  const state = await fixture();
  t.after(state.cleanup);
  const { initializeStateVolumeForTest } = await loadInitializer();
  await chmod(state.root, 0o777);
  await assert.rejects(
    initializeStateVolumeForTest(state.root, state.policy),
    /trusted named-volume root/i,
  );
  assert.deepEqual(await readdir(state.root), []);
  assert.equal((await lstat(state.root)).mode & 0o7777, 0o777);
});

test("rejects marker and metadata drift without repairing it", async t => {
  const state = await fixture();
  t.after(state.cleanup);
  const { initializeStateVolumeForTest } = await loadInitializer();
  await initializeStateVolumeForTest(state.root, state.policy);
  await chmod(join(state.root, stateLeaf, "profiles"), 0o755);
  const before = await snapshot(state.root);
  await assert.rejects(
    initializeStateVolumeForTest(state.root, state.policy),
    /mode/i,
  );
  assert.deepEqual(await snapshot(state.root), before);

  await chmod(join(state.root, stateLeaf, "profiles"), 0o700);
  await writeFile(join(state.root, marker), "wrong\n");
  const markerBefore = await snapshot(state.root);
  await assert.rejects(
    initializeStateVolumeForTest(state.root, state.policy),
    /marker/i,
  );
  assert.deepEqual(await snapshot(state.root), markerBefore);
});

test(
  "rejects a cross-device mounted managed child without mutation",
  { skip: process.getuid() !== 0 },
  async t => {
    const state = await fixture();
    let mounted = false;
    t.after(async () => {
      if (mounted) {
        const unmounted = await run("/usr/bin/umount", [
          "--lazy",
          "--",
          join(state.root, stateLeaf, "profiles"),
        ]);
        assert.equal(unmounted.code, 0, unmounted.stderr);
      }
      await state.cleanup();
    });
    const { initializeStateVolumeForTest } = await loadInitializer();
    await initializeStateVolumeForTest(state.root, state.policy);
    const profiles = join(state.root, stateLeaf, "profiles");
    const mountedResult = await run("/usr/bin/mount", [
      "--types",
      "tmpfs",
      "--options",
      "mode=0700,size=4m",
      "tmpfs",
      profiles,
    ]);
    assert.equal(mountedResult.code, 0, mountedResult.stderr);
    mounted = true;
    const before = await snapshot(state.root);
    await assert.rejects(
      initializeStateVolumeForTest(state.root, state.policy),
      /profiles.*device/i,
    );
    assert.deepEqual(await snapshot(state.root), before);
  },
);

test("external flock serializes concurrent initialization", async t => {
  const state = await fixture();
  t.after(state.cleanup);
  const helper = [
    `import {initializeStateVolumeForTest as run} from ${JSON.stringify(moduleUrl.href)};`,
    `await run(process.argv[1], JSON.parse(process.argv[2]));`,
  ].join("");
  const args = [
    "--exclusive",
    "--timeout",
    "10",
    state.root,
    process.execPath,
    "--input-type=module",
    "-e",
    helper,
    state.root,
    JSON.stringify(state.policy),
  ];
  const results = await Promise.all([
    run("/usr/bin/flock", args),
    run("/usr/bin/flock", args),
  ]);
  assert.deepEqual(
    results.map(result => result.code),
    [0, 0],
    results.map(result => result.stderr).join("\n"),
  );
});

test("external flock releases its lock when the owner crashes", async t => {
  const state = await fixture();
  t.after(state.cleanup);
  const first = await run("/usr/bin/flock", [
    "--exclusive",
    "--timeout",
    "2",
    state.root,
    "/bin/sh",
    "-c",
    "kill -KILL $$",
  ]);
  assert.equal(first.signal === "SIGKILL" || first.code !== 0, true);
  const second = await run("/usr/bin/flock", [
    "--exclusive",
    "--timeout",
    "2",
    state.root,
    "/bin/true",
  ]);
  assert.equal(second.code, 0, second.stderr);
});

test("script has a fixed production root and no JavaScript lock emulation", async () => {
  const source = await readFile(moduleUrl, "utf8");
  assert.match(source, /const VOLUME_ROOT = "\/var\/lib\/firecrawl-browser-volume"/);
  assert.doesNotMatch(source, /proper-lockfile|lockfile|O_EXCL.*lock|mkdir.*lock/i);
});
