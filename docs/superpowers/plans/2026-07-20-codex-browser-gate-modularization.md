# Codex Browser Gate Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Gate0 executable into focused modules while preserving every observable CLI, protocol, lifecycle, hashing, and live-loop behavior.

**Architecture:** Keep `run.mjs` as the sole executable and composition root. Extract an acyclic graph of contract, decision-wire, lifecycle, protocol, and preflight modules; preserve one implementation of each policy throughout migration and characterize behavior before changing ownership.

**Tech Stack:** Node.js ESM, Node built-ins only, Codex app-server `0.144.5`, dependency-free lossless JSON canonicalizer, repository Husky hook.

---

## Execution rules

- Work directly in `/home/mamba/work/firecrawl` on current `main`; create no
  worktree or nested repository.
- Preserve unrelated user changes. Never stage anything not listed in the
  task's exact `git add` command.
- Use a fresh implementation subagent for each numbered task. After its
  commit, run a fresh requirements reviewer against this plan and the
  approved design. Only after requirements pass, run a fresh code-quality
  reviewer. The implementing subagent fixes review findings regression-first
  in a separate compliant commit before review repeats.
- Do not run `node scripts/codex-browser-gate/run.mjs`, `--runs 1`, or any
  other live-model path during Tasks 1-5. Named self-tests are deterministic
  and allowed. Run exactly one live `--runs 3` command in Task 6 after all
  deterministic tests and the hook pass.
- If that live command fails, stop and investigate root cause. Never retry it
  as a flakiness workaround.
- Preserve exact stdout, stderr, exit status, error codes, `AggregateError`
  member order, signal behavior, numeric behavior, schema hash framing,
  feature hash framing, and proposal hash bytes.
- Never retain an old implementation beside an extracted implementation.
  In each green step, import the new owner and delete the old definition in
  the same edit. Do not add compatibility shims, test-only export bags, or
  dynamic imports.
- Before every commit: stage exact paths in one command, run
  `apps/api/.husky/_/pre-commit` as a separate command, restage only files the
  hook changed, then use one bare `git commit` with the literal messages shown
  below. No chaining, substitutions, heredocs, wrappers, or bypass flags.

## Locked file structure

| Path | Change | Single responsibility |
|---|---|---|
| `scripts/codex-browser-gate/action-store.mjs` | Retain | Execute-once Gate fixture store; no behavior or export change. |
| `scripts/codex-browser-gate/schema-canonicalizer.mjs` | Retain | Lossless JSON AST, canonical bytes, schema bundle hash. |
| `scripts/codex-browser-gate/schema-canonicalizer.test.mjs` | Retain | Existing canonicalizer regressions. |
| `scripts/codex-browser-gate/gate-characterization.test.mjs` | Create | Exact CLI and module-boundary characterization; no live model calls. |
| `scripts/codex-browser-gate/gate-contract.mjs` | Create | Pinned constants, shared Gate error, feature validation and hash. |
| `scripts/codex-browser-gate/decision-wire.mjs` | Create | Strict decision schema, lossless parse, semantic normalization, proposal hash. |
| `scripts/codex-browser-gate/lifecycle.mjs` | Create | Process groups, roots, deadlines, signals, capture, cleanup composition. |
| `scripts/codex-browser-gate/app-server-protocol.mjs` | Create | Raw JSONL transport, exact numbers, generated schemas, app-server client and event audit. |
| `scripts/codex-browser-gate/preflight.mjs` | Create | CLI parsing, deterministic check ordering, fixtures, named self-test dispatch. |
| `scripts/codex-browser-gate/run.mjs` | Modify | Invocation settlement and exact live two-turn Gate composition only. |

Final dependency direction must be exactly:

```text
decision-wire ---------> gate-contract, schema-canonicalizer
lifecycle -------------> gate-contract
app-server-protocol ---> gate-contract, lifecycle, schema-canonicalizer
preflight -------------> gate-contract, action-store,
                         schema-canonicalizer, decision-wire,
                         lifecycle, app-server-protocol
run -------------------> all runtime modules
```

`action-store.mjs`, `schema-canonicalizer.mjs`, and `gate-contract.mjs` remain
leaves. Protocol accepts `modelDecisionEnvelopeSchema` as turn data and never
imports decision-wire. Lifecycle never imports protocol or decision-wire.

Baseline source ownership map, before Task 1 changes line numbers:

| New owner | Current `run.mjs` source regions |
|---|---|
| `gate-contract.mjs` | Lines 29-140, 305-309, and 874-915. |
| `decision-wire.mjs` | Lines 142-315, decision-only AST conversion from 1071-1100, and lines 1735-1905. |
| `lifecycle.mjs` | Lines 471-871, 1429-1454, 2219-2239, and 3112-3506. |
| `app-server-protocol.mjs` | Lines 317-469, 917-1427, 1456-1733, 1907-2217, protocol cases in 2609-2944, and 2946-3110. |
| `preflight.mjs` | Lines 2539-2607, cross-owner orchestration cases from 2609-2944, and 3508-3542 plus 3589-3607. |

