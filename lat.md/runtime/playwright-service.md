# Playwright Scrape Service

Playwright Scrape Service is the stateless HTML-fetching browser microservice used by the legacy scrape pipeline.

It differs from [[runtime/browser-service#Browser Service|Browser Service]]: it exposes one `/scrape` request at a time per permit, returns page content directly, and does not own durable profile generations or control-generation fencing.

## HTTP contract

The service exposes `GET /health` and `POST /scrape`.

A scrape request supplies URL, load timeout, optional post-load wait, headers, selector, TLS setting, mobile/location hints, proxy preference, ad blocking, and optional replay-checkpoint capture.

The response returns content, page status, content type, optional page error, and optional replay checkpoint. JSON or text responses use raw response bodies; other responses use rendered page HTML.

## Shared browser lifecycle

Requests lease one generation of a shared Chromium browser server while keeping contexts isolated.

[[apps/playwright-service-ts/api.ts#SharedBrowserLifecycle]] deduplicates concurrent browser startup and counts active leases. A retired generation remains alive until its final lease releases, then its browser server is killed.

Each scrape creates a fresh browser context and page. Cleanup closes page then context within bounded deadlines and always releases both the browser lease and page semaphore.

Cleanup timeout retires the whole browser generation because continuing to share a browser with unverified context cleanup could leak state across requests. [[apps/playwright-service-ts/api.ts#settleScrapeResources]] preserves the primary scrape error and reports cleanup failures separately.

## Concurrency

A process-local semaphore caps active pages using `MAX_CONCURRENT_PAGES`, default ten.

Requests beyond the limit wait in FIFO order for a permit. Health returns configured capacity and active page count, and creates a real context/page to verify browser usability.

Compose separately limits the service to two CPUs and 4 GiB memory. Application concurrency and container resource limits must be tuned together.

## Target security

The service validates the top-level URL and every intercepted browser request.

HTTP and HTTPS are the only allowed schemes. Unless `ALLOW_LOCAL_WEBHOOKS=true`, localhost, non-unicast IP literals, DNS names with any private/reserved answer, missing hosts, and failed or empty DNS answers are blocked.

DNS results are cached for 30 seconds, but each intercepted request is checked. Blocked navigation is converted into a 403-shaped page result rather than allowing Chromium to reach an internal resource.

Service workers are disabled. Optional media blocking and default ad-domain blocking occur in the context route layer, after target-safety validation.

## Browser settings

Requested settings are converted into the concrete context configuration recorded with replay state.

[[apps/playwright-service-ts/api.ts#resolveAppliedBrowserSettings]] resolves viewport, device scale, mobile/touch flags, user agent, locale, location, proxy metadata, TLS policy, ad blocking, and lockdown.

Proxy credentials are applied to Playwright but checkpoint metadata stores only a stable credential reference. A requested location that cannot be represented by the configured proxy is rejected for replay capture.

Multiple requested languages and lockdown are also unrepresentable in replay capture because recorded settings must describe actual context behavior exactly.

## Replay checkpoint capture

Optional checkpoint capture produces bounded storage plus a browser-settings and page fingerprint envelope.

[[apps/playwright-service-ts/api.ts#captureReplayCheckpoint]] freezes all context pages, inventories Chromium targets, terminates attributable background writers, and refuses unexpected or unattributable targets.

Capture tracks at most 128 storage origins and two MiB total state. It validates Chromium-reported usage before serializing storage state with IndexedDB.

Origins and page targets must remain unchanged throughout capture. The final envelope records final URL plus SHA-256 hashes of bounded title and normalized body text.

Capture timeout is 1–10,000 milliseconds. [[apps/playwright-service-ts/api.ts#captureWithDeadline]] cancels context work and retires the browser if cancellation cleanup cannot be verified.

Replay failure responses refine the service's [[playwright-service#HTTP contract]]. Oversized checkpoints return HTTP 413 with `checkpoint_too_large`; unrepresentable state and capture timeout return HTTP 422 with `checkpoint_unrepresentable` or `checkpoint_timeout`. Other scrape failures return a generic HTTP 500 response.

## Request flow

A successful scrape keeps browser and replay side effects ordered.

The service validates URL, acquires a page permit and browser lease, creates the context, applies non-user-agent headers, navigates with load timeout, waits if requested, verifies an optional selector, extracts content, optionally captures replay, then performs bounded cleanup before responding.

If navigation or scrape fails, the same cleanup path runs. Resource cleanup ambiguity may add deferred errors but never returns an apparently successful response.

## Deployment boundary

The service runs on the Compose backend network and is not published to the host.

API containers address `http://playwright-service:3000/scrape`. The only host-published service in the local stack is the API.

The container pins its Playwright image by version and digest and pins pnpm, installs with the frozen lockfile, builds TypeScript, and starts through `pnpm start`. `dockerfile.spec.ts` verifies the image, dependency, lockfile, and build ordering.

Compose mounts `/tmp/.cache` as a bounded noexec tmpfs and calls `/health` for service health.

## Logging and observability

Playwright Service uses console logs rather than a structured correlation or metrics protocol.

The scrape handler logs the full requested URL and selected request options, and target checks may log hostnames. Deployments must treat service logs as request data; this service does not implement the API's zero-data-retention logging contract.

`GET /health` reports configured capacity and active pages and verifies a real context/page. It does not establish target reachability, proxy correctness, replay capture, or API-to-service routing.
