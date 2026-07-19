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
their data needs backup or migration before running `docker compose up`. Do
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

Normal `start`, `restart`, and `docker compose down` preserve all named
volumes. The wrapper has no destructive reset surface: no volume deletion,
pruning, or broad Docker commands. A restart is never a data reset.

Stop services while preserving named volumes:

```bash
docker compose down
```

Start stopped services:

```bash
scripts/local-firecrawl start
```

`docker compose down` preserves named data volumes. Never add `--volumes` as a
recovery experiment; that permanently deletes application, artifact, and queue
state.

## Application migrations

`app-db-migrate` runs before the API. Migration filenames are applied in
lexical order, not by treating the numeric prefix as a unique version. Current
order is:

```text
0001_persistence_foundation.sql
0002_preflight_orphan_webhooks.sql
0002_retention_foreign_keys.sql
```

The preflight filename intentionally sorts before the retention foreign-key
migration. It removes legacy webhook orphans before constraints are validated.
Some deployments may already have the retention migration ledgered from before
the preflight file existed; the runner safely applies the missing preflight on
the next run without replaying the ledgered retention migration. Do not rename
either file to make the numeric prefixes unique.

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

Zero-data-retention requests stay redacted, do not write durable artifacts,
and receive a cleanup deadline no later than 24 hours even when normal
retention is longer. Inspect bounded logs for `Local artifact retention delete
failed`, `Local retention iteration failed`, or `Local retention worker
terminated unexpectedly`. Those failures require diagnosis; do not delete a
volume to silence them.

## Application database backup and restore

These commands use the database container's own user and database environment
values; they never place credentials on the command line. Stop the API first
so request handlers and the retention worker cannot write during maintenance.
The dump is published atomically on the host only after `pg_dump` succeeds:

```bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
compose=(docker compose --project-name firecrawl \
  --project-directory "$repo_root" -f "$repo_root/compose.yaml")
backup_dir="$repo_root/backups/local-firecrawl"
mkdir -p "$backup_dir"
dump_tmp="$(mktemp "$backup_dir/.app-postgres.dump.XXXXXX")"
backup_complete=false
cleanup_dump() {
  rm -f -- "$dump_tmp"
  if [[ "$backup_complete" != true ]]; then
    "${compose[@]}" stop api >/dev/null || true
  fi
}
trap cleanup_dump EXIT
"${compose[@]}" stop api
"${compose[@]}" exec -T app-postgres sh -ec \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' \
  > "$dump_tmp"
test -s "$dump_tmp"
mv -- "$dump_tmp" "$backup_dir/app-postgres.dump"
"$repo_root/scripts/local-firecrawl" start
backup_complete=true
trap - EXIT
```

If any command fails, `set -e` prevents API startup and the trap removes an
incomplete temporary dump. Verify the finished dump and copy it to independent
storage. Restore only during a maintenance window:

```bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
compose=(docker compose --project-name firecrawl \
  --project-directory "$repo_root" -f "$repo_root/compose.yaml")
dump_file="$repo_root/backups/local-firecrawl/app-postgres.dump"
restore_complete=false
keep_api_stopped() {
  if [[ "$restore_complete" != true ]]; then
    "${compose[@]}" stop api >/dev/null || true
  fi
}
trap keep_api_stopped EXIT
test -s "$dump_file"
"${compose[@]}" stop api
"${compose[@]}" exec -T app-postgres sh -ec \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --exit-on-error --single-transaction' \
  < "$dump_file"
"$repo_root/scripts/local-firecrawl" start
restore_complete=true
trap - EXIT
```

`--exit-on-error` and `set -e` keep the API stopped if restore fails. Save the
error and bounded logs, then repair or select a known-good backup instead of
starting writers against a failed restore. Run `scripts/local-firecrawl health`
only after the restore snippet completes.

## MinIO volume backup and restore

MinIO's data directory is an internal storage format. Never edit, copy, or
delete individual files inside it. The only supported filesystem operation is
a controlled, complete, offline volume archive. The pinned PostgreSQL image
supplies the verified GNU `tar`/`find` tools without joining any network.

Create a backup with API writers and MinIO stopped. The API restarts only after
archive creation and preflight both succeed:

```bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
compose=(docker compose --project-name firecrawl \
  --project-directory "$repo_root" -f "$repo_root/compose.yaml")
backup_dir="$repo_root/backups/local-firecrawl"
mkdir -p "$backup_dir"
archive_tmp=""
backup_complete=false
fail_backup_closed() {
  if [[ -n "$archive_tmp" ]]; then
    rm -f -- "$archive_tmp"
  fi
  if [[ "$backup_complete" != true ]]; then
    "${compose[@]}" stop api minio >/dev/null || true
  fi
}
trap fail_backup_closed EXIT
"${compose[@]}" stop api minio
minio_volume="$(docker volume ls \
  --filter label=com.docker.compose.project=firecrawl \
  --filter label=com.docker.compose.volume=minio-data \
  --format '{{.Name}}')"
test -n "$minio_volume"
[[ "$minio_volume" != *$'\n'* ]]
archive_tmp="$(mktemp "$backup_dir/.minio-data.XXXXXX")"
archive_tmp_name="${archive_tmp##*/}"
docker run --rm --network none --read-only \
  --volume "$minio_volume:/source:ro" \
  --volume "$backup_dir:/backup" \
  --entrypoint tar postgres:17.10-bookworm \
  -C /source -czf "/backup/$archive_tmp_name" .
test -s "$archive_tmp"
docker run --rm --network none --read-only \
  --volume "$backup_dir:/backup:ro" \
  --entrypoint tar postgres:17.10-bookworm \
  -tzf "/backup/$archive_tmp_name" >/dev/null
mv -- "$archive_tmp" "$backup_dir/minio-data.tar.gz"
"$repo_root/scripts/local-firecrawl" start
backup_complete=true
trap - EXIT
```

