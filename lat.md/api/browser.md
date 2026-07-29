# Interactive Browser Runtime

Interactive browser resources expose live sessions and scrape replay while keeping ownership, side effects, profiles, concurrency, billing, and crash recovery under durable control.

## Runtime modes

Browser endpoints preserve one public contract across a hosted browser service and the local browser-control runtime.

`POST /v2/browser` and its legacy `/v2/interact` alias create standalone sessions. Scrape-bound interaction starts from a retained replay checkpoint through `/v2/scrape/:jobId/interact`.

Hosted mode calls the configured browser service, then persists a compatibility session record. Local mode uses [[apps/api/src/lib/browser-runtime/public-browser-runtime.ts#createPublicBrowserRuntime]] to coordinate the private service with application-database state and local artifacts.

## Admission and lifetime

Browser admission reserves scarce capacity before a private service session becomes publicly usable.

The controller checks projected time-based credits and the team's combined scrape, crawl, and browser concurrency. A session has both an absolute deadline and an optional idle deadline; recorded activity may extend only the idle side.

Local admission records which Redis or FoundationDB concurrency backend owns the external slot. Failed creation and terminal sessions create durable cleanup work so a crash cannot permanently consume capacity.

## Durable state model

Browser state separates public session identity from executions, actions, reusable profiles, replay data, capabilities, and proxy access.

- Request and session rows anchor team ownership, deadlines, terminal reason, billing context, and admission backend.
- Interact runs identify prompt or direct execution and the private adapter job that owns it.
- Actions carry a caller identity, sequence, normalized proposal hash, effect class, state, and bounded result references.
- Profiles point to immutable committed generations; replay envelopes and checkpoints preserve scrape-time browser context.
- Capabilities authorize a bounded set of private operations, origins, calls, bytes, and time.
- Proxy grants store only token hashes plus permission, use, redemption, revocation, and expiry state.

Large screenshots, replay checkpoints, and profile generations use artifact storage; PostgreSQL retains their authority and checksums.

## Startup fencing and reconciliation

Local browser mutations remain unavailable until database state and the private browser service agree on one control generation.

[[apps/api/src/lib/browser-runtime/reconciliation-coordinator.ts#createBrowserReconciliationCoordinator]] freezes a database snapshot, establishes a process/service handoff, reconciles referenced profiles and replay checkpoints, then publishes the accepted generation.

[[apps/api/src/lib/browser-runtime/startup-gate.ts#createBrowserStartupGate]] gives mutations a fenced lease. A changed process nonce, service identity, control generation, or failed commit acknowledgement closes the gate and prevents stale work from becoming authoritative.

HTTP listener startup waits for this reconciliation. Reads and writes therefore cannot observe a half-migrated browser database or a newly restarted service using an old filesystem generation.

## Session and profile lifecycle

Session creation and stopping are multi-resource transitions rather than direct remote calls.

[[apps/api/src/lib/browser-runtime/orchestrator.ts#createBrowserSessionOrchestrator]] creates the durable session, acquires any profile writer, starts or replays the private browser, and publishes public proxy URLs only after the state is ready.

Only one live session may write a named profile. Read-only sessions may reuse the latest committed generation. A new generation is staged during use and becomes current only after stop captures, manifests, and commits the resulting checkpoint.

Stopping uses a renewable claim. Late callbacks, repeated DELETE requests, expiry workers, and service-destroyed notifications converge on one terminal transition; losing the claim prevents a stale stopper from committing profile or billing state.

## Scrape replay and prompt interaction

Scrape interaction starts a browser from the original scrape's retained browser context, not from the response document alone.

The controller verifies scrape ownership, resolves the replay envelope and checkpoint, and constrains navigation to the requested domains plus replay origins. Forced zero-data-retention scrapes are rejected because no replay checkpoint may exist.

Prompt mode creates a bounded decision loop. Direct mode exposes explicit browser operations. Both use the same session, run, capability, action, and terminal accounting model.

## Action execution

Browser actions use stable identities and ordered durable state so retries cannot silently duplicate side effects.

[[apps/api/src/lib/browser-runtime/action-coordinator.ts#createBrowserActionCoordinator]] canonicalizes each proposal, binds its hash to an action ID and sequence, and distinguishes read-only from side-effecting work.

A repeated identity with different content is rejected. Completed actions replay their stored outcome. An already-executing side effect is not run again, and a lost response becomes `outcome_unknown` rather than being guessed safe to retry.

Runs accept at most 25 ordered actions. Protocol schemas bound JSON depth and node count, text, observation, response, and screenshot sizes before durable storage or model reuse.

## Proxy access

Public live-view and CDP URLs are short-lived capabilities, not direct exposure of the private browser service.

[[apps/api/src/controllers/v2/browser-proxy.ts#createBrowserProxyHandlers]] redeems a hash-only grant for one permission and bounded uses, checks session ownership and startup authority, then creates a private grant for the upstream handshake.

If the gate closes, redemption rolls back, or the upstream handshake fails, the private grant is revoked. HTTP view assets reveal no service credential; the token in the URL is the credential and expires independently of the session.

## Billing and terminal cleanup

Browser billing is based on observed session duration and whether prompt interaction used the higher interaction rate.

Hosted compatibility mode uses a single destroyed-session claim to prevent duplicate billing. Local mode commits a billing outbox row with terminal state, then a leased worker records per-sink receipts for account billing or keyless quota reconciliation.

Admission cleanup separately releases the exact Redis, FoundationDB, or migration-era dual backend recorded at acquisition. Billing delivery and capacity release can retry independently without reopening the terminal session.

## Browser invariants

Interactive-browser correctness depends on explicit authority at every external boundary.

- A public session is always owned by one request team.
- Local state mutations require the current startup fence.
- A private adapter job may own only its bound run and capability.
- A side-effecting action is never replayed after execution becomes uncertain.
- At most one session writes a profile generation.
- Terminalization is monotonic and guarded by a renewable stop claim.
- Billing and concurrency cleanup are durable, idempotent follow-up work.
