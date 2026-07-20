import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import * as contract from "./gate-contract.mjs";
import * as preflight from "./preflight.mjs";

const { gateError, hashFeatureInventory } = contract;
const { parseInvocation, runPreflight } = preflight;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const gatePath = fileURLToPath(new URL("./run.mjs", import.meta.url));

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
      });
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
  }
  return processes;
}

function snapshotLinuxDescendantProcessGroups(rootPid) {
  if (process.platform !== "linux" || !Number.isInteger(rootPid)) return [];
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
  return [
    ...new Set(
      processes
        .filter(
          item =>
            item.pid !== rootPid &&
            descendants.has(item.pid) &&
            item.processGroup > 0 &&
            item.processGroup !== ownProcessGroup,
        )
        .map(item => item.processGroup),
    ),
  ];
}

function linuxProcessGroupAlive(processGroup) {
  return readLinuxProcessTable().some(
    item =>
      item.processGroup === processGroup &&
      item.state !== "Z" &&
      item.state !== "X",
  );
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

async function waitForShutdown(
  childClosed,
  descendantGroups,
  processGroupAlive,
  timeoutMs,
  pollMs,
) {
  const deadline = Date.now() + timeoutMs;
  while (
    !childClosed() ||
    descendantGroups.some(processGroup => processGroupAlive(processGroup))
  ) {
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
    snapshotDescendantProcessGroups = snapshotLinuxDescendantProcessGroups,
    killProcessGroup = killLinuxProcessGroup,
    processGroupAlive = linuxProcessGroupAlive,
  },
) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let closed = false;
    let settling = false;
    let settled = false;
    let timer;

    const removeListeners = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
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
      const descendantGroups = snapshotDescendantProcessGroups(child.pid);
      if (!closed) child.kill("SIGTERM");
      const terminated = await waitForShutdown(
        () => closed,
        descendantGroups,
        processGroupAlive,
        termGraceMs,
        pollMs,
      );
      if (!terminated) {
        if (!closed) child.kill("SIGKILL");
        for (const processGroup of descendantGroups) {
          if (processGroupAlive(processGroup)) {
            killProcessGroup(processGroup, "SIGKILL");
          }
        }
        await waitForShutdown(
          () => closed,
          descendantGroups,
          processGroupAlive,
          killGraceMs,
          pollMs,
        );
      }
      finish(reason);
    };
    const beginTermination = reason => {
      void terminate(reason).catch(error => finish(error));
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
      if (!settling) finish(error);
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
    onKill(signal, child);
    return true;
  };
  return child;
}

const timeoutEvents = [];
const aliveDescendantGroups = new Set([901]);
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
    snapshotDescendantProcessGroups: () => [901],
    killProcessGroup(group, signal) {
      timeoutEvents.push(`group:${group}:${signal}`);
      if (signal === "SIGKILL") aliveDescendantGroups.delete(group);
    },
    processGroupAlive: group => aliveDescendantGroups.has(group),
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
  snapshotDescendantProcessGroups: () => [],
  killProcessGroup() {},
  processGroupAlive: () => false,
});
outputChild.stdout.write(Buffer.alloc(5));
await assert.rejects(outputResult, /gate_characterization_output_limit/);
outputEvents.push("rejected");
assert.deepEqual(outputEvents, ["SIGTERM", "close", "rejected"]);

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
  "CODEX_VERSION",
  "CODEX_VERSION_OUTPUT",
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
assert.deepEqual(Object.keys(preflight).toSorted(), [
  "parseInvocation",
  "runPreflight",
]);
assert.equal(contract.CODEX_VERSION_OUTPUT, "codex-cli 0.144.5");
assert.equal(contract.CODEX_VERSION, "0.144.5");
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
for (const name of ["browser_use", "shell_tool", "artifact"]) {
  assert.match(name, contract.TOOL_SURFACE_PATTERN);
}
for (const name of ["remote_compaction_v2", "telemetry"]) {
  assert.doesNotMatch(name, contract.TOOL_SURFACE_PATTERN);
}
for (const eventName of ["command/started", "dynamic-tool", "collab/event"]) {
  assert.match(eventName, contract.FORBIDDEN_EVENT_PATTERN);
}
for (const eventName of ["turn/started", "agentMessage", "reasoning"]) {
  assert.doesNotMatch(eventName, contract.FORBIDDEN_EVENT_PATTERN);
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
assert.equal(detailedError.message, "code: detail");

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
