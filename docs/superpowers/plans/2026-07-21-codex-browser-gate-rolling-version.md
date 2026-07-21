# Codex Browser Gate Rolling-Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Browser Interact Gate validate and reuse active `codex` from `PATH` across compatible upgrades while preserving every capability and safety check.

**Architecture:** Add one dependency-injected executable-identity module for strict SemVer parsing, first-`PATH` resolution, filesystem identity capture, and pre/post comparison. Pass its absolute selected path through schema, feature, and app-server launches; frame generated schemas with one release-neutral logical prefix. Keep model `gpt-5.6-terra`, reasoning effort `medium`, protocol validation, feature policy, live action loop, output contract, and lifecycle behavior unchanged.

**Tech Stack:** Node.js 22 ESM, `node:test`-free assertion scripts, Codex app-server V2, lossless JSON canonicalization, SHA-256, Git hooks.

---

## Execution rules

- Work directly on current `main` in `/home/mamba/work/firecrawl`; do not create a worktree or nested checkout.
- Tests in this approved plan are authorized. Do not install or upgrade tools.
- For each numbered implementation task, dispatch one fresh implementer. After its focused checks and commit, dispatch a requirements reviewer, then a code-quality reviewer. Route findings back to that task's implementer, rerun checks, and repeat both reviews before continuing.
- Stage only paths named by each task. Before each commit, run the actual hook `apps/api/.husky/_/pre-commit`. Commit once with one bare `git commit`, literal `-m` arguments, and body lines no longer than 72 characters.
- Preserve `MODEL = "gpt-5.6-terra"`, `EFFORT = "medium"`, exact feature policy, all generated-schema checks, `approvalPolicy: "never"`, `sandbox: "read-only"`, empty tool/environment/workspace-root lists, action replay/mismatch checks, event audit, run isolation, timeout, signal, and cleanup behavior.
- Deterministic tests must not call live Codex. Only Task 5 runs the live three-run Gate.

## File map

| File | Responsibility |
|---|---|
| `scripts/codex-browser-gate/codex-executable.mjs` | Strict version parser, first-`PATH` executable capture, stable identity comparison. |
| `scripts/codex-browser-gate/codex-executable.test.mjs` | Dependency-injected parser, selection, reuse-input, and changed-identity regressions. |
| `scripts/codex-browser-gate/gate-contract.mjs` | Retain stable model, effort, safety, feature, and lifecycle constants; remove release constants. |
| `scripts/codex-browser-gate/app-server-protocol.mjs` | Accept selected executable for app-server spawn; use neutral schema logical prefix. |
| `scripts/codex-browser-gate/schema-canonicalizer.test.mjs` | Prove neutral framing stability and content/relative-path sensitivity. |
| `scripts/codex-browser-gate/gate-characterization.test.mjs` | Lock module boundaries, selected-command wiring, pre/post ordering, output ordering, and unchanged contracts. |
| `scripts/codex-browser-gate/run.mjs` | Capture active identity once, reuse selected path, recheck identity before PASS, report detected version. |
| Four historical design/plan docs | Add narrow supersession notice; retain historical text unchanged. |

### Task 1: Add strict active-Codex identity primitives

**Files:**

- Create: `scripts/codex-browser-gate/codex-executable.test.mjs`
- Create: `scripts/codex-browser-gate/codex-executable.mjs`

- [ ] **Step 1: Write failing strict-version tests**

Create `codex-executable.test.mjs` with imports from `node:assert/strict` and
the not-yet-created module. Use this exact valid/invalid matrix:

