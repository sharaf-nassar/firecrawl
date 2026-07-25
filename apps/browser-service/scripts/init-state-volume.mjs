import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VOLUME_ROOT = "/var/lib/firecrawl-browser-volume";
const MARKER_LEAF = ".firecrawl-browser-initialized-v1";
const MARKER_BYTES = Buffer.from("firecrawl-browser-volume-v1\n");
const STATE_LEAF = "state";
const STAGING_LEAF = ".profile-publish-staging";
const ROOT_LEAVES = Object.freeze([MARKER_LEAF, STATE_LEAF].sort());
const REQUIRED_STATE_LEAVES = Object.freeze([STAGING_LEAF, "profiles"].sort());
const OPTIONAL_STATE_LEAVES = Object.freeze(["quarantine", "replay"].sort());
const STAGING_LEAVES = Object.freeze(["bundles", "intents"].sort());
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const PRODUCTION_POLICY = Object.freeze({
  parentUid: 0,
  parentGid: 1000,
  childUid: 1000,
  childGid: 1000,
  markerUid: 0,
  markerGid: 0,
});

function fail(message) {
  const error = new Error(`browser volume initialization failed: ${message}`);
  error.category = "browser_volume_initialization_failed";
  throw error;
}

function procPath(fd, leaf = "") {
  return leaf === "" ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${leaf}`;
}

function mode(status) {
  return status.mode & 0o7777n;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isDirectory() === right.isDirectory() &&
    left.isFile() === right.isFile()
  );
}

function sameSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertPolicy(policy) {
  const keys = [
    "parentUid",
    "parentGid",
    "childUid",
    "childGid",
    "markerUid",
    "markerGid",
  ];
  if (
    policy === null ||
    typeof policy !== "object" ||
    Object.keys(policy).sort().join(",") !== keys.sort().join(",") ||
    keys.some(
      key =>
        !Number.isSafeInteger(policy[key]) ||
        policy[key] < 0 ||
        policy[key] > 0xffff_ffff,
    )
  ) {
    fail("invalid ownership policy");
  }
}

function openHeldDirectory(parentFd, leaf) {
  const path = procPath(parentFd, leaf);
  const fd = openSync(path, DIRECTORY_FLAGS);
  const held = fstatSync(fd, { bigint: true });
  const named = lstatSync(path, { bigint: true });
  if (
    !held.isDirectory() ||
    held.isSymbolicLink() ||
    !named.isDirectory() ||
    named.isSymbolicLink() ||
    !sameIdentity(held, named)
  ) {
    closeSync(fd);
    fail(`${leaf} directory identity`);
  }
  return { fd, held };
}

function assertDirectoryMetadata(status, uid, gid, expectedMode, label) {
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== BigInt(uid) ||
    status.gid !== BigInt(gid) ||
    mode(status) !== BigInt(expectedMode) ||
    status.nlink < 2n
  ) {
    fail(`${label} directory ownership or mode`);
  }
}

function createHeldDirectory(parentFd, leaf, relative, policy) {
  const path = procPath(parentFd, leaf);
  mkdirSync(path, { recursive: false, mode: 0o700 });
  const child = openHeldDirectory(parentFd, leaf);
  try {
    fchownSync(child.fd, policy.childUid, policy.childGid);
    fchmodSync(child.fd, 0o700);
    fsyncSync(child.fd);
    const finalStatus = fstatSync(child.fd, { bigint: true });
    const namedStatus = lstatSync(path, { bigint: true });
    assertDirectoryMetadata(
      finalStatus,
      policy.childUid,
      policy.childGid,
      0o700,
      relative,
    );
    if (!sameIdentity(finalStatus, namedStatus)) {
      fail(`${relative} directory identity changed`);
    }
    return child.fd;
  } catch (error) {
    closeSync(child.fd);
    throw error;
  }
}

function initializeNew(parentFd, policy) {
  const stateFd = createHeldDirectory(
    parentFd,
    STATE_LEAF,
    STATE_LEAF,
    policy,
  );
  try {
    const profilesFd = createHeldDirectory(
      stateFd,
      "profiles",
      "state/profiles",
      policy,
    );
    closeSync(profilesFd);
    const stagingFd = createHeldDirectory(
      stateFd,
      STAGING_LEAF,
      `state/${STAGING_LEAF}`,
      policy,
    );
    try {
      for (const leaf of STAGING_LEAVES) {
        const childFd = createHeldDirectory(
          stagingFd,
          leaf,
          `state/${STAGING_LEAF}/${leaf}`,
          policy,
        );
        closeSync(childFd);
      }
      fsyncSync(stagingFd);
    } finally {
      closeSync(stagingFd);
    }
    fsyncSync(stateFd);
  } finally {
    closeSync(stateFd);
  }
  fsyncSync(parentFd);
  fchownSync(parentFd, policy.parentUid, policy.parentGid);
  fchmodSync(parentFd, 0o750);
  fsyncSync(parentFd);

  const markerPath = procPath(parentFd, MARKER_LEAF);
  const markerFd = openSync(
    markerPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < MARKER_BYTES.length) {
      const written = writeSync(
        markerFd,
        MARKER_BYTES,
        offset,
        MARKER_BYTES.length - offset,
        offset,
      );
      if (written <= 0) fail("marker write");
      offset += written;
    }
    fchownSync(markerFd, policy.markerUid, policy.markerGid);
    fchmodSync(markerFd, 0o600);
    fsyncSync(markerFd);
    const held = fstatSync(markerFd, { bigint: true });
    const named = lstatSync(markerPath, { bigint: true });
    if (
      !held.isFile() ||
      held.isSymbolicLink() ||
      held.uid !== BigInt(policy.markerUid) ||
      held.gid !== BigInt(policy.markerGid) ||
      mode(held) !== 0o600n ||
      held.nlink !== 1n ||
      held.size !== BigInt(MARKER_BYTES.length) ||
      !sameIdentity(held, named)
    ) {
      fail("marker identity or metadata");
    }
  } finally {
    closeSync(markerFd);
  }
  fsyncSync(parentFd);
}

function runTestHook(testHooks, name, details) {
  const hook = testHooks?.[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") fail(`invalid ${name} test hook`);
  hook(Object.freeze({ ...details }));
}

function assertExactLeaves(fd, expected, label) {
  const entries = readdirSync(procPath(fd)).sort();
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${label} layout is partial or unknown`);
  }
}

