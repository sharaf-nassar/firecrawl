import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const runnerPath = fileURLToPath(import.meta.url);
const buildRoot = resolve(packageRoot, "build");
const lockPath = resolve(buildRoot, ".atomic-directory-publication-build.lock");
const builderPath = resolve(packageRoot, "scripts/build-native.mjs");
const fixturePath = resolve(
  packageRoot,
  "scripts/native-build-lock-orphan.fixture.mjs",
);
const faultVariantSpecs = Object.freeze([
  Object.freeze({ name: "napi-promise", leaf: "fault_napi_promise.node", id: 1 }),
  Object.freeze({
    name: "napi-reference",
    leaf: "fault_napi_reference.node",
    id: 2,
  }),
  Object.freeze({
    name: "napi-async-create",
    leaf: "fault_napi_async_create.node",
    id: 3,
  }),
  Object.freeze({
    name: "napi-async-queue",
    leaf: "fault_napi_async_queue.node",
    id: 4,
  }),
  Object.freeze({
    name: "pidfd-signal",
    leaf: "fault_pidfd_signal.node",
    id: 5,
  }),
  Object.freeze({ name: "wait", leaf: "fault_wait.node", id: 6 }),
  Object.freeze({ name: "deadline", leaf: "fault_deadline.node", id: 7 }),
  Object.freeze({
    name: "claim-external",
    leaf: "fault_claim_external.node",
    id: 8,
  }),
  Object.freeze({
    name: "claim-reference",
    leaf: "fault_claim_reference.node",
    id: 9,
  }),
  Object.freeze({
    name: "claim-timer-init",
    leaf: "fault_claim_timer_init.node",
    id: 10,
  }),
  Object.freeze({
    name: "claim-timer-start",
    leaf: "fault_claim_timer_start.node",
    id: 11,
  }),
  Object.freeze({
    name: "phase-graceful",
    leaf: "phase_graceful.node",
    id: 12,
  }),
  Object.freeze({ name: "phase-term", leaf: "phase_term.node", id: 13 }),
  Object.freeze({ name: "phase-kill", leaf: "phase_kill.node", id: 14 }),
  Object.freeze({
    name: "post-kill-timeout",
    leaf: "post_kill_timeout.node",
    id: 15,
  }),
  Object.freeze({
    name: "audit-create",
    leaf: "fault_audit_create.node",
    id: 16,
  }),
  Object.freeze({
    name: "settlement-handle-scope",
    leaf: "fault_settlement_handle_scope.node",
    id: 17,
  }),
  Object.freeze({
    name: "settlement-object",
    leaf: "fault_settlement_object.node",
    id: 18,
  }),
  Object.freeze({
    name: "settlement-property",
    leaf: "fault_settlement_property.node",
    id: 19,
  }),
  Object.freeze({
    name: "settlement-resolve",
    leaf: "fault_settlement_resolve.node",
    id: 20,
  }),
  Object.freeze({
    name: "settlement-reject",
    leaf: "fault_settlement_reject.node",
    id: 21,
  }),
  Object.freeze({
    name: "settlement-owner-init",
    leaf: "fault_settlement_owner_init.node",
    id: 22,
  }),
  Object.freeze({
    name: "settlement-owner-start",
    leaf: "fault_settlement_owner_start.node",
    id: 23,
  }),
  Object.freeze({
    name: "settlement-owner-ref",
    leaf: "fault_settlement_owner_ref.node",
    id: 24,
  }),
  Object.freeze({
    name: "preauthority-ref-delete",
    leaf: "fault_preauthority_ref_delete.node",
    id: 25,
  }),
  Object.freeze({
    name: "audit-cleanup-promise",
    leaf: "fault_audit_cleanup_promise.node",
    id: 26,
  }),
  Object.freeze({
    name: "audit-lifecycle-promise",
    leaf: "fault_audit_lifecycle_promise.node",
    id: 27,
  }),
  Object.freeze({
    name: "audit-close-external",
    leaf: "fault_audit_close_external.node",
    id: 28,
  }),
  Object.freeze({
    name: "audit-close-typedarray",
    leaf: "fault_audit_close_typedarray.node",
    id: 29,
  }),
  Object.freeze({
    name: "audit-property",
    leaf: "fault_audit_property.node",
    id: 30,
  }),
  Object.freeze({
    name: "audit-reference",
    leaf: "fault_audit_reference.node",
    id: 31,
  }),
  Object.freeze({
    name: "setup-resolve",
    leaf: "fault_setup_resolve.node",
    id: 32,
  }),
  Object.freeze({
    name: "preauthority-deferred-settle",
    leaf: "fault_preauthority_deferred_settle.node",
    id: 33,
  }),
  Object.freeze({
    name: "lifecycle-scope-close",
    leaf: "fault_lifecycle_scope_close.node",
    id: 34,
  }),
]);
const faultVariantIds = new Map(
  faultVariantSpecs.map(({ name, id }) => [name, id]),
);
const fixtureControlPrefix = "atomic-orphan-fixture-control-v1:";
const boundaryControlPrefix = "atomic-orphan-boundary-v1:";
const orphanBoundarySchedules = Object.freeze([
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
const claimSetupFaults = new Set([
  "napi-promise",
  "napi-reference",
  "claim-external",
  "claim-reference",
  "claim-timer-init",
  "claim-timer-start",
  "audit-create",
  "settlement-owner-init",
  "settlement-owner-start",
  "settlement-owner-ref",
  "preauthority-ref-delete",
  "audit-cleanup-promise",
  "audit-lifecycle-promise",
  "audit-close-external",
  "audit-close-typedarray",
  "audit-property",
  "audit-reference",
  "setup-resolve",
  "preauthority-deferred-settle",
]);
const reapFailureVariants = new Set([
  "napi-async-create",
  "napi-async-queue",
  "pidfd-signal",
  "wait",
  "deadline",
  "post-kill-timeout",
  "settlement-reject",
]);
const lockFlags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;
const productionLockRuntime = Object.freeze({
  buildRoot,
  lockPath,
  spawn: spawnSync,
});

const exactBuildEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
  SOURCE_DATE_EPOCH: "1",
  ATOMIC_BUILD_LOCK_FD: "9",
});

const forbiddenExact = new Set([
  "TMPDIR",
  "TMP",
  "TEMP",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "GCC_EXEC_PREFIX",
  "COMPILER_PATH",
  "LIBRARY_PATH",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "OBJC_INCLUDE_PATH",
  "DEPENDENCIES_OUTPUT",
  "SUNPRO_DEPENDENCIES",
  "GCC_SPECS",
  "GCC_PLUGIN_PATH",
  "PLUGIN_PATH",
  "CC",
  "CFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "NPM_CONFIG_CC",
  "NPM_CONFIG_CFLAGS",
  "NPM_CONFIG_CPPFLAGS",
  "NPM_CONFIG_LDFLAGS",
]);

function fail(message) {
  throw new Error(`atomic native build lock: ${message}`);
}

function freshEnvironment(values) {
  return Object.assign(Object.create(null), values);
}

function createBuildEnvironment() {
  return freshEnvironment(exactBuildEnvironment);
}

function createOrphanCleanupState() {
  return {
    claimState: "unclaimed",
    preclaimState: "not_attempted",
    claimAttempted: false,
    handle: undefined,
    claimError: undefined,
    releaseState: "not_attempted",
    releaseWriteAttempted: false,
    releaseWriteResult: "not_attempted",
    releaseWriterCloseAttempted: false,
    releaseWriterCloseResult: "not_attempted",
    reapState: "not_attempted",
    reapAttempted: false,
    reapPromise: undefined,
    reapResult: undefined,
    reapError: undefined,
    activeDispatch: undefined,
    boundary: undefined,
    policy: Object.freeze({
      gracefulTimeoutMs: 2000,
      termTimeoutMs: 1000,
      killTimeoutMs: 1000,
    }),
  };
}

async function runOrphanCleanupDispatch(state, effects) {
  if (state.claimState === "unclaimed") {
    if (state.claimAttempted) return state;
    state.claimAttempted = true;
    if (state.preclaimState === "not_attempted") {
      state.preclaimState = "starting";
      try {
        state.claimEvidence = await effects.prepareClaim();
        state.preclaimState = "settled";
      } catch (error) {
        state.claimError = error;
        state.preclaimState = "failed";
        return state;
      }
    }
    if (state.preclaimState !== "settled") return state;
    try {
      const claimed = effects.claim(state.claimEvidence);
      state.handle =
        claimed !== null &&
          (typeof claimed === "object" || typeof claimed === "function") &&
          typeof claimed.then === "function"
          ? await claimed
          : claimed;
      state.claimState = "claimed_unconsumed";
      state.boundary?.hit("claim-ack");
    } catch (error) {
      state.claimError = error;
      return state;
    }
  }
  if (state.claimState === "claimed_unconsumed") {
    if (!state.releaseWriteAttempted) {
      state.releaseWriteAttempted = true;
      try {
        const count = effects.writeRelease();
        if (count !== 1) {
          throw new Error(
            "one-byte FIFO write violated POSIX atomic-write semantics",
          );
        }
        state.releaseWriteResult = "written";
        state.releaseState = "written";
        state.boundary?.hit("release-write-result", "written");
      } catch (error) {
        state.releaseWriteResult = error;
        state.releaseState = "failed";
        state.boundary?.hit(
          "release-write-result",
          error?.code ?? "write_failed",
        );
      }
    }
    if (!state.releaseWriterCloseAttempted) {
      state.releaseWriterCloseAttempted = true;
      state.boundary?.hit("close-attempt");
      try {
        effects.closeRelease();
        state.releaseWriterCloseResult = "closed";
        if (state.releaseState === "written") state.releaseState = "closed";
        state.boundary?.hit("close-result", "closed");
      } catch (error) {
        state.releaseWriterCloseResult = error;
        state.releaseState = "failed";
        state.boundary?.hit("close-result", error?.code ?? "close_failed");
      }
    }
    if (state.reapState === "not_attempted") {
      state.reapAttempted = true;
      state.reapState = "starting";
    }
    if (state.reapState === "starting") {
      try {
        const promise = effects.reap(state.handle, state.policy);
        state.boundary?.hit("promise-return");
        if (
          promise === null ||
          (typeof promise !== "object" && typeof promise !== "function") ||
          typeof promise.then !== "function"
        ) {
          throw new TypeError("native reap did not return a Promise");
        }
        state.reapPromise = promise;
        state.boundary?.hit("promise-storage");
        state.reapState = "pending";
        state.claimState = "reap_pending";
        state.boundary?.hit("promise-pending");
      } catch (error) {
        state.reapError = error;
        return state;
      }
    }
  }
  if (state.claimState === "reap_pending") {
    try {
      state.reapResult = await state.reapPromise;
      state.reapState = "settled";
      state.claimState = "reaped";
      state.boundary?.hit("promise-settlement", "resolved");
      state.boundary?.hit("repeated-reentry");
    } catch (error) {
      state.reapError = error;
      state.reapState = "settled";
      state.boundary?.hit("promise-settlement", "rejected");
      state.boundary?.hit("repeated-reentry");
    }
  }
  return state;
}

function dispatchOrphanCleanup(state, effects) {
  if (state.activeDispatch !== undefined) {
    return state.activeDispatch;
  }
  let resolveDispatch;
  let rejectDispatch;
  const stable = new Promise((resolvePromise, rejectPromise) => {
    resolveDispatch = resolvePromise;
    rejectDispatch = rejectPromise;
  });
  state.activeDispatch = stable;
  queueMicrotask(async () => {
    try {
      resolveDispatch(await runOrphanCleanupDispatch(state, effects));
    } catch (error) {
      rejectDispatch(error);
    } finally {
      state.activeDispatch = undefined;
    }
  });
  return stable;
}