```js
import assert from "node:assert/strict";

import {
  assertSameCodexIdentity,
  captureCodexIdentity,
  parseCodexVersionOutput,
} from "./codex-executable.mjs";

for (const [output, version] of [
  ["codex-cli 0.144.6\n", "0.144.6"],
  ["codex-cli 1.2.3-alpha.1+build.5\n", "1.2.3-alpha.1+build.5"],
  ["codex-cli 1.2.3+build.5", "1.2.3+build.5"],
]) {
  assert.equal(parseCodexVersionOutput(output), version);
}

for (const output of [
  " codex-cli 1.2.3\n",
  "codex-cli 1.2.3 \n",
  "codex 1.2.3\n",
  "codex-cli 1.2\n",
  "codex-cli 01.2.3\n",
  "codex-cli 1.02.3\n",
  "codex-cli 1.2.03\n",
  "codex-cli 1.2.3-01\n",
  "codex-cli 1.2.3-alpha..1\n",
  "codex-cli 1.2.3-\n",
  "codex-cli 1.2.3\nextra\n",
  "codex-cli 1.2.3\r\n",
  "",
]) {
  assert.throws(
    () => parseCodexVersionOutput(output),
    error => error?.code === "codex_version_mismatch",
  );
}
```

- [ ] **Step 2: Add failing first-`PATH` and identity tests**

In the same file, inject all filesystem and process operations. Assert only
the first executable is selected, inactive higher versions are never queried,
and the absolute selected path is passed to `--version`:

```js
const calls = [];
const identity = await captureCodexIdentity({
  pathValue: "/first:/active:/newer",
  cwd: "/workspace",
  supervisor: {},
  async accessFile(path) {
    calls.push(["access", path]);
    if (path !== "/active/codex") {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
  },
  async realpathFile(path) {
    calls.push(["realpath", path]);
    return "/opt/codex/0.144.6/codex";
  },
  async statFile(path) {
    calls.push(["stat", path]);
    return { isFile: () => true, dev: 8n, ino: 1446n };
  },
  async runCommand(command, args) {
    calls.push(["run", command, args]);
    return { code: 0, stdout: "codex-cli 0.144.6\n", stderr: "" };
  },
});

assert.deepEqual(identity, {
  executablePath: "/active/codex",
  resolvedPath: "/opt/codex/0.144.6/codex",
  device: "8",
  inode: "1446",
  version: "0.144.6",
});
assert.deepEqual(calls, [
  ["access", "/first/codex"],
  ["access", "/active/codex"],
  ["realpath", "/active/codex"],
  ["stat", "/opt/codex/0.144.6/codex"],
  ["run", "/active/codex", ["--version"]],
]);
assert.equal(calls.some(call => String(call[1]).includes("newer")), false);
```

Add cases for an empty `PATH`, no executable, non-file candidate, nonzero
`--version`, and invalid output. Initial capture must throw
`codex_version_mismatch`. Repeat missing and invalid cases with
`failureCode: "codex_version_changed"`; those must throw
`codex_version_changed`.

Create a frozen baseline identity, alter each field separately, and require
every comparison to fail with `codex_version_changed`:

```js
const baseline = Object.freeze({
  executablePath: "/active/codex",
  resolvedPath: "/opt/codex/0.144.6/codex",
  device: "8",
  inode: "1446",
  version: "0.144.6",
});
assert.doesNotThrow(() => assertSameCodexIdentity(baseline, { ...baseline }));
for (const [field, value] of [
  ["executablePath", "/replacement/codex"],
  ["resolvedPath", "/opt/codex/0.144.7/codex"],
  ["device", "9"],
  ["inode", "1447"],
  ["version", "0.144.7"],
]) {
  assert.throws(
    () => assertSameCodexIdentity(baseline, { ...baseline, [field]: value }),
    error =>
      error?.code === "codex_version_changed" &&
      error.message === `codex_version_changed: ${field}`,
  );
}
```

End with exactly:

```js
process.stdout.write("codex_browser_executable: PASS\n");
```

- [ ] **Step 3: Run test and confirm RED**

```bash
node scripts/codex-browser-gate/codex-executable.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `codex-executable.mjs`.

- [ ] **Step 4: Implement strict parsing and identity capture**

Create `codex-executable.mjs`. Export exactly these three functions:

```js
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import { gateError } from "./gate-contract.mjs";
import { runCaptured } from "./lifecycle.mjs";

