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
publishes the wave plus one shared deferred promise before invoking the drain
callback. Synchronous callback reentry or shutdown therefore observes and joins
the published wave instead of creating or overwriting one. The callback settles
that deferred exactly once. Its service-owned promise
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
There is one shared history count and no transferable owner slot or separate
superseded-tombstone allowance: with 1,023 accepted tuples an unknown orphan
replacement may reserve tuple 1,024, while with 1,024 it is rejected before
superseding the owner.
After completed A then B, replay A returns A's historical response but cannot
replace current B generation. Neither nonce is persisted or logged.

Tuple lookup order is exact under the mutex: resolve known exact replay first;
for every unknown tuple, check and tentatively reserve one of the 1,024 slots
before evaluating API-identity/idempotency-key collision semantics. At capacity
an unknown colliding tuple therefore returns
`control_generation_history_exhausted`, while known replay remains
deterministic. Below capacity, collision rejection releases the tentative slot.

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
to the 25,000 request references. Enumerate directories iteratively with
`fs.opendir` and an explicit `bufferSize` no greater than 32; never use a
whole-directory `readdir`. Below the cap, charge each non-null `Dirent`
immediately after `Dir.read()` returns and before yielding or processing it. At
the cap, permit a `Dir.read()` lookahead only to distinguish uncharged EOF from
overflow. A non-null overflow result fails immediately and is never
yielded, inspected for name/type by application code, retained, sorted, statted,
opened, content-read, hashed, planned, or mutated. Fixed-buffer Node/libuv
prefetch remains bounded and is outside the processed-entry count. Here and
below, "read" in a prohibited downstream operation means file-content read,
not the single enumeration lookahead. Walk depth is at most 64; every relative
path is at
most 1,024 UTF-8 bytes and every segment at most 255 UTF-8 bytes. Checkpoint
files must be at most 2 MiB before read. Each profile file is at most 64 MiB and
one generation tree at most 256 MiB, enforced while streaming the walk.
The counter is created once per reconciliation and never reset. A set keyed by
`replay`, `profiles`, and `quarantine` charges each successfully entered managed
namespace root exactly once globally; ENOENT roots, absent-entry probes, and EOF
lookaheads do not charge. Repeated descendant walks recharge every non-null
yielded descendant across authority, enumeration, identity, revalidation,
recovery, and retry walks, which all consume the same total. This filesystem
traversal budget is independent of the separate 25,000-entry captured-workset
cardinality bound.
Exceeding any bound fails before deletion.
Response counts are nonnegative safe integers no greater than 25,000 each. API
accepts the result only when process nonce, generation nonce, and digest equal
its request and all result fields pass the closed schema.

The authenticated service key proves the caller is an API. Process nonce binds
to one live Browser Service process; control generation fences API ownership.
Category precedence is exact and cannot alter filesystem or readiness:
oversized reference count or encoded body returns
`reconciliation_snapshot_too_large` with 413; malformed JSON/schema, path,
checksum, alias, or digest returns `reconciliation_snapshot_invalid` with 400;
a structurally valid stale process returns `reconciliation_nonce_mismatch`
with 409; and a valid current-process but stale generation returns
`control_generation_mismatch` with 409.

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
  from its validated durable reconciliation manifest.
- The startup state publishes one reconciliation-flight record and shared
  deferred before invoking the execute callback. Synchronous reentry joins that
  flight, and synchronous draining aborts it; neither can duplicate execution
  or overwrite the flight.

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

Browser Service requires Linux procfs fd anchoring. It opens the canonical root
before any state work by first opening `/`, then every absolute root component
through its held parent using `/proc/self/fd/<parentFd>/<segment>` with
`O_DIRECTORY | O_NOFOLLOW`. It retains and validates the whole chain and
captures initial authority evidence from those exact handles before state work,
then revalidates/seals it immediately before close. It rejects startup
reconciliation as `reconciliation_filesystem_unsafe` with zero state work when
procfs anchoring is unavailable or a component changes during capture. It
creates and opens quarantine parents one component at a time with `O_NOFOLLOW`.
Source and destination parent handles stay open
through rename, both directory fsyncs, identity revalidation, delete, and final
fsync. Rename and removal use only procfd-anchored parent paths, never the
original validated string, so an ancestor symlink swap cannot redirect work
outside the root. A changed leaf type or identity fails closed.

Every non-cleanup filesystem await is bracketed by the reconciliation
admission checks before and after it. Raw `finally` blocks attempt every held
handle close without admission checks; close is required cleanup after abort.
A true close rejection retains fail-stop ownership rather than claiming zero
handles.

