import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import * as contract from "./gate-contract.mjs";
import * as codexExecutable from "./codex-executable.mjs";
import * as decisionWire from "./decision-wire.mjs";
import * as orchestration from "./gate-orchestration.mjs";
import * as lifecycle from "./lifecycle.mjs";
import * as protocol from "./app-server-protocol.mjs";
import * as preflight from "./preflight.mjs";

const { gateError, hashFeatureInventory } = contract;
const {
  normalizeModelDecisionEnvelopeV1,
  normalizedProposalHash,
  parseModelDecisionEnvelopeV1,
  runDecisionWireSelfTest,
} = decisionWire;
const {
  combinePrimaryAndCleanup,
  ProcessDeadline,
  surfaceCleanupFailures,
} = lifecycle;
const { parseInvocation, runPreflight } = preflight;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const gatePath = fileURLToPath(new URL("./run.mjs", import.meta.url));
const productionSourcePaths = [
  "action-store.mjs",
  "app-server-protocol.mjs",
  "codex-executable.mjs",
  "decision-wire.mjs",
  "gate-contract.mjs",
  "gate-orchestration.mjs",
  "lifecycle.mjs",
  "preflight.mjs",
  "run.mjs",
  "schema-canonicalizer.mjs",
];
const productionSources = Object.fromEntries(
  productionSourcePaths.map(name => [
    name,
    readFileSync(new URL(name, import.meta.url), "utf8"),
  ]),
);
const runSource = productionSources["run.mjs"];

function readLinuxProcessTable() {
  if (process.platform !== "linux") return [];
  const processes = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.push({
        pid: Number(entry.name),
        state: fields[0],
        parentPid: Number(fields[1]),
        processGroup: Number(fields[2]),
        session: Number(fields[3]),
        startTime: fields[19],
      });
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
  }
  return processes;
}

function readLinuxProcessIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      state: fields[0],
      parentPid: Number(fields[1]),
      processGroup: Number(fields[2]),
      session: Number(fields[3]),
      startTime: fields[19],
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

function snapshotLinuxProcessTree(rootPid) {
  if (process.platform !== "linux" || !Number.isInteger(rootPid)) {
    return { root: null, descendants: [] };
  }
  const processes = readLinuxProcessTable();
  const ownProcessGroup = processes.find(item => item.pid === process.pid)
    ?.processGroup;
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (descendants.has(item.pid) || !descendants.has(item.parentPid)) {
        continue;
      }
      descendants.add(item.pid);
      changed = true;
    }
  }
  return {
    root: processes.find(item => item.pid === rootPid) ?? null,
    descendants: processes.filter(
      item =>
        item.pid !== rootPid &&
        descendants.has(item.pid) &&
        item.processGroup > 0 &&
        item.processGroup !== ownProcessGroup,
    ),
  };
}

