# Local Firecrawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Firecrawl v2.11.0 directly from this repository as a durable, loopback-only replacement for paid core API usage.

**Architecture:** Merge the official v2.11.0 tag into the existing repository root, preserving upstream history and the local design documents. A preferred `compose.yaml` includes upstream `docker-compose.yaml` plus a focused local override that restricts networking, disables FoundationDB by default, persists service data, and improves startup ordering.

**Tech Stack:** Firecrawl v2.11.0, Docker Engine 29.6.1, Docker Compose 5.3.0, Bash, OpenSSL, Redis, RabbitMQ, PostgreSQL 17 with pg_cron, Playwright

---

## File Map

- `docker-compose.yaml`: official v2.11.0 Compose definition; import unchanged.
- `compose.yaml`: preferred Compose entrypoint that includes upstream and local files.
- `compose.local.yaml`: local-only networking, profiles, health, restart, and volume policy.
- `.env.example.local`: safe committed template for required local values.
- `.env`: ignored generated credentials and runtime values.
- `scripts/init-local-env.sh`: idempotence-safe one-time credential generator.
- `LOCAL_DEPLOYMENT.md`: operator runbook and client migration guide.
- `docs/superpowers/specs/2026-07-15-local-firecrawl-design.md`: approved design.
- `docs/superpowers/plans/2026-07-15-local-firecrawl.md`: this plan.

No Firecrawl API source or automated test files are modified.

### Task 1: Import Firecrawl v2.11.0 into the repository root

**Files:**
- Import: all files tracked by official tag `v2.11.0`
- Preserve: `docs/superpowers/specs/2026-07-15-local-firecrawl-design.md`
- Preserve: `docs/superpowers/plans/2026-07-15-local-firecrawl.md`

- [ ] **Step 1: Confirm the local history and clean worktree**

Run:

```bash
git status --short --branch
git log -3 --oneline
```

Expected: branch `main`, no uncommitted files, and local design/plan commits at
the tip.

- [ ] **Step 2: Add and verify the official upstream remote**

Run:

```bash
git remote add upstream https://github.com/firecrawl/firecrawl.git
git fetch upstream tag v2.11.0
git rev-parse 'v2.11.0^{commit}'
```

Expected commit: `ef12eb36b2f3382838dfe0a0c1a5add3d5df7fe5`.

- [ ] **Step 3: Stage the upstream release as an explicit merge**

Run:

```bash
git merge --allow-unrelated-histories --no-commit --no-ff v2.11.0
test -f docker-compose.yaml
test -f AGENTS.md
test ! -d firecrawl
```

Expected: merge stops before commit; official source appears directly in the
repository root, with no nested `firecrawl/` directory.

- [ ] **Step 4: Read repository instructions and inspect the merge**

Run:

```bash
sed -n '1,240p' AGENTS.md
git status --short
git diff --cached --check
git config --get core.hooksPath
```

Expected: no whitespace errors or path conflicts. No API source is locally
modified; every added source file matches the official release parent.

- [ ] **Step 5: Commit the upstream import**

Run the active pre-commit runner if `core.hooksPath` or `.git/hooks/pre-commit`
configures one. Then run this bare commit command:

```bash
git commit -m "chore: import Firecrawl v2.11.0" -m "Merge the official Firecrawl v2.11.0 release directly into this
repository while preserving upstream history.

Keep local deployment documentation alongside the pinned source."
```

Expected: a merge commit with the official tag as one parent and local docs as
the other history.

### Task 2: Add secure local Compose configuration

**Files:**
- Create: `compose.yaml`
- Create: `compose.local.yaml`
- Create: `.env.example.local`
- Create: `scripts/init-local-env.sh`

- [ ] **Step 1: Create the preferred Compose entrypoint**

Create `compose.yaml`:

```yaml
include:
  - path:
      - docker-compose.yaml
      - compose.local.yaml
```

Docker Compose 5.3.0 supports `include` and selects `compose.yaml` before the
upstream legacy filename.

- [ ] **Step 2: Create the local Compose override**

Create `compose.local.yaml`:

```yaml
services:
  api:
    ports: !override
      - "127.0.0.1:${PORT:-3002}:${INTERNAL_PORT:-3002}"
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
      playwright-service:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
      nuq-postgres:
        condition: service_healthy

  playwright-service:
    restart: unless-stopped
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

  redis:
    command: redis-server --bind 0.0.0.0 --appendonly yes
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 12

  rabbitmq:
    restart: unless-stopped
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq

  nuq-postgres:
    restart: unless-stopped
    volumes:
      - nuq-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 20s

  foundationdb:
    profiles: ["foundationdb"]

  foundationdb-init:
    profiles: ["foundationdb"]

volumes:
  redis-data:
  rabbitmq-data:
  nuq-postgres-data:
```