Browser Service validates the complete request before destructive work.
Checkpoint authority is exactly one regular file matching
`replay/<owner>/<scrape>/<canonical-lowercase-uuid>.json`. Profile authority is
exactly a generation directory matching
`profiles/<canonical-lowercase-profile-uuid>/{committed|staging|working}/`
`<canonical-lowercase-generation-uuid>/`, never a file. Unknown files or names
at the `profiles/`, profile, and state namespace levels fail closed. Inside a
generation, bounded regular files/directories form the canonical tree. Every
regular file requires `nlink === 1`; every symlink, socket, FIFO, device, or
other special entry is unsafe.

Task 3 and Task 4 share one canonical profile-tree algorithm. Walk at depth at
most 64 and sort entries by raw UTF-8 relative-path bytes. The root is encoded
with `path:""`; descendants use NFC slash-separated paths with segments at
most 255 bytes and total paths at most 1,024 bytes. Serialize whitespace-free
UTF-8 JSON with fixed key order
`{"version":1,"entries":[{"path":"","type":"directory","mode":448,"size":0,"sha256":null}]}`:
`type` is `directory` or `file`, `mode` is the low permission bits as a decimal
integer, directories use `size:0,sha256:null`, and files use exact byte size and
lowercase content SHA-256. The profile checksum is SHA-256 of those exact JSON
bytes. Per-file and cumulative byte limits are enforced during the walk.

If any authoritative reference is missing, corrupt, unsafe, or unreadable,
reconciliation fails, readiness remains false, and nothing is deleted.

After all authorities validate, Browser Service enumerates only checked-in
managed namespaces and computes the deterministic candidate plan that must be
persisted below before candidate mutation. It retains every listed
path, including cleanup intents and current/latest/active generations. It may
remove only an unreferenced, recognized service-owned committed, staging,
working, or checkpoint entry older than the existing 10-minute grace period.
For a directory candidate, age is its maximum descendant mtime including the
directory itself, not its root mtime alone. Unknown names fail readiness and
are never guessed or deleted.

Before any record promotion, repair, candidate mutation, or cleanup, Browser
Service read-only enumerates every plan directory and parses every temporary or
final manifest and completion marker. It validates every quarantine byte and
directory against those records and validates every pending entry's exact
source/destination phase, parent identity, leaf type, and content/tree identity.
For plan-bearing completed state, first require a valid final `complete` marker
that exactly binds plan SHA, retained, and removed. The recorded source parent
must open through a held procfd handle, match identity, and prove the source
leaf absent. The recorded destination parent must likewise open, match, and
prove its leaf absent, except after durable cleanup already removed an exact
destination suffix. That completed-cleanup exception walks from the nearest
surviving recorded or authorized ancestor through held procfd handles. It proves
every absent suffix component matches the exact destination hierarchy recorded
in the manifest, with no alternate leaf or unaccounted byte. It never applies
to pending state, `complete.tmp`, an invalid marker, a missing source parent,
or any arbitrary missing destination parent. Any failure leaves every record
and candidate untouched. A final completion-only record has no paths to mutate
or prior-plan authenticity; its strictly limited cleanup rule below does not
infer either.

The current logical reconciliation captures its workset exactly once after that
read-only validation. Its unique cardinality is the union of newly eligible
current entries and entries from plan-bearing manifests pending at capture.
Reject before plan publication when adding the would-be entry 25,001; exactly
25,000 succeeds. Manifests already completed at capture, including
completion-only records, are historical cleanup state and contribute nothing.
A contributing old plan contributes only its entries, never its own aggregate
count. Duplicate workset source or destination paths are unsafe rather than
silently deduplicated.

Before moving the first candidate, persist one immutable canonical plan at
`quarantine/<processNonce>/<controlGenerationNonce>/.plans/`
`<snapshotDigest>/plan.json`. Exact plan-directory grammar permits only
`plan.tmp`, `plan.json`, `complete.tmp`, and `complete`. No cleanup-copy record
is permitted. The manifest contains fixed-key `version`, process nonce,
generation nonce, snapshot digest, retained count, removed count, and sorted
entries. `entries` contains only newly eligible current candidates; pending-old
entries remain solely in their old manifests and affect only this plan's
`removed` workset cardinality. Each current entry records full source and
destination relative paths,
recognized type, immutable identity SHA-256, byte count, source/destination
parent path plus device/inode/mode identity, and the exact phase model below.
Field names/order equal Task 3's `ReconciliationPlanV1`; device and inode are
canonical unsigned decimal strings and entries sort by raw UTF-8 source then
destination path. `phaseModel:1` is immutable; observed phase comes only from
the source/destination state machine.
Checkpoint identity hashes type/mode/size/content SHA; profile identity hashes
the canonical tree representation. Manifest JSON is at most 64 MiB.

