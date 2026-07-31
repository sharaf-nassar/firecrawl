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

## Playwright service suite

`apps/playwright-service-ts/` uses Node's test runner through `tsx`.

`api.spec.ts` uses injected and mocked browser objects to cover applied browser settings, checkpoint writer inventory, storage bounds, cancellation, cleanup ordering, semaphore release, and shared-browser retirement. `dockerfile.spec.ts` locks dependency installation to the tracked lockfile.

The package suite does not start the HTTP server or a real browser. It does not directly exercise `/scrape`, `/health`, URL/DNS interception, rendered content, selectors, headers, or cross-request browser-context isolation.

The server integration matrix starts Playwright in one matrix branch and reaches it through API snippet tests. That is useful composition coverage but is not a substitute for focused service-level HTTP and real-browser tests.

## Support-service suites

Support services have uneven direct coverage.

Go HTML-to-Markdown uses `httptest` for index, health, conversion, malformed input, complex HTML, and ZDR logging behavior. Its path-scoped CI runs build, vet, and all Go tests.

`apps/nuq-postgres/` has no direct SQL or image test. The server matrix builds and starts the image, so its initialization and ordinary queue paths receive indirect integration coverage.

`apps/redis/` has no automated test for its image, memory sizing, password, persistence, or Fly configuration. The server matrix uses the upstream Redis image, not this custom image.

## Local wrapper suite

`scripts/local-firecrawl.test.mjs` validates orchestration without mutating a real Docker installation.

It creates private temporary fixtures and replaces `docker` with a recording fake. Tests cover environment creation and upgrade, Compose hardening validation, secret-safe errors, image build and one-shot ordering, recognized legacy provenance, writer-first stop, status, and diagnostic availability.

The API script `test:local-firecrawl:lifecycle` passes `--full-lifecycle`, but the test file has no argument-controlled real-Docker mode. Every current case still uses the fake runtime.

### Operations coverage gap

Wrapper tests do not prove live Compose behavior.

They do not start real containers, run migrations, validate MinIO policy, execute Browser Service reconciliation, run the Codex canary, probe model egress, test advisory-lock contention, verify log redaction, or run `health` against the assembled stack.

Live acceptance should use `scripts/local-firecrawl start`, one `health` pass, targeted egress and browser checks, then ordered `stop` without deleting volumes.

## Local MCP launcher suite

`scripts/local-firecrawl-mcp.test.mjs` locks the local MCP capability filter's static policy while keeping process transport concerns in the executable entrypoint.

The Node test suite verifies the exact seven disabled tools, discovery filtering, stale disabled-call errors, and supported-message passthrough against the importable launcher library.

## API-managed local acceptance

API harness commands provide narrower live acceptance for local persistence and Browser Service without assembling the wrapper-managed Compose stack.

From `apps/api`, `pnpm harness pnpm test:snips:local-persistence` starts or uses application Postgres, builds and serves `apps/test-site`, and runs the API workers. It verifies auth-off ownership, persisted request and scrape rows, foreign-owner denial, and the explicit failure when Browser Service is disabled.

`pnpm harness pnpm test:snips:local-browser` adds a harness-owned Browser Service, isolated state, application Postgres, and a controlled restart endpoint. Its snippet tests cover browser create/list/delete, rotating relay grants, origin limits, profile writer exclusion, snapshot readers, owner isolation, restart admission, and replay contracts.

These harnesses do not exercise MinIO, the wrapper's one-shots and lifecycle lock, container network hardening, the Browser Interaction Worker canary, or the assembled Compose health protocol. Replay cases that need Playwright remain capability-gated.

Neither command is invoked by a checked-in GitHub Actions workflow. They supply live local contract coverage, not an automated repository release gate.

## CI coverage gap

Runtime suites are not wired into repository GitHub Actions in this checkout.

No workflow runs Browser Service tests, Browser Interaction Worker tests, Playwright package tests, or local-wrapper tests. `test-server.yml` runs API snippet and NuQ FoundationDB suites, while `deploy-playwright.yml` builds and publishes without invoking `pnpm test`.

Critical workflow decision scripts also lack direct tests. `resolve_api_image_version.py` chooses API image tags, `check_version_has_incremented.py` gates SDK publication, and `audit-ci-vuln-scan.mjs` selects vulnerability remediation work.

Until dedicated jobs exist, contributors must run affected package suites locally and record any required Docker, privileged, or real-browser acceptance separately.

## Evaluation and benchmark layers

Quality and performance assets answer different questions from deterministic tests.

`apps/test-suite/` provides legacy Artillery load scenarios and external-site benchmark data. Production and pull-request evaluation workflows dispatch external systems; they do not run assertions in this checkout.

Use these layers for capacity and content-quality signals. Use package and server integration tests for deterministic protocol, lifecycle, and failure guarantees.
