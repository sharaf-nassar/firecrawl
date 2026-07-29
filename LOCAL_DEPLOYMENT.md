# Local Firecrawl

This checkout runs Firecrawl through Docker Compose. Only
`http://127.0.0.1:3002` is published. Redis, RabbitMQ, PostgreSQL, MinIO,
Playwright, Browser Service, and the Codex-backed browser interaction worker
remain private to Compose.

The deployment stores:

- queue state in `nuq-postgres-data`, `redis-data`, and `rabbitmq-data`;
- application records in `app-postgres-data`;
- artifacts in `minio-data`;
- browser state in `browser-state`;
- worker-owned Codex auth state in `codex-auth-state`;
- the private API/worker Unix socket in `browser-interaction-socket`.

Lifecycle commands preserve every named volume.

## First start

Check whether another checkout already owns the `firecrawl` Compose project:

```bash
scripts/local-firecrawl status
docker volume ls --filter label=com.docker.compose.project=firecrawl
```

Stop if either command shows unexpected resources. Identify their owner and
data before continuing. Never delete volumes as a discovery or recovery step.

For a new deployment without `.env`:

```bash
./scripts/init-local-env.sh &&
  scripts/local-firecrawl start &&
  scripts/local-firecrawl health
```

`.env` contains generated credentials, uses mode `0600`, and is ignored by
Git. The initialization script refuses to overwrite it.

For an existing `.env`, audit it against `.env.example.local`. Preserve all
credentials and `LOCAL_OWNER_ID`. Then run:

```bash
scripts/upgrade-local-env-phase1 &&
  scripts/upgrade-local-env-phase1 --check &&
  scripts/local-firecrawl restart &&
  scripts/local-firecrawl health
```

Browser settings required by the local Compose deployment are:

```dotenv
LOCAL_BROWSER_SERVICE_ENABLED=true
LOCAL_BROWSER_STATE_ROOT=/var/lib/firecrawl-browser-volume/state
MAX_BROWSER_SESSIONS=4
BROWSER_PUBLIC_API_ORIGIN=http://127.0.0.1:3002
```

`BROWSER_SERVICE_API_KEY` must be a 32-byte base64url secret (43 characters)
and remain distinct from `BROWSER_REPLAY_INGEST_API_KEY`.
`BROWSER_INTERACTION_WORKER_TOKEN` is a third, distinct 32-byte base64url
secret shared only by the API and interaction worker.
`scripts/init-local-env.sh` generates all three. The upgrade script replaces
only missing or legacy disabled/hex browser-service settings and preserves
already-valid secrets.

The interaction worker uses the active local `@openai/codex` installation and
the current user's `~/.codex/auth.json`. Before `start`, `restart`, or
`health`, ensure `codex` resolves on `PATH` and local Codex authentication is
configured. `stop`, `status`, and `logs` remain available while Codex is
missing, upgrading, or being reauthenticated. Recovery commands validate the
existing Compose project identity and interaction-worker mount shape without
resolving new host mount sources. Do not add Codex installation or auth paths
to `.env`.

The worker mounts the host CA bundle read-only and uses it for Codex and Node
TLS. The default is `/etc/ssl/certs/ca-certificates.crt`. To use another
readable, nonempty PEM bundle, export its absolute path before lifecycle
commands:

```bash
export LOCAL_FIRECRAWL_CA_BUNDLE_FILE=/path/to/ca-bundle.pem
scripts/local-firecrawl restart
```

## Clients and MCP

Use `http://127.0.0.1:3002` as Firecrawl base URL. Do not send the paid cloud
API key. Local API authentication is disabled by
`USE_DB_AUTHENTICATION=false`.

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

Claude Code and Codex MCP configurations must point Firecrawl MCP at:

```text
FIRECRAWL_API_URL=http://127.0.0.1:3002
```

Do not set `FIRECRAWL_API_KEY` for this local endpoint. Restart each MCP client
after changing its configuration so it creates a fresh MCP process.

## Routine operation

Use the path-independent lifecycle wrapper:

```bash
scripts/local-firecrawl start
scripts/local-firecrawl stop
scripts/local-firecrawl restart
scripts/local-firecrawl status
scripts/local-firecrawl status --json
scripts/local-firecrawl health
scripts/local-firecrawl health --json
scripts/local-firecrawl logs
scripts/local-firecrawl logs api
scripts/local-firecrawl logs browser-service
scripts/local-firecrawl logs browser-interaction-worker
```

The wrapper:

- serializes lifecycle work with a per-user lock;
- validates Compose configuration and loopback-only port policy;
- resolves the active local `@openai/codex` package and auth file without
  executing Codex or persisting installation paths;
- builds local API, Browser Service, and interaction worker images before
  start or restart;
- initializes browser state;
- starts durable dependencies;
- runs `app-db-migrate` and `minio-init` as bounded one-shots;
- starts Browser Service, interaction worker, and API only after
  initialization succeeds;