Create `plan.tmp` with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, write the
canonical bytes, fsync the file, rename it to `plan.json`, then fsync the plan
directory and `.plans` parent through held handles. Quarantine parent creation
may precede this write, but each new directory is immediately opened and its
held parent fsynced; the full empty skeleton is durable before `plan.tmp`. No
candidate move/delete may precede the manifest. A crash after temp-file fsync
resumes only by validating and publishing those exact bytes. Same tuple/
digest retry loads and validates the durable manifest rather than rebuilding
from mutable quarantine state.

Before `plan.tmp` exists, only the exact empty directory skeleton reserved for
that tuple/digest is valid. Retry revalidates source/parent identities before
publishing the manifest. Any destination bytes, nonempty candidate directory,
or unexpected entry without valid temp/manifest is unsafe untouched.

For each manifest item, source-only means revalidate exact identity, rename by
held parent handles, fsync both source and destination parents, revalidate the
moved identity, delete, then fsync destination parent. Destination-only means
validate its expected identity, fsync both recorded parents before delete,
delete, then fsync destination parent. Both absent means fsync destination
parent before recording/counting completion. Both present or any type,
identity, parent-identity, or byte mismatch fails unsafe without touching
either. A delete followed by fsync failure remains incomplete; retry performs
the destination fsync and counts that entry once. The manifest's `removed`
field immutably stores the captured workset size and is bounded to a
nonnegative safe integer no greater than 25,000. Exact retry uses that stored
value and never rebuilds it from current manifest states.

The manifest remains until every entry delete and required fsync completes.
Then create mode-0600 `complete.tmp` with
`O_CREAT | O_EXCL | O_NOFOLLOW`, write/fsync exact fixed-key version, manifest
SHA-256, retained, and removed fields, atomically rename to `complete`, and
fsync the plan directory. A temp-only retry validates and publishes those exact
bytes. For plan-bearing state, the completion marker is valid only when its
manifest SHA-256 matches the exact plan bytes and both
`complete.retained === plan.retained` and
`complete.removed === plan.removed`. A current exact retry validates
`plan.json` plus `complete` and returns the same counts.

A later authority-valid reconciliation may crash-safely clean an older
completed plan only after its final marker exact-binds it and a held recorded
source parent proves source absence. Normally, a held recorded destination
parent must match and prove its leaf absent; fsync both held parents before
removing any still-existing empty destination directory and keep relevant
handles through removal and held-parent fsync. After a cleanup crash, the
completed-cleanup exception may replace only that destination-parent proof: a
held nearest surviving recorded or authorized ancestor must prove the exact
manifest-authorized destination suffix absent with no alternate leaf or
unaccounted byte. Fsync the source parent and that ancestor before continuing.
It then unlinks `plan.json`, fsyncs the plan directory, unlinks `complete`, and
fsyncs again. Empty plan-directory ancestors follow with held-parent fsyncs. A
crash between those record unlinks leaves one canonical final
`complete` file, but that file cannot authenticate its deleted plan and is never
path authority. Accept it only after global read-only validation proves its
process/generation has zero quarantine leaves and zero unaccounted bytes. Its
only remaining hierarchy must be the exact otherwise-empty authorized
`.plans/<snapshotDigest>/complete` skeleton. It may authorize deleting only
itself and now-empty digest/`.plans`/generation/process ancestors, never managed
or quarantine content, and contributes no count. Its closed canonical fields,
bounds, mode, and link count are syntax checks only; SHA/count values cannot
authenticate the deleted plan. Forged-marker rejection applies to plan-bearing
state. Arbitrary bytes outside that one canonical encoding, malformed bytes, a
`complete.tmp` without a manifest, or any completion-only state with quarantine
content or an unauthorized skeleton fails unsafe untouched.

`retained` is the number of unique authoritative paths validated. `removed` is
the captured pending-only workset stored in the current immutable plan. Each
workset entry counts exactly once even when its observed phase is already
both-absent or it completes during the attempt. A manifest bearing valid final
completion before capture is historical and contributes zero. Exact retry
returns the stored count; it never recursively adds an older plan's aggregate
or derives history from later completion states. Old process/generation
recovery enumerates only validated manifests after current authority validation,
validates every quarantined byte against its expected identity, and never
reconstructs a plan from destination paths.

A partial failure leaves readiness false. A later generation may finish an
old-generation manifest only after its complete new authority snapshot proves
every original source unreferenced. After the current plan is durably published,
valid temporary records may be promoted, older captured pending plans execute
and complete first, and the current plan executes and completes last. Historical
or newly completed cleanup begins only after current completion is durable.
Readiness flips to true exactly once, only after every validated plan completes.
No cleanup starts from a partial, stale, wrong-generation, or conflicting
snapshot.

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
   clears ready/cache, fully drains service runtime plus old ProfileStore/root
   leases, then returns a newly minted, explicitly unready
   `controlGenerationNonce` with the unchanged process nonce and no installed
   authority/store.
