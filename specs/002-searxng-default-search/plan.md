# Plan: searxng-default-search

## Architecture Approach

Bundle one private SearXNG service only in `compose.local.yaml`, making it the zero-configuration provider for `scripts/local-firecrawl`. Keep generic Compose, Helm, and hosted deployments provider-explicit. Direct DuckDuckGo code is removed globally, and any installation with no configured provider receives a typed unavailable error.

Provider precedence is explicit and has no fallback loop:

- Local web-only mode (`LOCAL_SEARCH_WEB_ONLY=true`) always selects its validated `SEARXNG_ENDPOINT`; a Fire Engine value cannot supersede it.
- Outside local web-only mode, a configured Fire Engine wins; otherwise a configured SearXNG endpoint is selected; otherwise resolution raises `503 SEARCH_PROVIDER_UNAVAILABLE`.
- A structurally valid empty provider response is terminal in every mode and never causes selection of another provider.

The wrapper selects one of two local modes from rendered Compose configuration:

- Internal mode: blank or canonical `SEARXNG_ENDPOINT` resolves to `http://searxng:8080`; the wrapper starts and monitors the bundled service before starting API with its existing `--no-deps` flow.
- External mode: a validated non-canonical HTTP(S) endpoint is preserved; the wrapper does not start bundled SearXNG and stops any stale bundled container during mode changes.

Do not add a fixed `api.depends_on.searxng` edge because it would defeat external suppression. The wrapper owns startup ordering and requires SearXNG process/config readiness in internal mode. API container health remains independent after startup so scrape and crawl survive later provider outages; wrapper `health` performs one bounded functional search smoke.

Pin the official multi-architecture image and readable release together:

`ghcr.io/searxng/searxng:2026.7.31-6bfd82705@sha256:79c2be18a18367484474bae9b18a8cd9085114ab3dcd49cac091cad8c548a0a9`

Track `config/searxng/settings.yml` with JSON output, POST form method, blank autocomplete/favicon resolver, private/no-limiter/no-image-proxy behavior, no Valkey, default category `general`, and an explicit `keep_only` engine set: `brave`, `qwant`, `startpage`, and `bing`. Because `keep_only` filters defaults but does not enable engines that are disabled upstream, the tracked `engines` overrides must name all four engines with `disabled: false`. A boot test must inspect SearXNG's effective settings and prove the selected set is enabled before any functional smoke is accepted. Disable every DuckDuckGo path by construction. Use safe search level 1, default language `en`, maximum page 5, engine request timeout 3 seconds, maximum engine timeout 4 seconds, zero retries, `pool_connections: 16`, and `pool_maxsize: 8`.

Bundled-mode engine/category overrides are normalized and validated before Docker starts. Engine overrides must be a subset of the tracked allowlist; categories must be implemented only by those engines; and any DuckDuckGo engine, alias, autocomplete provider, favicon resolver, or category expansion is rejected. A separately operated external SearXNG endpoint is outside this enforceable configuration boundary, but Firecrawl never selects or falls back to DuckDuckGo itself.

Harden the service with no host port, `backend` network only, UID/GID `977:977`, read-only root, dropped capabilities, `no-new-privileges`, init, rotating logs, read-only settings, `cpus: 1.0`, 512 MiB memory and swap limits, `pids_limit: 128`, and tmpfs limits of 64 MiB for `/tmp` and 128 MiB for `/var/cache/searxng`. Generate a dedicated 64-character lowercase hexadecimal `SEARXNG_SECRET`; do not expose it to API.

Compose readiness runs every 10 seconds after a 20-second start period, with a 3-second probe timeout and 12 retries. The exact in-container probe is `wget -q --spider --timeout=3 http://127.0.0.1:8080/healthz`; success is exit zero from the local HTTP endpoint after settings parsing. Implementation must verify that the pinned image supplies this command. Static settings tests separately prove JSON and policy configuration; readiness never contacts an upstream engine.

