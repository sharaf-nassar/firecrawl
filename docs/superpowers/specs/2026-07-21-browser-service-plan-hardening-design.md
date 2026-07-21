# Browser Service Plan Hardening Design

**Date:** 2026-07-21

**Status:** Approved design addendum for
`2026-07-19-browser-service-and-api.md`

## Context

The Browser Service/API plan is the next stage after the durable browser-state
foundation. Preflight found two execution hazards and one startup deadlock in
the existing plan:

1. The active shell runs Node `25.8.2`, while the installed compatible runtime
   selected for this service is Node `22.22.1`. The active Node does not expose
   `corepack`; an unqualified `node`, `pnpm`, `tsx`, or `tsc` command can build
   an artifact under the wrong runtime.
2. The plan names pnpm and Playwright versions but does not make dependency
   acquisition, the frozen install, or the container image digest part of the
   acceptance boundary.
3. Browser Service readiness requires reconciliation with PostgreSQL, but the
   service must not receive database credentials. Waiting for ready before the
   API starts, while also requiring the API to perform reconciliation, creates
   a readiness circle.

This addendum hardens those boundaries without changing the approved public
Browser/Interact API, execute-once action model, private-network topology, or
disabled rollout default.

## Goals

- Make every Browser Service install, test, build, and runtime check use Node
  `22.22.1` deliberately.
- Produce a frozen dependency graph with pnpm `10.33.0`.
- Keep Playwright package and container browsers at exactly `1.61.1`, with an
  immutable container base.
- Make PostgreSQL remain the only authority for retained browser-state files.
- Start Browser Service without database credentials, then reconcile it before
  any browser work can begin.
- Make restart, retry, filesystem cleanup, and failure behavior deterministic
  and fail closed.

## Non-goals

- No Browser Service, Chromium, API route, database, Compose, test, or package
  implementation belongs in this design-document change.
- Reconciliation does not resume Chromium processes, model threads, actions,
  or code runners after a restart.
- Reconciliation is not a public recovery, backup, restore, or file-browsing
  API.
- Browser Service never queries PostgreSQL and never receives a PostgreSQL URL,
  database password, migration permission, or arbitrary SQL result.
- This addendum does not enable `LOCAL_BROWSER_SERVICE_ENABLED` or publish a
  Browser Service port.
- This addendum does not revise host execution beyond recording the required
  rolling-Codex follow-up.

## Locked toolchain

### Host commands

Node `22.22.1` is already installed through the existing local Node version
manager. Every Browser Service dependency, test, and build command must select
that exact installed runtime before executing. Implementation must not scan for
another Node, download Node, change the user's default Node, or use the active
Node `25.8.2` by accident.

The package declares:

```json
{
  "engines": { "node": "22.22.1" },
  "packageManager": "pnpm@10.33.0"
}
```

A dependency-free preflight runs before install, test, build, and start. It
requires `process.version === "v22.22.1"` and fails with a stable
`browser_service_runtime_mismatch` category otherwise. Tests exercise both the
accepted version and wrong-version path. Scripts must not relax this to a Node
major range.

Use the Corepack binary shipped with installed Node `22.22.1`. Invoke pnpm
through Corepack from `apps/browser-service`, where the exact
`packageManager` field applies. Do not run `npm install -g`, `pnpm setup`,
`corepack use`, or a global Corepack install. Corepack may acquire the pinned
pnpm release as a normal implementation dependency step.

Implementation order is fixed:

1. Select installed Node `22.22.1` and prove the exact version.
2. Create package metadata with `packageManager: pnpm@10.33.0`.
3. Use Corepack/pnpm `10.33.0` to generate `pnpm-lock.yaml` once.
4. Remove any generated `node_modules`, then run a frozen-lockfile install.
5. Run local `tsx`, Node tests, and `tsc` only through that frozen install.
6. Re-run exact Node and pnpm identity checks in acceptance.

Dependency acquisition for steps 3 and 4 is authorized as a normal plan step.
No global package install is authorized.

