# Local Runtime Operations

The supported local environment is a layered Docker Compose application managed through `scripts/local-firecrawl`.

`compose.yaml` includes the shared `docker-compose.yaml` stack and the hardened `compose.local.yaml` overlay. Direct Compose use can bypass ordering, provenance, rollback, port, and health invariants enforced by the wrapper.

## Deployment topology

The stack divides public ingress, backend services, model egress, persistent volumes, and initialization jobs.

Only API publishes a host port, bound to `127.0.0.1:${PORT:-3002}`. API, Browser Service, Playwright, databases, Redis, RabbitMQ, MinIO, and NuQ share the private `backend` bridge.

Browser Interaction Worker has no network namespace connectivity. Browser Interaction Egress Proxy alone joins `model-uplink`; shared Unix-socket volumes connect API to worker and worker to proxy.

## Long-running services

The wrapper derives its service inventory from the normalized local search provider mode while treating API, browser services, stores, queues, and object storage as one runtime.

Long-running services are:

- `api`, the public HTTP entrypoint and internal worker harness;
- `browser-service`, the persistent replay/profile browser runtime;
- `browser-interaction-worker`, constrained model decisions over Unix socket;
- `browser-interaction-egress-proxy`, allowlisted model HTTPS uplink;
- `playwright-service`, stateless scrape browser;
- `redis`, `rabbitmq`, and `nuq-postgres`, queue and coordination infrastructure;
- `app-postgres`, durable application records;
- `minio`, durable artifact objects.

Internal search mode adds private `searxng`; external mode omits it and preserves the validated external endpoint without disclosing it in diagnostics.

FoundationDB services are optional and profile-gated.

## Initialization jobs

Three one-shot containers establish state before request-serving containers start.

`browser-state-init` creates and validates the browser volume marker, ownership, modes, profile namespaces, staging metadata roots, and optional replay/quarantine directories.

`app-db-migrate` runs checked-in application migrations after application Postgres is healthy. `minio-init` creates the artifact bucket, restricted policy, and application credential after MinIO is healthy.

One-shots are profiles or explicitly invoked services, have bounded runtime, and must exit zero. Stale or failed one-shot containers are inspected and cleaned deliberately before rerun.

## Persistent volumes

Durability is separated by responsibility to prevent one service from gaining unnecessary authority.

- `browser-state` holds Browser Service profiles, replay checkpoints, quarantine, and atomic publication metadata.
- `codex-auth-state` holds worker-owned refreshed Codex authentication.
- `app-postgres-data` stores application records and migration ledger.
- `nuq-postgres-data` stores durable queue state and pg_cron history.
- `redis-data`, `rabbitmq-data`, and `minio-data` hold coordination, messaging, and artifacts.
- two socket volumes carry API-to-worker and worker-to-egress-proxy Unix sockets.

The browser state volume is writable by the initialization job and Browser Service, not API. API receives browser state through authenticated private protocols.

## API dependency ordering

API readiness is downstream of all required local capabilities.

Compose requires healthy application Postgres, Browser Interaction Worker, Browser Service, Redis, Playwright, RabbitMQ, and NuQ Postgres before API. SearXNG has no fixed API dependency because external mode suppresses the bundled service.

`start_runtime` orders durable dependencies, bundled SearXNG readiness when internal, one-shots, Browser Service, egress proxy, interaction worker, and API. SearXNG readiness uses only its local `/healthz`, so later upstream failure cannot make API unhealthy.

## Environment bootstrap

`scripts/init-local-env.sh` creates a new mode-`0600` `.env` and refuses to overwrite any existing file or symlink.

It generates independent secrets for NuQ Postgres, application Postgres, Bull auth, Browser Service, replay ingest, Browser Interaction Worker, MinIO, and SearXNG. It also writes the canonical internal search endpoint, local owner UUID, retention, and service defaults.

