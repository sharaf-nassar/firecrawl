# Local Browser Interact Runtime Design

## Goal

Make Firecrawl Browser and Interact fully functional in this local deployment.
Preserve the existing Firecrawl API and MCP contracts while replacing the
missing proprietary Browser Service and Gemini browser agent with local
services plus the host's ChatGPT-authenticated Codex CLI.

Phase 2 covers:

- `POST /v2/scrape/:jobId/interact`
- `DELETE /v2/scrape/:jobId/interact`
- The create, list, execute, and delete `/v2/browser` routes
- `firecrawl_interact` and `firecrawl_interact_stop`
- Persistent browser profiles, live view, restart recovery, and cleanup

Ordinary scraping continues to use the existing stateless Playwright service.
Only the Firecrawl API is published on `127.0.0.1`; every new component remains
on a private network or Unix socket.

## Approved Decisions

- Add a dedicated, backend-only Browser Service. Do not retrofit persistent
  sessions into `apps/playwright-service-ts`.
- Start one ephemeral Codex process for each prompt-based Interact request.
- Use `gpt-5.6-terra` with `medium` reasoning effort.
- Expose only typed browser tools to Codex. Never expose a raw host shell,
  Docker, user files, or the normal Codex tool environment.
- Execute Node, Python, and Bash code mode in disposable `runc` OCI sandboxes
  through a narrow root-owned broker.
- Keep profiles durable and replay browser state after process or service
  restarts. Active execution itself is not resumed.
- Expire sessions after 10 minutes idle or 60 minutes absolute. Honor a
  caller's shorter requested limit.
- Permit one writer per profile and any number of immutable read-only
  snapshots. Publish profile changes atomically.
- Allow navigation to the initial origin, validated redirect and clicked-link
  origins, and explicitly allowed domains. Cap each session at 8 origins.
- Proxy live view through the API with separate passive and interactive
  permissions and short-lived opaque URLs.
- Stop is terminal for the active browser and execution. A later Interact call
  creates a new browser and replays the persisted scrape/profile context.
- Never retry a model-generated browser action automatically.
- Never fall back to Gemini, Fireworks, Firecrawl Cloud, or an API key.

## Current Gap

The existing controllers already implement the public request and response
shapes. They call a proprietary service through `BROWSER_SERVICE_URL` using:

- `POST /browsers`
- `POST /browsers/:id/exec`
- `DELETE /browsers/:id`

No implementation of that service exists in the repository. The existing
Playwright service creates a new context and page for each `/scrape` request,
then closes them; it cannot provide sessions, profiles, CDP, live view, or
restart recovery.

Prompt Interact currently invokes a Gemini-specific loop and emits shell
commands. Code execution also relies on the missing Browser Service. Replay
reconstructs only URL, `waitFor`, and a subset of actions, silently omitting
browser-affecting scrape options. Drizzle declares browser session tables, but
the checked-in local migrations do not create them.

## Architecture

```text
Claude Code / Codex / SDK
          |
          v
Firecrawl API (only published TCP surface)
  |       |                 |
  |       |                 +--> live-view and CDP proxy
  |       +--> app-postgres + MinIO
  |
  +--> browser-service (private Compose network)
          |        |
          |        +--> persistent Chromium + profile volume
          |
          +--> bounded browser operation RPC
                       ^
                       |
private Unix socket    | browser capability, held by bridge
          |            |
host execution adapter --> root sandbox broker --> isolated `codex exec`
          |                         |
          |                         +--> isolated disposable code runner
          +--> fixed job policy only
```

### Firecrawl API

The API remains the policy and compatibility boundary. It validates owner and
scrape access, creates run/session records, builds replay context, issues
capabilities, maps internal failures to Firecrawl responses, proxies live
view, and coordinates cancellation. MCP receives no special path; its calls
exercise the same API as SDK and direct clients.

### Browser Service

Add a separate service responsible for Chromium process lifecycle, contexts,
pages, profile snapshots, replay, typed browser operations, live-view frames,
and idle/absolute expiration. It accepts only authenticated backend requests.
It does not invoke Codex or execute arbitrary host commands.

