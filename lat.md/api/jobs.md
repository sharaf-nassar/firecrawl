# Jobs and Queueing

Asynchronous work is represented as owned jobs and groups with renewable leases, durable status, bounded retention, and backend-aware routing.

## Job kinds

Queue job modes separate page execution from crawl discovery and terminal coordination.

- `single_urls` runs one scrape and optionally contributes it to a crawl or batch group.
- `kickoff` discovers initial crawl work from a seed URL, index, and sitemap.
- `kickoff_sitemap` continues sitemap expansion without conflating it with page scraping.
- Crawl-finished jobs perform group completion, billing/logging reconciliation, and terminal webhooks.
- Extract, deep-research, LLMs.txt, billing, precrawl, index, and webhook messages use dedicated queues because their retry and scaling needs differ.

## NuQ abstraction

NuQ presents queue and group operations independent of the selected durable backend.

The PostgreSQL implementation uses database rows for job state and optional RabbitMQ notifications for low-latency listeners. Its status vocabulary is `queued`, `active`, `completed`, `failed`, `backlog`, and `cancelled`; workers acquire lock tokens, renew leases, and must present the lock when finishing or failing work.

Groups aggregate child jobs into `active`, `completed`, or `cancelled` lifecycle. A group is the authoritative unit for crawl/batch counters, maximum concurrency, delay policy, expiry, cancellation, and listing.

## Backend routing

The queue router supports a controlled migration between PostgreSQL NuQ and FoundationDB without splitting one crawl across stores.

