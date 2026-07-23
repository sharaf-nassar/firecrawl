import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { constants as osConstants } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const script = realpathSync(fileURLToPath(import.meta.url));
const node = realpathSync(process.execPath);
const expectedBase = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
  ATOMIC_BUILD_LOCK_FD: "9",
};
const fixtureControlPrefix = "atomic-orphan-fixture-control-v1:";
const boundaryControlPrefix = "atomic-orphan-boundary-v1:";
const boundarySchedules = new Set([
  "none",
  "ready",
  "driver-exit",
  "adoption",
  "evidence",
  "claim-ack",
  "contention",
  "release-write-attempt",
  "release-write-syscall",
  "release-write-result",
  "close-attempt",
  "close-syscall",
  "close-result",
  "promise-return",
  "promise-storage",
  "promise-pending",
  "promise-settlement",
  "repeated-reentry",
]);

function fail(message) {
  throw new Error(`atomic orphan lock fixture: ${message}`);
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const addonIdentityKeys = Object.freeze([
  "dev",
  "ino",
  "size",
  "mode",
  "uid",
  "gid",
  "nlink",
  "mtimeNs",
  "ctimeNs",
]);
let heldTestAddon;

function loadHeldTestAddon() {
  const before = fstatSync(5, { bigint: true });
  const beforeFdinfo = readFileSync("/proc/self/fdinfo/5", "utf8");
  if (
    !before.isFile() ||
    before.uid !== BigInt(process.getuid()) ||
    (before.mode & 0o7777n) !== 0o600n ||
    before.nlink !== 1n ||
    before.size <= 0n
  ) {
    fail("held test addon identity is invalid");
  }
  if (heldTestAddon === undefined) {
    const moduleRecord = { exports: Object.create(null) };
    process.dlopen(
      moduleRecord,
      "/proc/self/fd/5",
      osConstants.dlopen.RTLD_NOW,
    );
    heldTestAddon = moduleRecord.exports;
  }
  const after = fstatSync(5, { bigint: true });
  const hookKeys = [
    "becomeChildSubreaperForTest",
    "claimAdoptedChildForTest",
    "prepareInheritedLockFdForTest",
    "reapClaimedChildForTest",
  ];
  if (
    addonIdentityKeys.some((key) => before[key] !== after[key]) ||
    readFileSync("/proc/self/fdinfo/5", "utf8") !== beforeFdinfo ||
    heldTestAddon === null ||
    typeof heldTestAddon !== "object" ||
    JSON.stringify(Object.keys(heldTestAddon).sort()) !==
      JSON.stringify(
        [
          "interfaceVersion",
          "napiVersion",
          "renameNoReplace",
          "testHooks",
        ].sort(),
      ) ||
    heldTestAddon.interfaceVersion !== "1.0.0" ||
    heldTestAddon.napiVersion !== 8 ||
    typeof heldTestAddon.renameNoReplace !== "function" ||
    heldTestAddon.testHooks === null ||
    typeof heldTestAddon.testHooks !== "object" ||
    !Object.isFrozen(heldTestAddon.testHooks) ||
    JSON.stringify(Object.keys(heldTestAddon.testHooks).sort()) !==
      JSON.stringify(hookKeys.sort()) ||
    hookKeys.some(
      (key) => typeof heldTestAddon.testHooks[key] !== "function",
    )
  ) {
    fail("held test addon load changed identity or exposed invalid ABI");
  }
  return heldTestAddon;
}

function statFields(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const tail = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return {
    parent: Number(tail[1]),
    starttime: tail[19],
  };
}

const docker = "/usr/bin/docker";
const wrongUidImage = "node:22-slim";

function wrongUidFail(message) {
  throw new Error(`atomic wrong-uid prepare fixture: ${message}`);
}

function pathIsWithin(path, root) {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith("..") && !suffix.startsWith("/"));
}

function runtimeDependencies(path) {
  const result = spawnSync("ldd", [path], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" },
    encoding: "utf8",
    timeout: 10_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    result.error !== undefined ||
    result.signal !== null ||
    output.includes("not found") ||
    (result.status !== 0 &&
      !/statically linked|not a dynamic executable/.test(output))
  ) {
    wrongUidFail(`host runtime dependency resolution failed for ${path}`);
  }
  if (result.status !== 0) return [];
  const dependencies = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(?:\S+\s+=>\s+)?(\/\S+)\s+\(/);
    if (match === null) continue;
    const dependency = resolve(match[1]);
    if (!existsSync(dependency) || !statSync(dependency).isFile()) {
      wrongUidFail(`host runtime dependency is invalid: ${dependency}`);
    }
    dependencies.push(dependency);
  }
  return dependencies;
}

