# Codex Browser Gate Modularization Design

> **Version-selection supersession:** Exact Codex `0.144.5` Gate requirements
> are superseded by the
> [rolling-version design](2026-07-21-codex-browser-gate-rolling-version-design.md).
> Model, reasoning effort, protocol, safety, lifecycle, and live-behavior
> requirements remain authoritative.

## Goal

Refactor `scripts/codex-browser-gate/run.mjs` into focused modules without
changing Gate0 behavior. Preserve every command-line flag, process boundary,
validation rule, hash, error code, output byte, model setting, timeout, signal
effect, and live two-turn action-loop assertion.

This is structure-only work. It does not add browser state, alter the action
store, change schema canonicalization, upgrade Codex, or begin later Browser
Interact phases.

## Approved Direction

Use a focused module split. Keep the executable as the composition root and
separate these responsibilities:

- detached-process and temporary-root lifecycle supervision;
- lossless app-server transport and generated-schema validation;
- strict model decision wire schema, validation, and normalization;
- deterministic preflight and named self-test orchestration; and
- live Gate setup, two-turn orchestration, aggregation, and CLI settlement.

Retain `action-store.mjs` and `schema-canonicalizer.mjs` as their existing
single-purpose modules. Add no package or runtime dependency.

The split is based on responsibility and dependency direction. It has no file
size target: a module is complete when it owns one coherent policy and exposes
the smallest interface its consumers need.

## Preserved Contract

The refactor must preserve these externally observable contracts exactly.

### Invocation

- No arguments means `--runs 3`.
- `--runs <count>` accepts the existing range `1..10` and rejects every other
  shape with `codex_gate_arguments_invalid`.
- `--action-store-self-test`, `--hardening-self-test`,
  `--transport-self-test`, and `--lifecycle-self-test` remain the only named
  self-test flags and reject extra arguments.
- Default and `--runs` execution runs all deterministic preflight checks
  silently before version discovery or any live Gate process.

### Success output

Named self-tests retain their exact lines and order:

```text
codex_browser_action_store: PASS writes=1 records=1
codex_browser_format_hardening: PASS
codex_browser_hardening: PASS
codex_browser_transport: PASS
codex_browser_lifecycle: PASS
```

`--hardening-self-test` emits both hardening lines shown above. Silent
preflight emits none of them. A successful live Gate still emits exactly one
line with this field order and spacing:

```text
codex_browser_gate: PASS runs=<runs> version=0.144.5 model=gpt-5.6-terra effort=medium turns=<turns> actions=<actions> writes=<writes> tools=0 approvals=0 schema=<sha256> features=<sha256>
```

Failures still write one rendered error message plus a newline to stderr, set
exit code `1`, and do not emit a success line. Existing error codes and
`AggregateError` ordering remain unchanged.

### Runtime identity and policy

- Codex output must remain exactly `codex-cli 0.144.5`.
- Model remains `gpt-5.6-terra`; reasoning effort remains `medium`.
- `CONFIG`, disabled feature inventory, reviewed enabled non-tool features,
  tool-surface matching, forbidden-event matching, allowed item types, and all
  limits remain byte-for-byte or value-for-value equivalent.
- Schema and feature hash inputs, framing, ordering, and digest algorithms do
  not change.
- Each run still receives a distinct process, thread, action ID, marker, and
  temporary root.
- The full decision schema, exact prompts, initial observation, normalized
  action hash, marker content and mode, callback replay, mismatch rejection,
  turn counts, event audit, and final result stay identical.

### Lifecycle behavior

- Every child remains spawned without a shell, detached into its own process
  group, under the current output and deadline limits.
- `SIGINT`, `SIGTERM`, and `SIGHUP` still stop owned process groups and roots,
  restore prior listeners, then re-raise the original signal.
- Cleanup retains TERM/KILL escalation, close-drain behavior, root removal,
  bounded cleanup deadlines, idempotency, and primary-before-cleanup error
  aggregation.
- The real Linux parent-plus-descendant process-group fixture remains part of
  normal silent preflight and the named lifecycle self-test.

## File Structure

### Existing modules retained

`scripts/codex-browser-gate/action-store.mjs`

- Owns Gate-local execute-once action validation, marker dispatch, cached
  replay, mismatch rejection, and snapshots.
- Its production behavior and `createGateActionStore` export do not change.

`scripts/codex-browser-gate/schema-canonicalizer.mjs`

