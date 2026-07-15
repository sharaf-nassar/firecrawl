# Local Firecrawl

This repository runs Firecrawl v2.11.0 for applications on this host. Only
`127.0.0.1:3002` is published. Redis, RabbitMQ, PostgreSQL, and Playwright stay
inside the Docker network.

## First start

Before starting services, check for containers created by another checkout:

```bash
docker compose ps -a
```

If the command shows existing Firecrawl containers from another checkout,
stop. Decide whether their data needs backup or migration before running
`docker compose up`. Do not delete their volumes.

For a new local deployment:

```bash
./scripts/init-local-env.sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

The first source build can take several minutes. `.env` contains generated
credentials and is ignored by Git. The setup script refuses to replace it.

## Client migration

Set the Firecrawl base URL to `http://127.0.0.1:3002`. Do not send the paid
cloud API key; local database authentication is disabled.

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

```bash
docker compose ps
docker compose logs --tail=200 api playwright-service nuq-postgres redis rabbitmq
docker compose restart
docker compose down
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
docker compose exec -T playwright-service node -e "fetch('http://127.0.0.1:3000/health').then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(e => { console.error(e); process.exit(1); })"
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

Read the target release notes and inspect its Compose changes first. Replace
`vX.Y.Z` below with one exact release tag; do not merge a floating branch:

```bash
git fetch upstream tag vX.Y.Z
git rev-parse 'vX.Y.Z^{commit}'
git merge --no-commit --no-ff vX.Y.Z
git status
git diff --name-only --diff-filter=U
docker compose config --quiet
```

Inspect each conflict and preserve both upstream requirements and the local
loopback, durability, credential, and FoundationDB profile policy. Do not use
`--ours` or `--theirs` blindly. Re-run the dependency and smoke checks before
committing the upgrade.
