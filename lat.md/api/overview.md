# API Service Architecture

The API service turns authenticated HTTP requests into synchronous scraping work or durable asynchronous jobs while keeping execution, persistence, billing, and delivery independently operable.

`apps/api` is a TypeScript/Express service, a set of specialized worker processes, and a native Rust helper. The HTTP process owns admission and orchestration; workers own long-running scrape, crawl-finalization, extraction, indexing, retention, and cleanup work.

## Runtime boundaries

Runtime roles are separate processes so public request latency, queue consumption, and maintenance work can scale and fail independently.

- The API listener registers HTTP and WebSocket routes, performs admission checks, and may execute a single scrape inline.
- NuQ workers lease queued scrape and crawl-discovery jobs.
- The queue worker finalizes crawls and handles legacy BullMQ jobs such as deep research and LLMs.txt generation.
- The extract worker consumes RabbitMQ extraction and dead-letter queues.
- Index, ZDR cleanup, prefetch, reconciliation, retention, browser billing, and browser admission workers handle narrower operational duties.
- The harness starts a local dependency graph and is distinct from the production entrypoint.

See [[lat.md/api/jobs#Worker process topology]] and [[lat.md/api/tests#Harness and lifecycle tests]].

## HTTP process startup

Startup establishes persistence and browser control before accepting traffic, preventing requests from observing partially migrated or unreconciled local state.

[[apps/api/src/index.ts#startServer]] runs the ordered startup lifecycle: optional browser-control acquisition, application migrations, browser reconciliation, retention startup, then listener binding. Listener setup initializes blocklists and engine forcing before attaching the livecast WebSocket proxy.

The listener installs:

- URL-encoded and JSON body parsing, with a 10 MiB JSON limit.
- CORS, response timing, disabled `x-powered-by`, and optional trusted-proxy handling.
- Bull Board under a secret-bearing admin path.
- `/`, `/e2e-test`, unversioned v0 routes, `/v1`, `/v2`, and admin routers.
- Late error middleware so route validation and operational failures share stable JSON envelopes.

Graceful termination closes the HTTP listener and local runtime, then drains NuQ, webhook, and indexer resources. Kubernetes termination includes load-balancer drain time before listener closure.

## API health probes

The v0 liveness and readiness paths are listener probes, not independent dependency or capability checks.

`GET /v0/health/liveness` and `GET /v0/health/readiness` are public and both unconditionally return HTTP 200 with `{ "status": "ok" }` through [[apps/api/src/controllers/v0/liveness.ts#livenessController]] and [[apps/api/src/controllers/v0/readiness.ts#readinessController]].

Because the listener binds after the ordered [[overview#HTTP process startup|startup lifecycle]], a successful probe proves that startup reached listener admission and the process can answer HTTP. Once bound, neither route checks PostgreSQL, Redis, queue brokers, scrape engines, browser authority, resource pressure, or end-to-end scrape success.

Kubernetes examples use the two paths under distinct probe names, but their runtime behavior is identical. The stronger local graph check is [[lat.md/operations/local-runtime#Local Runtime Operations#Health|`scripts/local-firecrawl health`]], which verifies dependencies, migrations, artifacts, browser components, and network policy.

## Configuration contract

Configuration is parsed once through a strict Zod schema, making malformed environment values a startup failure instead of a latent runtime error.

[[apps/api/src/config.ts#configSchema]] groups configuration into these operational domains:

- Listener and deployment identity.
- PostgreSQL, replica, index database, Redis, NuQ PostgreSQL/RabbitMQ, and FoundationDB.
- Local persistence, artifact provider, retention, and browser runtime.
- GCS object buckets and ClickHouse analytics.
- Scrape engines, search providers, PDF services, models, and external proxies.
- Worker ports, counts, lock durations, and queue timing.
- Authentication, OAuth introspection, keyless quotas, Autumn billing, and x402.
- Webhook, Sentry, tracing, restricted-country, and feature-gate settings.

Most integrations are capability-gated by configuration. Missing optional engines reduce the available fallback set; missing core dependencies needed by a selected runtime mode fail startup or the owning worker.

## Local and hosted persistence modes

The same API contract supports hosted infrastructure and a local persistence authority, but their consistency boundaries differ.

Hosted mode uses the main PostgreSQL schema, Redis state, queue databases, and configured object storage. Local persistence mode runs application migrations before service admission, records explicit artifact manifests and retention deadlines, and can coordinate a local browser service.

See [[lat.md/api/persistence#Application database]] and [[lat.md/api/persistence#Artifact storage and retention]].

## API versioning policy

Versioned routers preserve older contracts while new behavior converges in v2.

v0 is an explicitly deprecated compatibility surface. v1 retains string-oriented map results and deprecated extraction/research endpoints. v2 uses strict request schemas, structured map results, agent, parse, monitor, interactive browser, feedback, and proxy features.

Shared middleware is deliberately reused across v1 and v2 so authentication, rate limits, credits, blocklists, country restrictions, request timing, and idempotency remain policy boundaries rather than controller conventions.

See [[lat.md/api/http#Versioned route surfaces]].

## Architectural invariants

Cross-cutting invariants keep authorization, job ownership, and retention coherent across synchronous and asynchronous paths.

- Authenticate and assign a team before credit, queue, or durable-state work.
- Validate UUID job identifiers before querying status or cancellation state.
- Treat team ownership mismatches as missing resources where disclosure would leak job existence.
- Pin every crawl group to one queue backend for its entire lifetime.
- Keep queue locks renewable and terminal transitions idempotent.
- Persist request metadata separately from large result artifacts.
- Do not persist sensitive request or result content when zero-data-retention rules apply.
- Bill actual completed work; admission estimates prevent impossible requests but do not replace usage accounting.
- Never let optional cache, analytics, or webhook logging failures redefine successful scrape output.