[[apps/api/src/services/worker/nuq-router.ts#resolveNewGroupBackend]] selects a new group's backend from global configuration and a team flag. The choice is stored on the crawl. Child jobs inherit it, while standalone work resolves from the current team policy.

Reads use crawl or job backend markers and default unmarked legacy work to PostgreSQL. Optional FoundationDB failures fall back to PostgreSQL unless FoundationDB is forced. Existing PostgreSQL groups drain on their original backend after a team migrates.

## Admission, backlog, and priority

Queue admission separates accepted work from runnable work so team concurrency and global capacity remain enforceable.

[[apps/api/src/services/queue-jobs.ts#addScrapeJob]] chooses the backend, enforces queue limits, and places over-concurrency jobs into a backlog with a deadline. Kickoff work may bypass the gate so a crawl can discover its actual child load.

Priority includes endpoint base priority and plan modifiers. Synchronous scrape uses a team semaphore instead of a durable queue but reports whether it waited. Crawl-level `maxConcurrency` can only narrow the plan allowance.

FoundationDB performs admission and queue-cap checks atomically. PostgreSQL mode mirrors active and waiting state through Redis concurrency ledgers and reconciliation workers.

## Worker lease lifecycle

Workers repeatedly claim a job, extend its lock during execution, and make exactly one terminal queue transition.

[[apps/api/src/services/worker/scrape-worker.ts#processJobInternal]] dispatches by job mode. Page jobs run the scrape pipeline, bill actual work, persist logs/artifacts, register group completion, emit page webhooks, and discover eligible crawl links. Kickoff modes create child jobs.

Lease renewal failure makes the worker stop treating itself as authoritative. Unexpected errors are serialized when possible, while known transportable errors preserve stable error codes across the queue boundary.

## Crawl state

Redis holds fast-changing crawl orchestration state that is separate from queue job rows.

The stored crawl contains owner team, seed, crawler and scrape options, internal retention policy, webhook, creation time, cancellation, queue backend, robots rules, and optional per-crawl concurrency.

URL locks use normalized permutations to avoid duplicate pages caused by fragments, slash variants, and query-policy differences. Ordered completion lists power status pagination. Kickoff completion and crawl-finished markers prevent terminal processing before all discovery has settled.

[[apps/api/src/lib/crawl-redis.ts#finishCrawl]] is a guarded terminal transition: only one finisher should enqueue completion work and clear active-crawl membership.

## Group completion

A crawl or batch completes only when kickoff is finished and no group work remains runnable or backlogged.

Terminal coordination records final counts, billing, logs, completion webhooks, and status timestamps. Cancellation marks stored crawl state and group state before queued work is removed, so status cannot regress to completed because of late worker results.

Result bodies remain outside the crawl record. Status reads completed queue values first and then artifact storage, allowing queue retention and large-result storage to evolve independently.

## Extract queue

Extraction uses a durable RabbitMQ main queue with a dead-letter exchange and queue.

[[apps/api/src/services/extract-queue.ts#addExtractJob]] publishes persistent messages. Consumers use manual acknowledgement and bounded prefetch. Handled extraction failures are acknowledged after status is updated; broker-level crashes or exhausted delivery move to the dead-letter path for explicit failed-state repair.

The extract worker has independent health, liveness, metrics, initialization, and shutdown behavior, so extraction load does not compete with scrape workers.

## Monitoring queue

Monitoring uses a RabbitMQ coordinator queue while its page work continues through ordinary NuQ scrape and crawl groups.

Persistent check messages use a quorum queue, bounded consumer prefetch, manual acknowledgement, and a dead-letter queue. The queue message starts or recovers a durable check; PostgreSQL check rows and NuQ groups determine completion.

The queue worker owns due-monitor scheduling, monitor message consumption, and running-check reconciliation. See [[lat.md/api/monitoring#Check orchestration]].

## PostgreSQL queue image

The `apps/nuq-postgres` image makes queue schema initialization and database-side maintenance part of the NuQ deployment contract.

Its init SQL creates scrape, crawl-finished, backlog, and group tables plus the indexes and scheduled maintenance used by the API's NuQ adapter. It runs only when the database volume is initialized, so changing the bootstrap does not migrate existing queue databases.

Cron jobs recover expired locks, fail repeatedly stalled work, expire backlog entries, finish empty groups, clean retained rows, and maintain hot indexes. Queue progress and storage health therefore depend on both workers and database-side maintenance.

See [[lat.md/runtime/support-services#Runtime Support Services#NuQ Postgres]] for schema, retention, lock, and image-level operating details.

## Worker process topology

Worker entrypoints match operational scaling and failure domains.

- `queue-worker` consumes crawl-finished and legacy BullMQ work.
- `nuq-worker` and `nuq-fdb-worker` consume scrape jobs from their respective backends.
- `nuq-prefetch-worker` and `nuq-reconciler-worker` move or repair queue state.
- `extract-worker` owns extraction RabbitMQ and its DLQ.
- `index-worker` owns indexer messages.
- `zdr-worker` cleans retained records governed by ZDR deadlines.
- The queue worker schedules, consumes, and reconciles monitor checks when database authentication and RabbitMQ are configured.
- Local retention, browser admission cleanup, and browser billing outbox workers are started with the local API lifecycle.

Each externally supervised worker exposes health and metrics on its configured port and handles termination independently.

## Legacy worker resource backpressure

The legacy queue and index workers stop claiming new BullMQ jobs while local CPU or memory pressure exceeds configured thresholds.

[[apps/api/src/services/system-monitor.ts#SystemMonitor#acceptConnection]] compares CPU and memory fractions with `MAX_CPU` and `MAX_RAM`, both defaulting to 0.8. Kubernetes mode reads cgroup v2 usage and CPU allocation; other deployments use host metrics with a short configurable cache.

Before each claim, `queue-worker` and `index-worker` run this gate. A refusal sleeps for `CANT_ACCEPT_CONNECTION_INTERVAL`, default two seconds, without dequeuing or failing waiting work. After 25 consecutive refusals they log `WORKER STALLED` but continue retrying; successful admission resets the counter.

This gate does not cover NuQ scrape workers, the extract worker, or already-running jobs. The queue worker separately stops claiming when its API networking liveness check has failed. Kubernetes cgroup read errors log and substitute zero usage, so missing pressure telemetry fails open for that metric.

## Queue invariants

Queue correctness depends on explicit ownership, deadlines, and idempotent state changes.

- A job ID identifies one backend and one owner team.
- A crawl group never migrates backends mid-flight.
- Active work must hold and renew a lease.
- Terminal updates require the current lock token.
- Backlog entries expire rather than waiting forever.
- Completion waits for kickoff and all child work.
- Cancellation is terminal even if a worker returns late.
- Status reads never authorize solely from a caller-supplied job identifier.
