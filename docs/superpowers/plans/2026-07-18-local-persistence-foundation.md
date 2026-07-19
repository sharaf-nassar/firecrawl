# Local Persistence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the keyless loopback Firecrawl runtime durable application records and artifacts without enabling hosted authentication, so later Browser, monitoring, Agent, and research phases have a reliable local foundation.

**Architecture:** Keep `USE_DB_AUTHENTICATION=false`, derive one stable UUID owner for local requests, and initialize Drizzle from a separate `app-postgres` connection whenever local persistence is enabled. Apply checked-in SQL migrations through a one-shot Compose service before API startup. Store job artifacts behind a provider-neutral interface implemented by pinned MinIO, and run one idempotent local retention worker. Keep NuQ PostgreSQL, hosted auth/billing behavior, and later-phase schemas separate.

**Tech Stack:** TypeScript, Node.js 22, PostgreSQL 17, Drizzle ORM, `pg`, MinIO, `minio@8.0.7`, Docker Compose v5, Vitest, Bash

---

## Scope and Phase Boundary

This phase delivers:

- Durable `requests` and operational job rows under a stable local owner.
- Versioned, restart-safe application migrations.
- Durable MinIO artifacts through a typed storage interface.
- Local record/artifact retention without hosted Supabase RPCs.
- Ordered startup, health checks, backups, and restart verification.

This phase deliberately does not enable Browser Service, Interact, feedback,
monitoring, Agent, or research tools. Their tables and workers arrive with
their owning phases. Do not copy the entire hosted `public.ts` schema into the
local migration. Exclude auth, billing, ledger, index, blocklist, Browser,
monitor, feedback, Agent, and research-cache/service tables.

MinIO's upstream repository and official image stream were archived in 2026.
The approved design still selects MinIO, so this phase pins the final official
image line instead of using `latest` and documents replacement as a future
architecture decision.

## File Structure

### Create

- `apps/api/src/lib/local-runtime-config.ts`: pure local persistence,
  identity, storage, and retention validation.
- `apps/api/src/lib/local-runtime-config.test.ts`: configuration contract.
- `apps/api/src/lib/local-owner.ts`: stable local owner selection.
- `apps/api/src/lib/local-owner.test.ts`: auth-off identity behavior.
- `apps/api/src/db/application-config.ts`: hosted/local DB URL resolver.
- `apps/api/src/db/application-config.test.ts`: DB selection tests.
- `apps/api/src/db/migrate.ts`: advisory-locked SQL migration runner.
- `apps/api/src/db/migrate.integration.test.ts`: migration idempotency and
  baseline schema contract.
- `apps/api/src/db/migrations/0001_persistence_foundation.sql`: migration
  ledger, local owner, artifact manifest, operational job tables, and indexes.
- `apps/api/src/lib/artifacts/types.ts`: artifact store contract.
- `apps/api/src/lib/artifacts/minio.ts`: MinIO implementation.
- `apps/api/src/lib/artifacts/gcs.ts`: existing GCS behavior adapter.
- `apps/api/src/lib/artifacts/index.ts`: provider selection and health.
- `apps/api/src/lib/artifacts/artifact-store.test.ts`: provider-neutral
  contract using an in-memory test double.
- `apps/api/src/lib/artifacts/minio.integration.test.ts`: real MinIO service
  contract.
- `apps/api/src/services/local-retention-worker.ts`: bounded idempotent cleanup.
- `apps/api/src/services/local-retention-worker.test.ts`: retention behavior.
- `apps/api/src/cli/artifact-health.ts`: authenticated bucket health command.
- `apps/api/config/minio-artifact-policy.json`: least-privilege bucket policy.
- `apps/api/src/__tests__/snips/v2/local-persistence.test.ts`: live keyless
  scrape persistence test.
- `scripts/upgrade-local-env-phase1`: idempotently add Phase 1 secrets to the
  existing local `.env`.

### Modify

- `apps/api/src/config.ts`: typed local runtime settings.
- `apps/api/src/controllers/auth.ts`: stable owner when auth is off and local
  persistence is on.
- `apps/api/src/db/connection.ts`: initialize application DB independently of
  authentication.
- `apps/api/src/services/logging/log_job.ts`: persist local operational rows
  and route artifacts through the abstraction.
- `apps/api/src/lib/gcs-jobs.ts`: preserve public exports while delegating job
  blobs to the artifact store.
- `apps/api/src/lib/gcs-monitoring.ts`: preserve exports and use artifact store.
- `apps/api/src/lib/gcs-pdf-cache.ts`: preserve exports and use artifact store.
- `apps/api/src/harness.ts`: start the retention worker and provision test
  dependencies only when local persistence is enabled.
