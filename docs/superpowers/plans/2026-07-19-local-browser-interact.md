# Local Browser Interact Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver local Browser and Interact parity through durable browser
state, a private persistent Browser Service, deterministic host-coordinated
Codex actions, isolated code execution, and restart-safe operator tooling.

**Architecture:** Execute three dependency-ordered plans. First prove the exact
installed Codex structured-output loop and add durable state, execute-once
action records, plus replay-safe checkpoints. Then add the private Browser
Service and API compatibility layer. Finally add host execution sandboxes,
prompt/code integration, operations, and fresh-client acceptance. Keep the API
as the only published TCP service.

**Tech Stack:** TypeScript, Node.js 22, PostgreSQL 17, Drizzle ORM, Playwright
1.58.1 and 1.61.1, Chromium CDP, Codex app-server V2 JSONL, Rust 1.94,
`runc` 1.3.6, OCI Runtime Specification 1.2.1, systemd 255, Docker Compose,
Vitest

---

## Why This Is a Plan Set

Phase 2 contains three separately testable security boundaries. Combining them
into one large plan would allow later implementation to hide an early contract
failure. Execute these documents in order:

1. [Gate, persistence, and replay checkpoints](./2026-07-19-browser-interact-gate-and-state.md)
2. [Browser Service and API compatibility](./2026-07-19-browser-service-and-api.md)
3. [Host execution and operations](./2026-07-19-browser-host-execution-and-operations.md)

Each document has its own file map, red/green tests, commit boundaries, and exit
criteria. Do not begin a later plan until every earlier exit criterion passes.

## Non-Negotiable Gates

- [ ] **Gate 0: Prove installed Codex behavior before service work**

Run the first plan's two-turn structured-action check three consecutive times
with installed `codex-cli 0.144.5`, `gpt-5.6-terra`, and `medium` reasoning.
Each run must use one pinned app-server process and ephemeral thread, emit one
schema-valid side-effect proposal, execute the host marker once, return a
cached result for a matching callback replay, reject a mismatched replay, then
emit the exact final result after its observation. Shell, unified exec, web
search, apps, plugins, skills, hooks, multi-agent, model tools, and every MCP
server must be absent. Stop and revise the design on any mismatch.

- [ ] **Gate 1: Make replay safe before Browser Service execution**

Post-scrape checkpoints must be stored only for non-ZDR scrapes. Legacy rows
may repeat waits, scrolling, screenshots, PDFs, and scrape-only actions. Click,
write/fill, key, download, and arbitrary JavaScript actions without a checkpoint
must return `replay_unsupported`; never repeat them speculatively.

- [ ] **Gate 2: Prove Browser Service security before Codex integration**

The validating browser egress proxy, navigation-origin policy, profile writer
lease, typed capability checks, live-view permissions, and restart cleanup must
pass deterministic hostile fixtures before any real Codex/browser run.

- [ ] **Gate 3: Prove host isolation before public enablement**

The root broker must accept only fixed bundles and resource presets over its
group-restricted socket. Code containers have no external network interface.
Codex containers receive only their pinned root, generated config, read-only
ChatGPT credential file, sealed prompt/schema input, and bounded protocol
output; they reject browser relay descriptors. Code bundles alone receive a
session relay. Neither adapter nor broker receives the Docker socket.

- [ ] **Gate 4: Validate from fresh clients**

After deterministic and live API checks, start new Claude Code and Codex MCP
processes. Invoke `firecrawl_interact` and `firecrawl_interact_stop` through the
existing local API configuration. Old sessions do not count.

## Cross-Plan Contract Lock

The first plan owns durable identifiers and state transitions. Later plans may
extend response detail but must not rename these concepts:

- `browser_session_id`: durable API session row identifier
- `browser_runtime_id`: one non-durable Chromium process incarnation
- `browser_interact_run_id`: one prompt or code execution
- `browser_interact_action_id`: one host-assigned prompt-mode action proposal
- `profile_generation_id`: immutable committed profile generation
- `replay_checkpoint_id`: immutable non-ZDR post-scrape checkpoint
- `capability_id`: hash-addressed, server-held browser authority
- `proxy_grant_id`: hash-addressed passive, interactive, or CDP grant
- `correlation_id`: one request identifier propagated across every boundary