Where a hardening region contains cases for multiple owners, extract each
case according to the explicit Task 2-5 fixture assignments below; never copy
the complete region into more than one module.

### Locked production interfaces

Use these signatures exactly:

```js
// gate-contract.mjs
export const CODEX_VERSION_OUTPUT = "codex-cli 0.144.5";
export const CODEX_VERSION = "0.144.5";
export const MODEL = "gpt-5.6-terra";
export const EFFORT = "medium";
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const WATCHDOG_MS = 120_000;
export const MAX_RUNS = 10;
export function gateError(code, detail) {}
export function hashFeatureInventory(output) {}

// decision-wire.mjs
export const modelDecisionEnvelopeSchema = {};
export function parseModelDecisionEnvelopeV1(rawText) {}
export function normalizeModelDecisionEnvelopeV1(envelope) {}
export function normalizedProposalHash(operation) {}
export async function runDecisionWireSelfTest({ silent = false } = {}) {}

// lifecycle.mjs
export class LifecycleRegistry {}
export class ProcessDeadline {}
export function installSignalHandlers(registry, processLike = process) {}
export function runCaptured(command, args, options) {}
export function combinePrimaryAndCleanup(primary, cleanup) {}
export function surfaceCleanupFailures(primaryFailure, cleanupFailures) {}
export async function runLifecycleSelfTest({ silent = false } = {}) {}

// app-server-protocol.mjs
export async function schemaHash(schemaDir) {}
export async function loadEventSchemas(schemaDir) {}
export function assertGeneratedSchemaValue(value, schemaSource) {}
export class AppServerClient {}
export async function startTurn(
  client,
  threadId,
  prompt,
  eventSchemas,
  outputSchema,
) {}
export function extractTurnAgentMessageText(
  { turn, messages },
  { threadId, turnId },
) {}
export function runUnloadedTurnRegression(eventSchemas) {}
export function assertNoLateTurnMessages(
  allMessages,
  result,
  { threadId, turnId },
) {}
export function auditAllAppServerEvents(messages, knownTurns) {}
export async function runProtocolHardeningSelfTest(
  { silent = false } = {},
) {}
export async function runTransportSelfTest({ silent = false } = {}) {}

// preflight.mjs
export function parseInvocation(args, checks) {}
export async function runPreflight(checks) {}
```

Also export the remaining immutable contract values named by the approved
design: all five cleanup timing constants, `REQUIRED_SCHEMA_DEFINITIONS`,
`CONFIG`, `DISABLED_FEATURES`, `REVIEWED_ENABLED_NON_TOOL_FEATURES`,
`TOOL_SURFACE_PATTERN`, `FORBIDDEN_EVENT_PATTERN`, and
`ALLOWED_ITEM_TYPES`. Export nothing else from production modules.

## Task 1: Characterize CLI and extract the contract leaf

**Files:**

- Create: `scripts/codex-browser-gate/gate-characterization.test.mjs`
- Create: `scripts/codex-browser-gate/gate-contract.mjs`
- Create: `scripts/codex-browser-gate/preflight.mjs`
- Modify: `scripts/codex-browser-gate/run.mjs`

- [ ] **Step 1: Add failing characterization imports and exact assertions**

Create `gate-characterization.test.mjs` with a subprocess helper that always
uses `process.execPath`, `shell: false`, repository root as `cwd`, and a
20-second timeout. It must never invoke the no-argument or valid `--runs`
path. Use this helper and assertion table verbatim:

```js
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
  ["--action-store-self-test",
    "codex_browser_action_store: PASS writes=1 records=1\n"],
  ["--hardening-self-test",
    "codex_browser_format_hardening: PASS\n" +
      "codex_browser_hardening: PASS\n"],
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
```

Statically import contract and preflight exports. Assert:

```js
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
```

Pass an injected self-test check object to `parseInvocation` and assert each accepted
flag returns its exact function object. Assert an injected hardening failure
stops the order before transport or lifecycle. Assert `gateError("code",
"detail")` has `.code === "code"` and `.message === "code: detail"`.

Build a synthetic feature fixture from all exported disabled names at stage
`experimental`, plus all reviewed enabled names at their pinned stages.
Assert its hash is exactly:

```text
543779f017f80fa9ceb4f1b99b1b2b1734dad37c5237506d000a47fdd3890c2b
```

Assert duplicate names, missing disabled names, enabled tool-surface names
outside the reviewed map, and empty input all throw
`codex_feature_surface_changed`. Finish with exactly:

```js
process.stdout.write("codex_browser_gate_characterization: PASS\n");
```

- [ ] **Step 2: Run the characterization and verify the missing boundary**

Run:

```bash
node scripts/codex-browser-gate/gate-characterization.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `gate-contract.mjs` or
`preflight.mjs`. No live Codex process starts.

- [ ] **Step 3: Extract constants, feature hashing, and CLI/preflight order**

Create `gate-contract.mjs` by transferring the current literal declarations
from `run.mjs` without changing bytes or values. `gateError` remains:

```js
export function gateError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}
```

Rename only `parseFeatureInventory` to exported
`hashFeatureInventory(output)`. Keep its parser, policy checks, sort,
tab/newline framing, and SHA-256 body unchanged.

Create `preflight.mjs` with exact argument grammar and injectable checks:

```js
export function parseInvocation(args, checks = {}) {
  const selfTests = new Map([
    ["--action-store-self-test", checks.actionStore],
    ["--hardening-self-test", checks.hardening],
    ["--lifecycle-self-test", checks.lifecycle],
    ["--transport-self-test", checks.transport],
  ]);
  if (args.length === 1 && selfTests.has(args[0])) {
    return { selfTest: selfTests.get(args[0]) };
  }
  if (args.length === 0) return { runCount: 3 };
  if (
    args.length !== 2 ||
    args[0] !== "--runs" ||
    !/^[1-9]\d*$/.test(args[1])
  ) {
    throw gateError("codex_gate_arguments_invalid");
  }
  const runCount = Number(args[1]);
  if (!Number.isSafeInteger(runCount) || runCount > MAX_RUNS) {
    throw gateError("codex_gate_arguments_invalid");
  }
  return { runCount };
}

export async function runPreflight(checks = {}) {
  await checks.actionStore({ silent: true });
  await checks.hardening({ silent: true });
  await checks.transport({ silent: true });
  await checks.lifecycle({ silent: true });
}
```

During migration, `run.mjs` must pass its current four fixture functions.
Task 5 adds module-owned defaults and removes that temporary injection; the
functions above already own argument grammar and check order, so no policy is
duplicated.

Modify `run.mjs` to import every extracted value. Delete its matching constant
block, `gateError`, `parseFeatureInventory`, `parseRunCount`, `parseInvocation`,
and `runPreflight`. Change the live feature call to
`hashFeatureInventory(featureResult.stdout)`. Call imported `parseInvocation`
and `runPreflight` with the four current fixture functions until Task 5.

- [ ] **Step 4: Run focused syntax and deterministic checks**

Run each command separately:

```bash
node --check scripts/codex-browser-gate/gate-contract.mjs
node --check scripts/codex-browser-gate/preflight.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
git diff --check
```

Expected outputs:

```text
codex_browser_gate_characterization: PASS
codex_browser_format_hardening: PASS
codex_browser_hardening: PASS
codex_browser_schema_canonicalizer: PASS cases=41
```

`node --check` and `git diff --check` emit nothing and exit `0`.

- [ ] **Step 5: Stage, hook, and commit only Task 1 files**

Run separately:

```bash
git add scripts/codex-browser-gate/gate-characterization.test.mjs scripts/codex-browser-gate/gate-contract.mjs scripts/codex-browser-gate/preflight.mjs scripts/codex-browser-gate/run.mjs
apps/api/.husky/_/pre-commit
git commit -m "test: characterize Codex gate contract" -m "Lock exact CLI dispatch, feature hashing, and preflight order before
extracting the remaining Gate responsibilities.

Centralize immutable runtime policy without changing live behavior."
```

Expected: hook exits `0`; commit succeeds on first attempt.

## Task 2: Extract strict decision-wire ownership

**Files:**

- Create: `scripts/codex-browser-gate/decision-wire.mjs`
- Modify: `scripts/codex-browser-gate/gate-characterization.test.mjs`
- Modify: `scripts/codex-browser-gate/run.mjs`
- Modify: `scripts/codex-browser-gate/preflight.mjs`

- [ ] **Step 1: Add failing decision interface assertions**

Extend characterization with a static namespace import and exact export list:

```js
assert.deepEqual(Object.keys(decisionWire).toSorted(), [
  "modelDecisionEnvelopeSchema",
  "normalizeModelDecisionEnvelopeV1",
  "normalizedProposalHash",
  "parseModelDecisionEnvelopeV1",
  "runDecisionWireSelfTest",
]);
```

Add assertions for both valid branches and the lossless duplicate-key guard:

```js
assert.deepEqual(
  parseModelDecisionEnvelopeV1(
    '{"decision":{"version":1,"type":"action","action":' +
      '{"kind":"fill","ref":"gate-marker","value":"approved"}}}',
  ),
  {
    decision: {
      version: 1,
      type: "action",
      action: { kind: "fill", ref: "gate-marker", value: "approved" },
    },
  },
);
assert.deepEqual(
  normalizeModelDecisionEnvelopeV1(
    parseModelDecisionEnvelopeV1(
      '{"decision":{"version":1,"type":"final",' +
        '"output":"gate-complete"}}',
    ),
  ),
  { version: 1, type: "final", output: "gate-complete" },
);
assert.throws(
  () => parseModelDecisionEnvelopeV1(
    '{"decision":{"version":1,"type":"final","type":"action",' +
      '"output":"gate-complete"}}',
  ),
  /model_protocol_error/,
);
```

Assert proposal hash equality for ordered/permuted operations and inequality
after a changed value. Invoke `runDecisionWireSelfTest({ silent: true })` and
assert it writes nothing.

- [ ] **Step 2: Run and confirm the new owner is absent**

Run:

```bash
node scripts/codex-browser-gate/gate-characterization.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `decision-wire.mjs`.

