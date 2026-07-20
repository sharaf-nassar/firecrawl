# Browser Interact Gate and Durable State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove installed Codex can call one truthful side-effecting browser MCP tool headlessly, then add the disabled-by-default PostgreSQL, replay-envelope, checkpoint, ZDR, recovery, and retention foundation needed by local Browser Interact.

**Architecture:** Gate zero runs before repository runtime changes and stops the rollout if Codex cannot honor the exact noninteractive tool policy. PostgreSQL becomes authoritative for browser sessions, runs, profiles, capabilities, proxy grants, replay envelopes, and checkpoint metadata. The existing stateless Playwright service exports a bounded post-scrape checkpoint before closing its context; the API stores sensitive state atomically on an owner-restricted volume and cleans it before request retention deletes database rows.

**Tech Stack:** Codex CLI 0.144.5, MCP JSON-RPC over stdio, TypeScript, Zod, Drizzle ORM, PostgreSQL 17, Playwright 1.58.1, Vitest, Docker Compose.

---

## File map

- Create `scripts/codex-browser-gate/mcp-server.mjs`: dependency-free, truthful side-effecting MCP fixture.
- Create `scripts/codex-browser-gate/run.mjs`: isolated Codex runner and JSONL assertions.
- Create `apps/api/src/db/migrations/0004_browser_interact_foundation.sql`: durable browser and replay tables, constraints, foreign keys, and indexes.
- Create `compose.browser-test.yaml`: isolated loopback PostgreSQL used only by browser-state integration tests.
- Modify `apps/api/src/db/schema/public.ts`: Drizzle declarations matching migration 0004.
- Modify `apps/api/src/db/migrate.integration.test.ts`: migration ledger, constraints, index, and cascade coverage.
- Create `apps/api/src/lib/browser-state/types.ts`: canonical session, run, profile, capability, grant, and activity types.
- Create `apps/api/src/lib/browser-state/transitions.ts`: pure legal-transition tables and guards.
- Create `apps/api/src/lib/browser-state/store.ts`: transactional PostgreSQL CRUD, compare-and-set transitions, durable activity and prompt accounting, startup interruption.
- Create `apps/api/src/lib/browser-state/transitions.test.ts`: deterministic transition tests.
- Create `apps/api/src/lib/browser-state/store.integration.test.ts`: compare-and-set, profile lease, revocation, and recovery tests.
- Modify `apps/api/src/harness.ts`: run browser-state recovery after migrations only when feature flag is enabled.
- Create `apps/api/src/lib/scrape-interact/replay-envelope.ts`: V1 normalization, action effects, legacy adaptation, and replay planning.
- Create `apps/api/src/lib/scrape-interact/replay-envelope.test.ts`: normalization, unknown-option, side-effect, fingerprint, and ZDR cases.
- Create `apps/api/src/lib/scrape-interact/replay-store.ts`: atomic checkpoint-file and PostgreSQL persistence/load APIs.
- Create `apps/api/src/lib/scrape-interact/replay-store.integration.test.ts`: durable and ZDR persistence tests.
- Modify `apps/playwright-service-ts/api.ts`: optional checkpoint capture before context close.
- Modify `apps/api/src/scraper/scrapeURL/engines/index.ts`: internal checkpoint capture type.
- Modify `apps/api/src/scraper/scrapeURL/engines/playwright/index.ts`: request and validate checkpoint capture.
- Modify `apps/api/src/scraper/scrapeURL/index.ts`: carry checkpoint separately from public `Document`.
- Modify `apps/api/src/services/worker/scrape-worker.ts`: pass checkpoint capture to durable logging.
- Modify `apps/api/src/services/logging/log_job.ts`: persist replay state after non-ZDR scrape insert.
- Create `apps/api/src/lib/browser-state/filesystem-store.ts`: root-confined atomic sensitive-state writes and deletes.
- Modify `apps/api/src/services/local-retention-worker.ts`: delete claimed replay/profile files before operational rows.
- Modify `apps/api/src/services/local-retention-worker.test.ts`: checkpoint/profile cleanup order and failure retry coverage.
- Modify `apps/api/src/config.ts`: disabled feature flag and checkpoint root.
- Modify `apps/api/src/lib/local-runtime-config.ts`: validate browser state root only when enabled.
- Modify `compose.local.yaml`: private named volume and disabled feature environment.
- Modify `.env.example.local`: document disabled rollout controls.

## Shared contracts

Use these names unchanged in later Browser Service, API, and host-adapter plans:

```ts
export type BrowserSessionState =
  | "creating"
  | "replaying"
  | "ready"
  | "executing"
  | "stopping"
  | "destroyed"
  | "expired"
  | "interrupted"
  | "error";

export type InteractRunState =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type ReplayActionEffect = "read_only" | "side_effecting";

export interface ReplayBrowserSettingsV1 {
  headers: Record<string, string>;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
  };
  deviceName?: string;
  userAgent: string;
  locale: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
  location: { country: string; languages: string[] };
  proxy: {
    kind: "basic" | "stealth" | "enhanced" | "auto";
    country?: string;
    credentialRef?: string;
  };
  skipTlsVerification: boolean;
  blockAds: boolean;
  lockdown: boolean;
}

export interface ReplayCheckpointCaptureV1 {
  version: 1;
  finalUrl: string;
  storageState: {
    cookies: Array<Record<string, unknown>>;
    origins: Array<Record<string, unknown>>;
  };
  fingerprint: {
    finalUrl: string;
    titleSha256: string;
    bodyTextSha256: string;
  };
  browserSettings: ReplayBrowserSettingsV1;
}
```