6. Only after confirmed handoff, API opens PostgreSQL, applies migrations,
   activates its durable singleton control epoch after older mutations drain,
   and runs startup recovery under its closed/drained gate.
7. API captures and commits one consistent snapshot and posts it with both
   nonces, service authentication, correlation ID, and bounded deadline.
8. Browser Service validates generation and authorities, reconciles the
   filesystem to an opaque outcome, reacquires root/builds ProfileStore, then
   atomically installs public result/authority/store/readiness and returns
   counts plus matching process/generation/digest.
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
Its reconciliation boundary persists immutable plan manifests before candidate
mutation, executes through procfd-anchored held directory handles, and shares
the exact bounded canonical profile-tree identity with Task 4. Manifest phases
and completion markers make retry counts deterministic across process and
generation crashes.
Profile/session creation remains impossible until handoff and reconciliation
succeed. Its tests use fixture roots and injected snapshots; no database
credentials enter Browser Service.

### Task 4 persistent replay boundary

Task 4 owns profile/session/replay files, restore-gate changes/tests in
`egress-proxy.ts` and `egress-proxy.test.ts`, and the minimal held-profile API
additions/tests in `reconciliation.ts` and `reconciliation.test.ts`. It also
owns the ready-authority handoff and rollover changes/tests in
`startup-state.ts` and `startup-state.test.ts`. It locks
Playwright `1.61.1` behavior. Persistent launch options must not
contain `storageState`; `launchPersistentContext()` intentionally omits that
option, while `BrowserContext.setStorageState()` is the supported post-launch
restore API. After validating every request setting and, for replay, checkpoint
file, metadata, checksum, canonical byte, and closed-schema boundary, Browser
Service creates a private provisional Registry entry, fresh isolated working
directory, and loopback proxy with one closed per-session gate. For non-replay,
it launches the persistent context, immediately proves zero gate violations,
atomically opens the gate, and only then acquires/creates a page and navigates
`initialUrl`. That navigation must observe ingress, DNS, policy, and dial in
order. For replay, it launches the persistent context, immediately calls
`setStorageState()`, immediately receives
`storageState({ indexedDB: true })` as `unknown`, parses it through the bounded
closed `StorageStateV1` schema, compares semantic-normalized state, proves the
gate recorded zero ingress violations, and atomically opens it. Only then may
service code acquire `context.pages()[0]`, create a page, or navigate.
Both paths use the same `provisional.acquireWorkingCopy()`,
`provisional.acquireEgressProxy()`, and
`provisional.acquirePersistentContext()` methods; each attaches its owned
resource before returning and before the caller's next fallible await.
Persistent-context acquisition owns a `launch_attempt` token before calling
Playwright; a returned context atomically replaces the token.

The working value contains no path. Fixed internal
`launchPersistentChromiumForWorking(boundWorking, binding, options)`
runtime-authenticates current admission, revalidates the full chain, constructs
and verifies `/proc/<browser-service-pid>/fd/<generation-fd>`, and directly
calls Playwright in the same lexical scope. No callback/caller sees an FD/path.
Its WeakMap-backed session attachment retains the generation/root lease through
Registry attachment and session lifetime. Internal post-context launch failure
or Registry attachment failure invokes exactly-once
`releaseChromiumSessionAttachment()`. Verified context/public Browser closure
releases; unknown closure retains fail-stop ownership. Forged/double release
and use after release fail. Path swaps use the original inode or fail prelaunch.

Task 4 does not use Task 3's pathname-reopening
`canonicalizeProfileTree(canonicalRoot, path)` entry point. Task 3 preserves
that public API and `ReconciliationResult` behavior. Internally,
`reconcileBrowserStateWithAuthority()` is exported only between implementation
modules and returns an opaque `InternalReconciliationOutcome`. A module-private
WeakMap record, not object fields or TypeScript branding, stores the unchanged
public result plus `ReconciledRootEvidence`: canonical absolute components,
every component dev/ino/mode, and exact process/control/snapshot binding.
Public reconciliation delegates, clones only the result, and disposes its
uninstalled outcome.

`consumeInternalReconciliationOutcome(outcome, binding, consume)` is its sole
accessor. Reconciliation owns the WeakMap and single-use
`fresh → consuming → consumed` transition, reacquires root, and gives one fixed
internal startup consumer only cloned public result plus opaque authority/root
capabilities. Forged, stale, concurrent, or repeated consumption fails before
callback. Consumer failure closes constructed store/root/authority and remains
consumed; successful return has no later fallible work.

Before any state work, reconciliation opens `/`, then each absolute root
component through held-parent procfds with `O_DIRECTORY | O_NOFOLLOW`, validates
parent entries, retains the whole chain, and captures initial evidence before
state work. It revalidates/seals evidence from the same handles immediately
before close. Capture-time component swaps fail with zero state work.
Reacquisition repeats the held walk and exact comparison.

