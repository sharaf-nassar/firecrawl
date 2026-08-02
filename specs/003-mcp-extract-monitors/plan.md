# Plan: mcp-extract-monitors

No constitution.md exists in this repo — no constitution to check against.

## Architecture Approach

Two independent fixes under one epic, both kept at the thinnest viable layer:

1. **Extract:** wire the API's OpenAI-provider client to the host-side Codex Shim and make it speak chat completions. The shim (`apps/codex-shim/src/server.mjs`) serves only `POST /v1/chat/completions` and rejects `/v1/embeddings`; the API container reaches it at `http://host.docker.internal:3030/v1` via the existing `extra_hosts: host.docker.internal:host-gateway` (`docker-compose.yaml:15-16`). The code change is confined to `apps/api/src/lib/generic-ai.ts` (chat-mode routing, precedent at lines 62-64 where o3-mini is forced through `providerList.openai.chat(...)`) plus `apps/api/src/config.ts` (empty-string hardening for `OPENAI_BASE_URL`/`OLLAMA_BASE_URL` with the existing `emptyStringAsUndefined` helper, config.ts:13-14). Recommended mechanism: an explicit opt-in config flag (working name `OPENAI_CHAT_COMPLETIONS_ONLY`), seeded `true` by the local env template — safer than a baseURL-presence heuristic because hosted deployments may legitimately set `OPENAI_BASE_URL` and rely on the Responses API.
2. **Monitors/feedback:** apply the established launcher capability-filter policy (`lat.md/operations/local-runtime.md:91`) by adding the 9 unbacked tool names to `disabledLocalToolNames` in `scripts/local-firecrawl-mcp.lib.mjs:1-18`, yielding a 17-name list. Discovery filtering and `-32601` rejection already exist (`filterToolList`, `unsupportedToolResponse`); this is a data change plus test-literal updates.

**Alternatives considered and rejected:**

- *Implement a Responses-API `/responses` endpoint in the shim* — rejected: duplicates protocol surface in `apps/codex-shim/` when a one-file API-side chat-mode switch with in-repo precedent achieves the same; spec Non-Goals pin this.
- *Disable `firecrawl_extract` in the launcher* — rejected by human answer (Clarifications Q1: "extract should be using codex! we built a sidecar for this").
- *Point local extract at api.openai.com* — rejected: spec Non-Goal; local stack must not depend on hosted OpenAI.
- *baseURL-presence heuristic for chat mode* (auto-chat whenever `OPENAI_BASE_URL` is set) — rejected as default: silently changes hosted behavior for any operator using a custom Responses-capable endpoint; an explicit flag is auditable and default-off. (If planning review prefers zero new env vars, the heuristic is the fallback — recorded in Risks.)
- *Enable monitors locally* (migrations + scheduler + GCS artifacts) — rejected for this epic: much larger project; the `monitors` table exists only in ORM schema (`apps/api/src/db/schema/public.ts:1232`), not in local migrations. Tool names stay reserved per policy for future enablement.
- *Leave `firecrawl_feedback` exposed with its clean 503* — rejected by human answer (Clarifications Q2: disable; 17 names).

## Affected Components