If backup fails, API and MinIO remain stopped and the incomplete archive is
removed. A restore is not filesystem-atomic. It is service-level atomic: no API
or MinIO consumer runs while the live volume could contain partial data. The
procedure preflights the selected archive before stopping services, creates and
validates a separate rollback archive, preserves numeric ownership, compares
the restored tree with the archive, and validates MinIO before allowing API
startup.

```bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
compose=(docker compose --project-name firecrawl \
  --project-directory "$repo_root" -f "$repo_root/compose.yaml")
backup_dir="$repo_root/backups/local-firecrawl"
restore_archive="$backup_dir/minio-data.tar.gz"
restore_name="${restore_archive##*/}"
recovery_complete=false
fail_closed() {
  if [[ "$recovery_complete" != true ]]; then
    "${compose[@]}" stop api minio >/dev/null || true
  fi
}
trap fail_closed EXIT
test -s "$restore_archive"
docker run --rm --network none --read-only \
  --volume "$backup_dir:/backup:ro" \
  --entrypoint tar postgres:17.10-bookworm \
  -tzf "/backup/$restore_name" >/dev/null

"${compose[@]}" stop api minio
minio_volume="$(docker volume ls \
  --filter label=com.docker.compose.project=firecrawl \
  --filter label=com.docker.compose.volume=minio-data \
  --format '{{.Name}}')"
test -n "$minio_volume"
[[ "$minio_volume" != *$'\n'* ]]
rollback_archive="$(mktemp "$backup_dir/minio-data.rollback.XXXXXX")"
rollback_name="${rollback_archive##*/}"
docker run --rm --network none --read-only \
  --volume "$minio_volume:/source:ro" \
  --volume "$backup_dir:/backup" \
  --entrypoint tar postgres:17.10-bookworm \
  -C /source -czf "/backup/$rollback_name" .
test -s "$rollback_archive"
docker run --rm --network none --read-only \
  --volume "$backup_dir:/backup:ro" \
  --entrypoint tar postgres:17.10-bookworm \
  -tzf "/backup/$rollback_name" >/dev/null
printf 'Rollback archive: %s\n' "$rollback_archive"

docker run --rm --network none --read-only \
  --volume "$minio_volume:/target" \
  --volume "$backup_dir:/backup:ro" \
  --entrypoint sh postgres:17.10-bookworm -ec \
  'find /target -mindepth 1 -delete
   tar --extract --gzip --numeric-owner --same-owner \
     --file "/backup/$1" --directory /target' sh "$restore_name"
docker run --rm --network none --read-only \
  --volume "$minio_volume:/target:ro" \
  --volume "$backup_dir:/backup:ro" \
  --entrypoint tar postgres:17.10-bookworm \
  --compare --gzip --numeric-owner --file "/backup/$restore_name" \
  --directory /target

"${compose[@]}" up -d --wait minio
"${compose[@]}" up --no-deps --force-recreate \
  --abort-on-container-exit --exit-code-from minio-init minio-init
test "$("${compose[@]}" ps --all \
  --format '{{.State}} {{.ExitCode}}' minio-init)" = 'exited 0'
"${compose[@]}" exec -T minio curl --fail --silent --show-error \
  --max-time 10 --output /dev/null \
  http://127.0.0.1:9000/minio/health/live
"${compose[@]}" run --rm --no-deps -T api sh -ec \
  'test -z "${MINIO_ROOT_USER+x}" && \
   test -z "${MINIO_ROOT_PASSWORD+x}" && \
   node dist/src/cli/artifact-health.js'
"$repo_root/scripts/local-firecrawl" start
recovery_complete=true
trap - EXIT
```

Any failure after restoration begins keeps API and MinIO stopped and leaves the
validated rollback archive intact. An earlier failure leaves the live volume
untouched. To recover, set `restore_archive` to the printed rollback path and
repeat the same offline restore procedure. Never start either consumer against
the failed or partially restored volume.

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
docker compose exec -T redis redis-cli ping
docker compose exec -T rabbitmq rabbitmq-diagnostics -q check_running
docker compose exec -T nuq-postgres sh -ec \
  'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose exec -T app-postgres sh -ec \
  'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose exec -T minio curl --fail --silent --show-error \
  http://127.0.0.1:9000/minio/health/live
docker compose exec -T api node dist/src/cli/artifact-health.js
docker compose exec -T playwright-service node -e "
fetch('http://127.0.0.1:3000/health')
  .then(async response => {
    console.log(await response.text());
    process.exit(response.ok ? 0 : 1);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
"
```

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