function hostRuntimeMounts(nativePath) {
  const native = realpathSync(nativePath);
  const requiredPaths = Object.freeze([
    node,
    ...runtimeDependencies(node),
    ...runtimeDependencies(native),
  ]);
  const candidates = [];
  for (const path of requiredPaths) {
    const destination = dirname(path);
    if (!existsSync(destination)) {
      wrongUidFail(`host runtime root is absent: ${destination}`);
    }
    const source = realpathSync(destination);
    if (!statSync(source).isDirectory()) {
      wrongUidFail(`host runtime root is invalid: ${source}`);
    }
    if (
      !candidates.some(
        (candidate) =>
          candidate.source === source &&
          candidate.destination === destination,
      )
    ) {
      candidates.push({ source, destination });
    }
  }
  candidates.sort(
    (left, right) =>
      left.destination.length - right.destination.length ||
      left.destination.localeCompare(right.destination),
  );
  const mounts = candidates.filter(
    (candidate, index, all) =>
      !all.slice(0, index).some((parent) => {
        if (!pathIsWithin(candidate.destination, parent.destination)) {
          return false;
        }
        const suffix = relative(
          parent.destination,
          candidate.destination,
        );
        return resolve(parent.source, suffix) === candidate.source;
      }),
  );
  if (
    mounts.length === 0 ||
    requiredPaths.some(
      (path) => !mounts.some((mount) => pathIsWithin(path, mount.destination)),
    ) ||
    mounts.some(
      (mount, index) =>
        !requiredPaths.some(
          (path) =>
            pathIsWithin(path, mount.destination) &&
            !mounts.some(
              (other, otherIndex) =>
                otherIndex !== index &&
                pathIsWithin(path, other.destination),
            ),
        ),
    )
  ) {
    wrongUidFail("minimal host runtime mount set is invalid");
  }
  return Object.freeze(mounts.map((mount) => Object.freeze(mount)));
}

function wrongUidEnvironment(parentPid, parentStarttime) {
  return Object.assign(Object.create(null), {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    ATOMIC_BUILD_LOCK_FD: "9",
    ATOMIC_BUILD_LOCK_FIXTURE_ROLE: "driver",
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID: String(parentPid),
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME: parentStarttime,
  });
}

function assertWrongUidDescriptorIdentities(lock) {
  const lockPath = realpathSync("/proc/self/fd/9");
  const ready = fstatSync(3);
  const release = fstatSync(4);
  const addon = fstatSync(5);
  const control = fstatSync(6);
  const parent = lstatSync(dirname(lockPath));
  const controlFlags = Number.parseInt(
    readFileSync("/proc/self/fdinfo/6", "utf8").match(
      /^flags:\s+([0-7]+)$/m,
    )?.[1] ?? "0",
    8,
  );
  const controlBytes = Buffer.alloc(64);
  const controlLength = readSync(
    6,
    controlBytes,
    0,
    controlBytes.length,
    0,
  );
  const checks = {
    lockPath: lockPath.endsWith(
      "/.atomic-directory-publication-build.lock",
    ),
    readyType: ready.isFIFO(),
    releaseType: release.isFIFO(),
    distinct: ready.dev !== release.dev || ready.ino !== release.ino,
    readyUid: ready.uid === process.getuid(),
    releaseUid: release.uid === process.getuid(),
    readyMode: (ready.mode & 0o7777) === 0o600,
    releaseMode: (release.mode & 0o7777) === 0o600,
    readyUnlinked: ready.nlink === 0,
    releaseUnlinked: release.nlink === 0,
    addonType: addon.isFile(),
    controlType: control.isFile(),
    controlUid: control.uid === process.getuid(),
    controlMode: (control.mode & 0o7777) === 0o600,
    controlUnlinked: control.nlink === 0,
    controlCloexec: (controlFlags & 0o2000000) !== 0,
    controlText:
      controlBytes.subarray(0, controlLength).toString("ascii") ===
      "atomic-orphan-fixture-control-v1:00\n",
    parentType: parent.isDirectory(),
    parentUid: parent.uid === process.getuid(),
    parentMode: (parent.mode & 0o7777) === 0o700,
    lockType: lock.isFile(),
    lockMode: (lock.mode & 0o7777) === 0o600,
    lockLinked: lock.nlink === 1,
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length > 0) {
    wrongUidFail(`non-UID descriptor identity is invalid: ${failed.join(",")}`);
  }
}

