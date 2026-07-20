import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as contract from "./gate-contract.mjs";
import * as preflight from "./preflight.mjs";

const { gateError, hashFeatureInventory } = contract;
const { parseInvocation, runPreflight } = preflight;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const gatePath = fileURLToPath(new URL("./run.mjs", import.meta.url));

function invokeGate(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gatePath, ...args], {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("gate_characterization_timeout"));
    }, 20_000);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
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