Consolidate legacy and v2 SearXNG adapters behind one provider resolver. The shared client sends one `application/x-www-form-urlencoded` POST flow with a 10-second absolute deadline, no Firecrawl retry, maximum 100 provider results, maximum five pages, and per-process concurrency four. SearXNG owns engine suspension and its configured zero-retry policy. Preserve a valid empty result as terminal rather than attempting another provider.

The selected engine set is the normalized, de-duplicated request override after validation against the frozen qualified allowlist, or the complete frozen qualified allowlist when no override is present. Parse `unresponsive_engines` only when it is an array of unique two-element arrays whose first and second elements are nonempty strings and whose normalized engine name belongs to the selected set. A non-array value, malformed tuple, duplicate engine, unknown engine, or failure entry outside the selected set makes the provider envelope malformed and returns `502 SEARCH_PROVIDER_BAD_RESPONSE`. An omitted or empty array means no selected engine failed.

Introduce canonical `SearchProviderUnavailableError` and `SearchProviderBadResponseError` domain errors plus strict response validation. Only `toSearchProviderHttpError` at the shared search-controller boundary maps them to HTTP status/code/message; legacy and v2 controllers and internal consumers must not implement parallel mappings.

- `503 SEARCH_PROVIDER_UNAVAILABLE`: missing provider, deadline/semaphore timeout, DNS/connect/reset/unreachable, or zero valid results where `unresponsive_engines` proves every selected engine failed.
- `502 SEARCH_PROVIDER_BAD_RESPONSE`: provider non-2xx, invalid JSON/envelope, or a nonempty result set with zero valid items.
- HTTP 200 empty without warning: structurally valid zero results and no selected engine failure.
- HTTP 200 empty with warning: structurally valid zero results and a nonempty proper subset of selected engines failed.
- HTTP 200 partial with warning: at least one valid result plus malformed items or selected-engine failures, with no query, endpoint, engine-error detail, or credentials.

Apply the contract to v0/v1/v2, x402, MCP, extraction, and deep-research consumers. Provider failures occur before ordinary tracking/billing.

Treat x402 as a separate design boundary. An independent root P1 design/prototype must establish current authorization, rate-limit, payment verification/settlement, and controller ordering before x402 implementation starts. It must prove that each accepted request executes provider search exactly once, invalid or unpaid requests cannot spend provider capacity, provider failures never settle, successful and legitimate-empty responses settle exactly once, and moving work before settlement does not create an authentication, rate-limit, replay, or denial-of-service bypass. Required tests cover unpaid, invalid-signature, replayed, rate-limited, provider-502, provider-503, valid-empty, partial-success, and ordinary-success requests with provider-call and settlement-call counters.

Enable explicit `LOCAL_SEARCH_WEB_ONLY=true` in the local overlay. Local REST rejects unsupported image, news, geo, recency, enterprise, and feedback semantics before reservation or provider work. Local MCP rewrites the upstream search schema/instructions to web-only, hides feedback, and rejects bypassed unsupported calls. Hosted behavior remains unchanged.

Alternatives rejected:

- DuckDuckGo fallback: already proven intermittent and converts provider failure into misleading empty success.
- Public SearXNG or shared Valkey: unnecessary exposure and state for one internal consumer.
- Live external query in recurring Compose health: creates upstream traffic and flaky whole-stack readiness.
- Mutable SearXNG defaults: can silently restore DuckDuckGo and change privacy/reliability behavior.
- Implementing image/news/geo/recency/feedback now: materially expands scope beyond the accepted web-only MVP.
- Generic Compose/Helm bundling: conflicts with the accepted wrapper-only migration boundary.

Primary deployment behavior is grounded in SearXNG's official [container installation](https://docs.searxng.org/admin/installation-docker), [settings inheritance](https://docs.searxng.org/admin/settings/settings.html#use-default-settings), [search API](https://docs.searxng.org/dev/search_api.html), [server settings](https://docs.searxng.org/admin/settings/settings_server.html), and [outgoing settings](https://docs.searxng.org/admin/settings/settings_outgoing.html).