Internal `InternalStartupAdmission.reconcileWithAuthority(request, execute)`
owns the execution callback/admission boundary while public `reconcile()` stays
unchanged. Production constructs it with a required internal ProfileStore
factory; public `createStartupState()` remains unchanged. The route supplies
only `execute`; the controller invokes it, passes
its outcome directly to the consume API, builds a generation-scoped
ProfileStore in the fixed consumer, then atomically installs public result,
authority, store, and ready state. The route never receives an outcome or calls
`requireReady()` between pieces. Handoff first clears ready, drains sessions/
leases, closes old store/root, and mints unready. Later reconciliation/install
makes it ready. Any failure leaves it unready without partial authority.

`reconciliation.ts` exports opaque
`AnchoredProfileRoot` and `BoundProfileGeneration` capabilities plus
`closeAnchoredProfileRoot`, `bindProfileGeneration`,
`canonicalizeHeldProfileTree`, `syncAndCanonicalizeHeldProfileTree`, and
`copyHeldProfileTree`. Generation bind holds
root→profiles→profile→state→generation through procfd children. Module-private
WeakMaps, not TypeScript brands, authenticate roots, generations, and launch
capabilities. Serialized records use `live | consuming | consumed | closed`;
forged/cast/foreign values, use after consume, repeated transition/remove, and
double close fail before filesystem effect. Root close rejects new operations,
drains every lease/binding, then closes its chain.

Held canonicalization directly reuses Task 3's private Budget, iterative walk,
fixed-key encoder, hash, and evidence implementation with the same admission
hooks and exact 25,000-entry, depth-64, 64-MiB-file, 256-MiB-tree, path/NFC,
nlink, and file-type bounds. Sync first finishes canonical evidence, then syncs
files and directories postorder, then revalidates canonical mode/size/content
SHA, inodes, and all bindings. Copy finishes source evidence before destination
mutation, streams bounded chunks with exact size/EOF and before/after stat,
fsyncs destination files/directories, then requires identical revalidated
source/destination canonical trees. Prefix, truncation, trailing bytes, and
same-inode drift fail. Limit failure precedes sync/copy.

All ProfileStore create/copy/rename/delete operations retain and revalidate the
full ancestor chain; the opaque generation capability exposes only high-level
mutations. A discovered-then-deleted child produces an in-memory evidence
tombstone and fails unsafe, never an on-disk marker or shortened tree. Opaque
objects attempt all FD closes. Success, abort, open/stat failure, and
close-then-throw prove zero retained FDs; a true close rejection retains
fail-stop `close_unverified` ownership, closes admission, and makes no zero-FD
claim. Binding close releases unused children; transition/remove consumes the
old binding. Create-exclusive is working-only: hold
root→profiles→profile→working-state, perform nonrecursive procfd mkdir that
fails `EEXIST`, then open with `O_DIRECTORY | O_NOFOLLOW`, fstat, and revalidate
the now-complete chain. It never claims a pre-mkdir generation handle. Copy
requires a committed source and new absent empty working destination; working/
staging sources fail before mutation. Nested directories repeat held-parent
mkdir/open/fstat/revalidation. Files use `O_CREAT | O_EXCL | O_NOFOLLOW`;
collision, symlink, and replacement races fail without overwrite. Only
working→staging and staging→committed are allowed; remove accepts only owned
working/deletion-tombstone bindings, never committed.
Writer prepare rejects a root-only empty tree as
`browser_unavailable` with internal detail `profile_schema_empty`. No duplicate
tree hash implementation exists. Child create/write/fsync, postorder directory
fsync, rename, remove, and post-mutation validation are explicit crash points;
recovery proves canonical state or discards owned partial state before any
publication.

Canonicalize, sync, copy, create, prepare, finalize, remove, and launch check
binding/admission immediately before and after every await. Abort starts no
later effect and still attempts every required close.

Persistent Chromium automatically initializes an `about:blank` page before
launch returns. Mobile Chromium may cause Playwright to create a replacement
default-context page and close the original. Playwright's storage APIs may
inspect existing-page origins, create helper pages, navigate to origins under
a prepended handler that fulfills every request locally, and evaluate their
utility-world storage script. Those launch/storage-library operations are
allowed. Service and caller code may not acquire a page, call `newPage()`,
navigate, use locators, evaluate script, or register initiating listener work
until non-replay zero-violation checks, or replay equality plus zero-violation
checks, succeed and the gate opens. Playwright 1.61.1 suppresses public context
events for storage helper pages, so those events are incomplete and never an
egress oracle.

