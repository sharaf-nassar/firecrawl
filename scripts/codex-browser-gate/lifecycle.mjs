import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { PassThrough } from "node:stream";

import {
  CLEANUP_DRAIN_GRACE_MS,
  CLEANUP_KILL_GRACE_MS,
  CLEANUP_POLL_MS,
  CLEANUP_TERM_GRACE_MS,
  CLEANUP_TOTAL_GRACE_MS,
  gateError,
  MAX_OUTPUT_BYTES,
} from "./gate-contract.mjs";
import {
  deriveSafeSchemaMismatchDetails,
  loadRequiredV2Contract,
} from "./app-server-compatibility.mjs";

const REQUIRED_V2_CONTRACT_URL = new URL(
  "../../host/browser-runtime/protocol/compatibility/required-v2-contract.json",
  import.meta.url,
);
const SAFE_SCHEMA_DETAILS = new Set(
  deriveSafeSchemaMismatchDetails(
    await loadRequiredV2Contract(REQUIRED_V2_CONTRACT_URL),
  ),
);

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

export class LifecycleRegistry {
  constructor({
    killProcess = process.kill.bind(process),
    now = () => performance.now(),
    wait: waitFor = wait,
    removeTree = rm,
    inspectPath = stat,
    scheduleTimer = setTimeout,
    cancelTimer = clearTimeout,
  } = {}) {
    this.killProcess = killProcess;
    this.now = now;
    this.wait = waitFor;
    this.removeTree = removeTree;
    this.inspectPath = inspectPath;
    this.scheduleTimer = scheduleTimer;
    this.cancelTimer = cancelTimer;
    this.groups = new Map();
    this.roots = new Map();
    this.aborted = null;
    this.closing = false;
    this.cleanupPromise = null;
    this.signalPromise = null;
  }

  assertAccepting() {
    if (this.aborted) throw this.aborted;
    if (this.closing) throw gateError("codex_lifecycle_closed");
  }