## Affected Components

- `compose.local.yaml`: add private SearXNG service, settings mount, health, hardening, resources, and local API endpoint/capability variables.
- `config/searxng/settings.yml` (new): immutable private JSON-only configuration and explicit non-DuckDuckGo engine allowlist.
- `.env.example.local`, `scripts/init-local-env.sh`, `scripts/upgrade-local-env-phase1`: default/migrate endpoint, generate and validate secret, preserve external overrides and atomic/idempotent update guarantees.
- `scripts/local-firecrawl`: provider-mode detection from rendered configuration; conditional service inventory; start/stop/restart/status/health/logs; port and Compose invariants; redacted functional smoke.
- `scripts/local-firecrawl.test.mjs` and a focused `scripts/searxng-config.test.mjs`: environment, orchestration, hardening, config, smoke, redaction, and no-port contracts.
- `apps/api/src/search/errors.ts` and `provider.ts` (new): typed errors, status mapping, shared provider resolution, deadline, concurrency, and terminal-empty behavior.
- `apps/api/src/search/searxng.ts`: single validated POST client shared by legacy/v2; delete duplicate `apps/api/src/search/v2/searxng.ts`.
- `apps/api/src/search/index.ts` and `apps/api/src/search/v2/index.ts`: delegate to the shared resolver, enforce the local/non-local precedence matrix, and stop swallowing provider errors.
- `apps/api/src/search/v2/ddgsearch.ts`: delete direct DuckDuckGo implementation and all imports/comments/tests/config references.
- `apps/api/src/lib/error.ts` and `apps/api/src/lib/error-serde.ts`: add transportable 502/503 provider codes and serialization.
- `apps/api/src/config.ts`: provider deadline/result/concurrency bounds and explicit local web-only flag.
- v0/v1/v2 and x402 search controllers: shared error envelopes, warnings, billing/refund assertions, and raw-body local capability validation.
- `apps/api/src/search/execute.ts`: cap buffered provider demand at 100, thread sanitized warnings, and preserve zero billing before provider success.
- extraction and deep-research search consumers: propagate typed provider failure rather than converting it to legitimate empty results.
- `scripts/local-firecrawl-mcp`, `scripts/local-firecrawl-mcp.lib.mjs`, and `scripts/local-firecrawl-mcp.test.mjs`: disable feedback, rewrite search tool/schema/instructions, intercept unsupported calls, add pinned fixtures and drift tests.
- `.github/workflows/ci.yml`: run SearXNG config/rendering tests and focused API provider/controller tests in the required gate; never query live upstream engines in CI.
- `README.md`, `LOCAL_DEPLOYMENT.md`, `SELF_HOST.md`, and `.env.example.local`: topology, supported web-only capability, migration, external override, health, logs, failure recovery, privacy, rollback, and generic self-host boundary.
- `lat.md/operations/local-runtime.md`, `lat.md/runtime/support-services.md`, `lat.md/api/http.md`, `lat.md/api/trust-and-operations.md`, `lat.md/testing/runtime-operations.md`, and `lat.md/operations/deployment-and-ci.md`: architectural and test-contract synchronization.

## Data Model

No database schema, durable volume, or data migration is introduced. SearXNG cache state is ephemeral and bounded in tmpfs.

New/changed configuration:

- `SEARXNG_ENDPOINT`: parse with one shared URL normalizer. Accept only `http` or `https`, no username/password, query, or fragment, and an empty path or `/` only. Lowercase and IDNA-normalize the hostname, remove the trailing root slash, and treat an omitted port as 80 for HTTP or 443 for HTTPS; an explicitly supplied default port normalizes identically. The reserved internal hostname `searxng` is valid only as HTTP with effective port 8080 and normalizes to `http://searxng:8080`; any other scheme or port on that hostname is rejected rather than treated as external. New local installs and missing/blank existing values receive that canonical internal value. Every other valid normalized URL is an external override and is preserved in canonical form.
- `SEARXNG_SECRET`: 32 random bytes rendered as 64 lowercase hex, unique from other local secrets, mode-0600 environment storage, visible only to SearXNG.
- `SEARXNG_ENGINES` and `SEARXNG_CATEGORIES`: remain optional bundled-mode operator overrides; absence uses the tracked allowlist and `general` category. Overrides cannot expand beyond qualified engines/categories and reject every normalized DuckDuckGo identifier or alias.
- `LOCAL_SEARCH_WEB_ONLY=true`: explicit local capability mode rather than inference from authentication settings.
- `SEARCH_PROVIDER_TIMEOUT_MS=10000`: schema min 1000, max 30000.
- `SEARCH_PROVIDER_MAX_RESULTS=100`: hard public cap.
- `SEARCH_PROVIDER_MAX_CONCURRENCY=4`: per-process semaphore bound suitable for the single local API container.

Environment upgrades reuse `scripts/upgrade-local-env-phase1` and preserve its lock, symlink, mode, duplicate-key, concurrent-change, atomic-write, and idempotency guarantees. Older Firecrawl versions safely ignore added keys during rollback.

## API / Interface Changes

- Local `/v0`, `/v1`, and `/v2` search accept web-only query, limit, language, supported domain/category filters, and downstream scrape options. Explicit unsupported sources/options return stable `400 BAD_REQUEST` before reservation or search.
- Provider failures return:
  - `503` with `{success:false, code:"SEARCH_PROVIDER_UNAVAILABLE", error:"Search provider is temporarily unavailable. Please try again later."}`.
  - `502` with `{success:false, code:"SEARCH_PROVIDER_BAD_RESPONSE", error:"Search provider returned an invalid response. Please try again later."}`.
- Structurally valid empty searches retain existing success envelopes and zero credits. When the taxonomy requires a warning, every REST version adds the exact top-level sibling field `warning: "Some search results could not be retrieved."` beside `success` and the version's existing result field; warnings never appear inside a result item or provider metadata.
- MCP advertises and accepts web-only search, removes unsupported fields/source claims, hides `firecrawl_search_feedback`, and rewrites upstream instructions consistently. A bypassed unsupported argument returns a protocol-level JSON-RPC error with code `-32602`, message `Invalid params`, and data `{code:"LOCAL_SEARCH_WEB_ONLY"}`. A REST `SEARCH_PROVIDER_UNAVAILABLE` or `SEARCH_PROVIDER_BAD_RESPONSE` response returns a successful JSON-RPC `tools/call` envelope whose tool result has `isError:true` and exactly one text content block containing the corresponding compact JSON `{success:false,code,error}`; it never becomes a protocol error or `{success:true,data:{}}`.
- `scripts/local-firecrawl logs searxng` becomes valid in internal mode. Human and JSON status/health identify internal versus external provider mode without exposing endpoint/secret/query.
- Wrapper `health` adds one POST `/v2/search` smoke using the literal query `SearXNG metasearch`, web source, limit 1, API request timeout 10 seconds, and outer deadline 15 seconds. The fixed product-domain query avoids user data and is expected to retain public web coverage across qualified engines. Success requires HTTP 200, `success:true`, and one valid HTTP(S) result. Compose health performs no external search.
- Direct DuckDuckGo fallback and provider configuration disappear. Unrelated example links mentioning `duckduckgo.com` remain outside removal scope.
- Breaking behavior is intentional for local callers that used unsupported sources/options or depended on silent empty success. Generic/hosted Fire Engine behavior remains unchanged except that no direct DuckDuckGo fallback exists when Fire Engine is absent.

## Testing Strategy

API unit/contract tests:

- Shared SearXNG client: POST body and query-safe URL, mapping, language, page/result caps, shared deadline, semaphore concurrency, transport timeout, non-2xx, malformed envelope/items, strict selected-engine and `unresponsive_engines` parsing, all three zero-valid branches, partial results, sanitized warnings, and no retries.
- Provider resolver: the complete local/non-local precedence matrix, SearXNG selection, valid empty terminal behavior, no-provider 503, and no DuckDuckGo import/fallback.
- Local capability validator: allowed web/domain/category/language/scrape inputs and rejected v0/v1/v2 image/news/geo/recency/enterprise/feedback variants before billing.
- Ordinary REST controllers: exact 502/503 envelopes, exact top-level warning placement, no ordinary billing/scrape dispatch on failure, keyless reconciliation, and legitimate-empty behavior.
- Internal consumers: extraction and deep-research propagate typed failures and preserve valid empty/partial semantics without independent error mapping.
- x402 prototype and implementation: the exact authorization, rate-limit, replay, provider-call, and settlement-counter cases defined in Architecture Approach; implementation cannot begin until the prototype freezes the ordering contract.

Runtime and configuration tests:

- Rendered service uses exact image tag/digest, private backend network, no ports, read-only settings, correct UID, hardening, bounded resources, tmpfs, and local health only. A required registry-manifest test proves the immutable digest resolves to a manifest list containing `linux/amd64` and `linux/arm64`.
- Static settings test asserts JSON/POST/private/no-limiter/no-image-proxy, `keep_only`, explicit `disabled:false` overrides for every selected engine, exact allowlist and `general` category, no DuckDuckGo/autocomplete/favicon fallback, override rejection, page/outgoing bounds, and secret placeholder policy. A current-architecture boot test reads effective settings and proves all selected engines are enabled; booting another architecture is optional and non-blocking.
- Environment tests cover new install, missing/blank migration, external override preservation, secret generation/validation/uniqueness, invalid URL rejection, idempotency, modes, symlinks, locks, and concurrent changes.
- Wrapper fake-runtime tests cover conditional start, external suppression, stale-container stop, ordering, selected status/log inventory, no-port enforcement, query-safe health output, and one bounded functional smoke.
- MCP tests cover web-only schema/instructions, feedback absence, unsupported direct-call rejection, pinned upstream fixture drift, and 502/503 tool errors rather than empty success.

CI and live acceptance:

- First run a P1 CI command/target spike against the repository as it exists, recording the exact deterministic commands, package working directories, build target, and focused test selectors that succeed. This spike blocks CI workflow edits; the plan does not invent unverified command names. No live upstream request belongs in CI.
- After engine/resource/deadline values are benchmarked and frozen, add the verified SearXNG settings, rendered-Compose, wrapper/MCP, and focused API commands to required repository validation.
- Keep one implementation-closing, non-mutating E2E acceptance task for fresh and upgraded local environments, wrapper health, MCP web results, external suppression, outage behavior, stop order, current-architecture boot, required manifest-list architecture verification, and a static zero-match scan for direct DuckDuckGo provider/config references. A failure blocks the epic or creates follow-up work; this final task never changes implementation, frozen values, tests, CI, or documentation.
- Qualify each candidate engine on the supported local host baseline with three isolated smoke attempts: at least two must return one valid HTTP(S) result within the 4-second engine ceiling, without API credentials, account cookies, CAPTCHA, or a changed outbound hostname. Remove a failing engine, rerun static and live acceptance, and never substitute DuckDuckGo. At least two diverse engines must qualify or the epic remains blocked.
- Before CI and documentation, benchmark 20 sequential and 8 concurrent searches on a Linux x86_64 host with at least 4 logical CPUs and 8 GiB RAM allocated to Docker. Keep the SearXNG container at 1 CPU, 512 MiB memory/swap, 128 PIDs, the stated tmpfs limits, HTTP pools 16/8, and Firecrawl concurrency four. Acceptance: no OOM/PID breach, p95 below 6 seconds, and no request exceeds the 10-second provider deadline. This task qualifies engines and freezes the final engine/resource/deadline values, updating implementation and plan artifacts before it closes. Later CI, documentation, and final E2E consume those values without mutation.
- Run existing wrapper, MCP, API, CI, Compose, and `lat check` gates.