Task 4 extends Task 2's egress proxy. Its categories are exactly
`http | connect | upgrade`: HTTP handler requests map to `http`, CONNECT maps
HTTPS and WSS tunnels to `connect`, and WS Upgrade maps to `upgrade`; no `ws`
or `wss` category exists. Each session gate has exact state
`restore_closed | open | closed`; its ingress linearization point is before DNS
resolution, policy `onDecision`, and dial.
While restore-closed, any attempt increments a bounded violation counter,
records only the exact mapped category above, rejects and closes, and performs
zero DNS, decision, or dial. A closed-linearized attempt is never queued or
replayed and permanently disqualifies that session gate from opening. Monotonic
ingress/violation/DNS/decision/dial counters are
per-session. Each checked increment fails closed before downstream work on
`Number.MAX_SAFE_INTEGER` overflow without changing any counter. Non-replay
open requires zero violations; replay open additionally requires successful
export parse and semantic equality. Open from `open` or `closed`, or after a
violation, is a typed no-state-change invariant failure. Close is
terminal and idempotent once closed. Post-open non-replay `initialUrl` or replay
`finalUrl` navigation must traverse the same observer and all Task 2 transport
defenses as positive control.

Semantic normalization sorts cookies, origins, localStorage entries,
databases, stores, records, and indexes by a total order derived from the local
closed schema. Tagged, length-framed identity tuples compare raw UTF-8 bytes,
then full fixed-key normalized element bytes. Identities are cookie
`(domain,path,name,partitionKey-or-absent,
_crHasCrossSiteAncestor-or-absent)`, origin `(origin)`, localStorage `(name)`,
database `(name)`, store `(name)`, index `(name)`, and record `key:` plus
canonical key, `keyEncoded:` plus canonical encoded key, or for inline/keyless
records `value:`/`valueEncoded:` plus canonical value. Duplicate identities,
including same-primary/different-payload, are rejected. Duplicates remain
allowed only in ordered value-semantic arrays such as `keyPathArray` and JSON
payload arrays; their order is preserved. Absent IndexedDB equals `[]`, empty
origins are dropped, and other absent optionals are omitted. Semantic bytes are
compared only to each other, never to foundation checkpoint bytes/checksum.

Registry creates a private provisional entry before its first resource and
incrementally owns working capability, context, proxy/gate/listener/live sockets,
pending acquisition, and cleanup state until navigation/fingerprint success.
A partially acquiring working/proxy constructor attaches ownership before its
next fallible await or returns only after self-cleaning. Validation failures
precede side effects and launch nothing. Detached launch races are forbidden.

Public Playwright rejection/timeout after launch starts does not prove process
cleanup, and without a returned context there is no public process handle.
Only explicit trusted `preSpawn` proof that no browser process/resource existed
permits proxy shutdown, working discard, and provisional removal; rejected
promise state alone is never proof. Otherwise Registry records
`cleanup_failed/launch_cleanup_unverified` before returning a typed unavailable
error, retains launch token and working profile, closes/drains proxy when
verifiable, performs no discard/prepare/stage/finalize/publication, and globally
closes new-session admission/readiness or drains this service process. Sweeper
cannot clear the token from public evidence. No private PID/process API is
allowed. Unverified proxy closure retains its handles and bounded cleanup codes
in the same entry. Token and Registry ownership are process-local and never
persisted; the working directory remains ordinary unreferenced filesystem
state. Process/container restart guarantees old Chromium termination and
clears that in-memory uncertainty. Task 3 reconciliation then treats the exact
recognized unreferenced working generation under existing authority: retain while maximum
descendant age is <=10 minutes, with readiness allowed, then remove only in a
later startup/reconciliation generation after age >10 minutes through existing
manifest/quarantine/fsync/delete/completion rules. There is no new marker or
immediate-deletion exception.

Every failure after a context was returned calls public `context.close()` once,
preserves and observes
that original promise under a bound, and never recalls it. On graceful
rejection/timeout without verified closure, cleanup calls bounded public
`context.browser()?.close()` as its only force-quit-like fallback. Verified
context close or Browser disconnect succeeds; unavailable, failed, or pending
public close state remains owned. Cleanup independently performs terminal gate
close, proxy listener close, bounded socket drain, and profile discard only
after verified context closure. Private Playwright process APIs are forbidden.
Cleanup aggregates only
`chromium_close_failed`, `proxy_listener_close_failed`,
`proxy_socket_drain_failed`, and `profile_discard_failed`. Terminal gate close
is infallible. Verified cleanup removes provisional ownership. Any unverified
context/listener/socket/path remains truthfully owned in `cleanup_failed` with
admission closed, original close promises/states, and no
prepare/stage/finalize/publication. Sweeper observes those promises, may retry
only `browser.close()` when public state permits, never recalls an already
started `context.close()`, and removes ownership only after verified closure/
discard. Service restart is operator fallback. Normal writer close uses the
same public fallback and verifies context/browser closure, terminal gate close,
listener close, and zero sockets before prepare/finalize; any cleanup failure
prevents publication. Snapshot close discards. Publication errors add
`profile_prepare_failed` or `profile_finalize_failed`; reconciliation owns
durable partial filesystem state.

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
- reconciliation maps oversized references/body to snapshot-too-large,
  malformed schema/path/checksum/alias/digest to snapshot-invalid, valid stale
  process to nonce-mismatch, and valid stale generation to generation-mismatch
  before filesystem execution;