## Verified references and assumptions

- Codex CLI `exec` supports `--ephemeral`, `--json`, `--strict-config`, `--ignore-rules`, `--output-schema`, explicit model and sandbox selection, and isolated `CODEX_HOME`: [Codex noninteractive mode](https://developers.openai.com/codex/noninteractive).
- Codex MCP configuration supports `required`, `enabled_tools`, `default_tools_approval_mode`, and per-tool `approval_mode = "approve"`: [Codex MCP configuration](https://developers.openai.com/codex/mcp).
- Codex configuration supports `approval_policy = "never"`, `model_reasoning_effort`, `web_search = "disabled"`, and disabling `apps`, `hooks`, `multi_agent`, `shell_tool`, and `unified_exec`: [Codex configuration reference](https://developers.openai.com/codex/config-reference).
- Installed gate target is `codex-cli 0.144.5`. Any newer installed version must pass the same `--strict-config` gate before implementation continues.
- Existing `apps/playwright-service-ts` pins Playwright `^1.58.1`. `browserContext.storageState({ indexedDB: true })` is available since 1.51; restoration into a live context is deferred to the Browser Service plan, which pins Playwright 1.61.1: [Playwright BrowserContext storageState](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state).
- Gate zero proves Codex approval/tool exposure behavior. Full outer `runc` isolation cannot be proven before the broker and fixed bundles exist; that containment remains a later mandatory host-adapter gate. Do not misreport this spike as the sandbox acceptance test.

### Task 1: Prove headless side-effecting Codex MCP execution

**Files:**
- Create: `scripts/codex-browser-gate/mcp-server.mjs`
- Create: `scripts/codex-browser-gate/run.mjs`

- [ ] **Step 1: Write the truthful MCP fixture**

Implement newline-delimited JSON-RPC handling for `initialize`, `ping`, `tools/list`, and `tools/call`. Advertise exactly one tool:

```js
const tool = {
  name: "perform_side_effect",
  description: "Write one gate marker proving an authorized side effect ran.",
  inputSchema: {
    type: "object",
    properties: { value: { const: "approved" } },
    required: ["value"],
    additionalProperties: false,
  },
  annotations: {
    title: "Perform gate side effect",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};
```

For `tools/call`, require `name === "perform_side_effect"`, input value `approved`, and `GATE_MARKER_PATH`. Open the marker with `flag: "wx"`, mode `0o600`, and body `approved\n`; a second call must return `isError: true`. Never accept a path in tool input.

- [ ] **Step 2: Write the isolated runner**

`run.mjs` must:

1. Parse `codex --version`, require `codex-cli` version 0.144.5 or newer,
   and retain the exact detected version for the PASS line. Reject older or
   unparsable versions.
2. Create a `mkdtemp()` root containing `codex-home`, `work`, `marker`, and `events.jsonl`.
3. Copy only `~/.codex/auth.json` into the temporary home with mode `0o600`; fail with `codex_auth_missing` if absent.
4. Generate `config.toml` with `nodeExecutable`, `mcpServerPath`, and
   `markerPath` produced by `process.execPath`, `fileURLToPath(import.meta.url)`,
   and the temporary root. Escape TOML strings with `JSON.stringify`:

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[history]
persistence = "none"

[features]
apps = false
artifact = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
code_mode = false
code_mode_host = false
code_mode_only = false
computer_use = false
enable_mcp_apps = false
goals = false
hooks = false
image_generation = false
in_app_browser = false
memories = false
multi_agent = false
plugins = false
plugin_sharing = false
remote_plugin = false
request_permissions_tool = false
shell_snapshot = false
shell_tool = false
skill_mcp_dependency_install = false
standalone_web_search = false
tool_call_mcp_elicitation = false
tool_suggest = false
unified_exec = false
workspace_dependencies = false

[mcp_servers.browser_gate]
command = "${nodeExecutable}"
args = ["${mcpServerPath}"]
required = true
enabled_tools = ["perform_side_effect"]
default_tools_approval_mode = "prompt"
startup_timeout_sec = 10
tool_timeout_sec = 20

[mcp_servers.browser_gate.env]
GATE_MARKER_PATH = "${markerPath}"

[mcp_servers.browser_gate.tools.perform_side_effect]
approval_mode = "approve"
```

5. With the isolated `CODEX_HOME`, spawn `codex features list` without a
   shell. Parse every row and assert every tool-bearing feature listed above is
   false. Also fail closed with `codex_feature_surface_changed` if an enabled
   feature name newly matches `tool`, `browser`, `computer`, `code_mode`,
   `image`, `app`, `plugin`, `shell`, `web_search`, `skill`, `mcp`, or
   `artifact` and is not an explicitly reviewed non-tool feature. Record the
   parsed inventory hash in the gate result.
6. Spawn, without a shell, `codex exec --ephemeral --strict-config --ignore-rules --skip-git-repo-check --sandbox read-only --json` with this prompt:

```text
Call browser_gate.perform_side_effect exactly once with value "approved".
Do not call any other tool. After it succeeds, reply exactly gate-complete.
```

7. Apply a 120-second watchdog, capture stdout as JSONL, cap combined output at 4 MiB, and kill the process group on timeout.
8. Assert exit 0, marker body `approved\n`, exactly one completed MCP tool-call event naming `perform_side_effect`, final agent text `gate-complete`, and zero command, file-change, browser, computer, code-mode, image, web-search, app, plugin, shell, or collaboration tool events. Reject every completed tool name other than `perform_side_effect`.
9. Print only `codex_browser_gate: PASS version=<version> model=gpt-5.6-terra effort=medium calls=1 features=<sha256>`; always delete the temporary root.

- [ ] **Step 3: Run gate zero**

Run from repository root:

```bash
node scripts/codex-browser-gate/run.mjs
```

Expected: one `codex_browser_gate: PASS ... calls=1 features=<sha256>` line
and exit 0. If Codex pauses, denies the call, exposes another tool, changes
the reviewed feature surface, cannot use the requested model, or needs broader
approval/sandbox settings, stop. Do not begin Task 2; revise approved design
instead. Never add `danger-full-access` or
`--dangerously-bypass-approvals-and-sandbox`.

- [ ] **Step 4: Stage and run actual hook**

```bash
git add scripts/codex-browser-gate/mcp-server.mjs scripts/codex-browser-gate/run.mjs
apps/api/.husky/_/pre-commit
```

Expected: hook exits 0. If formatting changes either file, stage those two files again and rerun the same hook before committing.

- [ ] **Step 5: Commit the passing gate**

```bash
git commit -m "test: prove headless Codex browser tool approval" -m "Add a reproducible installed-Codex gate that confirms a
truthful side-effecting MCP tool runs headlessly under the isolated
browser policy.

Fail before durable browser work if tool policy or model behavior
differs."
```

### Task 2: Add browser and replay persistence migration

**Files:**
- Create: `compose.browser-test.yaml`
- Create: `apps/api/src/db/migrations/0004_browser_interact_foundation.sql`
- Modify: `apps/api/src/db/schema/public.ts`
- Modify: `apps/api/src/db/migrate.integration.test.ts`

- [ ] **Step 1: Write failing migration assertions**

Add `browserInteractFilename = "0004_browser_interact_foundation.sql"` to expected ledger. Assert these tables exist:

```ts
const browserFoundationTables = [
  "browser_sessions",
  "browser_session_activities",
  "browser_interact_runs",
  "browser_profiles",
  "browser_profile_generations",
  "browser_replay_envelopes",
  "browser_replay_checkpoints",
  "browser_capabilities",
  "browser_proxy_grants",
];
```

Add a fixture transaction that inserts owner, request, scrape, profile,
generation, envelope, checkpoint, session, run, capability, grant, and
activity. Assert duplicate owner/profile name and reuse of one writer session
across two profiles violate unique indexes. Delete the request and assert
request/session/run/replay/capability/grant/activity rows cascade while
owner/profile identity remains.
Assert migration 0004 adds nullable `checksum` to existing `local_artifacts`
with a 64-character lowercase SHA-256 check; pre-Phase-2 manifests remain
valid with null while browser artifacts require it.

- [ ] **Step 2: Run test to verify it fails**

Create the isolated integration database definition:

```yaml
services:
  browser-test-postgres:
    image: postgres:17.10-bookworm
    environment:
      POSTGRES_USER: firecrawl
      POSTGRES_PASSWORD: password
      POSTGRES_DB: firecrawl
    ports:
      - "127.0.0.1:55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U firecrawl -d firecrawl"]
      interval: 2s
      timeout: 3s
      retries: 30
```

From the repository root:

```bash
docker compose --project-name firecrawl-browser-test --project-directory . -f compose.browser-test.yaml up -d --wait browser-test-postgres
```

This disposable project is separate from local runtime volumes. If port 55432
is occupied, stop and identify the owner; do not silently target another
database.

From `apps/api`:

```bash
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:password@127.0.0.1:55432/firecrawl pnpm vitest run src/db/migrate.integration.test.ts
```

Expected: FAIL because migration 0004 and browser tables do not exist. If the configured integration database is unavailable, stop and fix the existing local stack; do not replace the integration test with mocks.

- [ ] **Step 3: Create migration with exact durable columns**

Create all tables in one transaction-safe SQL migration. Use these keys and checks:

```sql
ALTER TABLE local_artifacts
  ADD COLUMN checksum text
  CHECK (checksum IS NULL OR checksum ~ '^[a-f0-9]{64}$');
```

```sql
CREATE TABLE browser_profiles (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  name text NOT NULL,
  latest_generation_id uuid,
  writer_session_id uuid,
  retention_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE TABLE browser_profile_generations (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  state_path text,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  file_deleted_at timestamptz,
  UNIQUE (profile_id, generation)
);

CREATE TABLE browser_replay_envelopes (
  scrape_id uuid PRIMARY KEY REFERENCES scrapes(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version = 1),
  navigation_policy_version integer NOT NULL CHECK (navigation_policy_version = 1),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE browser_replay_checkpoints (
  id uuid PRIMARY KEY,
  scrape_id uuid NOT NULL UNIQUE REFERENCES scrapes(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES local_owners(id) ON DELETE CASCADE,
  envelope_version integer NOT NULL CHECK (envelope_version = 1),
  state_path text,
  final_url text NOT NULL,
  fingerprint jsonb NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  file_deleted_at timestamptz
);
```

`browser_sessions` must contain `id`, `request_id`, `owner_id`, nullable `scrape_id`, nullable runtime `browser_id`, `runtime_epoch`, nullable `profile_id` and `profile_generation_id`, `replay_version`, state, absolute/idle deadlines, `last_activity_at`, nullable `current_run_id`, `prompt_used`, billing counters, stream flag, legacy nullable proxy fields, lifecycle timestamps, and terminal reason. Check state against `creating,replaying,ready,executing,stopping,destroyed,expired,interrupted,error`.

`browser_interact_runs` must contain `id`, `request_id`, `owner_id`,
`session_id`, nullable `scrape_id`, mode, state, nullable language, model,
reasoning effort, deadline, correlation ID, nullable adapter process ID,
cancellation timestamp, nullable `output_reference` JSON, non-null
`artifact_references` JSON array defaulting to `[]`, error category/detail,
and queued/started/finished timestamps. Each artifact reference is later
validated as `{ artifactId, objectKey, kind, contentType, byteSize, checksum }`;
object bytes/manifests use the existing `local_artifacts`/MinIO transaction.
Check mode against `prompt,code,browser_operation,replay` and state against the
approved run states.

`browser_session_activities` must contain identity ID, request/owner/session/run links, mode, nullable language, timeout milliseconds, exit/killed metadata, source, correlation ID, and created/completed timestamps.

`browser_capabilities` must store only token hash plus owner/session/run/process bindings, operation and origin JSON arrays, navigation policy version, call/byte limits and usage, wall/per-operation deadlines, and issued/redeemed/revoked/expiry timestamps. `browser_proxy_grants` must store only token hash plus owner/session, permission (`passive`, `interactive`, or `cdp`), use limits, issued/redeemed/revoked/expiry timestamps.

After both tables exist, add deferred foreign keys from profile latest
generation and writer session, and session current run. Add indexes for
owner/state, scrape/session recency, run/state, all expiry columns,
capability/grant hashes, and a partial unique index preventing one session from
holding multiple writer leases:

```sql
CREATE UNIQUE INDEX browser_profiles_writer_session_idx
  ON browser_profiles (writer_session_id)
  WHERE writer_session_id IS NOT NULL;
```

One writer per profile is represented by the single `writer_session_id` column
and enforced by the compare-and-set lease transaction in Task 3; SQL cannot
replace that value without the store's guarded update.

- [ ] **Step 4: Align Drizzle schema**

Replace legacy browser declarations with columns matching SQL exactly and export declarations for every new table. Keep legacy `workspace_id`, `context_id`, `cdp_url`, `cdp_path`, and `cdp_interactive_path` nullable during compatibility rollout; later API work removes their use, not this migration.

- [ ] **Step 5: Run migration and build tests**

From `apps/api`:

```bash
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:password@127.0.0.1:55432/firecrawl pnpm vitest run src/db/migrate.integration.test.ts
pnpm build
```

Expected: migration test PASS twice-idempotent through the ledger, all constraint/cascade assertions PASS, and TypeScript build PASS.

- [ ] **Step 6: Stage, hook, and commit**

```bash
git add compose.browser-test.yaml apps/api/src/db/migrations/0004_browser_interact_foundation.sql apps/api/src/db/schema/public.ts apps/api/src/db/migrate.integration.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: add durable browser state schema" -m "Create local browser, run, profile, replay, capability, and
proxy-grant tables with lifecycle constraints, expiry indexes, and
retention cascades.

Align Drizzle declarations and verify migration integrity in
PostgreSQL."
```

### Task 3: Implement durable state machines and startup recovery

**Files:**
- Create: `apps/api/src/lib/browser-state/types.ts`
- Create: `apps/api/src/lib/browser-state/transitions.ts`
- Create: `apps/api/src/lib/browser-state/transitions.test.ts`
- Create: `apps/api/src/lib/browser-state/store.ts`
- Create: `apps/api/src/lib/browser-state/store.integration.test.ts`
- Modify: `apps/api/src/lib/browser-sessions.ts`
- Modify: `apps/api/src/lib/browser-session-activity.ts`
- Modify: `apps/api/src/harness.ts`

- [ ] **Step 1: Write failing pure transition tests**

Assert the complete transition maps:

```ts
export const browserSessionTransitions = {
  creating: ["replaying", "stopping", "interrupted", "error"],
  replaying: ["ready", "stopping", "interrupted", "error"],
  ready: ["executing", "stopping", "expired", "interrupted", "error"],
  executing: ["ready", "stopping", "expired", "interrupted", "error"],
  stopping: ["destroyed", "expired", "interrupted", "error"],
  destroyed: [], expired: [], interrupted: [], error: [],
} as const;

export const interactRunTransitions = {
  queued: ["starting", "cancelled", "timed_out", "interrupted"],
  starting: ["running", "failed", "cancelled", "timed_out", "interrupted"],
  running: ["succeeded", "failed", "cancelled", "timed_out", "interrupted"],
  succeeded: [], failed: [], cancelled: [], timed_out: [], interrupted: [],
} as const;
```

Assert terminal states reject every outgoing transition and `executing -> succeeded` is rejected because run completion must transition the session back to `ready` separately.

- [ ] **Step 2: Run pure tests red, then implement guards**

From `apps/api`:

```bash
pnpm vitest run src/lib/browser-state/transitions.test.ts
```

Expected before implementation: FAIL with missing module. Implement `isBrowserSessionTransition`, `assertBrowserSessionTransition`, `isInteractRunTransition`, and `assertInteractRunTransition` using the maps; rerun and expect PASS.

- [ ] **Step 3: Write failing PostgreSQL state tests**

Cover:

- `compareAndSetBrowserSessionState(id, ["ready"], "executing", patch)` allows exactly one concurrent caller.
- `compareAndSetInteractRunState` permits exactly one terminal winner.
- `markSessionPromptUsed` survives process restart and `didSessionUsePrompt` reads PostgreSQL, not Redis.
- `appendBrowserActivity` inserts directly and does not lose an event when Redis is unavailable.
- `acquireProfileWriter` returns one lease and rejects the second with `profile_locked`; read snapshots do not take the writer column.
- `interruptUnfinishedBrowserWork(now)` marks unfinished sessions/runs interrupted, revokes active capabilities/grants, and clears matching writer leases in one transaction while leaving terminal rows unchanged.

- [ ] **Step 4: Implement store signatures**

Export exactly:

```ts
export async function createBrowserSession(input: CreateBrowserSessionInput): Promise<BrowserSessionRow>;
export async function getBrowserSession(id: string): Promise<BrowserSessionRow | null>;
export async function getReadyBrowserSessionForScrape(ownerId: string, scrapeId: string): Promise<BrowserSessionRow | null>;
export async function compareAndSetBrowserSessionState(id: string, from: BrowserSessionState[], to: BrowserSessionState, patch?: BrowserSessionTransitionPatch): Promise<BrowserSessionRow | null>;
export async function touchBrowserSession(id: string, now: Date): Promise<boolean>;
export async function createInteractRun(input: CreateInteractRunInput): Promise<BrowserInteractRunRow>;
export async function compareAndSetInteractRunState(id: string, from: InteractRunState[], to: InteractRunState, patch?: InteractRunTransitionPatch): Promise<BrowserInteractRunRow | null>;
export async function markSessionPromptUsed(id: string): Promise<void>;
export async function didSessionUsePrompt(id: string): Promise<boolean>;
export async function appendBrowserActivity(input: BrowserActivityInput): Promise<void>;
export async function acquireProfileWriter(input: AcquireProfileWriterInput): Promise<BrowserProfileLease>;
export async function releaseProfileWriter(profileId: string, sessionId: string): Promise<boolean>;
export async function interruptUnfinishedBrowserWork(now: Date): Promise<BrowserRecoveryResult>;
```

Use transactions and row/count compare-and-set updates. Throw named `ProfileLockedError` only for expected lease conflict; allow unexpected database errors to bubble. Keep `lib/browser-sessions.ts` and `lib/browser-session-activity.ts` as temporary compatibility facades over this store, but remove Redis prompt flags and Redis activity queue writes.

- [ ] **Step 5: Wire guarded recovery**

After `runApplicationMigrations` succeeds in `harness.ts`, call recovery only when `config.LOCAL_BROWSER_SERVICE_ENABLED` is true. Log counts only:

```ts
const recovered = await interruptUnfinishedBrowserWork(new Date());
logger.info("Recovered durable browser state", recovered);
```

Do not start Browser Service or change existing endpoint routing in this plan.

- [ ] **Step 6: Run focused tests**

From `apps/api`:

```bash
pnpm vitest run src/lib/browser-state/transitions.test.ts src/lib/browser-state/store.integration.test.ts src/controllers/v2/__tests__/browser-billing.test.ts
pnpm build
```

Expected: all focused tests and build PASS; browser billing test proves durable prompt accounting preserves rate selection.

- [ ] **Step 7: Stage, hook, and commit**

```bash
git add apps/api/src/lib/browser-state/types.ts apps/api/src/lib/browser-state/transitions.ts apps/api/src/lib/browser-state/transitions.test.ts apps/api/src/lib/browser-state/store.ts apps/api/src/lib/browser-state/store.integration.test.ts apps/api/src/lib/browser-sessions.ts apps/api/src/lib/browser-session-activity.ts apps/api/src/harness.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: persist browser lifecycle state" -m "Add compare-and-set browser and run transitions, durable prompt
and activity accounting, exclusive profile leases, and restart
interruption.

Keep compatibility helpers while removing Redis-only lifecycle
decisions."
```

### Task 4: Normalize replay envelopes and fail closed on unsafe legacy state

**Files:**
- Create: `apps/api/src/lib/scrape-interact/replay-envelope.ts`
- Create: `apps/api/src/lib/scrape-interact/replay-envelope.test.ts`
- Modify: `apps/api/src/lib/scrape-interact/scrape-replay.ts`

- [ ] **Step 1: Write failing normalization tests**

Cover canonical URL rewriting; request origin; retained headers/cookies; wait;
viewport; device/mobile/touch/user agent; locale/timezone/geolocation/location;
TLS; ad-block; proxy metadata/credential references; lockdown; profile
generation; all action kinds; output-only options ignored; unknown/malformed
options rejected with field names; redacted URL/options returning
`replay_unavailable`; checkpoint replay never repeating actions; and legacy
replay rejecting click/write/press/JavaScript while allowing
wait/scroll/screenshot/PDF/scrape.

- [ ] **Step 2: Run test to verify red**

From `apps/api`:

```bash
pnpm vitest run src/lib/scrape-interact/replay-envelope.test.ts
```

Expected: FAIL with missing replay-envelope module.

- [ ] **Step 3: Implement versioned envelope and action effects**

Export exactly:

```ts
export interface ReplayEnvelopeV1 {
  version: 1;
  navigationPolicyVersion: 1;
  canonicalTargetUrl: string;
  callerOrigin: string;
  waitForMs: number;
  browserSettings: ReplayBrowserSettingsV1;
  profile?: {
    name: string;
    saveChanges: boolean;
    generationId?: string;
  };
  actions: Array<{ index: number; effect: ReplayActionEffect; action: ReplayAction }>;
}

export type ReplayResolution =
  | { kind: "checkpoint"; envelope: ReplayEnvelopeV1; checkpoint: StoredReplayCheckpoint }
  | { kind: "legacy"; envelope: ReplayEnvelopeV1; safeActions: ReplayAction[] }
  | { kind: "error"; category: "replay_unavailable" | "replay_unsupported"; fields: string[]; message: string };
```

Use `read_only` for wait, scroll, screenshot, PDF, and scrape. Use
`side_effecting` for click, write, press, and executeJavascript. Normalize the
complete `ReplayBrowserSettingsV1`; secret-bearing cookies, headers, and proxy
credentials exist only for non-ZDR rows, and proxy secrets are represented by
server-side `credentialRef`, never copied into logs, prompts, capabilities, or
URLs. New checkpoint resolution restores storage plus exact browser settings,
loads `checkpoint.finalUrl`, verifies fingerprint, and passes zero actions for
execution. Legacy resolution includes only read-only actions and returns
`replay_unsupported` naming every side-effecting or unrepresentable setting
and action index.

Define exhaustive known option keys from current `baseScrapeOptions`; ignore known output/post-processing keys, normalize known browser-affecting keys, and reject every unknown key. Do not silently drop malformed headers, locations, profiles, actions, proxy values, or future keys.

- [ ] **Step 4: Preserve compatibility wrapper**

Keep `buildReplayContextFromScrape`, `estimateReplayTimeoutSeconds`, and
`buildReplayScript` unchanged in `scrape-replay.ts` for the disabled legacy
controller. Re-export the new adapter types there, but do not route the public
controller through them in this foundation plan. Browser Service/API
integration switches to `loadScrapeReplayState` and removes script replay;
this avoids changing endpoint behavior before the new service exists.

- [ ] **Step 5: Run focused tests and build**

From `apps/api`:

```bash
pnpm vitest run src/lib/scrape-interact/replay-envelope.test.ts
pnpm build
```

Expected: all normalization and safety cases PASS; build PASS.

- [ ] **Step 6: Stage, hook, and commit**

```bash
git add apps/api/src/lib/scrape-interact/replay-envelope.ts apps/api/src/lib/scrape-interact/replay-envelope.test.ts apps/api/src/lib/scrape-interact/scrape-replay.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: define safe browser replay envelopes" -m "Normalize every retained browser-affecting scrape option into a
versioned replay contract and classify actions by effect.

Reject redacted, unknown, or unsafe legacy state instead of
replaying it."
```

### Task 5: Capture and persist post-scrape checkpoints

**Files:**
- Modify: `apps/playwright-service-ts/api.ts`
- Modify: `apps/api/src/scraper/scrapeURL/engines/index.ts`
- Modify: `apps/api/src/scraper/scrapeURL/engines/playwright/index.ts`
- Modify: `apps/api/src/scraper/scrapeURL/index.ts`
- Modify: `apps/api/src/services/worker/scrape-worker.ts`
- Modify: `apps/api/src/services/logging/log_job.ts`
- Create: `apps/api/src/lib/browser-state/filesystem-store.ts`
- Create: `apps/api/src/lib/scrape-interact/replay-store.ts`
- Create: `apps/api/src/lib/scrape-interact/replay-store.integration.test.ts`

- [ ] **Step 1: Write failing checkpoint persistence tests**

Use a temporary browser-state root and integration PostgreSQL. Assert:

- non-ZDR input writes one mode-0600 file below `replay/<owner>/<scrape>/`, inserts envelope/checkpoint rows, and loads a checksum-verified `ReplayResolution`;
- a second save atomically replaces metadata without leaving staging files;
- database failure removes the newly written file;
- traversal path IDs and symlinks are rejected;
- checksum mismatch returns `replay_unavailable` without returning storage state;
- ZDR input inserts no envelope/checkpoint and writes no file.

- [ ] **Step 2: Run test to verify red**

From `apps/api`:

```bash
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:password@127.0.0.1:55432/firecrawl pnpm vitest run src/lib/scrape-interact/replay-store.integration.test.ts
```

Expected: FAIL with missing store modules.

- [ ] **Step 3: Capture bounded state before Playwright closes**

Extend `UrlModel` with `capture_replay_checkpoint?: boolean`. Immediately after successful `scrapePage` and before `finally` closes the context, capture:

```ts
const storageState = await requestContext.storageState({ indexedDB: true });
const finalUrl = page.url();
const title = await page.title();
const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().slice(0, 65_536);
```

Also return the exact normalized context settings used by this scrape:
viewport, device scale/mobile/touch values, device name when selected, user
agent, locale, timezone, resolved geolocation and country/languages, retained
headers/cookies, proxy kind/country plus server-side credential reference,
TLS verification, ad blocking, and lockdown. Source these from validated
request/context configuration, not page-controlled JavaScript; compare the
runtime viewport to the configured value and fail capture on mismatch. Hash
title and bounded body text with SHA-256. Return `replayCheckpoint` only when
requested. Cap serialized storage state plus retained browser settings at 2
MiB; return a typed `checkpoint_too_large` error rather than truncate
cookies/origins/settings. Never log state, secret values, or fingerprint
source text.

- [ ] **Step 4: Carry capture outside public documents**

Add optional `replayCheckpoint?: ReplayCheckpointCaptureV1` to `EngineScrapeResult` and successful `ScrapeUrlResponse`, copying it beside `document`. In the Playwright engine request capture only when:

```ts
config.LOCAL_BROWSER_SERVICE_ENABLED && !meta.internalOptions.zeroDataRetention
```

Validate response with Zod. Pass `pipeline.replayCheckpoint` to `logScrape`; never attach it to `Document`, webhook payload, MinIO scrape artifact, tracing metadata, or API response.

- [ ] **Step 5: Implement root-confined atomic file store**

`BrowserStateFilesystem` accepts one absolute configured root. Export `writeCheckpoint(ownerId, scrapeId, storageState)`, `readCheckpoint(pathId, checksum)`, and `delete(pathId)`. Create directories mode `0o700`, serialize stable JSON, write a same-directory random staging file with `flag: "wx"` and mode `0o600`, fsync file, rename atomically, fsync parent directory, and return relative path ID, byte size, and SHA-256. Resolve every operation with `realpath`/parent checks; reject absolute paths, `..`, symlinks, and paths outside root.

- [ ] **Step 6: Implement transactionally linked replay store**

Export exactly:

```ts
export async function persistScrapeReplayState(input: PersistScrapeReplayStateInput): Promise<{ persisted: boolean; reason?: "disabled" | "zdr" | "checkpoint_unavailable" }>;
export async function loadScrapeReplayState(ownerId: string, scrapeId: string): Promise<ReplayResolution>;
```

If feature disabled, return `disabled`. If ZDR, return `zdr` before
normalization or filesystem work. Otherwise normalize the accepted request,
merge only trusted actual context fields from the checkpoint capture, require
all approved replay settings to be representable, write checkpoint when
capture exists, then upsert envelope/checkpoint in one PostgreSQL transaction.
Set checkpoint expiry from parent request `dr_clean_by`, falling back to
configured record-retention days only when request deadline is null. On
transaction failure, delete the new file and rethrow. Call persistence from
`logScrape` only after `scrapes` insert succeeds; log category and scrape ID,
never state content.

- [ ] **Step 7: Run focused service, API, and build tests**

From `apps/playwright-service-ts`:

```bash
pnpm build
```

From `apps/api`:

```bash
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:password@127.0.0.1:55432/firecrawl pnpm vitest run src/lib/scrape-interact/replay-store.integration.test.ts src/lib/scrape-interact/replay-envelope.test.ts
pnpm build
```

Expected: both builds and all replay tests PASS.

- [ ] **Step 8: Stage, hook, and commit**

```bash
git add apps/playwright-service-ts/api.ts apps/api/src/scraper/scrapeURL/engines/index.ts apps/api/src/scraper/scrapeURL/engines/playwright/index.ts apps/api/src/scraper/scrapeURL/index.ts apps/api/src/services/worker/scrape-worker.ts apps/api/src/services/logging/log_job.ts apps/api/src/lib/browser-state/filesystem-store.ts apps/api/src/lib/scrape-interact/replay-store.ts apps/api/src/lib/scrape-interact/replay-store.integration.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: persist post-scrape browser checkpoints" -m "Capture bounded Playwright storage and verification state before
context close, then store it atomically outside public scrape documents.

Link checksummed checkpoint files to replay envelopes in PostgreSQL."
```

### Task 6: Enforce ZDR and browser-state file retention

**Files:**
- Modify: `apps/api/src/services/local-retention-worker.ts`
- Modify: `apps/api/src/services/local-retention-worker.test.ts`
- Modify: `apps/api/src/lib/scrape-interact/replay-store.integration.test.ts`

- [ ] **Step 1: Write failing retention tests**

Extend fake and PostgreSQL retention coverage with `ExpiredBrowserStateFile` records. Assert cleanup order is browser state file, checkpoint/generation metadata CAS, operational child rows, request row. Assert file-delete failure leaves metadata and request rows for retry. Assert a missing file is treated idempotently and metadata is marked deleted. Assert a nonexpired profile generation and latest committed generation are retained.

- [ ] **Step 2: Run tests to verify red**

From `apps/api`:

```bash
pnpm vitest run src/services/local-retention-worker.test.ts
```

Expected: FAIL because retention database/file contracts do not exist.

- [ ] **Step 3: Add claimed browser file cleanup**

Add database methods:

```ts
listExpiredBrowserStateFiles(now: Date, limit: number): Promise<ExpiredBrowserStateFile[]>;
tryClaimBrowserStateFile(candidate: ExpiredBrowserStateFile, now: Date): Promise<BrowserStateFileClaim | null>;
```

Candidates include replay checkpoint paths whose request deadline has expired and profile generation paths whose `expires_at` has passed, excluding a profile's `latest_generation_id`, active session generations, and already deleted paths. Use PostgreSQL advisory locks plus checksum/path CAS, matching artifact-manifest claim semantics. Delete through `BrowserStateFilesystem` before setting `state_path = NULL, file_deleted_at = now()`. Run this phase before `deleteExpiredOperationalRows` so cascades never lose the last filesystem reference.

- [ ] **Step 4: Verify ZDR at every entry**

Keep three independent guards: Playwright capture request is false for ZDR; `persistScrapeReplayState` returns before filesystem/database access; `loadScrapeReplayState` returns `replay_unavailable` for redacted URL/options or missing envelope. Add an assertion that no browser session, run, profile mutation, activity, capability, grant, replay row, checkpoint file, or browser artifact is created from a ZDR scrape.

Browser artifact manifests reuse Phase 1 `local_artifacts`. Extend retention
coverage with a browser-run object key and assert object deletion precedes its
manifest/run/request cleanup, a delete failure remains retryable, and an
already-missing object is idempotent. Run/session expiry must use the parent
request `dr_clean_by`; never retain an artifact beyond its request.

- [ ] **Step 5: Run focused retention suite**

From `apps/api`:

```bash
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:password@127.0.0.1:55432/firecrawl pnpm vitest run src/services/local-retention-worker.test.ts src/lib/scrape-interact/replay-store.integration.test.ts
pnpm build
```

Expected: cleanup order, retry, latest-generation retention, ZDR, integration, and build checks PASS.

- [ ] **Step 6: Stage, hook, and commit**

```bash
git add apps/api/src/services/local-retention-worker.ts apps/api/src/services/local-retention-worker.test.ts apps/api/src/lib/scrape-interact/replay-store.integration.test.ts
apps/api/.husky/_/pre-commit
git commit -m "feat: retain and purge browser state safely" -m "Delete claimed checkpoint and profile files before database
retention loses their references, with idempotent retry and generation
safety.

Prove zero-data-retention scrapes create no durable browser state."
```

### Task 7: Add disabled rollout configuration and private volume

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/lib/local-runtime-config.ts`
- Modify: `apps/api/src/lib/local-runtime-config.test.ts`
- Modify: `apps/api/src/lib/browser-state/filesystem-store.ts`
- Modify: `apps/api/src/harness.ts`
- Modify: `compose.local.yaml`
- Modify: `.env.example.local`

- [ ] **Step 1: Write failing config tests**

Assert default `LOCAL_BROWSER_SERVICE_ENABLED=false`; enabled mode requires
`LOCAL_PERSISTENCE_ENABLED=true` and an absolute, non-root
`LOCAL_BROWSER_STATE_ROOT`; disabled mode does not require a usable root.
Reject `/` and relative paths. Filesystem health, not pure config parsing,
verifies that the root exists and is writable at startup.

- [ ] **Step 2: Run test to verify red**

From `apps/api`:

```bash
pnpm vitest run src/lib/local-runtime-config.test.ts
```

Expected: FAIL because browser configuration fields are absent.

- [ ] **Step 3: Add disabled configuration**

Add:

```ts
LOCAL_BROWSER_SERVICE_ENABLED: z.stringbool().default(false),
LOCAL_BROWSER_STATE_ROOT: emptyStringAsDefault(
  z.string().default("/var/lib/firecrawl-browser"),
),
```

In `compose.local.yaml`, set `LOCAL_BROWSER_SERVICE_ENABLED: "false"`, pass root, mount `browser-state:/var/lib/firecrawl-browser`, and declare the named volume. Do not publish a port or add Browser Service yet. Add both variables to `.env.example.local` with disabled default.

When enabled, `harness.ts` must call `BrowserStateFilesystem.health()` before
recovery. Health creates, fsyncs, and removes one mode-0600 probe below the
configured root. Failure aborts startup with `browser_state_unavailable`.

- [ ] **Step 4: Run config, compose, and build validation**

From `apps/api`:

```bash
pnpm vitest run src/lib/local-runtime-config.test.ts
pnpm build
```

From repository root:

```bash
docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet
```

Expected: tests/build PASS and Compose config exits 0 with only API published.

- [ ] **Step 5: Stage, hook, and commit**

```bash
git add apps/api/src/config.ts apps/api/src/lib/local-runtime-config.ts apps/api/src/lib/local-runtime-config.test.ts apps/api/src/lib/browser-state/filesystem-store.ts apps/api/src/harness.ts compose.local.yaml .env.example.local
apps/api/.husky/_/pre-commit
git commit -m "chore: gate local browser state rollout" -m "Keep browser state capture and recovery disabled by default while
wiring a validated private state root and named volume.

Reject enabled configurations that lack durable local persistence."
```

### Task 8: Run foundation acceptance gates

**Files:**
- Verify only; no new files expected.

- [ ] **Step 1: Re-run Codex gate zero**

```bash
node scripts/codex-browser-gate/run.mjs
```

Expected: PASS with exactly one side-effecting MCP call.

- [ ] **Step 2: Run all focused API tests**

From `apps/api`:

```bash
TEST_APPLICATION_DATABASE_URL=postgresql://firecrawl:password@127.0.0.1:55432/firecrawl pnpm vitest run src/db/migrate.integration.test.ts src/lib/browser-state/transitions.test.ts src/lib/browser-state/store.integration.test.ts src/lib/scrape-interact/replay-envelope.test.ts src/lib/scrape-interact/replay-store.integration.test.ts src/services/local-retention-worker.test.ts src/controllers/v2/__tests__/browser-billing.test.ts src/lib/local-runtime-config.test.ts
pnpm build
```

Expected: all focused tests and TypeScript build PASS.

- [ ] **Step 3: Run Playwright and Compose checks**

From `apps/playwright-service-ts`:

```bash
pnpm build
```

From repository root:

```bash
docker compose --project-name firecrawl --project-directory . -f compose.yaml config --quiet
docker compose --project-name firecrawl --project-directory . -f compose.yaml ps --format json
```

Expected: build/config PASS; published port list contains only loopback API port. Do not enable the feature or expect Browser/Interact success yet.

- [ ] **Step 4: Remove the isolated integration database**

From repository root:

```bash
docker compose --project-name firecrawl-browser-test --project-directory . -f compose.browser-test.yaml down --volumes
```

Expected: test container, network, and disposable volume are removed. Never run
this command against the `firecrawl` project or `compose.yaml`.

- [ ] **Step 5: Run actual hook on clean staged state**

```bash
apps/api/.husky/_/pre-commit
git status --short
```

Expected: hook exits 0 and status is clean. If verification changes files, inspect and commit them using the same literal-message procedure before handing off.

## Foundation completion boundary

Stop after Task 8. This plan deliberately does not create Browser Service, live-view/CDP proxy, Codex host adapter, private Browser MCP, `runc` code runner, or public controller integration. Foundation is complete only when gate zero passes and durable state/replay capture works behind `LOCAL_BROWSER_SERVICE_ENABLED=false`. Continue with Browser Service/API and host execution plans next.