- Owns lossless JSON parsing, canonical serialization, schema-tree mutation,
  and canonical bundle hashing.
- Its exports and command-line behavior do not change.

`scripts/codex-browser-gate/schema-canonicalizer.test.mjs`

- Remains the standalone canonicalizer regression suite.

### New contract leaf

`scripts/codex-browser-gate/gate-contract.mjs`

- Owns immutable pinned values: Codex version strings, model, effort, config,
  feature policy, item/event policy, output limits, run limits, watchdogs, and
  cleanup grace periods.
- Owns `gateError(code, detail)` so every extracted Gate module creates the
  same error shape and message. `action-store.mjs` retains its existing
  domain-specific error helper.
- Owns pure feature-inventory validation and hashing against the pinned
  feature policy. It performs no I/O, installs no handlers, and creates no
  mutable singleton.

The contract leaf prevents copied constants and error helpers while keeping
all higher-level dependencies acyclic.

### Lifecycle supervision

`scripts/codex-browser-gate/lifecycle.mjs`

- Owns `LifecycleRegistry`, `ProcessDeadline`, detached command capture,
  signal handler installation, root-removal assertions, and primary/cleanup
  error combination.
- Accepts clocks, timers, spawn, kill, stat, and removal operations through
  the existing injection points. It never imports the app-server protocol or
  decision schema.
- Exposes production lifecycle operations used by `run.mjs` and the protocol
  client. Any fixture-only access stays inside this module behind the explicit
  `runLifecycleSelfTest({ silent })` preflight interface.

There is no module-global registry here. `run.mjs` constructs the one registry
for an invocation and passes it to every owner.

### App-server protocol

`scripts/codex-browser-gate/app-server-protocol.mjs`

- Owns raw JSONL framing, fatal lossless message parsing, exact transport
  number wrappers, response-ID correlation, schema-number materialization,
  generated-schema keyword auditing and matching, schema loading and hashing,
  `AppServerClient`, turn start/wait behavior, and global event auditing.
- Keeps the transport-number symbol private. Numbers remain exact through
  response correlation and schema validation, then materialize only after the
  current safe-range checks pass.
- Treats a decision schema as injected turn data. It does not import
  `decision-wire.mjs` and cannot normalize a model decision.
- Extracts the one correlated completed agent-message text as raw text after
  turn and generated-schema validation. Decision parsing remains downstream.
- Exposes only live protocol operations plus explicit
  `runProtocolHardeningSelfTest({ silent })` and
  `runTransportSelfTest({ silent })` preflight interfaces. Raw framers,
  numeric symbols, and fixture constructors remain private.

Moving functions may not weaken the current validation. Duplicate decoded
keys, malformed UTF-8, fractional or unsafe IDs, unsupported schema keywords
or formats, rounded numeric boundaries, cross-thread/cross-turn events, late
events, tool/approval events, and invalid generated messages keep their exact
failure classifications.

### Decision wire contract

`scripts/codex-browser-gate/decision-wire.mjs`

- Owns `modelDecisionEnvelopeSchema` and its closed-object builders.
- Owns recursive schema self-audit, lossless model-message parsing, semantic
  validation for every wire operation, and
  `normalizeModelDecisionEnvelopeV1`.
- Owns canonical proposal hashing because only a validated, normalized
  internal operation may enter action identity.
- Keeps the distinction between model-wire and trusted internal decisions.
  `get_text.ref` nullable handling and empty `evaluate.args` normalization do
  not change, even though Gate0's live fixture selects `fill`.
- Exposes the schema, parse/validate/normalize operation, proposal hash, and
  explicit `runDecisionWireSelfTest({ silent })` preflight interface. Helper
  validators and fixture mutations remain private.

Model output still passes through `parseLosslessJson`; normal `JSON.parse`
must not reappear at this boundary.

### Deterministic preflight

`scripts/codex-browser-gate/preflight.mjs`

- Owns action-store fixtures, cross-module hardening fixtures, named self-test
  dispatch, and silent preflight ordering.
- Exports `runPreflight()` and one named-self-test resolver used by `run.mjs`.
- Calls owner-module self-test interfaces rather than importing private
  implementation helpers.
- Preserves the current order: action store, hardening, transport, lifecycle.
- Preserves the current named output exactly while suppressing all output in
  normal preflight.