- [ ] **Step 3: Create decision-wire and delete old decision code**

Create `decision-wire.mjs` with imports limited to:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gateError } from "./gate-contract.mjs";
import {
  canonicalizeJsonBytes,
  parseLosslessJson,
} from "./schema-canonicalizer.mjs";
```

Transfer these current implementations as one ownership unit: `closed`,
`stringLiteral`, `versionOne`, every decision schema node,
`auditModelDecisionSchema`, `hasExactKeys`, `modelProtocolError`,
`validString`, `validInteger`, `validateModelWireBrowserOperationV1`,
`validateModelDecisionEnvelopeV1`, `normalizeModelDecisionEnvelopeV1`, and
`normalizedProposalHash`.

Implement `parseModelDecisionEnvelopeV1(rawText)` as the only model-output
boundary:

```js
export function parseModelDecisionEnvelopeV1(rawText) {
  try {
    const envelope = losslessJsonNodeToPlainValue(
      parseLosslessJson(Buffer.from(rawText, "utf8")),
    );
    validateModelDecisionEnvelopeV1(envelope);
    return envelope;
  } catch {
    throw gateError("model_protocol_error");
  }
}
```

Keep its AST-to-plain helper private, preserving duplicate decoded-key,
unsafe-number, malformed UTF-8, and closed-object rejection. Keep
`normalizedProposalHash` byte-identical: canonicalize UTF-8 bytes from
`JSON.stringify(operation)`, then SHA-256.

Move all decision-schema and decision-message cases currently embedded in
`hardeningSelfTest` into `runDecisionWireSelfTest`. It writes no PASS line,
even when `silent` is false, because no such line exists in the public CLI.

During this task, keep turn event correlation in `run.mjs`. Change the final
three lines of private `parseTurnEnvelope` so it delegates only decision
parsing to the new owner:

```js
return parseModelDecisionEnvelopeV1(event.params.item.text);
```

Delete every transferred decision definition from `run.mjs`. Task 4 replaces
private `parseTurnEnvelope` with protocol-owned raw text extraction and direct
calls to `parseModelDecisionEnvelopeV1` for both turns. Update the transitional
hardening fixture to call `runDecisionWireSelfTest({ silent: true })` instead
of duplicating cases.

- [ ] **Step 4: Run decision and existing deterministic checks**

Run separately:

```bash
node --check scripts/codex-browser-gate/decision-wire.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/run.mjs --action-store-self-test
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
git diff --check
```

Expected PASS lines remain exactly the established characterization,
two-line hardening, action-store, and
`codex_browser_schema_canonicalizer: PASS cases=41` outputs.

- [ ] **Step 5: Stage, hook, and commit only Task 2 files**

```bash
git add scripts/codex-browser-gate/decision-wire.mjs scripts/codex-browser-gate/gate-characterization.test.mjs scripts/codex-browser-gate/preflight.mjs scripts/codex-browser-gate/run.mjs
apps/api/.husky/_/pre-commit
git commit -m "refactor: extract Codex decision wire" -m "Move strict decision schemas, lossless parsing, normalization, and
proposal hashing behind one focused module.