- `apps/api/src/services/logging/log_job.test.ts`: local persistence gates.
- `apps/api/package.json`: MinIO dependency, migration, focused test, and
  artifact health scripts.
- `apps/api/pnpm-lock.yaml`: dependency lock.
- `apps/api/Dockerfile`: copy SQL migrations and MinIO policy into runtime.
- `compose.local.yaml`: application DB, migrator, MinIO, initializer, API
  environment/dependencies, health checks, and volumes.
- `scripts/init-local-env.sh`: generate complete Phase 1 configuration for
  new installs.
- `scripts/local-firecrawl`: manage and diagnose the expanded runtime.
- `LOCAL_DEPLOYMENT.md`: persistence, backup, retention, and archived MinIO
  risk.
- `.env` locally through `scripts/upgrade-local-env-phase1`; never commit it.

## Task 1: Define and test local runtime configuration

**Files:**
- Create: `apps/api/src/lib/local-runtime-config.ts`
- Create: `apps/api/src/lib/local-runtime-config.test.ts`
- Modify: `apps/api/src/config.ts`

- [ ] **Step 1: Write failing configuration tests**

Cover these exact cases:

```ts
describe("resolveLocalRuntimeConfig", () => {
  it("leaves persistence disabled without local settings", () => {});
  it("requires an application database URL when enabled", () => {});
  it("requires a UUID local owner when enabled", () => {});
  it("rejects local persistence with database authentication", () => {});
  it("requires every MinIO setting when provider is minio", () => {});
  it("accepts positive record and artifact retention days", () => {});
});
```

The resolver must return a discriminated union. Disabled mode contains only
`enabled: false`. Enabled mode contains a parsed DB URL, UUID owner, retention
durations, and either `artifactProvider: "none"` or complete MinIO settings.

- [ ] **Step 2: Run the focused test and confirm red**

```bash
cd apps/api
pnpm vitest run src/lib/local-runtime-config.test.ts
```

Expected: failure because the resolver and configuration keys do not exist.

- [ ] **Step 3: Add primitive environment fields to `config.ts`**

Add:

```ts
LOCAL_PERSISTENCE_ENABLED: z.stringbool().default(false),
APPLICATION_DATABASE_URL: emptyStringAsUndefined(z.string().url()),
LOCAL_OWNER_ID: emptyStringAsUndefined(z.string().uuid()),
ARTIFACT_STORE_PROVIDER: emptyStringAsDefault(
  z.enum(["none", "minio", "gcs"]).default("none"),
),
ARTIFACT_MINIO_ENDPOINT: emptyStringAsUndefined(z.string().url()),
ARTIFACT_MINIO_ACCESS_KEY: emptyStringAsUndefined(z.string()),
ARTIFACT_MINIO_SECRET_KEY: emptyStringAsUndefined(z.string()),
ARTIFACT_MINIO_BUCKET: emptyStringAsUndefined(z.string()),
ARTIFACT_MINIO_REGION: emptyStringAsDefault(z.string().default("us-east-1")),
LOCAL_RECORD_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
LOCAL_ARTIFACT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
```

Keep cross-field validation in the pure resolver so tests do not need to
reload the process-global config module. Fail startup with one clear list of
missing/conflicting keys; never silently disable a requested provider.

- [ ] **Step 4: Implement the resolver and make tests green**

Use specific `LocalRuntimeConfigurationError` errors. Do not catch or rewrite
unexpected Zod/programming errors.

```bash
pnpm vitest run src/lib/local-runtime-config.test.ts
```

Expected: all six tests pass.

- [ ] **Step 5: Commit configuration contract**

```bash
git add apps/api/src/config.ts apps/api/src/lib/local-runtime-config.ts apps/api/src/lib/local-runtime-config.test.ts
git commit -m "feat: define local persistence configuration" -m "Add validated local database, owner, artifact, and retention settings
without coupling persistence to hosted authentication.

Cover disabled, incomplete, conflicting, and valid runtime settings with
focused configuration tests."
```

## Task 2: Provide stable local identity and application DB selection

**Files:**
- Create: `apps/api/src/lib/local-owner.ts`
- Create: `apps/api/src/lib/local-owner.test.ts`
- Create: `apps/api/src/db/application-config.ts`
- Create: `apps/api/src/db/application-config.test.ts`
- Modify: `apps/api/src/controllers/auth.ts`
- Modify: `apps/api/src/db/connection.ts`

- [ ] **Step 1: Write failing pure resolver tests**

Assert:

- Hosted auth selects `DATABASE_URL` and `DATABASE_REPLICA_URL`.
- Local persistence with auth off selects `APPLICATION_DATABASE_URL` for both
  writer and reader.
