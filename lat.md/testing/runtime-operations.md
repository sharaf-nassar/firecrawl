# Runtime and Operations Testing

Specialized runtimes and operational tooling keep package-local suites that exercise fail-closed boundaries, native effects, real Chromium, and orchestration order.

These suites complement [[api/tests#API Test Organization|API tests]] and [[ecosystem-integration#Ecosystem and Client Testing|ecosystem tests]]. Their package scripts and CI reach differ, so passing one layer is not evidence that every runtime boundary ran.

## Browser Service suite

`apps/browser-service/` combines Node's test runner, Vitest, native addon builds, host filesystem effects, and real Playwright integration.

`pnpm test` first builds production and test native addons. It then runs build, rollback-checker, volume-initializer, runtime-preflight, and lockfile tests before the TypeScript Vitest suite.

### Protocol and state-machine coverage

Most Browser Service tests make authority and failure semantics deterministic without starting the full service image.

They cover strict private schemas, authentication and deadlines, control-generation fencing, reconciliation, session/version authority, action idempotency, egress policy, artifacts, relay grants, profile transitions, recovery reducers, cleanup, and shutdown races.

Contract inventory tests compare the derived service contract to `apps/browser-service/contracts/private-v1.contract.json`. Changing private wire behavior requires updating both executable schemas and the canonical inventory.

### Native and filesystem coverage

Persistence tests exercise real no-replace publication, process races, crash barriers, directory identities, manifests, recovery, and rollback classification on temporary host filesystems.

The suite builds a test-only native addon with controlled syscall barriers while separately proving those hooks are absent from the production addon. Volume initialization tests exercise symlink, ownership, mode, replacement, lock, and crash cases.

Several image acceptance cases require Linux, Docker, privileged mounts, or `FIRECRAWL_TASK6_IMAGE_ACCEPTANCE=1`. Default `pnpm test` does not imply every container-filesystem acceptance branch ran.

### Real Chromium coverage

Integration files use the package's pinned Chromium to test network and replay behavior that mocks cannot establish.

Chromium egress tests route hostile navigations, redirects, frames, workers, WebSockets, WebRTC, and QUIC-shaped behavior through controlled local origins and policy decisions. Replay tests restore cookies, local storage, and IndexedDB while ingress remains closed.

These are package-level integrations: they do not start API, Compose, Browser Interaction Worker, application Postgres, or MinIO.

## Browser Interaction Worker suite

`apps/browser-interaction-worker/` uses Node's built-in test runner for its closed decision protocol and model-egress policy.

Tests cover turn-dependent schemas, bounded history, deadline and finalization planning, prompt shape, timeout fallback, fixed proxy environment, hostname/address policy, TLS ClientHello SNI, CONNECT forwarding, and loopback-to-Unix-socket relay.

The egress tests use local sockets and injected resolution/dial functions. They prove policy sequencing without contacting model providers.

### Worker coverage gap

Important worker lifecycle behavior currently has no direct automated test.

The suite does not exercise `createWorkerServer`, request authentication and capacity, client-disconnect cancellation, `createCodexRunner` process termination, authentication merge, scratch cleanup, or the real startup canary and hook audit.

Those behaviors are partially constrained by local Compose validation and health checks, but need package-level failure and race tests for deterministic regression coverage.

## Codex Shim suite

`apps/codex-shim/` uses Node's built-in test runner to verify the OpenAI-to-Codex translation boundary without contacting model providers.

The suite places a recording `codex` stub first on `PATH`. It covers message and argv translation, exact schema-file creation and cleanup, final-message event parsing, FIFO concurrency, chat and embeddings routes, and secret-safe OpenAI error responses.

## Playwright service suite

`apps/playwright-service-ts/` uses Node's test runner through `tsx`.

`api.spec.ts` uses injected and mocked browser objects to cover applied browser settings, checkpoint writer inventory, storage bounds, cancellation, cleanup ordering, semaphore release, and shared-browser retirement. `dockerfile.spec.ts` locks dependency installation to the tracked lockfile.

The package suite does not start the HTTP server or a real browser. It does not directly exercise `/scrape`, `/health`, URL/DNS interception, rendered content, selectors, headers, or cross-request browser-context isolation.

Repository CI installs, builds, and runs this package suite. That deterministic coverage is still not a substitute for focused service-level HTTP and real-browser tests.

## Support-service suites

Support services have uneven direct coverage.

Go HTML-to-Markdown uses `httptest` for index, health, conversion, malformed input, complex HTML, and ZDR logging behavior. The suite remains package-local and is outside required repository CI.

`apps/nuq-postgres/` has no direct SQL or image test and is outside required repository CI. Its initialization and ordinary queue paths need explicit service-backed validation when changed.

`apps/redis/` has no automated test for its image, memory sizing, password, persistence, or Fly configuration. The custom image is outside required repository CI.

## SearXNG configuration suite

`scripts/searxng-config.test.mjs` locks the local search image, settings, rendered Compose boundary, and current-architecture startup without issuing an upstream search.

### Static settings policy

The pinned image's settings loader must parse the tracked configuration into the exact private JSON/POST policy, four enabled general engines, and bounded outgoing request settings with no DuckDuckGo or Valkey path.

### Rendered service hardening

Rendered Compose must retain the digest, backend-only topology, read-only settings and root, non-root identity, dropped privileges, bounded resources, rotating logs, and local-only health probe without exposing the secret to API.

### Immutable image architectures

The registry descriptor for the exact image digest must remain an OCI image index containing both `linux/amd64` and `linux/arm64` manifests.

### Boot and effective settings

The current host architecture must boot the hardened service, pass `/healthz`, and report only the four selected engines as enabled in SearXNG's effective `/config` response.

## Local wrapper suite

`scripts/local-firecrawl.test.mjs` validates orchestration without mutating a real Docker installation.

It creates private temporary fixtures and replaces `docker` with a recording fake. Tests cover environment creation and upgrade, Compose hardening validation, secret-safe errors, image build and one-shot ordering, recognized legacy provenance, writer-first stop, status, and diagnostic availability.

The API script `test:local-firecrawl:lifecycle` passes `--full-lifecycle`, but the test file has no argument-controlled real-Docker mode. Every current case still uses the fake runtime.

Repository CI runs the deterministic local-script contracts, including this fake-runtime suite. That gate verifies orchestration rules without claiming live Compose acceptance.

### Operations coverage gap

Wrapper tests do not prove live Compose behavior.

They do not start real containers, run migrations, validate MinIO policy, execute Browser Service reconciliation, run the Codex canary, probe model egress, test advisory-lock contention, verify log redaction, or run `health` against the assembled stack.

Live acceptance should use `scripts/local-firecrawl start`, one `health` pass, targeted egress and browser checks, then ordered `stop` without deleting volumes.

## Local MCP launcher suite

`scripts/local-firecrawl-mcp.test.mjs` locks the local MCP capability policy while keeping process transport concerns in the executable entrypoint.

The Node test suite verifies the seven disabled tools, discovery filtering, prompt-only interact rewriting, clear rejection of stale code-mode calls, and supported prompt/stop passthrough against the importable launcher library.

It also deep-compares the rewritten pinned upstream registration with a checked-in snapshot and requires the executable package pin to equal the fixture's recorded version.

## API-managed local acceptance

API harness commands provide narrower live acceptance for local persistence and Browser Service without assembling the wrapper-managed Compose stack.

From `apps/api`, `pnpm harness pnpm test:snips:local-persistence` starts or uses application Postgres, builds and serves `apps/test-site`, and runs the API workers. It verifies auth-off ownership, persisted request and scrape rows, foreign-owner denial, and the explicit failure when Browser Service is disabled.

`pnpm harness pnpm test:snips:local-browser` adds a harness-owned Browser Service, isolated state, application Postgres, and a controlled restart endpoint. Its snippet tests cover browser create/list/delete, rotating relay grants, origin limits, profile writer exclusion, snapshot readers, owner isolation, restart admission, and replay contracts.

These harnesses do not exercise MinIO, the wrapper's one-shots and lifecycle lock, container network hardening, the Browser Interaction Worker canary, or the assembled Compose health protocol. Replay cases that need Playwright remain capability-gated.

Neither command is invoked by repository CI. They supply live local contract coverage, not an automated validation gate.

## CI coverage boundary

Repository CI covers deterministic active-runtime contracts that fit GitHub-hosted runners without secrets.

The workflow checks repository and local scripts, builds the API image, builds Browser Service test and runtime image targets, runs Playwright Service install/build/test, and installs and builds Test Site. Container results are never published.

Browser Interaction Worker tests, live Compose acceptance, API service-backed harnesses, FoundationDB, SDKs, support-service suites, and credentialed or hosted integrations remain outside the required gate.

Contributors must run affected excluded suites locally or in their owning external system and record any required Docker, privileged, real-browser, or credentialed acceptance separately.

## Evaluation and benchmark layers

Quality and performance assets answer different questions from deterministic tests.

`apps/test-suite/` provides legacy Artillery load scenarios and external-site benchmark data. No repository workflow runs them or dispatches an external evaluator.

Use these layers for capacity and content-quality signals. Use package and server integration tests for deterministic protocol, lifecycle, and failure guarantees.