const SEMVER =
  "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)" +
  "(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?" +
  "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?";
const VERSION_OUTPUT = new RegExp(`^codex-cli (${SEMVER})\\n?$`);
const IDENTITY_FIELDS = Object.freeze([
  "executablePath",
  "resolvedPath",
  "device",
  "inode",
  "version",
]);

export function parseCodexVersionOutput(output) {
  if (typeof output !== "string") throw gateError("codex_version_mismatch");
  const match = VERSION_OUTPUT.exec(output);
  if (!match) throw gateError("codex_version_mismatch");
  return match[1];
}
```

Implement capture with this exact signature and behavior:

```js
export async function captureCodexIdentity({
  pathValue,
  cwd,
  supervisor,
  failureCode = "codex_version_mismatch",
  accessFile = access,
  realpathFile = realpath,
  statFile = stat,
  runCommand = runCaptured,
}) {
  try {
    if (typeof pathValue !== "string" || pathValue === "") {
      throw gateError(failureCode);
    }
    let selected;
    for (const entry of pathValue.split(delimiter)) {
      const candidate = resolve(cwd, entry || ".", "codex");
      try {
        await accessFile(candidate, constants.X_OK);
        const resolvedPath = await realpathFile(candidate);
        const executableStat = await statFile(resolvedPath);
        if (!executableStat.isFile()) continue;
        selected = { executablePath: candidate, resolvedPath, executableStat };
        break;
      } catch (error) {
        if (["EACCES", "ENOENT", "ENOTDIR"].includes(error?.code)) continue;
        throw error;
      }
    }
    if (!selected) throw gateError(failureCode);
    const versionResult = await runCommand(
      selected.executablePath,
      ["--version"],
      {
        supervisor,
      },
    );
    if (versionResult.code !== 0) throw gateError(failureCode);
    let version;
    try {
      version = parseCodexVersionOutput(versionResult.stdout);
    } catch {
      throw gateError(failureCode);
    }
    return Object.freeze({
      executablePath: selected.executablePath,
      resolvedPath: selected.resolvedPath,
      device: String(selected.executableStat.dev),
      inode: String(selected.executableStat.ino),
      version,
    });
  } catch (error) {
    if (error?.code === failureCode) throw error;
    throw gateError(failureCode);
  }
}

export function assertSameCodexIdentity(expected, actual) {
  for (const field of IDENTITY_FIELDS) {
    if (expected?.[field] !== actual?.[field]) {
      throw gateError("codex_version_changed", field);
    }
  }
}
```

The candidate is accepted only after `access(X_OK)`, `realpath`, and a regular
file check. Do not invoke a shell, `which`, `command -v`, npm, NVM, a package
registry, or semantic-version comparison.

- [ ] **Step 5: Run focused checks and confirm GREEN**

```bash
node --check scripts/codex-browser-gate/codex-executable.mjs
node scripts/codex-browser-gate/codex-executable.test.mjs
git diff --check
```

Expected: syntax PASS, `codex_browser_executable: PASS`, diff check exits `0`.

- [ ] **Step 6: Stage, run hook, and commit Task 1**

```bash
git add scripts/codex-browser-gate/codex-executable.mjs scripts/codex-browser-gate/codex-executable.test.mjs
apps/api/.husky/_/pre-commit
git commit -m "feat: identify active Codex releases" -m "Resolve the first executable on PATH and parse its reported SemVer
without comparing compatible release numbers.

