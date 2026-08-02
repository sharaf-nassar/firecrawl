# Spec: searxng-default-search

## Problem Statement

Local MCP web search currently falls back to scraped DuckDuckGo whenever no external provider is configured. Anti-bot blocking makes that path intermittent, and provider exhaustion is reported as a successful empty result. Local operators need a dependable, explicit search dependency whose failures are visible.

## Goals

- Run SearXNG as the default search provider for the `scripts/local-firecrawl` stack while preserving explicitly configured Fire Engine precedence outside that stack.
- Route ordinary local API and MCP web searches through SearXNG without manual endpoint or engine selection after required Brave credential setup; installations with neither SearXNG nor Fire Engine fail explicitly.
- Remove the direct DuckDuckGo provider, fallback branch, configuration surface, tests, and documentation, and disable every DuckDuckGo engine and autocomplete backend in the bundled SearXNG configuration.
- Keep SearXNG private to the internal service network and expose no host or public port by default.
- Make Compose readiness prove process/config health without upstream traffic, then make wrapper `health` prove that the JSON search API can answer one bounded real query.
- Return an explicit provider-unavailable error when SearXNG cannot answer instead of HTTP 200 with empty data.
- Document supported search sources and options accurately so MCP clients do not infer capabilities that the local adapter does not implement.
- Provide deterministic automated coverage for provider selection, response mapping, failure semantics, Compose wiring, and launcher capability exposure.

## Non-Goals

- Operating a public or multi-tenant SearXNG instance.
- Providing an uptime SLA for upstream search engines or preventing all upstream CAPTCHA and rate-limit events.
- Adding a generic paid search API without an explicit provider adapter.
- Reintroducing DuckDuckGo as a fallback, feature flag, or undocumented escape hatch.
- Sharing Firecrawl's Redis with SearXNG or adding Valkey unless rate limiting or public exposure becomes a separate requirement.
- Expanding the current SearXNG adapter to every image, news, geo, recency, or advanced v2 search option unless clarification makes those capabilities part of this feature.
- Making search feedback work without its database dependency; feedback capability policy is addressed only where the new search contract requires it.
- Bundling SearXNG into generic `docker-compose.yaml`, Helm, or hosted deployments; those distributions keep explicit provider configuration and fail clearly when none is available.

## Backlog Inputs

None. The request does not reference an existing epic or P4 backlog issue, and no source backlog was supplied to this molecule.

## Target Epic

This run will create a new feature epic for SearXNG-backed local search.

## User Stories

### Reliable local MCP search

As a local MCP user, I want search to use the bundled SearXNG service, so that ordinary web searches do not depend on a brittle scraped fallback.

Acceptance Criteria:

- A default local stack started through `scripts/local-firecrawl` includes a healthy internal SearXNG service.
- Bundled startup requires a privately collected Brave Search API key, enables exactly official `braveapi` plus Bing, and fails closed rather than operating Bing-only.
- `firecrawl_search` returns mapped web results for a deterministic smoke query through the local API.
- No DuckDuckGo provider request occurs in Firecrawl or the bundled SearXNG engine configuration.

### Explicit provider failure

As an operator, I want search-provider failures to be reported as failures, so that clients can distinguish an outage from a valid query with zero results.

Acceptance Criteria:

- Transport timeout, unreachable service, or all-engine failure produces `503 SEARCH_PROVIDER_UNAVAILABLE`; malformed or non-2xx provider responses produce `502 SEARCH_PROVIDER_BAD_RESPONSE`.
- MCP callers receive tool errors rather than `{success: true, data: {}}`, and failed provider requests are not billed.
- Structurally valid zero results remain HTTP 200; partial results succeed with sanitized diagnostics.
- Logs identify the provider failure without exposing query credentials or private configuration.

### Private-by-default infrastructure

As a self-hosting operator, I want SearXNG reachable only by Firecrawl services, so that adding reliable search does not create another public endpoint.

Acceptance Criteria:

- Compose connects SearXNG to the existing internal backend network without publishing a host port.
- SearXNG JSON output is enabled, public-instance behavior is disabled, and the image/config version is pinned.
- API startup depends only on SearXNG process/config and JSON endpoint readiness; wrapper `health` performs a bounded functional search smoke, and later provider outages do not disable scrape or crawl.

### Maintainable provider contract

As a maintainer, I want one explicit provider path with focused tests and documentation, so that future changes cannot silently restore unreliable fallback behavior.

Acceptance Criteria:

- DuckDuckGo implementation code, tests, configuration, and documentation are absent.
- Tests cover SearXNG request construction, result mapping, empty legitimate results, malformed responses, timeouts, and provider-unavailable behavior.
- Local environment examples, Compose docs, MCP capability docs, and lat.md architecture agree on the same default and supported options.
- Local MCP advertises web search only and hides feedback; unsupported local REST search sources and options are rejected rather than silently ignored.

## Constraints

- The supported local entrypoint remains `scripts/local-firecrawl`; recovery and lifecycle operations must continue through that wrapper.
- The local Firecrawl API remains at `http://127.0.0.1:3002`, while SearXNG stays internal to Compose.
- Explicitly configured Fire Engine retains precedence outside the wrapper-managed local stack. The local stack defaults to its internal SearXNG endpoint, and direct DuckDuckGo routing is removed globally.
- The local SearXNG contract is web-only. Local MCP hides unsupported sources/options and feedback; local REST rejects unsupported image, news, geo, recency, enterprise, and feedback semantics.
- The service sends user queries to configured upstream engines; engine choice and outbound networking are privacy and operations boundaries.
- A private single-consumer service should not add Valkey or public limiter complexity without demonstrated need.
- SearXNG engine availability can change independently; health checks and tests must avoid creating a permanently flaky startup gate.
- Firecrawl makes one bounded provider attempt with no application retry or separate circuit breaker; SearXNG owns engine suspension. Planning must set and benchmark exact deadline, pagination/result, concurrency, and resource bounds.
- Existing blank SearXNG environment values adopt `http://searxng:8080`, while an explicit external endpoint remains a supported override.
- Bundled mode requires exactly `braveapi,bing` and a nonblank Brave credential. The credential is encoded in the protected local environment, passed only to SearXNG, decoded only into tmpfs, and never exposed to API; bundled overrides cannot remove Brave.
- The internal service uses a dedicated generated service secret, POST requests, query-safe logging, no host port, container hardening, and an immutable image pin with an update owner.
- Changes require updates to Compose, environment initialization, health/status output, API search code, MCP capability policy, tests, user documentation, and lat.md.
- No project constitution exists, so the clarify gate must decide whether to continue without one.

## Resolved Decisions

- Bundled search uses official credentialed `braveapi` plus Bing. Both engines must qualify; Bing-only operation is invalid.
- Firecrawl uses a 10-second provider deadline, 100-result cap, five-page cap, and concurrency four. SearXNG uses 3/4-second engine timeouts, zero retries, HTTP pools 16/8, 1 CPU, 512 MiB memory/swap, 128 PIDs, and bounded tmpfs.
- Wrapper `health` uses one fixed non-user web query with limit 1 and requires HTTP 200, `success:true`, and one valid HTTP(S) result.
- The immutable SearXNG image is `2026.7.31-6bfd82705` at digest `sha256:79c2be18a18367484474bae9b18a8cd9085114ab3dcd49cac091cad8c548a0a9`; local-runtime maintainers own monthly and security-triggered review.
- Canonical provider errors and the shared controller mapping carry the accepted 502/503 contract across legacy, v2, MCP, and internal callers.

## Clarifications

**Q1: Where is bundled SearXNG mandatory, and does explicitly configured Fire Engine keep precedence?**
A: Bundle SearXNG only for `scripts/local-firecrawl`. Preserve explicitly configured Fire Engine elsewhere, remove direct DuckDuckGo globally, and fail clearly when neither provider exists.

**Q2: Does removal prohibit DuckDuckGo inside SearXNG, and what engine policy ships?**
A: Yes. Disable all DuckDuckGo engines and autocomplete. Bundled mode requires the fixed official `braveapi,bing` pair and a Brave credential; it rejects bundled engine overrides and cannot operate Bing-only. External SearXNG endpoints suppress the bundled service but Firecrawl still validates any engine override against `braveapi,bing` and bounds categories to its supported contract.

**Q3: Is local search a web-only MVP, and how are unsupported capabilities handled?**
A: Yes. Advertise web-only MCP search, reject unsupported REST options, and hide local search feedback.

**Q4: What provider-failure contract applies across callers?**
A: Use `503 SEARCH_PROVIDER_UNAVAILABLE` for timeouts, unreachable service, and all-engine failure; use `502 SEARCH_PROVIDER_BAD_RESPONSE` for malformed or non-2xx responses; use HTTP 200 only for structurally valid empty results. Partial results succeed with sanitized warnings, MCP surfaces tool errors, and provider failures are not billed.

**Q5: Does search failure block the runtime, and how is health checked?**
A: Require process/config readiness at startup, keep scrape/crawl available during later search outages, return typed 503s for search, and perform a bounded functional query through wrapper `health` rather than continuous Compose health checks.