## Risks

- Upstream engines can still throttle or block one egress IP. Mitigation: four-engine diversity, explicit engine failures, bounded smoke, sanitized diagnostics, and benchmark before allowlist freeze; no SLA claim.
- A SearXNG HTTP 200 may contain empty results and `unresponsive_engines`. Mitigation: fixed allowlist plus envelope-aware valid-empty/all-engine/partial classification.
- Image entrypoint behavior may conflict with non-root/read-only hardening. Mitigation: live acceptance verifies UID, cache paths, settings ownership, capabilities, and boots the current architecture; registry-manifest inspection must prove both `linux/amd64` and `linux/arm64`, while a second-architecture boot remains optional and non-blocking.
- External endpoint normalization could start or suppress the wrong service. Mitigation: render and validate canonical/internal versus strict external URL forms before Docker operations; test mode switching and stale-container cleanup.
- Existing query-bearing controller logger contexts can violate redaction even if the adapter is safe. Mitigation: remove raw query fields and assert logs/errors never contain query, URL, body, endpoint, or credentials.
- Typed errors affect duplicated legacy/v2 and internal consumers. Mitigation: one shared resolver/error mapper, focused tests at every caller, and unexpected exceptions continue bubbling as 500.
- x402 settlement may occur before controller failure. Mitigation: make settlement-timing verification a blocking acceptance item and move provider preflight if required.
- Full API tests are not currently in required CI. Mitigation: run exact new deterministic test files in the API build stage rather than broad service-dependent suites.
- Immutable pinning improves reproducibility but requires maintenance. Mitigation: Firecrawl local-runtime maintainers own review on the first business day of each month and upon SearXNG security notices. They verify the upstream tag/digest and architectures, review settings changes, update the pair together, run deterministic config/API tests plus live acceptance, and record the result in release notes.
- No constitution exists. The user explicitly approved proceeding, so alignment is checked against the clarified spec and repository architecture only.

Failover and software rollback are distinct:

- Provider failover keeps current code. Set a validated external `SEARXNG_ENDPOINT` and restart through the wrapper; external mode must stop and remove any stale bundled SearXNG container without touching volumes or other services. Returning the endpoint to canonical `http://searxng:8080` and restarting re-enables the bundled service.
- Code rollback starts while current code still runs: first switch to a validated external endpoint and restart so the current wrapper removes the internal container, then restore the prior code commit and restart with that external provider. Added environment keys remain harmless to the older version. Do not rely on the older wrapper to discover or clean a stale new-service container.
- Re-upgrade preserves the normalized endpoint. An external value continues to suppress the internal service; a missing/blank value migrates to the canonical internal endpoint; the canonical value starts a fresh internal container. The wrapper must stop any stale internal container before external-mode startup and must never delete Firecrawl or SearXNG volumes during failover, rollback, re-upgrade, or recovery.

## Sequencing