The service maintains a process registry for current runtime state. PostgreSQL
is authoritative for session state, and a named volume holds versioned browser
profiles. MinIO stores screenshots, recordings, trace excerpts, and other
large artifacts when requested.

### Host Codex Adapter

Run a systemd user service outside Docker and expose a private Unix socket in a
host runtime directory. Mount that socket only into the API component that
submits adapter jobs. The adapter owns Codex authentication and never returns
credentials or raw environment data.

Each prompt request starts one process with these boundaries:

- `codex exec --ephemeral`
- Explicit model `gpt-5.6-terra` and reasoning effort `medium`
- Outer `runc` mount/process isolation plus the read-only Codex sandbox
- A new empty working directory with no host workspace or home-directory bind
- Dedicated, adapter-controlled `CODEX_HOME` and generated profile
- Only the private typed Browser MCP configured
- Explicit `enabled_tools` for the request
- Each enabled Browser MCP tool set to `approval_mode = "approve"`
- `approval_policy = "never"` so unattended runs never wait for UI input
- `features.shell_tool = false` and `features.unified_exec = false`
- No user config, rules, skills, plugins, hooks, web search, shell, arbitrary
  files, multi-agent behavior, built-in execution tool, or other MCP servers
- Adapter deadline, output limit, subprocess watchdog, and structured result
  schema

This boundary follows the verified official Codex configuration surface:
isolated `CODEX_HOME`, explicit MCP tool enablement, per-tool approval mode,
noninteractive approval policy, read-only sandboxing, ephemeral execution, and
model/reasoning overrides. It must not use danger-full-access,
`--dangerously-bypass-approvals-and-sandbox`, or equivalent yolo settings.
Browser MCP annotations remain truthful about side effects; explicit per-tool
approval is the API's bounded job authorization, not a false read-only hint.
Because official Codex behavior still treats destructive MCP annotations as an
approval boundary, a real side-effecting private-tool call on installed Codex
0.144.5 is Phase 2 gate zero. It must complete headlessly with the exact
isolated config above. If it pauses, rejects the call, exposes another tool, or
requires a broader approval/sandbox setting, implementation stops and this
design is revised before migrations or services are added.

The OCI container is the outer host-filesystem boundary. Bind only the
generated per-run configuration, the minimum read-only authentication file
needed by the installed ChatGPT credential store, and one session relay into
a pinned Codex root filesystem. Share host networking only because Codex must
reach OpenAI; web search, shell, and all model-controlled network tools remain
disabled. The model cannot select paths, binds, environment variables, MCP
servers, or network destinations.

Authentication material remains adapter-owned. Browser content, prompts, and
tool results are visible to the selected OpenAI model; they are not sent to
Gemini, Fireworks, or Firecrawl Cloud.

### Disposable Code Runner

Code-based Interact bypasses Codex. The host adapter asks a root-owned sandbox
broker to start a fresh `runc` container for Node, Python, or Bash. Setup
builds pinned Codex and code-runner images and materializes their checksummed
read-only root filesystems while the operator-controlled lifecycle script is
running. Per-request execution never connects to Docker or receives its
socket.

The sandbox receives only request input, a tmpfs, and a session-scoped browser
relay. The runner exposes the existing page-oriented code contract through a
bundled Playwright/agent-browser compatibility layer. Its CDP traffic crosses
the relay, where Browser Service applies the same session, writer, deadline,
and origin policy as typed operations. The sandbox has no network namespace
route of its own.

`runc` applies mount, PID, network, IPC, and UTS namespaces, a read-only root,
seccomp, dropped capabilities, `noNewPrivileges`, a non-root process identity,
tmpfs size limits, and cgroup v2 CPU, memory, PID, and wall-clock limits. Code
containers receive a fresh network namespace with no external interface.
Destroy the container, cgroup, and scratch data after every execution.