**Q6: What latency and load policy applies?**
A: Make one provider attempt with no Firecrawl retry or separate circuit breaker. Use the frozen 10-second deadline, 100-result and five-page caps, concurrency four, 3/4-second engine timeouts, zero retries, and SearXNG pools 16/8. Credentialed live acceptance passed with overall p95 1,048 ms and max 1,961 ms on 2026-08-01.

**Q7: What migration and security contract applies?**
A: Existing blank endpoints adopt `http://searxng:8080`; explicit external overrides remain supported. Bundled setup privately requires the Brave key and stores only its Base64 transport value in the mode-`0600` environment. Only SearXNG receives it and decodes it into tmpfs. Keep POST, query-safe logs, no host port, container hardening, immutable pinning, and generic Compose/Helm outside this MVP.

The feature proceeds without a repository constitution, as approved by accepting all recommended clarification defaults.

## Spec Review

### Critical Questions (answer before planning)

1. Where is bundled SearXNG mandatory, and does explicitly configured Fire Engine keep precedence? Choose whether the supported default covers only `scripts/local-firecrawl`, all Compose/self-host distributions, or every environment; define behavior for non-local installs with neither provider. — This fixes the provider matrix and migration blast radius; flagged by: requirements, gaps, ambiguity, feasibility, scope, stakeholders.
2. Does “remove DuckDuckGo entirely” prohibit every DuckDuckGo engine and autocomplete backend inside SearXNG, and what explicit replacement engine/category allowlist, safe-search default, locale, outbound privacy policy, and operator override surface ship? — Removing only Firecrawl's adapter would still send queries to DuckDuckGo and mutable SearXNG defaults cannot support deterministic health or privacy claims; flagged by: requirements, gaps, ambiguity, feasibility, scope, stakeholders.
3. Is the local contract a web-only MVP, and should unsupported images, news, geo, recency, enterprise, and feedback inputs be hidden from MCP and rejected by REST, or implemented now? — Current MCP/API schemas over-promise while the adapter maps only web results and feedback is unavailable without DB auth; flagged by: requirements, gaps, ambiguity, feasibility, scope, stakeholders.
4. What exact provider-failure taxonomy applies across v0/v1/v2, x402, MCP, extract, and deep research? Decide stable status/code/envelope and retryability for timeout, unreachable/non-2xx, malformed data, all-engine failure, partial failure, and legitimate zero results, including billing behavior. — Existing callers collapse these cases into empty success or generic errors; flagged by: requirements, gaps, ambiguity, feasibility, stakeholders.
5. Does SearXNG or upstream-engine failure block the whole local runtime, or does the API stay available while search returns a typed error? Define separate recurring process/config health and bounded functional search smoke semantics, including query, timeout, cadence, and success predicate. — A live external Compose health check can make scrape/crawl unavailable and create flaky startup traffic; flagged by: requirements, gaps, ambiguity, feasibility, scope, stakeholders.
6. What latency and load bounds govern Firecrawl-to-SearXNG search? Set overall deadline, per-engine timeout/retry ownership, pagination/result caps, request concurrency, resource/PID limits, and whether SearXNG engine suspension is the only circuit breaker. — Current Axios calls have no timeout and can multiply serial pages across federated engines; flagged by: requirements, gaps, ambiguity, feasibility, stakeholders.
7. What migration and security contract applies to existing operators? Decide blank-env defaulting, external endpoint overrides, secret generation, internal network boundary, query/log redaction, GET versus POST, container hardening, image pin/update ownership, and whether Helm/generic Compose are changed or documented as out of scope. — Existing `.env` files are not overwritten, queries currently reach logs/upstream engines, and adding one service affects lifecycle and upgrade behavior; flagged by: requirements, gaps, feasibility, scope, stakeholders.

### Non-Blocking Observations

- A private API-only SearXNG service can disable limiter, autocomplete, image proxy, and public-instance behavior; Valkey is unnecessary unless public or multi-tenant exposure becomes a separate requirement.
- Pin the container by immutable digest plus readable release and document a manual security/update cadence because Dependabot currently covers GitHub Actions only.
- Add SearXNG to wrapper start/stop/restart/status/health/log inventories, JSON output, fake-runtime fixtures, and port-policy assertions.
- Use deterministic adapter/controller/MCP and rendered-Compose tests in required CI; keep real upstream smoke checks in wrapper operations rather than CI.
- Validate and bound result fields, skip isolated malformed items with sanitized diagnostics, and reject malformed response envelopes.
- Consolidating duplicated legacy/v2 SearXNG logic would reduce contract drift, but the plan should avoid unrelated search refactors unless required for typed errors.
- No project constitution exists, so this review could not test the feature against recorded engineering principles.
