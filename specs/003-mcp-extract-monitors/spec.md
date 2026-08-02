# Spec: mcp-extract-monitors

## Problem Statement

A full tool-matrix run of the local Firecrawl MCP launcher on 2026-08-01 (self-hosted stack at `http://127.0.0.1:3002`, launcher `scripts/local-firecrawl-mcp` pinning `firecrawl-mcp@3.22.3` at `scripts/local-firecrawl-mcp:17`) found two broken capability groups while every other tool (scrape, search, map, crawl, check_crawl_status, parse, interact, interact_stop) passed:

1. **`firecrawl_extract` fails on trivial input.** Extracting from `https://example.com` returns `"status":"failed","error":"Failed to parse URL from /responses"` even though the local LLM key is configured. Root-cause analysis (below, and in Open Questions where inconclusive):
   - `scripts/init-local-env.sh:107-108` seeds the local env file with `OPENAI_API_KEY=` and `OPENAI_BASE_URL=` — the base URL line is intentionally blank for operators who only fill in the key.
   - `docker-compose.yaml:38-39` forwards these verbatim into the API container: `OPENAI_API_KEY: ${OPENAI_API_KEY}`, `OPENAI_BASE_URL: ${OPENAI_BASE_URL}`. Compose interpolation of an empty variable yields an **empty string**, not an unset variable.
   - `apps/api/src/config.ts:71` declares `OPENAI_BASE_URL: z.string().optional()` **without** the `emptyStringAsUndefined` preprocessor that the config module already defines (`apps/api/src/config.ts:13-14`) and applies to other vars (e.g. `FDB_CLUSTER_FILE`, `NUQ_BACKEND` at `apps/api/src/config.ts:123-124`). So `config.OPENAI_BASE_URL === ""`.
   - `apps/api/src/lib/generic-ai.ts:25-28` passes that empty string into `createOpenAI({ apiKey, baseURL: config.OPENAI_BASE_URL })`. `@ai-sdk/openai@3.0.71` (`apps/api/package.json:91`) treats `""` as a set base URL (empty string is not nullish, so the `https://api.openai.com/v1` default never applies), and its default model path uses the OpenAI **Responses API**, producing the relative request URL `"" + "/responses"` → `fetch("/responses")` → `Failed to parse URL from /responses`. (Exact `@ai-sdk` internals unverified — node_modules is not installed in this worktree; see Open Questions.)
   - Note `apps/api/src/lib/generic-ai.ts:22` selects `defaultProvider` via `config.OLLAMA_BASE_URL ? "ollama" : "openai"` — the same empty-string wiring is *accidentally harmless* there because `""` is falsy, which is why the failure lands in the OpenAI client rather than Ollama.
   - The same tool call also surfaced a deprecation warning: `/v2/extract/:jobId is deprecated, use /v2/scrape json format`, emitted by `deprecationMiddleware("v2_extract"/"v2_extract_status")` at `apps/api/src/routes/v2.ts:409,419` with messages defined in `apps/api/src/lib/deprecations.ts:23,28`. This is a hosted-API lifecycle signal, orthogonal to the bug.

