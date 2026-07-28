# Local Firecrawl

This repository runs Firecrawl v2.11.0 for applications on this host. Phase 1
supports durable core scrape, search, and crawl records, job artifacts, and
retention. Interact still requires the Phase 2 browser/orchestrator work; a
local Interact request is not a supported Phase 1 capability.

Only `127.0.0.1:3002` is published. Redis, RabbitMQ, both PostgreSQL services,
MinIO, and Playwright stay inside the Docker network. `nuq-postgres` is queue
state; `app-postgres` is the durable application database.

## First start

Before starting services, check for containers and volumes created by another
checkout of the `firecrawl` Compose project:

```bash
docker compose ps -a
docker volume ls --filter label=com.docker.compose.project=firecrawl
```

If either command shows unexpected Firecrawl resources, stop. Decide whether
their data needs backup or migration before starting the runtime. Do
not delete volumes or assume an anonymous volume can be mapped safely without
its original container metadata.

For a new local deployment with no `.env`, use this short-circuiting sequence:

```bash
./scripts/init-local-env.sh &&
  docker compose config --quiet &&
  docker compose build api playwright-service nuq-postgres &&
  scripts/local-firecrawl start &&
  scripts/local-firecrawl health
```

The first source build can take several minutes. `.env` contains generated
credentials and is ignored by Git. The setup script refuses to replace it,
and the chained commands stop if generation fails.

If `.env` already exists, stop and audit it against `.env.example.local`.
Preserve intentional credentials and settings; never overwrite the file
blindly. After confirming it belongs to this deployment, start with:

```bash
scripts/upgrade-local-env-phase1 &&
  scripts/upgrade-local-env-phase1 --check &&
  docker compose config --quiet &&
  docker compose build api playwright-service nuq-postgres &&
  scripts/local-firecrawl start &&
  scripts/local-firecrawl health
```

## Client migration

Set the Firecrawl base URL to `http://127.0.0.1:3002`. Do not send the paid
cloud API key; Firecrawl API authentication is disabled locally by
`USE_DB_AUTHENTICATION=false`.

Authentication and persistence are separate. Disabling API-key authentication
does not disable the application database. Every local request is normalized
to the stable `LOCAL_OWNER_ID` from `.env`, so ownership checks and retention
remain deterministic across restarts. Preserve this ID with the database; do
not rotate it casually or existing rows will belong to a different owner.

JavaScript/TypeScript:

```javascript
import Firecrawl from "@mendable/firecrawl-js";

const firecrawl = new Firecrawl({
  apiUrl: "http://127.0.0.1:3002",
});
```

The JavaScript v2 SDK also recognizes `FIRECRAWL_API_URL`.

Python:

```python
from firecrawl import Firecrawl

firecrawl = Firecrawl(api_url="http://127.0.0.1:3002")
```

Use the explicit `api_url` option with the current Python v2 client. Its
unified client does not read `FIRECRAWL_API_URL`; the legacy v1 client does.

## Smoke checks

Scrape one page:

```bash
curl --fail-with-body -sS -X POST http://127.0.0.1:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

Start a two-page crawl:

```bash
curl --fail-with-body -sS -X POST http://127.0.0.1:3002/v2/crawl \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://docs.firecrawl.dev","limit":2}'
```

Poll the returned ID:

```bash
curl --fail-with-body -sS http://127.0.0.1:3002/v2/crawl/CRAWL_ID
```

## Routine operation

Use the path-independent wrapper for routine startup, recovery, inspection,
health checks, and bounded logs:

```bash
scripts/local-firecrawl start
scripts/local-firecrawl stop
scripts/local-firecrawl restart
scripts/local-firecrawl status
scripts/local-firecrawl health
scripts/local-firecrawl logs
```

The wrapper stops API writers before dependencies, waits for all long-running
dependencies, runs `app-db-migrate` and `minio-init` as bounded foreground
one-shots, then starts the API. It stops immediately if either one-shot fails.
This avoids Docker Compose v5 treating a successful exited one-shot as a failed
long-running `up --wait` target.

Normal `start`, `stop`, and `restart` preserve all named volumes. The wrapper
has no destructive reset surface: no volume deletion, pruning, or broad Docker
commands. A restart is never a data reset.

Stop services while preserving named volumes and the shared maintenance lock:

```bash
scripts/local-firecrawl stop
```

Start stopped services:

```bash
scripts/local-firecrawl start
```

`stop` preserves named data volumes. Never use `docker compose down --volumes`
as a recovery experiment; that permanently deletes application, artifact, and
queue state and bypasses lifecycle locking.

## Application migrations

`app-db-migrate` runs before the API. Migration filenames are applied in
lexical order, not by treating the numeric prefix as a unique version. Current
order is:

```text
0001_persistence_foundation.sql
0002_async_request_placeholders.sql
0002_preflight_orphan_webhooks.sql
0002_retention_foreign_keys.sql
0003_resolved_placeholder_webhook_deadlines.sql
```

The async-placeholder filename sorts before both immutable retention files. It
backfills a metadata-free request for every legacy child-first operational row
and installs triggers on all 14 child tables. The preflight can then preserve
resolved webhook logs, and the retention migration can validate its request
foreign keys without deleting child-first job data. Some deployments may
already have the retention migration ledgered from before the preflight file
existed; the runner applies missing files without replaying ledgered files. Do
not rename these files to make the numeric prefixes unique.

The later webhook-deadline migration propagates the configured request
deadline when a real request replaces an asynchronous placeholder. It does not
rewrite webhook deadlines for later updates to already-real requests.

`application_schema_migrations` records each filename and SHA-256 checksum.
Startup fails if an applied file disappears, its checksum changes, a stored
checksum is missing, or a pending migration fails. Never edit an applied
migration. Add a new lexically later file instead.

Diagnose startup failures without exposing `.env`:

```bash
scripts/local-firecrawl status
scripts/local-firecrawl logs
```

`status` must show `app-db-migrate` as `Exited (0)`. `health` also requires the
latest ledger filename to exactly match the latest checked-in migration.

## Retention

`LOCAL_RECORD_RETENTION_DAYS` and `LOCAL_ARTIFACT_RETENTION_DAYS` default to
`30` and must be positive integers. The API process runs the local retention
worker continuously in batches. It removes expired MinIO objects and their
manifests, then cleans expired operational rows. Failed artifact deletes keep
their manifests retryable; later iterations retry them.

An operational child may be logged before its request. Its insert creates a
placeholder request containing no target URL or user payload and a deadline no
later than 24 hours. The local request logger atomically replaces the
placeholder with real metadata and the configured retention deadline. If the
request log never arrives, normal retention removes the abandoned placeholder
and its dependent rows after the bounded fallback window. Hosted request
logging is unchanged. A conflicting real request is never overwritten by the
local placeholder replacement path.

Zero-data-retention requests stay redacted, do not write durable artifacts,
and receive a cleanup deadline no later than 24 hours even when normal
retention is longer. Inspect bounded logs for `Local artifact retention delete
failed`, `Local retention iteration failed`, or `Local retention worker
terminated unexpectedly`. Those failures require diagnosis; do not delete a
volume to silence them.

## Coordinated persistence backup and restore

Use the coordinated scripts; do not dump or replace individual volumes by
hand. Both scripts acquire the same exclusive lifecycle lock as
`scripts/local-firecrawl`, drain active browser work, stop Browser Service and
host execution writers, and keep PostgreSQL, MinIO, and browser profiles in one
generation.

Profiles are sensitive. Committed profile generations can contain cookies,
local storage, IndexedDB, authentication state, and browsing history. Write
backups only to encrypted storage restricted to the Firecrawl operator. Do not
sync an unencrypted generation to shared or public storage.

### Create a coordinated generation

Run from any directory:

```bash
/home/mamba/work/firecrawl/scripts/local-firecrawl-backup
```

The default destination is `backups/local-firecrawl` in this checkout. Prefer
an absolute encrypted destination:

```bash
/home/mamba/work/firecrawl/scripts/local-firecrawl-backup \
  --output /absolute/encrypted/firecrawl-backups
```

A successfully published directory is mode `0700`. Its five mode-`0600`
members are:

```text
<generation>.app-postgres.dump
<generation>.minio-data.tar.gz
<generation>.browser-profiles.tar.gz
<generation>.manifest
<generation>.sha256
```

The checksum inventory covers the manifest and all three payloads exactly.
Publication is an atomic, no-clobber directory rename. Working and staging
profile generations are excluded. Codex auth, adapter tokens, runtime sockets,
broker state, app-server thread state, replay work, host build staging, and
other ephemeral state are never included.

A runtime that was running before backup is restarted and receives the full
local health check. A runtime that was already stopped remains stopped. Any
capture, publication, restart, or health failure leaves API, Browser Service,
the execution adapter, MinIO, and application PostgreSQL stopped.

### Restore a coordinated generation

Pass the canonical absolute generation directory. Optionally place the
rollback generation in another encrypted directory:

```bash
/home/mamba/work/firecrawl/scripts/local-firecrawl-restore \
  /absolute/encrypted/firecrawl-backups/<generation> \
  --rollback-output /absolute/encrypted/firecrawl-rollbacks