Terminal session states are `destroyed`, `expired`, `interrupted`, and `error`.
Terminal run states are `succeeded`, `failed`, `cancelled`, `timed_out`, and
`interrupted`. State transitions use compare-and-set updates; cleanup ownership
is claimed once.

Action states are `prepared`, `executing`, `succeeded`,
`rejected_no_effect`, `failed_no_effect`, `cancelled_no_effect`, and
`outcome_unknown`. The API persists `prepared` before dispatch. An interrupted
`prepared` action is proven no-effect; an interrupted `executing` action
becomes terminal `outcome_unknown` and is never retried or returned to Codex.

Public `origin` remains trace attribution. It never grants navigation.
`allowedDomains` is the only direct caller grant. The target URL establishes
the initial normalized navigation origin. Validated redirects and clicked links
may extend it up to 8 origins. Public subresources receive independent
public-egress and SSRF checks without entering the navigation set.

## Version and Documentation Lock

- Existing stateless Playwright remains on its current 1.58 line. Its
  `storageState({ indexedDB: true })` checkpoint export is supported since
  Playwright 1.51.
- New Browser Service pins Playwright 1.61.1. Persistent-context restoration
  uses `setStorageState`, introduced in Playwright 1.59.
- `connectOverCDP` is Chromium-only and lower fidelity than the Playwright
  protocol. Use it only for the compatibility relay; internal typed operations
  retain their Browser Service-owned Playwright objects.
- `browserContext.route()` is defense in depth, not the primary SSRF boundary;
  service-worker traffic can bypass it. Chromium's validating egress proxy owns
  DNS resolution, address pinning, redirect validation, and private-address
  denial.
- Prompt mode pins Codex CLI/app-server 0.144.5 and the generated V2 protocol
  schema checksum. Every turn supplies the strict
  `ModelDecisionEnvelopeV1` output schema and unwraps its validated
  `ModelDecisionV1`; the command is experimental, so every upgrade must pass
  Gate 0.
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs#root-objects-must-not-be-anyof-and-must-be-an-object)
  requires a root object, forbids root `anyOf`, and supports the nested
  `anyOf` used under the required `decision` property and its action.
- OCI bundles target installed `runc` 1.3.6 and Runtime Specification 1.2.1.
- systemd socket units set `SocketUser`, `SocketGroup`, and `SocketMode=0660`;
  never rely on the default `0666` mode.

