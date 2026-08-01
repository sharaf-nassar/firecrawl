# Analysis: searxng-default-search

## Coverage Table

| User story / requirement | Covered by (plan section) | Status |
|--------------------------|---------------------------|--------|
| G1 — Bundle SearXNG by default for `scripts/local-firecrawl` while preserving explicitly configured Fire Engine precedence outside the local stack. | Architecture Approach provider matrix and internal/external modes; Sequencing: secure service, environment migration, lifecycle. | full |
| G2 — Route ordinary local API and MCP web search through SearXNG without manual provider setup; fail explicitly when no provider exists. | Architecture Approach resolver and `503` contract; API / Interface Changes; Sequencing: shared provider, REST, MCP. | full |
| G3 — Remove direct DuckDuckGo code, fallback, configuration, tests, and docs; prohibit DuckDuckGo engines and autocomplete in bundled SearXNG. | Architecture Approach tracked `keep_only` policy and override validation; Affected Components deletion list; Testing Strategy zero-match and settings checks. | full |
| G4 — Keep bundled SearXNG private with no host/public port. | Architecture Approach backend-only network and hardening; Runtime and configuration tests; Sequencing: secure service/settings. | full |
| G5 — Separate process/config startup readiness from a real-query functional health check. | Architecture Approach exact local `/healthz` probe; API / Interface Changes exact wrapper smoke; wrapper and E2E tests. | full |
| G6 — Report provider outages explicitly instead of returning misleading empty success. | Architecture Approach canonical error taxonomy and zero-result classification; API / Interface Changes exact envelopes; controller/MCP tests. | full |
| G7 — Accurately document supported local search sources and options. | API / Interface Changes web-only contract; Affected Components docs and lat.md inventory; Sequencing: documentation task. | full |
| G8 — Add deterministic coverage for selection, mapping, failures, Compose, wrapper, and MCP behavior. | Testing Strategy unit, contract, rendered-runtime, wrapper, MCP, CI, benchmark, and E2E gates. | full |
| US1 — Reliable local MCP search: bundled healthy service, mapped smoke result, and no DuckDuckGo request. | Architecture Approach local topology; API / Interface Changes fixed smoke; Testing Strategy settings, wrapper, MCP, and final zero-match acceptance. | full |
| US2 — Explicit provider failure: stable `502`/`503`, MCP tool errors, no billing, valid empty `200`, partial warning, and redacted logs. | Architecture Approach error/billing contract; API / Interface Changes exact REST/MCP envelopes; API and wrapper tests; x402 prototype/implementation tasks. | full |
| US3 — Private-by-default infrastructure: internal networking, pinned private JSON service, bounded startup readiness, and post-start scrape/crawl availability. | Architecture Approach pin, network, settings, hardening, and two-tier health; Runtime tests; lifecycle and E2E tasks. | full |
| US4 — Maintainable provider contract: direct DuckDuckGo absent, focused provider tests, synchronized docs, and web-only MCP/REST enforcement. | Affected Components; API / Interface Changes; Testing Strategy; Sequencing: provider, REST, MCP, CI, documentation, and E2E tasks. | full |
| C1 — Keep `scripts/local-firecrawl` as the supported lifecycle and recovery entrypoint. | Architecture Approach wrapper-owned ordering and modes; Affected Components wrapper scope; lifecycle task. | full |
| C2 — Keep Firecrawl API at `127.0.0.1:3002` and SearXNG internal to Compose. | Architecture Approach backend-only/no-port design; rendered-Compose and no-port tests. | full |
| C3 — Preserve Fire Engine precedence outside local mode, use local SearXNG inside it, and remove direct DuckDuckGo globally. | Architecture Approach explicit local/non-local provider matrix; resolver tests; provider-removal task. | full |
| C4 — Make local search web-only; hide unsupported MCP inputs and feedback; reject unsupported REST semantics. | Architecture Approach `LOCAL_SEARCH_WEB_ONLY`; API / Interface Changes exact `400` and `-32602`; REST and MCP tasks. | full |
| C5 — Treat upstream engine selection and outbound networking as privacy/operations boundaries. | Architecture Approach explicit allowlist, POST, safe search, query-safe diagnostics, and override boundary; qualification and docs tasks. | full |
| C6 — Do not add Valkey or public limiter complexity. | Architecture Approach private/no-limiter/no-Valkey settings and rejected alternatives; static settings tests. | full |
| C7 — Avoid flaky recurring upstream startup health. | Architecture Approach local process/config Compose probe; API / Interface Changes bounded wrapper smoke; no-live-upstream CI rule. | full |
| C8 — Use one bounded attempt with exact deadlines, pagination/results, concurrency, engine retry, pool, and container limits. | Architecture Approach numeric bounds; Data Model; benchmark/qualification acceptance; operational-value freeze dependency. | full |
| C9 — Migrate blank endpoints to `http://searxng:8080` while preserving validated external overrides. | Architecture Approach internal/external modes; Data Model URL normalization; environment and lifecycle tests. | full |
| C10 — Generate a dedicated secret, use POST and query-safe logging, avoid host ports, harden the container, and pin updates to an owner. | Architecture Approach security settings; Data Model secret; Risks monthly local-runtime-maintainer cadence; runtime/redaction tests. | full |
| C11 — Update Compose, environment lifecycle, health/status, API, MCP, tests, docs, and lat.md. | Affected Components complete inventory; Sequencing assigns implementation, validation, CI, documentation, and E2E work. | full |
| C12 — Continue without a constitution only after human clarification. | Spec Clarifications records approval; Risks records constitution absence; Constitution Check below. | full |
| CL1 — Bundle only for the local wrapper; preserve Fire Engine elsewhere; fail when neither provider exists. | Architecture Approach provider matrix and wrapper-only topology; provider, environment, and lifecycle tasks. | full |
| CL2 — Ban every bundled DuckDuckGo path and ship a small tested keyless allowlist with constrained operator overrides. | Architecture Approach four candidates, `keep_only`, explicit enablement, deny validation, and qualification gate. | full |
| CL3 — Limit local search to web; reject or hide unsupported REST/MCP/feedback capabilities. | Architecture Approach capability mode; API / Interface Changes; REST and MCP tasks. | full |
| CL4 — Apply exact `502`/`503`/`200`/partial semantics across callers without billing provider failures. | Architecture Approach canonical domain errors, single mapper, consumer and x402 boundaries; API / Interface Changes; contract tests. | full |
| CL5 — Require local startup readiness without making later search outages disable scrape/crawl; use bounded wrapper functional health. | Architecture Approach health split; API / Interface Changes exact smoke; lifecycle and E2E tasks. | full |
| CL6 — Use one capped attempt, no Firecrawl retry/circuit breaker, bounded load, and SearXNG engine suspension. | Architecture Approach exact 10-second/100-result/five-page/concurrency-four contract and engine/pool bounds; benchmark task. | full |
| CL7 — Migrate blank envs, preserve external endpoints, generate a secret, use POST/redaction/private hardening/pinning, and exclude generic Compose/Helm. | Architecture Approach modes/security/scope; Data Model; Risks rollback/update cadence; environment, lifecycle, and docs tasks. | full |
| NG1 — Do not operate a public or multi-tenant SearXNG service. | Architecture Approach private topology, no limiter/public behavior, no host port, and rejected alternatives. | full |
| NG2 — Do not claim upstream-engine uptime or eliminate all CAPTCHA/rate limits. | Risks explicitly retains upstream variability; qualification gates behavior without claiming an SLA. | full |
| NG3 — Do not add an unspecified paid search provider. | Architecture Approach changes x402 ordering only for existing search; no new provider adapter appears in Affected Components or Sequencing. | full |
| NG4 — Do not restore DuckDuckGo through a fallback, flag, alias, engine, or undocumented escape hatch. | Architecture Approach global provider deletion and bundled override deny policy; static and final zero-match checks. | full |
| NG5 — Do not share Firecrawl Redis or add Valkey. | Architecture Approach no-Valkey design; Data Model states no durable volume; static settings tests. | full |
| NG6 — Do not implement image/news/geo/recency/enterprise/feedback capabilities in this MVP. | Architecture Approach rejected alternative and web-only mode; API / Interface Changes rejects/hides them; capability tests. | full |
| NG7 — Do not bundle SearXNG into generic Compose, Helm, or hosted deployments. | Architecture Approach wrapper-only overlay and provider-explicit non-local distributions; documentation task records boundary. | full |