function managedStateLeaves(fd) {
  const entries = readdirSync(procPath(fd)).sort();
  const allowed = new Set([
    ...REQUIRED_STATE_LEAVES,
    ...OPTIONAL_STATE_LEAVES,
  ]);
  if (
    REQUIRED_STATE_LEAVES.some(leaf => !entries.includes(leaf)) ||
    entries.some(leaf => !allowed.has(leaf))
  ) {
    fail("state layout is partial or unknown");
  }
  return entries;
}

function validateHeldDirectory(
  parentFd,
  leaf,
  relative,
  policy,
  testHooks,
  expectedDevice,
  validateChildren,
) {
  const child = openHeldDirectory(parentFd, leaf);
  try {
    runTestHook(testHooks, "afterDirectoryOpen", {
      relative,
      parentFd,
      childFd: child.fd,
    });
    assertDirectoryMetadata(
      child.held,
      policy.childUid,
      policy.childGid,
      0o700,
      relative,
    );
    if (
      expectedDevice !== undefined &&
      child.held.dev !== expectedDevice
    ) {
      fail(`${relative} directory device`);
    }
    validateChildren?.(child.fd, child.held.dev);
    const after = fstatSync(child.fd, { bigint: true });
    const named = lstatSync(procPath(parentFd, leaf), { bigint: true });
    if (!sameSnapshot(child.held, after) || !sameIdentity(after, named)) {
      fail(`${relative} directory changed during validation`);
    }
  } finally {
    closeSync(child.fd);
  }
}