- `apps/api/src/config.ts` — wrap `OPENAI_BASE_URL` (line 71) and `OLLAMA_BASE_URL` (line 325) in `emptyStringAsUndefined`; add the chat-mode flag declaration.
- `apps/api/src/lib/generic-ai.ts` — chat-completions routing for the openai provider when the flag is set (extend `getModel`, lines 56-66).
- `scripts/local-firecrawl-mcp.lib.mjs` — extend `disabledLocalToolNames` (lines 1-18) with 8 `firecrawl_monitor_*` names + `firecrawl_feedback`, with a policy comment mirroring the existing entries.
- `scripts/local-firecrawl-mcp.test.mjs` — update the `disabledToolNames` literal (lines 53-62) and the "eight unsupported capabilities" count test (lines 66-68) to seventeen; existing fixture files under `scripts/fixtures/` are untouched (they capture only interact/search rewrites).
- `scripts/init-local-env.sh` — seed `OPENAI_BASE_URL=http://host.docker.internal:3030/v1` (currently blank at line 108), the chat-mode flag, and `MODEL_NAME` guidance for codex (value per Risks).
- New tests: colocated vitest units in `apps/api/src` (convention precedent: `apps/api/src/db/application-config.test.ts`; runner per `apps/api/package.json:24`).
- `lat.md/operations/local-runtime.md` — "Local MCP capability filter" section (line 91): document the 9 new disabled names and the extract-to-shim wiring.
- `lat.md/runtime/codex-shim.md` — only if the shim's documented boundary changes (plan says it does not; a consumer note may be added).
- `lat.md/testing/runtime-operations.md` — launcher suite and any new API test coverage descriptions.
- `SELF_HOST.md:62` — confirm `OPENAI_BASE_URL` example wording matches post-fix semantics ("empty behaves as unset"); document shim wiring for local extract.

## Data Model

None. No database schema, migration, or persisted-format changes. (The missing local `monitors` table is explicitly out of scope; tools are disabled at the launcher instead.)

## API / Interface Changes

- **MCP tool surface shrinks by 9 names** for local launcher consumers: `firecrawl_monitor_create/get/list/update/delete/run/check/checks` and `firecrawl_feedback` disappear from `tools/list` and return JSON-RPC `-32601` ("...disabled in the local Firecrawl MCP...") on direct call. **Breaking-change note:** MCP consumers with cached tool lists or permission allowlists naming `mcp__firecrawl__firecrawl_monitor_*`/`firecrawl_feedback` (Claude Code sessions, Codex configs) will see those tools vanish; harmless by design but must be called out in the change description.
- **Extract behavior change:** `firecrawl_extract` goes from always-failing (`Failed to parse URL from /responses`) to returning structured data via the Codex Shim; LLM traffic targets `/v1/chat/completions`, never `/responses` or `/v1/embeddings`.
- **Env var semantics change:** empty-string `OPENAI_BASE_URL`/`OLLAMA_BASE_URL` now parse as unset (provider defaults apply) instead of leaking `""` into client constructors. One new opt-in env var for chat-mode routing (default off; hosted behavior unchanged).
- No REST API route changes; the `/v2/extract` deprecation path is untouched.

## Testing Strategy

- **Config regression (vitest, apps/api):** colocated unit test asserting `OPENAI_BASE_URL=""`/`OLLAMA_BASE_URL=""` parse to `undefined` while non-empty values pass through — placement: a small `config`-focused test file following the `application-config.test.ts` colocation pattern.
- **Chat-mode routing (vitest, apps/api):** unit test on `getModel` proving flag-on returns the chat-path model targeting `/chat/completions` and flag-off preserves the Responses default (also confirming the `@ai-sdk/openai@3.0.71` `.chat()` behavior that was unverifiable without node_modules).
- **Launcher (node:test, scripts/):** update `scripts/local-firecrawl-mcp.test.mjs` literals — 17-name `disabledToolNames`, count-test text, plus one assertion that a `firecrawl_monitor_create` call gets the standard `-32601` disabled-tool error (reusing the existing `unsupportedToolResponse` test pattern). Fixture snapshot files unchanged.
- **Codex-shim suite (node:test):** no changes — the shim is not modified.
- **Live acceptance (manual, recorded):** one MCP tool-matrix rerun per Clarifications Q4 — extract succeeds on `https://example.com` via the shim; monitor/feedback calls return launcher errors; no monitor 500s in API logs; the eight tools that passed the 2026-08-01 baseline (scrape, search, map, crawl, check_crawl_status, parse, interact, interact_stop) are re-run and still pass. **Evidence format:** a per-tool result table (tool name → pass/fail/disabled-error, side by side with the 2026-08-01 baseline) plus the extract job id, its `completed` status payload, and a note of which extract pipeline executed (fire-0 vs main, per the parity risk) — recorded as a comment on the acceptance bead (item 6). Preconditions: human dedupes host codex installs (`scripts/local-firecrawl:133` check passes) and the shim is running. Gated live CI check is out of scope.
- `lat check` green after documentation sync (repo-required post-task gate).