function runWrongUidChildProbe() {
  const lock = fstatSync(9);
  assertWrongUidDescriptorIdentities(lock);
  const evidence = Object.freeze({
    role: "orphan_lock_driver_v1",
    nodeExecutableRealpath: node,
    nodeExecutableSha256: hash(node),
    scriptRealpath: script,
    scriptSha256: hash(script),
    expectedParentPid: process.ppid,
    expectedParentStarttime: statFields(process.ppid).starttime,
    fd9Device: String(lock.dev),
    fd9Inode: String(lock.ino),
    fd9Uid: lock.uid,
    fd9Mode: lock.mode & 0o7777,
    fd9Nlink: lock.nlink,
  });
  const beforeFlags = readFileSync("/proc/self/fdinfo/9", "utf8");
  let rejection;
  try {
    loadHeldTestAddon().testHooks.prepareInheritedLockFdForTest(evidence);
  } catch (error) {
    rejection = error;
  }
  const after = fstatSync(9);
  if (
    lock.uid !== 1 ||
    process.getuid() !== 0 ||
    rejection === undefined ||
    !String(rejection.message).includes("evidence is invalid") ||
    after.dev !== lock.dev ||
    after.ino !== lock.ino ||
    after.uid !== lock.uid ||
    after.mode !== lock.mode ||
    after.nlink !== lock.nlink ||
    readFileSync("/proc/self/fdinfo/9", "utf8") !== beforeFlags
  ) {
    wrongUidFail(
      `prepare result or descriptor mutation is invalid: ${JSON.stringify({
        lockUid: lock.uid,
        processUid: process.getuid(),
        rejection: rejection?.message,
        before: {
          dev: String(lock.dev),
          ino: String(lock.ino),
          uid: lock.uid,
          mode: lock.mode,
          nlink: lock.nlink,
          flags: beforeFlags,
        },
        after: {
          dev: String(after.dev),
          ino: String(after.ino),
          uid: after.uid,
          mode: after.mode,
          nlink: after.nlink,
          flags: readFileSync("/proc/self/fdinfo/9", "utf8"),
        },
      })}`,
    );
  }
  writeSync(
    1,
    `${JSON.stringify({
      status: "wrong_uid_rejected",
      processUid: process.getuid(),
      lockUid: lock.uid,
      evidenceUid: evidence.fd9Uid,
    })}\n`,
  );
}