- Legacy auth-off mode creates no app DB client.
- Index DB selection remains unchanged.
- Local persistence returns `LOCAL_OWNER_ID`; legacy auth-off returns
  `"bypass"`; hosted auth delegates to `supaAuthenticateUser`.

```bash
cd apps/api
pnpm vitest run src/db/application-config.test.ts src/lib/local-owner.test.ts
```

Expected: red because helpers do not exist.

- [ ] **Step 2: Implement DB connection selection**

Export these pure functions from `application-config.ts`:

```ts
resolveApplicationDatabaseConfig(input): {
  enabled: boolean;
  writerUrl?: string;
  readerUrl?: string;
  applicationName: "firecrawl-api" | "firecrawl-api-local";
}
isApplicationPersistenceEnabled(): boolean
```

Update `connection.ts` to build `mainDb` and `replicaDb` from the resolver.
Do not change `indexDb`. Change the startup diagnostic to name the missing
setting (`DATABASE_URL` or `APPLICATION_DATABASE_URL`).

- [ ] **Step 3: Implement one local owner helper**

Use one helper for all auth-off identity construction. In
`authenticateUser`, preserve current `withAuth` warning behavior, but return
`LOCAL_OWNER_ID` only when local persistence is enabled. Do not change keyless
rate limiting, credit bypass, hosted auth, or `ensureChunkOrgId`.

- [ ] **Step 4: Run focused tests and build**

```bash
pnpm vitest run src/db/application-config.test.ts src/lib/local-owner.test.ts
pnpm build
```

Expected: tests pass and TypeScript builds.

- [ ] **Step 5: Commit identity and connection separation**

```bash
git add apps/api/src/controllers/auth.ts apps/api/src/db/application-config.ts apps/api/src/db/application-config.test.ts apps/api/src/db/connection.ts apps/api/src/lib/local-owner.ts apps/api/src/lib/local-owner.test.ts
git commit -m "feat: decouple persistence from authentication" -m "Initialize the application database for validated local persistence and
map auth-off requests to one durable UUID owner.

Preserve hosted database selection, index storage, keyless behavior, and
the legacy bypass identity when local persistence is disabled."
```

## Task 3: Add versioned local application migrations

**Files:**
- Create: `apps/api/src/db/migrate.ts`
- Create: `apps/api/src/db/migrate.integration.test.ts`
- Create: `apps/api/src/db/migrations/0001_persistence_foundation.sql`
- Modify: `apps/api/package.json`
- Modify: `apps/api/Dockerfile`

- [ ] **Step 1: Write the failing migration integration test**

Against a disposable PostgreSQL URL, execute the runner twice and assert:

- `application_schema_migrations` contains exactly one row for migration 0001.
- `local_owners` contains the configured `LOCAL_OWNER_ID` once.
- A `requests` row and matching `scrapes` row accept UUID owner/request IDs.
- All 15 `log_job.tableMap` targets exist.
- Required cache/webhook tables exist.
- A failed migration rolls back and is not added to the ledger.

Skip only when `TEST_APPLICATION_DATABASE_URL` is absent; the Compose
integration task must supply it.

```bash
cd apps/api
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:test@127.0.0.1:55433/firecrawl pnpm vitest run src/db/migrate.integration.test.ts
```

Expected: red because the runner/migration do not exist.

- [ ] **Step 2: Implement the migration runner with existing `pg`**

Do not add Drizzle Kit. The runner must:

1. Validate local runtime configuration.
2. Open a `pg.Client` using `APPLICATION_DATABASE_URL`.
3. Acquire one PostgreSQL advisory lock dedicated to Firecrawl migrations.
4. Create `application_schema_migrations(filename text primary key,
   applied_at timestamptz not null default now())`.
5. Read sorted `NNNN_*.sql` files from the runtime migration directory.
6. Apply each pending file and ledger insert in one transaction.
7. Seed `local_owners(id, label)` with `LOCAL_OWNER_ID, 'local'` using
   `ON CONFLICT DO NOTHING`.
8. Always release the advisory lock and close the client.

Export `runApplicationMigrations` for tests; execute it only when the module is
the CLI entrypoint. Add package scripts:

```json
"db:migrate": "tsx src/db/migrate.ts",
"db:migrate:production": "node dist/src/db/migrate.js"
```

- [ ] **Step 3: Write the baseline SQL migration**

Mirror exact column types/defaults from `src/db/schema/public.ts` for:

- Foundation: `local_owners`, `local_artifacts`.
- Operational: `requests`, `scrapes`, `parses`, `crawls`, `batch_scrapes`,
  `searches`, `extracts`, `maps`, `llmstxts`, `deep_researches`.
- Existing endpoint logs: `research_paper_searches`,
  `research_paper_inspects`, `research_paper_reads`,
  `research_related_papers`, `research_github_searches`.