The broker is a small systemd system service with a root-owned,
adapter-group-restricted Unix socket. It accepts only an allowlisted bundle
ID, job ID, fixed resource preset, deadline, sealed input descriptor, and
pre-created relay descriptor. It rejects arbitrary commands, arguments,
paths, mounts, environment variables, images, and network settings. The
unprivileged adapter never obtains root, general `runc` control, or the
broker's private filesystem. Neither service receives the Docker socket.

This host already has `runc` 1.3.6 with namespaces, seccomp, cgroup v2,
systemd cgroups, and AppArmor support. Ubuntu AppArmor currently blocks
unprivileged user namespaces, so rootless Bubblewrap/`runc` is not a valid
boundary here. Setup performs one explicit administrator-approved broker/unit
installation, then startup verifies the broker and fixed bundles. It reports
`sandbox_unavailable` rather than installing a tool, changing the AppArmor
sysctl, exposing Docker, or weakening isolation.

## Public API Compatibility

Preserve existing validation, ownership, billing/keyless behavior, and
response fields. Internal implementation changes must not require MCP changes.

### Scrape Interact

`POST /v2/scrape/:jobId/interact` continues to accept exactly one of `prompt`
or `code`, plus `language`, `timeout`, `origin`, `integration`, and
`existingSessionId`. Add an optional, backwards-compatible `allowedDomains`
array for direct navigation beyond origins learned from validated redirects
and clicked links. It is normalized, validated, and rejected if the resulting
session set would exceed 8 origins. Existing MCP calls require no change. The
response keeps output/stdout/result/stderr/exit fields plus live-view fields
when enabled.

The existing `origin` field remains execution/trace attribution; it is never a
URL allowlist or security grant. Derive the initial security origin only from
the persisted target URL. `allowedDomains` is the only caller-supplied
navigation extension.

`DELETE /v2/scrape/:jobId/interact` remains idempotent. It cancels current
execution, revokes capabilities and proxy URLs, terminates Codex/code runner,
closes Chromium, atomically saves a writable profile, and persists a terminal
state. A later POST creates a fresh session and replays context.

### Direct Browser API

Preserve create, list, execute, and delete routes under `/v2/browser`.
Creation honors `ttl`, `activityTtl`, `streamWebView`, and profile settings.
Preserve direct Browser API omitted-value behavior: 600 seconds absolute and
300 seconds idle. Accept up to the approved safety maxima of 3600 seconds
absolute and 600 seconds idle, honor shorter values, and normalize
`activityTtl <= ttl`. Interact-created sessions deliberately use 3600 seconds
absolute and 600 seconds idle; their credit preflight and reservation must use
that larger lifetime rather than the old 600-second assumption. Execute
accepts the same optional `allowedDomains` extension as Interact.

Existing `cdpUrl`, `liveViewUrl`, and `interactiveLiveViewUrl` fields contain
opaque API proxy URLs rather than private service addresses. CDP access is a
separate, tightly scoped execution permission. Listing never exposes raw
backend endpoints or reusable bearer material.

## Request Flows

### Prompt Interact

1. API authenticates the local owner and verifies scrape ownership.
2. API loads the versioned replay context or returns an explicit conflict.
3. API reuses a ready owned session or creates a new Browser Service session.
4. Browser Service restores a post-scrape checkpoint or performs only a
   replay-safe reconstruction of the original context.
5. API creates an Interact run and a server-held browser capability.
6. Host adapter creates isolated Codex configuration and starts one ephemeral
   process with only the typed Browser MCP.
7. Codex observes and acts through bounded typed operations.
8. Adapter validates structured output, terminates the process, and returns
   the result. API revokes the capability and persists terminal run state.
9. Browser remains ready until stop or TTL expiry. Profile changes publish
   atomically when the writer session closes.

Codex receives no automatic retry after an action error. The error and current
page state remain available for the model to decide its next action within the
same run. Only an idempotent infrastructure request may receive one bounded
retry before any effect is observed.

### Code Interact

Steps 1 through 5 match prompt mode. API then asks the host adapter to start a
disposable language runner with a session-scoped relay. The runner captures
stdout, result, stderr, exit status, killed state, and bounded artifacts.
Cancellation kills the process tree and sandbox before terminal state is
reported.

### Restart Replay