```

Restore stops writers before copying or validating backup payloads. It rejects
missing or extra files, generation drift, checksum mismatch, unsafe ownership
or modes, hard-linked or symlink payloads, absolute or parent archive paths,
links and special archive members, uncommitted profile paths, and
database-to-profile pointer disagreement.

Before any destructive write, restore captures and validates a complete
PostgreSQL, MinIO, and committed-profile rollback generation. It restores all
three stores, verifies every live database profile pointer against the exact
committed directory inventory, and only then restarts services that were
running before restore. The full health check catches installed Codex protocol,
application schema, migration checksum, adapter, broker, and Browser Service
drift after recovery. On any failure, all writers stay stopped and the
rollback generation remains available for an explicit second restore.

Backup and restore never resume active model threads, browser sessions, code
jobs, prompt jobs, or app-server conversations. Those operations terminate at
drain or restart; only durable database records, MinIO artifacts, and committed
profile generations return.

MinIO server and client images are pinned to exact releases because upstream
is archived and maintenance-sensitive. They never upgrade automatically.
Review security status, release notes, data-format compatibility, and a
restorable backup before changing either tag.

## Queue administration

Queue administration is available at
`http://127.0.0.1:3002/admin/BULL_AUTH_KEY/queues`. Read `BULL_AUTH_KEY` from
`.env` locally, replace the placeholder in the URL, and do not commit the key.

## Dependency checks

```bash
scripts/local-firecrawl health
```

This shared-lock health check covers Redis, RabbitMQ, both PostgreSQL roles,
Playwright, migration filename and checksum integrity, API/migrator image
provenance, MinIO, application artifact credentials, API response, and port
policy without exposing credential values.

## Troubleshooting

Agent recovery uses a fixed, non-destructive sequence:

```bash
scripts/local-firecrawl status
scripts/local-firecrawl health
scripts/local-firecrawl logs
scripts/local-firecrawl restart
scripts/local-firecrawl health
```

`status` includes application PostgreSQL, MinIO, and both one-shots. `health`
checks queue dependencies, browser service, application migrations, MinIO,
application-credential artifact access, API response, and exact loopback port
policy. `logs` is finite (`200` lines per service), includes the one-shots, and
is scoped to the `firecrawl` Compose project. None of these commands reads or
prints credential values.

A running container is not proof of a working API. If ordered `restart` stops
before API startup, retain that safe stopped state and inspect one-shot logs.
Stop and report instead of deleting volumes when migration integrity fails,
MinIO reports damaged state, a backup cannot be verified, Compose resources
belong to another checkout, or recovery would require credentials not already
present in the mode-`0600` `.env`. Repeat `health` and the scrape check only
after the root cause is resolved.

Self-hosting does not include Fire-engine or managed proxy rotation. A target
that worked through Firecrawl Cloud may block this host's direct IP. Configure
`PROXY_SERVER`, `PROXY_USERNAME`, and `PROXY_PASSWORD` in `.env` only when real
targets demonstrate that need.

## Upgrade

Read the target release notes and inspect its Compose changes first. Require a
clean worktree before the merge:

```bash
git status --porcelain
docker compose ps
docker volume ls --filter label=com.docker.compose.project=firecrawl
```

`git status --porcelain` must produce no output. Before changing source, stop
applications that submit jobs and make restorable backups of PostgreSQL and
any RabbitMQ or Redis state that must survive. Use service-aware backup tools
or a consistent stopped-volume snapshot, record the volume names above, and
verify the restore procedure. Preserve the current volumes and release until
the upgrade is accepted; never use `docker compose down --volumes` here.

Replace `vX.Y.Z` below with one exact release tag; do not merge a floating
branch:

```bash
git fetch upstream tag vX.Y.Z
git rev-parse 'vX.Y.Z^{commit}'
git merge --no-commit --no-ff vX.Y.Z
git status
git diff --name-only --diff-filter=U
```

Inspect each conflict and preserve both upstream requirements and the local
loopback, durability, credential, and FoundationDB profile policy. Do not use
`--ours` or `--theirs` blindly. After resolving and staging every conflict,
validate the merged model and recreate services from the upgraded source:

```bash
docker compose config --quiet
docker compose build api playwright-service nuq-postgres
scripts/local-firecrawl restart
scripts/local-firecrawl status
```

Run every dependency check, then the scrape and crawl smoke checks against the
recreated runtime. Commit the merge only after those checks pass.

If conflict resolution or pre-commit runtime verification is unsafe, abort
the uncommitted merge and rebuild the prior release:

```bash
git merge --abort
docker compose build api playwright-service nuq-postgres
scripts/local-firecrawl restart
```

Confirm the prior runtime with the dependency and smoke checks before
discarding any upgrade backup.