Keep model-wire validation and observable Gate behavior unchanged."
```

Expected: hook exits `0`; commit succeeds on first attempt.

## Task 3: Extract lifecycle supervision

**Files:**

- Create: `scripts/codex-browser-gate/lifecycle.mjs`
- Modify: `scripts/codex-browser-gate/gate-characterization.test.mjs`
- Modify: `scripts/codex-browser-gate/run.mjs`
- Modify: `scripts/codex-browser-gate/preflight.mjs`

- [ ] **Step 1: Add failing lifecycle export and cleanup assertions**

Add a static namespace import and assert the exact seven exports listed in
the locked interface. Add pure assertions:

```js
const primary = new Error("primary");
const cleanup = new Error("cleanup");
assert.equal(combinePrimaryAndCleanup(primary), primary);
assert.throws(
  () => surfaceCleanupFailures(primary, [cleanup]),
  error => error instanceof AggregateError &&
    error.errors[0] === primary && error.errors[1] === cleanup,
);
assert.throws(
  () => surfaceCleanupFailures(undefined, [cleanup]),
  error => error === cleanup,
);
```

Construct `ProcessDeadline(10, now, onExpire)` with an injected clock. Assert
`remaining()` returns `10`, then `1`, and after expiration throws exactly
`codex_app_server_timeout` while calling `onExpire` once across repeated
`expire()` calls.

- [ ] **Step 2: Run and confirm lifecycle module is absent**

```bash
node scripts/codex-browser-gate/gate-characterization.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lifecycle.mjs`.

- [ ] **Step 3: Create lifecycle module with explicit registry ownership**

Create `lifecycle.mjs` with only Node built-ins plus `gate-contract.mjs`.
Transfer `wait`, `LifecycleRegistry`, `installSignalHandlers`,
`combinePrimaryAndCleanup`, `runCaptured`, `ProcessDeadline`,
`assertRemoved`, `surfaceCleanupFailures`, and every lifecycle fixture from
the current `lifecycleSelfTest`.

Preserve these exact API shapes and ownership rules:

```js
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
) {}

export class ProcessDeadline {
  constructor(durationMs, now = Date.now, onExpire = () => {}) {}
  expirationError() {}
  expire() {}
  remaining() {}
}
```

`runCaptured` must require the invocation registry as `supervisor`; remove
the old implicit `gateLifecycle` default. Every `run.mjs` capture call passes
`supervisor: gateLifecycle`, including `codex --version`, schema generation,
and feature discovery. `AppServerClient` remains temporarily in `run.mjs` but
imports `ProcessDeadline` and receives the same registry explicitly.

Keep all injected clocks, timers, kill/stat/remove functions, negative-PGID
signals, TERM/KILL escalation, close drain, idempotent cleanup promises, root
mode/removal checks, signal listener restoration, and original-signal
re-raise unchanged. Move the real Linux parent-plus-descendant fixture into
`runLifecycleSelfTest`; it remains active for both silent preflight and the
named self-test. Only non-silent execution writes:

```text
codex_browser_lifecycle: PASS
```

Delete all transferred definitions and fixtures from `run.mjs`; import the
new interfaces. Transitional preflight injection calls
`runLifecycleSelfTest` from its new owner.

- [ ] **Step 4: Run lifecycle, transport, and signal-adjacent checks**

```bash
node --check scripts/codex-browser-gate/lifecycle.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --lifecycle-self-test
node scripts/codex-browser-gate/run.mjs --transport-self-test
node scripts/codex-browser-gate/run.mjs --hardening-self-test
git diff --check
```

Expected named outputs remain byte-exact. Syntax and diff checks emit
nothing.

- [ ] **Step 5: Stage, hook, and commit only Task 3 files**

```bash
git add scripts/codex-browser-gate/lifecycle.mjs scripts/codex-browser-gate/gate-characterization.test.mjs scripts/codex-browser-gate/preflight.mjs scripts/codex-browser-gate/run.mjs
apps/api/.husky/_/pre-commit
git commit -m "refactor: extract Codex gate lifecycle" -m "Centralize detached process groups, deadlines, signal handling, and
cleanup ordering behind an invocation-owned registry.

Retain every fake-process case and real descendant cleanup fixture."
```

Expected: hook exits `0`; commit succeeds on first attempt.

## Task 4: Extract lossless app-server protocol

**Files:**

- Create: `scripts/codex-browser-gate/app-server-protocol.mjs`
- Modify: `scripts/codex-browser-gate/gate-characterization.test.mjs`
- Modify: `scripts/codex-browser-gate/run.mjs`
- Modify: `scripts/codex-browser-gate/preflight.mjs`

- [ ] **Step 1: Add failing protocol export and boundary assertions**

Add a static namespace import and assert exactly these eleven exports:

```js
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
```

Assert the literal list length is `11` to catch accidental exports. Add direct
generated-schema cases using only trusted plain fixture values:

```js
assert.equal(
  assertGeneratedSchemaValue(1, { schema: { type: "integer" } }),
  1,
);
assert.throws(
  () => assertGeneratedSchemaValue(1.5, {
    schema: { type: "integer" },
  }),
  /codex_protocol_schema_mismatch/,
);
```

Invoke both protocol runners silently and assert no new stdout. Keep raw
transport-number, framer, parser, schema AST conversion, fake children, and
fixture constructors inaccessible.

- [ ] **Step 2: Run and confirm protocol module is absent**

```bash
node scripts/codex-browser-gate/gate-characterization.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`app-server-protocol.mjs`.