2. **Monitor and feedback tools are exposed but unbacked.** `firecrawl_monitor_create`/`firecrawl_monitor_list` return opaque 500s ("An error occurred... Error ID: ..."), `firecrawl_monitor_get`/`firecrawl_monitor_checks` return "Bad Request" on dummy ids, and `firecrawl_feedback` returns a clean 503 `{"feedbackErrorCode":"DB_DISABLED",...}`.
   - The monitor controller (`apps/api/src/controllers/v2/monitor.ts`) calls straight into the drizzle-backed store (`apps/api/src/services/monitoring/store.ts` importing `db` from `apps/api/src/db/connection.ts`) with **no deployment gate**. The `monitors` table is defined in the ORM schema (`apps/api/src/db/schema/public.ts:1232`) but no local migration creates it — `apps/api/src/db/migrations/` (0001–0011) only *references* `monitor_id`/`monitor_check_id` columns on webhook rows (`0001_persistence_foundation.sql:45-46,75-76`). So even with `LOCAL_PERSISTENCE_ENABLED=true` (wired at `compose.local.yaml:38,278`), monitor queries hit a missing relation and surface as generic 500s. Monitors additionally depend on a cron scheduler (`apps/api/src/services/monitoring/scheduler.ts`), GCS diff artifacts (`apps/api/src/lib/gcs-monitoring.ts`), and email recipient sync — none provisioned locally.
   - Feedback, by contrast, gates cleanly: `apps/api/src/controllers/v2/feedback/record.ts:86-93` returns 503 `DB_DISABLED` whenever `USE_DB_AUTHENTICATION !== true` (the local default per `docker-compose.yaml:33`).
   - Repo policy (`lat.md/operations/local-runtime.md`, section "Local MCP capability filter", line 91) is that the launcher disables capabilities unbacked by the local stack **while preserving upstream tool names for future enablement**. `createDisabledLocalTools`/`disabledLocalToolNames` in `scripts/local-firecrawl-mcp.lib.mjs:1-25` already do this for `firecrawl_agent`, `firecrawl_agent_status`, five `firecrawl_research_*` tools, and `firecrawl_search_feedback`. The monitor and feedback tools were never added to that list, so local MCP users get raw backend errors instead of the policy-standard "disabled in the local Firecrawl MCP" JSON-RPC error (`scripts/local-firecrawl-mcp.lib.mjs:343-362`).

This affects local-stack MCP users (interactive agent sessions using the launcher) now: extract is a headline capability that silently fails after job submission, and the monitor tools invite agents into dead-end retry loops against opaque 500s.

## Clarifications

Human answers to the Spec Review critical questions (2026-08-01), grounded by follow-up investigation in this worktree:

- **Q1 (extract LLM): "extract should be using codex! we built a sidecar for this."** The intended extract backend is the host-side Codex Shim (`apps/codex-shim/`), not api.openai.com. `createCodexShimServer` (`apps/codex-shim/src/server.mjs:105-119`) binds `0.0.0.0:3030` by default (`CODEX_SHIM_HOST`/`CODEX_SHIM_PORT`/`CODEX_SHIM_MAX_CONCURRENCY` overrides, concurrency 2) and translates chat completions into ephemeral `codex exec --ephemeral --json` runs via `createCodexTranslator` (`apps/codex-shim/src/translate.mjs`). It accepts **only** `POST /v1/chat/completions` (`server.mjs:206`), explicitly rejects `/v1/embeddings` (`server.mjs:192`), and has no OpenAI Responses-API `/responses` endpoint. So extract must be wired to the shim — not disabled, not pointed at api.openai.com. Wiring findings:
  - The API container can reach the host shim at `http://host.docker.internal:3030/v1` — `docker-compose.yaml:15-16` already declares `extra_hosts: host.docker.internal:host-gateway` on the common service anchor.
  - Neither `scripts/local-firecrawl` nor any compose file references the shim (`codex-shim`/`3030`/`CODEX_SHIM` have zero hits); the shim is a host process outside the wrapper's lifecycle. The wrapper's Codex handling (`scripts/local-firecrawl:94-149`) resolves/bind-mounts the host `codex` package for the containerized Codex service only.
  - The empty-`OPENAI_BASE_URL` root cause stands, but its resolution is now "point the env at the shim URL + force chat-completions mode," with `emptyStringAsUndefined` hardening as defense in depth.
  - Embeddings are **not** on the extract path: `getEmbeddingModel` (`apps/api/src/lib/generic-ai.ts:68`) is used only by `performRanking` in `apps/api/src/lib/ranker.ts:12`, which has no non-test callers; extract reranking is LLM-chat-based (`rerankLinksWithLLM`, `apps/api/src/lib/extract/reranker.ts`). The shim's embeddings rejection is therefore not a scope risk.
  - **Environment prerequisite (human-fixed, not a code task):** `local-firecrawl health` currently reports "Local Codex package is ambiguous: PATH resolves codex to multiple installations" (check at `scripts/local-firecrawl:133`). The human must dedupe host codex installs before end-to-end verification.