- reports bounded, redacted Compose logs.

One-shots use
`LOCAL_FIRECRAWL_ONE_SHOT_TIMEOUT_SECONDS` (default `300`). Failures report
whether start or wait timed out, inspect final container state, and clean up
only the exact failed container. The lifecycle lock waits for
`LOCAL_FIRECRAWL_LOCK_WAIT_SECONDS` (default `30`).

The wrapper passes only `compose.yaml`; that root file includes
`docker-compose.yaml` and `compose.local.yaml`. An optional canonical
`LOCAL_FIRECRAWL_COMPOSE_OVERRIDE` is appended explicitly.

`start` and `restart` recognize containers labeled with the previous
`compose.yaml,compose.local.yaml` source pair and replace them with the
canonical root-Compose configuration. Recovery commands may stop or inspect
that exact legacy deployment. New containers must carry the canonical
`compose.yaml` source label. Unknown Compose provenance fails closed.

`stop` orders API, interaction worker, and Browser Service before
dependencies. It does not remove containers or volumes. Never use
`docker compose down --volumes` as a recovery experiment.

## Local Codex interaction worker

The worker has no TCP listener or exposed port. It listens only on
`/run/firecrawl-interaction/worker.sock` in the
`browser-interaction-socket` named volume. The API mounts that volume
read-only and connects with Node's Unix-socket HTTP transport. The socket
directory is mode `0770`, the socket is mode `0660`, and both are owned by the
worker UID/GID. The API receives only that GID for socket access.

The API and worker share no Compose network. The API joins only `backend`; the
worker uses `network_mode: none`, so it has loopback but no Docker interface,
embedded DNS, host/LAN route, or public route. The worker receives no backend
service DNS, browser/DB/MinIO credentials, Docker socket, host repository,
browser state, or API mutation credential.

Codex receives fixed `HTTP_PROXY` and `HTTPS_PROXY` values pointing at a
loopback TCP relay. The relay copies bytes to
`/run/firecrawl-model-egress/proxy.sock` in a named volume shared only with
`browser-interaction-egress-proxy`. That proxy is the sole member of the
ordinary `model-uplink` bridge. It has no published port, backend network,
Docker socket, Codex auth, CA mount, or application secret.

The proxy accepts only `CONNECT` to port `443`. It allows the `openai.com` and
`chatgpt.com` apexes and their label-boundary subdomains. It rejects IP
literals, every non-allowlisted hostname, and any DNS answer set containing a
private, loopback, link-local, carrier-grade NAT, multicast, reserved, or
documentation address. It connects to a validated numeric address, verifies
the peer address, then requires a bounded TLS ClientHello whose SNI matches
the CONNECT hostname. TLS remains end-to-end between Codex and OpenAI; the
proxy does not install a CA or intercept model/auth content.

Interact reports deterministic model-protocol and action-limit failures as
HTTP `422`, so SDK clients do not retry the same failed browser session.
Capacity exhaustion remains HTTP `429`; interaction-adapter protocol failures
remain retryable HTTP `502`. Public responses contain sanitized error messages,
while server logs retain the internal failure category.

The worker preserves the caller's absolute 1-300 second run deadline. It
reserves one quarter of the run, bounded to 15-30 seconds, for a final-only
model turn that must return the best available result and disclose missing
details. With 5 seconds or less remaining it fails deterministically as timed
out instead of starting work that can overrun the hard deadline. The 25-action
limit remains unchanged.

For tooltip-heavy pages, the worker can request one read-only `hover_batch`
action with 1-16 unique refs from the current observation. Browser Service
prevalidates every retained element before moving the pointer, hovers targets
sequentially within an 8-second phase, and returns at most 1,024 UTF-8 bytes
of newly visible or changed generic DOM text per ref. One batch consumes one
action and exact action-cache replay never dispatches pointer movement again.

Allowing all subdomains of the two OpenAI-owned apexes is intentionally broader
than an exact endpoint list. It tolerates endpoint changes when the active
local Codex package is upgraded while still failing closed for other domains.
OpenAI does not publish a permanent exhaustive Codex firewall contract. A
future Codex transport that changes domains or hides SNI with ECH will fail
closed until the policy is reviewed; the allowlist never expands
automatically.

Start, restart, and health validation resolve every `codex` executable visible
on `PATH`, canonicalize symlinks, and require all results to identify one
`@openai/codex` package entrypoint. The package is mounted read-only at
`/opt/codex`; canonical `~/.codex/auth.json` is mounted read-only at
`/run/secrets/codex-auth.json`; the resolved host CA bundle is mounted
read-only at `/run/certs/host-ca-certificates.crt`. `CODEX_CA_CERTIFICATE`,
`SSL_CERT_FILE`, and `NODE_EXTRA_CA_CERTS` all reference that fixed path.
Missing or distinct installations and missing or empty CA bundles fail before
Compose changes runtime state. Compose validation rejects a missing,
writeable, or substituted CA mount.