- [ ] **Step 3: Create protocol module and preserve exact-number flow**

Create `app-server-protocol.mjs` with this import boundary:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import {
  ALLOWED_ITEM_TYPES,
  CLEANUP_DRAIN_GRACE_MS,
  FORBIDDEN_EVENT_PATTERN,
  MAX_OUTPUT_BYTES,
  MODEL,
  EFFORT,
  REQUIRED_SCHEMA_DEFINITIONS,
  WATCHDOG_MS,
  gateError,
} from "./gate-contract.mjs";
import { LifecycleRegistry, ProcessDeadline } from "./lifecycle.mjs";
import {
  hashCanonicalSchemaBundle,
  parseLosslessJson,
} from "./schema-canonicalizer.mjs";
```

Transfer these policies as a single unit and delete them from `run.mjs`:

- `RawJsonlFramer`, private `TRANSPORT_JSON_NUMBER`, exact-number parsing,
  comparison and safe materialization;
- `parseAppServerMessage`, schema AST conversion, supported-keyword audit,
  recursive generated-schema matching, `schemaHash`, and `loadEventSchemas`;
- `AppServerClient`, turn params/start/wait, unloaded-turn regression,
  correlated agent-message extraction, per-turn audit, no-late-message check,
  and global event audit;
- all protocol-format and transport fixtures presently inside hardening and
  transport self-tests.

Keep `TRANSPORT_JSON_NUMBER`, raw framer, AST converters, exact arithmetic,
schema validator, and fixture constructors private. The transport number must
remain wrapped until response correlation and generated-schema validation
finish. Do not use ordinary `JSON.parse` at inbound boundaries.

Require explicit client lifecycle ownership:

```js
new AppServerClient({
  cwd,
  env,
  eventsPath,
  supervisor,
  deadline,
  spawnChild,
  scheduleTimer,
  cancelTimer,
});
```

No constructor default may reference a module-global registry. Preserve the
one absolute 120-second `ProcessDeadline`, aggregate output cap, raw stdout
frame storage, response-ID correlation, close-drain, and cleanup failure
surface.

Change `startTurn` to receive the decision schema as data. It validates the
same params/response/event schemas and returns `{ turn, messages }`:

```js
await startTurn(
  client,
  threadId,
  prompt,
  eventSchemas,
  modelDecisionEnvelopeSchema,
);
```

`extractTurnAgentMessageText` performs the existing completed-turn identity,
status, error, itemsView, exactly-one-agent-message, thread/turn ID, item ID,
and text checks, then returns only raw `item.text`. Decision parsing remains
in decision-wire.

`runProtocolHardeningSelfTest({ silent: false })` writes exactly
`codex_browser_format_hardening: PASS\n`. `runTransportSelfTest` writes its
existing one-line PASS output. Move all corresponding fixture bodies; do not
export them.

- [ ] **Step 4: Run protocol, decision, lifecycle, and canonical checks**

```bash
node --check scripts/codex-browser-gate/app-server-protocol.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/run.mjs --transport-self-test
node scripts/codex-browser-gate/run.mjs --lifecycle-self-test
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
git diff --check
```

Expected: all exact PASS outputs match the baseline; checks emit no extra
lines.

- [ ] **Step 5: Stage, hook, and commit only Task 4 files**

```bash
git add scripts/codex-browser-gate/app-server-protocol.mjs scripts/codex-browser-gate/gate-characterization.test.mjs scripts/codex-browser-gate/preflight.mjs scripts/codex-browser-gate/run.mjs
apps/api/.husky/_/pre-commit
git commit -m "refactor: extract Codex app-server protocol" -m "Isolate raw JSONL framing, exact transport numbers, generated schema
validation, and correlated turn event handling.