Corepack resolves a project's package manager from `packageManager` and can
install that project-scoped release without changing the global default:
[Corepack README](https://github.com/nodejs/corepack/blob/main/README.md).

### Container runtime

Playwright stays exactly `1.61.1` in `package.json` and the lockfile. The final
container uses the Noble image
`mcr.microsoft.com/playwright:v1.61.1-noble` with an immutable manifest-list or
platform digest resolved during implementation and committed in the
Dockerfile. A mutable tag alone is forbidden.

The Docker build stage uses Node `22.22.1`. The final Playwright image must run
the service with Node `22.22.1`; if its vendor Node differs, the Dockerfile
copies the exact Node runtime from the build/runtime stage rather than
accepting drift or downloading another Node. Container acceptance asserts the
Node version before starting the service.

The image check parses all Dockerfile `FROM` references and fails when the
Playwright runtime lacks `@sha256:...`, the tag is not
`v1.61.1-noble`, package/lock Playwright versions are not exactly `1.61.1`, or
the built image reports another Playwright or Node version. A no-cache rebuild
must produce the same selected base digest and pass the same checks.

Playwright documents that its package is installed separately from the image,
remote package and image versions must match, and images should be pinned to a
specific version: [Playwright Docker](https://playwright.dev/docs/docker).

## Two-phase startup

### State machine

Browser Service has these process-local startup states:

```text
starting -> live_unreconciled -> reconciling -> ready
                 ^                 |
                 +------failed-----+
ready -> draining -> stopped
```

`live_unreconciled` means configuration, private authentication, listener, and
browser-state root checks passed. It does not permit session creation, profile
publication, actions, artifacts, grants, streams, or Chromium launch.

`ready` is process-local. It is valid only for the current service process
nonce and one successfully reconciled snapshot digest. A service restart
always returns to `live_unreconciled`; readiness is never loaded from disk.

### Process nonce and health

At process start, Browser Service generates 32 random bytes using the operating
system cryptographic RNG and encodes them as an unpadded, 43-character base64url
`processNonce`. The nonce is never persisted or logged and changes on every
process start.

Both health routes use the same bearer key, correlation ID, and bounded
deadline authentication as every private route. They are never public.

- `GET /health/live` returns 200 in `live_unreconciled`, `reconciling`, or
  `ready`, with strict `{ version: 1, status, processNonce }` JSON.
- `GET /health/ready` returns 503 until reconciliation succeeds. Its strict
  body includes `{ version: 1, status: "unready", processNonce, category }`.
- Once ready, `GET /health/ready` returns 200 with strict
  `{ version: 1, status: "ready", processNonce, snapshotDigest }` JSON.

No public browser ID, runtime session ID, relay grant, capability, path,
checksum, service key, or database identifier appears in health responses.

### Reconciliation endpoint

Add authenticated `POST /v1/reconciliation`. Task 1 defines its strict Zod 4
schemas and typed errors but does not mount the route or touch Chromium,
PostgreSQL, or the filesystem. All objects use `z.strictObject()`; unknown
fields fail. Zod 4 documents that strict objects reject unknown keys:
[Zod strict objects](https://zod.dev/api#strictobject).

The request is:

```ts
type ReconciliationRequestV1 = {
  version: 1;
  processNonce: string;
  snapshotDigest: string;
  references: Array<{
    kind:
      | "replay_checkpoint"
      | "profile_generation"
      | "replay_checkpoint_cleanup_intent";
    id: string;
    path: string;
    checksum: string;
  }>;
};
```

Bounds and canonical form are exact:

- `processNonce` is unpadded base64url for exactly 32 bytes.
- `snapshotDigest` and every checksum are lowercase SHA-256 hex.
- `id` is a canonical lowercase UUID.
- `path` is root-relative, slash-separated UTF-8, at most 1,024 bytes, with no
  empty, `.`, `..`, backslash, absolute, NUL, or control segment.
- At most 25,000 references and 16 MiB of request JSON are accepted.
- `(kind, id)` is unique. Repeated paths must carry the same checksum;
  conflicting aliases reject the entire request.
- The API sorts references by `kind`, then `id`, then `path`. It serializes a
  fixed-key, whitespace-free JSON object containing `version` and
  `references`, excluding `processNonce` and `snapshotDigest`, and hashes those
  UTF-8 bytes. Browser Service independently repeats this canonicalization and
  rejects a digest mismatch.

The successful strict response is:

```ts
type ReconciliationResultV1 = {
  version: 1;
  processNonce: string;
  snapshotDigest: string;
  retained: number;
  removed: number;
  missing: 0;
  corrupt: 0;
  ready: true;
};
```

Reconciliation inspects at most 25,000 managed filesystem entries in addition
to the 25,000 request references; exceeding either cap fails before deletion.
Response counts are nonnegative safe integers no greater than 25,000 each. API
accepts the result only when nonce and digest equal its request and all result
fields pass the closed schema.

The authenticated service key proves the caller is the API. The nonce binds a
request to one live Browser Service process; it is not a caller capability.
Wrong, stale, or malformed nonces return `reconciliation_nonce_mismatch` and
cannot alter the filesystem or readiness.

For one process nonce:

- First successful digest becomes the ready digest.
- Exact same nonce and digest retry returns the cached successful result and
  performs no second deletion.
- Same nonce with a different digest returns
  `reconciliation_conflicting_replay`, leaves current readiness unchanged, and
  performs no filesystem work.
- A failed attempt is not cached as success. Exact retry may finish recovery
  from its safe quarantine state.

### API snapshot authority

API owns the reconciliation coordinator. Browser Service receives no database
client. Before snapshot capture, API runs migrations and existing browser
startup recovery so unfinished runs/sessions become interrupted, capabilities
and grants are revoked, and dead writer leases are cleared.

The API keeps a closed `BrowserStartupGate` during recovery, snapshot capture,
and reconciliation. While closed, all Browser/Interact creation or execution
returns typed `browser_state_unavailable`; browser-state retention and every
browser filesystem/database mutator wait. No cloud, Gemini, or stateless
fallback is allowed.

API then opens a read-only `REPEATABLE READ` PostgreSQL transaction and reads
all nondeleted file authorities:

- every `browser_replay_checkpoints` row with a non-null `state_path` and null
  `file_deleted_at`;
- every `browser_profile_generations` row with a non-null `state_path` and null
  `file_deleted_at`, including latest and active-session generations;
- every unresolved `browser_replay_checkpoint_cleanup_intents` row, because
  retention owns deletion of those old checkpoint generations.

Each row maps only to `{ kind, id, path, checksum }`. The transaction verifies
required values, caps, canonical paths, alias consistency, and digest before
commit. An invalid or oversized authority set aborts startup; it is never
truncated.

The closed gate makes the committed snapshot stable until reconciliation
finishes. Only after API validates a successful response and authenticated
`/health/ready` reports the same nonce/digest may it open browser work and
start browser retention.

## Filesystem reconciliation

Browser Service validates the complete request before destructive work. For
each reference it resolves from the configured canonical root, rejects any
symlink or root escape, requires the expected regular file or profile
generation directory shape, and verifies the type-specific canonical SHA-256.
Directory walks reject symlinks, special files, unexpected hard links, and
entries outside the committed profile-generation grammar.

If any authoritative reference is missing, corrupt, unsafe, or unreadable,
reconciliation fails, readiness remains false, and nothing is deleted.

After all authorities validate, Browser Service enumerates only checked-in
managed namespaces and computes an in-memory plan. It retains every listed
path, including cleanup intents and current/latest/active generations. It may
remove only an unreferenced, recognized service-owned committed, staging,
working, or checkpoint entry older than the existing 10-minute grace period.
Unknown names fail readiness and are never guessed or deleted.

Removal first atomically renames each candidate within the same canonical root
to a nonce-scoped quarantine name, fsyncs the parent, then deletes the
quarantine entry and fsyncs again. A partial failure leaves readiness false;
retry with the same nonce/digest can continue idempotently. Readiness flips to
true exactly once, only after the whole validated plan completes. No cleanup is
started from a partial, stale, wrong-nonce, or conflicting snapshot.

Once the API opens its gate, normal retention again owns cleanup-intent files
and database compare-and-set updates. Browser Service startup reconciliation
does not clear database paths, cleanup intents, or `file_deleted_at`; it only
removes proven filesystem orphans absent from the authoritative snapshot.

## Startup, restart, and shutdown ordering

Compose and harness use this order:

1. Start Browser Service privately and wait only for authenticated live health.
2. Start API with browser work and browser retention gated.
3. API opens PostgreSQL, applies migrations, and runs startup recovery.
4. API reads `processNonce`, captures and commits one consistent snapshot, and
   posts it with service authentication, correlation ID, and bounded deadline.
5. Browser Service validates all authorities, reconciles the filesystem, and
   returns counts plus the canonical digest.
6. API verifies the response and authenticated ready health, then opens browser
   work and starts browser retention.

The reconciliation request uses the private request deadline capped at 60
seconds. Timeout, transport loss, authentication failure, database error,
invalid response, or unready result keeps the gate closed. Compose/harness
startup fails after its bounded retry budget and performs registered cleanup.

API continuously checks the authenticated ready nonce. If Browser Service
restarts, the changed nonce closes the gate immediately. API repeats startup
recovery and reconciliation under a single-process mutex before reopening it.
No existing session is resumed. Simultaneous detection coalesces into that one
attempt.

On graceful Browser Service shutdown, it enters `draining`, rejects new work,
finishes or classifies in-flight work through the existing ordered shutdown,
closes Chromium, and never changes the reconciliation snapshot. Forced
shutdown cannot promote or delete a generation. A replacement process has a
new nonce and must reconcile again.

## Failure categories and logging

Private typed categories include:

- `browser_service_runtime_mismatch`
- `reconciliation_required`
- `reconciliation_nonce_mismatch`
- `reconciliation_conflicting_replay`
- `reconciliation_snapshot_invalid`
- `reconciliation_snapshot_too_large`
- `reconciliation_reference_missing`
- `reconciliation_reference_corrupt`
- `reconciliation_filesystem_unsafe`
- `reconciliation_cleanup_failed`
- `reconciliation_deadline_exceeded`

Public API maps all reconciliation/startup failures to the existing sanitized
`browser_state_unavailable` response. Logs are bounded structured records with
category, correlation ID, state, aggregate counts, duration, and success/fail
status. They never include paths, reference IDs, checksums, nonce, bearer key,
database URL, private service URL, profile name, public browser ID, capability,
or relay grant. Error causes are reduced to allowlisted categories before
logging.

## Plan impact and task boundaries

### Task 1

Task 1 adds exact package metadata, Node/pnpm preflight, frozen lock workflow,
strict reconciliation request/result and health schemas, typed errors, private
authentication, and tests. It does not start Express, Chromium, PostgreSQL,
Compose, or filesystem reconciliation.

Use Zod 4 `z.strictObject()` instead of legacy `.strict()` for new closed
objects. Express remains major version 5; its official API supports Node 18 and
newer, so selected Node 22 is supported:
[Express 5 API](https://expressjs.com/en/api/).

### Task 3 before profile readiness

Task 3 implements the process nonce, reconciliation engine, quarantine-safe
filesystem plan, and readiness latch before session/profile registry can
become ready. Profile/session creation remains impossible until reconciliation
succeeds. Its tests use fixture roots and injected snapshots; no database
credentials enter Browser Service.

### Task 5

Task 5 mounts authenticated live, ready, and reconciliation routes, applies
body/deadline bounds, connects ready state to server admission, and implements
ordered shutdown. Its Dockerfile resolves and pins the Playwright digest,
preserves exact Node `22.22.1`, installs from the frozen lock, and adds image
reproducibility/version tests.

### API client task

The typed Browser Service client adds closed live/ready/reconcile methods. API
adds the startup gate, repeatable-read snapshot loader, recovery ordering, and
nonce-change re-reconciliation. This work lands before controllers can accept
browser work.

### Task 12

Task 12 no longer waits for ready before API spawn. Harness and Compose first
wait for authenticated live health, then API performs reconciliation, then the
orchestrator waits for API-confirmed Browser Service readiness. Cleanup remains
registered before the first health wait. Only API publishes a host port.

### Host plan follow-up

Before executing host plan Task 5, revise stale Codex `0.144.5` pins to consume
the approved rolling installed-Codex contract. Keep model, reasoning effort,
schema, safety, lifecycle, and capability gates pinned; do not restore an exact
Codex CLI version requirement.

## Tests and acceptance

New tests in the implementation plan must prove:

- exact Node `22.22.1` succeeds and wrong runtimes fail before install/test/
  build/start;
- Corepack selects pnpm `10.33.0`, frozen install succeeds, and lock mutation
  or missing lock fails;
- Playwright package, lock, image tag, immutable digest, and built runtime all
  match `1.61.1`, including a no-cache rebuild;
- live health succeeds before reconciliation while ready health and every
  browser route fail closed;
- health and reconciliation reject missing auth, expired deadlines, unknown
  fields, malformed nonce/hash/path, excess references, and excess bytes;
- stale/wrong nonce and conflicting same-nonce replay perform zero filesystem
  changes;
- exact same nonce/digest retry is idempotent and returns the same result;
- one repeatable-read snapshot includes checkpoints, profile generations,
  active/latest generations, and unresolved cleanup intents;
- missing or corrupt authoritative files cause zero deletion and remain
  unready;
- traversal, absolute paths, symlinks, special files, hard-link ambiguity, and
  checksum aliases fail closed;
- only recognized, unreferenced entries older than 10 minutes enter quarantine;
- partial quarantine/delete failure remains unready and exact retry completes;
- API opens browser work and retention only after matching response and ready
  health nonce/digest;
- service restart changes nonce, closes the API gate, interrupts old runtime
  work, and requires reconciliation again;
- graceful and forced shutdown never promote an orphan or delete a referenced
  generation;
- logs contain aggregate metadata but no path, nonce, checksum, key, URL,
  capability, grant, or browser identity.

Acceptance also runs Task 1 focused tests/build, Task 3 reconciliation/profile
tests, Task 5 server/image tests, API client/startup tests, Task 12 harness and
Compose checks, the actual repository hook, and a clean-tree check. Tests use
Node `22.22.1` and the frozen install. Browser Service remains private and
disabled by default.

## Rejected alternatives

### Give Browser Service database credentials

Rejected. It duplicates query and migration authority, expands secret scope,
and lets a browser-owning process make retention decisions directly.

### Let Browser Service become ready before reconciliation

Rejected. Sessions could observe or delete state before PostgreSQL authority is
known, making restart safety timing-dependent.

### Have Compose wait for ready before starting API

Rejected. API is the only component allowed to read the authoritative database
snapshot, so this recreates the readiness circle.

### Send public browser IDs or capabilities in the snapshot

Rejected. Reconciliation needs only opaque database-row identity, confined
path, kind, and checksum. Public/session authority does not belong in the
filesystem protocol.

### Accept a mutable Playwright tag or version range

Rejected. A changed browser image or package can silently break executable
lookup and persistent-context compatibility despite an unchanged source tree.

### Delete unknown or merely unreferenced paths immediately

Rejected. Unknown paths may reflect a future schema or interrupted writer.
Only recognized entries absent from a fully validated snapshot and older than
the grace period are eligible.

### Cache failed reconciliation as terminal

Rejected. Quarantine cleanup is intentionally retryable. Only a successful
nonce/digest result is cached; conflicting replay remains a hard failure.