For `--hardening-self-test`, preflight calls decision-wire checks first, then
protocol format checks, then cross-module/CLI checks. Protocol format checks
write `codex_browser_format_hardening: PASS` when non-silent; the preflight
wrapper writes `codex_browser_hardening: PASS` last. Action-store, transport,
and lifecycle runners each own their one existing non-silent PASS line.

Self-test-only exports are prohibited except these explicit preflight runner
interfaces. Production modules must not export raw fixtures, fake children,
private numeric wrappers, private parsers, or an `internals`/`testing` bag.

### Executable orchestration

`scripts/codex-browser-gate/run.mjs`

- Remains the only Gate executable and composition root.
- Owns invocation settlement, the invocation-level lifecycle registry and
  signal handlers, per-run temporary directory/config setup, auth copy,
  feature and schema command sequencing, initialize/thread sequencing, exact
  two-turn prompts and assertions, action-store execution, per-run cleanup,
  cross-run identity/hash checks, aggregation, and the final PASS line.
- Contains no JSON tokenizer, generic schema validator, lifecycle class,
  decision schema definition, or deterministic fixture body.
- Performs no behavior beyond composing the other modules and asserting the
  live Gate scenario.

## Internal Export Inventory

Names below are locked for the implementation plan. They are internal module
interfaces, not a new supported package API.

`gate-contract.mjs` exports:

- `CODEX_VERSION_OUTPUT`, `CODEX_VERSION`, `MODEL`, `EFFORT`,
  `MAX_OUTPUT_BYTES`, `WATCHDOG_MS`, and `MAX_RUNS`;
- `CLEANUP_TERM_GRACE_MS`, `CLEANUP_KILL_GRACE_MS`, `CLEANUP_POLL_MS`,
  `CLEANUP_TOTAL_GRACE_MS`, and `CLEANUP_DRAIN_GRACE_MS`;
- `REQUIRED_SCHEMA_DEFINITIONS`, `CONFIG`, `DISABLED_FEATURES`,
  `REVIEWED_ENABLED_NON_TOOL_FEATURES`, `TOOL_SURFACE_PATTERN`,
  `FORBIDDEN_EVENT_PATTERN`, and `ALLOWED_ITEM_TYPES`;
- `gateError(code, detail)`; and
- `hashFeatureInventory(output)`.

`lifecycle.mjs` exports:

- `LifecycleRegistry`, `ProcessDeadline`, `installSignalHandlers`, and
  `runCaptured`;
- `combinePrimaryAndCleanup` and `surfaceCleanupFailures`; and
- the explicit preflight interface `runLifecycleSelfTest({ silent })`.

`app-server-protocol.mjs` exports:

- `schemaHash`, `loadEventSchemas`, and `assertGeneratedSchemaValue`;
- `AppServerClient`, `startTurn`, `extractTurnAgentMessageText`,
  `runUnloadedTurnRegression`, `assertNoLateTurnMessages`, and
  `auditAllAppServerEvents`; and
- explicit preflight interfaces
  `runProtocolHardeningSelfTest({ silent })` and
  `runTransportSelfTest({ silent })`.

`runUnloadedTurnRegression(eventSchemas)` is an explicit live-schema
preflight interface. Its fixture data remains private inside the protocol
module.

`decision-wire.mjs` exports:

- `modelDecisionEnvelopeSchema`, `parseModelDecisionEnvelopeV1`,
  `normalizeModelDecisionEnvelopeV1`, and `normalizedProposalHash`; and
- the explicit preflight interface
  `runDecisionWireSelfTest({ silent })`.

`preflight.mjs` exports:

- `parseInvocation(args)`, whose result remains either `{ selfTest }` or
  `{ runCount }`; and
- `runPreflight()`, which accepts the existing injectable check functions for
  characterization.

`run.mjs` exports nothing and executes once. Helpers not listed above remain
private to their owner. In particular, raw transport-number values, JSONL
framers, exact-number arithmetic, fake process fixtures, schema AST converters,
wire helper validators, root-removal assertions, and CLI fixture bodies are
not exported.

## Dependency Graph

All imports follow this graph; arrows mean “imports from.”

```text
schema-canonicalizer.test.mjs -> schema-canonicalizer.mjs

decision-wire.mjs -----------+-> gate-contract.mjs
                             +-> schema-canonicalizer.mjs

lifecycle.mjs -----------------> gate-contract.mjs

app-server-protocol.mjs -----+-> gate-contract.mjs
                             +-> lifecycle.mjs
                             +-> schema-canonicalizer.mjs

preflight.mjs ---------------+-> gate-contract.mjs
                             +-> action-store.mjs
                             +-> schema-canonicalizer.mjs
                             +-> decision-wire.mjs
                             +-> lifecycle.mjs
                             +-> app-server-protocol.mjs

run.mjs ---------------------+-> every runtime module above
```