- Ungated direct consumers: `idempotency_keys`,
  `deterministic_json_scripts`, `deterministic_json_llm_cache`,
  `webhook_logs`.

Add primary keys on IDs/object keys, unique constraints matching the Drizzle
schema, and indexes for:

```sql
requests (team_id, created_at desc)
requests (dr_clean_by) where dr_clean_by is not null
local_artifacts (delete_after) where delete_after is not null
local_artifacts (owner_id, created_at desc)
each job table (request_id)
each job table (team_id, created_at desc)
```

Do not add foreign keys from job rows to `requests`: logging is asynchronous
and completion may race the request insert. Do not create hosted RPCs.

**Acceptance amendment (2026-07-18):** Preserve the requirement above as the
original design history, but use request foreign keys safely. A lexically
earlier migration creates bounded, metadata-free placeholder requests before
the immutable foreign-key migrations run. It also installs `BEFORE INSERT`
triggers on all 14 operational child tables so a child-first asynchronous log
write creates its placeholder atomically. Local `logRequest` uses
`ON CONFLICT DO UPDATE` to replace that placeholder with real request metadata
and the configured deadline; hosted inserts keep their prior behavior.
Abandoned placeholders expire within 24 hours, allowing normal retention to
remove them and their dependent rows without deleting valid child-first data
during migration.

**Acceptance amendment (2026-07-18, follow-up):** Restrict the local upsert to
rows whose existing `kind` is `async_placeholder`; a duplicate real request
therefore remains unchanged. A new forward-only migration propagates the real
request deadline to resolved webhook logs only on the placeholder-to-real
kind transition. Later updates to already-real requests do not rewrite webhook
retention. The existing webhook assignment trigger resolves each propagated
deadline from the newly updated request row.

- [ ] **Step 4: Copy migrations into the runtime image**

Add a Dockerfile copy after built application files:

```dockerfile
COPY --from=build /app/apps/api/src/db/migrations ./dist/src/db/migrations
```

Make path resolution work in both TS source and compiled runtime.

- [ ] **Step 5: Run migration integration and build**

Start only a disposable Postgres container through the integration profile
defined in Task 4, then run:

```bash
cd apps/api
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:test@127.0.0.1:55433/firecrawl pnpm vitest run src/db/migrate.integration.test.ts
pnpm build
```

Expected: idempotency, rollback, owner seed, inserts, and build pass.

- [ ] **Step 6: Commit migration foundation**

```bash
git add apps/api/Dockerfile apps/api/package.json apps/api/src/db/migrate.ts apps/api/src/db/migrate.integration.test.ts apps/api/src/db/migrations/0001_persistence_foundation.sql
git commit -m "feat: add local application migrations" -m "Apply an advisory-locked, versioned operational schema before local API
startup and seed the stable local owner idempotently.

Keep queue, hosted auth and billing, index, and later-phase schemas outside
the local application database."
```

## Task 4: Add app-postgres and ordered migration startup

**Files:**
- Modify: `compose.local.yaml`
- Modify: `scripts/init-local-env.sh`
- Create: `scripts/upgrade-local-env-phase1`
- Modify: `.env` locally; do not stage

- [ ] **Step 1: Add app-postgres and one-shot migrator**

Use `postgres:17.10-bookworm`, backend network only, a named
`app-postgres-data` volume, `restart: unless-stopped`, and:

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
  interval: 5s
  timeout: 5s
  retries: 20
  start_period: 20s