function createOrphanCleanupEffects(runtime) {
  return Object.freeze({
    prepareClaim: () => runtime.prepareClaim(),
    claim: (evidence) => runtime.claim(evidence),
    writeRelease: () => runtime.writeRelease(),
    closeRelease: () => runtime.closeRelease(),
    reap: (handle, policy) => runtime.reap(handle, policy),
  });
}

function createBoundaryController(target, state, audit) {
  if (target === "none") {
    return undefined;
  }
  if (!orphanBoundarySchedules.includes(target)) {
    fail(`unknown orphan boundary schedule ${target}`);
  }
  const events = [];
  const reentries = [];
  let effects;
  let targetHits = 0;
  const controller = {
    bind(boundEffects) {
      effects = boundEffects;
    },
    hit(name, result) {
      events.push(
        Object.freeze({
          name,
          ...(result === undefined ? {} : { result }),
        }),
      );
      if (name !== target) return;
      targetHits++;
      const before = JSON.stringify(audit);
      const count = target === "repeated-reentry" ? 3 : 1;
      for (let index = 0; index < count; index++) {
        reentries.push(dispatchOrphanCleanup(state, effects));
      }
      if (JSON.stringify(audit) !== before) {
        fail(`boundary reentry advanced effects at ${target}`);
      }
    },
    finish(transaction) {
      if (targetHits !== 1 || reentries.length === 0) {
        fail(`boundary schedule ${target} was not hit exactly once`);
      }
      if (reentries.some((promise) => promise !== transaction)) {
        fail(`boundary schedule ${target} changed in-flight Promise identity`);
      }
      return Object.freeze({
        target,
        targetHits,
        reentries: reentries.length,
        stablePromise: true,
        events: Object.freeze(events),
      });
    },
  };
  return Object.freeze(controller);
}

function assertSafeInheritedEnvironment(environment = process.env) {
  for (const rawKey of Object.keys(environment)) {
    const key = rawKey.toUpperCase();
    const components = key.split("_");
    if (
      key.startsWith("NODE_") ||
      forbiddenExact.has(key) ||
      key.startsWith("GCC_") ||
      key.startsWith("COLLECT_GCC") ||
      components.some((component) =>
        ["SPEC", "SPECS", "PLUGIN", "PLUGINS"].includes(component),
      ) ||
      key.startsWith("ATOMIC_BUILD_LOCK_TEST_") ||
      key.startsWith("ATOMIC_BUILD_LOCK_FIXTURE_")
    ) {
      fail(`inherited environment key ${rawKey} is forbidden`);
    }
  }
}

function validateLockStat(status) {
  if (
    !status.isFile() ||
    status.uid !== process.getuid() ||
    (status.mode & 0o7777) !== 0o600 ||
    status.nlink !== 1
  ) {
    fail("build lock record is not a private owned regular file");
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertBuildLockRecord(path) {
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("build lock record is missing");
    }
    throw error;
  }
  validateLockStat(status);
  return status;
}

function validateHeldLock(heldLockFd, original, currentLockPath = lockPath) {
  const descriptorStatus = fstatSync(heldLockFd);
  const pathStatus = assertBuildLockRecord(currentLockPath);
  validateLockStat(descriptorStatus);
  if (
    !sameIdentity(descriptorStatus, original) ||
    !sameIdentity(pathStatus, original)
  ) {
    fail("build lock descriptor identity changed");
  }
}