function runWrongUidContainerCase(lockUid) {
  const root = mkdtempSync(join(tmpdir(), "atomic-wrong-uid-"));
  chmodSync(root, 0o700);
  const readyPath = join(root, "ready");
  const releasePath = join(root, "release");
  const lockPath = join(root, ".atomic-directory-publication-build.lock");
  const controlPath = join(root, "control");
  const addonPath =
    "/run/atomic-addon/atomic_directory_publication_test.node";
  const made = spawnSync(
    "/usr/bin/mkfifo",
    ["--mode=0600", "--", readyPath, releasePath],
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" } },
  );
  if (made.error || made.status !== 0) wrongUidFail("FIFO creation failed");
  const ready = openSync(readyPath, constants.O_RDWR | constants.O_NOFOLLOW);
  const release = openSync(
    releasePath,
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  unlinkSync(readyPath);
  unlinkSync(releasePath);
  writeFileSync(
    addonPath,
    readFileSync("/fixture/atomic_directory_publication_test.node"),
    { flag: "wx", mode: 0o600 },
  );
  const addon = openSync(addonPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const addonIdentity = fstatSync(addon);
  writeFileSync(controlPath, "atomic-orphan-fixture-control-v1:00\n", {
    flag: "wx",
    mode: 0o600,
  });
  const control = openSync(
    controlPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  unlinkSync(controlPath);
  const lock = openSync(
    lockPath,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(lock, 0o600);
  fchownSync(lock, lockUid, 0);
  try {
    const child = spawnSync(process.execPath, [script], {
      env: wrongUidEnvironment(
        process.pid,
        statFields(process.pid).starttime,
      ),
      encoding: "utf8",
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        ready,
        release,
        addon,
        control,
        "ignore",
        "ignore",
        lock,
      ],
    });
    if (child.error || child.status !== 0 || child.signal !== null) {
      wrongUidFail(`child probe failed: ${child.stderr.trim()}`);
    }
    return JSON.parse(child.stdout);
  } finally {
    closeSync(lock);
    closeSync(control);
    closeSync(addon);
    const addonAfter = lstatSync(addonPath);
    if (
      addonAfter.dev !== addonIdentity.dev ||
      addonAfter.ino !== addonIdentity.ino ||
      !addonAfter.isFile() ||
      addonAfter.uid !== process.getuid() ||
      (addonAfter.mode & 0o7777) !== 0o600 ||
      addonAfter.nlink !== 1
    ) {
      wrongUidFail("private addon cleanup identity changed");
    }
    unlinkSync(addonPath);
    closeSync(release);
    closeSync(ready);
    rmSync(root, { recursive: true, force: true });
  }
}

function runWrongUidContainerFixture() {
  const wrongUid = runWrongUidContainerCase(1);
  if (
    wrongUid.status !== "wrong_uid_rejected" ||
    wrongUid.processUid !== 0 ||
    wrongUid.lockUid !== 1 ||
    wrongUid.evidenceUid !== 1
  ) {
    wrongUidFail("container proof is invalid");
  }
  writeSync(1, `${JSON.stringify({ wrongUid })}\n`);
}

function runWrongUidPrepareProbeForTest() {
  const native = realpathSync(
    resolve(
      dirname(script),
      "../build/Test/atomic_directory_publication_test.node",
    ),
  );
  const imageStatus = spawnSync(
    docker,
    ["image", "inspect", wrongUidImage],
    {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (
    imageStatus.error !== undefined ||
    imageStatus.status !== 0 ||
    imageStatus.signal !== null
  ) {
    wrongUidFail("cached Docker node:22-slim image is unavailable");
  }
  if (!lstatSync(node).isFile() || !lstatSync(native).isFile()) {
    wrongUidFail("canonical host runtime input is invalid");
  }
  const runtimeMountArguments = hostRuntimeMounts(native).flatMap((mount) => [
    "--mount",
    `type=bind,src=${mount.source},dst=${mount.destination},readonly`,
  ]);
  const fixtureLeaf = script.split("/").at(-1);
  const result = spawnSync(
    docker,
    [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--pids-limit=32",
      "--cap-drop=ALL",
      "--cap-add=CHOWN",
      "--cap-add=DAC_OVERRIDE",
      "--security-opt=no-new-privileges",
      "--user=0:0",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,mode=0700,uid=0,gid=0",
      "--tmpfs=/run/atomic-addon:rw,exec,nosuid,nodev,mode=0700,uid=0,gid=0",
      "--mount",
      `type=bind,src=${script},dst=/fixture/${fixtureLeaf},readonly`,
      "--mount",
      `type=bind,src=${native},dst=/fixture/atomic_directory_publication_test.node,readonly`,
      ...runtimeMountArguments,
      `--entrypoint=${node}`,
      wrongUidImage,
      `/fixture/${fixtureLeaf}`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.error || result.status !== 0 || result.signal !== null) {
    wrongUidFail(`Docker probe failed: ${result.stderr.trim()}`);
  }
  const proof = JSON.parse(result.stdout);
  if (proof.wrongUid?.status !== "wrong_uid_rejected") {
    wrongUidFail("Docker probe proof is invalid");
  }
  return Object.freeze(proof);
}

function validateEnvironment(role) {
  const expected = {
    ...expectedBase,
    ATOMIC_BUILD_LOCK_FIXTURE_ROLE: role,
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID: String(process.ppid),
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME:
      statFields(process.ppid).starttime,
    ...(role === "descendant"
      ? {
          ATOMIC_BUILD_LOCK_FIXTURE_DRIVER_PID: String(process.ppid),
        }
      : {}),
  };
  if (
    JSON.stringify(Object.keys(process.env).sort()) !==
      JSON.stringify(Object.keys(expected).sort()) ||
    Object.entries(expected).some(([key, value]) => process.env[key] !== value)
  ) {
    fail("environment is not exact");
  }
  if (
    process.env.ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID !==
      String(process.ppid) ||
    process.env.ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME !==
      statFields(process.ppid).starttime
  ) {
    fail("expected parent evidence is invalid");
  }
  const lock = fstatSync(9);
  const ready = fstatSync(3);
  const release = fstatSync(4);
  const addon = fstatSync(5);
  if (
    !lock.isFile() ||
    (lock.mode & 0o7777) !== 0o600 ||
    !ready.isFIFO() ||
    !release.isFIFO() ||
    !addon.isFile() ||
    addon.uid !== process.getuid() ||
    (addon.mode & 0o7777) !== 0o600 ||
    addon.nlink !== 1 ||
    (ready.dev === release.dev && ready.ino === release.ino)
  ) {
    fail("inherited descriptor identities are invalid");
  }
}

function fd9Flags() {
  const match = readFileSync(`/proc/${process.pid}/fdinfo/9`, "utf8").match(
    /^flags:\s+([0-7]+)$/m,
  );
  if (match === null) fail("fd9 flags are unavailable");
  return Number.parseInt(match[1], 8);
}

function readFixtureControl() {
  const status = fstatSync(6);
  const bytes = Buffer.alloc(64);
  const count = readSync(6, bytes, 0, bytes.length, 0);
  const text = bytes.subarray(0, count).toString("ascii");
  const match = text.match(
    /^atomic-orphan-fixture-control-v1:([0-9]{2})\n$/,
  );
  const variant = match === null ? -1 : Number(match[1]);
  if (
    !status.isFile() ||
    status.uid !== process.getuid() ||
    (status.mode & 0o7777) !== 0o600 ||
    status.nlink !== 0 ||
    match === null ||
    variant < 0 ||
    variant > 34 ||
    text !== `${fixtureControlPrefix}${String(variant).padStart(2, "0")}\n`
  ) {
    fail("inherited fixture control is invalid");
  }
  return Object.freeze({ variant });
}

function readBoundaryControl() {
  const status = fstatSync(7);
  const flags = Number.parseInt(
    readFileSync(`/proc/${process.pid}/fdinfo/7`, "utf8").match(
      /^flags:\s+([0-7]+)$/m,
    )?.[1] ?? "0",
    8,
  );
  const bytes = Buffer.alloc(96);
  const count = readSync(7, bytes, 0, bytes.length, 0);
  const text = bytes.subarray(0, count).toString("ascii");
  const prefix = text.startsWith(boundaryControlPrefix);
  const schedule =
    prefix && text.endsWith("\n")
      ? text.slice(boundaryControlPrefix.length, -1)
      : "";
  if (
    !status.isFile() ||
    status.uid !== process.getuid() ||
    (status.mode & 0o7777) !== 0o600 ||
    status.nlink !== 0 ||
    (flags & 0o2000000) === 0 ||
    (flags & 0o3) !== constants.O_RDONLY ||
    !prefix ||
    !boundarySchedules.has(schedule) ||
    text !== `${boundaryControlPrefix}${schedule}\n`
  ) {
    fail("inherited boundary control is invalid");
  }
  return schedule;
}

function prepareInheritedLock(native, role) {
  const lock = fstatSync(9);
  const evidence = Object.freeze({
    role:
      role === "driver"
        ? "orphan_lock_driver_v1"
        : "orphan_lock_descendant_v1",
    nodeExecutableRealpath: node,
    nodeExecutableSha256: hash(node),
    scriptRealpath: script,
    scriptSha256: hash(script),
    expectedParentPid: process.ppid,
    expectedParentStarttime: statFields(process.ppid).starttime,
    fd9Device: String(lock.dev),
    fd9Inode: String(lock.ino),
    fd9Uid: lock.uid,
    fd9Mode: lock.mode & 0o7777,
    fd9Nlink: lock.nlink,
  });
  const hiddenExtra = { ...evidence };
  Object.defineProperty(hiddenExtra, "hidden", {
    value: 1,
    enumerable: false,
  });
  const symbolExtra = { ...evidence, [Symbol("extra")]: 1 };
  const invalidCases = [
    [],
    [evidence, evidence],
    [null],
    [{}],
    [{ ...evidence, extra: 1 }],
    [hiddenExtra],
    [symbolExtra],
    [{ ...evidence, role: `${evidence.role}\0suffix` }],
    [{ ...evidence, role: "driver" }],
    [{ ...evidence, nodeExecutableRealpath: script }],
    [{ ...evidence, nodeExecutableSha256: "0".repeat(64) }],
    [{ ...evidence, scriptRealpath: node }],
    [{ ...evidence, scriptSha256: "0".repeat(64) }],
    [{ ...evidence, expectedParentPid: process.pid }],
    [{ ...evidence, expectedParentPid: String(process.ppid) }],
    [{ ...evidence, expectedParentPid: 2 ** 32 + process.ppid }],
    [{ ...evidence, expectedParentPid: Number.NaN }],
    [{ ...evidence, expectedParentPid: Number.POSITIVE_INFINITY }],
    [{ ...evidence, expectedParentPid: process.ppid + 0.5 }],
    [{ ...evidence, expectedParentPid: Number.MAX_SAFE_INTEGER }],
    [{ ...evidence, expectedParentStarttime: "0" }],
    [{ ...evidence, fd9Device: "0" }],
    [{ ...evidence, fd9Inode: "0" }],
    [{ ...evidence, fd9Uid: lock.uid + 1 }],
    [{ ...evidence, fd9Uid: 2 ** 32 + lock.uid }],
    [{ ...evidence, fd9Uid: -1 }],
    [{ ...evidence, fd9Uid: 0.5 }],
    [{ ...evidence, fd9Uid: Number.NaN }],
    [{ ...evidence, fd9Uid: Number.POSITIVE_INFINITY }],
    [{ ...evidence, fd9Mode: 0o640 }],
    [{ ...evidence, fd9Nlink: 2 }],
  ];
  const beforeFlags = fd9Flags();
  const rejectWithoutMutation = (args) => {
    let rejected = false;
    try {
      native.testHooks.prepareInheritedLockFdForTest(...args);
    } catch {
      rejected = true;
    }
    const unchanged = fstatSync(9);
    if (
      !rejected ||
      unchanged.dev !== lock.dev ||
      unchanged.ino !== lock.ino ||
      fd9Flags() !== beforeFlags
    ) {
      fail("invalid inherited lock preparation was not side-effect free");
    }
  };
  for (const args of invalidCases) {
    rejectWithoutMutation(args);
    const unchanged = fstatSync(9);
    if (
      unchanged.mode !== lock.mode ||
      unchanged.nlink !== lock.nlink
    ) {
      fail("invalid inherited lock preparation was not side-effect free");
    }
  }
  const lockPath = readlinkSync("/proc/self/fd/9");
  const parentPath = dirname(lockPath);
  const hardlinkPath = `${lockPath}.negative-link-${process.pid}`;
  const backupPath = `${lockPath}.negative-backup-${process.pid}`;
  let actualNegativeCases = 0;
  fchmodSync(9, 0o640);
  try {
    rejectWithoutMutation([evidence]);
    actualNegativeCases++;
  } finally {
    fchmodSync(9, 0o600);
  }
  linkSync(lockPath, hardlinkPath);
  try {
    rejectWithoutMutation([evidence]);
    actualNegativeCases++;
  } finally {
    unlinkSync(hardlinkPath);
  }
  chmodSync(parentPath, 0o755);
  try {
    rejectWithoutMutation([evidence]);
    actualNegativeCases++;
  } finally {
    chmodSync(parentPath, 0o700);
  }
  renameSync(lockPath, backupPath);
  try {
    writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });
    try {
      rejectWithoutMutation([evidence]);
      actualNegativeCases++;
    } finally {
      unlinkSync(lockPath);
    }
  } finally {
    renameSync(backupPath, lockPath);
  }
  native.testHooks.prepareInheritedLockFdForTest(evidence);
  const after = fstatSync(9);
  if (
    after.dev !== lock.dev ||
    after.ino !== lock.ino ||
    after.uid !== lock.uid ||
    after.mode !== lock.mode ||
    after.nlink !== lock.nlink ||
    (fd9Flags() & 0o2000000) !== 0
  ) {
    fail("native fd9 preparation post-check failed");
  }
  return Object.freeze({
    evidence,
    negativeCases: invalidCases.length + actualNegativeCases,
  });
}

function rejectPrepareAfterProgression(native, prepared, boundary) {
  const lock = fstatSync(9);
  const flags = fd9Flags();
  let duplicateRejected = false;
  try {
    native.testHooks.prepareInheritedLockFdForTest(prepared.evidence);
  } catch {
    duplicateRejected = true;
  }
  const duplicateStatus = fstatSync(9);
  if (
    !duplicateRejected ||
    duplicateStatus.dev !== lock.dev ||
    duplicateStatus.ino !== lock.ino ||
    duplicateStatus.mode !== lock.mode ||
    duplicateStatus.nlink !== lock.nlink ||
    fd9Flags() !== flags
  ) {
    fail(`${boundary} duplicate preparation was not side-effect free`);
  }
}

function childStdio() {
  return [
    "ignore",
    "inherit",
    "inherit",
    3,
    4,
    5,
    6,
    7,
    5,
    9,
  ];
}

const probeControls = new Map([
  ["/dev/null", "fd9-absent"],
  ["/dev/zero", "fd9-nonregular"],
  ["/dev/full", "cmdline-drift"],
  ["/dev/random", "environment-drift"],
  ["/proc/version", "driver-no-call-after-spawn"],
  ["/proc/cpuinfo", "descendant-no-call-after-ready"],
]);

function prepareProbeEvidence(role) {
  let lock;
  try {
    lock = fstatSync(9);
  } catch (error) {
    if (error?.code !== "EBADF") throw error;
  }
  return Object.freeze({
    role,
    nodeExecutableRealpath: node,
    nodeExecutableSha256: hash(node),
    scriptRealpath: script,
    scriptSha256: hash(script),
    expectedParentPid: process.ppid,
    expectedParentStarttime: statFields(process.ppid).starttime,
    fd9Device: String(lock?.dev ?? 1),
    fd9Inode: String(lock?.ino ?? 1),
    fd9Uid: process.getuid(),
    fd9Mode: 0o600,
    fd9Nlink: 1,
  });
}

function runPrepareProbe(native, probe, role = "orphan_lock_driver_v1") {
  let rejected = false;
  try {
    native.testHooks.prepareInheritedLockFdForTest(
      prepareProbeEvidence(role),
    );
  } catch {
    rejected = true;
  }
  if (!rejected) {
    fail(`${probe} inherited lock preparation unexpectedly succeeded`);
  }
}

async function spawnPrepareProbe(
  probe,
  controlPath,
  fd9,
  role = "driver",
  boundaryFds,
) {
  const parent = statFields(process.pid);
  const environment = Object.assign(Object.create(null), expectedBase, {
    ATOMIC_BUILD_LOCK_FIXTURE_ROLE: role,
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID: String(process.pid),
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME: parent.starttime,
    ...(role === "descendant"
      ? { ATOMIC_BUILD_LOCK_FIXTURE_DRIVER_PID: String(process.pid) }
      : {}),
    ...(probe === "environment-drift"
      ? { ATOMIC_BUILD_LOCK_FIXTURE_DRIFT: "1" }
      : {}),
  });
  const control = openSync(
    controlPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const stdio = [
    "ignore",
    "inherit",
    "inherit",
    boundaryFds?.readyWrite ?? "ignore",
    boundaryFds?.releaseRead ?? "ignore",
    5,
    6,
    "ignore",
    control,
  ];
  if (fd9 !== undefined) {
    stdio.push(fd9);
  }
  let child;
  try {
    child = spawn(
      node,
      probe === "cmdline-drift" ? [script, "drift"] : [script],
      { env: environment, stdio },
    );
  } finally {
    closeSync(control);
    boundaryFds?.closeChildEnds();
    if (fd9 !== undefined && fd9 !== 9) {
      closeSync(fd9);
    }
  }
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(
          new Error(
            `atomic prepare probe ${probe} exited with ${code}/${signal}`,
          ),
        );
      }
    });
  });
}