```

Add `app-db-migrate` from the API image with
`node dist/src/db/migrate.js`, `restart: "no"`, and
`app-postgres: condition: service_healthy`. Make `api` depend on
`app-db-migrate: condition: service_completed_successfully`.

Use separate `APP_POSTGRES_*` credentials and this internal URL:

```text
postgresql://${APP_POSTGRES_USER}:${APP_POSTGRES_PASSWORD}@app-postgres:5432/${APP_POSTGRES_DB}
```

Do not reuse NuQ variables or volume.

- [ ] **Step 2: Extend environment generation safely**

For new installs, generate with existing `openssl` plus Node's built-in
`crypto.randomUUID()`:

- Distinct 32-byte app PostgreSQL password.
- Stable `LOCAL_OWNER_ID` UUID.
- `LOCAL_PERSISTENCE_ENABLED=true`.
- `LOCAL_RECORD_RETENTION_DAYS=30`.
- `LOCAL_ARTIFACT_RETENTION_DAYS=30`.

Create `upgrade-local-env-phase1` for the existing install. It must:

- Refuse non-regular or non-0600 `.env` files.
- Validate any existing Phase 1 values and never replace them.
- Append only missing keys under `umask 077`.
- Generate each secret once.
- Be idempotent on a second run.

Add a `--check` mode that validates without writing.

- [ ] **Step 3: Validate Compose ordering before touching runtime**

```bash
scripts/upgrade-local-env-phase1
scripts/upgrade-local-env-phase1 --check
docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet
docker compose --project-name firecrawl --project-directory . -f compose.yaml config | rg -n "app-postgres|app-db-migrate|service_completed_successfully"
```

Expected: upgrade is idempotent, Compose is valid, and API waits for the
migrator.

- [ ] **Step 4: Start database and run migration twice**

```bash
docker compose --project-name firecrawl --project-directory . -f compose.yaml up -d --wait app-postgres app-db-migrate
docker compose --project-name firecrawl --project-directory . -f compose.yaml run --rm app-db-migrate
docker compose --project-name firecrawl --project-directory . -f compose.yaml exec -T app-postgres psql -U "$APP_POSTGRES_USER" -d "$APP_POSTGRES_DB" -c 'select filename from application_schema_migrations order by filename;'
```

Expected: migration 0001 appears once and the second run is a no-op. If shell
environment does not contain `.env` values, obtain them without printing
secrets or run `psql` using container-owned `POSTGRES_*` variables.

- [ ] **Step 5: Commit database orchestration**

```bash
git add compose.local.yaml scripts/init-local-env.sh scripts/upgrade-local-env-phase1
git commit -m "feat: orchestrate local application database" -m "Add a durable application PostgreSQL service and gate API startup on
successful versioned migrations.

Generate stable local identity and database credentials for new and
existing deployments without exposing or rotating saved secrets."
```

## Task 5: Persist keyless request and job rows

**Files:**
- Modify: `apps/api/src/services/logging/log_job.ts`
- Modify: `apps/api/src/services/logging/log_job.test.ts`
- Create: `apps/api/src/__tests__/snips/v2/local-persistence.test.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/harness.ts`

- [ ] **Step 1: Add failing logging tests**

Mock only DB/storage boundaries. Prove:

- Auth off + local persistence on inserts `requests` and `scrapes`.
- Auth off + local persistence off still skips inserts.
- Local writes use `LOCAL_OWNER_ID`, never `"bypass"` or preview UUIDs.
- Hosted change-tracking RPC remains disabled locally.
- A storage failure bubbles from forced persistence instead of reporting a
  successful durable write.

```bash
cd apps/api
pnpm vitest run src/services/logging/log_job.test.ts
```

Expected: new cases fail at the auth-only gate.

- [ ] **Step 2: Replace only persistence gates**

Change `robustInsert` to use `isApplicationPersistenceEnabled()`. Normalize
the owner through `local-owner.ts` before building UUID columns. Keep billing,
refund, PostHog, blocklist, and `changeTrackingInsertScrape` behavior behind
their existing hosted-auth gates.

Do not rename `supabase-jobs.ts` in this phase. Its Drizzle reads will work
because `dbRr` is now initialized.

- [ ] **Step 3: Add a focused self-host snip**

Add package script:

```json
"test:snips:local-persistence": "vitest run src/__tests__/snips/v2/local-persistence.test.ts"
```

The test must:

1. Require `TEST_SUITE_SELF_HOSTED=true` and local persistence.
2. Scrape the fixture server with existing `scrapeTimeout` conventions.
3. Read the returned `metadata.scrapeId`.
4. Query app-postgres and assert request/scrape owner equals
   `LOCAL_OWNER_ID`, URL/options are present, and auth remains disabled.
5. Call the existing job lookup and assert it returns the scrape for that
   owner and rejects a different owner.

Extend harness test provisioning to start disposable app-postgres and apply
migrations when this focused script runs. Do not make all unit tests depend on
Docker.

- [ ] **Step 4: Run tests and build**

```bash
cd apps/api
pnpm vitest run src/services/logging/log_job.test.ts
pnpm harness pnpm test:snips:local-persistence
pnpm build
```

Expected: local logging, owner isolation, live scrape persistence, and build
pass.

- [ ] **Step 5: Commit operational persistence**

```bash
git add apps/api/package.json apps/api/src/__tests__/snips/v2/local-persistence.test.ts apps/api/src/harness.ts apps/api/src/services/logging/log_job.ts apps/api/src/services/logging/log_job.test.ts
git commit -m "feat: persist local Firecrawl jobs" -m "Write keyless request and operational job records to the local
application database under the stable owner while hosted auth stays off.

