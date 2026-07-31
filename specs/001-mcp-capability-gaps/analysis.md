# Analysis: mcp-capability-gaps

Report-only cross-check of `spec.md` against the final `plan.md` (post review fixes). Two review passes were applied to the plan (see plan "## Alignment fixes applied"); the spec-plan alignment pass reported 0 must-fix. This analysis independently re-verifies coverage rather than assuming it.

## Coverage Table

| User story / requirement | Covered by (plan section) | Status |
|---|---|---|
| Goal 1 — extract succeeds e2e via codex-shim | Architecture §1 (shim service, translation, luna/terra mapping); Sequencing 3, 4, 5, 9 | full |
| Goal 2 — fail-fast at both layers (launcher hide + API 4xx) | Architecture §2 (precondition + probe semantics), §3(a) (session-start probe, hide from `tools/list`); Sequencing 7, 8 | full |
| Goal 3 — interact surface matches prompt-only reality | Architecture §3(b) rewrite, §3(c) intercept, §3(d) drift guard; Sequencing 10, 11 | full |
| Goal 4 — orchestration documents shim; fresh setup = explicitly disabled | Architecture supervision paragraph (`start` never auto-starts shim), §4 (docs surface decided: `.env.example.local` + lat.md only, compose untouched); Sequencing 6 | full |
| Goal 5 — lat.md docs updated (`http.md` Extract, `local-runtime.md`) | Architecture §4; Affected Components; Sequencing 12 | full |
| Goal 6 — measurable acceptance incl. json-format scrape | Testing Strategy (spike, unit, e2e suites); Sequencing 9; plan coverage self-check | full |
| Story 1 AC1 — extract returns `completed` + schema-conformant data, deterministic fixture | Testing Strategy fixture bullet (harness-served static HTML via `host.docker.internal`, 3-field schema); Sequencing 5, 9 | full |
| Story 1 AC2 — raw API path completes, no `extract.dlq` parking | Testing Strategy extract-e2e bullet; Sequencing 9 AC | full |
| Story 1 AC3 — works after cold `local-firecrawl restart` | Testing Strategy ("rerun after `local-firecrawl restart` covers AC3"); Sequencing 9 | full |
| Story 1 AC4 — all LLM calls route through shim, none to hosted OpenAI | Testing Strategy + Sequencing 9 AC (shim access-log count across gating/per-URL/rerank phases; non-secret placeholder key makes hosted calls 401-fail — negative half, alignment fix 12) | full |
| Story 1 AC5 — scrape `formats: ["json"]` through the shim | Testing Strategy json-scrape bullet; Sequencing 9; API/Interface Changes records the accepted no-gate asymmetry for scrape | full |
| Story 2 AC1 — both mechanisms fire (tool hidden + API 4xx) | Architecture §2, §3(a); Sequencing 7, 8, 9 (API half) | full |
| Story 2 AC2 — "configured" = probed alive; session-start evaluation, accepted staleness | Architecture §2 (probe semantics: any-HTTP-alive, 1.5s fail-closed, ~15s cache; Ollama `/api/tags` variant), §3(a); Sequencing 7, 8 ACs | full |
| Story 2 AC3 — empty-string vars treated as unset, scoped to the five LLM vars | Architecture §2(a); Affected Components (`config.ts` per-field coercion); Sequencing 7 AC (no `createOpenAI({ apiKey: "" })`) | full |
| Story 2 AC4 — `local-firecrawl status` shows extract capability, never echoes auth | Architecture supervision paragraph; API/Interface Changes CLI bullet; Sequencing 6 AC | full |
| Story 3 AC1 — `tools/list` entry rewritten (description + `inputSchema`) | Architecture §3(b); Sequencing 10 AC (no code/bash/python/stdout claims survive) | full |
| Story 3 AC2 — stray `code`-bearing calls intercepted with clear prompt-only error | Architecture §3(c); Sequencing 10 | full |
| Story 3 AC3 — drift guard coupled to pinned `firecrawl-mcp@3.22.3` | Architecture §3(d); Sequencing 11 (fixture + snapshot + version assertion) | full |
| Story 3 AC4 — prompt-driven interact still succeeds e2e | Testing Strategy interact regression bullet (snips + launcher smoke); Sequencing 10 AC | full |
| Story 3 AC5 — `firecrawl_interact_stop` unchanged | API/Interface Changes; Sequencing 10 AC | full |
| Story 4 AC1 — fresh setup lands in deliberate disabled state; two enablement steps | Architecture supervision paragraph + §4; Sequencing 6, 7 | full |
| Story 4 AC2 — `init-local-env.sh` / `.env.example.local` document the LLM vars | Architecture §4; Affected Components; Sequencing 6 AC | full |
| Story 4 AC3 — no new compose service; host-side shim via `host.docker.internal` | Architecture §1 rationale + port/bind paragraph; Affected Components (compose byte-untouched); Sequencing 6 | full |
| Story 4 AC4 — lat.md updated, `lat check` passes | Sequencing 12 AC | full |
| Clarification Q1 — codex-shim backend (codex exec translation, luna/terra, 501 embeddings) | Architecture §1 (full route surface, mapping keyed by incoming model name — resolves spec OQ3); Sequencing 3, 4 | full |
| Clarification Q2 — explicitly disabled fresh-setup default | Architecture supervision paragraph (deliberate start/stop asymmetry); Sequencing 6 | full |
| Clarification Q3 — both-layer fail-fast, probed-alive, scoped coercion | Architecture §2, §3(a); Sequencing 7, 8 | full |
| Clarification Q4 — rewrite + intercept + drift guard | Architecture §3(b)-(d); Sequencing 10, 11 | full |
| Clarification Q5 — alias via `OPENAI_BASE_URL`, no parameterization | Affected Components (`generic-ai.ts`, `llmExtract.ts`, `completions/*` explicitly unchanged) | full |
| Clarification Q6 — json-scrape promoted to AC; sibling audit deferred | Sequencing 9 (json-scrape e2e); sibling audit correctly absent from plan scope (spec Non-Goal) | full |
| Clarification Q7 — accepted quota-burn risk; no auth material echoed | Architecture §1 `/health` + port/bind paragraph (firewall note); Sequencing 3, 4, 6 ACs (no auth in logs/payloads/status) | full |

