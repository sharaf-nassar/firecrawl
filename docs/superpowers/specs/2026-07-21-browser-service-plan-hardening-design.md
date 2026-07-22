# Browser Service Plan Hardening Design

**Date:** 2026-07-21

**Status:** Approved design addendum for
`2026-07-19-browser-service-and-api.md`

## Context

The Browser Service/API plan is the next stage after the durable browser-state
foundation. Preflight found two execution hazards, one startup deadlock, and
one restart-fencing gap in the existing plan:

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
4. A Browser Service process can outlive an API process. Reusing only its
   stable process nonce prevents a restarted API from reconciling changed
   durable state and leaves the old API able to mutate surviving Chromium
   sessions, grants, streams, writers, and profile working copies.

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
- Fence every API process with a service-minted control generation obtained
  only after complete Browser Service runtime drain.
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
starting -> live_unreconciled -> handoff_pre_mint -> handoff_minted
                                      |                    |
                          drain failed|                    v
                                      v             live_unreconciled
                                handoff_failed
                                      |
                         fresh tuple/full redrain
                                      v
                              handoff_pre_mint
handoff_pre_mint(orphan) --fresh tuple/same drain--> handoff_pre_mint
live_unreconciled -> reconciling -> ready
                         |           |
                         +--failed---+
ready -> handoff_pre_mint
ready -> draining -> stopped
```

`live_unreconciled` means configuration, private authentication, listener, and
browser-state root checks passed. It does not permit session creation, profile
publication, actions, artifacts, grants, streams, or Chromium launch.

`ready` is process-local and generation-scoped. It is valid only for the
current service process nonce, current control-generation nonce, and one
successfully reconciled snapshot digest. An API takeover keeps the process
nonce stable but closes admission, drains service runtime state, clears
readiness/cache, and mints a new generation. A service restart changes process
nonce, invalidates every generation, and returns to `live_unreconciled`;
readiness is never loaded from disk.

`handoff_pre_mint` is one mutex-owned wave, not one HTTP request. An orphaned
owner leaves that wave and shared drain intact until a fresh tuple adopts it,
the drain fails, or service shutdown destroys the process. `handoff_minted` is
the atomic commit point: after it, ownership cannot be superseded and exact
tuple replay returns the cached generation.

### Process nonce, control generation, and health

At process start, Browser Service generates 32 random bytes using the operating
system cryptographic RNG and encodes them as an unpadded, 43-character base64url
`processNonce`. The nonce is never persisted or logged and changes on every
process start. It remains stable for that complete service-process lifetime;
API-only restart never changes it.

Each API process generates one canonical UUID `apiInstanceId`. For each
observed Browser Service process, it also generates one 32-byte base64url
idempotency key. Authenticated `POST /v1/control-generations` carries the
observed process nonce and that exact pair. Under one process-local handoff
mutex, Browser Service owns one handoff wave: current tuple owner, owner
transport liveness and absolute deadline, one shared drain promise, phase
`pre_mint | minted | failed`, and bounded tuple tombstones. First owner closes admission
synchronously, aborts in-flight reconciliation, clears readiness/cache, and
starts exactly one physical drain/close operation. That service-owned promise
closes/revokes every session, Chromium context, stream, relay grant, writer,
timer, and uncommitted profile working copy and continues independently if its
owner HTTP transport dies.

Before mint, an owner whose transport aborts/closes or deadline expires is
orphaned. A fresh authenticated tuple with a new canonical API instance ID and
idempotency key may atomically supersede only that orphaned current owner,
adopt/await the same drain promise, and
tombstone the old tuple as `control_generation_superseded`; it never starts a
second drain. Every handler checks ownership under the mutex after each await
and immediately before mint. The old handler and exact old-tuple retries
therefore return superseded and can never mint, regain ownership, or resurrect
readiness. Further replacements may supersede only the newly current owner
after it too becomes orphaned. A different tuple presented while owner remains
live gets `control_generation_in_progress` and cannot steal the wave.

An exact concurrent request may await the result while its tuple owner remains
live but does not become another owner. Once owner is orphaned and before a
fresh tuple supersedes it, exact retry returns
`control_generation_in_progress` without reviving ownership. After
supersession, exact old-tuple retry deterministically returns
`control_generation_superseded`.

When the shared drain completes, current live owner alone atomically changes
phase to `minted`, caches the response, and publishes a new random 32-byte
base64url `controlGenerationNonce`. After mint, no supersession is permitted.
Exact completed `(processNonce,apiInstanceId,idempotencyKey)` replay returns
the cached result after response loss without another drain or mint. A later
different tuple starts the next normal full handoff. A failed physical drain
mints nothing and atomically enters immutable `failed`, clears active-wave
ownership, and leaves admission closed/unready. The failed tuple caches one
private 503 `control_generation_drain_failed` response in the standard closed
`version/category/message` envelope. Its allowlisted internal detail code is
`close_failed | close_deadline_exceeded | drain_invariant_failed`; raw causes
and that detail never enter the response. Exact failed-tuple replay returns the
byte-identical response without redraining. A fresh identity/key starts a
brand-new full physical drain: it re-enumerates every resource and reruns all
idempotent close/revoke/discard steps. Already absent resources converge, but
no partial cursor, rejected promise, admission object, or partial success is
reused. A failed replacement never restores a superseded predecessor. Reusing
one identity/key with a different partner remains
`control_generation_conflict`.

Accepted pending, superseded, failed, and completed tuple/result tombstones remain
process-local and non-evicting for service-process lifetime, capped at 1,024
distinct tuples. Reserve capacity before accepting a first or replacement
owner. At capacity, exact completed replay succeeds, exact superseded replay
returns superseded, exact failed replay returns its cached 503, and an unknown tuple fails
`control_generation_history_exhausted` without ownership change, drain, or
mint. An orphan then requires service restart for a fresh process namespace.
After completed A then B, replay A returns A's historical response but cannot
replace current B generation. Neither nonce is persisted or logged.

Both health routes use the same bearer key, correlation ID, and bounded
deadline authentication as every private route. They are never public.

- Initial `GET /health/live` discovery returns 200 with strict
  `{ version: 1, status, processNonce }` JSON and never reveals a generation.
- After handoff, scoped live health requires both fencing headers and adds the
  exact `controlGenerationNonce` to its strict response.
- Generation-scoped `GET /health/ready` returns 503 until reconciliation
  succeeds. Its strict body includes `{ version: 1, status: "unready",
  processNonce, controlGenerationNonce, category }`. Missing/stale fencing
  headers return the standard typed error envelope, never an unscoped health
  body.
- Once ready, `GET /health/ready` returns 200 with strict
  `{ version: 1, status: "ready", processNonce, controlGenerationNonce,
  snapshotDigest }` JSON.

Every private request after handoff, including scoped health, reconciliation,
session, action, grant, artifact, stream, profile, and close, carries exact
`x-firecrawl-process-nonce` and
`x-firecrawl-control-generation-nonce` headers. Service validates both before
body parsing, mutation, writer acquisition, or stream upgrade. Stale
generation returns typed rejection with zero effect; an old API never learns
the replacement generation from discovery health.

No public browser ID, runtime session ID, relay grant, capability, path,
checksum, service key, or database identifier appears in health responses.

### Control-generation and reconciliation endpoints

Add authenticated `POST /v1/control-generations` and
`POST /v1/reconciliation`. Task 1 defines their strict Zod 4 schemas and typed
errors but does not mount routes or touch Chromium, PostgreSQL, or the
filesystem. All objects use `z.strictObject()`; unknown fields fail. Zod 4
documents that strict objects reject unknown keys:
[Zod strict objects](https://zod.dev/api#strictobject).

The control-generation request/result are:

```ts
type CreateControlGenerationV1 = {
  version: 1;
  processNonce: string;
  apiInstanceId: string;
  idempotencyKey: string;
};
type ControlGenerationV1 = {
  version: 1;
  processNonce: string;
  controlGenerationNonce: string;
  apiInstanceId: string;
};
```

The request is:

```ts
type ReconciliationRequestV1 = {
  version: 1;
  processNonce: string;
  controlGenerationNonce: string;
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

- Both nonce fields and `idempotencyKey` are unpadded base64url for exactly
  32 bytes; `apiInstanceId` is a canonical lowercase UUID.
- `snapshotDigest` and every checksum are lowercase SHA-256 hex.
- `id` is a canonical lowercase UUID.
- `path` is root-relative, slash-separated UTF-8, at most 1,024 bytes, with no
  empty, `.`, `..`, backslash, absolute, NUL, or control segment.
- At most 25,000 references and 16 MiB of request JSON are accepted.
- `(kind, id)` is unique. Repeated paths must carry the same checksum;
  conflicting aliases reject the entire request.
- The API sorts references by `kind`, then `id`, then `path`. It serializes a
  fixed-key, whitespace-free JSON object containing `version` and
  `references`, excluding `processNonce`, `controlGenerationNonce`, and
  `snapshotDigest`, and hashes those UTF-8 bytes. Browser Service independently
  repeats this canonicalization and rejects a digest mismatch.

The successful strict response is:

```ts
type ReconciliationResultV1 = {
  version: 1;
  processNonce: string;
  controlGenerationNonce: string;
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
accepts the result only when process nonce, generation nonce, and digest equal
its request and all result fields pass the closed schema.

The authenticated service key proves the caller is an API. Process nonce binds
to one live Browser Service process; control generation fences API ownership.
Wrong, stale, or malformed process/generation values return
`reconciliation_nonce_mismatch` or `control_generation_mismatch` and cannot
alter filesystem or readiness.

For one process/control generation:

- First successful digest becomes the ready digest.
- Exact same process/generation/digest retry returns cached successful result and
  performs no second deletion.
- Same process/generation with a different digest returns
  `reconciliation_conflicting_replay`, leaves current readiness unchanged, and
  performs no filesystem work.
- A completed new generation under the same process permits a new digest only
  because handoff proved all prior service runtime closed and cleared cache.
- A failed attempt is not cached as success. Exact retry may finish recovery
  from its safe quarantine state.

### API snapshot authority

API owns the reconciliation coordinator. Browser Service receives no database
client. On every enabled API startup, including first startup, API first keeps
its gate closed, discovers process-only live health, and completes one control
handoff. Only after Browser Service confirms its complete runtime drain may API
run migrations and existing browser startup recovery so unfinished durable
runs/sessions become interrupted, capabilities and grants are revoked, and
dead writer leases are cleared. API never claims Chromium interruption from
database recovery; handoff proves service runtime closure first.

The API keeps a closed `BrowserStartupGate` during handoff, migrations,
recovery, snapshot capture, and reconciliation. While closed, all
Browser/Interact creation or execution
returns typed `browser_state_unavailable`; browser-state retention and every
browser filesystem/database mutator wait. No cloud, Gemini, or stateless
fallback is allowed.

Service fencing alone cannot stop a paused old API from resuming a local
filesystem/database mutation. Migration
`0007_browser_control_generation.sql` therefore creates one singleton durable
fence with positive monotonic database epoch, process nonce, control-generation
nonce, API instance UUID, and activation timestamp. After handoff and
migrations but before recovery, new API locks this row, verifies proposed
generation through scoped service health while lock is held, increments epoch,
commits, and verifies scoped health again. A superseded handoff cannot recover
or open its gate.

Every browser-state durable mutator begins a database transaction, locks that
singleton row `FOR UPDATE`, requires exact API/process/generation/epoch, and
holds lock/transaction across all filesystem effects plus matching database
CAS. New generation activation therefore waits for a previously admitted old
mutation to finish; its result is included in later snapshot. After epoch
increment, every old mutation fails before filesystem effect even if old API's
process-local gate has not yet observed service rejection. Process-local gate
remains immediate admission optimization, never sole cross-process fence.

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
`/health/ready` reports the same process/generation/digest may it open browser
work and start browser retention.

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
to `quarantine/<processNonce>/<controlGenerationNonce>/<full-source-path>`,
fsyncs the parent, then deletes the quarantine entry and fsyncs again. A
partial failure leaves readiness false; retry with the same
process/generation/digest can continue idempotently. A later generation may
validate and finish an old-generation quarantine only after its complete new
authority snapshot proves the original path is unreferenced. Readiness flips
to true exactly once, only after the whole validated plan completes. No cleanup
starts from a partial, stale, wrong-generation, or conflicting snapshot.

Once the API opens its gate, normal retention again owns cleanup-intent files
and database compare-and-set updates. Browser Service startup reconciliation
does not clear database paths, cleanup intents, or `file_deleted_at`; it only
removes proven filesystem orphans absent from the authoritative snapshot.

## Startup, restart, and shutdown ordering

Compose and harness use this order:

1. Start long-running dependencies and Browser Service privately, then wait
   only for authenticated Browser Service live health.
2. Run and verify required MinIO bucket initialization.
3. Start API with browser work and browser retention gated. Normal startup does
   not invoke the application migration sidecar.
4. API discovers `processNonce`, generates one process-lifetime
   `apiInstanceId` plus one handoff idempotency key, and posts the authenticated
   control-generation request.
5. Browser Service closes admission synchronously, aborts reconciliation,
   clears ready/cache, fully drains service runtime, then returns a newly
   minted `controlGenerationNonce` with the unchanged process nonce.
6. Only after confirmed handoff, API opens PostgreSQL, applies migrations,
   activates its durable singleton control epoch after older mutations drain,
   and runs startup recovery under its closed/drained gate.
7. API captures and commits one consistent snapshot and posts it with both
   nonces, service authentication, correlation ID, and bounded deadline.
8. Browser Service validates generation and authorities, reconciles the
   filesystem, and returns counts plus matching process/generation/digest.
9. API verifies response and scoped ready health, then opens browser work and
   starts browser retention.

API process owns application migration ordering. Harness may create and
health-check disposable PostgreSQL but never calls application migrations.
Rendered local Compose API has no dependency on a pre-API migration sidecar.
Before control handoff succeeds, bootstrap performs no database connect/query,
DB-backed browser-store construction, listener bind, worker start, or
retention start. A lazily constructed pool/gate is allowed only when its
construction causes no database I/O. Browser-disabled startup remains API-owned
and runs migrations before normal listener/workers without constructing the
browser coordinator.

Handoff and reconciliation use private request deadlines capped at 60 seconds
inside one startup budget. Pre-mint owner transport loss/deadline orphans that
tuple; a fresh API-process tuple adopts the service-owned drain and the old
tuple remains superseded. A physical drain failure keeps the gate closed and
mints nothing, terminally caches that tuple's private failure, and requires a
fresh tuple to perform a complete inventory redrain. Response loss after mint
recovers cached result through exact replay. Database recovery cannot start
before confirmed drain. Process change
abandons old service identity and restarts discovery. Authentication failure,
database error, invalid response, or unready result keeps the gate closed.
Compose/harness startup fails after bounded retries and performs registered
cleanup.

API continuously checks authenticated scoped ready identity. If Browser
Service restarts, changed process nonce closes the gate immediately; API
performs a new handoff before recovery and reconciliation under one mutex. If
process stays stable but generation changes, another API took control: old API
closes permanently, stops browser retention/monitoring, and never retakes
control automatically. Every later private request from it receives typed
stale-generation rejection. Required client-wide mismatch handling invokes
that close synchronously for every HTTP response, artifact stream, and
WebSocket upgrade, but compares rejected binding so a late old response cannot
close a newer local binding. No existing session resumes. Simultaneous
detection coalesces.

Every API-only restart performs a fresh handoff before migrations/recovery,
even when Browser Service process nonce is unchanged. This closes lingering
Chromium/session/grant/writer/stream state and permits a changed snapshot digest
under the new generation without weakening same-generation conflicting replay.
Same-process transport/response loss is safe because exact tuple replay is
idempotent only when it recovers a cached minted result or joins an owner that
service still considers live. It cannot revive a pre-mint orphan or a
superseded tuple. A true API-process crash loses its process-local tuple;
replacement API deliberately uses a fresh API identity/key pair. During an
unfinished pre-mint wave it adopts the same service drain and mints once. If
prior process already caused a mint, replacement starts a new full handoff and
causes a second safe drain/mint. Concurrent live takeovers serialize; later
completed takeover fences the earlier API.

On graceful Browser Service shutdown, it enters `draining`, rejects new work,
finishes or classifies in-flight work through the existing ordered shutdown,
closes Chromium, and never changes the reconciliation snapshot. Forced
shutdown cannot promote or delete a generation. A replacement process has a
new process nonce, no control generation, and must hand off then reconcile.
Graceful API shutdown first closes/drains its API gate, uses its current
generation to close owned service resources, and stops monitoring without
minting another generation. If already superseded, those scoped close requests
receive stale-generation rejection and cannot affect the new owner. API crash
leaves cleanup to next startup handoff.

## Failure categories and logging

Private typed categories include:

- `browser_service_runtime_mismatch`
- `control_generation_required`
- `control_generation_in_progress`
- `control_generation_conflict`
- `control_generation_superseded`
- `control_generation_drain_failed`
- `control_generation_mismatch`
- `control_generation_history_exhausted`
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
status. They never include paths, reference IDs, checksums, either nonce, bearer key,
database URL, private service URL, profile name, public browser ID, capability,
or relay grant. Error causes are reduced to allowlisted categories before
logging.

## Plan impact and task boundaries

### Task 1

Task 1 adds exact package metadata, Node/pnpm preflight, frozen lock workflow,
strict handoff/reconciliation request/result and discovery/scoped-health
schemas, typed errors, private authentication, and tests. It does not start
Express, Chromium, PostgreSQL, Compose, or filesystem reconciliation.

Use Zod 4 `z.strictObject()` instead of legacy `.strict()` for new closed
objects. Express remains major version 5; its official API supports Node 18 and
newer, so selected Node 22 is supported:
[Express 5 API](https://expressjs.com/en/api/).

### Task 3 before profile readiness

Task 3 implements stable process nonce, control-generation state/idempotency,
generation-scoped reconciliation cache, quarantine-safe filesystem plan, and
readiness latch before session/profile registry can become ready.
Its failed handoff tombstone makes physical-drain failure terminal for the
exact tuple while allowing only a fresh tuple's complete idempotent redrain.
Profile/session creation remains impossible until handoff and reconciliation
succeed. Its tests use fixture roots and injected snapshots; no database
credentials enter Browser Service.

### Task 6

Task 6 mounts authenticated discovery, control-generation, scoped health,
reconciliation, and browser routes; applies fencing/body/deadline bounds;
connects ready state to server admission; wires full runtime takeover drain;
serializes the cached drain-failure envelope without leaking internal detail;
and implements ordered shutdown. Its Dockerfile resolves and pins Playwright
digest, preserves exact Node `22.22.1`, installs from frozen lock, and adds
image reproducibility/version tests.

### Tasks 7 and 8

Task 7 typed Browser Service client adds closed discovery, handoff,
generation-scoped health, and reconciliation methods plus automatic fencing
headers for every later private request. Task 8 adds startup gate,
pre-migration handoff, `0007_browser_control_generation.sql`, durable
cross-process mutation leases, repeatable-read snapshot loader, recovery
ordering, API-only restart fencing, and process-change re-handoff/
reconciliation. This work lands before controllers can accept browser work.

### Task 14

Task 14 no longer waits for ready before API spawn. Harness and Compose first
wait for authenticated process-only live health. Wrapper verifies required
MinIO bucket initialization, then starts API; API performs handoff, migrations/
recovery, and reconciliation before the orchestrator waits for API-confirmed
scoped readiness. Normal start/restart never invokes the migration sidecar,
which remains explicit maintenance only. A fake-Compose wrapper test locks this
physical call order and default profile boundary. Harness also covers API-only
restart while Browser Service stays alive. Cleanup remains registered before
first health wait. Only API publishes a host port.

### Task 15

Task 15 owns the checked stale-contract scanner and its positive mutation
fixtures. Recursive production-root discovery plus fixed-point local
TypeScript ESM, dynamic-import, CommonJS `require`, and import-equals closure
defines its inventory; a static list is not the discovery source. It resolves
extensionless, `.js`/`.cjs`/`.mjs` source mappings, directory indexes, and
tsconfig aliases; unresolved local or nonliteral unprovable module edges fail
closed. It covers all Browser Service source,
API browser-state/browser-runtime/scrape-interact source, relevant
controllers/services/config/entrypoints/harness, database schema/migrations,
Compose, environment, and every transitive local import from browser-owned
closure entrypoints. Generic config/index/harness/route bridges are scanned
directly and carry exact checked browser-follow versus reviewed non-browser
import classifications; unclassified or changed bridge imports fail closed
without pulling unrelated v0/v1 schemas into browser ownership.
`controllers/v2/types.ts` is scanned as a bridge after Task 12 removes its own
legacy strict-object call, while its exact `../v1/types` import remains a
reviewed non-browser boundary. Required helpers
include `filesystem-store-internal.ts`, `transitions.ts`,
`process-identity.ts`, `legacy-compatibility.ts`, and `replay-envelope.ts`.
Only exact reviewed test/negative/generated/vendor exclusions are allowed;
stale exclusions, unresolved closure, or uncovered task paths fail before
rule scanning. Checked `browser_schema`, `reviewed_non_browser_schema`, and
`non_schema` source roles derive from browser-owned roots, followed edges, and
exact reviewed boundaries. Every newly discovered browser schema receives URL/
UUID checks; unclassified schema-bearing or changed reviewed boundaries fail
before rule scanning. Temporary workspaces run the real CLI pipeline with no
source-role injection: one newly discovered browser-root schema and one schema
outside roots reached through checked `browser_follow` metadata must both
derive `browser_schema` before producing exact URL/UUID findings. Ordinary
discovered and followed controls must derive `non_schema` and produce no
schema-only findings. Tests assert normalized inventory and derived roles
before findings, so broken discovery-to-role propagation fails acceptance.
AST-aware browser-schema/alias checks plus bounded SQL/text rules prevent
permissive validators, legacy root layers, duplicate database storage payloads,
split activation, and stale code-result contracts from passing acceptance
silently.

### Host plan follow-up

Before executing Task 5 of
`2026-07-19-browser-host-execution-and-operations.md`, revise stale Codex
`0.144.5` pins to consume the approved rolling installed-Codex contract. Keep
model, reasoning effort, schema, safety, lifecycle, and capability gates
pinned; do not restore an exact Codex CLI version requirement.

## Tests and acceptance

New tests in the implementation plan must prove:

- exact Node `22.22.1` succeeds and wrong runtimes fail before install/test/
  build/start;
- Corepack selects pnpm `10.33.0`, frozen install succeeds, and lock mutation
  or missing lock fails;
- Playwright package, lock, image tag, immutable digest, and built runtime all
  match `1.61.1`, including a no-cache rebuild;
- process-only live discovery succeeds before handoff while scoped health,
  ready health, and every browser route fail closed;
- handoff, health, and reconciliation reject missing auth, expired deadlines,
  unknown fields, malformed process/generation/idempotency/hash/path values,
  excess references, and excess bytes;
- handoff mints a generation only after closing every old service runtime
  resource and clearing readiness/cache while process nonce remains stable;
- exact API identity/idempotency replay mints once; conflicting/concurrent
  takeover fails closed and later completed takeover fences prior API;
- API crash or request deadline during pre-mint drain lets one fresh tuple
  supersede the orphan and adopt the same service-owned drain; old handler and
  retries return `control_generation_superseded` and cannot mint;
- multiple sequential pre-mint owner crashes still perform one physical drain;
  a concurrent live owner cannot be stolen, and current live owner alone
  mints after the shared drain settles;
- a partial physical drain failure caches one terminal 503 for exact replay,
  clears active-wave ownership, mints nothing, and leaves admission closed;
  a fresh tuple re-enumerates the full inventory, converges already-closed
  resources, and alone may mint after a successful full redrain;
- a failed replacement cannot resurrect its superseded predecessor, and failed
  tombstones consume the same 1,024-entry history capacity as every accepted
  tuple;
- A→B→replay-A returns historical A without changing current B; tuple history
  capacity accepts known replay, preserves superseded tombstones, and rejects
  unknown orphan replacement without eviction or a second drain;
- every later private route rejects stale process/generation before effects;
- every client HTTP/WS mismatch synchronously closes only matching API binding;
- new durable epoch activation waits for a paused old filesystem/database
  mutation, snapshots its completed result, then rejects old future mutations
  before filesystem effect;
- stale/wrong generation and conflicting same-generation replay perform zero
  filesystem changes;
- exact same process/generation/digest retry is idempotent and returns same
  result;
- one repeatable-read snapshot includes checkpoints, profile generations,
  active/latest generations, and unresolved cleanup intents;
- missing or corrupt authoritative files cause zero deletion and remain
  unready;
- traversal, absolute paths, symlinks, special files, hard-link ambiguity, and
  checksum aliases fail closed;
- only recognized, unreferenced entries older than 10 minutes enter quarantine;
- partial quarantine/delete failure remains unready and exact retry completes;
- no database migration/recovery/snapshot begins before confirmed service
  handoff drain; API opens browser work/retention only after matching
  process/generation/digest response and ready health;
- paused/failed handoff produces zero database connects/queries, DB-backed
  stores, listeners, workers, or retention; harness migration spy stays zero,
  child API owns migration, and rendered Compose has no migration-sidecar API
  dependency;
- API-only restart after checkpoint/profile mutation keeps process nonce,
  drains lingering Chromium/session/grant/writer/stream state, mints a new
  generation, accepts changed digest, and rejects old API requests;
- same-process post-mint lost response replays one tuple without duplicate
  mint; true API crash replacement uses a fresh tuple, adopts the existing
  drain when crash was pre-mint, or performs a new full handoff after prior
  mint; service restart during handoff causes no premature recovery;
- service restart changes process nonce, closes API gate, performs new handoff,
  interrupts durable work, and requires reconciliation again;
- graceful and forced shutdown never promote an orphan or delete a referenced
  generation;
- scanner bridge fixtures follow a browser registration to a two-hop forbidden
  helper, keep a reviewed unrelated v1/v2 import outside browser inventory,
  and fail on every unclassified or changed bridge import;
- scanner CommonJS/import-equals fixtures close local two-hop helpers and
  `.cjs`/`.mjs` mappings, allow literal external packages without recursion,
  and fail unresolved local or nonliteral unprovable module references;
- scanner schema-role fixtures use the real CLI with no role override; assert a
  discovered browser-root schema and an outside-root schema reached through a
  checked `browser_follow` edge enter inventory and derive `browser_schema`
  before exact bare URL/UUID findings;
- scanner role controls enter the same production-derived inventory as
  `non_schema` and produce no schema-only findings; unclassified schema-bearing
  sources and broken discovery-to-role propagation fail before rule scanning;
- logs contain aggregate metadata but no path, either nonce, checksum, key, URL,
  capability, grant, or browser identity.

Acceptance also runs Task 1 focused tests/build, Task 3
generation/reconciliation/profile tests, Task 6 server/image tests, Tasks 7
and 8 client/startup tests, Task 14 harness/Compose checks, Task 15 checked
discovery/import-closure scanner with temporary directory/import mutation
fixtures, actual repository hook, and a
clean-tree check. Tests use Node `22.22.1` and frozen install. Browser Service
remains private and disabled by default.

## Rejected alternatives

### Give Browser Service database credentials

Rejected. It duplicates query and migration authority, expands secret scope,
and lets a browser-owning process make retention decisions directly.

### Let Browser Service become ready before reconciliation

Rejected. Sessions could observe or delete state before PostgreSQL authority is
known, and an old API would remain unfenced. Control handoff must first drain
runtime; reconciliation then establishes generation-scoped readiness.

### Have Compose wait for ready before starting API

Rejected. API is the only component allowed to read the authoritative database
snapshot, so this recreates the readiness circle and skips required API
control handoff.

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
process/generation/digest result is cached; conflicting replay inside that
generation remains a hard failure. New generation is allowed only after full
service drain clears prior cache/readiness.