  ownProcessGroup(child, onAbort = () => {}) {
    this.assertAccepting();
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
      throw gateError("codex_spawn_failed", "missing process group id");
    }
    const existing = this.groups.get(child.pid);
    if (existing && existing.child !== child) {
      throw gateError("codex_process_group_reused", String(child.pid));
    }
    this.groups.set(child.pid, {
      child,
      onAbort,
      cleanupPromise: existing?.cleanupPromise ?? null,
    });
    return child.pid;
  }

  adoptProcessGroupForCleanup(child) {
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
    if (!this.groups.has(child.pid)) {
      this.groups.set(child.pid, {
        child,
        onAbort: () => {},
        cleanupPromise: null,
      });
    }
  }

  ownRoot(root) {
    this.assertAccepting();
    if (typeof root !== "string" || root === "") {
      throw gateError("codex_temp_root_invalid");
    }
    if (!this.roots.has(root)) {
      this.roots.set(root, { cleanupPromise: null });
    }
    return root;
  }

  createRoot(prefix) {
    this.assertAccepting();
    const root = mkdtempSync(prefix);
    this.roots.set(root, { cleanupPromise: null });
    return root;
  }

  abort(error) {
    if (this.aborted) return;
    this.aborted = error;
    for (const record of this.groups.values()) {
      try {
        record.onAbort(error);
      } catch {
        // Cleanup still owns and terminates the process group.
      }
    }
  }

  groupAlive(pgid) {
    try {
      this.killProcess(-pgid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }

  sendGroupSignal(pgid, signal) {
    try {
      this.killProcess(-pgid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }

  async waitForGroupDeath(pgid, graceMs) {
    const expiresAt = this.now() + graceMs;
    while (this.groupAlive(pgid)) {
      const remaining = expiresAt - this.now();
      if (remaining <= 0) return false;
      await this.wait(Math.min(CLEANUP_POLL_MS, remaining));
    }
    return true;
  }

  withDeadline(operation, expiresAt, code) {
    const remaining = expiresAt - this.now();
    if (remaining <= 0) return Promise.reject(gateError(code));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.scheduleTimer(() => {
        if (settled) return;
        settled = true;
        reject(gateError(code));
      }, remaining);
      Promise.resolve(operation).then(
        value => {
          if (settled) return;
          settled = true;
          this.cancelTimer(timer);
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          this.cancelTimer(timer);
          reject(error);
        },
      );
    });
  }

  terminateProcessGroup(pgid, { graceful = true } = {}) {
    const record = this.groups.get(pgid);
    if (!record) return Promise.resolve();
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      if (!this.groupAlive(pgid)) {
        this.groups.delete(pgid);
        return;
      }
      if (graceful) {
        this.sendGroupSignal(pgid, "SIGTERM");
        if (await this.waitForGroupDeath(pgid, CLEANUP_TERM_GRACE_MS)) {
          this.groups.delete(pgid);
          return;
        }
      }
      this.sendGroupSignal(pgid, "SIGKILL");
      if (!(await this.waitForGroupDeath(pgid, CLEANUP_KILL_GRACE_MS))) {
        throw gateError("codex_process_group_survived", String(pgid));
      }
      this.groups.delete(pgid);
    })();
    return record.cleanupPromise;
  }

  removeRoot(root, expiresAt = this.now() + CLEANUP_TOTAL_GRACE_MS) {
    const record = this.roots.get(root);
    if (!record) return Promise.resolve();
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = this.withDeadline(
      (async () => {
        await this.removeTree(root, { force: true, recursive: true });
        try {
          await this.inspectPath(root);
        } catch (error) {
          if (error?.code === "ENOENT") {
            this.roots.delete(root);
            return;
          }
          throw error;
        }
        throw gateError("codex_temp_root_survived", root);
      })(),
      expiresAt,
      "codex_temp_root_cleanup_timeout",
    );
    return record.cleanupPromise;
  }

  cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closing = true;
    const expiresAt = this.now() + CLEANUP_TOTAL_GRACE_MS;
    const groupPromises = [...this.groups.keys()].map(pgid =>
      this.terminateProcessGroup(pgid, { graceful: true }),
    );
    this.cleanupPromise = (async () => {
      const failures = [];
      let groupResults = [];
      try {
        groupResults = await this.withDeadline(
          Promise.allSettled(groupPromises),
          expiresAt,
          "codex_process_cleanup_timeout",
        );
      } catch (error) {
        failures.push(error);
      }
      for (const result of groupResults) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      let rootResults = [];
      try {
        rootResults = await this.withDeadline(
          Promise.allSettled(
            [...this.roots.keys()].map(root =>
              this.removeRoot(root, expiresAt),
            ),
          ),
          expiresAt,
          "codex_temp_root_cleanup_timeout",
        );
      } catch (error) {
        failures.push(error);
      }
      for (const result of rootResults) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "lifecycle_cleanup_failed");
      }
    })();
    return this.cleanupPromise;
  }
}

export function installSignalHandlers(registry, processLike = process) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const previous = new Map(
    signals.map(signal => [signal, processLike.rawListeners(signal)]),
  );
  const installed = new Map();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const signal of signals) {
      processLike.removeListener(signal, installed.get(signal));
      for (const listener of previous.get(signal)) {
        processLike.on(signal, listener);
      }
    }
  };
  const onSignal = signal => {
    if (registry.signalPromise) return;
    const cleanupPromise = registry.cleanup();
    registry.abort(gateError("codex_gate_cancelled", signal));
    registry.signalPromise = (async () => {
      try {
        await cleanupPromise;
      } catch (error) {
        if (processLike.stderr?.write) {
          processLike.stderr.write(renderGateFailure(error));
        }
      } finally {
        restore();
        processLike.kill(processLike.pid, signal);
      }
    })();
  };
  for (const signal of signals) {
    for (const listener of previous.get(signal)) {
      processLike.removeListener(signal, listener);
    }
    const listener = () => onSignal(signal);
    installed.set(signal, listener);
    processLike.on(signal, listener);
  }
  return { restore };
}

