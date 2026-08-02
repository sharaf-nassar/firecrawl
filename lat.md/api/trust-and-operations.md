# Trust, Billing, and Operations

Cross-cutting policy protects team ownership, capacity, credits, private networks, sensitive data, and diagnostic quality without embedding those decisions in each controller.

## Authentication modes

Authentication resolves every accepted request to a team identity and plan-policy snapshot.

[[apps/api/src/controllers/auth.ts#authenticateUser]] supports API-key bearer tokens, OAuth access tokens resolved by introspection, preview tokens, local-owner authentication, and configured keyless access. WebSockets may carry the bearer token through the subprotocol header.

When database authentication is disabled, local/self-hosted operation uses a bypass identity and warns. With database authentication enabled, normalized API keys query an authorization-credit-usage record cached in Redis for ten minutes.

OAuth introspection results are cached by a token hash for at most five minutes; inactive tokens are cached briefly. Invalid or expired tokens return 401 without leaking database detail.

## Agent-sponsored credentials

Agent-provisioned API keys remain ordinary team credentials whose sponsor record adds temporary safety policy until the account owner confirms them.

After API-key authentication, [[apps/api/src/services/agent-sponsor.ts#getAgentSponsorStatus]] reads the sponsor state by API-key ID. Positive and confirmed-absent results are cached in Redis for five minutes, so sponsor-state changes are not instant at the API boundary.

[[apps/api/src/routes/shared.ts#checkCreditsMiddleware]] rejects blocked keys with 403. Pending keys are rejected after their verification deadline, receive 402 once adjusted usage has reached 50 credits, and otherwise mark the request as index-only before normal credit admission. Verified keys proceed through ordinary plan policy.

Index-only state propagates into scrape, parse, crawl, batch, and search-enrichment work. [[apps/api/src/scraper/scrapeURL/engines/index.ts#buildFallbackList]] removes network engines and permits only configured index variants; an index miss is terminal instead of falling through to a live fetch.

Sponsor lookup failure is currently fail-open: authentication logs the failure and continues without a sponsor marker, leaving only ordinary account credit policy. This differs from [[trust-and-operations#Keyless access|keyless quota failure]], which fails closed.

## Keyless access

Keyless scrape, search, and interaction are a constrained preview identity, not anonymous bypass.

Both daily request and credit limits must be configured before keyless mode exists. Only valid IPv4 client identities qualify; authenticated proxy forwarding may supply the end-user IP. Optional Spur checks reject anonymizing infrastructure and fail open on provider errors.

Quota enforcement fails closed when its Redis store is unavailable. Accepted requests use deterministic preview-team identities, reserve projected credits, and reconcile actual usage after completion. OAuth discovery headers tell agents how to obtain a key when access or quota blocks them.

## x402 paid search

x402 adds an EVM micropayment gate to conditionally registered v1 and v2 search routes; it does not replace ordinary authentication or request policy.

The route exists only when `X402_PAY_TO_ADDRESS` is configured. Authentication and search rate limiting run together first, followed by restricted-country policy. V2 also applies its blocklist middleware at this boundary; V1 currently does not register that middleware.

[[apps/api/src/lib/x402.ts#createX402RouteConfig]] advertises the `exact` EVM scheme, configured recipient, and configured price with a `$0.01` default. Base Sepolia is the default network; known Base, Avalanche, and IoTeX names map to CAIP-2 identifiers.

Payment verification uses a lazily initialized facilitator, defaulting to `https://x402.org/facilitator`. Facilitator availability and settlement are dependencies for this route, while ordinary `/search` retains account or keyless credit policy.

The pinned `@x402/express` middleware verifies before invoking the controller, buffers response writes, skips settlement for status 400 or higher, and withholds successful responses until settlement finishes.

The frozen target order is authorization, search-rate consumption, route policy, facilitator verification, an atomic shared replay claim, one provider execution, controller response mapping, then one settlement attempt only for a 2xx response. Unpaid, invalid, replayed, rate-limited, 4xx, 5xx, and exceptional requests never settle. No stage after the replay claim has an application retry.

[[apps/api/src/lib/x402-ordering.ts#executeX402SettlementPrototype]] keeps the complete target order counter-testable without provider or facilitator coupling. [[apps/api/src/lib/x402-replay.ts#createX402ReplayClaimHook]] installs the real shared claim at the resource server's successful post-verification hook. Redis `SET NX` makes the claim atomic across API replicas; its canonical identity excludes malleable signatures. TTL reaches EIP-3009 `validBefore` or Permit2 `deadline`, while authorization beyond the route's maximum payment timeout is rejected to bound retention.

The controllers keep request validation and team policy before one provider call. Canonical provider failures map to 502 or 503, so middleware never settles them; valid empty, partial, and ordinary results stay 200 and settle once. Partial diagnostics use only the sanitized top-level warning. Unexpected provider errors bubble into Express error handling without settlement. Settlement failure replaces a buffered success with a payment failure and never re-executes provider work.

## Authorization and ownership

Team ownership is rechecked at status, append, cancellation, and browser-resource boundaries.

Job status never trusts possession of a UUID. Database request rows, Redis crawl owners, queue group owner markers, and browser owner IDs are compared with the authenticated team.

Ownership mismatches usually return 404 to avoid revealing that another team's resource exists. Agent and extract status use the shared request record as the durable ownership anchor.

## Feature permissions

Team flags gate request capabilities whose privacy, robots, or network behavior exceeds the ordinary scrape contract.

[[apps/api/src/lib/permissions.ts#checkPermissions]] rejects caller-selected ZDR unless the team mode allows or forces it, `ignoreRobotsTxt` unless robots bypass is allowed or forced, custom robots user agents unless separately allowed, and the `us-whitelist` location unless static-IP access is enabled.

Forced policy remains stronger than request preference: forced ZDR and robots modes are resolved through shared helpers even when the caller omits the corresponding option. Permission rejection happens before execution and points hosted users to support rather than silently downgrading the requested behavior.

## Outbound network safety

Direct HTTP and webhook destinations pass through both product policy and connection-time network policy.

Route and controller blocklists deny configured domains, related subdomains or TLD variants, and record contextual hits. Team flags can grant explicit domain exceptions, while allowed-keyword rules handle narrow false positives.

For requests made through the API's Undici dispatchers, [[apps/api/src/scraper/scrapeURL/engines/utils/safeFetch.ts#getSecureDispatcher]] inspects the connected socket and rejects non-unicast addresses unless local destinations are explicitly enabled. This covers redirects and DNS answers, not only the submitted hostname.

Scrape dispatchers keep cookies for browser-like fetches; webhook dispatchers deliberately omit them. TLS verification is bypassed only when the owning request capability allows it.

## Fixed-upstream proxy boundaries

Support and partner-integration proxies forward bounded request data to fixed services, but their authentication and failure contracts differ from scrape URL safety.

Authenticated `/v2/support/ask` and `/v2/support/docs-search` calls forward only authorization, idempotency key, request ID, and JSON body to the configured support service. [[apps/api/src/controllers/v2/support-proxy.ts#supportProxyController]] has a 65-second timeout, returns 503 when disabled, and maps timeout or connection failure to 504 or 502.

The three `/admin/integration/*` routes forward JSON and any bearer authorization to fixed `integrations.firecrawl.dev` partner endpoints. They do not use the secret-bearing admin path or local auth middleware: upstream authorization is the enforcement boundary. [[apps/api/src/lib/admin-integration-integrations-proxy.ts#handleIntegrationAdminCreateUserProxy]] preserves upstream status and JSON error envelopes and maps transport failure to 502.

Neither family accepts a caller-selected destination. Changing the fixed origin, broadening forwarded headers, or moving credential validation between the API and upstream would change this security boundary and requires explicit review.

## Idempotency keys

Crawl creation accepts an optional caller-supplied UUID as a best-effort single-use admission marker.

[[apps/api/src/routes/shared.ts#idempotencyMiddleware]] checks the application database before controller execution. A previously visible recorded key returns 409; a missing key preserves legacy behavior; a malformed key is rejected.

The marker is not an atomic exactly-once transaction with crawl creation. It has no response replay cache or request-body hash, so clients must not treat it as proof that concurrent retries cannot both reach orchestration.

## Rate limiting and concurrency

Request-rate limits and execution concurrency solve different abuse and fairness problems.

[[apps/api/src/services/rate-limiter.ts#getRateLimiter]] creates one-minute Redis windows keyed by endpoint mode and team. Plan-specific rates override safe fallbacks; scrape and search retain a temporary minimum allowance.

Concurrency gates active work per team. Queue admission may backlog accepted jobs, while synchronous scrapes and browser sessions mirror their capacity use into Redis or FoundationDB ledgers. External-slot releases target the backend recorded at acquisition and can repair mismatched migration state.

## Credit admission

Credit checks reject obviously unaffordable work before resources are consumed, while allowing billing to follow actual completed usage.

Autumn is the admission source of truth. An Autumn availability failure fails open to avoid a customer outage. For variable-size requests, middleware derives requested credits from limit or URL count and may reduce an explicit limit to the remaining balance.

[[trust-and-operations#Agent-sponsored credentials|Agent-sponsored credentials]] apply their sponsor-state gate before ordinary credit policy.

## Usage billing

Actual usage is tracked by endpoint and request identity, then committed asynchronously without double charging.

[[apps/api/src/services/billing/credit_billing.ts#billTeam]] first asks Autumn to track request-scoped credits, then enqueues a legacy database billing operation. Redis batches group compatible operations by team, subscription, endpoint, extraction mode, and API key.

A distributed lock allows one billing-batch drainer. Database RPC success updates authorization caches asynchronously. Database failure refunds Autumn credits only when they were already tracked in-request; tracking not performed in-request is added after database success.

Preview and keyless identities skip account billing while retaining their separate quota accounting.

## Research billing and retention

Research proxy operations reuse scrape or search billing categories but have a distinct logging and privacy boundary.

[[http#Research]] bills paper inspection and query-guided reading as one scrape credit. Paper discovery, relationship traversal, and GitHub search bill by returned result count, with higher per-ten pricing when forced enterprise search privacy applies; successful keyless calls consume preview credits.

Billing is submitted asynchronously after a successful upstream response. A billing failure is logged without rewriting the already proxied response, matching the general rule that analytics or accounting transport failure does not become upstream research failure.

Current research request and result logging explicitly sets zero-data retention to false. Until that implementation changes, forced search privacy pricing must not be interpreted as ordinary search ZDR propagation or a no-retention guarantee.

## Feedback and refunds

Endpoint feedback is an owned job annotation with bounded, policy-driven credit relief.

[[apps/api/src/controllers/v2/feedback/record.ts#recordEndpointFeedback]] verifies database-backed access, team ownership, job age, endpoint-specific success requirements, and team opt-out before inserting feedback.

One team can persist only one feedback record for an endpoint job. Duplicate submission reports the original record and refunds zero, making the unique database constraint the race-safe deduplication boundary.

Refund policy uses actual billed credits, rating, endpoint, and expensive scrape features. It applies flat or percentage-with-cap rules, never exceeds the job charge, and is further bounded by a per-team UTC-day cap.

Feedback remains recorded if the billing refund fails. Forced-ZDR teams and jobs return a non-persisting success with zero refund so the endpoint does not create a new data-retention side channel.

## Webhook contract

Webhooks expose job lifecycle events with stable identifiers, optional filters, caller metadata, and authenticated delivery.

Events include crawl and batch started/page/completed, extract started/completed/failed, and monitor page/check completion. Filters accept the full event name or legacy suffixes.

[[apps/api/src/services/webhook/delivery.ts#WebhookSender]] signs payload bytes with `X-Firecrawl-Signature: sha256=<digest>` when a team or self-hosted secret exists. Payloads include a unique webhook delivery ID for downstream deduplication.

Private-IP destinations are denied unless explicitly enabled. Direct delivery uses secure no-cookie dispatch, 10-second v1/v2 or 30-second v0 timeouts, and fire-and-forget semantics unless a caller requires awaiting. Optional RabbitMQ delivery publishes persistent messages and honors channel backpressure.

Delivery logs are staged in Redis and batch-inserted into PostgreSQL. Logging failure does not rewrite job outcome.

## Observability

Logs, metrics, traces, and error reporting share request, team, job, mode, and privacy context.

Winston emits structured logs and filters ZDR-sensitive records before formatting. [[apps/api/src/lib/logger.ts#serializeLogMetadata]] bounds warn/error metadata at 8 KiB and retains only capped request/job/team context plus error name, message, stack, scalar codes, and cycle-safe cause summaries. Provider-specific error properties and arbitrary request, response, model, prompt, content, or body objects are not serialized.

Search phase and provider-selection notices plus no-op reconciler completions use debug level. Request metrics, request completion, reconciliation changes, and failures remain operational signals at info, warn, or error. Request timing middleware records Prometheus HTTP duration by API version, method, route pattern, and status. Workers expose queue, duration, health, liveness, and process metrics.

OpenTelemetry spans cover HTTP work, engine selection, waits, object storage, and external calls. Sentry tags distinguish API and worker services; ZDR-aware capture avoids attaching sensitive context.

Admin metrics include NuQ and process state. Bull Board exposes legacy BullMQ queues under the configured secret-bearing path.

## Error boundaries

Known domain errors cross process boundaries through explicit serialization; unexpected errors preserve diagnostics but return safe public messages.

Transportable errors cover scrape timeout, cache-only misses, DNS, map failures/timeouts, sitemap and crawl denial, unsupported actions, and related workflow conditions. Workers serialize these so controllers can choose stable status and code behavior.

Validation, malformed JSON, queue saturation, and unexpected errors have separate Express handlers. Unexpected responses carry an error identifier that correlates customer reports with structured logs and Sentry.

## Operational degradation rules

Optional dependencies degrade in bounded ways rather than causing silent policy bypass.

- Index-cache failure falls back to the index database.
- Search provider selection is terminal: typed failures surface as 502 or 503, while valid empty results and sanitized partial warnings remain successful.
- PII redaction returns no source markdown when its optional service cannot produce a complete safe result.
- Tracking, analytics, and webhook-log failure do not fail completed work.
- Autumn admission failure fails open; keyless limiter failure fails closed.
- Optional FoundationDB routing falls back to PostgreSQL; forced FoundationDB does not.
- Artifact lookup can fall back to live Redis result data.
- Missing required worker brokers or selected local-runtime dependencies fail the owning process.