An active Chromium or Codex process is never considered durable. On adapter,
API, or Browser Service startup:

1. Mark unfinished executions `interrupted` and revoke their capabilities.
2. Kill adapter-owned orphan Codex and code-runner processes.
3. Close or discard Browser Service processes not tied to a live registry.
4. Preserve scrape replay context, session history, profile generations, and
   artifacts.
5. On the next Interact call, create a new browser, restore the last committed
   profile/checkpoint generation, and perform a replay-safe reconstruction.

No request claims that an interrupted model or code execution resumed.

## Replay Contract

Persist a normalized, versioned replay envelope when the original scrape is
accepted. On successful completion of a non-ZDR scrape, also persist a
post-scrape checkpoint and verification fingerprint before the stateless
Playwright context closes. The envelope includes:

- Canonical target URL and caller-approved origin
- Wait and sanitized action sequence with an explicit effect classification
- Headers and cookies that policy permits retaining
- Mobile/device, locale, timezone, geolocation, and viewport settings
- Proxy selection metadata without secret material
- TLS, ad-blocking, and lockdown behavior
- Profile name/generation and navigation policy version
- Final URL, restorable storage state, checkpoint reference/checksum, and
  bounded page-state verification markers

Formats and post-processing options that do not affect browser state are not
replayed. Secrets are referenced through server-side records, never copied
into Codex prompts, capability payloads, URLs, or logs.

For pre-Phase-2 scrape rows, a versioned compatibility adapter reconstructs
the envelope from retained URL/options. It must reject unknown, malformed, or
unrepresentable browser-affecting options rather than omit them. Return
`replay_unsupported` with an actionable 409 response naming unsupported
fields. ZDR/redacted records without necessary context remain an explicit 409
and instruct callers to rerun the scrape.

Never blindly repeat a scrape action. For new rows, restore checkpointed
cookies/storage and load the checkpoint's final URL, then compare the bounded
verification fingerprint. The saved action sequence is audit/context data,
not an instruction to repeat already completed effects. If the checkpoint
cannot reproduce required ephemeral page state, return `replay_unsupported`
instead of guessing.

Legacy rows without a checkpoint may reconstruct only actions classified as
replay-safe: waits, scrolling, and read-only scrape/screenshot/PDF effects.
Treat clicks, writes/fills, key presses, downloads, and arbitrary JavaScript as
side-effecting unless a future action-specific proof establishes idempotence;
their presence returns `replay_unsupported`. Replay is fail-fast. A failed
navigation, safe action, fingerprint check, or profile restore identifies the
failing step and leaves the session terminal; prompt/code execution does not
begin on partial reconstruction.

## Browser Tools and Capabilities

The private MCP exposes only typed operations:

- `snapshot`
- `click`
- `fill`
- `type`
- `press`
- `select`
- `scroll`
- `wait`
- `get_text`
- `get_url`
- `navigate`
- Constrained `evaluate`

Each operation has a strict input/output schema, maximum payload, operation
timeout, and redaction policy. `evaluate` accepts a restricted page-context
expression/program, not Node APIs, imports, filesystem access, sockets, or a
Browser Service escape hatch. Snapshots expose stable element references and
bounded text instead of unrestricted page dumps.

`navigate` accepts only an absolute HTTP(S) URL whose normalized domain is
already authorized by the session's navigation set. It cannot add an origin;
only API validation of `allowedDomains` or a validated redirect/click may do
that.

Capability records stay server-side. Codex sees browser tool names and
results, not bearer secrets. A capability is bound to:

- Local owner, scrape, browser session, Interact run, and Codex process ID
- Allowed operation set
- Allowed origin set and navigation policy version
- Maximum calls, bytes, wall-clock deadline, and per-operation deadline
- Issued, redeemed, revoked, and expiry timestamps

Only the per-run bridge can redeem it. Browser Service revalidates state on
every call. Capabilities fail closed after completion, stop, timeout, process
exit, owner mismatch, session replacement, or service recovery.

## Navigation and Network Policy

Start each session with the target URL's normalized origin. Permit expansion
only when all validation succeeds:

- A redirect destination is validated before following it.
- A clicked link destination is derived from the currently rendered page and
  validated before navigation.
- Direct navigation to another origin requires a domain in the request's
  validated `allowedDomains` set.
- A session may contain at most 8 normalized origins.

Resolve and validate every hostname at connection time. Reject loopback,
link-local, private, carrier-grade NAT, multicast, metadata, Unix-socket, and
backend service destinations, including IPv4/IPv6 encodings and DNS rebinding.
Apply navigation-set checks to top-level navigation and navigation redirects.
Apply public-egress/SSRF checks to frames, workers, WebSockets, downloads, and
all browser-initiated subrequests. Revalidate redirects and DNS answers
instead of trusting the original URL parse.

The 8-origin set governs navigation authority, not ordinary public CDN/API
subresources. Non-navigation requests may reach other public origins only
after scheme, DNS, resolved-address, redirect, and response-size checks; they
do not enter the navigation set or authorize a later top-level navigation.
Block downloads by default unless the request contract explicitly asks for a
bounded artifact.

Do not silently broaden origin access because page text or a prompt requests
it. Tool results expose policy denials as typed errors without internal host
or network details.

## Profiles and Concurrency

A profile name is owner-scoped and maps to immutable generations on the
profile volume. Session creation obtains either:

- A writer lease: exclusive for the profile, initialized from the latest
  committed generation, with `saveChanges: true`
- A read snapshot: initialized from a specific committed generation and never
  publishes changes, with `saveChanges: false`

Writer lease acquisition is transactional. A second writer receives the
existing 409 profile-lock response; it is not retried. Read sessions copy or
clone the committed generation and never read a writer's working directory.

On normal close, stop, or TTL expiry, Browser Service flushes Chromium,
validates the profile, writes a new generation to a staging path, fsyncs it,
and atomically advances the database pointer. Crash recovery discards staging
generations and retains the prior committed one. Profile data never enters
MinIO unless an explicit encrypted backup feature is later designed.

## State Machines

### Browser Session

```text
creating -> replaying -> ready <-> executing
   |           |          |          |
   +-----------+----------+----------+-> stopping -> destroyed
                                      -> expired
                                      -> interrupted
                                      -> error
```

`destroyed`, `expired`, `interrupted`, and `error` are terminal for that
runtime session. A future request creates a new session linked to the same
scrape and profile lineage. One session permits one mutating execution at a
time. Passive live view and read-only snapshots may coexist with the writer.

### Interact Run

```text
queued -> starting -> running -> succeeded
                           |---> failed
                           |---> cancelled
                           |---> timed_out
                           `---> interrupted
