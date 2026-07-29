# Firecrawl SDK Architecture

The SDK subtree provides independently packaged language clients for the Firecrawl HTTP API rather than one generated, lockstep client workspace.

The public clients translate language-native inputs into the v2 API, normalize responses and errors, identify their SDK origin, and expose custom API URLs for self-hosted deployments. See [[monorepo#Independent package roots]] for repository ownership.

## Shared client contract

Every maintained SDK centers on the same resource families, but capability arrival and convenience helpers vary by language.

The common baseline is scrape, crawl, batch scrape, map, and search. Current clients also cover differing subsets of file parsing, structured extraction, research search, agents, monitors, browser sessions, scrape-bound interaction, and usage reporting.

Environment configuration is client-specific. JavaScript and Go read both `FIRECRAWL_API_KEY` and `FIRECRAWL_API_URL`; Rust uses explicit constructors, while Elixir uses application configuration or per-call options. File parsing uses multipart upload and other v2 traffic is JSON.

SDKs attach an `origin` or user-agent identifying the client and usually its release version. This attribution is operational metadata, not authentication or the API version: SDK releases advance independently from v2.

### Origin attribution

Caller-supplied origin labels are not portable across SDKs.

Several clients add an SDK origin only when the payload lacks one. Python's transport writes its SDK origin on JSON requests, while JavaScript preserves a custom value only for its recognized MCP attribution path; research query methods also set language-specific origins.

The server and integrations must treat origin as telemetry, never identity or authorization. An integration that needs its own attribution must verify the selected SDK's serialization behavior instead of assuming an arbitrary `origin` survives.

### Keyless and self-hosted use

Authentication policy belongs to the API, while clients decide whether missing credentials prevent construction.

Most current v2 clients permit an omitted key and omit the `Authorization` header because scrape, search, and interact can use the cloud keyless tier; other calls can receive 401. Custom URLs support self-hosted instances with optional or deployment-defined authentication.

Constructor helpers are not uniform. Python's synchronous client permits keyless cloud construction while its asynchronous client currently rejects it. Java's builder permits an omitted key, but `fromEnv()` requires one. Callers must use the selected client's actual constructor contract.

Python's v2 and unified clients read `FIRECRAWL_API_KEY` but not `FIRECRAWL_API_URL`; self-hosted use must pass `api_url=`. The feature-frozen Python v1 client separately reads both variables, so migration to the unified client can change base-URL discovery.

Custom URL shape also differs. Handwritten clients generally accept the service origin and append `/v2` per endpoint, while generated Elixir treats `base_url` as the versioned API root. Configuration copied between languages must preserve that distinction.

The configured API URL is also a credential trust boundary because authenticated clients attach the bearer key automatically. Applications must not derive it from untrusted request data or use custom base URLs as arbitrary per-call proxies.

### Errors and retries

Client transports turn non-success responses into language-native exceptions or results and apply bounded retry behavior where implemented.

Handwritten clients commonly distinguish authentication, rate-limit, timeout, and general Firecrawl failures. Blocking job helpers add job-timeout errors; callers using start/status primitives retain control over cancellation, deadlines, and retry policy.

Retry sets are not a cross-language guarantee. JavaScript retries 502 responses, while Python retries 502 responses and HTTP transport failures. Several other handwritten clients use broader transient-status sets; Rust and generated Elixir do not share that common loop.

Go, Java, PHP, and .NET accept caller-supplied HTTP clients or transports. JavaScript and Python expose timeout and retry settings around their owned transports, while Rust owns a `reqwest` client and Elixir forwards additional request options into `Req`.

### Timeout namespaces

Timeout values describe different clocks and do not share one cross-language unit.

- JavaScript transport `timeoutMs` is milliseconds; waiter `pollInterval` and `timeout` values are seconds.
- Python transport and `request_timeout` values are seconds, scrape and map wire `timeout` values are milliseconds, and job polling intervals and deadlines are seconds.
- Rust crawl and batch poll intervals are milliseconds and those waiters have no built-in completion deadline; agent poll intervals are milliseconds while agent timeout is seconds.
- Go's explicit polling interval and job-timeout arguments are seconds.

Callers crossing SDK boundaries must preserve the semantic role and unit instead of forwarding an unqualified `timeout` value.

## Endpoint and language coverage

The roster favors idiomatic clients over strict feature parity.

| Client | Public model | Notable coverage and execution style |
| --- | --- | --- |
| JavaScript/TypeScript | `@mendable/firecrawl-js`, aliases also published as `@mendable/firecrawl` and `firecrawl` | Broad v2 surface: core endpoints, extract, research, agent, monitor, browser, interaction, feedback, usage, sync-style waiters over promises, and live watchers. |
| Python | `firecrawl-py`, also published as `firecrawl` | Broad v2 surface, separate synchronous and asynchronous clients, typed Pydantic results, pagination helpers, and live watchers. |
| Go | nested module `github.com/firecrawl/firecrawl/apps/go-sdk` | Core, parse, research, agent, monitor, browser, interaction, and usage methods with `context.Context` and explicit polling helpers. |
| Java | Maven `com.firecrawl:firecrawl-java` | Core, parse, research, agent, monitor, browser, interaction, and usage methods; blocking calls plus `CompletableFuture` variants. |
| PHP | Composer `firecrawl/firecrawl-sdk` | Core, parse, research, agent, monitor, browser, interaction, and usage methods, typed models, and optional Laravel provider/facade integration. |
| Rust | crate `firecrawl` | Tokio-based core, parse, research, agent, monitor, and scrape-bound interaction methods with typed `Result` values. |
| Ruby | gem `firecrawl-sdk` | Synchronous core, parse, research, agent, monitor, interaction, and usage methods with polling waiters. |
| .NET | NuGet `firecrawl-sdk` | `Task`-based scrape, parse, crawl, batch, map, search, research, monitor, and usage methods for .NET 8. |
| Elixir | Hex `firecrawl` | Generated v2 endpoint wrappers returning `Req.Response` tuples, with validating and bang variants but no cross-endpoint polling abstraction. |

This table describes current source, not a promise that every SDK must expose every newly added API on the same release.

## Structured-output schemas

JavaScript and Python accept framework-native schemas as request conveniences, but JSON Schema on the wire remains the portable contract.

JavaScript converts Zod schemas used by scrape formats, change tracking, extract, and agent calls, and its scrape overload can infer the TypeScript `json` field. That inference does not parse or validate the response through Zod at runtime.

Python converts Pydantic classes or instances, resolves references where possible, and normalizes structured-output constraints. Returned `Document.json` remains dynamically typed rather than becoming an instance of the supplied model.

Other SDKs primarily accept maps or language-native JSON model types. Schema conversion, reference handling, and client-side validation therefore must not be assumed to match across languages; the emitted schema and server response are the interoperability boundary.

## File parsing boundary

File parsing is a multipart upload protocol with a scrape-like but deliberately narrower option surface.

A parse request sends one file part plus a JSON `options` part to `/v2/parse`, whose server contract is described by [[http#Parse]]. SDKs accept different native inputs—buffers, blobs, paths, byte arrays, or file-like objects—so filename, content type, file I/O, and empty-input checks remain client responsibilities.

Parse does not run browser actions or waits and does not accept location or mobile-rendering controls. Screenshot, branding, change-tracking, cache, and indexing options are outside the portable parse surface; proxy selection is limited to `auto` or `basic`.

Validation timing differs. JavaScript models a parse-specific subset, Python accepts its scrape options type and validates during request preparation, several object-oriented clients validate builders or option models, and Go leaves some string-valued constraints to the server.

Portable code should construct parse-specific options and must not assume that a field accepted by scrape is accepted by parse, or that every SDK rejects the same invalid request before network I/O.

## Research clients

Maintained SDKs expose the configured research proxy as a distinct method family rather than overloading ordinary web search options.

The common operations are paper search, paper metadata inspection, query-guided paper reading, related/citing/reference discovery, and GitHub history or README search. They target canonical `/v2/search/research` paths described by [[http#Research]].

JavaScript exposes [[apps/js-sdk/firecrawl/src/v2/methods/research.ts#ResearchClient]] through `firecrawl.research`. Python, Go, Java, PHP, Rust, Ruby, .NET, and generated Elixir expose corresponding language-native methods, with their usual response and error conventions.

Python exposes research only on its direct v2 synchronous and asynchronous clients. The unified `Firecrawl` and `AsyncFirecrawl` façades do not forward these methods.

These methods exist even when a self-hosted server has not configured `RESEARCH_PROXY_URL`; clients then observe route absence rather than falling back to general search. Research billing, keyless eligibility, upstream availability, and retention remain server contracts rather than SDK policy.

## Runtime compatibility

Each package declares its own consumer runtime floor rather than inheriting one repository-wide toolchain.

| Client | Declared runtime contract |
| --- | --- |
| JavaScript/TypeScript | Node.js 22 or newer. |
| Python | Python 3.8 or newer. |
| Go | Go 1.23 module. |
| Java | Java 11 source and target compatibility. |
| PHP | PHP 8.1-compatible releases. |
| Rust | Rust 2021 edition; no explicit minimum Rust version is declared. |
| Ruby | Ruby 3.0 or newer. |
| .NET | .NET 8.0. |
| Elixir | Elixir 1.15-compatible releases. |

Build and publication runners do not redefine these consumer contracts. For example, JavaScript workflows currently run Node.js 20 even though the published package declares Node.js 22, so workflow success alone is not evidence for a supported runtime.

## JavaScript and Python compatibility façades

JavaScript and Python make v2 the default while keeping feature-frozen v1 clients reachable for migrations.

The unified JavaScript [[apps/js-sdk/firecrawl/src/index.ts#Firecrawl]] extends [[apps/js-sdk/firecrawl/src/v2/client.ts#FirecrawlClient]] and lazily exposes `.v1`. Deprecated v1-style method aliases on the v2 client delegate to current names so reflection and older integrations keep working.

Python follows the same general shape through [[apps/python-sdk/firecrawl/client.py#Firecrawl]]: top-level methods target v2 and `.v1` exposes the legacy client. `AsyncFirecrawl` provides awaitable methods rather than wrapping the synchronous transport at call sites.

The Python unified façades are not complete aliases for the direct v2 clients. Research methods and historical credit and token usage remain available only through `FirecrawlClient` or `AsyncFirecrawlClient`.

Legacy compatibility is intentionally contained. New features belong on v2 types and methods; v1 remains available for existing consumers but is not the parity target.

## Interactive browser execution

SDKs expose two browser execution protocols whose resource identifiers and lifecycles are not interchangeable; see [[browser#Runtime modes]] for their shared server runtime.

Scrape-bound interaction executes code against the browser retained for a scrape job through `/v2/scrape/{jobId}/interact`; its stop operation releases that retained session. Standalone browser methods instead create a browser session, execute against its session ID, list sessions, and delete the session.

JavaScript, Python, Go, Java, PHP, and generated Elixir currently expose both protocols. Rust and Ruby expose scrape-bound interaction without the standalone browser lifecycle, while .NET exposes neither.

Both protocols can surface live-view or connection metadata, but that metadata does not transfer ownership between resource families. Callers must retain the originating job or session ID and invoke the matching remote stop or delete operation when cleanup matters.

## Asynchronous jobs

Long-running resources use a start, observe, terminate pattern even when an SDK also offers a one-call waiter.

1. A start method submits crawl, batch scrape, extract, or agent work and returns a job ID.
2. A status method returns lifecycle state and any available results.
3. A convenience waiter polls until `completed`, `failed`, or `cancelled`, with caller-configurable interval and timeout where supported.
4. Cancellation and error-detail methods remain separate because a completed job may contain per-URL failures.

The exact lifecycle set varies by resource and client, and additive states are not portable. Python uses `Literal` fields, Rust uses an enum, and JavaScript uses closed unions for crawl and batch states; Go stores the same state as a tolerant string.

New job states therefore require coordinated client evolution rather than an assumption that every SDK will treat an unknown value as progress. Waiters should preserve the job ID in errors and apply a deadline where supported; see [[sdk-architecture#Client evolution rules]].

### Client cancellation and remote cancellation

Stopping local control flow does not imply that the server-side resource stopped.

A transport timeout, cancelled context or future, closed watcher, or interrupted polling loop can leave a crawl, batch, agent, or browser resource active. Use the resource's explicit cancel or delete operation when remote termination matters, then observe its terminal state.

### Pagination

Crawl, batch, and monitor results can continue through an opaque `next` URL because a finished job may contain more documents than one response.

JavaScript and Python auto-aggregate pages by default and allow bounded or manual pagination. Rust auto-aggregates completed crawl and batch results plus monitor-check pages; other clients expose `next` or aggregate selectively. Callers must pass opaque cursors unchanged.

#### Continuation URL trust boundary

An absolute continuation URL is both pagination state and a credential-routing boundary.

PHP, Ruby, and .NET reject cursors whose scheme, host, or port differs from the configured API origin. Python's synchronous transport rebases off-origin cursor paths onto its configured origin.

Python's asynchronous transport, JavaScript, Go, Java, Rust, and generated Elixir currently follow absolute cursors with configured authenticated transports, so callers must only trust server-issued cursors.

A client must never copy an API key to a continuation origin selected by untrusted application data. New pagination helpers should preserve the opaque cursor while enforcing same-origin credential handling.

### Webhooks and idempotency

Polling is not the only completion channel: request models can carry webhook configuration, while maintained v2 clients expose an idempotency header for batch starts and Rust also exposes it for crawl starts.

Webhooks suit detached workflows; waiters suit interactive processes; status calls support recovery after interruption. The idempotency key is request identity, not job identity, and belongs in `x-idempotency-key`, not the JSON body.

Automatic retry of a job-creating request can be ambiguous if the server accepted work before the client saw a failure. Reuse one stable key across retries of the same logical start when that resource and SDK support it; otherwise reconcile by returned job identity or application state.

## Live job watching

JavaScript and Python add WebSocket watchers for incremental crawl and batch results, with HTTP polling as a recovery path.

The JavaScript [[apps/js-sdk/firecrawl/src/v2/watcher.ts#Watcher]] emits deduplicated `document`, `snapshot`, `done`, and `error` events. A socket close falls back to status polling, and terminal snapshots close the watcher.

Python provides threaded [[apps/python-sdk/firecrawl/v2/watcher.py#Watcher]] callbacks and an asynchronous iterator through [[apps/python-sdk/firecrawl/v2/watcher_async.py#AsyncWatcher]]. Both consume catch-up, document, error, and done messages and poll during quiet or failed connections.

Watchers improve latency but do not change job durability. Consumers should key durable state by job ID and document identity, tolerate catch-up replay, and regard the terminal status endpoint as authoritative.

## Generated and handwritten boundaries

Elixir is the only SDK whose public client is explicitly generated from the external Firecrawl v2 OpenAPI document.

`apps/elixir-sdk/generate.exs` fetches the specification, skips selected operations, generates validated `Req` wrappers in `lib/firecrawl.ex`, detects public-function removal for versioning, and bumps the package when output changes. Generated client code must not be edited directly.

All other SDK clients in this tree are maintained as language-specific source and models. Their request shaping, aliases, polling, pagination, and error semantics can intentionally exceed what an OpenAPI generator would provide, but must be reviewed for parity when the API evolves.

## Versioning and publication

Each SDK owns its version in its native package metadata and publishes through a path-scoped GitHub Actions workflow.

JavaScript uses its package manifest; Python uses `firecrawl/__init__.py`; Go uses `version.go`; Java uses Gradle; PHP uses `src/Version.php`; Rust uses Cargo; Ruby uses `lib/firecrawl/version.rb`; .NET uses its project file; and Elixir uses `mix.exs`.

Most publication workflows compare that local version with the canonical registry before publishing. Go instead creates the nested-module tag `apps/go-sdk/vX.Y.Z`; a repository-root `vX.Y.Z` tag does not release that module.

JavaScript deliberately builds once and republishes the artifact under three npm names. Python similarly publishes the same source as both `firecrawl-py` and `firecrawl`, using `firecrawl-py` for the release gate.

PHP is mirrored by a forced subtree split to the external `firecrawl-php` repository before Packagist is notified. That mirror is a publication artifact; this monorepo remains the source edited and tested for the PHP package.

Elixir regeneration runs on a schedule or manual dispatch, opens a reviewable generated-code pull request, and publishes to Hex only after the resulting version reaches `main`.

Package versions describe client compatibility, not synchronized monorepo releases. Changes to public method signatures or serialized option shapes require the appropriate semantic-version decision for each affected package.

### Attribution version coupling

Release metadata and request attribution do not always share one source of truth.

Go, Rust, Ruby, PHP, JavaScript, and Python derive attribution from package version sources. Java, .NET, and generated Elixir currently carry separate hard-coded origin strings; Elixir's generator template also owns that string. Release preparation must keep these values synchronized.

An origin mismatch does not change wire compatibility, but it corrupts telemetry and keyless-tier attribution. Version review must include serialized `origin` values as well as registry metadata.

## Client evolution rules

SDK maintenance should preserve wire correctness first, then idiomatic ergonomics and migration safety.

- Add v2 behavior to native request and response types before compatibility aliases.
- Keep start/status/cancel primitives even when adding a waiter or watcher.
- Preserve opaque pagination links, same-origin credential handling, server error details, custom API URLs, and SDK origin metadata.
- Coordinate additive response enums across clients whose decoders or public types use closed state sets.
- Regenerate Elixir from its source specification; never patch generated output as the durable fix.
- Update package-scoped tests, alias metadata, attribution versions, and publication metadata in the same SDK directory.

Cross-language parity is evidence-driven. A method existing in JavaScript or Python does not establish that it exists in every client.