Add focused logging and self-host scrape coverage, including owner-isolated
job lookup needed by the next Browser phase."
```

## Task 6: Add MinIO and the artifact-store abstraction

**Files:**
- Create: `apps/api/src/lib/artifacts/types.ts`
- Create: `apps/api/src/lib/artifacts/minio.ts`
- Create: `apps/api/src/lib/artifacts/gcs.ts`
- Create: `apps/api/src/lib/artifacts/index.ts`
- Create: `apps/api/src/lib/artifacts/artifact-store.test.ts`
- Create: `apps/api/src/lib/artifacts/minio.integration.test.ts`
- Create: `apps/api/src/cli/artifact-health.ts`
- Create: `apps/api/config/minio-artifact-policy.json`
- Modify: `apps/api/src/lib/gcs-jobs.ts`
- Modify: `apps/api/src/lib/gcs-monitoring.ts`
- Modify: `apps/api/src/lib/gcs-pdf-cache.ts`
- Modify: `apps/api/src/services/logging/log_job.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/pnpm-lock.yaml`
- Modify: `apps/api/Dockerfile`
- Modify: `compose.local.yaml`

- [ ] **Step 1: Add the verified client dependency**

```bash
cd apps/api
pnpm add minio@8.0.7
```

Expected: `package.json` and `pnpm-lock.yaml` pin the official JavaScript
client. Do not install or shell out to a host MinIO CLI.

- [ ] **Step 2: Write failing provider-neutral contract tests**

Define:

```ts
export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<StoredArtifact>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  health(): Promise<void>;
}
```

Test deterministic key construction, content type/metadata, missing-object
`null`, idempotent delete, and errors that are not “not found” bubbling as
`ArtifactStoreError` with operation/provider fields.

```bash
pnpm vitest run src/lib/artifacts/artifact-store.test.ts
```

Expected: red because the contract/factory do not exist.

- [ ] **Step 3: Implement MinIO and existing GCS adapters**

Construct `Minio.Client` from the validated endpoint URL, port, TLS flag,
access key, secret key, and region. Use `putObject`, `getObject`,
`removeObject`, and `bucketExists`. Cap internal infrastructure retries at
three; never retry validation errors.

Wrap current GCS operations behind the same interface so hosted deployments
retain behavior. The factory rules are explicit:

- `minio`: validated MinIO adapter.
- `gcs`: GCS adapter using existing settings.
- `none`: no-op availability with no durable artifact promises.
- Configured provider unavailable: typed failure; no silent provider switch.

- [ ] **Step 4: Preserve existing exports while routing job blobs**

Keep public function names in `gcs-jobs.ts`, `gcs-monitoring.ts`, and
`gcs-pdf-cache.ts` to avoid a broad import rewrite. Delegate their object
operations to the selected store. Replace `config.GCS_BUCKET_NAME` job gates
in `log_job.ts` with `isArtifactStoreConfigured()`.

Leave Fire-engine, index, and media direct-GCS buckets unchanged; they are not
Phase 1 local artifacts.

After each successful put, insert `local_artifacts` with object key, owner,
request/job IDs, kind, content type, byte size, and `delete_after`. If manifest
insert fails, attempt object rollback and throw the original persistence
error. Zero-data-retention requests keep their existing redaction/no-storage
rules.

- [ ] **Step 5: Add MinIO services and least privilege initialization**

Add backend-only services:

```yaml
minio:
  image: minio/minio:RELEASE.2025-09-07T16-13-09Z
  command: server /data --console-address :9001
minio-init:
  image: minio/mc:RELEASE.2025-08-13T08-35-41Z
```

Use `minio-data:/data`, no published ports, a `/minio/health/live` check, and
`minio-init: condition: service_healthy`. The initializer must create one
bucket and one application user, apply the checked-in policy, and grant only
list/get/put/delete for that bucket. The API receives application credentials,
never MinIO root credentials.

Make API depend on `minio-init: condition: service_completed_successfully`.
Copy `config/minio-artifact-policy.json` into the runtime image.

- [ ] **Step 6: Add and run real service contract test**

The integration test uses a unique prefix and always deletes its objects. It
must put/get/delete, verify metadata, verify missing-object behavior, and
confirm the app credential cannot access another bucket.

```bash
docker compose --project-name firecrawl --project-directory . -f compose.yaml up -d --wait minio minio-init
cd apps/api
pnpm vitest run src/lib/artifacts/artifact-store.test.ts src/lib/artifacts/minio.integration.test.ts
pnpm artifact:health
pnpm build
```

Expected: unit and real MinIO contracts pass; health verifies authenticated
bucket access.

- [ ] **Step 7: Commit artifact foundation**

```bash
git add apps/api/Dockerfile apps/api/config/minio-artifact-policy.json apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/cli/artifact-health.ts apps/api/src/lib/artifacts apps/api/src/lib/gcs-jobs.ts apps/api/src/lib/gcs-monitoring.ts apps/api/src/lib/gcs-pdf-cache.ts apps/api/src/services/logging/log_job.ts compose.local.yaml scripts/init-local-env.sh scripts/upgrade-local-env-phase1
git commit -m "feat: add durable local artifact storage" -m "Store Firecrawl job artifacts through a provider-neutral interface backed
by an internal least-privilege MinIO deployment.