function verifiedClose(heldLockFd, original) {
  let closeError;
  try {
    closeSync(heldLockFd);
  } catch (error) {
    closeError = error;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  try {
    fstatSync(heldLockFd);
    fail("retained build lock descriptor remained open");
  } catch (error) {
    if (error?.code !== "EBADF") {
      throw error;
    }
  }
  for (const leaf of readdirSync("/proc/self/fd")) {
    const candidate = Number(leaf);
    if (!Number.isSafeInteger(candidate) || candidate < 3) {
      continue;
    }
    try {
      const status = fstatSync(candidate);
      if (sameIdentity(status, original)) {
        fail("another runner descriptor retained the build lock identity");
      }
    } catch (error) {
      if (error?.code !== "EBADF" && error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function exactStdio(heldLockFd, stdout = "inherit", stderr = "inherit") {
  return [
    "ignore",
    stdout,
    stderr,
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    heldLockFd,
  ];
}

function buildFlockInvocation(heldLockFd) {
  return Object.freeze({
    command: "/usr/bin/flock",
    args: Object.freeze(["--exclusive", "--timeout", "60", "9"]),
    stdio: Object.freeze(exactStdio(heldLockFd)),
  });
}

function buildBuilderInvocationForPath(
  target,
  heldLockFd,
  currentBuilderPath,
  currentPackageRoot,
) {
  if (target !== "production" && target !== "all") {
    fail("target must be production or all");
  }
  return Object.freeze({
    command: realpathSync(process.execPath),
    args: Object.freeze([realpathSync(currentBuilderPath), target]),
    cwd: currentPackageRoot,
    env: createBuildEnvironment(),
    stdio: Object.freeze(exactStdio(heldLockFd)),
  });
}

function buildBuilderInvocation(target, heldLockFd) {
  return buildBuilderInvocationForPath(
    target,
    heldLockFd,
    builderPath,
    packageRoot,
  );
}

function assertRuntime() {
  if (
    process.platform !== "linux" ||
    process.version !== "v22.22.1" ||
    !["x64", "arm64"].includes(process.arch)
  ) {
    fail("runner requires Node 22.22.1 on Linux x64 or arm64");
  }
}

function assertFlock() {
  let canonical;
  let status;
  try {
    canonical = realpathSync("/usr/bin/flock");
    status = lstatSync(canonical);
  } catch {
    fail("/usr/bin/flock is unavailable");
  }
  if (
    canonical !== "/usr/bin/flock" ||
    !status.isFile() ||
    (status.mode & 0o111) === 0 ||
    status.uid !== 0 ||
    (status.mode & 0o022) !== 0
  ) {
    fail("/usr/bin/flock is not the canonical trusted executable");
  }
}

function ensureBuildRoot(currentBuildRoot = buildRoot) {
  try {
    mkdirSync(currentBuildRoot, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const status = lstatSync(currentBuildRoot);
  if (
    !status.isDirectory() ||
    status.uid !== process.getuid() ||
    (status.mode & 0o7777) !== 0o700
  ) {
    fail("build root is not a private owned directory");
  }
}

function spawnAndRequireSuccess(
  invocation,
  label,
  spawnImplementation = spawnSync,
) {
  const result = spawnImplementation(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: invocation.stdio,
  });
  if (result.signal !== null) {
    fail(`${label} terminated by signal`);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`${label} exited unsuccessfully`);
  }
  return result;
}

function withAcquiredBuildLock(
  runLocked,
  runtime = productionLockRuntime,
) {
  process.umask(0o077);
  ensureBuildRoot(runtime.buildRoot);
  assertFlock();

  const heldLockFd = openSync(runtime.lockPath, lockFlags, 0o600);
  const original = fstatSync(heldLockFd);
  let closeAttempted = false;
  const closeOnce = () => {
    if (closeAttempted) {
      return;
    }
    closeAttempted = true;
    verifiedClose(heldLockFd, original);
  };
  try {
    validateHeldLock(heldLockFd, original, runtime.lockPath);
    spawnAndRequireSuccess(
      buildFlockInvocation(heldLockFd),
      "flock helper",
      runtime.spawn,
    );
    validateHeldLock(heldLockFd, original, runtime.lockPath);
    const value = runLocked(heldLockFd, original);
    closeOnce();
    return value;
  } finally {
    closeOnce();
  }
}

async function withAcquiredBuildLockAsync(runLocked) {
  process.umask(0o077);
  ensureBuildRoot();
  assertFlock();
  const heldLockFd = openSync(lockPath, lockFlags, 0o600);
  const original = fstatSync(heldLockFd);
  let closeAttempted = false;
  const closeOnce = () => {
    if (closeAttempted) return;
    closeAttempted = true;
    verifiedClose(heldLockFd, original);
  };
  try {
    validateHeldLock(heldLockFd, original);
    spawnAndRequireSuccess(buildFlockInvocation(heldLockFd), "flock helper");
    validateHeldLock(heldLockFd, original);
    return await runLocked(heldLockFd, original, closeOnce);
  } finally {
    closeOnce();
  }
}

function runProduction(target) {
  return withAcquiredBuildLock((heldLockFd) =>
    spawnAndRequireSuccess(
      buildBuilderInvocation(target, heldLockFd),
      "native builder",
    ),
  );
}

async function runLockFailureMatrixForTest() {
  const sameStableIdentity = (left, right) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
  const sameDirectoryIdentity = (left, right) =>
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode;
  const unlinkBound = (path, expected) => {
    const current = lstatSync(path, { bigint: true });
    if (!current.isFile() || !sameStableIdentity(expected, current)) {
      fail("lock matrix cleanup file identity changed");
    }
    unlinkSync(path);
  };
  const rmdirBound = (path, expected) => {
    const current = lstatSync(path, { bigint: true });
    if (!sameDirectoryIdentity(expected, current)) {
      fail("lock matrix cleanup directory identity changed");
    }
    rmdirSync(path);
  };
  const builderFixtureSource = `import {
  fstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const expectedEnvironment = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
  SOURCE_DATE_EPOCH: "1",
  ATOMIC_BUILD_LOCK_FD: "9",
};
if (
  process.argv.length !== 3 ||
  process.argv[2] !== "production" ||
  JSON.stringify(Object.keys(process.env).sort()) !==
    JSON.stringify(Object.keys(expectedEnvironment).sort()) ||
  Object.entries(expectedEnvironment).some(
    ([key, value]) => process.env[key] !== value,
  )
) {
  throw new Error("lock matrix builder contract mismatch");
}
const lock = fstatSync(9);
if (
  !lock.isFile() ||
  lock.uid !== process.getuid() ||
  (lock.mode & 0o7777) !== 0o600 ||
  lock.nlink !== 1
) {
  throw new Error("lock matrix builder fd9 mismatch");
}
const root = new URL("../", import.meta.url);
writeFileSync(new URL("builder.marker", root), "spawned\\n", {
  flag: "wx",
  mode: 0o600,
});
const children = readFileSync(
  \`/proc/self/task/\${process.pid}/children\`,
  "utf8",
);
writeFileSync(new URL("builder.children", root), children, {
  flag: "wx",
  mode: 0o600,
});
const behavior = readFileSync(new URL("behavior", root), "utf8");
if (behavior === "nonzero\\n") {
  process.exit(23);
}
if (behavior === "signal\\n") {
  process.kill(process.pid, "SIGTERM");
}
throw new Error("lock matrix builder behavior mismatch");
`;
  const lockHolderSource = `const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  writeFileSync,
} = require("node:fs");
const { spawnSync } = require("node:child_process");

if (process.argv.length !== 3) {
  throw new Error("lock holder argument mismatch");
}
const lockPath = process.argv[1];
const readyPath = process.argv[2];
const lockFd = openSync(
  lockPath,
  constants.O_RDWR | constants.O_NOFOLLOW,
);
const opened = fstatSync(lockFd);
const named = lstatSync(lockPath);
if (
  !opened.isFile() ||
  opened.dev !== named.dev ||
  opened.ino !== named.ino ||
  opened.uid !== process.getuid() ||
  (opened.mode & 0o7777) !== 0o600 ||
  opened.nlink !== 1
) {
  throw new Error("lock holder identity mismatch");
}
const acquired = spawnSync(
  "/usr/bin/flock",
  ["--exclusive", "--timeout", "2", "9"],
  {
    stdio: [
      "ignore",
      "pipe",
      "pipe",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      lockFd,
    ],
  },
);
if (
  acquired.error !== undefined ||
  acquired.signal !== null ||
  acquired.status !== 0
) {
  throw acquired.error ?? new Error("lock holder acquisition failed");
}
writeFileSync(
  readyPath,
  JSON.stringify({
    pid: process.pid,
    dev: String(opened.dev),
    ino: String(opened.ino),
  }),
  { flag: "wx", mode: 0o600 },
);
let closed = false;
const finish = () => {
  if (!closed) {
    closed = true;
    closeSync(lockFd);
  }
  process.exit(0);
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
setInterval(() => {}, 1000);
`;
  const readProcessIdentity = (pid) => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) fail("lock holder process identity was malformed");
    return stat.slice(close + 2).split(" ")[19];
  };
  const waitForChildEvent = (child, description, timeoutMs) =>
    new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("close", onClose);
        callback(value);
      };
      const onError = (error) => finish(rejectPromise, error);
      const onClose = (code, signal) =>
        finish(resolvePromise, Object.freeze({ code, signal }));
      const timer = setTimeout(
        () =>
          finish(
            rejectPromise,
            new Error(`lock matrix ${description} timed out`),
          ),
        timeoutMs,
      );
      child.once("error", onError);
      child.once("close", onClose);
    });
  const startLockHolder = async (currentLock, currentRoot, readyPath) => {
    const nullFd = openSync(
      "/dev/null",
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    let child;
    try {
      child = spawn(
        realpathSync(process.execPath),
        ["-e", lockHolderSource, currentLock, readyPath],
        {
          cwd: currentRoot,
          env: createBuildEnvironment(),
          stdio: [nullFd, nullFd, nullFd],
        },
      );
    } finally {
      closeSync(nullFd);
    }
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      fail("lock holder did not expose an exact pid");
    }
    const identity = readProcessIdentity(pid);
    const deadline = performance.now() + 2000;
    let readyIdentity;
    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        fail("lock holder exited before readiness");
      }
      try {
        readyIdentity = lstatSync(readyPath, { bigint: true });
        if (
          !readyIdentity.isFile() ||
          readyIdentity.uid !== BigInt(process.getuid()) ||
          (readyIdentity.mode & 0o7777n) !== 0o600n ||
          readyIdentity.nlink !== 1n
        ) {
          fail("lock holder readiness identity was invalid");
        }
        const ready = JSON.parse(readFileSync(readyPath, "utf8"));
        const lock = lstatSync(currentLock, { bigint: true });
        if (
          ready.pid !== pid ||
          ready.dev !== String(lock.dev) ||
          ready.ino !== String(lock.ino)
        ) {
          fail("lock holder readiness evidence mismatched");
        }
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    if (readyIdentity === undefined) {
      fail("lock holder readiness timed out");
    }
    return Object.freeze({
      child,
      pid,
      identity,
      readyIdentity,
      readyPath,
    });
  };
  const stopLockHolder = async (holder) => {
    const current = readProcessIdentity(holder.pid);
    if (current !== holder.identity) {
      fail("lock holder process identity changed before cleanup");
    }
    const exited = waitForChildEvent(
      holder.child,
      "holder termination",
      2000,
    );
    process.kill(holder.pid, "SIGTERM");
    const result = await exited;
    if (result.code !== 0 || result.signal !== null) {
      fail("lock holder did not terminate cleanly");
    }
    try {
      readFileSync(`/proc/${holder.pid}/stat`, "utf8");
      fail("lock holder remained after exact reap");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    unlinkBound(holder.readyPath, holder.readyIdentity);
  };
  const cases = [
    "helper-signal",
    "helper-timeout",
    "builder-nonzero",
    "builder-signal",
    "post-lock-revalidation",
    "builder-spawn-failure",
  ];
  const results = [];
  for (const fault of cases) {
    const root = mkdtempSync(join(tmpdir(), "atomic-build-lock-matrix-"));
    const privateScripts = join(root, "scripts");
    const privateBuild = join(root, "build");
    const privateLock = join(
      privateBuild,
      ".atomic-directory-publication-build.lock",
    );
    const replacedLock = join(privateBuild, "replaced.lock");
    const privateStage = join(
      privateBuild,
      ".atomic-directory-publication-stage",
    );
    const sentinel = join(privateStage, "foreign");
    const privateBuilder = join(privateScripts, "build-native.mjs");
    const behavior = join(root, "behavior");
    const marker = join(root, "builder.marker");
    const builderChildren = join(root, "builder.children");
    const holderReady = join(root, "holder.ready");
    let lockReplaced = false;
    let helperSpawns = 0;
    let builderSpawns = 0;
    let errorText = "";
    let holder;
    const rootIdentity = lstatSync(root, { bigint: true });
    mkdirSync(privateScripts, { mode: 0o700 });
    mkdirSync(privateBuild, { mode: 0o700 });
    mkdirSync(privateStage, { mode: 0o700 });
    writeFileSync(sentinel, "foreign\n", { flag: "wx", mode: 0o600 });
    writeFileSync(privateBuilder, builderFixtureSource, {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      behavior,
      fault === "builder-signal" ? "signal\n" : "nonzero\n",
      { flag: "wx", mode: 0o600 },
    );
    const scriptsIdentity = lstatSync(privateScripts, { bigint: true });
    const buildIdentity = lstatSync(privateBuild, { bigint: true });
    const stageBefore = lstatSync(privateStage, { bigint: true });
    const sentinelBefore = lstatSync(sentinel, { bigint: true });
    const builderBefore = lstatSync(privateBuilder, { bigint: true });
    const behaviorBefore = lstatSync(behavior, { bigint: true });
    const childrenBefore = readFileSync(
      `/proc/self/task/${process.pid}/children`,
      "utf8",
    );
    const spawnImplementation = (command, args, options) => {
      if (command === "/usr/bin/flock") {
        helperSpawns++;
        if (fault === "helper-signal") {
          return spawnSync(command, args, {
            ...options,
            timeout: 100,
            killSignal: "SIGTERM",
          });
        }
        if (fault === "helper-timeout") {
          return spawnSync(
            command,
            ["--exclusive", "--timeout", "1", "9"],
            options,
          );
        }
        const result = spawnSync(command, args, options);
        if (fault === "post-lock-revalidation") {
          renameSync(privateLock, replacedLock);
          writeFileSync(privateLock, "", {
            flag: "wx",
            mode: 0o600,
          });
          lockReplaced = true;
        }
        return result;
      }
      builderSpawns++;
      return spawnSync(command, args, options);
    };
    try {
      if (fault === "helper-signal" || fault === "helper-timeout") {
        const seededLockFd = openSync(privateLock, lockFlags, 0o600);
        closeSync(seededLockFd);
        holder = await startLockHolder(privateLock, root, holderReady);
      }
      withAcquiredBuildLock(
        (heldLockFd) =>
          spawnAndRequireSuccess(
            buildBuilderInvocationForPath(
              "production",
              heldLockFd,
              privateBuilder,
              fault === "builder-spawn-failure"
                ? join(root, "absent-builder-cwd")
                : root,
            ),
            "native builder",
            spawnImplementation,
          ),
        Object.freeze({
          buildRoot: privateBuild,
          lockPath: privateLock,
          spawn: spawnImplementation,
        }),
      );
      fail(`lock matrix fault unexpectedly succeeded: ${fault}`);
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    } finally {
      if (holder !== undefined) {
        await stopLockHolder(holder);
      }
    }
    const stageAfter = lstatSync(privateStage, { bigint: true });
    const sentinelAfter = lstatSync(sentinel, { bigint: true });
    const stageUnchanged =
      sameStableIdentity(stageBefore, stageAfter) &&
      sameStableIdentity(sentinelBefore, sentinelAfter) &&
      readFileSync(sentinel, "utf8") === "foreign\n";
    const childrenAfter = readFileSync(
      `/proc/self/task/${process.pid}/children`,
      "utf8",
    );
    let markerIdentity;
    const builderSpawned = (() => {
      try {
        markerIdentity = lstatSync(marker, { bigint: true });
        return readFileSync(marker, "utf8") === "spawned\n";
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    })();
    let childrenIdentity;
    const nativeChildren = (() => {
      try {
        childrenIdentity = lstatSync(builderChildren, { bigint: true });
        return readFileSync(builderChildren, "utf8").trim();
      } catch (error) {
        if (error?.code === "ENOENT") return "";
        throw error;
      }
    })();
    const lockLeaves = lockReplaced
      ? [privateLock, replacedLock]
      : [privateLock];
    const lockIdentities = [];
    for (const currentLock of lockLeaves) {
      lockIdentities.push(lstatSync(currentLock, { bigint: true }));
      const fd = openSync(
        currentLock,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        const acquired = spawnSync(
          "/usr/bin/flock",
          ["--exclusive", "--nonblock", "9"],
          { stdio: exactStdio(fd, "pipe", "pipe") },
        );
        if (acquired.status !== 0) {
          fail(`lock matrix retained lock after failure: ${fault}`);
        }
      } finally {
        closeSync(fd);
      }
    }
    results.push(
      Object.freeze({
        fault,
        helperSpawns,
        builderSpawns,
        builderSpawned,
        nativeChildren,
        runnerChildrenUnchanged: childrenAfter === childrenBefore,
        stageUnchanged,
        errorText,
      }),
    );
    for (const leaf of [builderChildren, marker]) {
      const expected = leaf === builderChildren
        ? childrenIdentity
        : markerIdentity;
      if (expected !== undefined) unlinkBound(leaf, expected);
    }
    unlinkBound(behavior, behaviorBefore);
    unlinkBound(privateBuilder, builderBefore);
    rmdirBound(privateScripts, scriptsIdentity);
    unlinkBound(sentinel, sentinelBefore);
    rmdirBound(privateStage, stageBefore);
    for (const [index, currentLock] of lockLeaves.entries()) {
      unlinkBound(currentLock, lockIdentities[index]);
    }
    rmdirBound(privateBuild, buildIdentity);
    rmdirBound(root, rootIdentity);
  }
  return Object.freeze(results);
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const testAddonIdentityKeys = Object.freeze([
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
const loadedTestAddons = new Map();
const retainedTestAddonFds = new Set();

function loadTestAddonHeld(addonFd) {
  const before = fstatSync(addonFd, { bigint: true });
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !before.isFile() ||
    before.uid !== BigInt(uid) ||
    (before.mode & 0o7777n) !== 0o600n ||
    before.nlink !== 1n ||
    before.size <= 0n
  ) {
    fail("held test addon identity is invalid");
  }
  const identity = `${before.dev}:${before.ino}`;
  const snapshot = Object.freeze(
    Object.fromEntries(
      testAddonIdentityKeys.map((key) => [key, before[key]]),
    ),
  );
  const cached = loadedTestAddons.get(identity);
  if (
    cached !== undefined &&
    testAddonIdentityKeys.some(
      (key) => cached.identity[key] !== snapshot[key],
    )
  ) {
    fail("held test addon cached identity drifted");
  }
  let native = cached?.native;
  const firstLoad = cached === undefined;
  if (native === undefined) {
    const moduleRecord = { exports: Object.create(null) };
    process.dlopen(
      moduleRecord,
      `/proc/self/fd/${addonFd}`,
      osConstants.dlopen.RTLD_NOW,
    );
    native = moduleRecord.exports;
  }
  const after = fstatSync(addonFd, { bigint: true });
  if (
    testAddonIdentityKeys.some((key) => before[key] !== after[key]) ||
    native === null ||
    typeof native !== "object" ||
    JSON.stringify(Object.keys(native).sort()) !==
      JSON.stringify(
        [
          "interfaceVersion",
          "napiVersion",
          "renameNoReplace",
          "testHooks",
        ].sort(),
      ) ||
    native.interfaceVersion !== "1.0.0" ||
    native.napiVersion !== 8 ||
    typeof native.renameNoReplace !== "function" ||
    native.testHooks === null ||
    typeof native.testHooks !== "object" ||
    !Object.isFrozen(native.testHooks) ||
    JSON.stringify(Object.keys(native.testHooks).sort()) !==
      JSON.stringify(
        [
          "becomeChildSubreaperForTest",
          "claimAdoptedChildForTest",
          "prepareInheritedLockFdForTest",
          "reapClaimedChildForTest",
        ].sort(),
      )
  ) {
    fail("held test addon load changed identity or exposed invalid ABI");
  }
  if (firstLoad) {
    loadedTestAddons.set(
      identity,
      Object.freeze({ identity: snapshot, native }),
    );
    retainedTestAddonFds.add(addonFd);
  }
  return native;
}

function runHeldTestAddonCacheDriftRegression() {
  const root = mkdtempSync(join(tmpdir(), "atomic-addon-cache-"));
  const rootIdentity = lstatSync(root);
  const path = join(root, "addon.node");
  copyFileSync(
    resolve(
      packageRoot,
      "build/Test/atomic_directory_publication_test.node",
    ),
    path,
  );
  chmodSync(path, 0o600);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let rejected = false;
  try {
    loadTestAddonHeld(fd);
    const before = fstatSync(fd, { bigint: true });
    futimesSync(
      fd,
      new Date(Number(before.atimeMs) - 1000),
      new Date(Number(before.mtimeMs) - 1000),
    );
    try {
      loadTestAddonHeld(fd);
    } catch (error) {
      if (!/cached identity drifted/.test(String(error?.message))) {
        throw error;
      }
      rejected = true;
    }
    if (!rejected) {
      fail("held test addon cache accepted same-inode drift");
    }
  } finally {
    closeRetainedTestAddons();
    const leaf = lstatSync(path);
    if (
      !leaf.isFile() ||
      leaf.dev !== rootIdentity.dev ||
      leaf.uid !== process.getuid() ||
      leaf.nlink !== 1 ||
      (leaf.mode & 0o7777) !== 0o600
    ) {
      fail("held test addon cache fixture identity changed");
    }
    unlinkSync(path);
    const rootAfter = lstatSync(root);
    if (
      !rootAfter.isDirectory() ||
      rootAfter.dev !== rootIdentity.dev ||
      rootAfter.ino !== rootIdentity.ino ||
      rootAfter.uid !== rootIdentity.uid ||
      rootAfter.mode !== rootIdentity.mode ||
      readdirSync(root).length !== 0
    ) {
      fail("held test addon cache fixture root changed");
    }
    rmdirSync(root);
  }
  return rejected;
}

function closeRetainedTestAddons() {
  const failures = [];
  for (const fd of [...retainedTestAddonFds].reverse()) {
    try {
      closeSync(fd);
    } catch (error) {
      failures.push(error);
    }
  }
  retainedTestAddonFds.clear();
  loadedTestAddons.clear();
  if (failures.length > 0) {
    throw new AggregateError(failures, "held test addon cleanup failed");
  }
}

const requiredNodeHeaderLeaves = Object.freeze([
  "node_api.h",
  "node_api_types.h",
  "node_version.h",
]);

function sameTrustedInputIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hashHeldInput(fd) {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const count = readSync(fd, chunk, 0, chunk.length, position);
    if (count === 0) break;
    digest.update(chunk.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function validateTrustedNodeHeaderDirectory(path, status) {
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== BigInt(process.getuid()) ||
    (status.mode & 0o7777n) !== 0o755n ||
    status.nlink < 2n ||
    realpathSync(path) !== path
  ) {
    fail("fault variant Node header directory is untrusted");
  }
}

function validateTrustedNodeHeader(path, status) {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.uid !== BigInt(process.getuid()) ||
    (status.mode & 0o7777n) !== 0o644n ||
    status.nlink !== 1n ||
    realpathSync(path) !== path
  ) {
    fail("fault variant Node header is untrusted");
  }
}

function openTrustedNodeHeaders(prefix) {
  const canonicalPrefix = realpathSync(prefix);
  const nodeInclude = resolve(prefix, "include/node");
  if (
    canonicalPrefix !== prefix ||
    !nodeInclude.startsWith(`${prefix}${sep}`) ||
    realpathSync(nodeInclude) !== nodeInclude
  ) {
    fail("fault variant Node header root is not canonical");
  }
  const opened = [];
  try {
    const directoryBefore = lstatSync(nodeInclude, { bigint: true });
    validateTrustedNodeHeaderDirectory(nodeInclude, directoryBefore);
    const directoryFd = openSync(
      nodeInclude,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    opened.push(directoryFd);
    const directoryHeld = fstatSync(directoryFd, { bigint: true });
    const directoryAfter = lstatSync(nodeInclude, { bigint: true });
    validateTrustedNodeHeaderDirectory(nodeInclude, directoryHeld);
    if (
      !sameTrustedInputIdentity(directoryBefore, directoryHeld) ||
      !sameTrustedInputIdentity(directoryHeld, directoryAfter)
    ) {
      fail("fault variant Node header directory identity changed");
    }

    const headers = [];
    for (const leaf of requiredNodeHeaderLeaves) {
      const path = resolve(nodeInclude, leaf);
      if (!path.startsWith(`${nodeInclude}${sep}`)) {
        fail("fault variant Node header escaped its root");
      }
      const before = lstatSync(path, { bigint: true });
      validateTrustedNodeHeader(path, before);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      opened.push(fd);
      const held = fstatSync(fd, { bigint: true });
      const after = lstatSync(path, { bigint: true });
      validateTrustedNodeHeader(path, held);
      if (
        !sameTrustedInputIdentity(before, held) ||
        !sameTrustedInputIdentity(held, after)
      ) {
        fail("fault variant Node header identity changed");
      }
      headers.push(
        Object.freeze({
          leaf,
          path,
          fd,
          identity: held,
          sha256: hashHeldInput(fd),
        }),
      );
    }
    return Object.freeze({
      prefix,
      nodeInclude,
      directory: Object.freeze({
        path: nodeInclude,
        fd: directoryFd,
        identity: directoryHeld,
      }),
      headers: Object.freeze(headers),
      fds: Object.freeze(opened),
    });
  } catch (error) {
    const failures = [error];
    for (const fd of [...opened].reverse()) {
      try {
        closeSync(fd);
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "fault variant Node header validation cleanup failed",
      );
    }
    throw error;
  }
}

function revalidateTrustedNodeHeaders(trusted) {
  if (
    realpathSync(trusted.prefix) !== trusted.prefix ||
    realpathSync(trusted.nodeInclude) !== trusted.nodeInclude
  ) {
    fail("fault variant Node header root identity changed");
  }
  const directoryPath = lstatSync(trusted.directory.path, { bigint: true });
  const directoryHeld = fstatSync(trusted.directory.fd, { bigint: true });
  validateTrustedNodeHeaderDirectory(trusted.directory.path, directoryPath);
  validateTrustedNodeHeaderDirectory(trusted.directory.path, directoryHeld);
  if (
    !sameTrustedInputIdentity(trusted.directory.identity, directoryPath) ||
    !sameTrustedInputIdentity(trusted.directory.identity, directoryHeld)
  ) {
    fail("fault variant Node header directory identity changed");
  }
  for (const header of trusted.headers) {
    const pathStatus = lstatSync(header.path, { bigint: true });
    const heldStatus = fstatSync(header.fd, { bigint: true });
    validateTrustedNodeHeader(header.path, pathStatus);
    validateTrustedNodeHeader(header.path, heldStatus);
    if (
      !sameTrustedInputIdentity(header.identity, pathStatus) ||
      !sameTrustedInputIdentity(header.identity, heldStatus) ||
      hashHeldInput(header.fd) !== header.sha256
    ) {
      fail("fault variant Node header identity or hash changed");
    }
  }
}

function closeTrustedNodeHeaders(trusted) {
  const failures = [];
  for (const fd of [...trusted.fds].reverse()) {
    try {
      closeSync(fd);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "fault variant Node header close failed",
    );
  }
}

function runNodeHeaderTrustMatrixForTest() {
  const root = mkdtempSync(join(tmpdir(), "atomic-node-header-trust-"));
  const prefix = join(root, "node");
  const includeParent = join(prefix, "include");
  const nodeInclude = join(includeParent, "node");
  mkdirSync(prefix, { mode: 0o700 });
  mkdirSync(includeParent, { mode: 0o755 });
  mkdirSync(nodeInclude, { mode: 0o755 });
  for (const leaf of requiredNodeHeaderLeaves) {
    writeFileSync(join(nodeInclude, leaf), `${leaf}\n`, {
      mode: 0o644,
      flag: "wx",
    });
  }
  const results = [];
  const requireRejected = (fault) => {
    let trusted;
    let rejected = false;
    try {
      trusted = openTrustedNodeHeaders(prefix);
    } catch {
      rejected = true;
    } finally {
      if (trusted !== undefined) closeTrustedNodeHeaders(trusted);
    }
    if (!rejected) {
      fail(`fault variant Node header negative succeeded: ${fault}`);
    }
    results.push(Object.freeze({ fault, rejected }));
  };
  try {
    const valid = openTrustedNodeHeaders(prefix);
    try {
      revalidateTrustedNodeHeaders(valid);
      if (
        JSON.stringify(valid.headers.map(({ leaf }) => leaf)) !==
          JSON.stringify(requiredNodeHeaderLeaves) ||
        valid.headers.some(({ sha256 }) => !/^[0-9a-f]{64}$/.test(sha256))
      ) {
        fail("fault variant Node header positive proof is invalid");
      }
    } finally {
      closeTrustedNodeHeaders(valid);
    }

    chmodSync(nodeInclude, 0o775);
    requireRejected("writable-directory");
    chmodSync(nodeInclude, 0o755);

    chmodSync(nodeInclude, 0o700);
    requireRejected("wrong-directory-mode");
    chmodSync(nodeInclude, 0o755);

    const writableHeader = join(nodeInclude, "node_api.h");
    chmodSync(writableHeader, 0o664);
    requireRejected("writable-header");
    chmodSync(writableHeader, 0o644);

    chmodSync(writableHeader, 0o600);
    requireRejected("wrong-header-mode");
    chmodSync(writableHeader, 0o644);

    const redirectedInclude = join(includeParent, "node-real");
    renameSync(nodeInclude, redirectedInclude);
    symlinkSync(redirectedInclude, nodeInclude);
    requireRejected("redirected-directory");
    unlinkSync(nodeInclude);
    renameSync(redirectedInclude, nodeInclude);

    const redirectedHeader = join(nodeInclude, "node_api_types.real.h");
    const headerPath = join(nodeInclude, "node_api_types.h");
    renameSync(headerPath, redirectedHeader);
    symlinkSync(redirectedHeader, headerPath);
    requireRejected("redirected-header");
    unlinkSync(headerPath);
    renameSync(redirectedHeader, headerPath);

    const hardlink = join(nodeInclude, "node_api.duplicate.h");
    linkSync(writableHeader, hardlink);
    requireRejected("hardlinked-header");
    unlinkSync(hardlink);

    const wrongOwnerHeader = join(nodeInclude, "node_version.h");
    const wrongOwner = spawnSync(
      "/usr/bin/docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--mount",
        `type=bind,source=${root},target=/fixture`,
        "node:22-slim",
        "chown",
        "1:1",
        "/fixture/node/include/node/node_version.h",
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          LANG: "C",
          TZ: "UTC",
        },
        encoding: "utf8",
      },
    );
    if (
      wrongOwner.error !== undefined ||
      wrongOwner.status !== 0 ||
      wrongOwner.signal !== null
    ) {
      fail(
        `fault variant wrong-owner setup failed: ${
          wrongOwner.error?.message ?? wrongOwner.stderr
        }`,
      );
    }
    requireRejected("wrong-owner-header");
  } finally {
    for (const leaf of [
      "node_api.h",
      "node_api_types.h",
      "node_version.h",
      "node_api.duplicate.h",
      "node_api_types.real.h",
    ]) {
      try {
        unlinkSync(join(nodeInclude, leaf));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const path of [
      nodeInclude,
      join(includeParent, "node-real"),
      includeParent,
      prefix,
      root,
    ]) {
      try {
        const status = lstatSync(path);
        if (status.isSymbolicLink()) unlinkSync(path);
        else rmdirSync(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return Object.freeze(results);
}

function compileFaultVariantAddons(heldLockFd) {
  const compilerCommand = "/usr/bin/gcc";
  const compiler = realpathSync(compilerCommand);
  const compilerStatus = lstatSync(compiler);
  if (
    !compilerStatus.isFile() ||
    compilerStatus.uid !== 0 ||
    (compilerStatus.mode & 0o022) !== 0
  ) {
    fail("fault variant compiler is untrusted");
  }
  const nodeExecutable = realpathSync(process.execPath);
  const nodePrefix = dirname(dirname(nodeExecutable));
  const trustedNodeHeaders = openTrustedNodeHeaders(nodePrefix);
  const nodeInclude = trustedNodeHeaders.nodeInclude;
  try {
  const root = mkdtempSync(join(tmpdir(), "atomic-build-fault-addons-"));
  const rootIdentity = lstatSync(root);
  if (
    !rootIdentity.isDirectory() ||
    rootIdentity.uid !== process.getuid() ||
    (rootIdentity.mode & 0o7777) !== 0o700 ||
    rootIdentity.nlink !== 2
  ) {
    fail("fault variant root is not private");
  }
  const created = [];
  const allowedLeaves = new Set([
    "addon.o",
    "errors.o",
    ...faultVariantSpecs.flatMap((variant) => [
      `hooks-${variant.id}.o`,
      variant.leaf,
    ]),
  ]);
  const cleanupPartial = (requireExactCreated) => {
    const failures = [];
    let leaves = [];
    try {
      const currentRoot = lstatSync(root);
      if (!sameIdentity(currentRoot, rootIdentity)) {
        throw new Error("fault variant root identity changed");
      }
      leaves = readdirSync(root);
    } catch (error) {
      failures.push(error);
      return failures;
    }
    const createdByPath = new Map(created.map((entry) => [entry.path, entry]));
    for (const leaf of [...leaves].sort().reverse()) {
      const path = join(root, leaf);
      try {
        const current = lstatSync(path);
        const expected = createdByPath.get(path);
        if (
          !allowedLeaves.has(leaf) ||
          !current.isFile() ||
          current.uid !== process.getuid() ||
          current.nlink !== 1 ||
          (requireExactCreated &&
            (expected === undefined ||
              !sameIdentity(current, expected.identity)))
        ) {
          throw new Error(`fault variant cleanup rejected leaf ${leaf}`);
        }
        unlinkSync(path);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (readdirSync(root).length !== 0) {
        throw new Error("fault variant cleanup left residual entries");
      }
      rmdirSync(root);
    } catch (error) {
      failures.push(error);
    }
    return failures;
  };
  try {
    const sources = Object.freeze({
      addon: realpathSync(
        resolve(packageRoot, "native/atomic-directory-publication-addon.c"),
      ),
      errors: realpathSync(
        resolve(packageRoot, "native/atomic-directory-publication-errors.c"),
      ),
      hooks: realpathSync(
        resolve(
          packageRoot,
          "native/atomic-directory-publication-test-hooks.c",
        ),
      ),
    });
    const sourceHashes = Object.freeze(
      Object.fromEntries(
        Object.entries(sources).map(([name, path]) => [name, hashFile(path)]),
      ),
    );
    const environment = createBuildEnvironment();
    const commonFlags = [
      "-fPIC",
      "-std=c11",
      "-DNAPI_VERSION=8",
      "-DATOMIC_PUBLISH_TEST_HOOKS=1",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-I",
      nodeInclude,
    ];
    const compilerHash = hashFile(compiler);
    const runCompiler = (args, output) => {
      revalidateTrustedNodeHeaders(trustedNodeHeaders);
      let result;
      try {
        result = spawnSync(compilerCommand, args, {
          cwd: root,
          env: environment,
          stdio: exactStdio(heldLockFd, "pipe", "pipe"),
          encoding: "utf8",
        });
      } finally {
        revalidateTrustedNodeHeaders(trustedNodeHeaders);
      }
      if (
        result.error ||
        result.status !== 0 ||
        result.signal !== null ||
        hashFile(compiler) !== compilerHash
      ) {
        fail(
          `fault variant compiler failed: ${
            result.error?.message ?? result.stderr
          }`,
        );
      }
      chmodSync(output, 0o600);
      const status = lstatSync(output);
      if (
        !status.isFile() ||
        status.uid !== process.getuid() ||
        (status.mode & 0o7777) !== 0o600 ||
        status.nlink !== 1 ||
        status.size === 0
      ) {
        fail("fault variant compiler output is invalid");
      }
      created.push(Object.freeze({ path: output, identity: status }));
    };
    const addonObject = join(root, "addon.o");
    const errorsObject = join(root, "errors.o");
    runCompiler(
      [...commonFlags, "-c", sources.addon, "-o", addonObject],
      addonObject,
    );
    runCompiler(
      [...commonFlags, "-c", sources.errors, "-o", errorsObject],
      errorsObject,
    );
    const artifacts = [];
    for (const variant of faultVariantSpecs) {
      const hooksObject = join(root, `hooks-${variant.id}.o`);
      const artifact = join(root, variant.leaf);
      runCompiler(
        [
          ...commonFlags,
          `-DATOMIC_PUBLISH_FAULT_VARIANT=${variant.id}`,
          "-c",
          sources.hooks,
          "-o",
          hooksObject,
        ],
        hooksObject,
      );
      runCompiler(
        ["-shared", addonObject, errorsObject, hooksObject, "-o", artifact],
        artifact,
      );
      artifacts.push(Object.freeze({ ...variant, path: artifact }));
    }
    const expectedLeaves = created.map(({ path }) =>
      path.slice(root.length + 1)
    );
    if (
      JSON.stringify(readdirSync(root).sort()) !==
        JSON.stringify([...expectedLeaves].sort())
    ) {
      fail("fault variant root inventory is not exact");
    }
    const cleanup = () => {
      const failures = cleanupPartial(true);
      if (failures.length > 0) {
        throw new AggregateError(failures, "fault variant cleanup failed");
      }
    };
    return Object.freeze({
      artifacts: Object.freeze(artifacts),
      compiler,
      compilerHash,
      headerHashes: Object.freeze(
        Object.fromEntries(
          trustedNodeHeaders.headers.map(({ leaf, sha256 }) => [
            leaf,
            sha256,
          ]),
        ),
      ),
      sourceHashes,
      cleanup,
    });
  } catch (error) {
    const cleanupFailures = cleanupPartial(false);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "fault variant compilation and cleanup failed",
      );
    }
    throw error;
  }
  } finally {
    closeTrustedNodeHeaders(trustedNodeHeaders);
  }
}

function procStat(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const tail = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: tail[0], parent: Number(tail[1]), starttime: tail[19] };
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function waitForAdoption(record) {
  const deadline = performance.now() + 2000;
  return new Promise((resolvePromise, reject) => {
    const inspect = () => {
      try {
        const status = procStat(record.pid);
        const lock = statSync(`/proc/${record.pid}/fd/9`);
        if (
          status.parent === process.pid &&
          status.starttime === record.starttime &&
          String(lock.dev) === record.fd9Device &&
          String(lock.ino) === record.fd9Inode &&
          lock.uid === record.fd9Uid &&
          (lock.mode & 0o7777) === record.fd9Mode &&
          lock.nlink === record.fd9Nlink &&
          lock.uid === process.getuid() &&
          (lock.mode & 0o7777) === 0o600 &&
          lock.nlink === 1
        ) {
          resolvePromise();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error("atomic orphan adoption timed out"));
      } else {
        setImmediate(inspect);
      }
    };
    inspect();
  });
}

function waitForExactPidGone(record, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const inspect = () => {
      try {
        const current = procStat(record.pid);
        if (current.starttime !== record.starttime) {
          reject(new Error("exact orphan PID identity was reused"));
          return;
        }
      } catch (error) {
        if (error?.code === "ENOENT") {
          resolvePromise();
          return;
        }
        reject(error);
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error("exact orphan PID cleanup timed out"));
      } else {
        const retry = setTimeout(inspect, 5);
        retry.unref();
      }
    };
    inspect();
  });
}

function waitForSettlementOwnerClose(state, timeoutMs = 5000) {
  if (!(state instanceof Uint32Array) || state.length !== 2) {
    return Promise.reject(
      new Error("native settlement owner close state is invalid"),
    );
  }
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const inspect = () => {
      if (state[0] === 1 && state[1] === 1) {
        resolvePromise(
          Object.freeze({
            settlementOwnerCloseRequests: state[0],
            settlementOwnerCloseCompletions: state[1],
          }),
        );
      } else if (performance.now() >= deadline) {
        reject(new Error("native settlement owner close timed out"));
      } else {
        setImmediate(inspect);
      }
    };
    inspect();
  });
}

function waitForClaimSetupCompletion(result, timeoutMs = 5000) {
  const counters = result?.counters;
  if (!(counters instanceof Uint32Array) || counters.length !== 32) {
    return Promise.reject(
      new Error("native claim setup completion state is invalid"),
    );
  }
  const names = Object.freeze([
    "externalCreateRequests",
    "externalCreateCompletions",
    "ownerRefCreateRequests",
    "ownerRefCreateCompletions",
    "settlementOwnerInitRequests",
    "settlementOwnerInitCompletions",
    "settlementOwnerInitFailures",
    "settlementOwnerStartRequests",
    "settlementOwnerStartCompletions",
    "settlementOwnerStartFailures",
    "settlementOwnerRefRequests",
    "settlementOwnerRefCompletions",
    "settlementOwnerRefFailures",
    "settlementOwnerCloseRequests",
    "settlementOwnerCloseCompletions",
    "preauthorityRefDeleteRequests",
    "preauthorityRefDeleteFailures",
    "preauthorityRefDeleteCompletions",
    "preauthorityRefDeleteRetries",
    "deferredSettleRequests",
    "deferredSettleFailures",
    "deferredSettleCompletions",
    "setupSettleRequests",
    "setupSettleFailures",
    "setupSettleCompletions",
    "setupResultRefDeleteRequests",
    "setupResultRefDeleteFailures",
    "setupResultRefDeleteCompletions",
    "mandatoryDeferredsCreated",
    "mandatoryDeferredsSettled",
    "preauthoritySettlementRetries",
  ]);
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const inspect = () => {
      if (counters[0] === 1) {
        resolvePromise(
          Object.freeze(
            Object.fromEntries(
              names.map((name, index) => [name, counters[index + 1]]),
            ),
          ),
        );
      } else if (performance.now() >= deadline) {
        reject(new Error("native claim setup completion timed out"));
      } else {
        setImmediate(inspect);
      }
    };
    inspect();
  });
}

function readReadyRecord(fd) {
  const bytes = Buffer.alloc(8192);
  let used = 0;
  for (;;) {
    if (used === bytes.length) fail("orphan ready record exceeded bound");
    const count = readSync(fd, bytes, used, bytes.length - used, null);
    if (count === 0) break;
    used += count;
  }
  const text = bytes.subarray(0, used).toString("utf8");
  const record = JSON.parse(text);
  const keys = [
    "event",
    "role",
    "driverPid",
    "driverStarttime",
    "pid",
    "starttime",
    "nodeExecutableRealpath",
    "nodeExecutableSha256",
    "scriptRealpath",
    "scriptSha256",
    "fd9Device",
    "fd9Inode",
    "fd9Uid",
    "fd9Mode",
    "fd9Nlink",
    "fd9Cloexec",
    "fixtureControlVariant",
    "prepareNegativeCases",
    "isolatedPrepareCases",
    "wrongUidProbeSkipped",
  ];
  if (
    !text.endsWith("\n") ||
    text.includes("\r") ||
    text !== `${JSON.stringify(record)}\n` ||
    JSON.stringify(Object.keys(record)) !== JSON.stringify(keys)
  ) {
    fail("orphan ready record is not canonical");
  }
  return record;
}

function assertLiveReadyRecord(record, driver, faultName, boundarySchedule) {
  const driverStatus = procStat(driver.pid);
  const descendantStatus = procStat(record.pid);
  const lock = statSync(`/proc/${record.pid}/fd/9`);
  const match = readFileSync(`/proc/${record.pid}/fdinfo/9`, "utf8").match(
    /^flags:\s+([0-7]+)$/m,
  );
  const checks = {
    flags: match !== null,
    event: record.event === "orphan-ready-v1",
    role: record.role === "orphan_lock_descendant_v1",
    driverPid: record.driverPid === driver.pid,
    driverStarttime: record.driverStarttime === driverStatus.starttime,
    parent: descendantStatus.parent === driver.pid,
    starttime: record.starttime === descendantStatus.starttime,
    nodePath: record.nodeExecutableRealpath === realpathSync(process.execPath),
    nodeHash:
      record.nodeExecutableSha256 === hashFile(record.nodeExecutableRealpath),
    scriptPath: record.scriptRealpath === realpathSync(fixturePath),
    scriptHash: record.scriptSha256 === hashFile(record.scriptRealpath),
    fdDevice: record.fd9Device === String(lock.dev),
    fdInode: record.fd9Inode === String(lock.ino),
    fdUid: record.fd9Uid === lock.uid && lock.uid === process.getuid(),
    fdMode: record.fd9Mode === (lock.mode & 0o7777) && record.fd9Mode === 0o600,
    fdNlink: record.fd9Nlink === lock.nlink && record.fd9Nlink === 1,
    recordCloexec: record.fd9Cloexec === false,
    liveCloexec:
      match !== null && (Number.parseInt(match[1], 8) & 0o2000000) === 0,
    fixtureControlVariant:
      record.fixtureControlVariant ===
      (faultName === "none" ? 0 : faultVariantIds.get(faultName)),
    prepareNegativeCases: record.prepareNegativeCases === 36,
    isolatedPrepareCases:
      record.isolatedPrepareCases ===
      (faultName === "none" && boundarySchedule === "none" ? 7 : 0),
    wrongUidProbeSkipped: record.wrongUidProbeSkipped === false,
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length > 0) {
    fail(`orphan ready live evidence is invalid: ${failed.join(",")}`);
  }
}

function assertMkfifo() {
  const path = realpathSync("/usr/bin/mkfifo");
  const status = lstatSync(path);
  if (
    path !== "/usr/bin/mkfifo" ||
    !status.isFile() ||
    status.uid !== 0 ||
    (status.mode & 0o111) === 0 ||
    (status.mode & 0o022) !== 0
  ) {
    fail("canonical mkfifo identity is untrusted");
  }
  return { path, hash: hashFile(path) };
}

function fixtureStdio(
  inputFd,
  readyWrite,
  releaseRead,
  addonFd,
  controlFd,
  boundaryFd,
  heldLockFd,
) {
  return [
    inputFd,
    "inherit",
    "inherit",
    readyWrite,
    releaseRead,
    addonFd,
    controlFd,
    boundaryFd,
    addonFd,
    heldLockFd,
  ];
}

async function runOneNativeBuildOrphanFixture(
  nativePath,
  faultName,
  boundarySchedule = "none",
) {
  if (
    boundarySchedule !== "none" &&
    !orphanBoundarySchedules.includes(boundarySchedule)
  ) {
    fail(`orphan boundary schedule is invalid: ${boundarySchedule}`);
  }
  const addonFd = openSync(nativePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const native = loadTestAddonHeld(addonFd);
  let recoveryNative = native;
  if (claimSetupFaults.has(faultName)) {
    const recoveryFd = openSync(
      resolve(
        packageRoot,
        "build/Test/atomic_directory_publication_test.node",
      ),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      recoveryNative = loadTestAddonHeld(recoveryFd);
    } finally {
      closeSync(recoveryFd);
    }
  }
  let claimNative = native;
  native.testHooks.becomeChildSubreaperForTest();
  const inputFd = openSync(
    "/dev/null",
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const controlVariant =
    faultName === "none" ? 0 : faultVariantIds.get(faultName);
  if (controlVariant === undefined) {
    closeSync(inputFd);
    closeSync(addonFd);
    fail("orphan fixture control variant is unknown");
  }
  const addonIdentity = fstatSync(addonFd);
  if (
    !addonIdentity.isFile() ||
    addonIdentity.uid !== process.getuid() ||
    (addonIdentity.mode & 0o7777) !== 0o600 ||
    addonIdentity.nlink !== 1
  ) {
    closeSync(addonFd);
    fail("orphan fixture addon descriptor is invalid");
  }
  const mkfifo = assertMkfifo();
  const root = mkdtempSync(join(tmpdir(), "atomic-build-orphan-"));
  const readyPath = join(root, "ready");
  const releasePath = join(root, "release");
  const controlPath = join(root, "control");
  const boundaryPath = join(root, "boundary");
  let readyAnchor;
  let releaseAnchor;
  let readyRead;
  let readyWrite;
  let releaseRead;
  let releaseWrite;
  let readyAnchorClosed = false;
  let releaseAnchorClosed = false;
  let readyReadClosed = false;
  let readyWriteClosed = false;
  let releaseReadClosed = false;
  let releaseWriteClosed = false;
  let readyUnlinked = false;
  let releaseUnlinked = false;
  let rootRemoved = false;
  let addonClosed = false;
  let inputClosed = false;
  let controlFd;
  let controlClosed = false;
  let controlUnlinked = false;
  let boundaryFd;
  let boundaryClosed = false;
  let boundaryUnlinked = false;
  const closeStates = Object.fromEntries(
    [
      "readyAnchor",
      "releaseAnchor",
      "readyRead",
      "readyWrite",
      "releaseRead",
      "releaseWrite",
    ].map((name) => [
      name,
      { attempted: false, result: "not_attempted" },
    ]),
  );
  const closeEndpoint = (name, fd) => {
    const state = closeStates[name];
    if (state.attempted) return;
    state.attempted = true;
    try {
      closeSync(fd);
      state.result = "closed";
    } catch (error) {
      state.result = Object.freeze({
        status: "failed",
        code: error?.code ?? "close_failed",
      });
      throw error;
    }
  };
  const audit = {
    claimAttempts: 0,
    rejectedEvidence: 0,
    rejectedPolicies: 0,
    rejectedFourthHookCases: 0,
    releaseWrites: 0,
    releaseCloses: 0,
    reapStarts: 0,
    barrierStops: 0,
    claimSetupFailures: 0,
  };
  const phase = createOrphanCleanupState();
  const boundary = createBoundaryController(boundarySchedule, phase, audit);
  phase.boundary = boundary;
  let adoptedRecord;
  let completed;
  try {
    const created = spawnSync(
      mkfifo.path,
      ["--mode=0600", "--", readyPath, releasePath],
      {
        env: freshEnvironment({
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          LANG: "C",
          TZ: "UTC",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (
      created.error ||
      created.status !== 0 ||
      hashFile(mkfifo.path) !== mkfifo.hash
    ) {
      fail("canonical mkfifo invocation failed");
    }
    const readyStatus = lstatSync(readyPath);
    const releaseStatus = lstatSync(releasePath);
    if (
      !readyStatus.isFIFO() ||
      !releaseStatus.isFIFO() ||
      readyStatus.uid !== process.getuid() ||
      releaseStatus.uid !== process.getuid() ||
      (readyStatus.mode & 0o7777) !== 0o600 ||
      (releaseStatus.mode & 0o7777) !== 0o600 ||
      readyStatus.nlink !== 1 ||
      releaseStatus.nlink !== 1 ||
      (readyStatus.dev === releaseStatus.dev &&
        readyStatus.ino === releaseStatus.ino)
    ) {
      fail("private FIFO identity is invalid");
    }
    const openBound = (path, flags, expected) => {
      const fd = openSync(path, flags);
      const actual = fstatSync(fd);
      if (
        !actual.isFIFO() ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        actual.uid !== expected.uid ||
        actual.mode !== expected.mode ||
        actual.nlink !== expected.nlink
      ) {
        closeSync(fd);
        fail("FIFO descriptor binding changed");
      }
      return fd;
    };
    readyAnchor = openBound(
      readyPath,
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      readyStatus,
    );
    releaseAnchor = openBound(
      releasePath,
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      releaseStatus,
    );
    readyRead = openBound(
      readyPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
      readyStatus,
    );
    readyWrite = openBound(
      readyPath,
      constants.O_WRONLY | constants.O_NOFOLLOW,
      readyStatus,
    );
    releaseRead = openBound(
      releasePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
      releaseStatus,
    );
    releaseWrite = openBound(
      releasePath,
      constants.O_WRONLY | constants.O_NOFOLLOW,
      releaseStatus,
    );
    closeEndpoint("readyAnchor", readyAnchor);
    readyAnchorClosed = true;
    closeEndpoint("releaseAnchor", releaseAnchor);
    releaseAnchorClosed = true;
    const controlBytes =
      `${fixtureControlPrefix}${String(controlVariant).padStart(2, "0")}\n`;
    writeFileSync(controlPath, controlBytes, { flag: "wx", mode: 0o600 });
    const controlStatus = lstatSync(controlPath);
    controlFd = openSync(
      controlPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const boundControl = fstatSync(controlFd);
    if (
      !controlStatus.isFile() ||
      controlStatus.uid !== process.getuid() ||
      (controlStatus.mode & 0o7777) !== 0o600 ||
      controlStatus.nlink !== 1 ||
      boundControl.dev !== controlStatus.dev ||
      boundControl.ino !== controlStatus.ino ||
      readFileSync(controlFd, "ascii") !== controlBytes
    ) {
      fail("private fixture control identity is invalid");
    }
    unlinkSync(controlPath);
    controlUnlinked = true;
    if (fstatSync(controlFd).nlink !== 0) {
      fail("private fixture control remained linked");
    }
    const boundaryBytes = `${boundaryControlPrefix}${boundarySchedule}\n`;
    writeFileSync(boundaryPath, boundaryBytes, { flag: "wx", mode: 0o600 });
    const boundaryStatus = lstatSync(boundaryPath);
    boundaryFd = openSync(
      boundaryPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const boundBoundary = fstatSync(boundaryFd);
    if (
      !boundaryStatus.isFile() ||
      boundaryStatus.uid !== process.getuid() ||
      (boundaryStatus.mode & 0o7777) !== 0o600 ||
      boundaryStatus.nlink !== 1 ||
      boundBoundary.dev !== boundaryStatus.dev ||
      boundBoundary.ino !== boundaryStatus.ino ||
      readFileSync(boundaryFd, "ascii") !== boundaryBytes
    ) {
      fail("private boundary control identity is invalid");
    }
    unlinkSync(boundaryPath);
    boundaryUnlinked = true;
    if (fstatSync(boundaryFd).nlink !== 0) {
      fail("private boundary control remained linked");
    }
    unlinkSync(readyPath);
    readyUnlinked = true;
    unlinkSync(releasePath);
    releaseUnlinked = true;
    rmdirSync(root);
    rootRemoved = true;
    completed = await withAcquiredBuildLockAsync(
      async (heldLockFd, lockIdentity, closeRunnerLock) => {
        const environment = freshEnvironment({
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          LANG: "C",
          TZ: "UTC",
          ATOMIC_BUILD_LOCK_FD: "9",
          ATOMIC_BUILD_LOCK_FIXTURE_ROLE: "driver",
          ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID: String(process.pid),
          ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME:
            procStat(process.pid).starttime,
        });
        const driver = spawn(
          realpathSync(process.execPath),
          [realpathSync(fixturePath)],
          {
            cwd: packageRoot,
            env: environment,
            stdio: fixtureStdio(
              inputFd,
              readyWrite,
              releaseRead,
              addonFd,
              controlFd,
              boundaryFd,
              heldLockFd,
            ),
          },
        );
        closeSync(inputFd);
        inputClosed = true;
        closeSync(controlFd);
        controlClosed = true;
        closeSync(boundaryFd);
        boundaryClosed = true;
        closeEndpoint("readyWrite", readyWrite);
        readyWriteClosed = true;
        closeEndpoint("releaseRead", releaseRead);
        releaseReadClosed = true;
        const driverExit = waitForChild(driver);
        let contentionProved = false;
        const effects = createOrphanCleanupEffects(Object.freeze({
          async prepareClaim() {
            const record = readReadyRecord(readyRead);
            adoptedRecord = record;
            boundary?.hit("ready");
            closeEndpoint("readyRead", readyRead);
            readyReadClosed = true;
            assertLiveReadyRecord(
              record,
              driver,
              faultName,
              boundarySchedule,
            );
            if (!driver.kill("SIGKILL")) {
              fail("controlled driver SIGKILL failed");
            }
            const exit = await driverExit;
            if (exit.signal !== "SIGKILL") {
              fail("controlled driver exit was not SIGKILL");
            }
            boundary?.hit("driver-exit");
            closeRunnerLock();
            try {
              fstatSync(heldLockFd);
              fail("runner lock duplicate remained open");
            } catch (error) {
              if (error?.code !== "EBADF") throw error;
            }
            await waitForAdoption(record);
            boundary?.hit("adoption");
            const parent = procStat(process.pid);
            const evidence = Object.freeze({
              role: record.role,
              pid: record.pid,
              starttime: record.starttime,
              nodeExecutableRealpath: record.nodeExecutableRealpath,
              nodeExecutableSha256: record.nodeExecutableSha256,
              scriptRealpath: record.scriptRealpath,
              scriptSha256: record.scriptSha256,
              fd9Device: record.fd9Device,
              fd9Inode: record.fd9Inode,
              fd9Uid: record.fd9Uid,
              fd9Mode: record.fd9Mode,
              fd9Nlink: record.fd9Nlink,
              adoptiveParentPid: process.pid,
              adoptiveParentStarttime: parent.starttime,
            });
            const hiddenEvidence = { ...evidence };
            Object.defineProperty(hiddenEvidence, "hidden", {
              value: 1,
              enumerable: false,
            });
            const claimNegativeCases = [
              ["nodeExecutableSha256", {
                ...evidence,
                nodeExecutableSha256: "0".repeat(64),
              }],
              ["scriptSha256", {
                ...evidence,
                scriptSha256: "0".repeat(64),
              }],
              ["fd9Inode", { ...evidence, fd9Inode: "0" }],
              ["fd9Uid", { ...evidence, fd9Uid: record.fd9Uid + 1 }],
              ["fd9Mode", { ...evidence, fd9Mode: 0o640 }],
              ["fd9Nlink", { ...evidence, fd9Nlink: 2 }],
              ["adoptiveParentStarttime", {
                ...evidence,
                adoptiveParentStarttime: "0",
              }],
              ["hidden-key", hiddenEvidence],
              ["symbol-key", { ...evidence, [Symbol("extra")]: 1 }],
              ["nul-suffix", {
                ...evidence,
                role: `${evidence.role}\0suffix`,
              }],
              ["pid-wrap", { ...evidence, pid: 2 ** 32 + record.pid }],
              ["pid-nan", { ...evidence, pid: Number.NaN }],
              ["pid-infinity", {
                ...evidence,
                pid: Number.POSITIVE_INFINITY,
              }],
              ["pid-fraction", { ...evidence, pid: record.pid + 0.5 }],
              ["pid-range", {
                ...evidence,
                pid: Number.MAX_SAFE_INTEGER,
              }],
              ["parent-wrap", {
                ...evidence,
                adoptiveParentPid: 2 ** 32 + process.pid,
              }],
              ["uid-wrap", {
                ...evidence,
                fd9Uid: 2 ** 32 + record.fd9Uid,
              }],
            ];
            for (const [name, candidate] of claimNegativeCases) {
              let rejected = false;
              try {
                native.testHooks.claimAdoptedChildForTest(candidate);
              } catch {
                rejected = true;
              }
              if (!rejected) {
                fail(`mismatched claim evidence was accepted: ${name}`);
              }
              audit.rejectedEvidence++;
            }
            boundary?.hit("evidence");
            return evidence;
          },
          claim(evidence) {
            audit.claimAttempts++;
            const validateClaim = (handle) => {
              let duplicateRejected = false;
              try {
                claimNative.testHooks.claimAdoptedChildForTest(evidence);
              } catch {
                duplicateRejected = true;
              }
              if (!duplicateRejected) {
                fail("duplicate child claim was accepted");
              }
              const fourthHookNegativeCases = [
                () => claimNative.testHooks.reapClaimedChildForTest(),
                () => claimNative.testHooks.reapClaimedChildForTest(handle),
                () =>
                  claimNative.testHooks.reapClaimedChildForTest(
                    handle,
                    phase.policy,
                    phase.policy,
                  ),
                () =>
                  claimNative.testHooks.reapClaimedChildForTest({}, phase.policy),
                () =>
                  claimNative.testHooks.reapClaimedChildForTest(
                    null,
                    phase.policy,
                  ),
                () =>
                  claimNative.testHooks.reapClaimedChildForTest(handle, null),
                () =>
                  claimNative.testHooks.reapClaimedChildForTest(handle, {
                    ...phase.policy,
                    extra: 1,
                  }),
                () => {
                  const hidden = { ...phase.policy };
                  Object.defineProperty(hidden, "hidden", {
                    value: 1,
                    enumerable: false,
                  });
                  return claimNative.testHooks.reapClaimedChildForTest(
                    handle,
                    hidden,
                  );
                },
                () =>
                  claimNative.testHooks.reapClaimedChildForTest(handle, {
                    ...phase.policy,
                    [Symbol("extra")]: 1,
                  }),
                ...[
                  { ...phase.policy, gracefulTimeoutMs: 1999 },
                  { ...phase.policy, termTimeoutMs: 999 },
                  { ...phase.policy, killTimeoutMs: 999 },
                  { ...phase.policy, gracefulTimeoutMs: "2000" },
                  { ...phase.policy, termTimeoutMs: 0 },
                  { ...phase.policy, killTimeoutMs: -1 },
                  {
                    ...phase.policy,
                    gracefulTimeoutMs: 2 ** 32 + 2000,
                  },
                  { ...phase.policy, gracefulTimeoutMs: Number.NaN },
                  {
                    ...phase.policy,
                    gracefulTimeoutMs: Number.POSITIVE_INFINITY,
                  },
                  { ...phase.policy, gracefulTimeoutMs: 2000.5 },
                  {
                    ...phase.policy,
                    gracefulTimeoutMs: Number.MAX_SAFE_INTEGER,
                  },
                ].map(
                  (candidate) => () =>
                    claimNative.testHooks.reapClaimedChildForTest(
                      handle,
                      candidate,
                    ),
                ),
              ];
              for (const invoke of fourthHookNegativeCases) {
                let rejected = false;
                try {
                  invoke();
                } catch {
                  rejected = true;
                }
                if (!rejected) {
                  fail("invalid fourth-hook boundary was accepted");
                }
                audit.rejectedPolicies++;
                audit.rejectedFourthHookCases++;
              }
              return handle;
            };
            try {
              return validateClaim(
                native.testHooks.claimAdoptedChildForTest(evidence),
              );
            } catch (error) {
              if (!claimSetupFaults.has(faultName)) throw error;
              if (!(error?.setupCompletion instanceof Promise)) {
                if (
                  ![
                    "settlement-owner-init",
                    "settlement-owner-start",
                    "settlement-owner-ref",
                  ].includes(faultName)
                ) {
                  fail(`claim setup completion is invalid: ${faultName}`);
                }
                audit.claimSetupFailures++;
                audit.claimAttempts++;
                claimNative = recoveryNative;
                return validateClaim(
                  claimNative.testHooks.claimAdoptedChildForTest(evidence),
                );
              }
              audit.claimSetupFailures++;
              return error.setupCompletion
                .then((setupState) =>
                  waitForClaimSetupCompletion(setupState)
                )
                .then((setupFinal) => {
                  if (!Object.isFrozen(setupFinal)) {
                    fail(`claim setup completion is mutable: ${faultName}`);
                  }
                  audit.claimSetupFinal = setupFinal;
                  audit.claimAttempts++;
                  claimNative = recoveryNative;
                  return validateClaim(
                    claimNative.testHooks.claimAdoptedChildForTest(evidence),
                  );
                });
            }
          },
          writeRelease() {
            if (!contentionProved) {
              const contender = openSync(
                lockPath,
                constants.O_RDWR | constants.O_NOFOLLOW,
              );
              try {
                const blocked = spawnSync(
                  "/usr/bin/flock",
                  ["--exclusive", "--nonblock", "9"],
                  { stdio: exactStdio(contender, "pipe", "pipe") },
                );
                if (blocked.status === 0) {
                  fail("claimed descendant did not retain build lock");
                }
              } finally {
                closeSync(contender);
              }
              contentionProved = true;
              boundary?.hit("contention");
            }
            boundary?.hit("release-write-attempt");
            if (faultName === "pidfd-signal") {
              const identity = procStat(adoptedRecord.pid);
              if (
                identity.parent !== process.pid ||
                identity.starttime !== adoptedRecord.starttime
              ) {
                fail("signal fault exact PID identity changed before barrier");
              }
              process.kill(adoptedRecord.pid, "SIGSTOP");
              audit.barrierStops++;
            }
            audit.releaseWrites++;
            boundary?.hit("release-write-syscall");
            return writeSync(releaseWrite, Buffer.from([1]));
          },
          closeRelease() {
            audit.releaseCloses++;
            boundary?.hit("close-syscall");
            if (boundarySchedule === "close-result") {
              closeSync(releaseWrite);
              releaseWriteClosed = true;
            }
            closeEndpoint("releaseWrite", releaseWrite);
            releaseWriteClosed = true;
          },
          reap(handle, policy) {
            audit.reapStarts++;
            return claimNative.testHooks.reapClaimedChildForTest(handle, policy);
          },
        }));
        boundary?.bind(effects);
        let heartbeatTicks = 0;
        let cleanupFinal;
        let lifecycleFinal;
        const heartbeat = setInterval(() => heartbeatTicks++, 5);
        if (faultName === "post-kill-timeout") heartbeat.unref();
        let transaction;
        let boundaryFinal;
        try {
          transaction = dispatchOrphanCleanup(phase, effects);
          await transaction;
          if (!reapFailureVariants.has(faultName)) {
            await dispatchOrphanCleanup(phase, effects);
            if (
              phase.claimState !== "reaped" ||
              phase.reapError !== undefined
            ) {
              throw phase.claimError ?? phase.reapError ??
                new Error("orphan cleanup did not reach reaped");
            }
            const same = claimNative.testHooks.reapClaimedChildForTest(
              phase.handle,
              phase.policy,
            );
            if (same !== phase.reapPromise) {
              fail("settled native reap Promise identity changed");
            }
            const expectedResult =
              boundarySchedule === "release-write-result"
                ? { kind: "signal", signal: 15 }
                : faultName === "none" || faultName === "phase-graceful"
                ? { kind: "exit", code: 0 }
                : faultName === "phase-kill"
                  ? { kind: "signal", signal: 9 }
                  : { kind: "signal", signal: 15 };
            if (
              Object.entries(expectedResult).some(
                ([key, value]) => phase.reapResult?.[key] !== value,
              )
            ) {
              fail(`claimed descendant result is invalid: ${faultName}`);
            }
          } else {
            if (adoptedRecord === undefined || phase.reapError === undefined) {
              fail(`fault variant did not reject native reap: ${faultName}`);
            }
            const cleanupPromise =
              phase.reapError.nativeAudit?.cleanupComplete;
            if (
              faultName !== "napi-promise" &&
              (!(cleanupPromise instanceof Promise) ||
                phase.reapError.nativeAudit.cleanupComplete !== cleanupPromise)
            ) {
              fail(`fault variant cleanup Promise is invalid: ${faultName}`);
            }
            if (cleanupPromise instanceof Promise) {
              cleanupFinal = await cleanupPromise;
            }
            await waitForExactPidGone(adoptedRecord);
            await new Promise((resolvePromise) => setImmediate(resolvePromise));
            if (heartbeatTicks === 0) {
              fail(`fault variant blocked the event loop: ${faultName}`);
            }
            if (
              phase.reapPromise !== undefined &&
              faultName !== "napi-reference"
            ) {
              const same = claimNative.testHooks.reapClaimedChildForTest(
                phase.handle,
                phase.policy,
              );
              if (same !== phase.reapPromise) {
                fail(`fault variant Promise identity changed: ${faultName}`);
              }
            } else {
              let repeatedRejected = false;
              try {
                claimNative.testHooks.reapClaimedChildForTest(
                  phase.handle,
                  phase.policy,
                );
              } catch {
                repeatedRejected = true;
              }
              if (!repeatedRejected) {
                fail(`${faultName} fault was not terminal`);
              }
            }
          }
          const nativeAudit =
            phase.reapError?.nativeAudit ?? phase.reapResult?.nativeAudit;
          if (nativeAudit !== undefined) {
            const cleanupPromise = nativeAudit.cleanupComplete;
            if (
              !(cleanupPromise instanceof Promise) ||
              nativeAudit.cleanupComplete !== cleanupPromise
            ) {
              fail(`native cleanup Promise is invalid: ${faultName}`);
            }
            cleanupFinal ??= await cleanupPromise;
          }
          boundaryFinal = boundary?.finish(transaction);
        } finally {
          clearInterval(heartbeat);
        }
        const phaseSummary = Object.freeze({
          claimState: phase.claimState,
          claimAttempted: phase.claimAttempted,
          releaseState: phase.releaseState,
          releaseWriteAttempted: phase.releaseWriteAttempted,
          releaseWriteResult: phase.releaseWriteResult,
          releaseWriterCloseAttempted: phase.releaseWriterCloseAttempted,
          releaseWriterCloseResult: phase.releaseWriterCloseResult,
          reapState: phase.reapState,
          reapAttempted: phase.reapAttempted,
        });
        const nativeAudit =
          phase.reapError?.nativeAudit ?? phase.reapResult?.nativeAudit;
        const lifecyclePromise = nativeAudit?.lifecycleComplete;
        const settlementOwnerCloseState =
          nativeAudit?.settlementOwnerCloseState;
        if (
          nativeAudit !== undefined &&
          (!(lifecyclePromise instanceof Promise) ||
            nativeAudit.lifecycleComplete !== lifecyclePromise ||
            !(settlementOwnerCloseState instanceof Uint32Array) ||
            nativeAudit.settlementOwnerCloseState !==
              settlementOwnerCloseState)
        ) {
          fail(`native lifecycle Promise is invalid: ${faultName}`);
        }
        phase.handle = undefined;
        phase.claimEvidence = undefined;
        phase.reapPromise = undefined;
        globalThis.gc();
        if (lifecyclePromise instanceof Promise) {
          const gcPump = setInterval(() => globalThis.gc(), 5);
          gcPump.unref();
          try {
            const lifecycleCounters = await lifecyclePromise;
            const closeCounters = await waitForSettlementOwnerClose(
              settlementOwnerCloseState,
            );
            lifecycleFinal = Object.freeze({
              ...lifecycleCounters,
              ...closeCounters,
            });
          } finally {
            clearInterval(gcPump);
          }
        }
        return {
          result: phase.reapResult,
          fault: faultName,
          error:
            phase.reapError === undefined
              ? undefined
              : {
                  category: phase.reapError.category,
                  cleanup: phase.reapError.cleanup,
                  errno: phase.reapError.errno,
                  code: phase.reapError.code,
                  message: phase.reapError.message,
                  nativeAudit: phase.reapError.nativeAudit,
                  cleanupFinal,
                  lifecycleFinal,
                },
          exactPidGone:
            faultName === "none" && boundarySchedule === "none"
              ? undefined
              : adoptedRecord !== undefined,
          heartbeatTicks,
          fixtureControlVariant: adoptedRecord?.fixtureControlVariant,
          prepareNegativeCases: adoptedRecord?.prepareNegativeCases,
          isolatedPrepareCases: adoptedRecord?.isolatedPrepareCases,
          wrongUidProbeSkipped: adoptedRecord?.wrongUidProbeSkipped,
          cleanupFinal,
          lifecycleFinal,
          audit,
          phase: phaseSummary,
          boundary: boundaryFinal,
          lockDevice: String(lockIdentity.dev),
        };
      },
    );
  } finally {
    if (readyAnchor !== undefined && !readyAnchorClosed) {
      closeEndpoint("readyAnchor", readyAnchor);
    }
    if (releaseAnchor !== undefined && !releaseAnchorClosed) {
      closeEndpoint("releaseAnchor", releaseAnchor);
    }
    if (readyRead !== undefined && !readyReadClosed) {
      closeEndpoint("readyRead", readyRead);
    }
    if (readyWrite !== undefined && !readyWriteClosed) {
      closeEndpoint("readyWrite", readyWrite);
    }
    if (releaseRead !== undefined && !releaseReadClosed) {
      closeEndpoint("releaseRead", releaseRead);
    }
    if (
      releaseWrite !== undefined &&
      !releaseWriteClosed &&
      phase.claimState !== "unclaimed"
    ) {
      closeEndpoint("releaseWrite", releaseWrite);
    }
    if (!readyUnlinked) {
      try {
        unlinkSync(readyPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!releaseUnlinked) {
      try {
        unlinkSync(releasePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!controlUnlinked) {
      try {
        unlinkSync(controlPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!boundaryUnlinked) {
      try {
        unlinkSync(boundaryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!rootRemoved) {
      try {
        rmdirSync(root);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!addonClosed && !retainedTestAddonFds.has(addonFd)) {
      closeSync(addonFd);
      addonClosed = true;
    }
    if (!inputClosed) {
      closeSync(inputFd);
      inputClosed = true;
    }
    if (controlFd !== undefined && !controlClosed) {
      closeSync(controlFd);
      controlClosed = true;
    }
    if (boundaryFd !== undefined && !boundaryClosed) {
      closeSync(boundaryFd);
      boundaryClosed = true;
    }
  }
  return Object.freeze(completed);
}

export async function runNativeBuildOrphanFixtureForTest() {
  if (
    process.env.VITEST !== "true" ||
    resolve(process.argv[1] ?? "") !==
      resolve(packageRoot, "scripts/run-native-build.test.mjs") ||
    realpathSync(runnerPath) !== runnerPath
  ) {
    fail("orphan fixture seam is unavailable");
  }
  assertSafeInheritedEnvironment();
  const addonCacheDriftRejected =
    runHeldTestAddonCacheDriftRegression();
  const headerTrustMatrix = runNodeHeaderTrustMatrixForTest();
  const compiled = withAcquiredBuildLock((heldLockFd) =>
    compileFaultVariantAddons(heldLockFd),
  );
  try {
    const fixture = await runOneNativeBuildOrphanFixture(
      resolve(
        packageRoot,
        "build/Test/atomic_directory_publication_test.node",
      ),
      "none",
    );
    const faultVariants = [];
    for (const variant of compiled.artifacts) {
      faultVariants.push(
        await runOneNativeBuildOrphanFixture(variant.path, variant.name),
      );
    }
    const boundaryMatrix = [];
    for (const schedule of orphanBoundarySchedules) {
      boundaryMatrix.push(
        await runOneNativeBuildOrphanFixture(
          resolve(
            packageRoot,
            "build/Test/atomic_directory_publication_test.node",
          ),
          "none",
          schedule,
        ),
      );
    }
    return Object.freeze({
      fixture,
      addonCacheDriftRejected,
      headerTrustMatrix,
      faultVariants: Object.freeze(faultVariants),
      boundaryMatrix: Object.freeze(boundaryMatrix),
      faultBuild: Object.freeze({
        compiler: compiled.compiler,
        compilerHash: compiled.compilerHash,
        headerHashes: compiled.headerHashes,
        sourceHashes: compiled.sourceHashes,
      }),
      lockMatrix: await runLockFailureMatrixForTest(),
    });
  } finally {
    try {
      closeRetainedTestAddons();
    } finally {
      compiled.cleanup();
    }
  }
}

function main() {
  assertRuntime();
  assertSafeInheritedEnvironment();
  if (process.argv.length !== 3) {
    fail("expected exactly one target");
  }
  const target = process.argv[2];
  if (target !== "production" && target !== "all") {
    fail("target must be production or all");
  }
  runProduction(target);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