## Backlog Disposition

| Source P4 id | Plan work item(s) / non-goal | Disposition | Ready to resolve? |
|--------------|-------------------------------|-------------|-------------------|
| None — no source P4 inputs were supplied or discovered. | Backlog Refinement creates 15 new P1/P2 work items and no P4 placeholders. | No source issue requires refinement, supersession, retirement, or non-goal approval. | yes |

## Target Epic

New epic: **SearXNG-backed local search**. The plan assigns 15 implement-ready children (12 P1, 3 P2), with four independent P1 roots and explicit dependency edges. No existing or candidate epic remains ambiguous.

## Remaining Risks

- Upstream engines may throttle, block, or change behavior. Qualify each candidate independently, require at least two diverse engines, remove failures without substituting DuckDuckGo, and block the epic if the minimum cannot be met.
- The pinned image may not support the proposed `wget` readiness command, UID/GID, or read-only cache paths exactly as planned. Verify command availability, effective settings, permissions, and current-architecture boot before accepting the service task.
- SearXNG may encode partial or total engine failure inside HTTP 200 responses. Strict envelope and selected-engine validation, explicit zero-valid branches, and contract fixtures mitigate false empty success.
- x402 settlement ordering may currently bill before provider failure or allow duplicated provider execution if reordered. A separate root prototype freezes authorization, rate-limit, replay, provider-call, and settlement invariants before implementation.
- Internal/external endpoint normalization and mode changes could start the wrong service or leave a stale container. A shared normalizer plus render, switch, stale-stop, rollback, and re-upgrade tests gate lifecycle work.
- Existing controller logging may leak raw query or provider configuration. Provider/controller log assertions must reject query, URL, body, endpoint, credentials, and detailed engine errors.
- Required CI does not yet run focused API search contracts. The CI-command discovery spike must prove exact local commands before workflow changes, and CI must remain free of live upstream traffic.
- Initial performance and resource values may fail on the supported host baseline. The operational-freeze task blocks downstream CI/docs, requires p95 below 6 seconds and no request beyond 10 seconds, and blocks rather than silently weakening acceptance.
- Rollback cannot rely on an older wrapper to remove a new SearXNG container. Operators must switch to a validated external endpoint with current code before restoring older code; lifecycle documentation and E2E cover this sequence.