Preserve existing GCS exports for hosted compatibility and gate API startup
on bucket and policy initialization."
```

## Task 7: Implement local retention and cleanup

**Files:**
- Create: `apps/api/src/services/local-retention-worker.ts`
- Create: `apps/api/src/services/local-retention-worker.test.ts`
- Modify: `apps/api/src/harness.ts`
- Modify: `apps/api/src/services/logging/log_job.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Write failing retention tests**

Use fake clock, DB boundary, and artifact store. Cover:

- Normal local requests receive configured record expiry.
- Artifacts receive configured artifact expiry.
- ZDR keeps current 24-hour maximum cleanup behavior and redaction rules.
- Cleaner selects at most 50 expired artifacts per iteration.
- Delete object first, then manifest; missing objects count as success.
- Failed object delete keeps the manifest for retry.
- Expired job rows delete in dependency order before `requests`.
- One iteration is idempotent after interruption.
- Hosted mode never starts or runs local cleanup.

```bash
cd apps/api
pnpm vitest run src/services/local-retention-worker.test.ts
```

Expected: red because worker does not exist.

- [ ] **Step 2: Implement direct-SQL local cleanup**

Do not call `get_zdr_cleanup_batch_2`; it is a missing hosted RPC. Export a
single `runLocalRetentionIteration` for tests and a loop entrypoint for the
harness. Use bounded queries, `FOR UPDATE SKIP LOCKED` where rows are claimed,
and one-second idle backoff.

Cleanup sequence:

1. Select up to 50 expired artifact manifests.
2. Delete each object idempotently.
3. Delete only manifests whose object deletion succeeded/not-found.
4. Select expired requests in a transaction.
5. Delete matching operational child rows, then requests.
6. Log counts, duration, correlation/request IDs, and specific errors.

Unexpected DB/storage errors must bubble to the worker loop logger and retry
on the next bounded iteration; never mark failed work complete.

- [ ] **Step 3: Start worker only in validated local mode**

Start one worker from `harness.ts` only when local persistence is enabled.
Attach the existing harness shutdown signal so tests and service stop wait for
the loop to exit. Do not start the hosted ZDR worker locally.

- [ ] **Step 4: Run retention tests and build**

```bash
pnpm vitest run src/services/local-retention-worker.test.ts
pnpm build
```

Expected: all cleanup, retry, idempotency, shutdown, and hosted-isolation
cases pass.

- [ ] **Step 5: Commit retention behavior**

```bash
git add apps/api/package.json apps/api/src/harness.ts apps/api/src/services/local-retention-worker.ts apps/api/src/services/local-retention-worker.test.ts apps/api/src/services/logging/log_job.ts
git commit -m "feat: enforce local data retention" -m "Expire local artifacts and operational records with bounded idempotent
cleanup instead of relying on unavailable hosted Supabase RPCs.

Start one retention loop only for local persistence and preserve failed
deletions for safe retry."
```

## Task 8: Extend lifecycle, health, and operator documentation

**Files:**
- Modify: `scripts/local-firecrawl`
- Modify: `LOCAL_DEPLOYMENT.md`

- [ ] **Step 1: Extend scoped lifecycle service sets**

Add long-running services `app-postgres` and `minio`. Add one-shot
`app-db-migrate` and `minio-init` only to bounded logs/diagnostics. Preserve
path-independent Compose arguments, safe ordered restart, and the absence of
volume deletion/prune commands.

- [ ] **Step 2: Extend health checks**

`health` must verify:

- Existing Redis, RabbitMQ, NuQ PostgreSQL, Playwright, and API checks.
- App PostgreSQL `pg_isready`.
- Latest migration filename equals the latest checked-in migration.
- MinIO `/minio/health/live` inside the backend network.
- API image artifact health command succeeds with application credentials.
- Only API is published on `127.0.0.1:3002`.

Never print database or MinIO credentials.

- [ ] **Step 3: Document operations and backup boundaries**

Add:

- Stable local owner and auth/persistence separation.
- Migration ordering and failure diagnosis.
- Default 30-day retention and configuration keys.
- App PostgreSQL logical backup/restore commands.
- MinIO volume backup/restore at a stopped-service boundary.
- Warning not to edit MinIO data files directly.
- Pinned archived MinIO image risk and no automatic upgrades.
- Explicit statement that normal restart preserves all volumes.
- Phase 1 capability boundary: Interact still awaits Phase 2.

- [ ] **Step 4: Validate lifecycle behavior**