function validateExisting(parentFd, parentBefore, policy, root, testHooks) {
  assertDirectoryMetadata(
    parentBefore,
    policy.parentUid,
    policy.parentGid,
    0o750,
    "parent",
  );
  validateHeldDirectory(
    parentFd,
    STATE_LEAF,
    STATE_LEAF,
    policy,
    testHooks,
    undefined,
    (stateFd, stateDevice) => {
      const stateLeaves = managedStateLeaves(stateFd);
      validateHeldDirectory(
        stateFd,
        "profiles",
        "state/profiles",
        policy,
        testHooks,
        stateDevice,
      );
      validateHeldDirectory(
        stateFd,
        STAGING_LEAF,
        `state/${STAGING_LEAF}`,
        policy,
        testHooks,
        stateDevice,
        stagingFd => {
          assertExactLeaves(
            stagingFd,
            STAGING_LEAVES,
            `state/${STAGING_LEAF}`,
          );
          for (const leaf of STAGING_LEAVES) {
            validateHeldDirectory(
              stagingFd,
              leaf,
              `state/${STAGING_LEAF}/${leaf}`,
              policy,
              testHooks,
              stateDevice,
            );
          }
        },
      );
      for (const leaf of OPTIONAL_STATE_LEAVES) {
        if (!stateLeaves.includes(leaf)) continue;
        validateHeldDirectory(
          stateFd,
          leaf,
          `state/${leaf}`,
          policy,
          testHooks,
          stateDevice,
        );
      }
    },
  );

  const markerPath = procPath(parentFd, MARKER_LEAF);
  const markerFd = openSync(markerPath, FILE_FLAGS);
  try {
    const before = fstatSync(markerFd, { bigint: true });
    const named = lstatSync(markerPath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== BigInt(policy.markerUid) ||
      before.gid !== BigInt(policy.markerGid) ||
      mode(before) !== 0o600n ||
      before.nlink !== 1n ||
      before.size !== BigInt(MARKER_BYTES.length) ||
      !sameIdentity(before, named)
    ) {
      fail("marker identity or metadata");
    }
    const bytes = Buffer.alloc(MARKER_BYTES.length);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        markerFd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count <= 0) fail("marker read");
      offset += count;
    }
    if (!bytes.equals(MARKER_BYTES)) fail("marker content");
    const after = fstatSync(markerFd, { bigint: true });
    const namedAfter = lstatSync(markerPath, { bigint: true });
    if (!sameSnapshot(before, after) || !sameIdentity(after, namedAfter)) {
      fail("marker changed during validation");
    }
  } finally {
    closeSync(markerFd);
  }
  runTestHook(testHooks, "beforeFinalParentValidation", {
    root,
    parentFd,
  });
  const parentAfter = fstatSync(parentFd, { bigint: true });
  const parentNamedAfter = lstatSync(root, { bigint: true });
  if (
    !sameSnapshot(parentBefore, parentAfter) ||
    !parentNamedAfter.isDirectory() ||
    parentNamedAfter.isSymbolicLink() ||
    !sameIdentity(parentAfter, parentNamedAfter)
  ) {
    fail("parent changed during validation");
  }
}

function initializeStateVolume(root, policy, testHooks) {
  assertPolicy(policy);
  if (typeof root !== "string" || !root.startsWith("/") || resolve(root) !== root) {
    fail("volume root must be an absolute normalized path");
  }
  if (realpathSync(root) !== root) fail("volume root identity");
  const parentFd = openSync(root, DIRECTORY_FLAGS);
  try {
    const parentBefore = fstatSync(parentFd, { bigint: true });
    const parentNamed = lstatSync(root, { bigint: true });
    if (
      !parentBefore.isDirectory() ||
      parentBefore.isSymbolicLink() ||
      !parentNamed.isDirectory() ||
      parentNamed.isSymbolicLink() ||
      !sameIdentity(parentBefore, parentNamed)
    ) {
      fail("parent directory identity");
    }
    const entries = readdirSync(procPath(parentFd)).sort();
    if (entries.length === 0) {
      if (
        parentBefore.uid !== BigInt(policy.parentUid) ||
        parentBefore.gid !== BigInt(policy.markerGid) ||
        mode(parentBefore) !== 0o755n ||
        parentBefore.nlink < 2n
      ) {
        fail("empty parent is not a trusted named-volume root");
      }
      initializeNew(parentFd, policy);
      return "initialized";
    }
    if (
      entries.length !== ROOT_LEAVES.length ||
      entries.some((entry, index) => entry !== ROOT_LEAVES[index])
    ) {
      fail("volume layout is partial or unknown");
    }
    validateExisting(parentFd, parentBefore, policy, root, testHooks);
    return "validated";
  } finally {
    closeSync(parentFd);
  }
}

export async function initializeStateVolumeForTest(root, policy, testHooks) {
  try {
    return initializeStateVolume(root, policy, testHooks);
  } catch (error) {
    if (error?.category === "browser_volume_initialization_failed") throw error;
    fail(
      `filesystem validation: ${
        typeof error?.code === "string"
          ? error.code
          : error instanceof Error
            ? error.message
            : "unknown error"
      }`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) fail("unexpected arguments");
  await initializeStateVolumeForTest(VOLUME_ROOT, PRODUCTION_POLICY);
}