function killLinuxProcessGroup(processGroup, signal) {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sameProcessIdentity(left, right) {
  return (
    left != null &&
    right != null &&
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.session === right.session &&
    left.processGroup === right.processGroup &&
    right.state !== "Z" &&
    right.state !== "X"
  );
}

async function waitForShutdown(shutdownComplete, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (!shutdownComplete()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await wait(Math.min(pollMs, remaining));
  }
  return true;
}

function superviseGateChild(
  child,
  {
    timeoutMs,
    maxOutputBytes,
    termGraceMs,
    killGraceMs,
    pollMs,
    snapshotProcessTree = snapshotLinuxProcessTree,
    readProcessIdentity = readLinuxProcessIdentity,
    killProcessGroup = killLinuxProcessGroup,
    onCleanupStart = () => {},
  },
) {
  let childIdentityAnchor;
  let childIdentityCaptureFailure;
  try {
    childIdentityAnchor = readProcessIdentity(child.pid);
    if (!childIdentityAnchor) {
      childIdentityCaptureFailure = new Error("child identity missing");
    }
  } catch (error) {
    childIdentityCaptureFailure = error;
  }
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let closed = false;
    let settling = false;
    let settled = false;
    let recordSettlingChildError;
    let timer;

    const removeListeners = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListeners();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = async reason => {
      if (settling || settled) return;
      settling = true;
      clearTimeout(timer);
      const cleanupErrors = [];
      const unprobeableIdentities = new Set();
      let rootReplacementRecorded = false;
      const cleanupError = (code, cause, detail) => {
        const error = new Error(detail ? `${code}: ${detail}` : code, {
          cause,
        });
        error.code = code;
        cleanupErrors.push(error);
      };
      recordSettlingChildError = error => {
        cleanupError("gate_characterization_child_error", error);
      };
      if (childIdentityCaptureFailure) {
        cleanupError(
          "gate_characterization_child_identity_capture_failed",
          childIdentityCaptureFailure,
        );
      }
      try {
        onCleanupStart();
      } catch (error) {
        cleanupError("gate_characterization_cleanup_start_failed", error);
      }
      const recordRootReplacement = cause => {
        if (rootReplacementRecorded) return;
        rootReplacementRecorded = true;
        cleanupError("gate_characterization_root_replaced", cause);
      };
      const snapshot = phase => {
        try {
          const tree = snapshotProcessTree(child.pid);
          if (!sameProcessIdentity(childIdentityAnchor, tree.root)) {
            recordRootReplacement();
            return { root: null, descendants: [] };
          }
          return tree;
        } catch (error) {
          cleanupError(
            phase === "initial"
              ? "gate_characterization_initial_snapshot_failed"
              : "gate_characterization_escalation_snapshot_failed",
            error,
          );
          return { root: null, descendants: [] };
        }
      };
      const identityKey = identity =>
        `${identity.pid}:${identity.startTime}:${identity.session}:${identity.processGroup}`;
      const probeIdentity = (identity, kind = "descendant") => {
        if (!identity) return "unknown";
        const key = identityKey(identity);
        if (unprobeableIdentities.has(key)) return "unknown";
        try {
          return sameProcessIdentity(
            identity,
            readProcessIdentity(identity.pid),
          )
            ? "alive"
            : "gone";
        } catch (error) {
          unprobeableIdentities.add(key);
          cleanupError(
            kind === "direct"
              ? "gate_characterization_child_probe_failed"
              : "gate_characterization_descendant_probe_failed",
            error,
            String(identity.pid),
          );
          return "unknown";
        }
      };
      const descendants = new Map();
      const mergeSnapshot = tree => {
        for (const identity of tree.descendants) {
          descendants.set(identityKey(identity), identity);
        }
      };
      const groupedDescendants = () => {
        const groups = new Map();
        for (const identity of descendants.values()) {
          const group = groups.get(identity.processGroup) ?? [];
          group.push(identity);
          groups.set(identity.processGroup, group);
        }
        return [...groups]
          .map(([processGroup, identities]) => [
            processGroup,
            identities.toSorted((left, right) => left.pid - right.pid),
          ])
          .toSorted(([left], [right]) => left - right);
      };
      const descendantsGone = () =>
        [...descendants.values()].every(
          identity => probeIdentity(identity) === "gone",
        );
      const signalChild = signal => {
        if (probeIdentity(childIdentityAnchor, "direct") !== "alive") {
          recordRootReplacement();
          return;
        }
        try {
          const delivered = child.kill(signal);
          if (delivered === false) {
            cleanupError(
              signal === "SIGTERM"
                ? "gate_characterization_child_term_failed"
                : "gate_characterization_child_kill_failed",
              undefined,
              "signal returned false",
            );
          }
        } catch (error) {
          cleanupError(
            signal === "SIGTERM"
              ? "gate_characterization_child_term_failed"
              : "gate_characterization_child_kill_failed",
            error,
          );
        }
      };

      mergeSnapshot(snapshot("initial"));
      if (!closed) signalChild("SIGTERM");
      const shutdownComplete = () => closed && descendantsGone();
      const terminated = await waitForShutdown(
        shutdownComplete,
        termGraceMs,
        pollMs,
      );
      if (!terminated) {
        mergeSnapshot(snapshot("escalation"));
        if (!closed) signalChild("SIGKILL");
        for (const [processGroup, identities] of groupedDescendants()) {
          if (!identities.some(identity => probeIdentity(identity) === "alive")) {
            continue;
          }
          try {
            killProcessGroup(processGroup, "SIGKILL");
          } catch (error) {
            cleanupError(
              "gate_characterization_descendant_kill_failed",
              error,
              String(processGroup),
            );
          }
        }
        await waitForShutdown(shutdownComplete, killGraceMs, pollMs);
      }
      if (!closed) {
        cleanupError("gate_characterization_child_close_timeout");
      }
      for (const [processGroup, identities] of groupedDescendants()) {
        if (identities.some(identity => probeIdentity(identity) !== "gone")) {
          cleanupError(
            "gate_characterization_descendant_survived",
            undefined,
            String(processGroup),
          );
        }
      }
      if (cleanupErrors.length === 0) {
        finish(reason);
        return;
      }
      const aggregate = new AggregateError(
        [reason, ...cleanupErrors],
        `${reason.message}: gate_characterization_cleanup_failed`,
      );
      aggregate.code = "gate_characterization_cleanup_failed";
      finish(aggregate);
    };
    const beginTermination = reason => {
      void terminate(reason).catch(error => {
        const cleanupFailure = new Error(
          "gate_characterization_unexpected_cleanup_failure",
          { cause: error },
        );
        cleanupFailure.code =
          "gate_characterization_unexpected_cleanup_failure";
        const aggregate = new AggregateError(
          [reason, cleanupFailure],
          `${reason.message}: gate_characterization_cleanup_failed`,
        );
        aggregate.code = "gate_characterization_cleanup_failed";
        finish(aggregate);
      });
    };
    const capture = target => chunk => {
      if (settling || settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        beginTermination(new Error("gate_characterization_output_limit"));
        return;
      }
      target.push(chunk);
    };
    const onStdout = capture(stdout);
    const onStderr = capture(stderr);
    const onError = error => {
      if (settled) return;
      if (settling) {
        recordSettlingChildError?.(error);
        return;
      }
      finish(error);
    };
    const onClose = (code, signal) => {
      closed = true;
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (!settling) finish(null, result);
    };

    timer = setTimeout(() => {
      beginTermination(new Error("gate_characterization_timeout"));
    }, timeoutMs);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

function invokeGate(args) {
  const child = spawn(process.execPath, [gatePath, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return superviseGateChild(child, {
    timeoutMs: 20_000,
    maxOutputBytes: contract.MAX_OUTPUT_BYTES,
    termGraceMs:
      contract.CLEANUP_TOTAL_GRACE_MS + contract.CLEANUP_DRAIN_GRACE_MS,
    killGraceMs: contract.CLEANUP_KILL_GRACE_MS,
    pollMs: contract.CLEANUP_POLL_MS,
  });
}

function fakeCharacterizationChild(onKill) {
  const child = new EventEmitter();
  child.pid = 800;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = signal => {
    return onKill(signal, child) ?? true;
  };
  return child;
}

const processIdentity = ({
  pid,
  parentPid = 800,
  processGroup,
  session = processGroup,
  startTime = String(pid * 10),
  state = "S",
}) => ({ pid, parentPid, processGroup, session, startTime, state });

const fakeRootIdentity = processIdentity({
  pid: 800,
  parentPid: process.pid,
  processGroup: 800,
  startTime: "fake-root",
});
const identityTree = identities => ({
  root: fakeRootIdentity,
  descendants: identities,
});
const fakeIdentityReader = readDescendant => pid =>
  pid === fakeRootIdentity.pid ? fakeRootIdentity : readDescendant(pid);

const timeoutEvents = [];
const aliveDescendantGroups = new Set([901]);
const timeoutIdentity = processIdentity({ pid: 9011, processGroup: 901 });
const timeoutChild = fakeCharacterizationChild((signal, child) => {
  timeoutEvents.push(signal);
  if (signal === "SIGKILL") {
    queueMicrotask(() => {
      timeoutEvents.push("close");
      child.emit("close", null, "SIGKILL");
    });
  }
});
await assert.rejects(
  superviseGateChild(timeoutChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 20,
    pollMs: 1,
    snapshotProcessTree: () => identityTree([timeoutIdentity]),
    readProcessIdentity: fakeIdentityReader(pid =>
      pid === timeoutIdentity.pid && aliveDescendantGroups.has(901)
        ? timeoutIdentity
        : null,
    ),
    killProcessGroup(group, signal) {
      timeoutEvents.push(`group:${group}:${signal}`);
      if (signal === "SIGKILL") aliveDescendantGroups.delete(group);
    },
  }),
  /gate_characterization_timeout/,
);
timeoutEvents.push("rejected");
assert.deepEqual(timeoutEvents.slice(0, 2), ["SIGTERM", "SIGKILL"]);
assert(timeoutEvents.indexOf("close") < timeoutEvents.indexOf("rejected"));
assert(timeoutEvents.includes("group:901:SIGKILL"));
assert.deepEqual(aliveDescendantGroups, new Set());

const outputEvents = [];
const outputChild = fakeCharacterizationChild((signal, child) => {
  outputEvents.push(signal);
  if (signal === "SIGTERM") {
    queueMicrotask(() => {
      outputEvents.push("close");
      child.emit("close", null, "SIGTERM");
    });
  }
});
const outputResult = superviseGateChild(outputChild, {
  timeoutMs: 1_000,
  maxOutputBytes: 4,
  termGraceMs: 20,
  killGraceMs: 20,
  pollMs: 1,
  snapshotProcessTree: () => identityTree([]),
  readProcessIdentity: fakeIdentityReader(() => null),
  killProcessGroup() {},
});
outputChild.stdout.write(Buffer.alloc(5));
await assert.rejects(outputResult, /gate_characterization_output_limit/);
outputEvents.push("rejected");
assert.deepEqual(outputEvents, ["SIGTERM", "close", "rejected"]);

function assertCleanupFailure(error, primaryMessage, cleanupCodes) {
  assert(error instanceof AggregateError);
  assert.equal(error.code, "gate_characterization_cleanup_failed");
  assert.equal(error.errors[0].message, primaryMessage);
  assert.deepEqual(
    error.errors.slice(1).map(item => item.code),
    cleanupCodes,
  );
  return true;
}

const neverCloseChild = fakeCharacterizationChild(() => {});
await assert.rejects(
  superviseGateChild(neverCloseChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 1,
    pollMs: 1,
    snapshotProcessTree: () => identityTree([]),
    readProcessIdentity: fakeIdentityReader(() => null),
    killProcessGroup() {},
  }),
  error =>
    assertCleanupFailure(error, "gate_characterization_timeout", [
      "gate_characterization_child_close_timeout",
    ]),
);

const survivingGroupChild = fakeCharacterizationChild((signal, child) => {
  if (signal === "SIGKILL") {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  }
});
const survivingIdentity = processIdentity({ pid: 9111, processGroup: 911 });
await assert.rejects(
  superviseGateChild(survivingGroupChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 1,
    pollMs: 1,
    snapshotProcessTree: () => identityTree([survivingIdentity]),
    readProcessIdentity: fakeIdentityReader(pid =>
      pid === survivingIdentity.pid ? survivingIdentity : null,
    ),
    killProcessGroup() {},
  }),
  error =>
    assertCleanupFailure(error, "gate_characterization_timeout", [
      "gate_characterization_descendant_survived",
    ]),
);

let initialSnapshotCalls = 0;
const initialSnapshotChild = fakeCharacterizationChild((signal, child) => {
  if (signal === "SIGTERM") {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
  }
});
await assert.rejects(
  superviseGateChild(initialSnapshotChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 10,
    killGraceMs: 1,
    pollMs: 1,
    snapshotProcessTree() {
      initialSnapshotCalls += 1;
      throw new Error("initial snapshot denied");
    },
    readProcessIdentity: fakeIdentityReader(() => null),
    killProcessGroup() {},
  }),
  error =>
    assertCleanupFailure(error, "gate_characterization_timeout", [
      "gate_characterization_initial_snapshot_failed",
    ]),
);
assert.equal(initialSnapshotCalls, 1);