All 6 Goals, all 19 Story ACs, and all 7 Clarifications trace to concrete plan sections and sequencing items with matching acceptance criteria. The plan's own coverage self-check (Sequencing tail) agrees with this independent trace. No partial or missing rows.

## Backlog Disposition

None — no source backlog issues (spec Backlog Inputs: None).

| Backlog issue | Disposition |
|---|---|
| — | — |

## Target Epic

New epic — created during bead materialization.

## Remaining Risks

Carried from the plan's Risks section, verified against the final plan; all have named mitigations or explicit accepted-risk status.

1. **Spawn latency vs MCP client timeout.** ~2-10s per `codex exec` across gating + per-URL + rerank calls while upstream `firecrawl_extract` blocks polling until completion. Mitigations: luna/low for gating, tiny fixture, concurrency cap; the spike (Sequencing 5) produces the real number. Residual: large multi-URL extracts may exceed client budgets — raw-API polling documented as fallback; no streaming this epic.
2. **`codex exec` output variance vs strict `json_schema`.** `--output-schema` constrains the final message but transcript noise/partial JSON is possible. Mitigation: shim parses the `--json` event stream for the final structured message, validates parseability, maps failures to OpenAI-style errors (failed extract, not a hang).
3. **Upstream `firecrawl-mcp` bump re-advertising code execution or extract.** Mitigated by the drift guard (version-pin assertion + rewrite snapshot, Sequencing 11) — a bump fails the launcher suite loudly.
4. **Host-process supervision fragility.** Pidfile staleness, port squatting, log growth — promoted to Sequencing 6 acceptance criteria. Explicit decision: **no auto-restart**; a crashed shim stays down and is surfaced by both fail-fast layers rather than resurrected.
5. **Concurrent `codex exec` spawns + `~/.codex` auth refresh races.** Concurrency cap (default 2) + FIFO queue reduces exposure; if the spike shows `auth.json` corruption, adopt the browser-interaction-worker's `AbortableMutex`-around-spawn pattern shim-side.
6. **Unauthenticated shim on `0.0.0.0:3030`.** Accepted risk per Clarifications Q7 (reduces to subscription-quota burn); bind must be `0.0.0.0` for bridge reachability. LAN exposure noted in docs — operators may firewall the port. `stop`/`restart` teardown guarantees no orphaned listener.
7. **Model quality of luna/terra for schema-following extraction is unvalidated** until the spike runs a real extract; the fixture schema is kept trivially satisfiable to bound this.
8. **Fixture reachability.** `host.docker.internal` scraping from fetch/playwright engines unverified (playwright-service may lack `extra_hosts`); spike verifies, fallback is serving from an in-network container port.

## Unresolved Questions

Near-empty by design — spec Open Questions 1-3 and 6 are resolved in the plan (port 3030 + `/health` shape; `local-firecrawl`-managed supervision; mapping keyed by incoming model name; `language: z.literal("node")` kept as-is). Deliberately deferred to the spike (Sequencing 5), which gates only e2e test sizing:

1. **Exact MCP client timeout budget for blocking extract polls** — the spike produces the wall-clock number; until then the worst-case-latency-vs-budget question stays open (plan documents raw-API polling as the fallback).
2. **Fixture reachability from all scrape engines** — spike verifies `host.docker.internal` from fetch/playwright paths; a concrete fallback (in-network container port) is already identified if it fails.

## Constitution Check

No constitution.md — skipped.

## Recommendation

**GO.** Coverage verification found every spec Goal, all 19 acceptance criteria across the four user stories, and all seven Clarification decisions traced to specific plan architecture sections and sequencing items with matching ACs — full coverage, no partials, consistent with the plan's own self-check. All must-fix findings from both review passes are folded in (12 recorded fixes, including the untracked-launcher P0, probe semantics, shim lifecycle teardown, and the Story 1 AC4 negative half). The remaining risks are either measured by the front-loaded spike (latency, fixture reachability, model quality) or explicitly accepted with documented mitigations (unauthenticated port, no auto-restart, quota burn), and the two remaining open questions are spike-scoped with fallbacks already named. The sequencing graph is sound: the spike gates only e2e test sizing, the interact track is independent of the LLM-backend work past the shared launcher prerequisites, and the untracked launcher is correctly rooted as P0. Nothing blocks bead materialization.