- **Q2 (feedback): disable in the launcher too.** Final disable list is **17 names**: the 8 existing entries in `disabledLocalToolNames` (`scripts/local-firecrawl-mcp.lib.mjs:1-18`: agent, agent_status, 5 research tools, search_feedback) plus 9 new (8 `firecrawl_monitor_*` + `firecrawl_feedback`). Arithmetic verified against the current list.
- **Q3 (OLLAMA_BASE_URL): yes** — apply `emptyStringAsUndefined` to both `OPENAI_BASE_URL` (config.ts:71) and `OLLAMA_BASE_URL` (config.ts:325).
- **Q4 (acceptance): automated config-level regression test + one recorded manual MCP tool-matrix rerun.** A gated live check is optional/out.

## Goals

- `firecrawl_extract` on the local stack returns structured data for a trivial schema against `https://example.com`, served end-to-end by the Codex Shim (`http://host.docker.internal:3030/v1` from the API container) — the extract job status endpoint reports `completed`, not `failed` with a URL-parse error.
- The API's OpenAI-provider client speaks **chat completions** against the shim (no `/responses` requests); the existing per-model chat escape hatch at `apps/api/src/lib/generic-ai.ts:62-64` shows the precedent, but the mechanism for shim-wide chat mode is a planning decision (see Open Questions).
- Empty `OPENAI_BASE_URL` **and** empty `OLLAMA_BASE_URL` behave identically to unset (both wrapped in `emptyStringAsUndefined`), so a blank env line can never again produce a relative-URL fetch.
- The nine unbacked monitor/feedback tools — `firecrawl_monitor_create`, `firecrawl_monitor_get`, `firecrawl_monitor_list`, `firecrawl_monitor_update`, `firecrawl_monitor_delete`, `firecrawl_monitor_run`, `firecrawl_monitor_check`, `firecrawl_monitor_checks`, `firecrawl_feedback` (names confirmed against the published `firecrawl-mcp@3.22.3` dist) — are handled per the capability-filter policy: hidden from `tools/list` and rejected on direct call with the standard `-32601` disabled-tool error, names preserved in `disabledLocalToolNames` for future enablement.
- Snapshot/fixture-locked tests in `scripts/local-firecrawl-mcp.test.mjs` are updated so the disabled-tool count assertion (currently "eight unsupported capabilities", `scripts/local-firecrawl-mcp.test.mjs:66-68`) and the `disabledToolNames` literal (`scripts/local-firecrawl-mcp.test.mjs:53-62`) reflect the full 17-name set, and all launcher tests pass.
- Acceptance evidence per Clarifications Q4: an automated config-level regression test for the empty-string base-URL path (exact placement decided at planning time) plus **one recorded manual MCP tool-matrix rerun** showing extract succeeding via the shim and monitor/feedback calls returning the launcher's disabled-tool error rather than backend 500s.
- `lat.md/operations/local-runtime.md` "Local MCP capability filter" (and any test-spec sections under `lat.md/testing/`), plus `lat.md/runtime/codex-shim.md` if the extract-to-shim wiring changes its documented boundary, updated to document the new disabled tools and the extract fix; `lat check` passes.

## Non-Goals

- Implementing real monitor or feedback backing locally (monitor tables/migrations, cron scheduler, GCS diff artifacts, email recipients, hosted-DB auth). Tool names stay reserved per policy.
- Any dependency on api.openai.com or a hosted OpenAI account for local extract — the Codex Shim is the LLM backend.
- Implementing an OpenAI Responses-API `/responses` endpoint in the shim. Investigation shows the cheaper path is on the API side: force the OpenAI provider into chat-completions mode for the shim (precedent already exists at `apps/api/src/lib/generic-ai.ts:62-64`, where o3-mini is routed via `providerList.openai.chat(...)`), so the plan should take the API-side chat-mode route and leave `apps/codex-shim/` unchanged.
- Managing the shim's process lifecycle from `scripts/local-firecrawl` or compose (it is a host process today; see Open Questions for whether a health probe is wanted).
- Enabling `USE_DB_AUTHENTICATION`/Supabase-style hosted auth on the local stack.
- Upstream changes to the `firecrawl-mcp` npm package or bumping the 3.22.3 pin.
- Migrating the launcher's extract tool off `/v2/extract` onto the `/v2/scrape` json-format path. The deprecation warning is informational; the extract failure is an LLM-client base-URL bug, not a deprecation casualty. (Revisit only if planning proves the fix must touch that path — see Open Questions.)
- General audit of every `z.string().optional()` config var for empty-string handling beyond the LLM base-URL vars implicated here.
- Changes to hosted/production deployments of the API.