let escalationSnapshotCalls = 0;
const escalationSnapshotChild = fakeCharacterizationChild((signal, child) => {
  if (signal === "SIGKILL") {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  }
});
const escalationAlive = new Set([921]);
const escalationIdentity = processIdentity({ pid: 9211, processGroup: 921 });
await assert.rejects(
  superviseGateChild(escalationSnapshotChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 10,
    pollMs: 1,
    snapshotProcessTree() {
      escalationSnapshotCalls += 1;
      if (escalationSnapshotCalls === 1) {
        return identityTree([escalationIdentity]);
      }
      throw new Error("escalation snapshot denied");
    },
    readProcessIdentity: fakeIdentityReader(pid =>
      pid === escalationIdentity.pid && escalationAlive.has(921)
        ? escalationIdentity
        : null,
    ),
    killProcessGroup(group) {
      escalationAlive.delete(group);
    },
  }),
  error =>
    assertCleanupFailure(error, "gate_characterization_timeout", [
      "gate_characterization_escalation_snapshot_failed",
    ]),
);
assert.equal(escalationSnapshotCalls, 2);

const probeFailureChild = fakeCharacterizationChild((signal, child) => {
  if (signal === "SIGKILL") {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  }
});
const probeFailureIdentity = processIdentity({
  pid: 9311,
  processGroup: 931,
});
await assert.rejects(
  superviseGateChild(probeFailureChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 1,
    pollMs: 1,
    snapshotProcessTree: () => identityTree([probeFailureIdentity]),
    killProcessGroup() {},
    readProcessIdentity: fakeIdentityReader(() => {
      throw new Error("probe denied");
    }),
  }),
  error =>
    assertCleanupFailure(error, "gate_characterization_timeout", [
      "gate_characterization_descendant_probe_failed",
      "gate_characterization_descendant_survived",
    ]),
);

const killFailureEvents = [];
const killFailureAlive = new Set([941, 942]);
const killFailureIdentities = [
  processIdentity({ pid: 9411, processGroup: 941 }),
  processIdentity({ pid: 9421, processGroup: 942 }),
];
const killFailureChild = fakeCharacterizationChild((signal, child) => {
  if (signal === "SIGKILL") {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  }
});
await assert.rejects(
  superviseGateChild(killFailureChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 1,
    pollMs: 1,
    snapshotProcessTree: () => identityTree(killFailureIdentities),
    readProcessIdentity: fakeIdentityReader(pid => {
      const identity = killFailureIdentities.find(item => item.pid === pid);
      return identity && killFailureAlive.has(identity.processGroup)
        ? identity
        : null;
    }),
    killProcessGroup(group) {
      killFailureEvents.push(group);
      if (group === 941) throw new Error("kill denied");
      killFailureAlive.delete(group);
    },
  }),
  error =>
    assertCleanupFailure(error, "gate_characterization_timeout", [
      "gate_characterization_descendant_kill_failed",
      "gate_characterization_descendant_survived",
    ]),
);
assert.deepEqual(killFailureEvents, [941, 942]);

const lateGroupSignals = [];
const lateIdentity = processIdentity({ pid: 9811, processGroup: 981 });
const lateRootIdentity = processIdentity({
  pid: 800,
  parentPid: process.pid,
  processGroup: 800,
});
let lateSnapshotCalls = 0;
let lateIdentityAlive = true;
const lateDescendantChild = fakeCharacterizationChild((signal, child) => {
  if (signal === "SIGKILL") {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  }
});
await assert.rejects(
  superviseGateChild(lateDescendantChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 10,
    pollMs: 1,
    snapshotProcessTree() {
      lateSnapshotCalls += 1;
      return {
        root: lateRootIdentity,
        descendants: lateSnapshotCalls === 1 ? [] : [lateIdentity],
      };
    },
    readProcessIdentity(pid) {
      if (pid === lateRootIdentity.pid) return lateRootIdentity;
      return pid === lateIdentity.pid && lateIdentityAlive ? lateIdentity : null;
    },
    killProcessGroup(group, signal) {
      lateGroupSignals.push([group, signal]);
      lateIdentityAlive = false;
    },
  }),
  /gate_characterization_timeout/,
);
assert.equal(lateSnapshotCalls, 2);
assert.deepEqual(lateGroupSignals, [[981, "SIGKILL"]]);

const reusedGroupSignals = [];
const capturedIdentity = processIdentity({
  pid: 9911,
  processGroup: 991,
  session: 991,
  startTime: "captured-start",
});
const reusedIdentity = {
  ...capturedIdentity,
  session: 1991,
  startTime: "reused-start",
};
const reusedRootIdentity = processIdentity({
  pid: 800,
  parentPid: process.pid,
  processGroup: 800,
});
const reusedGroupChild = fakeCharacterizationChild((signal, child) => {
  if (signal === "SIGKILL") {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  }
});
await assert.rejects(
  superviseGateChild(reusedGroupChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 10,
    pollMs: 1,
    snapshotProcessTree: () => ({
      root: reusedRootIdentity,
      descendants: [capturedIdentity],
    }),
    readProcessIdentity(pid) {
      if (pid === reusedRootIdentity.pid) return reusedRootIdentity;
      return pid === capturedIdentity.pid ? reusedIdentity : null;
    },
    killProcessGroup(group, signal) {
      reusedGroupSignals.push([group, signal]);
    },
  }),
  /gate_characterization_timeout/,
);
assert.deepEqual(reusedGroupSignals, []);