```

Terminal transitions use compare-and-set updates. Completion, cancellation,
and timeout may race, but exactly one state and one cleanup owner win.

## Persistence and Migrations

Add versioned local migrations before enabling Browser Service health. Align
Drizzle schema and helpers with the migrated tables; do not rely on Redis for
durable browser or prompt flags.

Required durable records:

- `browser_sessions`: owner, scrape, runtime/browser IDs, profile generation,
  replay version, state, TTL deadlines, current run, create/update/terminal
  times, terminal reason, and billing counters
- `browser_session_activities`: session/run, mode/language, bounded timing and
  exit metadata, source, correlation ID, and timestamps
- `browser_interact_runs`: prompt/code mode, status, configured model/effort,
  deadlines, adapter process identifier, output/artifact references, error
  category, and lifecycle timestamps
- `browser_profiles`: owner/name identity, latest committed generation, writer
  lease/session, retention state, and timestamps
- `browser_profile_generations`: immutable generation metadata, filesystem
  path identifier, size/checksum, committed/expired times
- `browser_replay_checkpoints`: non-ZDR scrape, version, protected state path,
  final URL, verification fingerprint, checksum, and retention timestamps
- `browser_capabilities`: hashes and policy metadata only, never raw tokens
- `browser_proxy_grants`: hashes, passive/interactive/CDP permission, owner,
  session, expiry, use limit, and revocation

Use foreign keys to local owners/scrapes where retention semantics permit.
Indexes cover owner/status, scrape/current session, run/status, expiry,
profile writer lease, and capability/grant expiry. Migrations are idempotent
under the existing migration runner and API health fails closed if pending.

MinIO artifacts use stable owner/scrape/session/run prefixes and manifest
records. Object retention follows database retention. Profile-volume cleanup
removes only unreferenced expired generations after the database transaction
commits. Replay checkpoints contain sensitive browser state, remain on the
owner-restricted profile volume, and follow scrape retention.

ZDR/redacted scrapes never create a replay checkpoint, browser profile change,
Interact run, or browser artifact. Their future Interact call returns the
documented 409 before a browser session starts. Supporting a same-live-session
ZDR exception would require a separate ephemeral contract and is out of scope.

## Private Service Contracts

All private requests carry a correlation ID, absolute deadline, authenticated
service identity, and typed JSON schema. Unknown fields are rejected.

Browser Service provides bounded operations equivalent to:

- Create session from replay envelope/profile snapshot
- Query session state
- Execute one typed browser operation
- Open/revoke passive, interactive, or CDP proxy stream
- Close session with save/discard policy
- Health probe that creates and destroys a disposable session

The Codex adapter accepts a prompt job with model policy, output schema,
Browser MCP tool allowlist, run identifier, and deadline. It streams bounded
events internally and returns only validated structured output plus sanitized
usage/process metadata.

The code runner accepts language, source, session relay grant, deadline, and
resource limits. It returns existing execution response fields. Neither
adapter contract accepts arbitrary environment variables, command-line
arguments, mounts, network destinations, MCP configuration, or model names
from the public request.

Private contracts use cancellation signals. Client disconnect, stop, or
deadline propagates API to adapter/Browser Service to child process. A
transport retry is allowed only for an idempotency-keyed request whose outcome
is known to have no externally visible effect.

## Live View and CDP Proxy

Browser Service emits frames and accepts input only through authenticated
private streams. API returns short-lived opaque proxy URLs bound to owner,
session, permission, expiry, and use limit:

- Passive grant: view frames and connection state only
- Interactive grant: passive access plus approved keyboard/pointer input
- CDP grant: direct Browser API compatibility, separately issued and never
  implied by either live-view grant

Validate ownership when minting and redeeming grants. Tokens are stored only
as hashes, never logged, stripped from referrers, and revoked on stop,
terminal state, replacement, or expiration. Use restrictive CSP, origin
checks, no third-party framing, and `Cache-Control: no-store`. Interactive
input passes the same session writer lock and origin policy as tool actions.

## Error Contract

Internal failures use typed categories and sanitized detail:

- `scrape_not_found` -> 404
- `forbidden` -> 403
- `profile_locked` -> 409
- `replay_unavailable` or `replay_unsupported` -> 409
- `session_destroyed` or `session_expired` -> 410
- `capability_denied` or `target_blocked` -> 403
- `concurrency_exceeded` -> 429
- `browser_unavailable`, `codex_unavailable`, or
  `sandbox_unavailable` -> 503
- `model_unavailable` -> 503
- `deadline_exceeded` -> 504
- `cancelled` -> existing cancellation response semantics

Public response bodies keep `success: false` and a useful message. Logs and
internal activity records retain category, failing component, replay step, and
correlation ID without cookies, prompt secrets, page form values, raw grants,
or internal network addresses.

No configuration or downstream error triggers provider fallback. Missing
Browser Service, Codex auth/model, the verified `runc` broker/bundles, or a
migration produces a typed health failure and keeps dependent endpoints
unavailable.

## Threat Model

Security tests and review must address:

- Page prompt injection asking Codex to use host tools or reveal secrets
- Malicious DOM/tool output causing arbitrary MCP calls or oversized context
- Model-generated origin escape, unsafe `evaluate`, downloads, or data
  exfiltration
- SSRF, open redirects, DNS rebinding, alternate IP syntax, WebSockets, and
  subresource access to local infrastructure
- Cross-owner/session/profile access and stale capability replay
- Interactive live-view token theft, privilege confusion, click injection,
  and CSRF
- Node/Python/Bash sandbox escape, fork bombs, output bombs, and access to
  Docker or host mounts
- Sandbox-broker protocol abuse, descriptor/path smuggling, bundle tampering,
  stale job reuse, and attempts to select commands or resource policies
- Codex access to user config, rules, skills, plugins, hooks, other MCPs,
  workspace files, environment variables, and auth files
- Profile corruption, partial publication, concurrent writers, and sensitive
  cookie leakage in logs or artifacts
- Cancellation races and orphan Chromium, Codex, or code-runner processes

Page content is always untrusted. A model decision never replaces server-side
authorization, origin validation, resource limits, or schema validation.

## Operations and Recovery

Extend `scripts/local-firecrawl` to manage Compose and host services as one
runtime:

- `install-host`: one explicit interactive administrator step that installs
  or upgrades the checksummed broker binary, fixed unit, group/socket policy,
  and OCI bundles; normal agent operation never invokes `sudo`
- `start`: validate prerequisites and Codex login, start adapter, apply
  migrations, ensure the installed broker is healthy, start services, and
  wait for health
- `restart`: stop execution in order, preserve state/volumes, restart adapter
  and Compose, recover terminal state, and wait for health
- `status`: show adapter, Browser Service, migration, active session/run,
  profile-lock, and cleanup state
- `health`: verify migrations, app database, MinIO, disposable Browser Service
  create/destroy, adapter socket/auth/model, typed Browser MCP bridge, and
  `runc` broker/bundle isolation
- `logs`: provide bounded component/correlation filtering with redaction

Ordered shutdown stops accepting new runs, cancels adapters/runners, revokes
grants, closes Chromium, commits healthy writable profiles, persists terminal
state, then stops services. Forced timeout leaves previous profile generation
intact and recovery marks unfinished work interrupted.

Only the API publishes a TCP port. Browser Service, live-view source, CDP,
databases, MinIO, queues, and adapter remain private. Never mount the Docker
socket. Extend backup/restore documentation and tooling to include the browser
profile volume plus database generation metadata; verify checksums after
restore.

Retention periodically expires sessions/grants/capabilities, terminates
orphan processes, removes expired artifacts, and garbage-collects unreferenced
profile generations. Cleanup uses leases so multiple API/worker processes
cannot race.

## Rollout

0. Before repository implementation, run a throwaway installed-Codex spike
   with an isolated temporary `CODEX_HOME` and a local side-effecting stub MCP
   tool. Prove the exact model, reasoning, disabled built-ins, enabled-tool
   allowlist, per-tool approval, `approval_policy = "never"`, and headless JSONL
   completion behavior. Stop and revise the design on any mismatch.
1. Add migrations, state helpers, replay envelope, post-scrape checkpoint, and
   cleanup/recovery logic
   behind `LOCAL_BROWSER_SERVICE_ENABLED=false`.
2. Add Browser Service with typed operations, profiles, origin enforcement,
   and fixture-based contract tests.
3. Add API compatibility integration, live-view proxy, and direct Browser API
   coverage while the Gemini path remains disabled in local mode.
4. Add the isolated Codex adapter, private Browser MCP, fake-runner contract
   tests, and one real end-to-end Codex smoke through the installed broker.
5. Add the disposable `runc` code runner for all three supported languages
   and escape/resource tests.
6. Enable local Browser Service by default only after restart, stop, retention,
   and hostile-input gates pass.
7. Validate through new Claude Code and Codex MCP processes. Remove the local
   Gemini browser path and any obsolete cloud fallback configuration.

Rollout never exposes a half-configured fallback. While disabled or unhealthy,
Browser/Interact returns the typed local configuration error.

## Testing Strategy

New tests are authorized for this phase. Prefer API snips for externally
observable behavior and focused service/unit tests for isolation boundaries.

### Deterministic Tests

- Replay envelope normalization, legacy reconstruction, unsupported fields,
  ZDR/redacted context, and per-step failures
- Browser and run state transitions, compare-and-set races, TTLs, idempotent
  stop, and restart interruption
- Capability/grant ownership, expiry, operation/origin/call/byte limits, and
  revocation
- One profile writer, read snapshots, atomic generation publication, crash
  recovery, and retention
- Browser Service typed operation and live-view contracts
- Fake Codex process command/config construction, private MCP exposure,
  structured output, approval-free headless execution, denied unlisted tools,
  cancellation, timeout, and orphan cleanup
- Node, Python, and Bash runner success/failure, resource limits, network
  isolation, output bounds, and process-tree termination
- Broker schema/peer-credential enforcement, sealed descriptors, fixed-bundle
  checksums, symlink/path rejection, and malformed-job denial
- Error/status mapping and log redaction

### Integration and Security Tests

- Prompt and code Interact through persisted local scrape IDs
- Direct Browser create/list/execute/delete compatibility
- Session reuse, controlled navigation expansion, 8-origin cap, passive versus
  interactive live view, CDP grant isolation, and cross-owner denial
- Service/API/host-adapter restart followed by a new replayed Interact request
- Migration failure gate, retention, backup/restore, and no orphan processes
- Hostile pages for prompt injection, SSRF, redirects, DNS rebinding, private
  subresources, WebSockets, oversized DOM, unsafe evaluate, and downloads
- Sandbox escape attempts against filesystem, process, network, credentials,
  and Docker
- Assert no traffic reaches Firecrawl Cloud, Gemini, or Fireworks

After deterministic gates pass, run one real Codex smoke against a controlled
public fixture using `gpt-5.6-terra` at `medium`. Finally invoke
`firecrawl_interact` and `firecrawl_interact_stop` from fresh Claude Code and
Codex MCP sessions. Do not use public-site success as a substitute for fixture
coverage.

## Acceptance Criteria

Phase 2 is complete when:

1. Prompt Interact works through the local MCP and existing `/v2` API contract
   using one ephemeral `gpt-5.6-terra`/`medium` Codex process.
2. Node, Python, and Bash code Interact run in disposable isolated sandboxes
   and return existing response fields.
3. All direct `/v2/browser` create, list, execute, and delete flows pass.
4. Stop is idempotent and leaves no browser, Codex, runner, capability, proxy
   grant, or writer lease active.
5. Restart marks in-flight work terminal, preserves committed profiles and
   replay context, and a later request recreates and replays the session.
6. Profile single-writer/read-snapshot behavior and atomic publication survive
   crash and concurrent-session tests.
7. Live view and CDP are reachable only through owner-bound API proxy URLs;
   passive grants cannot send input.
8. Navigation enforcement covers redirects, clicked links, direct origins,
   subrequests, DNS rebinding, and the 8-origin limit.
9. Replay either reproduces every retained browser-affecting option or returns
   an explicit `replay_unsupported`/`replay_unavailable` error.
10. Codex sees only approved typed browser tools and cannot access user config,
    host files, shell, Docker, other MCPs, plugins, hooks, skills, or arbitrary
    network destinations.
11. Hostile pages and code cannot escape Browser Service, Codex, or `runc`
    boundaries or access another owner/session/profile.
12. No Browser/Interact path uses Gemini, Fireworks, Firecrawl Cloud, or an API
    key fallback.
13. Only Firecrawl API is published on `127.0.0.1`; all health, migration,
    retention, recovery, and focused test gates pass.

## Trade-offs

Dedicated Browser Service adds another runtime and migration surface, but
keeps persistent-session concerns out of the stateless scraper and preserves
one API contract for MCP, SDK, and direct callers.

One Codex process per prompt has startup latency and consumes ChatGPT usage,
but gives strong request isolation and simple cancellation. The isolated
profile and private typed MCP are required controls, not optional hardening.

Durable profiles improve continuity but contain sensitive cookies and site
state. Owner scoping, exclusive writers, immutable generations, atomic
publication, strict filesystem permissions, retention, and explicit backup
handling are required before profiles are enabled.

Replay after restart restores browser context, not model execution. This
avoids pretending an interrupted agent continued safely and makes terminal
state, billing, cancellation, and audit behavior deterministic.
