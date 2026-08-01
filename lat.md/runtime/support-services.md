# Runtime Support Services

Firecrawl uses small conversion and persistence services around the API and browser runtimes.

These services have narrower contracts than the API: HTML conversion is request/response, NuQ Postgres is a durable queue backend, and Redis supplies shared ephemeral coordination and rate-limit state.

## SearXNG

The local Compose overlay defines a private, bounded SearXNG service as the reproducible web-search dependency for the wrapper-managed runtime.

The official image is pinned by release and immutable digest. It joins only the `backend` network, publishes no host port, runs as UID/GID `977:977` with a read-only root, drops all capabilities, and uses bounded CPU, memory, PID, and tmpfs resources.

`config/searxng/settings.yml` inherits the pinned image defaults while retaining only Brave, Qwant, Startpage, and Bing. Every retained engine is explicitly enabled for `general`; autocomplete, favicons, limiter, public-instance behavior, image proxying, and Valkey are disabled.

Only JSON search output is enabled, with POST as the server method. A local `/healthz` probe proves the process loaded its configuration without contacting upstream engines; functional search health belongs to the wrapper lifecycle contract.

## HTML to Markdown service

The Go HTML-to-Markdown service converts a bounded HTML string without browser execution.

[[apps/go-html-to-md-service/handler.go#Handler#RegisterRoutes]] registers `GET /`, `GET /health`, and `POST /convert`. Convert accepts `{html}` and returns `{markdown, success}`; malformed JSON and empty input return structured 400 errors.

Request bodies are capped at 150 MiB both at router and handler boundaries. The server uses one-minute read/write timeouts and a 30-second graceful shutdown deadline.

[[apps/go-html-to-md-service/converter.go#NewConverter]] configures the Firecrawl converter with GitHub-Flavored Markdown and robust code-block plugins.

### Logging and zero retention

Conversion logging supports request correlation without forcing retention for zero-data-retention jobs.

`X-Request-ID` is attached to request logs only when `X-Zero-Data-Retention` is not `true`. ZDR requests also suppress success logs containing input size, output size, and duration.

Errors still use the service logger, so callers should treat ZDR as suppression of per-request success/correlation data rather than a separate storage engine.

## NuQ Postgres

NuQ Postgres is a preinitialized PostgreSQL 17 image for durable scrape and crawl-finished queues.

The image and bootstrap SQL live under `apps/nuq-postgres/`. Its image installs and preloads `pg_cron`, then runs `nuq.sql` only during initial database creation. Changes to that SQL do not migrate an existing volume automatically.

The `nuq` schema defines:

- `queue_scrape` for queued, active, completed, and failed scrape jobs;
- `queue_scrape_backlog` for owner/group work waiting outside the active queue;
- `queue_crawl_finished` for group-completion notifications;
- `group_crawl` for active, completed, and cancelled crawl groups.

Jobs contain JSON data, priority, lock ownership/time, stall count, completion data, optional RabbitMQ listen channel, self-hosted result/error fields, owner, and group.

### Queue ordering and locks

Partial indexes make queued selection follow priority, creation time, and ID without scanning terminal rows.

Active locks older than one minute are requeued every 15 seconds and increment `stalls`. After nine prior stalls, the next reap marks the job failed and publishes `pg_notify` on its queue channel.

Standalone cleanup runs every five minutes. It deletes completed rows whose `created_at` is more than one hour old and failed rows whose `created_at` is more than six hours old; it does not measure retention from the terminal transition.

A long-running standalone job can therefore become immediately eligible, or nearly eligible, on completion or failure. Grouped rows remain until their group's TTL cleanup, preserving crawl result listing.

### Crawl group completion

A scheduled job marks an active group completed only after both active queue and backlog contain no remaining work.

Completion sets `expires_at` from the group's millisecond TTL and enqueues a `queue_crawl_finished` record. Cleanup selects up to 500 expired groups with `FOR UPDATE SKIP LOCKED`, then cascades deletes across all three queue tables.

### Database maintenance

The queue image tunes checkpoints, background writer, I/O concurrency, WAL buffering, and group commit for write-heavy queue traffic.

Aggressive autovacuum settings apply to hot queue tables. Daily `REINDEX CONCURRENTLY` jobs are staggered in 20-minute slots; a one-minute watchdog cancels NuQ reindexes running longer than 18 minutes.

`cron.job_run_details` is pruned hourly to 24 hours because sub-minute schedules otherwise grow its history without bound.

## Redis

Redis supplies shared queue-adjacent coordination, rate limiting, and API runtime state.

Standard Compose uses `redis:alpine` with no persistence guarantee. The local overlay enables append-only persistence and mounts `redis-data`, so restart behavior differs between basic self-host and the managed local wrapper.

The repository also contains a custom image under `apps/redis/` intended for Fly-style deployment. Its entrypoint sizes `maxmemory` to 80 percent of detected VM RAM, defaults to `noeviction`, supports optional password/AOF/snapshot settings, and stores data under `/data/redis`.

`noeviction` makes memory exhaustion visible to callers instead of silently dropping queue or rate-limit keys. Capacity planning must leave headroom outside Redis's 80 percent allocation for the process and operating system.

## RabbitMQ relationship

RabbitMQ is the listen/notification transport paired with NuQ rather than the durable job store itself.

Queue rows may carry `listen_channel_id`, while API containers use `NUQ_RABBITMQ_URL=amqp://rabbitmq:5672`. PostgreSQL remains source of job state; RabbitMQ accelerates wakeups and result listeners.

## FoundationDB option

FoundationDB is an experimental alternative queue backend selected with `NUQ_BACKEND=fdb`.

Compose shares an FDB cluster file into the API and runs a one-shot initializer that configures a single SSD database. The local overlay hides both services behind the `foundationdb` profile, so Postgres NuQ remains the default.

FoundationDB replaces NuQ Postgres only for queue backing. It does not replace application Postgres, MinIO, Redis, or RabbitMQ.