const SAFE_AGGREGATE_CATEGORIES = new Set([
  "cleanup_failed",
  "gate_and_cleanup_failed",
  "lifecycle_cleanup_failed",
  "operation_and_cleanup_failed",
]);
const safeProtocolDetail = detail =>
  detail.length <= 128 &&
  /^[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/.test(detail);
const SAFE_DETAIL_VALIDATORS = Object.freeze({
  codex_agent_message_count: detail => /^\d{1,10}$/.test(detail),
  codex_app_server_exited: detail =>
    /^(?:code=(?:null|-?\d{1,10}) signal=(?:null|SIG[A-Z0-9]{1,16})|stopped with pending requests=\d{1,10})$/.test(
      detail,
    ),
  codex_app_server_timeout: safeProtocolDetail,
  codex_feature_surface_changed: detail =>
    /^[a-z][a-z0-9_-]{0,127}$/.test(detail),
  codex_forbidden_event: safeProtocolDetail,
  codex_forbidden_item: detail =>
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(detail),
  codex_gate_cancelled: detail =>
    /^(?:SIGINT|SIGTERM|SIGHUP)$/.test(detail),
  codex_process_group_reused: detail => /^\d{1,20}$/.test(detail),
  codex_process_group_survived: detail => /^\d{1,20}$/.test(detail),
  codex_protocol_schema_mismatch: detail => SAFE_SCHEMA_DETAILS.has(detail),
  codex_response_id_unknown: detail => /^-?\d{1,20}$/.test(detail),
  codex_run_identity_reused: detail =>
    /^(?:root|markerPath|pid|threadId|actionId)$/.test(detail),
  codex_server_request: safeProtocolDetail,
  codex_spawn_failed: detail => detail === "missing process group id",
  codex_turn_count_mismatch: detail => /^\d{1,10}\/\d{1,10}$/.test(detail),
  codex_version_changed: detail =>
    /^(?:executablePath|resolvedPath|device|inode|version)$/.test(detail),
});

function safeStructuredDetail(error) {
  const validator = SAFE_DETAIL_VALIDATORS[error.code];
  return typeof error.detail === "string" && validator?.(error.detail)
    ? error.detail
    : undefined;
}

export function renderGateFailure(error) {
  let category = "codex_gate_failed";
  if (
    typeof error?.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
  ) {
    category = error.code;
    const detail = safeStructuredDetail(error);
    if (detail !== undefined) category += `: ${detail}`;
  } else if (
    error instanceof AggregateError &&
    SAFE_AGGREGATE_CATEGORIES.has(error.message)
  ) {
    category = error.message;
  } else if (error instanceof AggregateError) {
    category = "operation_and_cleanup_failed";
  }
  return `${category}\n`;
}

export function combinePrimaryAndCleanup(primary, cleanup) {
  return cleanup
    ? new AggregateError([primary, cleanup], "operation_and_cleanup_failed")
    : primary;
}

export function runCaptured(
  command,
  args,
  {
    cwd,
    env,
    timeoutMs = 20_000,
    spawnChild = spawn,
    supervisor,
    scheduleTimer = setTimeout,
    cancelTimer = clearTimeout,
  },
) {
  return new Promise((resolve, reject) => {
    supervisor.assertAccepting();
    const child = spawnChild(command, args, {
      cwd,
      detached: true,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let watchdog;

    const finish = (failure, result, graceful) => {
      if (settled) return;
      settled = true;
      const settle = async () => {
        let primaryFailure = failure;
        try {
          cancelTimer(watchdog);
        } catch (error) {
          primaryFailure ??= error;
        }
        if (!primaryFailure && graceful) {
          try {
            if (supervisor.groupAlive(child.pid)) {
              primaryFailure = gateError(
                "codex_process_group_survived",
                String(child.pid),
              );
            }
          } catch (error) {
            primaryFailure = error;
          }
        }
        let cleanupFailure;
        try {
          await supervisor.terminateProcessGroup(child.pid, { graceful });
        } catch (error) {
          cleanupFailure = error;
        }
        if (primaryFailure) {
          reject(combinePrimaryAndCleanup(primaryFailure, cleanupFailure));
        } else if (cleanupFailure) {
          reject(cleanupFailure);
        } else {
          resolve(result);
        }
      };
      void settle().catch(reject);
    };
    child.on("error", () => {
      finish(gateError("codex_spawn_failed"), null, false);
    });
    try {
      supervisor.ownProcessGroup(child, error => {
        finish(error, null, false);
      });
    } catch (error) {
      supervisor.adoptProcessGroupForCleanup(child);
      finish(error, null, false);
      return;
    }
    watchdog = scheduleTimer(() => {
      finish(gateError("codex_command_timeout"), null, false);
    }, timeoutMs);

    const capture = target => chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(gateError("codex_output_limit"), null, false);
        return;
      }
      if (!settled) target.push(chunk);
    };

    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("close", (code, signal) => {
      finish(
        null,
        {
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        },
        true,
      );
    });
  });
}

export class ProcessDeadline {
  constructor(durationMs, now = Date.now, onExpire = () => {}) {
    this.now = now;
    this.onExpire = onExpire;
    this.expiresAt = now() + durationMs;
    this.expired = false;
  }

  expirationError() {
    return gateError("codex_app_server_timeout");
  }

  expire() {
    if (!this.expired) {
      this.expired = true;
      this.onExpire();
    }
    return this.expirationError();
  }

  remaining() {
    const remaining = this.expiresAt - this.now();
    if (remaining <= 0) throw this.expire();
    return remaining;
  }
}

async function assertRemoved(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw gateError("codex_temp_root_survived", path);
}

export function surfaceCleanupFailures(primaryFailure, cleanupFailures) {
  if (cleanupFailures.length === 0) return;
  if (primaryFailure) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "gate_and_cleanup_failed",
    );
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  throw new AggregateError(cleanupFailures, "cleanup_failed");
}