- handoff mints a generation only after closing every old service runtime
  resource and clearing readiness/cache while process nonce remains stable;
- handoff wave and reconciliation flight/deferred are published before their
  callbacks; synchronous callback reentry and shutdown join/abort one flight
  without duplicate execution or overwritten state;
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
- unknown tuples check/reserve history capacity before collision semantics;
  at-cap unknown collision returns history exhausted, below-cap collision
  releases its reservation, and known replay stays deterministic at capacity;
  an orphan replacement is accepted as tuple 1,024 from exactly 1,023 accepted
  tuples and rejected without owner change from exactly 1,024;
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
- profile authority is a canonical UUID generation directory, never a file;
  wrong UUID/name/namespace entries, traversal, absolute paths, symlinks,
  sockets/FIFOs/devices, hard links, and checksum aliases fail closed;
- Task 3 and Task 4 share exact UTF-8-sorted type/mode/size/content-SHA tree
  encoding and enforce depth 64, checkpoint 2 MiB, profile-file 64 MiB,
  profile-tree 256 MiB, and path/segment bounds during walks;
- public reconciliation API/result remain unchanged; its internal-only function
  returns a WeakMap-authenticated opaque outcome with no result/authority
  fields, while the public wrapper clones only its public result; the sole
  consume API is single-use and invokes one typed internal startup consumer;
- reconciliation opens and validates `/` through every absolute root component
  before any state work, captures evidence from those exact retained handles,
  and reacquisition compares the entire captured chain;
- handoff clears ready, drains sessions/root leases, closes old store/root, and
  mints the new generation unready; later internal reconciliation reacquires
  root/builds store and atomically installs result/authority/store plus ready;
- Task 4 binds generations through held
  root→profiles→profile→state→generation FDs and never calls Task 3's
  pathname-reopening canonicalizer; WeakMap records reject forged, foreign,
  consumed, or closed capabilities and root close drains serialized leases;
- held canonicalize/sync/copy reuse Task 3's private Budget/hash/evidence code;
  bounds complete before sync/copy, streaming enforces exact size/EOF, and full
  canonical/inode/binding revalidation follows file/directory fsync;
- tests cover transient swaps restored at root/every ancestor/generation,
  same-inode mode/size/content drift, prefix/truncation/trailing bytes, child
  deletion tombstones, open/stat/close-then-throw FD cleanup, true-close
  rejection fail-stop ownership without a zero-FD claim, 25,001/depth-65/
  64-MiB+1/256-MiB+1 pre-effect limits, phase-specific held mutations, positive
  first/completed hook proof, empty writer rejection, state/exclusive-create
  races, capture-time component swaps with zero state work, rollover during
  sync/copy, abort before/after every operation await, crash phases, and one
  hash identity; existing Task 3 public cases remain unchanged while close and
  root-capture cases are additive;
- copy source is committed and destination is new absent empty working state;
  working/staging sources fail before mutation, files use
  `O_CREAT | O_EXCL | O_NOFOLLOW`, prepare/finalize permit only
  working→staging→committed, and general removal never accepts committed state;
- create-working and nested copy directories hold only their existing parent
  chain before nonrecursive mkdir, then no-follow open/fstat/revalidate the new
  child; no pre-mkdir generation handle is asserted;
- real Chromium launch uses fixed internal
  `launchPersistentChromiumForWorking()` and only the verified
  `/proc/<browser-service-pid>/fd/<generation-fd>` of a module-private bound
  working capability, exposes no FD/path or generic callback, retains its
  FD/root lease through Registry attachment/session, and uses exactly-once
  `releaseChromiumSessionAttachment()` after verified browser closure;
- post-context launcher or Registry attachment failure invokes attachment
  release; double release/use-after-release fails, unknown closure retains
  fail-stop ownership, and root/state/generation swaps use the original inode
  or fail before launch;
- Playwright persistent launch receives no `storageState` option; replay uses
  immediate `setStorageState()` followed by an `unknown` immediate
  `storageState({ indexedDB: true })` export and closed-schema parse before any
  service-owned page acquisition or work;
- desktop `about:blank` initialization and mobile launch-owned replacement and
  close, existing-page origin inspection, storage helper pages, fulfilled
  origin navigation, and utility evaluation remain Playwright-only while
  service page acquisition, creation, navigation, locator, evaluation, and
  initiating listener work remain absent through verification;