Primary references:

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)
- [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)
- [OCI Linux configuration](https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md)
- [`runc` documentation](https://github.com/opencontainers/runc)

## Execution Discipline

- Work directly on `main` in `/home/mamba/work/firecrawl`; do not create a
  worktree or nested Firecrawl checkout.
- Use a fresh implementation subagent for each numbered task and perform
  requirements review followed by code-quality review before the next task.
- Write only the tests explicitly specified by these approved plans.
- Run every red test before implementation and confirm its expected failure.
- Run the focused green command after implementation, then the affected build.
- Preserve unrelated user changes and inspect conflicts rather than choosing
  one side wholesale.
- Never install a missing host tool automatically. Stop and request the user to
  install or approve the intended prerequisite.
- Do not invoke `sudo` during normal start, restart, health, or test flows. The
  third plan contains one explicit interactive `install-host` boundary.
- Never weaken AppArmor, enable unprivileged user namespaces, publish backend
  ports, mount the Docker socket, or fall back to a cloud provider.

For every commit:

1. Stage the exact listed paths with one `git add` command.
2. Run `apps/api/.husky/_/pre-commit` as a separate command.
3. Re-stage formatter changes and rerun the hook if required.
4. Run one bare `git commit` with literal `-m` subject/body text from the task.
5. Never chain commands or use substitution, heredocs, wrappers, message files,
   bypass flags, or unsupported commit flags.

## Plan Completion Sequence

### Task 1: Execute Gate and State Plan

- [ ] Complete every task in
  `docs/superpowers/plans/2026-07-19-browser-interact-gate-and-state.md`.
- [ ] Confirm its focused unit, migration, checkpoint, ZDR, retention, and
  recovery commands pass.
- [ ] Confirm Gate 0 passes three consecutive app-server runs with one durable
  side-effect proposal, marker write-once behavior, callback deduplication,
  mismatch rejection, exact final output, and zero tool/approval events.
- [ ] Request requirements and code-quality review before Task 2.

### Task 2: Execute Browser Service and API Plan

- [ ] Complete every task in
  `docs/superpowers/plans/2026-07-19-browser-service-and-api.md`.
- [ ] Confirm fixture navigation, subresource egress, profile, typed operation,
  proxy-grant, live-view/CDP, direct Browser API, restart, and stop checks pass.
- [ ] Confirm only the API is published on `127.0.0.1`.
- [ ] Request requirements and code-quality review before Task 3.

### Task 3: Execute Host Execution and Operations Plan

- [ ] Complete every task in
  `docs/superpowers/plans/2026-07-19-browser-host-execution-and-operations.md`.
- [ ] Pause at the documented administrator install step for the user to enter
  credentials; do not work around the password boundary.
- [ ] Confirm Codex and all three code languages run only through fixed OCI
  bundles; only code bundles receive the session relay.
- [ ] Confirm ordered restart, cancellation, orphan cleanup, retention, backup,
  and bounded logs.
- [ ] Request final requirements and code-quality review.

### Task 4: Run Phase 2 Acceptance

- [ ] Run the exact final verification commands in all three child plans.
- [ ] Run `docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet`.
- [ ] Run `scripts/local-firecrawl restart` and
  `scripts/local-firecrawl health`.
- [ ] Verify one prompt Interact and Node, Python, and Bash code Interact against
  controlled fixtures.
- [ ] Confirm prompt Interact records a monotonic action ledger, executes each
  action at most once, permits a different action after definite no-effect,
  and terminates on unknown outcome.
- [ ] Restart during an active run and confirm terminal interruption, capability
  revocation, no orphan process, preserved committed profile, and safe later
  replay.
- [ ] Invoke Interact and stop from fresh Claude Code and Codex MCP processes.
- [ ] Run `apps/api/.husky/_/pre-commit`, `git diff --check`, and the final
  review commands required by the child plans.

## Phase 2 Exit Criteria

- Prompt Interact uses one pinned app-server 0.144.5 process and one ephemeral
  `gpt-5.6-terra`/`medium` thread per request. Codex returns a strict root
  `ModelDecisionEnvelopeV1`; the host validates and unwraps its unchanged
  internal `ModelDecisionV1`. Codex receives bounded observations and has no
  MCP, tools, or relay.
- Every accepted prompt action is durably prepared before dispatch, executes
  at most once, and records a definite result or terminal unknown outcome.
- Node, Python, and Bash run inside disposable fixed `runc` bundles.
- Direct Browser create/list/execute/delete and scrape Interact/stop preserve
  their public response contracts.
- Profiles publish atomically with one writer and immutable read snapshots.
- Requested screenshots, traces, recordings, and runner artifacts use bounded
  owner/request/scrape/session/run MinIO manifests and parent retention; ZDR
  creates none.
- Replay checkpoints prevent duplicate side effects and ZDR replay remains an
  explicit 409.
- Passive live view cannot send input; interactive and CDP grants are separate,
  owner-bound, short-lived, and revocable.
- Stop, timeout, disconnect, and restart leave no Codex, runner, Chromium,
  capability, grant, or profile lease orphan.
- No traffic uses Gemini, Fireworks, Firecrawl Cloud, or an API-key fallback.
- Only Firecrawl API is published on `127.0.0.1`.
- All child-plan tests, builds, security checks, recovery checks, live smokes,
  fresh MCP validations, hooks, and reviews pass.
