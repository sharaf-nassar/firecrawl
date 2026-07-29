# Persistence and Storage

The API separates transactional request records, fast orchestration state, queue state, large result artifacts, cache data, and analytics because each has different consistency and retention needs.

## Application database

PostgreSQL is the source of truth for teams, keys, plans, request ownership, terminal job logs, monitoring, browser state, and local persistence manifests.

The public schema includes request rows plus endpoint-specific scrape, crawl, batch, search, extract, map, LLMs.txt, deep-research, and agent tables. Request IDs provide a shared ownership and retention anchor for endpoint records and webhook logs.

Separate schemas or connections support usage ledger tracks and the scrape index. Read-heavy authorization and status queries may use a replica, while writes and ownership-sensitive fallbacks use the primary database.

## Database migrations

Application migrations are ordered startup dependencies in local persistence mode.

The migration set establishes local owners, artifact manifests, endpoint records, retention foreign keys, webhook cleanup deadlines, and browser profiles, sessions, replay checkpoints, actions, capabilities, proxy grants, control generation, billing outbox, and cleanup claims.

Foreign keys use request ownership to coordinate deletion. Browser migrations encode leases, deadlines, fencing generations, idempotent action ordering, and outbox claims so crash recovery does not depend on process memory.

The production API build invokes `scripts/package-migrations.mjs` to publish migrations into `dist`; this makes migration packaging part of the [[lat.md/operations/deployment-and-ci#Deployment and CI Operations#Container publication|deployment artifact]], not an optional release step.

Publication serializes cooperative writers with an exclusive lock, captures and revalidates destination-ancestor identity, and stages an exact-byte source inventory. Any failure before final verification rolls back the prior tree; successful final inventory verification is the commit point.

## Redis roles

Redis is used for low-latency coordination, not as one undifferentiated database.

- General Redis stores crawl records, URL locks, completion ordering, extract status, authentication caches, idempotency, and lightweight service state.
- Rate-limit Redis stores per-mode request windows and keyless quotas.
- Eviction/coordination Redis stores crawl membership, concurrency ledgers, webhook log staging, billing batches, and other expiring state.
- Optional index-cache Redis/Dragonfly fronts index-database reads.

Deep-research and LLMs.txt progress and output are also TTL-bound Redis resources, while BullMQ Redis carries their runnable jobs. Keys use explicit TTLs where loss is acceptable or retention is bounded. Distributed locks protect cache mutation and batch drains.

## Redis service image

The `apps/redis` image defines a stateful Fly-oriented Redis runtime used by API coordination deployments.

Its default `noeviction` policy makes exhaustion visible instead of silently removing coordination state. Persistence, password, snapshot, and AOF choices remain deployment concerns rather than API-level durability guarantees.

Correctness-critical identity and terminal records remain in PostgreSQL, queue databases, or artifact storage. See [[lat.md/runtime/support-services#Runtime Support Services#Redis]] for Compose, local-overlay, Fly-image, memory, and restart behavior.

## Crawl and extraction state

Redis status represents live orchestration; terminal database rows and artifacts extend visibility after live keys expire.

Crawl records contain policy and ownership, while queue groups hold counters and child lifecycle. Completed page bodies reside in queue return values or artifact storage. Ordered completion keys provide stable pagination.

Extraction keeps a processing record, optional progress/usage fields, and result pointer. Status checks consult live Redis, terminal database rows, and artifacts in that order appropriate to ownership and completion.

## Artifact storage and retention

Large job results are stored behind a provider-neutral artifact interface backed by GCS or MinIO.

[[apps/api/src/lib/artifacts/index.ts#createArtifactStore]] selects the configured provider. Job object keys preserve legacy `<id>.json` naming but hash-prefix newer UUIDv7 identifiers to distribute object-store writes.

Hosted operation writes result JSON and searchable metadata directly to the provider. Local persistence wraps writes in an application-database manifest recording owner, request, job, kind, size, content type, checksum, and deletion deadline.

Manifest persistence is the consistency boundary: if a newly written object cannot be manifested, the object is deleted. Retention workers use manifest deadlines rather than object-store listing as authority.

Browser profiles, replay checkpoints, screenshots, and monitor diffs also separate large bodies from their PostgreSQL authority. See [[lat.md/api/browser#Durable state model]] and [[lat.md/api/monitoring#Page history and removal]].

## Job logging

Request admission and terminal endpoint logs are distinct records.

Admission logging creates a request row with kind, API version, owner team, origin/integration, target hint, API key identifier, and ZDR policy. Terminal loggers record success, duration, options, cost, result counts, and endpoint-specific data.

Object artifacts carry enough metadata for operations without requiring the large body in PostgreSQL. Preview/keyless team identities are omitted from persisted artifact metadata where appropriate.

## Index and cache stores

The index database stores reusable scrape documents and engine-selection data independently from endpoint job records.

The index schema contains content index rows, engine-picker work, and verdicts. Index lookups require capability-compatible variants; manual invalidation is distinct from TTL expiry.

[[apps/api/src/services/index-cache.ts#deriveIndexVariantKey]] makes variant identity deterministic. The cache keeps more candidates than a normal lookup result so age and capability filtering still has headroom, and limits reads to a short timeout before database fallback.

## Analytics and tracking

Operational logs, product analytics, ClickHouse tracking, Prometheus metrics, and Sentry are downstream views rather than transaction authorities.

Tracking failures are logged but should not fail a successful customer operation. Billing and ownership checks remain tied to Autumn, Redis batches, and PostgreSQL RPCs instead of analytics delivery.

## Zero-data retention

ZDR changes what may be written and how quickly retained records become eligible for deletion.

Request and job loggers redact targets and options. Artifact metadata omits sensitive values. Sentry capture is gated by ZDR-aware helpers. Local retention deadlines can collapse to immediate cleanup.

Unsupported asynchronous products reject forced ZDR rather than silently persisting data. Search has separate allowed and forced enterprise privacy modes that propagate to provider routing, billing, logging, and cleanup.

## Persistence invariants

Persistence layers remain replaceable because authority is explicit.

- PostgreSQL owns durable identity, ownership, and terminal records.
- Queue backends own runnable job state and leases.
- Redis owns expiring orchestration and admission state.
- Artifact storage owns large result bodies.
- Manifests own artifact retention authority in local mode.
- Index stores own reusable content, not job completion.
- Analytics stores never authorize access or determine completion.