| Work item | Priority | Depends on | Verifiable acceptance |
|---|---:|---|---|
| Implement secure local SearXNG service and settings | P1 | None | Exact image digest and manifest list, explicit enabled four-engine non-DuckDuckGo config, effective-settings boot verification, JSON/POST, private network/no port, hardening/resources, readiness, and rendered/static tests pass. |
| Consolidate SearXNG provider and remove direct DuckDuckGo | P1 | None | Shared bounded POST adapter/resolver/errors pass deterministic tests; precedence, strict engine-failure parsing, zero-valid/partial/502/503 contracts, and canonical mapping hold; duplicate/direct DDG code is removed. |
| Prototype and freeze x402 settlement ordering | P1 | None | Design records auth/rate-limit/payment/controller boundaries; counter-based tests prove one provider execution, no unpaid capacity use, no failure settlement, and exactly-once successful settlement without replay or DoS regression. |
| Discover and freeze deterministic CI commands | P1 | None | Verified working directories, commands, build target, and focused selectors are recorded from successful local runs; none contacts live upstream engines. |
| Migrate local SearXNG environment | P1 | Secure service/settings | New and upgraded envs receive canonical endpoint/secret safely; exact URL normalization, external overrides, and atomic/idempotent safeguards pass. |
| Propagate ordinary REST errors and billing semantics | P1 | Shared provider | v0/v1/v2 exact 400/502/503 envelopes and top-level warnings pass; provider failures are not ordinary-billed or masked as empty. |
| Propagate provider semantics to internal consumers | P1 | Shared provider | Extraction and deep research preserve valid empty/partial results and propagate canonical typed failures without duplicate mapping. |
| Implement x402 search provider semantics | P1 | Shared provider, x402 ordering prototype | Frozen ordering is implemented; exact unpaid/signature/replay/rate-limit/502/503/empty/partial/success counter tests pass. |
| Enforce local web-only REST capability | P1 | Shared provider, ordinary REST/billing | Local raw requests reject unsupported inputs before reservation/provider work; supported local search and non-local provider precedence remain valid; feedback policy passes. |
| Orchestrate provider-aware local lifecycle | P1 | Secure service/settings, environment migration | Internal/external modes, exact readiness/smoke, failover, stale-container handling, status/health/logs/stop/order/port/redaction, rollback, and re-upgrade tests pass. |
| Align local MCP search capability | P2 | Shared provider, local REST capability | Schema/instructions are web-only, feedback is absent, bypasses use exact `-32602`, provider failures use exact `isError` tool results, and fixture drift tests pass. |
| Qualify engines, benchmark, and freeze operational values | P1 | Service/settings, shared provider, environment, ordinary REST, internal consumers, local REST, lifecycle, MCP | At least two engines qualify; benchmark thresholds pass; final engine/resource/deadline/pool values are frozen in implementation and plan before downstream work. |
| Add required deterministic CI coverage | P2 | CI command freeze, all implementation, operational-value freeze | Required CI runs only verified settings/rendered-Compose/wrapper/MCP/API commands with frozen values and no live upstream traffic. |
| Document search architecture and operations | P2 | Stable implementation contracts, operational-value freeze | README/local deployment/self-host/env/lat.md use frozen topology, scope, errors, privacy, migration, failover, rollback/re-upgrade, health, recovery, and update cadence; `lat check` passes. |
| Run final non-mutating E2E acceptance | P1 | x402 implementation, operational-value freeze, deterministic CI, documentation | Fresh/upgrade/external/outage/MCP/stop and current-architecture scenarios pass; manifest architectures and zero direct DDG matches pass; task changes no implementation, values, CI, tests, or docs. |

Dependency edges, not title prefixes, encode order. Four root P1 items can proceed in parallel. The broad propagation work is split among ordinary REST/billing, internal consumers, and x402. The x402 implementation is blocked by its independent prototype. Benchmark/qualification freezes operational values before CI and documentation consume them. Final E2E is verification-only and closes the epic without mutation.

## Backlog Refinement

None. No P4 backlog source was supplied or discovered, so there is no source disposition to map. Every planned work item is implement-ready P1 or P2; no P4 work will be created.

## Target Epic

A new feature epic will be created for SearXNG-backed local search with 15 implement-ready children: 12 P1 and 3 P2. The initial dispatchable frontier contains four independent P1 tasks; no P4 task is created.

## Alignment fixes applied

Must-fix changes:

- Made effective engine enablement, selected-engine failure parsing, all zero-valid branches, provider precedence, warning placement, MCP error mapping, and endpoint normalization explicit.
- Isolated and gated x402 design, split propagation consumers, added pre-documentation operational freezing, and made final E2E non-mutating.
- Required manifest-list verification plus current-architecture boot, separated failover from code rollback/re-upgrade, and gated CI edits on verified commands.

Should-fix changes:

- Retained exact resource/pool/deadline bounds, fixed smoke query and predicate, qualified category/engine policy, named update owner/cadence, and canonical domain-error mapping.