Fresh environments target the host Codex Shim at `http://host.docker.internal:3030/v1`, enable chat-only OpenAI requests, and select `gpt-5.6-luna`. The separately managed shim must be running before local extract can succeed.

Interactive setup privately requires a Brave Search API key. Noninteractive setup reads only `FIRECRAWL_SEARXNG_BRAVE_API_KEY`; missing, blank, or whitespace-containing input fails before `.env` creation. Only its Base64 encoding is persisted.

`scripts/upgrade-local-env-phase1` upgrades earlier environment files under an exclusive mode-`0600` lock. It validates file type, ownership, duplicate keys, secret distinctness, and phase values, then replaces through a bounded temporary file only if the source did not change.

`scripts/local-firecrawl configure-search` collects a nonblank replacement before locking, then uses the atomic updater. It supports addition and rotation, preserves unrelated lines, and never passes the credential to API. External engine overrides remain valid only within `braveapi,bing`.

`scripts/normalize-searxng-endpoint.mjs` canonicalizes origin-only HTTP(S) overrides. Missing or blank values use `http://searxng:8080`; the reserved hostname rejects every other scheme or effective port.

Secrets from `.env` must not be copied into documentation or logs. The wrapper's log path performs pattern-based redaction, but operators should still treat diagnostic output as sensitive.

## Codex host inputs

Starting the local stack resolves but does not install the host Codex runtime.

The wrapper requires exactly one external `codex` executable on `PATH`, proves it is the `@openai/codex` package entrypoint, and bind-mounts that package read-only.

It also requires a single-link regular `~/.codex/auth.json` owned by the current user with mode `0400` or `0600`, plus a readable absolute CA bundle. Missing or ambiguous host inputs stop startup.

The host auth seed is mounted read-only. Refreshed state lives only in `codex-auth-state`, so the container cannot rewrite the user's host credential file.

## Local MCP capability filter

The checked-in MCP launcher exposes only capabilities backed by the configured local stack while preserving disabled upstream tool names for future enablement.

`scripts/local-firecrawl-mcp` is the thin stdio and signal-handling entrypoint for the external Firecrawl MCP package. Its importable library owns disabled tools, discovery and instruction rewrites, stale-call filtering, and local search result translation.

The launcher disables Agent start and status because they require the external Firecrawl Agent service.

The same launcher disables paper search, paper inspection, related-paper lookup, paper reading, and GitHub research because `RESEARCH_PROXY_URL` is not configured. Core local tools and prompt-driven browser interaction continue to target `http://127.0.0.1:3002`.

Local discovery removes `firecrawl_search_feedback` and replaces upstream search instructions and schema with the web-only contract. Search keeps query, limit, filter, domain, category, and scrape controls while exposing only the `web` source.

Local discovery also removes all eight `firecrawl_monitor_*` tools and `firecrawl_feedback`. The local stack does not configure monitor scheduling, persistence, artifacts, or feedback storage, so direct calls receive the standard JSON-RPC `-32601` disabled-tool error.

Direct calls that bypass discovery cannot request non-web sources, geo or recency controls, enterprise mode, or feedback. The launcher rejects them as JSON-RPC `-32602 Invalid params` with data code `LOCAL_SEARCH_WEB_ONLY` before the upstream package or API sees them.

The launcher correlates forwarded search call IDs because the pinned upstream package discards typed REST error bodies. Search HTTP 502 and 503 responses become `isError` tool results with one compact canonical JSON text block; legitimate empty web results pass through as successful calls.

For `firecrawl_interact`, the launcher replaces upstream code-mode advertising with the local prompt-only contract. Its schema omits `code`, restricts `language` to `node`, and rejects stale code-mode calls as invalid parameters before they reach the API.

The launcher pins `firecrawl-mcp@3.22.3`. Captured upstream interact and search registrations plus independent local snapshots make package-pin, instruction, or tool-schema drift require an explicit fixture update.

The complete disabled-name policy contains seventeen reserved upstream names:

- Agent service: `firecrawl_agent`, `firecrawl_agent_status`.
- Research proxy: `firecrawl_research_search_papers`, `firecrawl_research_inspect_paper`, `firecrawl_research_related_papers`, `firecrawl_research_read_paper`, `firecrawl_research_search_github`.
- Search feedback: `firecrawl_search_feedback`.
- Monitor and feedback storage: `firecrawl_monitor_create`, `firecrawl_monitor_get`, `firecrawl_monitor_list`, `firecrawl_monitor_update`, `firecrawl_monitor_delete`, `firecrawl_monitor_run`, `firecrawl_monitor_check`, `firecrawl_monitor_checks`, `firecrawl_feedback`.

`firecrawl_extract` remains enabled. Compose forwards `OPENAI_CHAT_COMPLETIONS_ONLY` only to the API service and defaults it to `false` when unset. Fresh local configuration sets it to `true` and targets `http://host.docker.internal:3030/v1`, routing both extraction pipelines through the separately managed [[runtime/codex-shim#Codex Shim#HTTP and capacity boundary|Codex Shim chat-completions boundary]].

## Lifecycle lock

All lifecycle and diagnostic commands coordinate through a per-user, per-project advisory lock.

The wrapper creates a regular, single-link, user-owned mode-`0600` lock under a private runtime directory, revalidates its identity before and after open, and uses `flock` with a configurable default 30-second wait.

Start, stop, restart, and egress probe take an exclusive lock. Status, health, and logs take a shared lock. This prevents diagnostics from observing half-completed maintenance while permitting concurrent read-only checks.

## Start and restart

Start and restart validate configuration and rebuild local runtime images before changing running state.

They prove Compose schema, network separation, mount direction, fixed worker paths, resource hardening, loopback port publication, and image/container provenance. Legacy containers are recognized only through bounded known configuration paths.

Writers are quiesced before dependencies stop. Browser rollback validation, when explicitly enabled, runs from the current immutable image against a read-only view of the state volume before the replacement starts.

The wrapper reads the normalized endpoint from rendered API configuration. Canonical `http://searxng:8080` requires a Brave key and `braveapi,bing`, then starts SearXNG before API; any validated external origin removes a stale bundled container before startup.

Provider failover and rollback never remove volumes. Switch to an external endpoint with current code before rolling code back; a later re-upgrade preserves that normalized external mode, while restoring the canonical endpoint re-enables the bundled service.

One-shot timeout defaults to 300 seconds and service health wait to 180 seconds. Timeouts are configuration errors when nonpositive and operational failures when exceeded.

## Browser rollback

Browser Service downgrade is opt-in because older code may not understand newer durable atomic-publication records.

`LOCAL_FIRECRAWL_BROWSER_DOWNGRADE=true` also requires `FIRECRAWL_BROWSER_SERVICE_IMAGE` pinned by SHA-256 digest and a currently running Browser Service.

The wrapper stops API, interaction worker, Browser Service, and egress proxy, then runs the current Browser Service image read-only and networkless against its own state volume to check rollback compatibility. Only a proven-safe state proceeds.

## Stop

Stop validates recoverable Compose provenance and shuts down writers before dependencies.

API, interaction worker, and Browser Service stop first, followed by egress proxy, bundled SearXNG when internal, then storage and queue dependencies. External mode removes only a stale SearXNG container. Volumes and one-shot records remain.

## Status

`scripts/local-firecrawl status` reports both long-running and one-shot containers under a shared lifecycle lock.

Human and JSON output name `internal` or `external` mode without showing its endpoint. JSON returns `searchProviderMode` plus selected Compose services sorted by name; external inventory excludes stale bundled SearXNG.

## Health

`scripts/local-firecrawl health` verifies application-level invariants beyond container health status.

Checks include Redis `PONG`, RabbitMQ diagnostics, both Postgres servers, latest migration filename and checksum, successful one-shots, MinIO liveness and restricted application artifact access, Playwright health, Browser Service authenticated liveness, egress socket, worker readiness, public API, and loopback-only port policy.

Health makes exactly one functional `POST /v2/search` using fixed query `SearXNG metasearch`, web source, and limit 1. Request timeout is 10 seconds inside a 15-second outer deadline; success requires HTTP 200, `success:true`, and one HTTP(S) web result.

Human output groups passing checks by dependency, application, and browser runtime. `PostgreSQL (application)` and `PostgreSQL (NuQ)` identify the two database roles. Interactive terminals use restrained status color unless `NO_COLOR` is set or `TERM=dumb`.

Successful health stdout contains only the report, or one JSON object with `--json`; raw probe output stays hidden. Failed probes preserve their exit status and emit a named stderr diagnostic followed by captured command detail when safe. The search smoke never echoes secret-bearing detail.

`--json` also reports provider mode and functional search health without its endpoint. Provider outage fails wrapper health but does not stop API or disable scrape and crawl.

## Egress probe

`scripts/local-firecrawl probe-egress` tests the worker-to-proxy boundary from inside the networkless worker.

The probe sends CONNECT requests through loopback and verifies policy outcomes. It requires the exclusive lifecycle lock because proxy/container changes during the probe would make results ambiguous.

## Logs

`scripts/local-firecrawl logs` provides bounded, redacted diagnostics for all services or selected browser/API components.

It reads at most 200 recent lines, optionally filters by canonical UUID correlation ID, and redacts credentials, prompts, queries, endpoints, URLs, sources, and page values.

Local environment initialization sets `LOGGING_LEVEL=INFO` and Compose passes it to API processes. Debug-only search phase, provider-selection, and no-op reconciler records are therefore opt-in rather than normal local output.

Internal mode supports `logs searxng`; external mode rejects that target and omits it from `logs all`. Browser component targets isolate their corresponding trust boundaries. Remaining failure after wrapper recovery should be surfaced instead of hidden by repeated restarts.

## Local recovery procedure

Recovery uses the wrapper so ordering and evidence remain intact.

1. Run `scripts/local-firecrawl status` to inspect containers and one-shots.
2. Run `scripts/local-firecrawl health` for the first failing invariant.
3. Run bounded component logs, optionally with a correlation UUID.
4. Use `scripts/local-firecrawl start` when stopped or `restart` when a full ordered rebuild is required.
5. Re-run health once; if unhealthy, preserve the reported category and logs for investigation.

Do not remove volumes to resolve ordinary startup, migration, browser reconciliation, or queue failures. Volume deletion discards the evidence and durable state those recovery protocols are designed to validate.

## Basic self-host stack

`docker-compose.yaml` remains the simpler general self-host configuration.

It runs API, Playwright, Redis, RabbitMQ, NuQ Postgres, and optional FoundationDB. It does not include bundled SearXNG, its Brave credential flow, local application persistence, MinIO, Browser Service, or Browser Interaction Worker unless combined through `compose.yaml`.

Generic Compose and Helm operators configure Fire Engine or an external JSON SearXNG explicitly. They do not inherit the wrapper's internal/external lifecycle, web-only filter, functional search health, or rollback contract.

The basic file publishes API on all host interfaces by default, while the local overlay replaces that binding with loopback-only ingress and persistent volumes. Operators must not assume the local hardening or recovery wrapper applies to a standalone self-host deployment.

## Browser integration test database

`compose.browser-test.yaml` is an isolated PostgreSQL service for Browser Service integration tests.

It publishes PostgreSQL only on `127.0.0.1:55432`, uses test credentials, and has its own health check. It is not part of the runtime Compose include.

## Host directory

The repository's `host/` directory currently contains no tracked runtime configuration.

Host integration is expressed through Compose bind mounts and `scripts/local-firecrawl` validation. New host-side units or configuration should define their ownership, secret, lifecycle, and rollback contracts here when introduced.