## Risks

- **Chat-mode mechanism regresses hosted Responses usage** — mitigated by an explicit default-off flag rather than a baseURL heuristic; unit test locks flag-off behavior. Residual: flag naming/plumbing review. **Rollback:** unset the flag (or set it false) and revert the env-template line to restore the Responses-API default — no code revert, migration, or data rollback needed; the item-1 empty-string hardening is behaviorally inert for any correctly set env and needs no rollback path.
- **JSON-schema structured output vs shim per-call schema files unverified** — ai-sdk's chat schema mode may not map cleanly onto `createCodexTranslator`'s schema-file implementation (`apps/codex-shim/src/translate.mjs`). Mitigation: the manual acceptance rerun is the explicit verification gate; if it fails, the fix likely lands in translator request parsing, a bounded follow-up.
- **Host codex PATH ambiguity** ("Local Codex package is ambiguous", `scripts/local-firecrawl:133`) — human-owned environment prerequisite; blocks only the final acceptance item, not code work.
- **MODEL_NAME pinning** — the translator passes `model` verbatim to `codex exec --model`; extract defaults are non-codex names. Mitigation: `MODEL_NAME` must be set in the env seeding item; exact value chosen with the human at implementation time (codex-supported model).
- **Fire-0 legacy extract parity** — `apps/api/src/lib/extract/fire-0/` has parallel completion plumbing; confirm during implementation that it shares `getModel` (and thus the flag) or is unreachable locally; acceptance rerun should note which pipeline executed.
- **Shim lifecycle unmanaged** — no supervisor in-repo; if the shim is down, extract fails opaquely. Out of scope to manage it, but the env-seeding/docs item should state the "shim must be running" precondition; a `local-firecrawl health` probe is a candidate follow-up bead, not part of this epic.
- **Concurrency 2 FIFO queue** — extract fan-out serializes behind the shim; long extracts may hit timeouts. Mitigation: trivial extract for acceptance; note as known limitation in docs sync.

## Sequencing

Ordered work items with blocking edges (this becomes the bead DAG):

1. **Harden empty-string LLM base URLs in API config** — wrap `OPENAI_BASE_URL`/`OLLAMA_BASE_URL` in `emptyStringAsUndefined` (`apps/api/src/config.ts:71,325`); add colocated vitest regression test. *No dependencies.*
2. **Route OpenAI provider through chat completions for the shim** — add default-off config flag; extend `getModel` (`apps/api/src/lib/generic-ai.ts:56-66`); vitest unit coverage for flag-on/flag-off; confirm fire-0 path shares the provider. *No dependencies.*
3. **Extend launcher disabled-tool list to monitors and feedback** — 9 names into `scripts/local-firecrawl-mcp.lib.mjs:1-18`; update `scripts/local-firecrawl-mcp.test.mjs` literals/count; add a `-32601` rejection assertion. *No dependencies.*
4. **Seed local env template and self-host docs with shim wiring** — `scripts/init-local-env.sh` defaults (`OPENAI_BASE_URL=http://host.docker.internal:3030/v1`, chat-mode flag set true, `MODEL_NAME` for codex); `SELF_HOST.md` wording. AC: a fresh `scripts/init-local-env.sh` run yields an env file containing the shim base URL, the finalized flag name set true, and a `MODEL_NAME` line set to a codex-supported model — the value is proposed by the implementer from `codex exec --model` support and confirmed with the human before merge (resolves spec Open Question 2; a commented placeholder line is not acceptable); `SELF_HOST.md` states "empty behaves as unset" and the shim-must-be-running precondition. *Blocked by item 2* (flag name and mechanism must be final).
5. **Sync lat.md documentation** — capability-filter section, testing suites, shim consumer note if needed; `lat check` green. *Blocked by items 1, 2, 3, 4.*
6. **Recorded manual MCP tool-matrix acceptance rerun** — extract via shim succeeds, monitor/feedback rejected, and the eight 2026-08-01 baseline-passing tools re-verified. AC: evidence recorded as a comment on this item's bead in the format defined in Testing Strategy (per-tool result table against the baseline, extract job id + `completed` payload, which extract pipeline ran, confirmation of no monitor 500s in API logs). *Blocked by items 1-5 plus human prerequisites (codex install dedupe, shim running, MODEL_NAME value agreed).*