Keep decision schemas injected and preserve all transport failure modes."
```

Expected: hook exits `0`; commit succeeds on first attempt.

## Task 5: Finish preflight ownership and thin executable composition

**Files:**

- Modify: `scripts/codex-browser-gate/preflight.mjs`
- Modify: `scripts/codex-browser-gate/gate-characterization.test.mjs`
- Modify: `scripts/codex-browser-gate/run.mjs`

- [ ] **Step 1: Add failing final-boundary and duplicate-owner assertions**

Update characterization to assert the final preflight export inventory is
exactly `parseInvocation` and `runPreflight`. Read production source files as
text and assert:

```js
assert.doesNotMatch(runSource, /class RawJsonlFramer/);
assert.doesNotMatch(runSource, /class LifecycleRegistry/);
assert.doesNotMatch(runSource, /class ProcessDeadline/);
assert.doesNotMatch(runSource, /function generatedSchemaMatches/);
assert.doesNotMatch(runSource, /function validateModelDecisionEnvelopeV1/);
assert.doesNotMatch(runSource, /function actionStoreSelfTest/);
assert.doesNotMatch(runSource, /function hardeningSelfTest/);
assert.doesNotMatch(runSource, /function transportSelfTest/);
assert.doesNotMatch(runSource, /function lifecycleSelfTest/);
assert.doesNotMatch(runSource, /^export\s/m);
```

Statically imported namespace assertions from Tasks 1-4 must match every
locked export exactly. Add a source-level import graph assertion that rejects
imports of `preflight.mjs` or `run.mjs` from contract, lifecycle, decision,
or protocol; rejects decision-wire imports from protocol; and rejects any
dynamic `import(` in production Gate modules.

Extract private `prepareGate` from `runSource` and assert its
`await runPreflight()` occurrence precedes its `runCaptured("codex",
["--version"]` occurrence. This preserves preflight-before-version ordering
without exporting a test-only runtime seam. Do not add a summary formatter
export; final live acceptance characterizes its exact bytes.

- [ ] **Step 2: Run and observe duplicate fixture ownership failure**

```bash
node scripts/codex-browser-gate/gate-characterization.test.mjs
```

Expected: FAIL because fixture bodies or old owner definitions still occur in
`run.mjs`.

- [ ] **Step 3: Make preflight the sole deterministic fixture coordinator**

In `preflight.mjs`, import the explicit owner runners and define one private
default check object:

```js
const defaultChecks = {
  actionStore: runActionStoreSelfTest,
  hardening: runHardeningSelfTest,
  transport: runTransportSelfTest,
  lifecycle: runLifecycleSelfTest,
};
```

Keep the action-store fixture private in this module as
`runActionStoreSelfTest`. It creates its root through a local
`LifecycleRegistry`, uses unchanged action bytes, asserts replay/mismatch/
write count/record state/marker bytes/mode, cleans its root, and writes only:

```text
codex_browser_action_store: PASS writes=1 records=1
```

Define private `runHardeningSelfTest({ silent })` with this exact order:

```js
await runDecisionWireSelfTest({ silent: true });
await runProtocolHardeningSelfTest({ silent });
await runCrossModuleHardeningSelfTest({ silent: true });
if (!silent) process.stdout.write("codex_browser_hardening: PASS\n");
```

The private cross-module fixture owns only CLI grammar, preflight
short-circuit/order, feature hash framing, cleanup error integration, and any
assertion spanning more than one owner. It must not reimplement a parser,
validator, lifecycle primitive, or hash.

Final `parseInvocation(args, checks = defaultChecks)` returns a function only
for the four exact one-argument self-test flags. `runPreflight(checks =
defaultChecks)` silently runs action-store, hardening, transport, lifecycle in
that order. Extra self-test arguments continue through run-count rejection.

- [ ] **Step 4: Reduce run.mjs to live scenario and settlement**

Delete transitional fixture injection and all deterministic fixture bodies.
`run.mjs` must contain only:

- imports, `INITIAL_OBSERVATION`, exact prompt assembly, and `requireExact`;
- `prepareGate`, `runOne`, aggregation/final PASS formatting, and `main`;
- one invocation-level `LifecycleRegistry`, installed signal handlers,
  `invoke`, cleanup settlement, stderr rendering, and exit-code assignment.

Construct one registry and pass it to every `runCaptured` call and every
`AppServerClient`. Pass `modelDecisionEnvelopeSchema` to each `startTurn`.
Use `extractTurnAgentMessageText` followed by
`parseModelDecisionEnvelopeV1`. Preserve exact prompt strings, observation
bytes, marker checks, action store replay/mismatch, identity checks, counts,
hashes, result field order, and raw event storage.

Keep `turnInput` private in `app-server-protocol.mjs`. For
`runUnloadedTurnRegression`, validate both generated schemas, extract the raw
agent text, assert it equals `JSON.stringify(wrappedFinal)`, and retain the
three exact timing assertions. Do not import decision-wire into protocol.

Top-level settlement remains semantically:

```js
const gateLifecycle = new LifecycleRegistry();
const signalHandlers = installSignalHandlers(gateLifecycle);
const invocation = invoke(process.argv.slice(2));

async function settleInvocation() {
  let primaryFailure;
  try { await invocation; } catch (error) { primaryFailure = error; }
  let cleanupFailure;
  try { await gateLifecycle.cleanup(); }
  catch (error) { cleanupFailure = error; }
  finally { signalHandlers.restore(); }
  if (primaryFailure) {
    throw combinePrimaryAndCleanup(primaryFailure, cleanupFailure);
  }
  if (cleanupFailure) throw cleanupFailure;
}
```

Do not change final stderr rendering or `process.exitCode = 1`.

- [ ] **Step 5: Run the complete deterministic suite, but no live Gate**

Run separately:

```bash
node --check scripts/codex-browser-gate/gate-contract.mjs
node --check scripts/codex-browser-gate/decision-wire.mjs
node --check scripts/codex-browser-gate/lifecycle.mjs
node --check scripts/codex-browser-gate/app-server-protocol.mjs
node --check scripts/codex-browser-gate/preflight.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --action-store-self-test
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/run.mjs --transport-self-test
node scripts/codex-browser-gate/run.mjs --lifecycle-self-test
git diff --check
```

Expected, in command order:

```text
codex_browser_schema_canonicalizer: PASS cases=41
codex_browser_gate_characterization: PASS
codex_browser_action_store: PASS writes=1 records=1
codex_browser_format_hardening: PASS
codex_browser_hardening: PASS
codex_browser_transport: PASS
codex_browser_lifecycle: PASS
```

No syntax or diff check emits output.

- [ ] **Step 6: Stage, hook, and commit only Task 5 files**

```bash
git add scripts/codex-browser-gate/preflight.mjs scripts/codex-browser-gate/gate-characterization.test.mjs scripts/codex-browser-gate/run.mjs
apps/api/.husky/_/pre-commit
git commit -m "refactor: compose modular Codex gate" -m "Make preflight the sole deterministic fixture coordinator and reduce
the executable to live scenario orchestration and settlement.

Enforce the locked export inventory and acyclic dependency graph."
```

Expected: hook exits `0`; commit succeeds on first attempt.

## Task 6: Final verification, single live acceptance, and reviews

**Files:**

- Verify: all files under `scripts/codex-browser-gate/`
- Review: `docs/superpowers/specs/2026-07-20-codex-browser-gate-modularization-design.md`
- Review: `docs/superpowers/specs/2026-07-19-local-browser-interact-runtime-design.md`

- [ ] **Step 1: Confirm clean state and run deterministic checks once more**

Run every command separately:

```bash
git status --short
node --check scripts/codex-browser-gate/gate-contract.mjs
node --check scripts/codex-browser-gate/decision-wire.mjs
node --check scripts/codex-browser-gate/lifecycle.mjs
node --check scripts/codex-browser-gate/app-server-protocol.mjs
node --check scripts/codex-browser-gate/preflight.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --action-store-self-test
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/run.mjs --transport-self-test
node scripts/codex-browser-gate/run.mjs --lifecycle-self-test
git diff --check
apps/api/.husky/_/pre-commit
```

Expected: status and check commands are silent; exact PASS lines match Task 5;
hook exits `0`. If any check fails, fix root cause with a failing regression,
commit under the same hook rules, and rerun requirements then quality review
before proceeding.

- [ ] **Step 2: Run exactly one fresh live three-run acceptance**

Run once:

```bash
node scripts/codex-browser-gate/run.mjs --runs 3
```

Expected exactly one stdout line, no stderr, and exit `0`:

```text
codex_browser_gate: PASS runs=3 version=0.144.5 model=gpt-5.6-terra effort=medium turns=6 actions=3 writes=3 tools=0 approvals=0 schema=86eb6780e1bfbf2d16d4fca5253e36b850203801489b59a51c1652e6af66f113 features=ead8f14dffc481ede409bc711a153d676c6e9fd6c8f6b17a378720648adab042
```

Both hashes must each be stable across all three internal runs. This command
also proves silent preflight emitted no lines, each run used distinct root,
marker, PID, thread, and action IDs, and no tool or approval event occurred.

- [ ] **Step 3: Run final requirements review**

Give a fresh reviewer the five implementation commits, this plan, both design
documents, and live output. Require explicit checks for all twelve success
criteria in the modularization design, exact export inventory, acyclic imports,
no duplicated policy, no weakened exact-number boundary, raw event bytes,
cleanup/error ordering, and forbidden scope expansion.

Expected: `PASS` with no unresolved requirement gaps. Any finding returns to
its owning task. Add a failing characterization first, implement the narrow
fix, run affected deterministic checks and hook, commit, then repeat this
requirements review. Rerun live acceptance only if the correction can affect
live behavior; if so, run it once after all deterministic checks pass.

- [ ] **Step 4: Run final code-quality review**

Only after requirements pass, give a different fresh reviewer the final diff
and verification evidence. Require checks for focused responsibilities,
private helpers, explicit dependency injection, absence of mutable module
singletons, error specificity, cleanup on every path, readable composition,
and no test-only production exports.

Expected: `PASS` with no unresolved quality findings. Fix findings narrowly,
regression-first, under the same hook and review rules.

- [ ] **Step 5: Confirm final repository state**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: clean status. Log contains the five scoped implementation commits
in dependency order, plus the preceding approved plan commit. No durable
state, Browser Service, host adapter, dependency, Codex version, model,
effort, config, or feature-policy change is present.