The host auth file is only a seed. The worker stores its writable auth state
in the `codex-auth-state` named volume and records the digest of the host seed
used to create it. An unchanged host digest preserves worker-refreshed tokens;
a changed digest replaces worker auth on the next bounded decision or worker
startup. Codex decisions are serialized around this shared auth state so token
refreshes cannot race. Auth never writes back to the host.

The worker runs as UID/GID `1000`, with a read-only root filesystem, all Linux
capabilities dropped, `no-new-privileges`, bounded processes/CPU/memory, and
tmpfs-backed `/tmp` and `CODEX_HOME`. Session data, output, hooks, and config
remain ephemeral; only worker auth state persists. It receives no Docker
socket, repository, browser-state, database, Browser Service credential,
replay credential, or API mutation credential.

Startup removes only an existing worker-owned socket at the fixed path and
rejects symlinks, non-sockets, or mismatched ownership. Shutdown removes only
the same socket inode created by that worker. The in-container healthcheck and
the lifecycle health command query readiness through the Unix socket.

No Codex version, model, or reasoning effort is pinned. After upgrading the
active local Codex installation, restart Firecrawl:

```bash
scripts/local-firecrawl restart
scripts/local-firecrawl health
```

The restart resolves and mounts the upgraded active package.

Inspect the allow/deny path without exposing credentials:

```bash
scripts/local-firecrawl probe-egress
```

The probe expects CONNECT success for `api.openai.com` and `chatgpt.com`, and
policy denial for `example.com` and the link-local metadata IP literal.

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

Poll its returned identifier:

```bash
curl --fail-with-body -sS http://127.0.0.1:3002/v2/crawl/CRAWL_ID
```

## Application migrations

`app-db-migrate` runs before API startup and shares the `backend` network with
`app-postgres`. Migration filenames are applied in lexical order.

`application_schema_migrations` records each filename and SHA-256 checksum.
Startup fails if an applied file disappears, its checksum changes, a stored
checksum is missing, or a pending migration fails. Never edit an applied
migration. Add a lexically later migration.

`health` requires the latest ledger filename and checksum to match the latest
checked-in migration. `status` must show `app-db-migrate` as exited with status
`0`.

## Persistence and retention

`LOCAL_RECORD_RETENTION_DAYS` and `LOCAL_ARTIFACT_RETENTION_DAYS` default to
`30` and must be positive integers. The API removes expired MinIO objects and
their manifests before cleaning expired operational rows. Failed artifact
deletes remain retryable.

`LOCAL_OWNER_ID` provides stable local ownership across restarts. Preserve it
with `app-postgres-data`; rotating it disconnects existing records from their
owner.

Preserve all named volumes during upgrades and recovery. Use service-aware
database dumps or a consistent stopped-volume snapshot for external disaster
recovery. Verify restoration separately before relying on it.

MinIO server and client images use exact releases because their data format
and maintenance status need deliberate review. Never change those tags without
checking compatibility and validating recovery from an independent copy.

## Queue administration

Queue administration is available at:

```text
http://127.0.0.1:3002/admin/BULL_AUTH_KEY/queues
```

Read `BULL_AUTH_KEY` from `.env` locally and replace the placeholder. Never
commit or paste the value.

## Health and troubleshooting

`scripts/local-firecrawl health` checks:

- Redis and RabbitMQ;
- queue and application PostgreSQL;
- migration ledger filename and checksum;
- Browser Service and Playwright;
- Codex-backed browser interaction worker readiness;
- MinIO and application artifact credentials;
- API response;
- exact loopback port publication.

Use this recovery sequence:

```bash
scripts/local-firecrawl status
scripts/local-firecrawl health
scripts/local-firecrawl logs
scripts/local-firecrawl restart
scripts/local-firecrawl health
```

If restart stops before API startup, keep the stopped state and inspect
one-shot logs. Do not delete volumes when migrations, MinIO, or provenance
checks fail.

Self-hosting does not include Fire-engine or managed proxy rotation. A target
that works through Firecrawl Cloud may block this machine's direct IP.
Configure `PROXY_SERVER`, `PROXY_USERNAME`, and `PROXY_PASSWORD` only when a
real target demonstrates that need.

## Upgrade

Review target release notes and Compose changes. Record current containers and
volumes before changing source:

```bash
git status --porcelain
scripts/local-firecrawl status
docker volume ls --filter label=com.docker.compose.project=firecrawl
```

Preserve current volumes and release until the upgrade passes:

```bash
scripts/local-firecrawl restart
scripts/local-firecrawl status
scripts/local-firecrawl health
```

Repeat scrape and crawl smoke checks. Inspect merge conflicts individually;
never use `--ours` or `--theirs` blindly.