## Backlog Inputs

None. (No P4 backlog sources for this run.) Note: existing P2 beads **firecrawl-dsw** (bug: extract base URL) and **firecrawl-4e1** (task: monitor/feedback disable) are the direct sources for this spec.

## Target Epic

This run will create a **new epic**. Existing beads firecrawl-dsw and firecrawl-4e1 will be linked to or superseded by the epic's tasks — they are not to be duplicated.

## User Stories

### Story 1: Local agent extracts structured data via the Codex Shim

As a local-stack MCP user (agent session), I call `firecrawl_extract` with a URL and schema so that I get structured JSON, served by the host-side Codex Shim rather than any hosted OpenAI endpoint.

**Acceptance Criteria:**
- Given the Codex Shim running on the host (default `0.0.0.0:3030`) and the local env pointing the API at it (`OPENAI_BASE_URL=http://host.docker.internal:3030/v1`, reachable via the existing `extra_hosts: host.docker.internal:host-gateway` at `docker-compose.yaml:15-16`), `firecrawl_extract` on `https://example.com` with a trivial schema returns `success: true` with populated fields.
- All extract LLM traffic from the API hits the shim's `/v1/chat/completions` endpoint — no request ever targets `/responses` or `/v1/embeddings`, and the job never fails with `Failed to parse URL from /responses` or any relative-URL fetch error.
- A config-level regression test proves that empty-string `OPENAI_BASE_URL`/`OLLAMA_BASE_URL` parse as `undefined` (falling back to provider defaults) while non-empty values pass through unchanged.
- Precondition (environment, human-owned): host codex installs deduped so `local-firecrawl health` no longer reports "Local Codex package is ambiguous" (`scripts/local-firecrawl:133`).

### Story 2: Agent gets an honest capability signal for monitors

As a local-stack MCP user, when I attempt monitor operations, I get an immediate, explicit "disabled locally" error so that I do not burn turns retrying opaque 500s or guessing at malformed ids.

**Acceptance Criteria:**
- `tools/list` from the launcher does not include any `firecrawl_monitor_*` tool or `firecrawl_feedback`.
- A direct `tools/call` naming any of the nine tools returns JSON-RPC error `-32601` with the standard message `"<name> is disabled in the local Firecrawl MCP because its external service is not configured"` (shape per `scripts/local-firecrawl-mcp.lib.mjs:352-361`), without the request reaching the local API.
- No monitor-related 500s appear in local API logs from MCP traffic.

### Story 3: Maintainer trusts the tool-set snapshot

As a repo maintainer, the launcher test suite forces an explicit review whenever the local tool surface changes, so capability drift is deliberate.

**Acceptance Criteria:**
- `node --test scripts/local-firecrawl-mcp.test.mjs` passes with the updated disabled-tool list and count.
- The test asserting the disabled set (`scripts/local-firecrawl-mcp.test.mjs:66`) enumerates all seventeen names (8 prior + 9 new) — a future upstream tool addition or removal still breaks the snapshot loudly.
- `lat check` passes with updated `lat.md` sections referencing the changed code.

## Constraints