Capture filesystem identity so a gate run can reject replacement binaries."
```

Expected: hook exits `0`; commit succeeds first attempt.

- [ ] **Step 7: Run Task 1 reviews**

Requirements review must verify SemVer 2.0.0 syntax, optional single terminal
LF only, first-`PATH` selection, no inactive-installation scan, sanitized
errors, all five identity fields, and initial/changed error codes. Quality
review must inspect TOCTOU boundaries, dependency injection, immutable return,
specific filesystem errors, and exact exports. Route findings back to Task 1
implementer and repeat Step 5, hook, commit, and both reviews if changed.

### Task 2: Reuse one selected executable and recheck before PASS

**Files:**

- Modify: `scripts/codex-browser-gate/gate-characterization.test.mjs`
- Modify: `scripts/codex-browser-gate/gate-contract.mjs`
- Modify: `scripts/codex-browser-gate/app-server-protocol.mjs`
- Modify: `scripts/codex-browser-gate/run.mjs`

- [ ] **Step 1: Write failing characterization assertions**

Import `codex-executable.mjs` as a namespace and add it to
`productionSourcePaths`. Replace pinned version export assertions with:

```js
import * as codexExecutable from "./codex-executable.mjs";

assert.deepEqual(Object.keys(codexExecutable).toSorted(), [
  "assertSameCodexIdentity",
  "captureCodexIdentity",
  "parseCodexVersionOutput",
]);
assert.equal("CODEX_VERSION" in contract, false);
assert.equal("CODEX_VERSION_OUTPUT" in contract, false);
assert.equal(contract.MODEL, "gpt-5.6-terra");
assert.equal(contract.EFFORT, "medium");
```

Update exact contract export inventory to remove `CODEX_VERSION` and
`CODEX_VERSION_OUTPUT`. Add source-boundary assertions:

```js
assert.doesNotMatch(runSource, /runCaptured\("codex"/);
assert.doesNotMatch(
  productionSources["app-server-protocol.mjs"],
  /spawnChild\(\s*["']codex["']/,
);
assert.match(runSource, /runOne\(runNumber, codexIdentity\.executablePath\)/);
assert.match(runSource, /command: codexExecutablePath/);
assert.match(runSource, /version=\$\{codexIdentity\.version\}/);
```

Replace the old `prepareGate` ordering check with source slices that prove:

1. `await runPreflight()` precedes initial `captureCodexIdentity`;
2. every `runOne` completes before post-run `captureCodexIdentity`;
3. `assertSameCodexIdentity` precedes `process.stdout.write`; and
4. post-run capture uses `failureCode: "codex_version_changed"`.

Keep existing assertions for model, effort, feature constants, protocol
exports, module import direction, self-test output, run counts, and cleanup.

- [ ] **Step 2: Add failing app-server command injection regression**

In `runProtocolHardeningSelfTest`, update each existing fake client fixture to
pass `command: "/selected/codex"`. For the first fake child, capture the
spawn arguments and assert exactly:

```js
assert.deepEqual(spawnArguments, [
  "/selected/codex",
  ["app-server", "--strict-config", "--stdio"],
]);
```

The fake `spawnChild` may ignore its options after recording command/args.
Every existing protocol fixture must pass an explicit `command`; no constructor
default may independently resolve `codex`.

- [ ] **Step 3: Run characterization and confirm RED**

```bash
node scripts/codex-browser-gate/gate-characterization.test.mjs
```

Expected: FAIL because pinned exports and hard-coded command paths remain.

- [ ] **Step 4: Wire the selected executable through all launches**

Remove `CODEX_VERSION_OUTPUT` and `CODEX_VERSION` from
`gate-contract.mjs`. Add `command` as the first constructor property. At the
start of the existing constructor body, before assigning fields, add:

```js
if (typeof command !== "string" || command === "") {
  throw gateError("codex_app_server_spawn_failed");
}
```

Retain every existing constructor assignment and replace only its hard-coded
spawn call with:

```js
this.child = spawnChild(
  command,
  ["app-server", "--strict-config", "--stdio"],
  {
    cwd,
    detached: true,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);
```

Update every deterministic protocol fixture to inject its explicit fake
command. Change `runOne` to `async function runOne(runNumber,
codexExecutablePath)`. Use `codexExecutablePath` for schema and feature
`runCaptured` calls and pass `command: codexExecutablePath` to
`AppServerClient`.

Capture the original selection inputs before any live command, then re-use
them for the post-run check:

```js
async function prepareGate(selection) {
  await runPreflight();
  return captureCodexIdentity({
    ...selection,
    supervisor: gateLifecycle,
  });
}

async function main(runCount) {
  const selection = {
    pathValue: process.env.PATH,
    cwd: process.cwd(),
  };
  const codexIdentity = await prepareGate(selection);
  const results = [];
  for (let runNumber = 1; runNumber <= runCount; runNumber += 1) {
    results.push(await runOne(runNumber, codexIdentity.executablePath));
  }
  const postRunIdentity = await captureCodexIdentity({
    ...selection,
    supervisor: gateLifecycle,
    failureCode: "codex_version_changed",
  });
  assertSameCodexIdentity(codexIdentity, postRunIdentity);
}
```

Import `captureCodexIdentity` and `assertSameCodexIdentity`. Print
`codexIdentity.version` in the unchanged PASS field position. Do not print
selected/resolved paths. Do not change error settlement; post-run failures
must still flow through lifecycle cleanup before the single stderr line.
Keep the existing run-identity checks, schema/feature set-size assertions,
counter summation, and PASS construction around this insertion.

- [ ] **Step 5: Run focused checks and confirm GREEN**

```bash
node --check scripts/codex-browser-gate/gate-contract.mjs
node --check scripts/codex-browser-gate/app-server-protocol.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/codex-executable.test.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/run.mjs --transport-self-test
node scripts/codex-browser-gate/run.mjs --lifecycle-self-test
git diff --check
```

Expected: all checks exit `0`; named outputs remain exact; characterization
prints `codex_browser_gate_characterization: PASS`.

- [ ] **Step 6: Stage, run hook, and commit Task 2**

```bash
git add scripts/codex-browser-gate/gate-characterization.test.mjs scripts/codex-browser-gate/gate-contract.mjs scripts/codex-browser-gate/app-server-protocol.mjs scripts/codex-browser-gate/run.mjs
apps/api/.husky/_/pre-commit
git commit -m "feat: reuse active Codex in browser gate" -m "Pass one PATH-selected executable through schema, feature, and app-server
processes, then verify its identity again before reporting success.

Keep model, effort, capability checks, output order, and cleanup unchanged."
```

Expected: hook exits `0`; commit succeeds first attempt.

- [ ] **Step 7: Run Task 2 reviews**

Requirements review must trace the same absolute path into schema generation,
feature inventory, and every app-server process; verify original `PATH`/cwd
reuse; verify post-run comparison before PASS; and verify changed resolution,
filesystem identity, invalid version, and nonzero version return
`codex_version_changed`. Quality review must inspect constructor fixtures,
error/cleanup aggregation, no path leakage, source assertions, and unchanged
model/effort/safety policy. Route findings back to Task 2 implementer and
repeat checks and reviews if changed.

### Task 3: Make schema framing release-neutral

**Files:**

- Modify: `scripts/codex-browser-gate/schema-canonicalizer.test.mjs`
- Modify: `scripts/codex-browser-gate/gate-characterization.test.mjs`
- Modify: `scripts/codex-browser-gate/app-server-protocol.mjs`

- [ ] **Step 1: Write failing neutral-prefix regressions**

In `schema-canonicalizer.test.mjs`, replace versioned fixture paths with fixed
prefix `host/browser-runtime/protocol/codex-app-server/`. Add helpers that
frame two release-labelled source sets by relative path only:

```js
const SCHEMA_PREFIX =
  "host/browser-runtime/protocol/codex-app-server/";
const releaseBundle = (release, entries) =>
  entries.map(([relativePath, raw]) => ({
    release,
    relativePath,
    raw,
  }));
const neutralEntries = entries =>
  entries.map(({ relativePath, raw }) => [
    `${SCHEMA_PREFIX}${relativePath}`,
    raw,
  ]);

const release1445 = releaseBundle("0.144.5", [
  ["v2/A.json", bytes('{"a":1}')],
  ["bundle.json", bytes('{"b":2}')],
]);
const release1446 = releaseBundle("0.144.6", [
  ["v2/A.json", bytes('{"a":1}')],
  ["bundle.json", bytes('{"b":2}')],
]);
equal(
  hashCanonicalSchemaBundle(neutralEntries(release1445)),
  hashCanonicalSchemaBundle(neutralEntries(release1446)),
);
differs(
  hashCanonicalSchemaBundle(neutralEntries(release1445)),
  hashCanonicalSchemaBundle(
    neutralEntries(
      releaseBundle("0.144.6", [
        ["v2/A.json", bytes('{"a":2}')],
        ["bundle.json", bytes('{"b":2}')],
      ]),
    ),
  ),
);
differs(
  hashCanonicalSchemaBundle(neutralEntries(release1445)),
  hashCanonicalSchemaBundle(
    neutralEntries(
      releaseBundle("0.144.6", [
        ["v2/Renamed.json", bytes('{"a":1}')],
        ["bundle.json", bytes('{"b":2}')],
      ]),
    ),
  ),
);
```

In characterization, assert protocol source contains the neutral literal and
contains no Gate schema prefix with a release suffix:

```js
assert.match(
  productionSources["app-server-protocol.mjs"],
  /host\/browser-runtime\/protocol\/codex-app-server\/\$\{relativePath\}/,
);
assert.doesNotMatch(
  productionSources["app-server-protocol.mjs"],
  /codex-app-server-0\.144\.5/,
);
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
```

Expected: canonicalizer regression PASS; characterization FAIL because
production still hashes `codex-app-server-0.144.5`.

- [ ] **Step 3: Change only schema hash framing**

In `schemaHash`, replace the versioned logical string with:

```js
const SCHEMA_LOGICAL_PREFIX =
  "host/browser-runtime/protocol/codex-app-server/";

return hashCanonicalSchemaBundle(
  rawFiles.map(([relativePath, raw]) => [
    `${SCHEMA_LOGICAL_PREFIX}${relativePath}`,
    raw,
  ]),
);
```

Keep generated files in the private temporary schema directory. Do not create
the logical prefix on disk. Retain path separator normalization, lexicographic
ordering, NUL framing, lossless normalization, required-definition audit, and
SHA-256.

- [ ] **Step 4: Run focused checks and confirm GREEN**

```bash
node --check scripts/codex-browser-gate/app-server-protocol.mjs
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --hardening-self-test
git diff --check
```

Expected: canonicalizer and characterization PASS; hardening output unchanged.

- [ ] **Step 5: Stage, run hook, and commit Task 3**

```bash
git add scripts/codex-browser-gate/schema-canonicalizer.test.mjs scripts/codex-browser-gate/gate-characterization.test.mjs scripts/codex-browser-gate/app-server-protocol.mjs
apps/api/.husky/_/pre-commit
git commit -m "fix: neutralize Codex schema hash framing" -m "Frame generated app-server schemas under one release-neutral logical
prefix while preserving relative paths and lossless canonical bytes.

Prove release labels do not affect hashes while content and path changes do."
```

Expected: hook exits `0`; commit succeeds first attempt.

- [ ] **Step 6: Run Task 3 reviews**

Requirements review must verify exact neutral prefix, no created logical
directory, equal digest across release labels, digest changes for content and
relative path, and unchanged structural schema checks. Quality review must
inspect fixture independence, canonicalizer framing, prefix placement, and
absence of remaining Gate-specific release label. Route findings back to
Task 3 implementer and repeat checks and reviews if changed.

### Task 4: Mark historical version pins narrowly superseded

**Files:**

- Modify: `docs/superpowers/specs/2026-07-19-local-browser-interact-runtime-design.md:1`
- Modify: `docs/superpowers/specs/2026-07-20-codex-browser-gate-modularization-design.md:1`
- Modify: `docs/superpowers/plans/2026-07-19-browser-interact-gate-and-state.md:1`
- Modify: `docs/superpowers/plans/2026-07-20-codex-browser-gate-modularization.md:1`

- [ ] **Step 1: Add exact narrow supersession notice**

Immediately below each title, add this notice with a relative link adjusted
from that document's directory:

```md
> **Version-selection supersession:** Exact Codex `0.144.5` Gate requirements
> are superseded by the
> [rolling-version design](../specs/2026-07-21-codex-browser-gate-rolling-version-design.md).
> Model, reasoning effort, protocol, safety, lifecycle, and live-behavior
> requirements remain authoritative.
```

For specs linking another spec, use filename-only link
`2026-07-21-codex-browser-gate-rolling-version-design.md`. Do not rewrite or
delete historical implementation text. Do not change host deployment plans
that intentionally pin packaged artifacts.

- [ ] **Step 2: Verify notice scope and links**

```bash
rg -n "Version-selection supersession" docs/superpowers/specs/2026-07-19-local-browser-interact-runtime-design.md docs/superpowers/specs/2026-07-20-codex-browser-gate-modularization-design.md docs/superpowers/plans/2026-07-19-browser-interact-gate-and-state.md docs/superpowers/plans/2026-07-20-codex-browser-gate-modularization.md
git diff --check
```

Expected: exactly four notices, valid relative targets, diff check exits `0`.

- [ ] **Step 3: Stage, run hook, and commit Task 4**

```bash
git add docs/superpowers/specs/2026-07-19-local-browser-interact-runtime-design.md docs/superpowers/specs/2026-07-20-codex-browser-gate-modularization-design.md docs/superpowers/plans/2026-07-19-browser-interact-gate-and-state.md docs/superpowers/plans/2026-07-20-codex-browser-gate-modularization.md
apps/api/.husky/_/pre-commit
git commit -m "docs: supersede fixed Codex gate version" -m "Point historical Gate documents to rolling active-version selection while
retaining their model, protocol, safety, lifecycle, and behavior contracts."
```

Expected: hook exits `0`; commit succeeds first attempt.

- [ ] **Step 4: Run Task 4 reviews**

Requirements review must verify exactly the four approved historical docs are
annotated and broader packaged-artifact pins remain untouched. Quality review
must verify links, wording, line length, and no historical bulk rewrite. Route
findings back to Task 4 implementer and repeat checks and reviews if changed.

### Task 5: Run rolling-gate acceptance and resume foundation Task 8

**Files:**

- Verify: all files under `scripts/codex-browser-gate/`
- Verify: `docs/superpowers/specs/2026-07-21-codex-browser-gate-rolling-version-design.md`
- Verify: Task 8 in `docs/superpowers/plans/2026-07-19-browser-interact-gate-and-state.md`
- No new files or commit expected.

- [ ] **Step 1: Run complete deterministic Gate verification**

```bash
node --check scripts/codex-browser-gate/codex-executable.mjs
node --check scripts/codex-browser-gate/gate-contract.mjs
node --check scripts/codex-browser-gate/decision-wire.mjs
node --check scripts/codex-browser-gate/lifecycle.mjs
node --check scripts/codex-browser-gate/app-server-protocol.mjs
node --check scripts/codex-browser-gate/preflight.mjs
node --check scripts/codex-browser-gate/run.mjs
node scripts/codex-browser-gate/codex-executable.test.mjs
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
node scripts/codex-browser-gate/gate-characterization.test.mjs
node scripts/codex-browser-gate/run.mjs --action-store-self-test
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/run.mjs --transport-self-test
node scripts/codex-browser-gate/run.mjs --lifecycle-self-test
git diff --check
```

Expected: every syntax check exits `0`; executable, canonicalizer,
characterization, and named self-tests print their exact PASS lines; no live
model call occurs.

- [ ] **Step 2: Confirm active installation and run live three-run Gate**

```bash
command -v codex
codex --version
node scripts/codex-browser-gate/run.mjs --runs 3
```

Expected active executable is `/home/mamba/.local/bin/codex`, version output
is `codex-cli 0.144.6`, and Gate emits exactly one stdout line shaped as:

```text
codex_browser_gate: PASS runs=3 version=0.144.6 model=gpt-5.6-terra effort=medium turns=6 actions=3 writes=3 tools=0 approvals=0 schema=<64 lowercase hex> features=<64 lowercase hex>
```

The three runs must agree on schema and feature hashes, use distinct run
identities, perform exact action/replay/mismatch/final behavior, and leave no
Gate temp roots or child process groups. Any active compatible future SemVer
replaces `0.144.6` in both preflight output and PASS expectation; do not edit
the repository solely for that version change.

- [ ] **Step 3: Run final rolling-version requirements and quality reviews**

Requirements review must map every approved design bullet to implementation
and evidence, including stable/prerelease/build parsing, malformed forms,
first `PATH` winner, no version comparison, all post-run identity differences,
absolute executable reuse, neutral schema framing, within-run hash agreement,
unchanged model/effort/capability/safety/lifecycle behavior, exact output, and
cleanup on changed-version failure. Quality review must inspect the complete
diff from `f3f88b7fc`, report Critical/Important/Minor findings, and require no
open findings before proceeding. Use prior task implementers for fixes, then
rerun Steps 1-3.

- [ ] **Step 4: Start isolated Task 8 database and run focused API tests**

Preserve unrelated Docker projects. If `127.0.0.1:55432` is occupied, stop
only the identified owner after recording its container ID/project, then
restore that same service after Step 6. Start the disposable project:

```bash
docker compose --project-name firecrawl-browser-test --project-directory . -f compose.browser-test.yaml up -d --wait
```

From `apps/api`:

```bash
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:password@127.0.0.1:55432/firecrawl pnpm vitest run src/db/migrate.integration.test.ts src/lib/browser-state/transitions.test.ts src/lib/browser-state/store.integration.test.ts src/lib/scrape-interact/replay-envelope.test.ts src/lib/scrape-interact/replay-store.integration.test.ts src/services/local-retention-worker.test.ts src/controllers/v2/__tests__/browser-billing.test.ts src/lib/local-runtime-config.test.ts
pnpm build
```

Expected: all focused tests and TypeScript build PASS. Environment-only skips
must be named and justified; test failures block completion.

- [ ] **Step 5: Run Playwright and Compose acceptance**

From `apps/playwright-service-ts`:

```bash
pnpm build
```

From repository root:

```bash
docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet
docker compose --project-name firecrawl --project-directory . -f compose.yaml ps --format json
```

Expected: Playwright build and Compose config PASS; only loopback API port is
published. `LOCAL_BROWSER_SERVICE_ENABLED` remains `false`; no Browser Service
port is introduced.

- [ ] **Step 6: Remove disposable infrastructure and restore prior services**

```bash
docker compose --project-name firecrawl-browser-test --project-directory . -f compose.browser-test.yaml down --volumes
```

Expected: disposable container, network, and volume are removed. Never run
this against project `firecrawl` or `compose.yaml`. Restore any recorded prior
owner of `127.0.0.1:55432`, then verify its original container/project is
healthy. Leave unrelated port `5432`, Redis, Firecrawl API, and other Docker
projects untouched.

- [ ] **Step 7: Run actual hook and confirm clean completion**

```bash
apps/api/.husky/_/pre-commit
git status --short
```

Expected: hook exits `0`; worktree is clean. If verification changes a file,
inspect it, route it to the responsible implementer, run both reviews again,
and commit only after focused verification and hook success.

## Completion boundary

Rolling active-version selection is complete only after deterministic and live
Gate checks pass, final reviews have no findings, Task 8 acceptance passes,
disposable infrastructure is removed, prior services are restored, and the
worktree is clean. Then continue with the next approved Browser Service/API
and host-execution plans; do not expand this change into those systems.
