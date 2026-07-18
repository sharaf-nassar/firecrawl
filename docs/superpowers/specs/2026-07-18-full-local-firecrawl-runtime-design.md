# Full Local Firecrawl Runtime Design

## Goal

Make every tool exposed by `firecrawl-mcp@3.22.3` functional against this
self-hosted Firecrawl deployment. Replace missing Firecrawl Cloud services
with local or open-source components and use the host's existing
ChatGPT-authenticated Codex CLI for AI reasoning instead of Gemini,
Fireworks, or Firecrawl Cloud.

The result preserves Firecrawl's API and MCP contracts so Claude Code, Codex,
SDK clients, and direct API callers observe one consistent local system.

## Approved Constraints

- Support all 26 tools currently exposed by `firecrawl-mcp@3.22.3`.
- Use local and open-source services first.
- Allow direct public web/API access and the existing Codex subscription.
- Add no paid SaaS dependency.
- Run Codex through a host-side adapter; do not place Codex credentials in
  Docker.
- Isolate each Codex run from host files, shell, Docker, normal MCP servers,
  hooks, plugins, skills, rules, and arbitrary network access.
- Keep Firecrawl bound to the loopback interface.
- Deliver the program in independently usable phases.
- Add focused automated tests for new behavior and security boundaries.

"Local Codex" means the locally installed Codex CLI and locally managed
authentication. Model inference still runs on OpenAI infrastructure through
the existing ChatGPT login.

## Tool Scope

The installed MCP package exposes these tools:

- Core: `firecrawl_scrape`, `firecrawl_crawl`,
  `firecrawl_check_crawl_status`, `firecrawl_map`, `firecrawl_search`,
  `firecrawl_parse`, and `firecrawl_extract`
- Interaction: `firecrawl_interact` and `firecrawl_interact_stop`
- Agent: `firecrawl_agent` and `firecrawl_agent_status`
- Feedback: `firecrawl_feedback` and `firecrawl_search_feedback`
- Monitoring: `firecrawl_monitor_create`, `firecrawl_monitor_get`,
  `firecrawl_monitor_list`, `firecrawl_monitor_update`,
  `firecrawl_monitor_delete`, `firecrawl_monitor_run`,
  `firecrawl_monitor_check`, and `firecrawl_monitor_checks`
- Research: `firecrawl_research_search_papers`,
  `firecrawl_research_related_papers`, `firecrawl_research_read_paper`,
  `firecrawl_research_inspect_paper`, and
  `firecrawl_research_search_github`

The design targets functional local contract parity for these tools. It does
not promise identical result quality to Firecrawl Cloud's proprietary
Fire-engine, managed proxies, or private research datasets.

## Current Capability Gaps

Baseline scrape, crawl, crawl status, map, and basic search work locally.
Parse and extract work for limited formats. The remaining behavior is partial
or unavailable because the official self-hosted Compose stack omits several
application services.

The observed `firecrawl_interact` failure demonstrates the first dependency
gap. URL mode successfully scrapes the target, obtains a `scrapeId`, and calls
`POST /v2/scrape/{scrapeId}/interact`. The interaction controller then looks
up that scrape in the application database. This deployment has
`USE_DB_AUTHENTICATION=false`, so request logging skips application-database
insertion and the controller returns `Job not found.`

Additional gaps include:

- No application database or local application migrations
- No persistent Browser Service compatible with Firecrawl's browser API
- Hardcoded Gemini and Fireworks model paths
- No local artifact/object store
- No Agent v2 service
- No research proxy/index service
- Monitoring scheduler and persistence disabled without application DB
- No configured OCR service
- Reduced search without SearXNG or Fire-engine
- MCP and API schema drift for some monitoring and Agent fields