- The Codex Shim is **chat-completions-only**: it serves `POST /v1/chat/completions` (`apps/codex-shim/src/server.mjs:206`), rejects `/v1/embeddings` as unsupported (`server.mjs:192`), and has no `/responses` endpoint. The API's extract client must not emit Responses-API or embeddings traffic at it.
- Shim concurrency defaults to **2** (`CODEX_SHIM_MAX_CONCURRENCY`, FIFO queue) — extract fan-out (batch extract, reranker calls) will serialize behind that limit; no parallelism assumptions, and timeouts must tolerate queuing.
- The shim runs on the **host** (binds `0.0.0.0:3030`); the API container reaches it only via `host.docker.internal` (`extra_hosts` host-gateway, `docker-compose.yaml:15-16`). Neither the wrapper nor compose manages the shim process.
- Host codex PATH ambiguity ("Local Codex package is ambiguous", `scripts/local-firecrawl:133`) is a **human-fixed environment prerequisite** (dedupe host codex installs), not a code task in this epic.
- The launcher pins `firecrawl-mcp@3.22.3` (`scripts/local-firecrawl-mcp:17`); tool names to disable must match that version's registrations exactly (confirmed: 8 `firecrawl_monitor_*` tools + `firecrawl_feedback` in the published 3.22.3 dist).
- Snapshot fixtures under `scripts/fixtures/` and the literal assertions in `scripts/local-firecrawl-mcp.test.mjs` intentionally force explicit updates on any tool-set drift — the change must update them, not weaken them.
- Disabled tools must **preserve names** for future enablement per `lat.md/operations/local-runtime.md:91` ("Local MCP capability filter") — no deletion or renaming semantics.
- The local stack is managed only via the `scripts/local-firecrawl` wrapper (start/stop/health/logs); no direct `docker compose` recovery, no volume deletion.
- Any behavior change requires corresponding `lat.md/` updates and a passing `lat check` (repo policy in `CLAUDE.md`).
- Test evidence baseline is the 2026-08-01 tool-matrix run: scrape/search/map/crawl/check_crawl_status/parse/interact/interact_stop pass and must keep passing; extract and monitor/feedback are the only failures in scope.
- Config module immutability/idiom: reuse the existing `emptyStringAsUndefined` helper (`apps/api/src/config.ts:13-14`) rather than inventing a parallel mechanism.

## Open Questions

Resolved by Clarifications: live-env root cause and fix direction (Q1 → shim), feedback disable (Q2 → yes, 17 names), `OLLAMA_BASE_URL` scope (Q3 → both vars), acceptance evidence (Q4 → config regression test + one recorded manual matrix rerun). Remaining genuinely open items:

1. **Mechanism for forcing chat-completions mode in `generic-ai.ts`.** Options: route the openai provider through `providerList.openai.chat(modelName)` whenever `OPENAI_BASE_URL` is set (heuristic — assumes every custom base URL is chat-only), or add an explicit config flag (e.g. `OPENAI_CHAT_COMPLETIONS_ONLY`). Must not regress hosted deployments that rely on the Responses API default. Also verify at unit level that `@ai-sdk/openai@3.0.71`'s `.chat()` path targets `/chat/completions` (node_modules absent in this worktree; the o3-mini precedent at `generic-ai.ts:62-64` strongly suggests it does).
2. **Which model name the local env should pin.** `createCodexTranslator` passes the request's `model` verbatim to `codex exec --model` (`apps/codex-shim/src/translate.mjs:266-274`), but extract call sites default to non-codex names via `getModel(...)` unless `MODEL_NAME` overrides them (`generic-ai.ts:60`). What `MODEL_NAME` value should `scripts/init-local-env.sh` / the operator set for codex, and should the template seed `OPENAI_BASE_URL=http://host.docker.internal:3030/v1` by default?
3. **Shim lifecycle and health visibility.** The shim is a host process with no supervisor found in-repo (no wrapper/compose/systemd integration). Who starts it, and should `local-firecrawl health` gain a port-3030 reachability probe so extract failures are diagnosable — or is that firmly out of scope for this epic?
4. **Fire-0 legacy extract path parity.** `apps/api/src/lib/extract/fire-0/` has its own completion plumbing (`generateCompletions_F0`, `llmExtract-f0.ts`); does it share the same provider client (and thus get fixed for free), and is it even reachable on the local stack? Confirm during planning so the manual matrix rerun exercises the right pipeline.
5. **Structured-output compatibility.** Extract relies on JSON-schema-constrained generation; the shim supports "JSON-schema response formats" via a per-call schema file (`lat.md/runtime/codex-shim.md`), but whether the ai-sdk chat path's schema mode maps cleanly onto the shim's implementation is unverified until an end-to-end run.