`action-store.mjs`, `schema-canonicalizer.mjs`, and `gate-contract.mjs` are
leaves. `decision-wire.mjs` and `lifecycle.mjs` are peers. The protocol layer
may depend on lifecycle supervision but receives the decision schema as data.
Neither protocol nor decision code imports preflight or `run.mjs`. No dynamic
import is used to conceal a cycle.

All module exports are repository-internal implementation interfaces. Public
behavior remains the `run.mjs` CLI and the canonicalizer CLI; this refactor
does not create a supported JavaScript library API.

## Data Flow

### Startup and preflight

1. `run.mjs` constructs one `LifecycleRegistry` and installs signal handlers.
2. Invocation parsing either resolves one named self-test or a run count.
3. Live execution calls `runPreflight()` with `silent: true`.
4. Preflight executes action-store, hardening, transport, and lifecycle checks
   in current order. A failure stops before `codex --version`.
5. `run.mjs` captures `codex --version` and requires the pinned exact output.

### One live run

1. `run.mjs` asks the invocation registry to create and own a mode-0700 root,
   creates the same child paths and modes, copies only `auth.json`, and writes
   the unchanged config.
2. Lifecycle capture runs schema generation. Protocol code validates the
   complete generated file set, required definitions, canonical bundle hash,
   loaded live schemas, and unloaded-turn fixture.
3. Lifecycle capture runs feature discovery. `hashFeatureInventory` validates
   it against contract policy, computes the existing stable feature hash, and
   rejects changed tool surface.
4. `AppServerClient` starts one detached app-server under the same absolute
   process deadline and output cap. Initialize and thread start use the same
   request bytes after ordinary `JSON.stringify` of trusted outbound data.
5. Protocol code validates thread/turn params and responses against the live
   generated schemas. `run.mjs` injects `modelDecisionEnvelopeSchema` into
   each `turn/start`.
6. App-server stdout enters the raw framer, then lossless JSON parsing and
   exact numeric wrappers. Response correlation and generated-schema checks
   occur before safe materialization.
7. Protocol code correlates the active turn and returns exactly one completed
   agent-message text. Decision code losslessly parses, strictly validates,
   and normalizes it.
8. `run.mjs` asserts the exact selected action. Decision code hashes canonical
   normalized operation bytes. The unchanged action store executes once,
   replays once, and rejects the mismatch.
9. The bounded observation enters turn two. The same path produces and
   validates the exact final decision.
10. Protocol code audits all stored events. Lifecycle code stops the process
    group; `run.mjs` stores raw event frames and removes the run root.
11. `run.mjs` aggregates distinct identities and stable hashes, then writes
    the unchanged one-line result.

Raw app-server stdout remains the authoritative event capture. Moving code
must not parse, reserialize, or canonicalize event frames before writing
`events.jsonl`.

## Cleanup and Error Ownership

Ownership is singular at each level:

- `LifecycleRegistry` owns every detached process group and temporary root.
- `AppServerClient` owns stdin/stdout/stderr state, pending requests, its
  process deadline, and protocol failure state; it delegates termination to
  its injected registry.
- `runOne` owns the live client, event path, marker, and run result. Its
  `finally` always stops/stores/removes and preserves the primary failure
  before cleanup failures.
- Top-level settlement owns invocation-wide cleanup and signal-handler
  restoration.
- Signal handling begins the same registry cleanup, aborts current work, then
  restores prior listeners and re-raises the received signal.

No lower module calls `process.exit`, changes `process.exitCode`, writes the
final PASS line, or installs a global signal listener. Named preflight runners
may write only their existing PASS lines when `silent` is false.

Cleanup errors must never be swallowed. One cleanup error remains that error;
multiple cleanup errors preserve their order in `AggregateError`; a primary
failure precedes cleanup failures.

## Characterization and Test Migration

New tests are authorized for this refactor. Tests characterize current
behavior before moving implementations and must not redefine expected output
from the refactored code.

### Baseline characterization

Before extraction, record exact exit status, stdout, and stderr for all four
named self-tests, malformed argument shapes, default run-count parsing through
injected orchestration, and deterministic preflight ordering. Record current
schema and feature hash framing through existing deterministic fixtures.

