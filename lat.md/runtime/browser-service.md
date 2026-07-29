# Browser Service

Browser Service is Firecrawl's private, stateful Chromium control plane for replayable sessions, bounded browser actions, artifacts, live streams, and durable profile state.

The service is separate from the public API. The API supplies generation authority and reconciliation snapshots; Browser Service owns Chromium processes, session-local policy, and filesystem capabilities. [[apps/browser-service/src/index.ts#createBrowserServiceApplication]] composes these boundaries.

## Process bootstrap

Startup is fail-closed: the process validates configuration and the mounted state root before opening its HTTP listener.

[[apps/browser-service/src/config.ts#readBrowserServiceConfig]] requires a long bearer secret, a canonical absolute `LOCAL_BROWSER_STATE_ROOT`, a bounded port, and a bounded session limit. The state root expands into `profiles`, `replay`, and `quarantine` namespaces.

Before listening on `0.0.0.0`, the application acquires temporary pre-ready recovery authority and checks the filesystem within a five-second default deadline. Unsafe layout, unsupported atomic behavior, or incomplete cleanup keeps the process unavailable.

## Control generations

A control generation is the fencing boundary between one API control-plane view and all browser resources created under that view.

Each generation binds a process nonce, control-generation nonce, and reconciliation digest. Most routes require matching `x-firecrawl-process-nonce` and `x-firecrawl-control-generation-nonce` headers; stale callers cannot use a newer runtime.

`POST /v1/control-generations` is the handoff route. A new generation first fences route admission, drains grants, artifacts, sessions, profile capabilities, and the old root authority, then mints new authority. Drain ambiguity fails the handoff instead of allowing overlapping writers.

Generation requests and reconciliation flights are idempotency-cached with bounded histories. Conflicting replays, exhausted history, superseded handoffs, and nonce mismatches have distinct public error categories.

## Reconciliation gate

Reconciliation converts the API's bounded snapshot of retained filesystem references into the only root capability from which sessions may be admitted.

`POST /v1/reconciliation` accepts up to 25,000 profile or replay references and a 16 MiB request. [[apps/browser-service/src/reconciliation.ts#reconcileBrowserStateWithAuthority]] validates checksums, paths, aliases, directory identities, and generation binding before installing authority.

A successful result reports zero missing and zero corrupt references. Unreferenced safe state is removed, referenced state is retained, and any unverified removal, close, or filesystem identity change leaves readiness closed.

Fresh reconciliation includes an atomic publication canary. This proves the mounted filesystem supports the no-replace rename, directory identity, durability, and cleanup operations required by profile publication.

## Private HTTP protocol

The private API uses strict, bounded JSON schemas and structured error categories; it is not a general-purpose browser endpoint.

Every private request requires:

- `Authorization: Bearer <service key>`, compared without leaking secret length timing;
- printable `x-firecrawl-correlation-id` of 1–128 characters;
- canonical future UTC `x-firecrawl-deadline`, no more than five minutes ahead;
- generation fencing headers except on discovery bootstrap.

[[apps/browser-service/src/auth.ts#authorizePrivateRequest]] validates the common headers. Duplicate headers, unknown fields, oversized bodies, oversized responses, and noncanonical identifiers are rejected.

### Health and authority routes

Health distinguishes process liveness from generation readiness.

- `GET /health/live` discovers the process nonce or checks liveness scoped to a generation.
- `GET /health/ready` requires the current binding and reports whether reconciliation authority is installed.
- `POST /v1/control-generations` creates or hands off control authority.
- `POST /v1/reconciliation` validates and installs the generation's state snapshot.

### Session and action routes

Session routes expose lifecycle and one-writer action execution.

- `POST /v1/sessions` creates a session.
- `GET /v1/sessions/:runtimeSessionId` touches the idle TTL and returns current bounded page state.
- `DELETE /v1/sessions/:runtimeSessionId` closes and may prepare writer profile state.
- `POST /v1/sessions/:runtimeSessionId/actions` executes one idempotent browser action.

### State, artifact, and stream routes

State transport is explicit; no route exposes arbitrary filesystem access.

- Replay checkpoints can be persisted, read, and deleted through `/v1/replay-checkpoints`.
- Prepared profile generations can be finalized, discarded, or released from retention.
- `/v1/sessions/:runtimeSessionId/artifacts` streams a screenshot, trace, or recording with metadata headers.
- Relay grants are minted and revoked under a session before a WebSocket stream may open.

## Session lifecycle

A session is a generation-bound persistent Chromium context backed by a private working profile and a session-specific egress proxy.

[[apps/browser-service/src/session-registry.ts#createSessionRegistry]] owns the registry. Create requests specify an idempotency ID, initial URL, absolute and activity TTLs, monotonic allowed domains, optional profile authority, optional replay authority, and exactly representable browser settings.

Creation follows this sequence:

1. Validate request, targets, profile authority, and replay constraints.
2. Read and validate any replay checkpoint before allocating runtime identity.
3. Create a private working profile, optionally copied from a committed base.
4. Start a session-local egress proxy with restore traffic initially gated.
5. Launch persistent Chromium against that working profile.
6. Restore storage state while egress remains closed, then verify semantic round-trip equivalence.
7. Open egress, acquire the launch-owned page, navigate, observe bounded page state, and start trace and recording producers.
8. Mark the session ready only after all resources and cleanup authority are known.

Any ambiguous Chromium launch or cleanup begins generation drain. Browser Service will not admit more work when it cannot prove whether a process or filesystem writer survived.

## Session authority and expiry

Session authority combines version checks, TTLs, allowed-domain monotonicity, and a single writer lease.

The initial session version is one. Touches and committed actions increment it and extend idle expiry without extending absolute expiry. Action requests carry `expectedSessionVersion`; stale writers receive a concurrency error.

Allowed domains may only stay the same or expand as a unique bounded set. Changing authority disposes the current operation session so future actions rebuild policy from the new set.

A periodic sweep closes expired sessions and retries cleanup-failed entries. Generation handoff and shutdown revoke runtime leases, abort writers, close streams, and wait within bounded deadlines.

## Browser operations

Browser operations expose a compact semantic action vocabulary rather than unrestricted Playwright or CDP access.

[[apps/browser-service/src/operations.ts#createBrowserOperationSession]] supports navigate, click, hover, hover-batch, type, wait, extract, and screenshot operations. Element references come from the bounded accessibility/DOM observation and become stale when the observed page changes.

Action execution is capped by the session deadline and a 45-second default operation timeout. Results carry bounded page state: URL, title, snapshot excerpt, and stable interaction hints.

Action IDs, run IDs, sequence numbers, normalized proposal hashes, and effect classification feed a per-session idempotency cache. Proven no-effect failures may be retried safely; ambiguous side effects close the session.

## Egress boundary

Each session routes Chromium through a private proxy that enforces destination policy independently of page scripts.

[[apps/browser-service/src/egress-proxy.ts#createEgressProxy]] rejects non-HTTP(S) targets, credentials in URLs, private or reserved addresses, invalid CONNECT authorities, DNS answers that are not public, disallowed domains, oversized traffic, excessive tunnels, and expired sessions.

Replay restoration starts behind a closed restore gate. The gate records restore attempts and only opens after storage installation and semantic verification, preventing restored content from producing network effects before the checkpoint is trusted.

The initial origin and explicitly allowed domains form session authority. Browser observations can learn origins for validation, but page content cannot expand the allowlist.

## Profile generations

Profile storage separates mutable browser work from durable generations and makes commit authority explicit.

[[apps/browser-service/src/profile-store.ts#createProfileStore]] manages `working`, `staging`, and `committed` generations. A session starts from an empty profile or an authenticated committed generation.

Snapshot-mode work is discarded on close. Writer-mode work is prepared into staging and returned with a checksum, byte size, and one-time prepare token. A later authenticated finalize publishes it to committed state; authenticated delete discards it.

Prepare tokens are stored as digests, transition requests are serialized, and finalized/deleted responses are idempotent within bounded history. A generation cannot be adopted by another store or reopened after its capability is closed.

## Atomic directory publication

Durable profile transitions use an explicit reducer-driven publication protocol because plain recursive copy or overwrite cannot prove crash consistency.

The protocol records publication intent, destination identity, cleanup identity manifests, source state, canary evidence, and durable phase. It uses a native no-replace rename primitive so publication cannot overwrite an existing generation.

Phases distinguish allocation, building, rename, manifest planning/publication, source deletion, adoption or discard, manifest deletion, and terminal cleanup. [[apps/browser-service/src/atomic-directory-publication.ts#reduceAtomicPublication]] only emits the next bounded filesystem effect after validating the prior observation.

Publication is capacity-bounded by entry counts, payload bytes, metadata bytes, tracked IDs, and manifest sizes. These bounds are security and recovery invariants, not tuning suggestions.

## Crash recovery

Startup recovery replays durable publication intent before normal reconciliation and refuses state it cannot classify.

The recovery path inventories stable and scratch metadata, validates intent/manifest bindings, reconstructs planned manifests when possible, completes proven publications, discards proven pre-publication state, and resumes protected post-order cleanup.

Directory capabilities are anchored by open handles and repeatedly revalidated by device, inode, type, mode, link count, and canonical parent relationships. Symlink traversal, cross-device mutation, replacement races, and unverified absence fail closed.

Cleanup manifests list exact paths and identities in post-order. A cursor is persisted as cleanup advances, permitting bounded restart without reinterpreting attacker-controlled directory contents.

## Image and native trust

Browser Service's image build treats its native no-replace rename addon as part of the persistence trust boundary.

Node, Playwright, architecture-specific base manifests, OS release identity, `util-linux`, and `flock` are digest- or version-pinned. The native addon is built in a closed environment, hashed, copied with production dependencies, and verified again by runtime preflight.

The runtime image omits compilers, package managers, test material, and build traces, then runs as UID/GID 1000. The separate root-owned volume initializer uses a 60-second exclusive `flock`; Browser Service never performs privileged volume setup itself.

## Replay checkpoints

Replay checkpoints persist bounded browser storage independently from profile generations.

Checkpoint authority binds owner, scrape, checkpoint ID, state path, checksum, and byte size. [[apps/browser-service/src/replay-restore.ts#loadReplayCheckpointFromBytes]] verifies canonical encoding and authority before storage reaches Chromium.

Restore re-exports Chromium storage state and compares semantic normalization. The final URL is enforced; title and body fingerprints are diagnostic drift signals rather than hard replay failure.

## Artifacts

Artifacts are session-bound, short-lived streams with integrity metadata.

[[apps/browser-service/src/artifacts.ts#createArtifactService]] captures screenshots, traces, and recordings under bounded sizes and deadlines. Screenshot action bytes are tied to action ID and checksum; other captures use requested artifact IDs.

Artifact leases are released on session close, expiry, generation drain, and shutdown. If a response fails after capture, cleanup still owns the artifact stream.

## Live relay streams

Live streams require both private service authority and a single-use relay grant.

[[apps/browser-service/src/streams.ts#createRelayGrantManager]] mints expiring grants for `passive`, `interactive`, or `cdp` permission. A WebSocket upgrade at `/v1/sessions/:id/streams/:permission` must match session, permission, generation, API-key binding, and `x-firecrawl-relay-token`.

Passive streams carry bounded screencast frames. Interactive streams accept a narrow pointer, wheel, and keyboard protocol. CDP streams allow only schema-validated commands with bounded outstanding IDs, frames, queues, and JSON depth.

Grants have `useLimit: 1`. Revocation, expiry, session close, or generation drain closes associated channels and waits for committed browser effects to settle.

## Shutdown behavior

Shutdown fences new HTTP and WebSocket admission before draining existing effects.

The server aborts reconciliation transport, stops its listener and sweeper, drains the current generation, waits for active requests, closes the WebSocket server, and closes installed authority. A failed drain is surfaced instead of converted to clean shutdown.

## Observability

Browser Service emits bounded structured evidence for persistence and reconciliation without making diagnostics part of correctness.

[[apps/browser-service/src/atomic-publication-observability.ts#createAtomicPublicationObservability]] keeps process-monotonic counters for attempts, success, conflicts, recovery, unsafe bindings, ambiguous state, and close failures.

Severe categories emit one process-lifetime alert; repeated publication conflict alerts after eight conflicts. Startup preflight records platform, architecture, N-API versions, filesystem family, and readiness result.

The sink is failure-isolated so logging cannot change publication or recovery. Reconciliation logs include a correlation ID only when it matches a narrow safe grammar and never expose filesystem paths or capabilities.

The service does not expose a metrics endpoint. Operators consume its JSON output through container logs and combine it with authenticated health and [[operations/local-runtime#Local Runtime Operations#Health|wrapper health]].
