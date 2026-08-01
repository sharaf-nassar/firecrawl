# HTTP API Contracts

The HTTP layer validates public contracts, applies shared admission policy, and chooses between inline execution, asynchronous job creation, or proxying to a specialized service.

## Shared response conventions

Public JSON responses carry `success`, with failures adding an error message and sometimes a stable error code or validation details.

Strict Zod validation rejects unknown v2 fields and reports structured issues. Malformed JSON has its own `BAD_REQUEST_INVALID_JSON` code. Queue saturation returns 429, known transportable scrape errors retain their domain code, and unexpected errors return a support-safe message tied to an internal error identifier.

Job creation normally returns HTTP 200 with a UUID and status URL. Status endpoints also return HTTP 200 for terminal job failure because the request to inspect the job succeeded; missing or unauthorized jobs return 404.

## Schema authority and OpenAPI snapshots

Runtime TypeScript and Zod route schemas define accepted requests; checked-in OpenAPI files do not drive API execution.

`apps/api/openapi.json`, `openapi-v0.json`, and `v1-openapi.json` are snapshots with no repository consumer, generator, or CI drift validation. Updating one does not change controller parsing. HTTP/controller coverage is described by [[lat.md/api/tests#API Test Organization#HTTP and controller tests]].

The generated Elixir boundary is separate: its generator fetches the external `firecrawl-docs` v2 OpenAPI document rather than these snapshots. See [[lat.md/clients/sdk-architecture#Firecrawl SDK Architecture#Generated and handwritten boundaries]].

## Versioned route surfaces

Route versions are compatibility boundaries, not aliases with guaranteed identical payloads.

[[apps/api/src/routes/v0.ts#v0Router]] exposes deprecated scrape, crawl, crawl status/cancel, key authentication, search, and health paths under `/v0`.

[[apps/api/src/routes/v1.ts#v1Router]] exposes scrape, crawl, batch scrape, search, map, crawl and scrape status, WebSocket crawl status, extract, LLMs.txt, deep research, Fireclaw, usage, queue status, cancellation, and optional x402 search.

[[apps/api/src/routes/v2.ts#v2Router]] adds strict v2 contracts plus parse, feedback, scrape interaction, crawl parameter preview, agent, activity, monitor, browser/interact sessions, support proxying, optional research proxying, and optional x402 search.

Admin routes expose dependency health, metrics, queue inspection, operational backfills, precrawl, crawl monitoring, and integration-key proxy operations. Most operational routes embed the configured admin secret in the path; integration routes validate their own proxy secrets.

## Deprecation signaling

Deprecated routes remain callable but advertise migration in both headers and JSON so SDKs, proxies, and direct callers can detect retirement consistently.

[[apps/api/src/lib/deprecations.ts#deprecationMiddleware]] sets `Deprecation: true`, an RFC 7234 `Warning: 299`, and an optional successor-version `Link`. When the response is a JSON object, it appends the same message to `warnings` and adds `replacement` when one exists.

The contract applies to v0 scrape, crawl, status, cancel, and search; v1 and v2 extract; and v1 deep research and LLMs.txt routes. Deprecation does not alter the underlying status code or short-circuit the controller, so warnings also appear on supported error responses.

## Agent livecast

The unversioned `/agent-livecast` WebSocket is a legacy bidirectional relay to the configured Fire Engine beta service.

[[apps/api/src/services/agentLivecastWS.ts#attachWsProxy]] installs the route whenever the application listener starts. It reads `userProvidedId` from the query string, derives an upstream WebSocket URL from `FIRE_ENGINE_BETA_URL`, and forwards frames in both directions until either peer closes.

This route does not use API authentication, rate limiting, team ownership, or a capability grant, and registration is not conditional on the upstream URL being configured. It is an explicit exception to [[lat#Firecrawl#Design invariants]], not a model for new public streaming routes.

The relay also writes request and upstream URLs through direct console logging. Its authentication, session authority, configuration-disabled behavior, logging, and eventual removal require explicit ownership. It is separate from [[browser#Proxy access|tokenized Browser Service proxy access]].

## Admission pipeline

Route middleware orders policy checks before controller side effects.

Typical protected routes perform authentication and endpoint-specific rate limiting, restricted-country checks for sensitive capabilities, projected credit checks, URL blocklist enforcement, and then controller validation. Crawl creation also checks optional idempotency markers.

[[apps/api/src/routes/shared.ts#authMiddleware]] attaches normalized team, organization, account, and plan-feature data to the request. [[apps/api/src/routes/shared.ts#checkCreditsMiddleware]] uses Autumn as credit source of truth, permits plan overage decisions, and may clamp a user-supplied limit to remaining credits.

Blocklist and country checks are capability-aware. Restricted-country checks apply when requests use headers, browser actions, agents, or related nested scrape options rather than to every simple fetch.

## Scrape

Scrape is a synchronous document operation even though it uses the same worker implementation and accounting model as queued jobs.

`POST /v1/scrape` and `POST /v2/scrape` accept one URL plus requested output formats, browser actions, parser, location, proxy, caching, timeout, and transformation options. V2 parses a strict schema and normalizes string formats into typed format objects.

[[apps/api/src/controllers/v2/scrape.ts#scrapeController]] acquires a team concurrency semaphore, creates an in-memory active job, and invokes the scrape worker directly. The response is one document with metadata; raw HTML is removed unless requested. Timeout is 408, unsupported actions are 400, selected cache misses are 404, and DNS resolution failure is a domain failure carried in HTTP 200 for compatibility.

Keyless calls reserve projected credits before execution and reconcile against actual document cost afterward. Agent-interoperability calls require a shared secret and can route billing to the parent agent job.

See [[lat.md/api/scraping#Scrape execution pipeline]].

## Scrape result lookup

Scrape lookup exposes retained document data for an existing synchronous scrape; it is not a live queue-status resource.

`GET /v1/scrape/:jobId` and `GET /v2/scrape/:jobId` authenticate with crawl-status policy. V2 validates the identifier as a UUID before storage access.

[[apps/api/src/controllers/v2/scrape-status.ts#scrapeStatusController]] first requires a durable scrape row and checks its team. Missing records return 404, while an ownership mismatch returns 403 instead of the usual job-existence-hiding 404. Forced-ZDR teams receive 400 because this lookup depends on retained scrape data.

The controller then resolves the job through [[apps/api/src/controllers/v2/crawl-status.ts#getJob]], which joins queue state with the terminal scrape record and loads document data from a queue return value or GCS artifact. It returns only `{ success, data }`; work without a retained result also appears as 404, so callers cannot use this route to observe queued or failed lifecycle state.

## Parse

Parse applies the scrape transformation pipeline to an uploaded file instead of fetching a public URL.

`POST /v2/parse` accepts multipart form data with one HTML, PDF, or supported office document, a JSON `options` field, and a 50 MiB upload limit. Middleware converts the upload into a strict scrape-like request, then the controller uses the parsing engines without ordinary network discovery.

The contract keeps formats, parsing, extraction, redaction, and billing behavior aligned with scrape while marking the work as a parse for persistence and retention.

## Crawl

Crawl is an asynchronous URL-discovery job whose status is a paginated projection of a durable queue group.

`POST /v1/crawl` and `POST /v2/crawl` accept a seed URL, crawler options, nested scrape options, optional webhook, per-crawl concurrency, retention mode, and limit. V2 adds sitemap policy values and optional natural-language prompt generation for crawler options.

[[apps/api/src/controllers/v2/crawl.ts#crawlController]] caps the effective limit to admitted credits, validates path regular expressions, creates a backend-pinned crawl group and Redis crawl record, then enqueues a kickoff job. Explicit user fields override prompt-generated values.

The kickoff worker uses index and sitemap discovery, locks normalized URL permutations, and adds child scrape jobs. Child results can discover further links until path, domain, depth, robots, deduplication, and limit rules stop expansion.

## Crawl planning and active listings

Auxiliary crawl routes preview prompt-derived policy and enumerate owned live crawl groups without creating jobs or returning page results.

`POST /v2/crawl/params-preview` accepts only a URL and a prompt of at most 10,000 characters. [[apps/api/src/controllers/v2/crawl-params-preview.ts#crawlParamsPreviewController]] enriches the prompt with bounded site structure, generates crawler fields, and returns the proposed options with the URL. It creates no crawl, and validation or generation failure returns 400.

`GET /v1|v2/crawl/ongoing` and the identical `/crawl/active` alias query queue groups by authenticated owner, then join Redis crawl policy. Cancelled groups, batch-scrape groups without crawler options, and groups whose Redis state has disappeared are omitted.

Each active entry contains its ID, owner, seed URL, creation timestamp, crawler policy, and scrape options. V1 and v2 project crawler options through their respective compatibility schemas; neither route paginates, returns child documents, or lists terminal crawls.

## Batch scrape

Batch scrape reuses crawl grouping and status machinery without link discovery.

`POST /v1/batch/scrape` and `POST /v2/batch/scrape` accept one or more URLs, common scrape options, webhook configuration, optional maximum concurrency, and optional append target. V2 defaults to ignoring invalid URLs; invalid or blocked inputs are reported separately when allowed.

[[apps/api/src/controllers/v2/batch-scrape.ts#batchScrapeController]] creates or verifies the owning group, locks every URL, registers child job identifiers, enqueues the jobs, marks kickoff complete, and emits `batch_scrape.started`. Large batches receive lower queue priority.

Appending requires the target group to exist and belong to the same team. It extends the group rather than creating a new request identity.

## Crawl and batch status

Status contracts combine queue-group counters, persisted documents, billing totals, expiry, warnings, and continuation links.

`GET /v1|v2/crawl/:jobId` and the batch equivalent return `scraping`, `completed`, `failed`, or `cancelled`; completed and total counts; credits used; expiry; and result documents. V2 also returns creation/completion timestamps and duration when known.

Results are bounded by query pagination and a 10 MiB response budget. `next` remains present while unread results exist or the group is still active. Missing queue return values fall back to artifact storage.

Errors and robots exclusions are separate resources under `/:jobId/errors`. WebSocket crawl status streams progress. DELETE marks the crawl cancelled, removes or cancels queued children, and rejects already completed work with 409.

## Map

Map is a synchronous link-discovery operation optimized for URL inventory rather than page content.

`POST /v1/map` returns URL strings; v2 returns objects with URL and optional title or description. Inputs control domain scope, path filtering, sitemap policy, query handling, search relevance, index/cache use, location, headers, limit, and timeout.

[[apps/api/src/controllers/v2/map.ts#mapController]] can delegate supported URLs to a resolver, otherwise combines index, sitemap, and crawl discovery. Standard mapping bills one credit; delegated resolution bills by returned link count. Timeout is 408 and narrow non-root results may include a broader-domain suggestion.

## Search

Search is a synchronous federated query that may enrich result records by scraping them.

`POST /v1/search` and `/v2/search` accept query, result limit, sources, category/domain filters, locale, enterprise privacy mode, timeout, and optional scrape formats. V2 supports separate web, images, and news result collections.

[[apps/api/src/controllers/v2/search.ts#searchController]] normalizes search intent, enforces team ZDR policy, calls [[apps/api/src/search/execute.ts#executeSearch]], and bills search results separately from scrape enrichment.

Provider selection has no fallback loop. Local web-only mode requires SearXNG; elsewhere Fire Engine wins over configured SearXNG, and no provider is a typed 503. The shared SearXNG client uses bounded form-encoded POST requests and preserves valid empty responses.

Each source is capped to the requested limit. Scraping occurs only when output formats are requested, and merged scrape costs join provider-result costs in `creditsUsed`. Timeouts from enrichment return 408.

An experimental highlights option can replace provider snippets with query-relevant spans from recent indexed content. It runs only when team and deployment capabilities are present, batches scoring after scrape enrichment, and keeps the original snippet on any cache or model failure.

Optional x402 search uses a separate controller and payment gate described by [[trust-and-operations#x402 paid search]].

## Research

Research is a synchronous proxy family for paper discovery, paper reading, citation relationships, and GitHub history or README search.

When `RESEARCH_PROXY_URL` is configured, `/v2/search/research` allows the same keyless authentication mode as search, while `/v2/research` is an authenticated legacy alias. The legacy alias recursively adds selected snake-case response fields beside canonical camel-case fields.

[[apps/api/src/controllers/v2/research-proxy.ts#createResearchRouter]] exposes paper search, paper inspect or query-guided read, similar/citing/reference paper lookup, and GitHub search. Strict query schemas cap paper and relationship results at 500, paper read passages at 50, and GitHub results at 100.

The proxy forwards only `Accept` and `X-Request-ID` from the caller, adds the authenticated team ID for the upstream, and returns only content type and request ID metadata. Upstream work has a 120-second budget; timeouts become 504 and other proxy failures become 502.

Successful paper inspect and read requests bill one scrape credit. Paper search, relationship search, and GitHub search bill two credits per ten results, or ten per ten when forced enterprise search privacy pricing applies; keyless requests consume the corresponding preview quota.

Research logging currently persists target hints, validated options, and upstream responses with `zeroDataRetention: false`, even when forced privacy pricing applies. Research therefore has a separate current retention boundary and must not inherit [[trust-and-operations#Research billing and retention|ordinary search ZDR assumptions]].

## Extract

Extract is an asynchronous structured-data workflow backed by RabbitMQ, Redis status, database records, and artifacts.

`POST /v1|v2/extract` accepts URLs or a prompt, schema and prompt instructions, scrape options, link-scope controls, and optional web search. The legacy endpoints are deprecated, and forced-ZDR teams are rejected because extraction retention does not support ZDR.

[[apps/api/src/controllers/v2/extract.ts#extractController]] records a processing state and publishes an extraction message. The extract worker emits started/completed/failed webhooks, updates Redis status, persists logs/artifacts, and acknowledges handled failures. Crashed messages reaching the dead-letter queue are converted into explicit failed status.

Status prefers durable artifacts for completed data, falls back to Redis result storage, and uses database request ownership to hide other teams' jobs.

## Legacy generation jobs

V1 deep research and LLMs.txt generation are retained asynchronous products with BullMQ execution and Redis-visible progress.

Deep research iterates search, scrape, finding synthesis, gap analysis, and final markdown or schema-guided JSON within depth, URL, and time limits. [[apps/api/src/lib/deep-research/deep-research-service.ts#performDeepResearch]] updates activities, sources, and depth throughout the run.

LLMs.txt generation maps and ranks a site's pages, scrapes selected content, and produces a concise index plus optional full text. [[apps/api/src/lib/generate-llmstxt/generate-llmstxt-service.ts#performGenerateLlmsTxt]] may reuse the database cache before repeating site work.

Both return a job ID and expose TTL-bound status. Forced ZDR teams are rejected because progress and generated output remain in Redis. Their BullMQ jobs run in the queue worker and are separate from NuQ crawl groups.

## Agent

Agent is an asynchronous v2 proxy contract for the external Spark extraction service.

`POST /v2/agent` accepts prompt, optional URLs and JSON schema, credit ceiling, URL-confinement policy, webhook, and model. Requests consume an eligible free-agent allowance unless their requested credit ceiling makes them explicitly paid.

[[apps/api/src/controllers/v2/agent.ts#agentController]] records the request, then forwards an internal authenticated job to the configured agent service. GET combines local request ownership, durable terminal records, external pending options, artifacts, expiry, model, and credits. DELETE only forwards cancellation while no terminal agent record exists.

## Monitors and browser sessions

V2 includes stateful monitoring and interactive browser resources beyond the core scrape family.

Monitor routes create, list, inspect, update, delete, and manually run monitors; child check resources expose page judgments and diffs. Email confirmation and unsubscribe use body tokens as their credentials and are intentionally public.

Browser and legacy `interact` aliases create, list, and delete sessions. Separate routes support scrape-bound interaction, authenticated execution, service-destroyed callbacks, and tokenized proxy views or WebSocket relays. Local deployments reconcile browser state before admission.

See [[lat.md/api/monitoring#Change Monitoring]] and [[lat.md/api/browser#Interactive Browser Runtime]].

## Endpoint feedback

V2 feedback binds a rating and diagnostics to an owned, recently completed search, scrape, parse, or map job.

`POST /v2/feedback` uses an endpoint discriminator and job UUID; the legacy search-specific path maps into the same recorder. Duplicate feedback for one team, endpoint, and job succeeds idempotently but never issues a second refund.

Database authentication, team ownership, job age, success requirements, team opt-out, ZDR, refund enablement, billed cost, rating, endpoint feature, and daily refund cap all influence acceptance or refund amount.

See [[lat.md/api/trust-and-operations#Feedback and refunds]].

## Account and auxiliary endpoints

Account routes expose usage and queue state without mutating scrape work.

Both main versions expose current and historical credit/token usage and queue/concurrency state. V2 activity reads the last 24 hours of durable request records for the authenticated team, supports an endpoint filter, and keyset-paginates newest-first with a default of 50 and maximum of 100 records.

[[apps/api/src/controllers/v1/activity.ts#activityController]] returns request ID, endpoint kind, API version, timestamp, and target hint. Its opaque cursor combines timestamp and request ID so equal timestamps remain stable; malformed cursors or unsupported endpoint filters return 400.

`POST /v1/fireclaw` is a billing-only product endpoint rather than a scrape or job. [[apps/api/src/controllers/v1/fireclaw.ts#fireclawController]] clamps `plays` to one through ten, charges 100 credits per play, rejects insufficient balance with 402, and reports the billed plays and refreshed remaining balance.

Availability is route-specific. Research routers register only when `RESEARCH_PROXY_URL` exists, and x402 search registers only with a pay-to address. Support, keyless eligibility, feedback, and browser proxy routes always register, then enforce authentication, controller-held secrets, capabilities, or token grants at request time.

Support routes return 503 when no support upstream is configured. The keyless eligibility probe returns 401 when its shared proxy secret is absent or mismatched; feedback remains an ordinary authenticated account route.