Do not add a fake success path that bypasses module integration. Existing
dependency injection remains the seam for commands, clocks, timers, process
groups, and app-server messages.

### Migration order

1. Add characterization assertions around exact CLI dispatch, output, error
   rendering, preflight silence/order, and live-result formatting.
2. Extract immutable contract values and decision-wire behavior. Run decision,
   hardening, action-store, and canonicalizer checks.
3. Extract lifecycle supervision with all fake-process cases and the real
   Linux descendant fixture intact. Run lifecycle and transport checks.
4. Extract raw protocol, exact numbers, generated-schema validation, client,
   turn correlation, and global audit. Run hardening and transport checks.
5. Move fixtures and named dispatch behind `preflight.mjs`; reduce `run.mjs`
   to composition and live orchestration. Run every deterministic check.
6. Run the actual repository hook, then one fresh live `--runs 3` acceptance
   after the full split.

Each extraction first makes the characterization fail because the old symbol
is no longer available at its expected boundary, then restores it through the
new owner. Avoid parallel old/new implementations and compatibility shims;
there must be one active implementation of every policy.

### Required commands

Run from repository root:

```bash
node scripts/codex-browser-gate/schema-canonicalizer.test.mjs
node scripts/codex-browser-gate/run.mjs --action-store-self-test
node scripts/codex-browser-gate/run.mjs --hardening-self-test
node scripts/codex-browser-gate/run.mjs --transport-self-test
node scripts/codex-browser-gate/run.mjs --lifecycle-self-test
apps/api/.husky/_/pre-commit
node scripts/codex-browser-gate/run.mjs --runs 3
```

The first five commands must retain their current output exactly. Normal
preflight inside the final command remains silent. The live command must pass
three runs with six turns, three actions, three writes, zero tools, zero
approvals, one stable schema hash, and one stable feature hash.

Run the expensive live command only after deterministic checks and the hook
pass. If it fails, stop and investigate the root cause; do not retry it as a
flakiness workaround.

## Commit and Review Sequence

1. Commit this design alone.
2. Write and approve a concrete implementation plan mapping each extraction
   and characterization to exact files and commands.
3. Implement the split in dependency order, keeping unrelated Browser
   Interact work out of the commits.
4. Run deterministic checks and the actual hook, then run the single final
   three-run live Gate acceptance.
5. Run requirements review against this design and the Gate0 runtime design.
6. Fix every requirements gap with a failing characterization first, rerun
   affected checks, and repeat requirements review.
7. Run a fresh code-quality review only after requirements review passes.
8. Fix quality findings without widening scope, rerun affected checks and the
   hook, and rerun live acceptance only when a correction can affect live
   behavior.

Do not combine durable-state implementation with this refactor. The module
split must be approved and green before continuing Gate0's next task.

## Success Criteria

The modularization is complete when all of these are true:

1. The dependency graph is acyclic and matches this design.
2. Each module has one stated responsibility; no duplicate validator,
   lifecycle, hash, config, or error implementation remains.
3. `run.mjs` contains only CLI settlement and live scenario composition.
4. Production modules expose no fixture or test-only internals beyond the
   explicit preflight runner interfaces.
5. Existing CLI flags, exact success output, stderr rendering, exit status,
   error codes, aggregate-error order, and signal behavior are unchanged.
6. Exact/raw transport numbers stay lossless until successful generated-schema
   validation; no unsafe early `Number` conversion is introduced.
7. Decision parsing remains lossless, strict, closed, and separate from the
   trusted internal decision.
8. Canonical schema and proposal hashes use the same bytes, paths, framing,
   ordering, and algorithms as before.
9. Silent preflight still includes every deterministic fixture, including the
   real Linux descendant cleanup fixture, before live version discovery.
10. All deterministic commands, the actual hook, and one fresh three-run live
    Gate pass with the preserved outputs and counts.
11. Requirements and code-quality reviews pass with no unresolved findings.
12. No dependency, runtime feature, durable state, Browser Service behavior,
    or host-adapter behavior is added.

## Out of Scope

- Durable PostgreSQL action/session/profile state
- Browser Service or API changes
- Host adapter, OCI, `runc`, systemd, or broker implementation
- Codex version, model, effort, config, feature, or schema changes
- Action-store or canonicalizer redesign
- Additional CLI flags, diagnostics, logging, or output formatting
- Performance optimization unrelated to preserving the Gate contract