## Unresolved Questions

- Which subset of `brave`, `qwant`, `startpage`, and `bing` will pass live keyless-engine qualification? The plan requires at least two and forbids DuckDuckGo substitution.
- Does the pinned image provide the exact `wget` health probe and support all non-root/read-only hardening assumptions? The secure-service task must verify both before closure.
- What is the repository's current x402 provider/settlement ordering, and which ordering preserves authentication, rate-limit, replay, and exactly-once settlement? The root prototype resolves this before x402 implementation.
- Which exact focused API, wrapper, MCP, Compose, and settings commands succeed in the rebuilt repository CI? The root CI-command discovery task freezes them before workflow edits.
- Do the proposed deadline, pools, concurrency, memory, PID, and tmpfs limits meet the benchmark thresholds on the declared Linux x86_64 baseline? The operational-value task freezes the answer before CI and documentation.

These are bounded implementation-validation questions with blocking acceptance criteria, not unresolved product scope or epic ownership decisions.

## Constitution Check

No constitution.md — skipped.

## Recommendation

**GO** — every goal, user story, constraint, clarification answer, and non-goal has full plan coverage; no source P4 input or target-epic ambiguity remains. The 15-item dependency graph isolates risky unknowns into root prototypes or blocking qualification tasks, freezes operational values before CI and documentation, and reserves final non-mutating E2E verification for the integrated contract. Remaining questions can change qualified values or block implementation, but they do not require another product decision before creating the planned P1/P2 beads.
