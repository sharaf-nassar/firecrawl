# Local Firecrawl

This repository runs Firecrawl v2.11.0 for applications on this host. Only
`127.0.0.1:3002` is published. Redis, RabbitMQ, PostgreSQL, and Playwright stay
inside the Docker network.

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
  docker compose up -d --build &&
  docker compose ps
```

The first source build can take several minutes. `.env` contains generated
credentials and is ignored by Git. The setup script refuses to replace it,
and the chained commands stop if generation fails.

If `.env` already exists, stop and audit it against `.env.example.local`.
Preserve intentional credentials and settings; never overwrite the file
blindly. After confirming it belongs to this deployment, start with:

```bash
docker compose config --quiet &&
  docker compose up -d --build &&
  docker compose ps
```

## Client migration

Set the Firecrawl base URL to `http://127.0.0.1:3002`. Do not send the paid
cloud API key; Firecrawl API authentication is disabled locally by
`USE_DB_AUTHENTICATION=false`.

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

The wrapper's `restart` operation performs an ordered `stop` followed by
`up -d --wait`, reapplying dependency health ordering and waiting for service
health checks before returning. Its supported surface has no destructive
operations: no `down`, volume deletion, pruning, or broad Docker commands.

Stop services while preserving named volumes:

```bash
docker compose down
```

Start stopped services:

```bash
docker compose up -d
```

`docker compose down` preserves named data volumes. Do not add `--volumes`
unless permanently deleting local Firecrawl queue/cache data is intended.

## Queue administration

Queue administration is available at
`http://127.0.0.1:3002/admin/BULL_AUTH_KEY/queues`. Read `BULL_AUTH_KEY` from
`.env` locally, replace the placeholder in the URL, and do not commit the key.

## Dependency checks

```bash
docker compose exec -T redis redis-cli ping
docker compose exec -T rabbitmq rabbitmq-diagnostics -q check_running
docker compose exec -T nuq-postgres pg_isready -U firecrawl -d postgres
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

Use `docker compose ps` first, then inspect only this project's logs with the
routine-operation command above. A running container is not proof of a working
API; repeat the scrape check after resolving dependency failures.

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
docker compose up -d --build --force-recreate
docker compose ps
```

Run every dependency check, then the scrape and crawl smoke checks against the
recreated runtime. Commit the merge only after those checks pass.

If conflict resolution or pre-commit runtime verification is unsafe, abort
the uncommitted merge and rebuild the prior release:

```bash
git merge --abort
docker compose up -d --build --force-recreate
```

Confirm the prior runtime with the dependency and smoke checks before
discarding any upgrade backup.
