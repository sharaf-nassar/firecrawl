# Scraping Pipeline

Scraping is a feature-aware engine race followed by a deterministic transformation, accounting, and persistence pipeline.

## Request normalization

Scrape schemas turn public options into a canonical internal representation before any engine is selected.

Options cover output formats, main-content filtering, tags, headers, waits, mobile/location, proxy mode, TLS policy, actions, PDF parsing, caching, redaction, and LLM-derived formats. V2 uses strict objects and typed format entries; v1 retains older fields and transformations.

Requested formats also imply internal prerequisites. JSON, deterministic JSON, summary, question, highlights, query, change tracking, and redaction need markdown even when markdown is not returned.

## Scrape execution pipeline

[[apps/api/src/scraper/scrapeURL/index.ts#scrapeURL]] coordinates URL validation and rewriting, feature derivation, engine selection, timeout/abort control, postprocessors, transformers, and final response cleanup.

The same function accepts network URLs and uploaded parse inputs. It creates a mostly immutable metadata object carrying request identity, team policy, options, cost tracking, logger context, and abort state through every stage.

## Engine capabilities

Engines advertise supported features and quality so selection reflects requested behavior instead of a fixed browser-first order.

Configured candidates include recent index content, Fire Engine CDP or TLS modes, Playwright, direct fetch, PDF and office-document parsers, Wikipedia, and X/Twitter specialty handlers. Deployment configuration removes unavailable candidates before selection.

PDF, document, actions, wait, screenshots, audio/video, location, mobile, TLS, stealth, branding, and ad-block policy become feature flags. Lockdown requests force index-only behavior and ignore request-time features by design.

## Waterfall and racing

The engine loop ranks compatible candidates, starts the best candidate, and waterfalls or races later candidates when the current attempt exceeds its reasonable-time budget.

An attempt is successful only when transport status, page-error state, and useful-content checks pass. Failure removes that engine and advances the waterfall. When no configured engine supports actions, the pipeline returns a specific unsupported-actions error instead of silently omitting actions.

The winning engine records its identity, unsupported optional features, cache state, proxy, content type, status, timing, and postprocessors in metadata. Unsupported optional features may yield a warning; required behavior prevents selection.

## Engine rollout and shadowing

Hosted scrape paths can sample non-ZDR traffic into staging or alternate Fire Engine deployments without changing the public request schema.

[[apps/api/src/services/ab-test.ts#abTestJob]] asynchronously mirrors sampled standalone page jobs to a staging `/v2/scrape` endpoint. It forwards the URL and scrape options, ignores the mirror response, caps the mirror budget, excludes agent modes, and never runs for ZDR work.

[[apps/api/src/services/ab-test.ts#abTestFireEngine]] independently supports Fire Engine `mirror` and `split` modes. Mirror keeps production authoritative and compares returned content and timing later; split makes the sampled alternate base URL authoritative for that engine attempt.

Sampling rates are clamped to zero through one. Mirror failures are logged without changing the primary result, while alternate jobs are deleted on a best-effort basis. These rollout paths move complete request or engine payloads and therefore remain subject to the explicit non-ZDR gate.

## Postprocessing and transformation

Postprocessors handle source-specific content before the ordered transformer stack derives the requested document fields.

The transformer order is a correctness contract: metadata and cleaned HTML precede markdown; markdown precedes LLM extraction, summaries, questions, highlights, deterministic JSON, redaction, and diffs. Links, images, attributes, branding, products, media, and index submission run only when requested or operationally required.

[[apps/api/src/scraper/scrapeURL/transformers/index.ts#executeTransformers]] executes the stack sequentially and records stage timing. Final coercion removes internal prerequisite fields that the caller did not request.

## LLM schema extraction

The `json` format converts scraped markdown into schema-constrained data within the synchronous scrape pipeline, superseding the older asynchronous extract product for ordinary page extraction.

[[apps/api/src/scraper/scrapeURL/transformers/llmExtract.ts#performLLMExtract]] normalizes caller schemas into strict object shapes, requires declared properties, and selects a stronger model when recursive references are present. When only a prompt is supplied, it derives a schema before extraction.

Input is bounded before synchronous tokenization and then trimmed to the selected model's context budget. The result carries a warning when content was trimmed. Model refusal has a distinct domain error, malformed JSON gets one repair path, and rate-limit or quota failures can retry on the configured fallback model.

Agent extraction may request interactive SmartScrape when ordinary markdown lacks content hidden behind user actions. Cost tracking records model calls and agent work so [[scraping#Scrape billing]] uses actual resources rather than only the presence of a JSON format.

ZDR disables this format at transformation time: the scrape can still succeed, but it returns a warning and omits generated JSON rather than sending page content to the model.

## Deterministic JSON

Deterministic JSON generates and reuses a page-specific extractor instead of asking a model to reproduce the final object on every scrape.

[[apps/api/src/lib/deterministicJson/extract.ts#extractDeterministicJson]] keys cached extractor code by version, model, URL, schema, and prompt. A cache miss selects anchor HTML, generates validated code, runs it against the current document, and stores it for reuse.

Generated code executes in the configured sandbox against jsdom rather than the API process or live page. Its only host callback is a bounded `askLlm` channel. Output is parsed against the requested schema before becoming `document.json`.

A failed cached extractor is regenerated once. Selectors judged too strict receive one repair attempt. ZDR disables the feature because reusable code and LLM responses are persisted in database caches.

## PII redaction

PII redaction is an external, all-or-nothing markdown transformation that fails closed rather than returning partially cleaned content.

[[apps/api/src/lib/fire-privacy-client.ts#redactText]] maps public modes and replacement styles to the configured Fire Privacy service, chunks markdown under its request limits, runs at bounded concurrency, validates spans, filters requested entity classes, and merges offsets back into one document.

Inputs above 250,000 UTF-8 bytes are skipped without an upstream call. Missing configuration, timeout, unreachable service, invalid response, or any failed chunk produces no redacted markdown; empty input passes through as a skipped no-op.

[[apps/api/src/scraper/scrapeURL/transformers/redactPII.ts#performRedactPII]] replaces source markdown with the redacted result. When safe output is unavailable it writes an empty markdown string, so downstream transformers and the final response cannot accidentally expose the unredacted source.

The external service receives raw markdown chunks before redaction. Deployment privacy review must therefore include that service's transport and retention guarantees; the API's fail-closed output rule does not itself establish upstream zero retention.

## Branding profile extraction

The `branding` format turns rendered page evidence into a reusable visual identity while preserving deterministic output when AI enhancement is unavailable.

Engines must advertise branding capability. Raw browser analysis captures color samples, typography, spacing, radii, buttons, inputs, image candidates, and framework hints; a deterministic processor converts those signals into the public profile.

[[apps/api/src/lib/branding/transformer.ts#brandingTransformer]] ranks logo candidates heuristically, limits the AI view to 20 logos and 12 high-value buttons, and asks a schema-constrained model to classify color roles, calls to action, personality, fonts, and design-system hints. Invalid model indices fall back to the heuristic.

Model refusal, invalid output, or transport failure returns deterministic browser analysis rather than failing the scrape. Raw snapshots, candidate lists, and framework hints are removed unless deployment or team debug branding is enabled, and branding fields are removed when the caller did not request the format.

AI enhancement sends page-derived text, candidate URLs, and an optional screenshot to the selected model even for a ZDR scrape. ZDR suppresses sensitive error capture at this boundary but does not skip the model call, so branding does not inherit the `json` format's ZDR exclusion.

## Native processing boundary

CPU-heavy and structure-sensitive parsing is shared through native libraries while orchestration remains in TypeScript.

The Rust N-API package exports crawl filtering, sitemap parsing, HTML cleanup and extraction, engine verdicts, PDF processing, and office-document conversion. For example, [[apps/api/native/src/crawler.rs#filter_links]] applies crawl policy over batches of candidate URLs.

HTML-to-markdown conversion uses a separately built Go shared library loaded through Koffi, then Rust postprocessing. Native logging is translated into request-scoped structured entries so native failures retain API trace context.

Native implementations are semantic dependencies: JavaScript fallbacks or alternate engines may handle selected failures, but crawl filtering and document conversion must preserve the same public options and metadata contracts.

## Crawl discovery

Crawl discovery consumes links from scraped documents but applies crawler policy before creating more jobs.

Eligibility includes domain/subdomain/external-link policy, include/exclude regular expressions, discovery depth, entire-domain behavior, query normalization, similar-URL deduplication, robots policy, sitemap mode, delay, and global result limit.

Normalized URL locks are acquired before enqueue, making link discovery safe under parallel child completion. Sitemap and index results are treated as discovery inputs, not automatically trusted output.

## Cache hierarchy

Scraping can use recent indexed documents before network engines when request capabilities match the stored variant.

Index variants include URL hash, device mode, ad blocking, stealth, location country, and language set. Age, screenshot capability, fullscreen capability, and wait duration filter candidate rows.

The optional Dragonfly/Redis front cache fails fast and falls back to PostgreSQL index queries. Positive writes invalidate negative markers. Cache errors affect latency and engine choice, not correctness.

See [[lat.md/api/persistence#Index and cache stores]].

## Index submission

Scrape postprocessing can export either complete documents or discovered link graphs to separately configured indexing systems.

The search-index transformer samples successful documents and asynchronously sends URL, resolved URL, title, description, markdown, raw HTML, screenshot, language, country, device mode, and object path. It excludes parse work, ZDR and lockdown requests, authenticated-header content, failed responses, short markdown, and unparsed PDFs.

The link-index transformer uses a separate traffic share and persistent RabbitMQ exchange. It extracts and publishes the discovery URL plus deduplicated links for non-parse team work, excluding robots and sitemap pseudo-teams; publisher failure is logged without failing the scrape.

Current link-index admission does not apply the search-index transformer's ZDR, lockdown, or authorization-header checks at this boundary. This privacy asymmetry is current behavior, not a reusable policy, and must be resolved explicitly before link indexing is assumed to follow [[scraping#Privacy and retention|core scrape retention rules]].

These outbound indexing paths differ from the local reusable content index described by [[persistence#Index and cache stores]]. None owns customer job completion or authorization.

## Result metadata

Document metadata is the stable record of how content was obtained and what downstream accounting should trust.

It includes source and final URL, status, content type, title/description and other page metadata, engine/cache/proxy information, timing, warnings/errors, PDF pages, credits used, and crawl concurrency diagnostics where applicable.

Raw HTML and other expensive fields are removed unless requested. Synchronous scrape may expose its internal scrape ID only for selected website-origin clients.

## Scrape billing

Scrape cost begins at one credit and increases for resource-intensive or privacy-sensitive features.

[[apps/api/src/lib/scrape-billing.ts#calculateCreditsToBeBilled]] accounts for JSON extraction, deterministic JSON code generation or cache reuse, questions/highlights, media, PDF pages, PII redaction, lockdown/ZDR, stealth proxy, specialty sites, unblocked domains, and agent model cost.

Failures are generally not billed, except work that consumed defined resources such as DNS resolution or lockdown-cache checks and agent inference. Worker accounting uses the actual winning result and cost tracker, not only the admission estimate.

## Privacy and retention

Core scrape execution propagates ZDR as logging policy, persistence deadline, external-export policy, and Sentry filtering rather than as a response-only flag.

Forced team policy overrides request preference. Logs redact URLs, queries, options, and errors where required. Artifact persistence uses immediate or shortened cleanup semantics. Extract and agent currently reject forced ZDR because their durable workflow cannot honor that policy end to end.

[[scraping#Engine rollout and shadowing|Staging mirrors]] and full-document [[scraping#Index submission|search indexing]] explicitly exclude ZDR traffic. Link-index forwarding does not currently apply the same guard, and [[http#Research|research proxy logging]] explicitly records with ZDR disabled; both are documented exceptions, not evidence that ZDR policy is optional.