## Spec Review

### Critical Questions (answer before planning)

1. **Is the empty-`OPENAI_BASE_URL` root cause confirmed against the live stack?** → resolved, see Clarifications (extract is to be wired to the Codex Shim; empty-string hardening kept as defense in depth). The fix shape (one-line `emptyStringAsUndefined` at `apps/api/src/config.ts:71`) rests on two unverified links: the operator's actual runtime env value, and `@ai-sdk/openai@3.0.71` treating `baseURL: ""` as set (node_modules absent in this worktree). If the live env instead holds a wrong non-empty URL, this becomes an env-repair/docs task and the code change is a hardening no-op — effort and epic shape change materially. Folds Open Questions 1-2. Flagged by: feasibility, requirements.
2. **Disable `firecrawl_feedback` via the launcher, or leave its clean 503?** → resolved, see Clarifications (disable; 17 names total). This decides the disabled-tool count (17 vs 16), the test literals at `scripts/local-firecrawl-mcp.test.mjs:53-68`, the lat.md policy text, and Story 2's tool enumeration. The spec assumes disable (precedent: `firecrawl_search_feedback`), but the API's own `DB_DISABLED` response is already honest — two engineers would ship different tool surfaces. Folds Open Question 4. Flagged by: ambiguity, scope.
3. **Is `OLLAMA_BASE_URL` (config.ts:325) in scope for the same empty-string fix?** → resolved, see Clarifications (yes, fix both). The spec says "for consistency ... if judged in scope" — that hedge must resolve before implementation, since it changes provider selection semantics at `generic-ai.ts:22` (an empty string currently short-circuits to openai either way, but the test surface and lat.md wording differ). Folds Open Question 3. Flagged by: ambiguity, scope.
4. **What counts as acceptance evidence for Story 1?** → resolved, see Clarifications (config-level regression test + one recorded manual matrix rerun; gated live check optional/out). End-to-end extract requires a running stack plus a real LLM key — CI (`.github/workflows/ci.yml`, which runs the launcher tests) cannot exercise it. Decide the split: automated config-level regression test (placement per Open Question 8) plus a manual tool-matrix rerun as the recorded evidence, or something stronger. Without this, "done" for the headline AC is unverifiable in CI. Flagged by: requirements, feasibility.

### Non-Blocking Observations

- No new snapshot fixture *files* are needed for the monitor/feedback disable — existing fixtures under `scripts/fixtures/` capture only the rewritten interact/search tools; the change is name-list literals plus the "eight unsupported capabilities" count text. Read the fixtures-updated goal accordingly.
- MCP consumers beyond this repo (Claude Code sessions, Codex configs, permission allowlists naming `mcp__firecrawl__firecrawl_monitor_*` / `firecrawl_feedback`) will see those tools vanish from discovery. Harmless by design, but worth one line in the change description so cached-tool-list confusion is expected.
- Story 2's "no monitor-related 500s appear in local API logs" is observational, not automatable — treat it as part of the manual verification run, not a test assertion.
- Story 1 AC3 (non-empty custom `OPENAI_BASE_URL` still routes) has no local test target; verify via a unit test of config precedence rather than a live proxy.
- `SELF_HOST.md:62` documents `OPENAI_BASE_URL` as a commented example; a docs touch is likely unnecessary, but confirm the wording still matches post-fix semantics ("empty behaves as unset").
- The server-side gap — monitor routes lacking a feedback-style deployment gate, so non-MCP local API callers still get opaque 500s (missing `monitors` relation) — stays out of scope here; file it as a follow-up bead on the epic so it isn't lost.
- Monitor "Bad Request" on dummy ids comes from `monitorParamsSchema` UUID validation (`apps/api/src/controllers/v2/monitor.ts:54-60`), not the DB gap — no separate work item needed once the tools are disabled.