- suppressed storage-helper context events are incomplete and unused; exact
  `http | connect | upgrade` per-session categories cover HTTP handler,
  HTTPS/WSS CONNECT, and WS Upgrade ingress before DNS, policy, or dial;
- non-replay launch proves zero closed-gate violations before open/page/
  `initialUrl`; replay additionally restores, exports, parses, and compares
  before open/page/`finalUrl`, and both navigations positively observe
  ingress-to-DNS-to-policy-to-dial order;
- exact real-Chromium replay roundtrips cookies, localStorage, and IndexedDB;
  semantic normalization drops empty origins, equates absent and empty
  IndexedDB, uses tagged length-framed raw UTF-8 identity tuples with full-byte
  tie-breakers, rejects tag collisions and duplicate or same-primary/different-
  payload identities, and accepts non-ASCII/reversed foundation arrays without
  comparing semantic bytes to checkpoint bytes;
- launch options and exact replay/non-replay call order are inspected; malformed
  unknown export and acquisition/restore/export/parse/compare/gate/navigation/
  fingerprint/timeout/crash failures distinguish zero-launch validation from
  incremental provisional ownership; exact order owns `launch_attempt` before
  calling Playwright and replaces it only when a context returns;
- trusted `preSpawn` rejection proves no browser process/resource and may
  discard; timeout/post-spawn rejection retains
  `cleanup_failed/launch_cleanup_unverified`, working profile, and globally
  closed admission for the current process; verified restart drops the
  process-local token, immediate reconciliation retains the <=10-minute working
  generation and may become ready, and a later generation removes it
  crash-safely only after age >10 minutes;
- gate tests cover invalid open transitions, close from restore-closed/open,
  repeated close, session isolation, checked counter overflow, violation-open
  exclusion, no queue/replay, and post-open DNS/policy/dial ordering; isolation
  compares state plus all five counters, and overflow changes no counter;
- successful returned-context cleanup verifies context/listener/socket and
  working-capability closure before removing ownership; failed public cleanup
  retains truthful `cleanup_failed` ownership and closed admission for sweeper
  retry, performs no
  prepare/stage/finalize/publication, and uses no private browser kill API;
- cleanup tests cover one-shot graceful context close failure followed by
  successful public `browser.close()`, plus unavailable/both-failed fallback
  retention with original promise observation and Browser-only sweeper retry;
- normal writer close verifies context, gate, listener, and socket teardown
  before profile prepare/finalize; any cleanup failure prevents publication;
- the global managed-entry counter includes every yielded nested namespace and
  manifest entry; a non-null overflow lookahead fails with zero downstream
  processing, while descendant maximum mtime controls the 10-minute grace;
- a positive traversal fixture with exactly 25,000 charged entries plus an EOF
  lookahead succeeds. Overflow performs one non-null lookahead but never yields,
  inspects, retains, sorts, stats, opens, content-reads, hashes, plans, or
  mutates it; `bufferSize <= 32`, each root charges once, repeated descendant
  walks recharge descendants, and EOF/ENOENT probes never charge;
- procfd-anchored held directory handles survive ancestor symlink swaps; every
  non-cleanup filesystem await has before/after admission checks, while raw
  finally attempts every handle close after abort, retaining fail-stop
  ownership if any close cannot be verified;
- canonical immutable plan manifest is durable before candidate mutation;
  corrupt/forged/missing-manifest quarantine and source/destination identity
  mismatches fail unsafe untouched;
- every plan and completion state plus every pending entry phase and identity is
  validated read-only before mutation through held recorded parent handles;
  completed plans prove source and destination absent, and their markers equal
  plan SHA, retained, and removed exactly;
- a crash after destination-directory removal but before plan unlink restarts,
  proves the exact authorized absent suffix from a held surviving ancestor, and
  completes cleanup; ancestor replacement or any unauthorized missing parent
  fails unsafe untouched;
- crashes after plan fsync/rename, candidate rename, either parent fsync,
  delete, post-delete fsync, completion marker, or manifest cleanup resume exact
  phases and counts; delete-then-fsync failure retries fsync and counts once;
- the active plan stores one pending-only aggregate removed count; historical
  completion and recursive old aggregates contribute zero, while its entries
  contain current candidates only; union cardinality 25,000 succeeds and 25,001
  fails before plan publication;
- plan-first cleanup accepts a lone final completion marker only with global
  proof of zero quarantine leaves and an exact empty authorized skeleton; it
  deletes only that record and empty ancestors, never path content;
- new process/generation recovery validates authority then enumerates validated
  manifests only, verifies quarantine bytes, and never reconstructs a plan from
  destination paths;
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