function createPrepareProbeBoundaries() {
  const root = mkdtempSync(join(tmpdir(), "atomic-prepare-boundary-"));
  const readyPath = join(root, "ready");
  const releasePath = join(root, "release");
  const made = spawnSync(
    "/usr/bin/mkfifo",
    ["--mode=0600", "--", readyPath, releasePath],
    {
      env: Object.assign(Object.create(null), {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        LANG: "C",
        TZ: "UTC",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (made.error !== undefined || made.status !== 0) {
    fail("prepare boundary FIFO creation failed");
  }
  const readyAnchor = openSync(
    readyPath,
    constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  const releaseAnchor = openSync(
    releasePath,
    constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  const readyRead = openSync(
    readyPath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  const readyWrite = openSync(
    readyPath,
    constants.O_WRONLY | constants.O_NOFOLLOW,
  );
  const releaseRead = openSync(
    releasePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  unlinkSync(readyPath);
  unlinkSync(releasePath);
  rmdirSync(root);
  closeSync(readyAnchor);
  closeSync(releaseAnchor);
  let childEndsClosed = false;
  return Object.freeze({
    readyWrite,
    releaseRead,
    closeChildEnds() {
      if (childEndsClosed) return;
      childEndsClosed = true;
      closeSync(readyWrite);
      closeSync(releaseRead);
    },
    closeParentEnd() {
      closeSync(readyRead);
    },
  });
}

async function runIsolatedPrepareProbes() {
  const probes = [
    ["fd9-absent", "/dev/null", undefined],
    [
      "fd9-nonregular",
      "/dev/zero",
      openSync("/dev/null", constants.O_RDONLY | constants.O_NOFOLLOW),
    ],
    ["cmdline-drift", "/dev/full", 9],
    ["environment-drift", "/dev/random", 9],
  ];
  for (const [probe, control, fd9] of probes) {
    await spawnPrepareProbe(probe, control, fd9);
  }
  for (const [probe, control, role] of [
    ["driver-no-call-after-spawn", "/proc/version", "driver"],
    ["descendant-no-call-after-ready", "/proc/cpuinfo", "descendant"],
  ]) {
    const boundaryFds = createPrepareProbeBoundaries();
    try {
      await spawnPrepareProbe(probe, control, 9, role, boundaryFds);
    } finally {
      boundaryFds.closeChildEnds();
      boundaryFds.closeParentEnd();
    }
  }
  runWrongUidPrepareProbeForTest();
  return Object.freeze({
    isolatedPrepareCases: probes.length + 3,
    wrongUidProbeSkipped: false,
  });
}

if (
  process.env.ATOMIC_BUILD_LOCK_FIXTURE_ROLE === undefined &&
  script.startsWith("/fixture/")
) {
  runWrongUidContainerFixture();
  process.exit(0);
}
if (
  process.env.ATOMIC_BUILD_LOCK_FIXTURE_ROLE === "driver" &&
  process.getuid() === 0 &&
  fstatSync(9).isFile() &&
  fstatSync(9).uid === 1
) {
  runWrongUidChildProbe();
  process.exit(0);
}

let controlTarget;
try {
  controlTarget = realpathSync("/proc/self/fd/8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const probe = probeControls.get(controlTarget);
if (probe !== undefined) {
  if (probe === "fd9-absent") {
    closeSync(9);
  }
  const native = loadHeldTestAddon();
  if (probe === "driver-no-call-after-spawn") {
    const progressed = spawn(node, ["-e", ""], {
      env: Object.assign(Object.create(null), expectedBase),
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      progressed.once("error", reject);
      progressed.once("exit", (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error("no-call driver progression child failed"));
      });
    });
    closeSync(3);
    closeSync(4);
    runPrepareProbe(native, probe);
  } else if (probe === "descendant-no-call-after-ready") {
    const ready = Buffer.from("atomic-no-call-ready-v1\n");
    if (writeSync(3, ready) !== ready.length) {
      fail("no-call descendant ready write was short");
    }
    closeSync(3);
    runPrepareProbe(native, probe, "orphan_lock_descendant_v1");
  } else {
    runPrepareProbe(native, probe);
  }
  process.exit(0);
}

const role = process.env.ATOMIC_BUILD_LOCK_FIXTURE_ROLE;
if (
  process.argv.length !== 2 ||
  !["driver", "descendant"].includes(role) ||
  realpathSync(process.argv[1]) !== script
) {
  fail("argv, script, or role is invalid");
}
validateEnvironment(role);
const fixtureControl = readFixtureControl();
const boundarySchedule = readBoundaryControl();
const flagsBeforeModuleLoad = fd9Flags();
const native = loadHeldTestAddon();
if (fd9Flags() !== flagsBeforeModuleLoad) {
  fail("test addon module load mutated fd9");
}
const preparedLock = prepareInheritedLock(native, role);

if (role === "driver") {
  const driver = statFields(process.pid);
  const environment = Object.assign(Object.create(null), expectedBase, {
    ATOMIC_BUILD_LOCK_FIXTURE_ROLE: "descendant",
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID: String(process.pid),
    ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME: driver.starttime,
    ATOMIC_BUILD_LOCK_FIXTURE_DRIVER_PID: String(process.pid),
  });
  const child = spawn(node, [script], {
    env: environment,
    stdio: childStdio(),
  });
  closeSync(3);
  closeSync(4);
  rejectPrepareAfterProgression(native, preparedLock, "post-spawn");
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (code !== 0 || signal !== null) {
      process.exitCode = 1;
    }
  });
} else {
  if (
    statFields(process.pid).parent !==
    Number(process.env.ATOMIC_BUILD_LOCK_FIXTURE_DRIVER_PID)
  ) {
    fail("driver relationship is invalid");
  }
  const lock = fstatSync(9);
  const isolatedPrepareEvidence =
    fixtureControl.variant === 0 && boundarySchedule === "none"
      ? await runIsolatedPrepareProbes()
      : Object.freeze({
          isolatedPrepareCases: 0,
          wrongUidProbeSkipped: false,
        });
  const flagsText = readFileSync(`/proc/${process.pid}/fdinfo/9`, "utf8");
  const flags = Number.parseInt(flagsText.match(/^flags:\s+([0-7]+)$/m)[1], 8);
  const record = {
    event: "orphan-ready-v1",
    role: "orphan_lock_descendant_v1",
    driverPid: process.ppid,
    driverStarttime: statFields(process.ppid).starttime,
    pid: process.pid,
    starttime: statFields(process.pid).starttime,
    nodeExecutableRealpath: node,
    nodeExecutableSha256: hash(node),
    scriptRealpath: script,
    scriptSha256: hash(script),
    fd9Device: String(lock.dev),
    fd9Inode: String(lock.ino),
    fd9Uid: lock.uid,
    fd9Mode: lock.mode & 0o7777,
    fd9Nlink: lock.nlink,
    fd9Cloexec: (flags & 0o2000000) !== 0,
    fixtureControlVariant: fixtureControl.variant,
    prepareNegativeCases: preparedLock.negativeCases + 1,
    isolatedPrepareCases: isolatedPrepareEvidence.isolatedPrepareCases,
    wrongUidProbeSkipped: isolatedPrepareEvidence.wrongUidProbeSkipped,
  };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (writeSync(3, bytes) !== bytes.length) {
    fail("ready record write was short");
  }
  closeSync(3);
  rejectPrepareAfterProgression(native, preparedLock, "post-ready");
  if (boundarySchedule === "release-write-result") {
    closeSync(4);
    setInterval(() => {}, 1000);
  } else {
    const release = Buffer.alloc(1);
    const count = readSync(4, release, 0, 1, null);
    if (count !== 1 || release[0] !== 0x01) {
      fail("release byte is invalid");
    }
    closeSync(4);
  }
  if (boundarySchedule === "release-write-result") {
    // The native owner terminates this child after the real FIFO EPIPE.
  } else if ([14, 15].includes(fixtureControl.variant)) {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else if (
    (fixtureControl.variant >= 1 && fixtureControl.variant <= 11) ||
    fixtureControl.variant === 13 ||
    (fixtureControl.variant >= 16 && fixtureControl.variant <= 34)
  ) {
    setInterval(() => {}, 1000);
  } else if ([0, 12].includes(fixtureControl.variant)) {
    closeSync(5);
    closeSync(6);
    closeSync(9);
  } else {
    fail("fixture control variant has no child lifecycle");
  }
}