const anchoredRoot = processIdentity({
  pid: 800,
  parentPid: process.pid,
  processGroup: 800,
  startTime: "anchored-root",
});
const replacementRoot = {
  ...anchoredRoot,
  session: 1800,
  processGroup: 1800,
  startTime: "replacement-root",
};
const replacementDescendant = processIdentity({
  pid: 18001,
  parentPid: replacementRoot.pid,
  processGroup: 1800,
  session: 1800,
  startTime: "replacement-descendant",
});
const replacementDirectSignals = [];
const replacementGroupSignals = [];
let replacementRootReads = 0;
const replacementChild = fakeCharacterizationChild(signal => {
  replacementDirectSignals.push(signal);
});
await assert.rejects(
  superviseGateChild(replacementChild, {
    timeoutMs: 1,
    maxOutputBytes: 1024,
    termGraceMs: 1,
    killGraceMs: 1,
    pollMs: 1,
    snapshotProcessTree: () => ({
      root: replacementRoot,
      descendants: [replacementDescendant],
    }),
    readProcessIdentity(pid) {
      if (pid === anchoredRoot.pid) {
        replacementRootReads += 1;
        return replacementRootReads === 1 ? anchoredRoot : replacementRoot;
      }
      return pid === replacementDescendant.pid ? replacementDescendant : null;
    },
    killProcessGroup(group, signal) {
      replacementGroupSignals.push([group, signal]);
    },
  }),
  error =>
    assertCleanupFailure(error, "gate_characterization_timeout", [
      "gate_characterization_root_replaced",
      "gate_characterization_child_close_timeout",
    ]),
);
assert.deepEqual(replacementDirectSignals, []);
assert.deepEqual(replacementGroupSignals, []);

const directSignalCases = [
  { phase: "term", mode: "false", expected: ["gate_characterization_child_term_failed"] },
  { phase: "term", mode: "throw", expected: ["gate_characterization_child_term_failed"] },
  { phase: "term", mode: "error", expected: ["gate_characterization_child_error"] },
  {
    phase: "kill",
    mode: "false",
    expected: [
      "gate_characterization_child_kill_failed",
      "gate_characterization_child_close_timeout",
    ],
  },
  {
    phase: "kill",
    mode: "throw",
    expected: [
      "gate_characterization_child_kill_failed",
      "gate_characterization_child_close_timeout",
    ],
  },
  { phase: "kill", mode: "error", expected: ["gate_characterization_child_error"] },
];