The official self-host guide documents basic local scraping and the limits of
Fire-engine and Supabase-dependent behavior. It does not ship the missing
Browser Service or research/Agent services. See the
[Firecrawl self-host guide](https://github.com/firecrawl/firecrawl/blob/v2.11.0/SELF_HOST.md),
[MCP server](https://github.com/firecrawl/firecrawl-mcp-server), and
[Interact flow](https://docs.firecrawl.dev/features/interact).

## Architecture

Extend this repository as a local-runtime fork of Firecrawl. Preserve the
existing `/v2` API surface and add local implementations behind it. Do not
place a compatibility gateway in front of Firecrawl or move missing behavior
only into MCP; direct API and SDK clients must receive the same behavior.

### Existing Data Plane

Retain the existing services:

- Firecrawl API and worker harness
- Stateless Playwright scraping service
- Redis
- RabbitMQ
- NuQ PostgreSQL queue storage

The Playwright scraper remains responsible for ordinary page rendering. It is
not treated as the persistent Browser Service.

### Local Application Plane

Add these local services:

- `app-postgres`: application records for scrapes, owners, feedback,
  monitors, browser sessions, Agent jobs, and research cache metadata
- `minio`: S3-compatible storage for screenshots, monitor artifacts,
  research documents, and larger job results
- `browser-service`: persistent isolated Chromium sessions, context replay,
  profiles, live view, and typed browser operations
- `searxng`: local metasearch provider
- `ocr-worker`: Tesseract/OCRmyPDF-based document processing
- Dedicated Agent, research, and monitoring workers as their phases require

All services stay on the Compose backend network. The API remains the only
TCP service published to `127.0.0.1`. Where a host process needs Browser
Service access, use a Unix socket in a host runtime directory bind-mounted
only into the required container.

### Persistence Without Cloud Authentication

Persistence and authentication become separate concerns.

- Keep `USE_DB_AUTHENTICATION=false` for the loopback-only local API.
- Add `LOCAL_PERSISTENCE_ENABLED=true`.
- Add `APPLICATION_DATABASE_URL` for `app-postgres`.
- Generate one stable `LOCAL_OWNER_ID` during local environment setup.
- Initialize the Drizzle application client when local persistence is enabled,
  even though API authentication is disabled.
- Store local records under `LOCAL_OWNER_ID` and enforce that owner on reads.
- Run checked-in, versioned local migrations before the API becomes healthy.
- Keep NuQ queue tables and application tables in separate PostgreSQL
  services and volumes.

This avoids enabling Firecrawl's incomplete self-hosted Supabase/authentication
path solely to obtain durable application state.

## Host Codex Adapter

Add a systemd user service that exposes a private Unix socket under the user's
runtime directory. The API submits bounded AI jobs through that socket. The
adapter invokes the machine's existing `codex` executable and reuses the
existing ChatGPT authentication without copying the credential into Docker.

Each invocation:

- Uses `codex exec --ephemeral`
- Ignores user configuration and exec rules
- Starts in a new empty temporary directory
- Disables normal MCP servers, web search, hooks, plugins, skills,
  multi-agent behavior, and unrelated tools
- Runs inside Bubblewrap with an explicit minimal filesystem and network view
- Uses a static output schema for structured tasks
- Has an adapter-owned absolute deadline and subprocess watchdog

Codex authentication is treated as a password-equivalent host secret. The
adapter never returns credential material, configuration, or environment data
to Firecrawl.

Official Codex non-interactive mode supports explicit models, configuration
overrides, ephemeral execution, JSONL events, and structured output. See
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [current model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Browser Capability Bridge

Prompt-based browser interaction must not expose the current raw Bash-string
tool to Codex. Instead, a per-run MCP bridge exposes typed operations:

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
- Constrained `evaluate`

The API issues an opaque, one-use capability bound to:

- One local owner
- One scrape record
- One browser session
- An allowed origin set
- An operation allowlist
- A maximum call count
- An absolute deadline

The bridge holds the capability; it is not included in model-visible prompts
or tool results. Browser Service validates it on every operation. Generated
JavaScript executes only inside the isolated browser container. It never runs
in the API, Codex adapter, or host shell.

## Codex Data Flows

### Prompt-Based Interact

1. MCP calls local `POST /v2/scrape`.
2. API persists the scrape URL, options, actions, and local owner.
3. Browser Service creates a persistent session and replays that context.
4. API issues a one-use browser capability.
5. Codex adapter starts an isolated `codex exec` with only the browser MCP.
6. Codex observes and acts through typed browser operations.
7. Adapter returns a structured result and revokes the capability.
8. API stores necessary job metadata and returns Firecrawl's existing
   response contract.

### Code-Based Interact

Code mode bypasses Codex. Browser Service executes constrained Playwright code
inside the browser container with the same session, origin, call, and deadline
controls.

### One-Shot AI Work

JSON extraction, summaries, query transformation, reranking, monitor
judgment, and other bounded transforms send input plus a strict response
schema to the host adapter. These jobs have no browser MCP and no tool access.

### Agent and Research

Long-running Agent and research jobs use durable queue state and progress
records. They may receive a constrained search/scrape/browser MCP chosen for
that job type, never the user's normal Codex tool environment.

## Model and Reasoning Policy

Centralize model selection by task class instead of keeping provider/model
constants in Firecrawl modules.

| Task class | Model | Reasoning effort |
| --- | --- | --- |
| Query classification, reranking, monitor triage | `gpt-5.6-terra` | `low` |
| JSON extraction, summaries, crawl-prompt transforms | `gpt-5.6-terra` | `medium` |
| Browser Interact | `gpt-5.6-terra` | `medium` |
| Autonomous Agent and research synthesis | `gpt-5.6` | `high` |

These are initial values as of 2026-07-18. Store them in local configuration
so evaluation results or model availability can change policy without code
edits.

Rules:

- Never silently fall back to Gemini, Fireworks, Firecrawl Cloud, or an API
  key.
- Return a typed local configuration error when a selected model is
  unavailable.
- Do not invoke Codex for deterministic parsing, OCR, hashing, storage, or
  scheduling.
- Use strict structured output for bounded transformations.
- Begin with one concurrent browser Codex run and two concurrent non-browser
  runs. Increase only after observing reliability, latency, and ChatGPT usage
  limits.

## Delivery Phases

This master design defines the program. Each phase receives its own focused
specification, implementation plan, commits, tests, and review before the next
phase begins.

### Phase 1: Persistence Foundation

- Add `app-postgres`, versioned migrations, and stable local owner behavior.
- Decouple application DB initialization and request persistence from API
  authentication.
- Add MinIO and an artifact-storage abstraction.
- Add retention and cleanup behavior.
- Preserve existing keyless loopback clients.

### Phase 2: Browser Service and Interact

- Implement persistent Chromium sessions, scrape replay, profiles, live view,
  typed operations, and cleanup.
- Add the host Codex adapter and browser MCP bridge.
- Replace the Gemini browser loop.
- Enable `firecrawl_interact` and `firecrawl_interact_stop`.

### Phase 3: Unified AI Transforms

- Replace Gemini and Fireworks paths with the task-policy Codex adapter.
- Complete JSON extraction, summary, query, crawl-prompt, reranking, extract,
  and AI-assisted parse behavior.
- Preserve deterministic paths without Codex.

### Phase 4: Monitoring and Feedback

- Enable the local scheduler and implement missing database claims/RPC logic.
- Store monitor snapshots and diffs in MinIO.
- Use Codex for bounded change judgment.
- Enable all eight monitor tools and both feedback tools.

### Phase 5: Local Agent

- Adapt the existing Redis-backed deep-research engine behind `/v2/agent`.
- Add structured output, progress, cancellation, configured model/effort, and
  optional constrained browser capabilities.
- Enable `firecrawl_agent` and `firecrawl_agent_status`.

### Phase 6: Research Services

- Build a local research cache/index using public arXiv,
  OpenAlex/Semantic Scholar, and GitHub APIs.
- Cache documents and metadata locally.
- Use Codex only for inspection and synthesis steps.
- Enable all five research MCP tools.

### Phase 7: Parity Hardening

- Add SearXNG, Tesseract/OCRmyPDF, richer screenshots, device/location
  emulation, and open-source browser stealth.
- Accept optional user-supplied proxies without adding a paid dependency.
- Improve scrape, search, parse, and extraction coverage.

Fire-engine-level anti-bot performance is not an acceptance requirement
because Fire-engine is proprietary. Failures caused by direct-host blocking
remain visible and never trigger a cloud fallback.

### Phase 8: MCP Contract Alignment

- Pin or locally fork the MCP package where its schemas disagree with the
  implemented local API.
- Align monitoring types and Agent model/effort fields.
- Keep all 26 tools visible only when their local contracts pass.
- Validate through fresh Claude Code and Codex sessions.

## Reliability and Error Handling

Every request carries one correlation ID through MCP, API, queues, workers,
Codex, Browser Service, and storage. Replace ambiguous downstream errors with
typed categories including:

- `codex_unavailable`
- `browser_unavailable`
- `storage_unavailable`
- `model_unavailable`
- `deadline_exceeded`
- `cancelled`
- `unsupported_capability`
- `target_blocked`

Default absolute deadlines:

- One-shot AI transforms: 5 minutes
- Browser Interact: 10 minutes
- Agent and research: 30 minutes

Per-browser-operation timeouts remain separate from the absolute run
deadline. On deadline, cancellation, or client disconnect:

1. Abort pending adapter and Browser Service requests.
2. Send `SIGTERM` to the Codex subprocess.
3. Escalate to `SIGKILL` after a short grace period.
4. Revoke all run capabilities.
5. Stop or retain the browser according to endpoint semantics.
6. Persist the terminal job state and return a typed error.

Model-generated browser actions are not retried automatically. An
infrastructure operation may receive one idempotent retry. Recovery never
loops or silently changes providers.

## Security

Treat every target page, document, search result, and research source as
untrusted input.

- Codex cannot access host files, shell, Docker, credentials, normal MCPs,
  plugins, hooks, skills, rules, or arbitrary network destinations.
- Browser capabilities are scoped, short-lived, revocable, and unguessable.
- Cross-owner, cross-session, cross-origin, and expired operations fail closed.
- Navigation stays within approved origins unless callers explicitly extend
  the allowlist.
- MinIO, databases, queues, and workers expose no host ports.
- Logs redact credentials, cookies, sensitive form values, signed
  capabilities, and prompts marked sensitive.
- Codex authentication never appears in Docker environment variables,
  volumes, logs, or API responses.
- No service receives the Docker socket.

## Operations and Recovery

Extend `scripts/local-firecrawl` to manage the Docker project and host Codex
adapter as one local runtime.

- `start`: validate Codex login, start the systemd user adapter, apply
  migrations, start Compose, and wait for health.
- `restart`: perform an ordered restart of only this project and adapter while
  preserving databases, objects, profiles, and job state.
- `status`: show adapter plus Compose service state.
- `health`: verify migrations, MinIO, queues, browser session creation,
  adapter socket, and configured model availability.
- `logs`: show bounded, scoped adapter and Compose logs.

Long Agent/research operations require larger Claude Code and Codex MCP tool
timeouts than the current 180-second Codex setting. Client configuration is
updated only after corresponding endpoints support polling or bounded
long-running calls.

Normal recovery never prunes Docker, removes volumes, sends requests to
Firecrawl Cloud, or repeatedly restarts failing services.

## Testing Strategy

New test code is explicitly authorized for this program.

### Unit Tests

Cover local identity, persistence/auth separation, capability signing and
validation, origin enforcement, Codex command construction, output-schema
parsing, redaction, deadlines, and cancellation.

### Service Contract Tests

Cover Browser Service endpoints, Codex adapter socket protocol, MinIO
artifacts, research providers, monitoring scheduler, and Agent state
transitions.

### Compose Integration Tests

Use disposable databases and volumes to test migrations, queue recovery,
restart persistence, health ordering, and cleanup.

### MCP Contract Tests

Start a fresh local MCP subprocess, invoke every tool against controlled local
fixtures, and validate request/response schemas. Run the complete contract
matrix through both Claude Code and Codex configurations before final
acceptance.

### Security Tests

Use hostile page/document fixtures that attempt filesystem access, shell
execution, Docker access, credential theft, cross-session operations,
cross-origin navigation, and unrestricted network access. Every attempt must
fail at the intended boundary.

### Recovery Tests

Terminate Codex and browser workers mid-job, restart services, and verify
terminal job state, capability revocation, process cleanup, and preserved
durable data.

### Live Smoke Tests

Use real Codex and a small set of public pages only after deterministic tests
pass. Most tests use a fake Codex runner, fixture websites, and deterministic
research fixtures to avoid ChatGPT allowance and public-site flakiness.

## Acceptance Criteria

The full program is complete only when:

1. All 26 installed MCP tools pass their local contract checks.
2. Fresh Claude Code and Codex sessions use only the local Firecrawl endpoint.
3. No runtime traffic reaches Firecrawl Cloud, Gemini, Fireworks, or a paid
   replacement service.
4. AI task classes use their configured Codex model and reasoning policy.
5. Existing core scrape/crawl/map/search behavior remains functional.
6. Restart preserves intended application, queue, artifact, profile, monitor,
   Agent, and research state.
7. Cancellation leaves no orphaned Codex or browser process.
8. Hostile content cannot escape its browser capability or access host data.
9. Only the Firecrawl API is published on `127.0.0.1`.
10. Repository tests, affected upstream tests, Compose integration tests, and
    the MCP contract matrix pass.

## Trade-offs

This design prioritizes one coherent local API over the faster alternatives of
an external compatibility gateway or an MCP-only fork. It requires more
upstream maintenance because local behavior lives in the Firecrawl runtime,
but avoids duplicating job/session logic and keeps SDK/API/MCP behavior
consistent.

Using the existing Codex subscription avoids API-key billing but introduces
CLI startup latency, ChatGPT usage limits, and an advanced unattended-auth
security boundary. The host adapter, Bubblewrap isolation, strict tool
capabilities, low initial concurrency, and explicit failure behavior are
required mitigations rather than optional hardening.