`!override` replaces the upstream wildcard port mapping instead of appending a
second public mapping. FoundationDB remains available only with
`docker compose --profile foundationdb ...`.

- [ ] **Step 3: Create the safe environment template**

Create `.env.example.local`:

```dotenv
# Local-only Firecrawl API
PORT=3002
INTERNAL_PORT=3002
USE_DB_AUTHENTICATION=false

# Firecrawl v2.11.0 pins pg_cron to the postgres database.
POSTGRES_USER=firecrawl
POSTGRES_PASSWORD=GENERATED_BY_INIT_SCRIPT
POSTGRES_DB=postgres

# Protects /admin/<key>/queues even though the API is loopback-only.
BULL_AUTH_KEY=GENERATED_BY_INIT_SCRIPT

LOGGING_LEVEL=INFO
ALLOW_LOCAL_WEBHOOKS=false
BLOCK_MEDIA=false
```

- [ ] **Step 4: Create the one-time local environment generator**

Create executable `scripts/init-local-env.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/.env"

if [[ -e "${env_file}" ]]; then
  printf 'Refusing to overwrite existing %s\n' "${env_file}" >&2
  exit 1
fi

postgres_password="$(openssl rand -hex 32)"
bull_auth_key="$(openssl rand -hex 32)"

umask 077
{
  printf '%s\n' 'PORT=3002'
  printf '%s\n' 'INTERNAL_PORT=3002'
  printf '%s\n' 'USE_DB_AUTHENTICATION=false'
  printf '%s\n' 'POSTGRES_USER=firecrawl'
  printf '%s\n' "POSTGRES_PASSWORD=${postgres_password}"
  printf '%s\n' 'POSTGRES_DB=postgres'
  printf '%s\n' "BULL_AUTH_KEY=${bull_auth_key}"
  printf '%s\n' 'LOGGING_LEVEL=INFO'
  printf '%s\n' 'ALLOW_LOCAL_WEBHOOKS=false'
  printf '%s\n' 'BLOCK_MEDIA=false'
} > "${env_file}"

printf 'Created %s with mode 0600 credentials.\n' "${env_file}"
```

Run:

```bash
chmod +x scripts/init-local-env.sh
bash -n scripts/init-local-env.sh
./scripts/init-local-env.sh
stat -c '%a %n' .env
git check-ignore .env
```

Expected: `.env` mode `600`; Git reports `.env` as ignored. If `.env` already
exists, inspect and preserve it instead of overwriting it.

- [ ] **Step 5: Validate the merged Compose model without starting services**

Run:

```bash
docker compose config --quiet
docker compose config --profiles
docker compose config --services
docker compose config | rg -n 'host_ip: 127.0.0.1|published: "3002"|target: 3002'
```

Expected: profile list contains `foundationdb`; normal services are `api`,
`playwright-service`, `redis`, `rabbitmq`, and `nuq-postgres`; API port includes
`host_ip: 127.0.0.1`. Resolve every Compose warning or schema error before
continuing.

- [ ] **Step 6: Commit local runtime configuration**

Run:

```bash
git add compose.yaml compose.local.yaml .env.example.local scripts/init-local-env.sh
git diff --cached --check
```

Run the active hook runner, re-stage formatter changes if any, then commit:

```bash
git commit -m "feat: configure secure local Firecrawl runtime" -m "Add a loopback-only Compose entrypoint with durable service volumes,
dependency health checks, restart policies, and opt-in FoundationDB.

Generate ignored local credentials without overwriting existing secrets."
```

### Task 3: Add the local operator runbook

**Files:**
- Create: `LOCAL_DEPLOYMENT.md`

- [ ] **Step 1: Write the runbook**

Create `LOCAL_DEPLOYMENT.md` with these complete sections and commands:

````markdown
# Local Firecrawl

This repository runs Firecrawl v2.11.0 for applications on this host. Only
`127.0.0.1:3002` is published. Redis, RabbitMQ, PostgreSQL, and Playwright stay
inside the Docker network.

## First start

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

Python:

```python
from firecrawl import Firecrawl

firecrawl = Firecrawl(api_url="http://127.0.0.1:3002")
```

Both current SDKs also recognize `FIRECRAWL_API_URL`.

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

Queue administration is available at
`http://127.0.0.1:3002/admin/BULL_AUTH_KEY/queues`; read `BULL_AUTH_KEY` from
`.env` locally and do not commit it.

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

Read the target release notes and inspect its Compose changes first. Then fetch
and merge the exact tag without choosing either conflict side blindly:

```bash
git fetch upstream tag vNEXT
git merge --no-commit --no-ff vNEXT
git status
docker compose config --quiet
```

Resolve conflicts by preserving both upstream requirements and the local
loopback/durability policy. Run smoke checks before committing the upgrade.
````

- [ ] **Step 2: Verify runbook commands and SDK option names**

Run:

```bash
rg -n 'apiUrl|api_url|FIRECRAWL_API_URL' apps/js-sdk apps/python-sdk | head -40
docker compose config --quiet
git diff --check
```

Expected: v2.11.0 SDK source confirms `apiUrl`, `api_url`, and
`FIRECRAWL_API_URL`; documented Compose commands parse successfully.

- [ ] **Step 3: Commit the runbook**

Run:

```bash
git add LOCAL_DEPLOYMENT.md
git diff --cached --check
```

Run the active hook runner, then commit:

```bash
git commit -m "docs: add local Firecrawl operations guide" -m "Document first startup, host client migration, health checks, scoped
troubleshooting, safe shutdown, and deliberate upstream upgrades.

Include real v2 scrape and crawl commands for functional verification."
```

### Task 4: Build and start the local stack

**Files:**
- Generate but do not commit: `.env`
- Create Docker images, containers, network, and named volumes managed by the
  `firecrawl` Compose project

- [ ] **Step 1: Reconfirm host safety before container changes**

Run:

```bash
docker compose config --quiet
docker compose ps -a
ss -ltn '( sport = :3002 )'
```

Expected: Compose is valid, no existing Firecrawl project containers need
preservation, and host port `3002` is unused.

- [ ] **Step 2: Build and start the normal profile**

Run:

```bash
docker compose up -d --build
```

Expected: source images build; `api`, `playwright-service`, `redis`,
`rabbitmq`, and `nuq-postgres` start. Do not run broad prune or unrelated
container commands.

- [ ] **Step 3: Inspect service state and logs**

Run:

```bash
docker compose ps
docker compose logs --tail=200 api playwright-service nuq-postgres redis rabbitmq
```

Expected: no FoundationDB containers, no restart loops, and dependencies become
healthy. Warnings about bypassed Supabase authentication are expected for the
official self-host configuration; connection errors are not.

- [ ] **Step 4: Verify each dependency**

Run:

```bash
docker compose exec -T redis redis-cli ping
docker compose exec -T rabbitmq rabbitmq-diagnostics -q check_running
docker compose exec -T nuq-postgres pg_isready -U firecrawl -d postgres
docker compose exec -T playwright-service node -e "fetch('http://127.0.0.1:3000/health').then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(e => { console.error(e); process.exit(1); })"
```

Expected: `PONG`, RabbitMQ exit status 0, PostgreSQL accepting connections, and
Playwright HTTP 200 with a healthy payload.

- [ ] **Step 5: Verify host publication**

Run:

```bash
docker compose port api 3002
ss -ltn '( sport = :3002 )'
```

Expected: only `127.0.0.1:3002`; no `0.0.0.0:3002` or `[::]:3002` listener.

### Task 5: Prove the v2 API and restart behavior

**Files:**
- No source files changed

- [ ] **Step 1: Run a real scrape**

Run:

```bash
curl --fail-with-body -sS -X POST http://127.0.0.1:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

Expected: HTTP success JSON with `success: true` and non-empty markdown for
Example Domain.

- [ ] **Step 2: Start and poll a bounded crawl**

Run:

```bash
curl --fail-with-body -sS -X POST http://127.0.0.1:3002/v2/crawl \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://docs.firecrawl.dev","limit":2}'
curl --fail-with-body -sS http://127.0.0.1:3002/v2/crawl/CRAWL_ID
```

Replace `CRAWL_ID` with the returned identifier. Expected: accepted crawl,
then `scraping` or `completed`; poll until `completed` and confirm at least one
document.

- [ ] **Step 3: Verify restart recovery without deleting volumes**

Run:

```bash
docker compose restart
docker compose ps
docker compose exec -T redis redis-cli ping
curl --fail-with-body -sS -X POST http://127.0.0.1:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

Expected: dependencies return healthy and the API succeeds after restart.

- [ ] **Step 4: Run final repository and runtime checks**

Run:

```bash
git status --short --branch
git log --oneline --decorate -6
docker compose config --quiet
docker compose ps
docker compose logs --tail=100 api playwright-service nuq-postgres redis rabbitmq
```

Expected: clean tracked worktree, ignored `.env`, all normal-profile services
running without error loops, functional API evidence captured, and no pending
work. Do not commit `.env` or runtime output.