for (const [index, testCase] of directSignalCases.entries()) {
  const root = processIdentity({
    pid: 800,
    parentPid: process.pid,
    processGroup: 800,
    startTime: `signal-root-${index}`,
  });
  const descendant = processIdentity({
    pid: 20001 + index,
    processGroup: 2000 + index,
    startTime: `signal-descendant-${index}`,
  });
  let descendantAlive = true;
  let cleanupStarts = 0;
  let snapshots = 0;
  const directSignals = [];
  const groupSignals = [];
  const signalChild = fakeCharacterizationChild((signal, child) => {
    directSignals.push(signal);
    const activePhase = signal === "SIGTERM" ? "term" : "kill";
    if (activePhase === testCase.phase) {
      if (testCase.mode === "false") return false;
      if (testCase.mode === "throw") throw new Error(`${activePhase} denied`);
      child.emit("error", new Error(`${activePhase} emitted error`));
    }
    if (signal === "SIGKILL" && testCase.mode !== "false" && testCase.mode !== "throw") {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    } else if (signal === "SIGKILL" && testCase.phase !== "kill") {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  });
  let reportedError;
  await assert.rejects(
    superviseGateChild(signalChild, {
      timeoutMs: 1,
      maxOutputBytes: 1024,
      termGraceMs: 1,
      killGraceMs: 2,
      pollMs: 1,
      onCleanupStart() {
        cleanupStarts += 1;
      },
      snapshotProcessTree() {
        snapshots += 1;
        return { root, descendants: [descendant] };
      },
      readProcessIdentity(pid) {
        if (pid === root.pid) return root;
        return pid === descendant.pid && descendantAlive ? descendant : null;
      },
      killProcessGroup(group, signal) {
        groupSignals.push([group, signal]);
        descendantAlive = false;
      },
    }),
    error => {
      reportedError = error;
      return assertCleanupFailure(
        error,
        "gate_characterization_timeout",
        testCase.expected,
      );
    },
  );
  assert.equal(cleanupStarts, 1);
  assert.equal(snapshots, 2);
  assert.deepEqual(groupSignals, [[descendant.processGroup, "SIGKILL"]]);
  assert.deepEqual(directSignals, ["SIGTERM", "SIGKILL"]);
  const reportedCount = reportedError.errors.length;
  assert.doesNotThrow(() => signalChild.emit("error", new Error("late error")));
  assert.equal(reportedError.errors.length, reportedCount);
}

for (const primary of ["output", "timeout"]) {
  const root = processIdentity({
    pid: 800,
    parentPid: process.pid,
    processGroup: 800,
    startTime: `race-root-${primary}`,
  });
  let cleanupStarts = 0;
  let snapshots = 0;
  let settlements = 0;
  const signals = [];
  const raceChild = fakeCharacterizationChild((signal, child) => {
    signals.push(signal);
    if (primary === "timeout") child.stdout.write(Buffer.alloc(2));
    queueMicrotask(() => child.emit("close", null, signal));
  });
  const raceResult = superviseGateChild(raceChild, {
    timeoutMs: primary === "timeout" ? 0 : 50,
    maxOutputBytes: 1,
    termGraceMs: 10,
    killGraceMs: 1,
    pollMs: 1,
    onCleanupStart() {
      cleanupStarts += 1;
    },
    snapshotProcessTree() {
      snapshots += 1;
      return { root, descendants: [] };
    },
    readProcessIdentity: () => root,
    killProcessGroup() {},
  }).then(
    () => {
      settlements += 1;
    },
    error => {
      settlements += 1;
      throw error;
    },
  );
  if (primary === "output") raceChild.stdout.write(Buffer.alloc(2));
  await assert.rejects(
    raceResult,
    new RegExp(`gate_characterization_${primary}`),
  );
  await wait(5);
  assert.equal(cleanupStarts, 1);
  assert.equal(snapshots, 1);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(settlements, 1);
}

const namedCases = [
  [
    "--action-store-self-test",
    "codex_browser_action_store: PASS writes=1 records=1\n",
  ],
  [
    "--hardening-self-test",
    "codex_browser_format_hardening: PASS\n" +
      "codex_browser_hardening: PASS\n",
  ],
  ["--transport-self-test", "codex_browser_transport: PASS\n"],
  ["--lifecycle-self-test", "codex_browser_lifecycle: PASS\n"],
];

for (const [flag, stdout] of namedCases) {
  assert.deepEqual(await invokeGate([flag]), {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
  });
}

for (const args of [
  ["--runs"],
  ["--runs", "0"],
  ["--runs", "01"],
  ["--runs", "+1"],
  ["--runs", "-1"],
  ["--runs", "1.0"],
  ["--runs", " 1"],
  ["--runs", "11"],
  ["--runs", "9007199254740993"],
  ["--runs", "Infinity"],
  ["--runs", "1", "extra"],
  ["--unknown"],
  ["--transport-self-test", "--lifecycle-self-test"],
  ["--hardening-self-test", "extra"],
]) {
  assert.deepEqual(await invokeGate(args), {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "codex_gate_arguments_invalid\n",
  });
}

assert.deepEqual(Object.keys(contract).toSorted(), [
  "ALLOWED_ITEM_TYPES",
  "CLEANUP_DRAIN_GRACE_MS",
  "CLEANUP_KILL_GRACE_MS",
  "CLEANUP_POLL_MS",
  "CLEANUP_TERM_GRACE_MS",
  "CLEANUP_TOTAL_GRACE_MS",
  "CONFIG",
  "DISABLED_FEATURES",
  "EFFORT",
  "FORBIDDEN_EVENT_PATTERN",
  "MAX_OUTPUT_BYTES",
  "MAX_RUNS",
  "MODEL",
  "REQUIRED_SCHEMA_DEFINITIONS",
  "REVIEWED_ENABLED_NON_TOOL_FEATURES",
  "TOOL_SURFACE_PATTERN",
  "WATCHDOG_MS",
  "gateError",
  "hashFeatureInventory",
]);
assert.deepEqual(Object.keys(codexExecutable).toSorted(), [
  "assertSameCodexIdentity",
  "captureCodexIdentity",
  "parseCodexVersionOutput",
]);
assert.deepEqual(Object.keys(decisionWire).toSorted(), [
  "modelDecisionEnvelopeSchema",
  "normalizeModelDecisionEnvelopeV1",
  "normalizedProposalHash",
  "parseModelDecisionEnvelopeV1",
  "runDecisionWireSelfTest",
]);
assert.deepEqual(Object.keys(lifecycle).toSorted(), [
  "LifecycleRegistry",
  "ProcessDeadline",
  "combinePrimaryAndCleanup",
  "installSignalHandlers",
  "renderGateFailure",
  "runCaptured",
  "runLifecycleSelfTest",
  "surfaceCleanupFailures",
]);
assert.deepEqual(Object.keys(orchestration).toSorted(), [
  "runGateWithStableCodex",
]);
assert.deepEqual(Object.keys(protocol).toSorted(), [
  "AppServerClient",
  "assertGeneratedSchemaValue",
  "assertNoLateTurnMessages",
  "auditAllAppServerEvents",
  "extractTurnAgentMessageText",
  "loadEventSchemas",
  "runProtocolHardeningSelfTest",
  "runTransportSelfTest",
  "runUnloadedTurnRegression",
  "schemaHash",
  "startTurn",
]);
assert.equal(Object.keys(protocol).length, 11);
assert.equal(
  protocol.assertGeneratedSchemaValue(1, { schema: { type: "integer" } }),
  1,
);
assert.throws(
  () =>
    protocol.assertGeneratedSchemaValue(1.5, {
      schema: { type: "integer" },
    }),
  /codex_protocol_schema_mismatch/,
);
const originalProtocolStdoutWrite = process.stdout.write;
let protocolSelfTestOutput = "";
process.stdout.write = chunk => {
  protocolSelfTestOutput += String(chunk);
  return true;
};
try {
  await protocol.runProtocolHardeningSelfTest({ silent: true });
  await protocol.runTransportSelfTest({ silent: true });
} finally {
  process.stdout.write = originalProtocolStdoutWrite;
}
assert.equal(protocolSelfTestOutput, "");
assert.deepEqual(Object.keys(preflight).toSorted(), [
  "parseInvocation",
  "runPreflight",
]);

for (const pattern of [
  /class RawJsonlFramer/,
  /class LifecycleRegistry/,
  /class ProcessDeadline/,
  /function generatedSchemaMatches/,
  /function validateModelDecisionEnvelopeV1/,
  /function actionStoreSelfTest/,
  /function hardeningSelfTest/,
  /function transportSelfTest/,
  /function lifecycleSelfTest/,
  /^export\s/m,
]) {
  assert.doesNotMatch(runSource, pattern);
}

for (const name of [
  "codex-executable.mjs",
  "gate-contract.mjs",
  "lifecycle.mjs",
  "decision-wire.mjs",
  "app-server-protocol.mjs",
]) {
  assert.doesNotMatch(
    productionSources[name],
    /["']\.\/(?:preflight|run)\.mjs["']/,
  );
}
assert.doesNotMatch(
  productionSources["app-server-protocol.mjs"],
  /["']\.\/decision-wire\.mjs["']/,
);
for (const source of Object.values(productionSources)) {
  assert.doesNotMatch(source, /\bimport\s*\(/);
}

const orchestrationSource = productionSources["gate-orchestration.mjs"];
const preflightCall = orchestrationSource.indexOf("await runPreflight()");
const versionCall = orchestrationSource.indexOf("captureCodexIdentity({");
const firstRunCall = orchestrationSource.indexOf(
  "runOne(runNumber, codexIdentity.resolvedPath)",
);
const postRunCapture = orchestrationSource.indexOf("const postRunIdentity");
const identityAssertion = orchestrationSource.indexOf(
  "assertSameCodexIdentity(codexIdentity, postRunIdentity)",
);
const reportCall = orchestrationSource.indexOf(
  "return reportSuccess(codexIdentity, results)",
);
assert.notEqual(preflightCall, -1);
assert.notEqual(versionCall, -1);
assert.notEqual(firstRunCall, -1);
assert.notEqual(postRunCapture, -1);
assert.notEqual(identityAssertion, -1);
assert.notEqual(reportCall, -1);
assert.ok(preflightCall < versionCall);
assert.ok(firstRunCall < postRunCapture);
assert.ok(postRunCapture < identityAssertion);
assert.ok(identityAssertion < reportCall);
assert.match(
  orchestrationSource.slice(postRunCapture, identityAssertion),
  /failureCode: "codex_version_changed"/,
);
assert.match(
  orchestrationSource.slice(postRunCapture, identityAssertion),
  /\.\.\.selection/,
);
assert.doesNotMatch(runSource, /runCaptured\("codex"/);
assert.doesNotMatch(
  productionSources["app-server-protocol.mjs"],
  /spawnChild\(\s*["']codex["']/,
);
assert.match(runSource, /command: codexExecutablePath/);
assert.match(runSource, /runGateWithStableCodex\(\{/);
assert.match(runSource, /version=\$\{codexIdentity\.version\}/);
assert.match(runSource, /process\.stderr\.write\(renderGateFailure\(error\)\)/);
assert.match(
  runSource,
  /runCaptured\(\s*codexExecutablePath,\s*\[\s*"app-server",\s*"generate-json-schema"/,
);
assert.match(
  runSource,
  /runCaptured\(\s*codexExecutablePath,\s*\["features", "list"\]/,
);
assert.equal("CODEX_VERSION" in contract, false);
assert.equal("CODEX_VERSION_OUTPUT" in contract, false);

const primaryFailure = new Error("primary");
const cleanupFailure = new Error("cleanup");
assert.equal(combinePrimaryAndCleanup(primaryFailure), primaryFailure);
for (const [code, detail, rendered] of [
  [
    "codex_version_changed",
    "resolvedPath",
    "codex_version_changed: resolvedPath\n",
  ],
  [
    "codex_run_identity_reused",
    "threadId",
    "codex_run_identity_reused: threadId\n",
  ],
  [
    "codex_protocol_schema_mismatch",
    "ThreadStartParams",
    "codex_protocol_schema_mismatch: ThreadStartParams\n",
  ],
  [
    "codex_feature_surface_changed",
    "browser_use",
    "codex_feature_surface_changed: browser_use\n",
  ],
  [
    "codex_turn_count_mismatch",
    "1/2",
    "codex_turn_count_mismatch: 1/2\n",
  ],
  [
    "codex_forbidden_event",
    "turn/tool-call",
    "codex_forbidden_event: turn/tool-call\n",
  ],
  [
    "codex_response_id_unknown",
    "17",
    "codex_response_id_unknown: 17\n",
  ],
  [
    "codex_agent_message_count",
    "2",
    "codex_agent_message_count: 2\n",
  ],
  [
    "codex_app_server_timeout",
    "thread/start",
    "codex_app_server_timeout: thread/start\n",
  ],
  [
    "codex_forbidden_item",
    "toolCall",
    "codex_forbidden_item: toolCall\n",
  ],
  [
    "codex_server_request",
    "item/request",
    "codex_server_request: item/request\n",
  ],
  [
    "codex_app_server_exited",
    "code=1 signal=null",
    "codex_app_server_exited: code=1 signal=null\n",
  ],
  [
    "codex_app_server_exited",
    "stopped with pending requests=3",
    "codex_app_server_exited: stopped with pending requests=3\n",
  ],
  [
    "codex_spawn_failed",
    "missing process group id",
    "codex_spawn_failed: missing process group id\n",
  ],
  [
    "codex_process_group_survived",
    "801",
    "codex_process_group_survived: 801\n",
  ],
  [
    "codex_process_group_reused",
    "802",
    "codex_process_group_reused: 802\n",
  ],
  ["codex_gate_cancelled", "SIGTERM", "codex_gate_cancelled: SIGTERM\n"],
]) {
  const error = gateError(code, detail);
  assert.equal(error.detail, detail);
  assert.equal(lifecycle.renderGateFailure(error), rendered);
}
const sensitiveFailurePaths = [
  "/home/gate-user/.local/share/codex/0.144.6/bin/codex",
  "/home/gate-user/.codex",
  "/tmp/codex-browser-gate-secret",
];
const sensitiveFailure = gateError(
  "codex_spawn_failed",
  sensitiveFailurePaths.join(" "),
);
assert.equal(
  lifecycle.renderGateFailure(sensitiveFailure),
  "codex_spawn_failed\n",
);
for (const code of [
  "codex_command_timeout",
  "codex_error_notification",
  "codex_feature_surface_changed",
  "codex_features_failed",
  "codex_protocol_schema_mismatch",
  "codex_response_error",
  "codex_spawn_failed",
  "codex_temp_root_survived",
  "codex_version_changed",
]) {
  assert.equal(
    lifecycle.renderGateFailure(
      gateError(code, sensitiveFailurePaths.join(" ")),
    ),
    `${code}\n`,
  );
}
assert.equal(
  lifecycle.renderGateFailure(
    new AggregateError(
      [sensitiveFailure],
      `operation_and_cleanup_failed ${sensitiveFailurePaths.join(" ")}`,
    ),
  ),
  "operation_and_cleanup_failed\n",
);
assert.equal(
  lifecycle.renderGateFailure(new Error(sensitiveFailurePaths.join(" "))),
  "codex_gate_failed\n",
);
for (const rendered of [
  lifecycle.renderGateFailure(sensitiveFailure),
  lifecycle.renderGateFailure(
    new AggregateError([sensitiveFailure], "operation_and_cleanup_failed"),
  ),
  lifecycle.renderGateFailure(new Error(sensitiveFailurePaths.join(" "))),
]) {
  for (const path of sensitiveFailurePaths) {
    assert.equal(rendered.includes(path), false);
  }
}
assert.throws(
  () => surfaceCleanupFailures(primaryFailure, [cleanupFailure]),
  error =>
    error instanceof AggregateError &&
    error.errors[0] === primaryFailure &&
    error.errors[1] === cleanupFailure,
);
assert.throws(
  () => surfaceCleanupFailures(undefined, [cleanupFailure]),
  error => error === cleanupFailure,
);

let deadlineNow = 0;
let expirationCount = 0;
const deadline = new ProcessDeadline(
  10,
  () => deadlineNow,
  () => {
    expirationCount += 1;
  },
);
assert.equal(deadline.remaining(), 10);
deadlineNow = 9;
assert.equal(deadline.remaining(), 1);
deadlineNow = 10;
assert.throws(
  () => deadline.remaining(),
  error =>
    error?.code === "codex_app_server_timeout" &&
    error.message === "codex_app_server_timeout",
);
assert.throws(
  () => {
    throw deadline.expire();
  },
  /codex_app_server_timeout/,
);
assert.equal(expirationCount, 1);

const actionEnvelopeText =
  '{"decision":{"version":1,"type":"action","action":' +
  '{"kind":"fill","ref":"gate-marker","value":"approved"}}}';
assert.deepEqual(parseModelDecisionEnvelopeV1(actionEnvelopeText), {
  decision: {
    version: 1,
    type: "action",
    action: {
      kind: "fill",
      ref: "gate-marker",
      value: "approved",
    },
  },
});
const finalEnvelopeText =
  '{"decision":{"version":1,"type":"final",' +
  '"output":"gate-complete"}}';
assert.deepEqual(
  normalizeModelDecisionEnvelopeV1(
    parseModelDecisionEnvelopeV1(finalEnvelopeText),
  ),
  { version: 1, type: "final", output: "gate-complete" },
);
assert.throws(
  () =>
    parseModelDecisionEnvelopeV1(
      '{"decision":{"version":1,"type":"final",' +
        '"\\u0074ype":"action","output":"gate-complete"}}',
    ),
  /model_protocol_error/,
);
const emptyEvaluateArgsKey =
  '{"decision":{"version":1,"type":"action","action":' +
  '{"kind":"evaluate","expression":"1","args":{"":123}}}}';
assert.throws(
  () => parseModelDecisionEnvelopeV1(emptyEvaluateArgsKey),
  /model_protocol_error/,
);
const nulEvaluateArgsKey = String.raw`
  {"decision":{"version":1,"type":"action","action":
  {"kind":"evaluate","expression":"1","args":{"\u0000":123}}}}
`;
assert.throws(
  () => parseModelDecisionEnvelopeV1(nulEvaluateArgsKey),
  /model_protocol_error/,
);
const orderedProposal = {
  kind: "fill",
  ref: "gate-marker",
  value: "approved",
};
const permutedProposal = {
  value: "approved",
  kind: "fill",
  ref: "gate-marker",
};
const changedProposal = {
  kind: "fill",
  ref: "gate-marker",
  value: "changed",
};
assert.equal(
  normalizedProposalHash(orderedProposal),
  normalizedProposalHash(permutedProposal),
);
assert.notEqual(
  normalizedProposalHash(orderedProposal),
  normalizedProposalHash(changedProposal),
);
const originalStdoutWrite = process.stdout.write;
let decisionWireOutput = "";
process.stdout.write = chunk => {
  decisionWireOutput += String(chunk);
  return true;
};
try {
  await runDecisionWireSelfTest();
  await runDecisionWireSelfTest({ silent: true });
  await runDecisionWireSelfTest({ silent: false });
} finally {
  process.stdout.write = originalStdoutWrite;
}
assert.equal(decisionWireOutput, "");
const frozenSchemaObjects = new WeakSet();
function assertDeepFrozen(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    frozenSchemaObjects.has(value)
  ) {
    return;
  }
  frozenSchemaObjects.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}
assertDeepFrozen(decisionWire.modelDecisionEnvelopeSchema);
const schemaBytes = JSON.stringify(
  decisionWire.modelDecisionEnvelopeSchema,
);
const schemaMutationAttempts = [
  () => {
    decisionWire.modelDecisionEnvelopeSchema.properties.decision = null;
  },
  () => {
    const required =
      decisionWire.modelDecisionEnvelopeSchema.required;
    required.push("unexpected");
  },
  () => {
    const alternatives =
      decisionWire.modelDecisionEnvelopeSchema.properties.decision
        .anyOf;
    alternatives.push({});
  },
  () => {
    const actionSchema =
      decisionWire.modelDecisionEnvelopeSchema.properties.decision
        .anyOf[0];
    actionSchema.properties.type.enum[0] = "mutated";
  },
];
for (const mutate of schemaMutationAttempts) {
  assert.throws(mutate, TypeError);
}
assert.equal(
  JSON.stringify(decisionWire.modelDecisionEnvelopeSchema),
  schemaBytes,
);
assert.deepEqual(parseModelDecisionEnvelopeV1(actionEnvelopeText), {
  decision: {
    version: 1,
    type: "action",
    action: {
      kind: "fill",
      ref: "gate-marker",
      value: "approved",
    },
  },
});
assert.equal(contract.MODEL, "gpt-5.6-terra");
assert.equal(contract.EFFORT, "medium");
assert.equal(contract.MAX_OUTPUT_BYTES, 4 * 1024 * 1024);
assert.equal(contract.WATCHDOG_MS, 120_000);
assert.equal(contract.MAX_RUNS, 10);
assert.equal(contract.CLEANUP_TERM_GRACE_MS, 250);
assert.equal(contract.CLEANUP_KILL_GRACE_MS, 1_000);
assert.equal(contract.CLEANUP_POLL_MS, 10);
assert.equal(contract.CLEANUP_TOTAL_GRACE_MS, 5_000);
assert.equal(contract.CLEANUP_DRAIN_GRACE_MS, 1_000);
assert.equal(
  contract.CONFIG,
  `model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[history]
persistence = "none"

[analytics]
enabled = false

[features]
apps = false
artifact = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
code_mode = false
code_mode_host = false
code_mode_only = false
computer_use = false
enable_mcp_apps = false
goals = false
hooks = false
image_generation = false
in_app_browser = false
memories = false
multi_agent = false
plugins = false
plugin_sharing = false
remote_plugin = false
request_permissions_tool = false
shell_snapshot = false
shell_tool = false
skill_mcp_dependency_install = false
standalone_web_search = false
tool_call_mcp_elicitation = false
tool_suggest = false
unified_exec = false
workspace_dependencies = false
`,
);
assert.deepEqual([...contract.REQUIRED_SCHEMA_DEFINITIONS], [
  "ThreadStartParams",
  "TurnStartParams",
  "ThreadStartResponse",
  "TurnCompletedNotification",
]);
assert.deepEqual([...contract.DISABLED_FEATURES], [
  "apps",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "enable_mcp_apps",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
]);
assert.deepEqual([...contract.REVIEWED_ENABLED_NON_TOOL_FEATURES], [
  ["guardian_approval", "stable"],
  ["remote_compaction_v2", "stable"],
  ["resize_all_images", "removed"],
  ["tool_search_always_defer_mcp_tools", "removed"],
  ["tui_app_server", "removed"],
]);
assert.deepEqual([...contract.ALLOWED_ITEM_TYPES], [
  "userMessage",
  "agentMessage",
  "reasoning",
]);
assert.equal(
  contract.TOOL_SURFACE_PATTERN.source,
  "tool|browser|computer|code_mode|image|app|plugin|shell|web_search|skill|mcp|artifact",
);
assert.equal(contract.TOOL_SURFACE_PATTERN.flags, "");
assert.equal(
  contract.FORBIDDEN_EVENT_PATTERN.source,
  "command|file|mcp|dynamic.?tool|browser|computer|code.?mode|web.?search|image|app|plugin|shell|approval|collab",
);
assert.equal(contract.FORBIDDEN_EVENT_PATTERN.flags, "i");
for (const pattern of [
  contract.TOOL_SURFACE_PATTERN,
  contract.FORBIDDEN_EVENT_PATTERN,
]) {
  assert.equal(Object.isFrozen(pattern), true);
  assert.throws(() => {
    pattern.test = () => false;
  });
  assert.throws(() => {
    pattern.lastIndex = 1;
  });
  assert.throws(() => pattern.compile("never-match", ""));
  assert.throws(() => RegExp.prototype.compile.call(pattern, "never-match"));
}
for (const name of ["browser_use", "shell_tool", "artifact"]) {
  assert.equal(contract.TOOL_SURFACE_PATTERN.test(name), true);
}
for (const name of ["remote_compaction_v2", "telemetry"]) {
  assert.equal(contract.TOOL_SURFACE_PATTERN.test(name), false);
}
for (const eventName of ["command/started", "dynamic-tool", "collab/event"]) {
  assert.equal(contract.FORBIDDEN_EVENT_PATTERN.test(eventName), true);
}
for (const eventName of ["turn/started", "agentMessage", "reasoning"]) {
  assert.equal(contract.FORBIDDEN_EVENT_PATTERN.test(eventName), false);
}

assert.equal(Object.isFrozen(contract.REQUIRED_SCHEMA_DEFINITIONS), true);
assert.equal(Object.isFrozen(contract.DISABLED_FEATURES), true);
assert.equal(Object.isFrozen(contract.REVIEWED_ENABLED_NON_TOOL_FEATURES), true);
assert.equal(Object.isFrozen(contract.ALLOWED_ITEM_TYPES), true);
assert.throws(() => contract.REQUIRED_SCHEMA_DEFINITIONS.push("Injected"));
assert.throws(() => contract.DISABLED_FEATURES.push("injected_tool"));
assert.throws(() => {
  contract.REQUIRED_SCHEMA_DEFINITIONS[0] = "Injected";
});
assert.throws(() => {
  contract.REVIEWED_ENABLED_NON_TOOL_FEATURES.injected = true;
});
assert.throws(() =>
  Map.prototype.set.call(
    contract.REVIEWED_ENABLED_NON_TOOL_FEATURES,
    "unreviewed_tool",
    "stable",
  ),
);
assert.throws(() =>
  Set.prototype.add.call(contract.ALLOWED_ITEM_TYPES, "toolCall"),
);
assert.equal(contract.REVIEWED_ENABLED_NON_TOOL_FEATURES.has("unreviewed_tool"), false);
assert.equal(contract.ALLOWED_ITEM_TYPES.has("toolCall"), false);
assert.deepEqual(parseInvocation([]), { runCount: 3 });
assert.deepEqual(parseInvocation(["--runs", "1"]), { runCount: 1 });
assert.deepEqual(parseInvocation(["--runs", "10"]), { runCount: 10 });

const selfTestChecks = {
  actionStore() {},
  hardening() {},
  transport() {},
  lifecycle() {},
};
for (const [flag, name] of [
  ["--action-store-self-test", "actionStore"],
  ["--hardening-self-test", "hardening"],
  ["--transport-self-test", "transport"],
  ["--lifecycle-self-test", "lifecycle"],
]) {
  assert.equal(
    parseInvocation([flag], selfTestChecks).selfTest,
    selfTestChecks[name],
  );
}

const calls = [];
const checks = Object.fromEntries(
  ["actionStore", "hardening", "transport", "lifecycle"].map(name => [
    name,
    async options => calls.push([name, options]),
  ]),
);
await runPreflight(checks);
assert.deepEqual(calls, [
  ["actionStore", { silent: true }],
  ["hardening", { silent: true }],
  ["transport", { silent: true }],
  ["lifecycle", { silent: true }],
]);

const stableSelection = Object.freeze({
  pathValue: "/selected/bin:/fallback/bin",
  cwd: "/original/workspace",
});
const stableSupervisor = {};
const initialIdentity = Object.freeze({
  executablePath: "/selected/bin/codex",
  resolvedPath: "/opt/codex/0.144.6/bin/codex",
  device: "8",
  inode: "1446",
  version: "0.144.6",
});
const orchestrationCalls = [];
let captureNumber = 0;
const orchestrationResult = await orchestration.runGateWithStableCodex({
  selection: stableSelection,
  supervisor: stableSupervisor,
  runCount: 2,
  async runPreflight() {
    orchestrationCalls.push("preflight");
  },
  async captureCodexIdentity(options) {
    captureNumber += 1;
    assert.equal(options.pathValue, stableSelection.pathValue);
    assert.equal(options.cwd, stableSelection.cwd);
    assert.equal(options.supervisor, stableSupervisor);
    orchestrationCalls.push(
      `capture:${options.failureCode ?? "initial"}`,
    );
    return { ...initialIdentity };
  },
  assertSameCodexIdentity(expected, actual) {
    orchestrationCalls.push("compare");
    assert.deepEqual(expected, initialIdentity);
    assert.deepEqual(actual, initialIdentity);
  },
  async runOne(runNumber, command) {
    orchestrationCalls.push(`run:${runNumber}:${command}`);
    return { runNumber };
  },
  reportSuccess(identity, results) {
    orchestrationCalls.push("report");
    assert.deepEqual(identity, initialIdentity);
    assert.deepEqual(results, [{ runNumber: 1 }, { runNumber: 2 }]);
    return "reported";
  },
});
assert.equal(captureNumber, 2);
assert.equal(orchestrationResult, "reported");
assert.deepEqual(orchestrationCalls, [
  "preflight",
  "capture:initial",
  "run:1:/opt/codex/0.144.6/bin/codex",
  "run:2:/opt/codex/0.144.6/bin/codex",
  "capture:codex_version_changed",
  "compare",
  "report",
]);

const changedIdentityCalls = [];
await assert.rejects(
  orchestration.runGateWithStableCodex({
    selection: stableSelection,
    supervisor: stableSupervisor,
    runCount: 1,
    async runPreflight() {
      changedIdentityCalls.push("preflight");
    },
    async captureCodexIdentity(options) {
      changedIdentityCalls.push(
        `capture:${options.failureCode ?? "initial"}`,
      );
      return options.failureCode
        ? { ...initialIdentity, version: "0.144.7" }
        : { ...initialIdentity };
    },
    assertSameCodexIdentity() {
      changedIdentityCalls.push("compare");
      throw gateError("codex_version_changed", "version");
    },
    async runOne() {
      changedIdentityCalls.push("run");
      return {};
    },
    reportSuccess() {
      changedIdentityCalls.push("report");
    },
  }),
  error =>
    error?.code === "codex_version_changed" &&
    error.message === "codex_version_changed: version",
);
assert.deepEqual(changedIdentityCalls, [
  "preflight",
  "capture:initial",
  "run",
  "capture:codex_version_changed",
  "compare",
]);

const failedCalls = [];
const hardeningFailure = new Error("hardening failed");
await assert.rejects(
  runPreflight({
    actionStore: async options => failedCalls.push(["actionStore", options]),
    hardening: async options => {
      failedCalls.push(["hardening", options]);
      throw hardeningFailure;
    },
    transport: async options => failedCalls.push(["transport", options]),
    lifecycle: async options => failedCalls.push(["lifecycle", options]),
  }),
  error => error === hardeningFailure,
);
assert.deepEqual(failedCalls, [
  ["actionStore", { silent: true }],
  ["hardening", { silent: true }],
]);

const detailedError = gateError("code", "detail");
assert.equal(detailedError.code, "code");
assert.equal(detailedError.detail, "detail");
assert.equal(detailedError.message, "code: detail");
assert.throws(() => {
  detailedError.detail = "mutated";
}, TypeError);

const disabledLines = contract.DISABLED_FEATURES.map(
  name => `${name}  experimental  false`,
);
const reviewedLines = [...contract.REVIEWED_ENABLED_NON_TOOL_FEATURES].map(
  ([name, stage]) => `${name}  ${stage}  true`,
);
const featureFixture = [...disabledLines, ...reviewedLines].join("\n");
assert.equal(
  hashFeatureInventory(featureFixture),
  "543779f017f80fa9ceb4f1b99b1b2b1734dad37c5237506d000a47fdd3890c2b",
);

function assertFeatureSurfaceChanged(output) {
  assert.throws(
    () => hashFeatureInventory(output),
    error =>
      error instanceof Error &&
      error.code === "codex_feature_surface_changed" &&
      error.message.startsWith("codex_feature_surface_changed"),
  );
}

assertFeatureSurfaceChanged(`${featureFixture}\n${disabledLines[0]}`);
assertFeatureSurfaceChanged(
  [...disabledLines.slice(1), ...reviewedLines].join("\n"),
);
assertFeatureSurfaceChanged(`${featureFixture}\nunreviewed_tool  stable  true`);
assertFeatureSurfaceChanged("");

process.stdout.write("codex_browser_gate_characterization: PASS\n");