export async function runLifecycleSelfTest({ silent = false } = {}) {
  const createGroupHarness = (pids, termExits = new Set()) => {
    const alive = new Set(pids);
    const signals = [];
    const killProcess = (target, signal) => {
      assert(target < 0);
      const pgid = -target;
      if (signal === 0) {
        if (!alive.has(pgid)) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      signals.push([pgid, signal]);
      if (signal === "SIGKILL" || termExits.has(pgid)) alive.delete(pgid);
    };
    return { alive, killProcess, signals };
  };
  const fakeChild = pid => {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = {
      end() {},
      write(_body, callback) {
        callback?.();
      },
    };
    return child;
  };

  const signalGroups = createGroupHarness([701, 702], new Set([701]));
  let clock = 0;
  const registry = new LifecycleRegistry({
    killProcess: signalGroups.killProcess,
    now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
    },
  });
  const authRoot = registry.createRoot(
    join(tmpdir(), "codex-gate-lifecycle-"),
  );
  await mkdir(join(authRoot, "codex-home"), { mode: 0o700 });
  await writeFile(join(authRoot, "codex-home", "auth.json"), "secret", {
    mode: 0o600,
  });
  let aborted;
  registry.ownProcessGroup(fakeChild(701), error => {
    aborted = error;
    void registry.terminateProcessGroup(701, { graceful: false });
  });
  registry.ownProcessGroup(fakeChild(702));
  const signalProcess = new EventEmitter();
  signalProcess.pid = 99;
  let previousSignals = 0;
  const previousHandler = () => {
    previousSignals += 1;
  };
  signalProcess.once("SIGTERM", previousHandler);
  let laterSignals = 0;
  const reraised = [];
  installSignalHandlers(registry, signalProcess);
  const laterHandler = () => {
    laterSignals += 1;
  };
  signalProcess.on("SIGTERM", laterHandler);
  signalProcess.kill = (pid, signal) => {
    reraised.push([pid, signal]);
    signalProcess.emit(signal);
  };
  signalProcess.emit("SIGTERM");
  const concurrentCleanup = registry.cleanup();
  assert.equal(concurrentCleanup, registry.cleanupPromise);
  await Promise.all([registry.signalPromise, concurrentCleanup]);
  assert.match(aborted.message, /codex_gate_cancelled/);
  assert.deepEqual(signalGroups.alive, new Set());
  assert.deepEqual(signalGroups.signals, [
    [701, "SIGTERM"],
    [702, "SIGTERM"],
    [702, "SIGKILL"],
  ]);
  await assertRemoved(authRoot);
  assert.deepEqual(reraised, [[99, "SIGTERM"]]);
  assert.equal(previousSignals, 1);
  assert.equal(laterSignals, 2);
  assert(!signalProcess.listeners("SIGTERM").includes(previousHandler));

  const acquisitionRegistry = new LifecycleRegistry();
  const acquiredRoot = acquisitionRegistry.createRoot(
    join(tmpdir(), "codex-gate-acquisition-"),
  );
  assert(acquisitionRegistry.roots.has(acquiredRoot));
  const acquisitionCleanup = acquisitionRegistry.cleanup();
  assert.throws(
    () =>
      acquisitionRegistry.createRoot(
        join(tmpdir(), "codex-gate-late-acquisition-"),
      ),
    /codex_lifecycle_closed/,
  );
  await acquisitionCleanup;
  await assertRemoved(acquiredRoot);

  const stalledRootRegistry = new LifecycleRegistry({
    removeTree: () => new Promise(() => {}),
    now: () => 0,
    scheduleTimer(callback) {
      return setImmediate(callback);
    },
    cancelTimer(handle) {
      clearImmediate(handle);
    },
  });
  stalledRootRegistry.ownRoot("/stalled-root");
  await assert.rejects(
    stalledRootRegistry.removeRoot("/stalled-root", 1),
    /codex_temp_root_cleanup_timeout/,
  );

  const timeoutGroups = createGroupHarness([801]);
  const timeoutRegistry = new LifecycleRegistry({
    killProcess: timeoutGroups.killProcess,
    now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
    },
  });
  const retainedPipeChild = fakeChild(801);
  const sensitiveCommand =
    "/home/gate-user/.local/share/codex/0.144.6/bin/codex";
  await assert.rejects(
    runCaptured(sensitiveCommand, [], {
      spawnChild: () => retainedPipeChild,
      supervisor: timeoutRegistry,
      timeoutMs: 1,
      scheduleTimer: callback => {
        queueMicrotask(callback);
        return 1;
      },
      cancelTimer() {},
    }),
    error =>
      error?.code === "codex_command_timeout" &&
      error.message === "codex_command_timeout" &&
      !error.message.includes(sensitiveCommand) &&
      !error.message.includes("/home/gate-user") &&
      !error.message.includes("/tmp/codex-browser-gate-secret"),
  );
  assert.deepEqual(timeoutGroups.alive, new Set());
  assert(timeoutGroups.signals.some(([, signal]) => signal === "SIGKILL"));

  let probeCleanupAttempted = false;
  const probeChild = fakeChild(808);
  const probePromise = runCaptured("fake-probe", [], {
    spawnChild: () => probeChild,
    supervisor: {
      assertAccepting() {},
      ownProcessGroup() {},
      groupAlive() {
        const error = new Error("permission denied");
        error.code = "EPERM";
        throw error;
      },
      async terminateProcessGroup() {
        probeCleanupAttempted = true;
      },
    },
  });
  probeChild.emit("close", 0, null);
  await assert.rejects(
    Promise.race([
      probePromise,
      wait(100).then(() => {
        throw new Error("probe settlement hung");
      }),
    ]),
    /permission denied/,
  );
  assert.equal(probeCleanupAttempted, true);

  const outputGroups = createGroupHarness([802]);
  const outputRegistry = new LifecycleRegistry({
    killProcess: outputGroups.killProcess,
    now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
    },
  });
  const outputChild = fakeChild(802);
  const outputPromise = runCaptured("fake-output", [], {
    spawnChild: () => outputChild,
    supervisor: outputRegistry,
  });
  outputChild.stdout.write(Buffer.alloc(MAX_OUTPUT_BYTES + 1));
  await assert.rejects(outputPromise, /codex_output_limit/);
  assert.deepEqual(outputGroups.alive, new Set());

  const leakedCloseGroups = createGroupHarness([805]);
  const leakedCloseRegistry = new LifecycleRegistry({
    killProcess: leakedCloseGroups.killProcess,
    now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
    },
  });
  const leakedCloseChild = fakeChild(805);
  const leakedClosePromise = runCaptured("fake-close", [], {
    spawnChild: () => leakedCloseChild,
    supervisor: leakedCloseRegistry,
  });
  leakedCloseChild.emit("close", 0, null);
  await assert.rejects(leakedClosePromise, /codex_process_group_survived/);
  assert.deepEqual(leakedCloseGroups.alive, new Set());

  const missingPidChild = fakeChild(undefined);
  const missingPidPromise = runCaptured("fake-missing", [], {
    spawnChild: () => missingPidChild,
    supervisor: new LifecycleRegistry(),
  });
  queueMicrotask(() => {
    missingPidChild.emit("error", new Error("ENOENT"));
  });
  await assert.rejects(missingPidPromise, /codex_spawn_failed/);

  const spawnGroups = createGroupHarness([809]);
  const spawnRegistry = new LifecycleRegistry({
    killProcess: spawnGroups.killProcess,
    now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
    },
  });
  const spawnChild = fakeChild(809);
  const spawnPromise = runCaptured(sensitiveCommand, [], {
    cwd: "/tmp/codex-browser-gate-secret/work",
    spawnChild: () => spawnChild,
    supervisor: spawnRegistry,
  });
  queueMicrotask(() => {
    spawnChild.emit(
      "error",
      new Error(
        `spawn ${sensitiveCommand} from ` +
          "/home/gate-user/.codex and /tmp/codex-browser-gate-secret",
      ),
    );
  });
  await assert.rejects(
    spawnPromise,
    error =>
      error?.code === "codex_spawn_failed" &&
      error.message === "codex_spawn_failed" &&
      !error.message.includes(sensitiveCommand) &&
      !error.message.includes("/home/gate-user") &&
      !error.message.includes("/tmp/codex-browser-gate-secret"),
  );
  assert.deepEqual(spawnGroups.alive, new Set());

  const stubbornAlive = new Set([804]);
  const stubbornSignals = [];
  let stubbornClock = 0;
  const stubbornRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      const pgid = -target;
      if (signal === 0) {
        if (!stubbornAlive.has(pgid)) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      stubbornSignals.push([pgid, signal]);
    },
    now: () => stubbornClock,
    wait: async milliseconds => {
      stubbornClock += milliseconds;
    },
  });
  stubbornRegistry.ownProcessGroup(fakeChild(804));
  const stubbornRoot = stubbornRegistry.createRoot(
    join(tmpdir(), "codex-gate-stubborn-"),
  );
  await assert.rejects(
    stubbornRegistry.cleanup(),
    /codex_process_group_survived/,
  );
  assert.deepEqual(stubbornSignals, [
    [804, "SIGTERM"],
    [804, "SIGKILL"],
  ]);
  assert(stubbornClock <= CLEANUP_TERM_GRACE_MS + CLEANUP_KILL_GRACE_MS);
  await assertRemoved(stubbornRoot);

  const permissionRegistry = new LifecycleRegistry({
    killProcess() {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    },
  });
  const permissionRoot = permissionRegistry.createRoot(
    join(tmpdir(), "codex-gate-permission-"),
  );
  permissionRegistry.ownProcessGroup(fakeChild(806));
  await assert.rejects(permissionRegistry.cleanup(), /permission denied/);
  await assertRemoved(permissionRoot);

  if (process.platform === "linux") {
    const realRegistry = new LifecycleRegistry();
    const descendantScript = [
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("descendant-ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join("");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => {});',
      "spawn(process.execPath,",
      `["-e", ${JSON.stringify(descendantScript)}],`,
      '{ stdio: ["ignore", "inherit", "inherit"] });',
      "setInterval(() => {}, 1000);",
    ].join("");
    const realChild = spawn(process.execPath, ["-e", parentScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    realRegistry.ownProcessGroup(realChild);
    const realClose = new Promise(resolve => realChild.once("close", resolve));
    try {
      await realRegistry.withDeadline(
        new Promise((resolve, reject) => {
          const chunks = [];
          realChild.stdout.on("data", chunk => {
            chunks.push(chunk);
            if (
              Buffer.concat(chunks).includes(Buffer.from("descendant-ready"))
            ) {
              resolve();
            }
          });
          realChild.once("error", reject);
        }),
        realRegistry.now() + 1_000,
        "real_descendant_ready_timeout",
      );
      const cleanupStartedAt = performance.now();
      await realRegistry.terminateProcessGroup(realChild.pid, {
        graceful: true,
      });
      await realRegistry.withDeadline(
        realClose,
        realRegistry.now() + CLEANUP_DRAIN_GRACE_MS,
        "real_process_pipe_drain_timeout",
      );
      const cleanupElapsed = performance.now() - cleanupStartedAt;
      assert(cleanupElapsed >= CLEANUP_TERM_GRACE_MS - CLEANUP_POLL_MS);
      assert(cleanupElapsed < 2_000);
      assert.equal(realRegistry.groupAlive(realChild.pid), false);
    } finally {
      try {
        process.kill(-realChild.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  if (!silent) process.stdout.write("codex_browser_lifecycle: PASS\n");
}