**Parallelism:** items 1, 2, 3 run fully in parallel (disjoint files). Item 4 follows 2. Item 5 fans in from 1-4. Item 6 is the terminal gate.

## Backlog Refinement

No P4 backlog sources. Two direct P2 sources:

- **firecrawl-dsw** (P2 bug, extract base URL) — maps to plan items **1, 2, 4** (config hardening + chat-mode routing to the shim + env seeding), verified by item 6. **Disposition: split-and-supersede.** The bead's original framing ("empty base URL crashes extract") is now one-third of the real fix (Clarifications Q1 redirected the target to the Codex Shim); one bead cannot carry three independently implementable tasks with distinct acceptance criteria. Supersede it with the three new task beads under the epic, linked back for provenance. Acceptance criteria carried over: no `Failed to parse URL from /responses` possible from blank env lines (item 1); extract LLM traffic is chat-completions against the shim (item 2); fresh env template works without manual URL surgery (item 4).
- **firecrawl-4e1** (P2 task, monitor/feedback disable) — maps 1:1 to plan item **3**. **Disposition: refine-in-place.** Scope is unchanged from the bead's intent; refine it with the concrete acceptance criteria (17-name `disabledLocalToolNames`, tools absent from `tools/list`, `-32601` on direct call, `scripts/local-firecrawl-mcp.test.mjs` literals updated and green) and link it under the new epic.

## Target Epic

A **new epic** bead will be created for this feature (mcp-extract-monitors), owning plan items 1-6 as P0-P3 task beads with the dependency edges above (no P4 tasks). firecrawl-dsw is superseded by items 1/2/4's beads; firecrawl-4e1 is refined in place as item 3's bead — both linked under the epic per their dispositions. Candidate follow-up beads recorded on the epic but outside it: server-side `DB_DISABLED`-style gate for monitor routes, `local-firecrawl health` shim probe, future local monitor enablement (migrations + scheduler + artifacts).

## Alignment fixes applied

- Defined the manual acceptance rerun's evidence format (per-tool result table against the 2026-08-01 baseline, extract job id + `completed` payload, which extract pipeline executed, no-monitor-500s confirmation, recorded as a bead comment) in Testing Strategy and item 6's AC — Pass 1 (Clarification Q4 was PARTIAL: "recorded" had no format or location), must-fix.
- Added the spec constraint that the eight 2026-08-01 baseline-passing tools (scrape, search, map, crawl, check_crawl_status, parse, interact, interact_stop) must be re-run and still pass, to Testing Strategy and item 6 — Pass 1 (constraint was a GAP in the plan's acceptance scope), must-fix.
- Added an explicit rollback story for the chat-mode flag to Risks (unset/false the flag + revert the env-template line restores the Responses default; item-1 hardening needs no rollback path) — Pass 2 (completeness: rollback unstated), must-fix.
- Tightened item 4 with a verifiable AC (fresh `scripts/init-local-env.sh` output must contain the shim base URL, finalized flag set true, and a concrete codex-supported `MODEL_NAME` — implementer proposes, human confirms, no commented placeholder; `SELF_HOST.md` wording checks named) — Pass 2 (testability: `MODEL_NAME` deferral read as placeholder criteria unfit for a bead), should-fix.