```bash
bash -n scripts/local-firecrawl scripts/init-local-env.sh scripts/upgrade-local-env-phase1
scripts/local-firecrawl status
scripts/local-firecrawl health
scripts/local-firecrawl logs
```

Expected: syntax passes; status includes app-postgres and MinIO; health checks
all dependencies; logs remain bounded to this project.

- [ ] **Step 5: Commit operations updates**

```bash
git add LOCAL_DEPLOYMENT.md scripts/local-firecrawl
git commit -m "docs: document local persistence operations" -m "Extend Firecrawl recovery checks to the application database,
migrations, and artifact store while preserving non-destructive restart.

Document retention, backups, phase boundaries, and the pinned archived
MinIO dependency risk."
```

## Task 9: Prove restart durability and Phase 1 acceptance

**Files:**
- Modify only files required by failures found below.

- [ ] **Step 1: Run focused automated coverage**

```bash
cd apps/api
pnpm vitest run src/lib/local-runtime-config.test.ts src/lib/local-owner.test.ts src/db/application-config.test.ts src/db/migrate.integration.test.ts src/lib/artifacts/artifact-store.test.ts src/lib/artifacts/minio.integration.test.ts src/services/logging/log_job.test.ts src/services/local-retention-worker.test.ts
pnpm harness pnpm test:snips:local-persistence
pnpm build
```

Expected: all focused tests and build pass.

- [ ] **Step 2: Run repository and Compose checks**

```bash
cd /home/mamba/work/firecrawl
docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet
git diff --check
scripts/local-firecrawl restart
scripts/local-firecrawl health
```

Expected: valid Compose/diff, ordered successful restart, all health checks
green.

- [ ] **Step 3: Run live persistence smoke**

Scrape `https://example.com` through `http://127.0.0.1:3002/v2/scrape`, save
its returned scrape ID without committing output, then verify:

- One request and scrape row exist under `LOCAL_OWNER_ID`.
- One job artifact manifest and object exist.
- `USE_DB_AUTHENTICATION=false` remains in the API container.
- No DB/MinIO/queue service publishes a host port.

Run `scripts/local-firecrawl restart`, then repeat DB lookup and artifact read
for the same IDs. Expected: both survive restart unchanged.

- [ ] **Step 4: Prove migration failure closes startup**

In a disposable Compose project/volume only, inject a deliberately invalid
test migration, start the project, and assert migrator exits non-zero and API
never becomes healthy. Remove only the disposable project/volume afterward.
Never alter the real `firecrawl` volumes.

- [ ] **Step 5: Prove retention on disposable data**

Insert one expired request/artifact and one unexpired pair under the local
owner. Run one cleaner iteration through a test-only CLI or integration test.
Expected: expired object/manifest/job/request disappear; unexpired data
remains.

- [ ] **Step 6: Inspect network and cloud-provider isolation**

```bash
docker compose --project-name firecrawl --project-directory . -f compose.yaml ps --format json
docker compose --project-name firecrawl --project-directory . -f compose.yaml port api 3002
```

Expected: only API maps to `127.0.0.1:3002`; app-postgres, NuQ PostgreSQL,
MinIO, Redis, RabbitMQ, and Playwright remain backend-only. Review logs to
confirm no Firecrawl Cloud, Gemini, or Fireworks fallback occurred.

- [ ] **Step 7: Run actual pre-commit framework and final review**

```bash
git config --get core.hooksPath
```

Inspect the resolved pre-commit entrypoint. Run the actual hook runner it
invokes across all files. If formatting changes files, stage later and rerun
until clean. Then:

```bash
git status --short
git diff --check
git diff --stat
git log --oneline -9
```

Expected: only intended Phase 1 changes remain, no whitespace errors, all
task commits present.

- [ ] **Step 8: Request code review**

Use `superpowers:requesting-code-review`. Resolve findings with the same
focused tests, then rerun Steps 1-7. Do not start Phase 2 until Phase 1 review
and acceptance are green.

## Phase 1 Exit Criteria

- `USE_DB_AUTHENTICATION=false` and keyless loopback requests still work.
- Every local request/job write uses stable `LOCAL_OWNER_ID`.
- App PostgreSQL migrations are versioned, idempotent, and startup-gating.
- Operational records and MinIO artifacts survive ordered restart.
- Artifact provider failure is typed and never falls back silently.
- Local retention deletes expired data and preserves failed deletions for
  retry.
- Hosted auth/billing and NuQ behavior are unchanged.
- Only API is published on loopback.
- Focused unit, integration, self-host snip, build, lifecycle, restart, and
  security-boundary checks pass.
- Phase 2 can resolve an existing scrape by ID/owner without receiving
  `Job not found`; Browser Service remains the next explicit dependency.
