# API Test Organization

API tests combine colocated unit tests, subsystem suites, service-backed integration tests, contract checks, and end-to-end HTTP coverage.

## Vitest contract

Vitest runs TypeScript tests under Node with globals, fork isolation, long scrape-friendly timeouts, and JUnit output.

`apps/api/vitest.config.ts` includes `src/**/*.test.ts` and excludes build output and dependencies. Fork isolation is intentional because suites use real sockets and heavy module mocking. Test and hook timeouts are 120 seconds; teardown has 30 seconds for service drains.

Package scripts select environments by excluding authenticated, unauthenticated, full, production-incompatible, scraper-heavy, or local-persistence groups. Packaging migrations have a separate Node test runner.

## Unit and component tests

Most tests are colocated beside the library, controller, scraper, search, or service behavior they protect.

High-density areas include browser runtime/state, scrape interactions and replay, artifact manifests/providers, index cache, keyless accounting, authentication helpers, billing, feedback refunds, monitoring, webhook filters, deterministic JSON, URL validation, search provider contracts, highlighting, and engine utilities.

These tests usually replace external dependencies and focus on state transitions, schema projection, retry policy, privacy, and edge conditions.

Configuration regression tests verify that empty OpenAI and Ollama base URLs parse as unset while non-empty custom endpoints pass through unchanged.

### Bounded logger metadata

Logger unit tests prove warn/error metadata stays within its byte budget when errors contain huge provider fields or cyclic causes while preserving bounded error identity, stack, scalar code, and cause context.

### OpenAI endpoint selection

Generic AI tests invoke the returned OpenAI model with intercepted transport, proving endpoint selection from the installed provider rather than provider labels or implementation details.

#### Opt-in Chat Completions

Enabling `OPENAI_CHAT_COMPLETIONS_ONLY` sends language-model requests to `/chat/completions`, never `/responses` or `/embeddings`.

#### Default Responses API

Leaving `OPENAI_CHAT_COMPLETIONS_ONLY` disabled preserves the hosted default and sends language-model requests to `/responses`.

Search provider unit tests fix the local and non-local precedence matrix, SearXNG POST/deadline/result/page/concurrency bounds, strict engine diagnostics, canonical errors, valid empty results, partial warnings, and zero application retries.

Ordinary search controller tests cover v0, v1, and v2 provider-error envelopes, pre-reservation local source rejection, top-level partial warnings, valid-empty zero billing, keyless reconciliation, and absence of scrape dispatch after provider failure.

## Internal search consumers

Focused contracts keep extraction and deep research aligned with shared search-provider semantics.

### Extraction

Extraction search tests cover provider failures, legitimate empty discovery, and sanitized partial warnings.

#### Errors propagate

Canonical unavailable and bad-response errors plus unexpected defects bubble unchanged, with one provider execution per discovery request and no local HTTP mapping.

#### Valid empty

A legitimate empty provider response remains an ordinary empty URL list after exactly one provider execution.

#### Partial warning

A partial result keeps the canonical sanitized warning and discovered URL after exactly one provider execution.

### Deep research

Deep-research search tests cover provider failures before scraping, legitimate empty results, and sanitized partial warnings.

#### Errors propagate

Canonical unavailable and bad-response errors plus unexpected defects bubble unchanged before scraping, with one provider execution and no local HTTP mapping.

#### Valid empty

A legitimate empty provider response remains ordinary empty input to scraping after exactly one provider execution.

#### Partial warning

A partial result keeps the canonical sanitized warning with scraped documents after exactly one provider execution.

## Queue and worker tests

Queue tests exercise backend semantics and migration invariants without treating queue implementations as interchangeable black boxes.

NuQ PostgreSQL and FoundationDB suites cover enqueue/claim/lease/finish/fail, group accounting, backlog gates, slots, sweeping, routing, and stress. Worker tests cover billing, cancellation, crawl completion, concurrency release, queue failures, and ZDR cleanup.

The most important invariant is backend pinning: existing crawl work remains readable and completable after team routing policy changes.

Legacy-worker tests separately cover deep-research progress state and generation helpers because those products use BullMQ and Redis rather than NuQ group semantics.

## Scraper tests

Scraper suites validate engine selection, transport safety, document handling, transformations, and crawl discovery.

Coverage includes DNS and blocklists, engine forcing, retry budgets, robots decisions, sitemap behavior, max depth, PDF/document parsing, metadata, links/images, URL rewriting, postprocessors, browser actions, and scrape output formats.

External engine suites are separated from pure transformer tests because they require different fixtures and service availability.

## Specialized proxy and transformer gaps

Privacy-sensitive transformers have focused unit coverage, while several hosted proxy and rollout boundaries lack end-to-end proof.

Fire Privacy client tests cover mode mapping, chunking, span filtering, size limits, timeouts, service errors, all-or-nothing failure, and the redaction transformer's empty-markdown fallback. HTTP suites do not prove the same fail-closed result through a configured live Fire Privacy service.

Branding has detailed color-normalization unit tests, but its live scrape suite is skipped. Logo ranking, AI index remapping, deterministic fallback, debug-field removal, prompt-injection resistance, ZDR behavior, and the complete public profile therefore lack an active end-to-end contract.

Search-index transformer tests cover lockdown exclusion and ordinary forwarding. They do not cover ZDR, authenticated headers, sampling, malformed metadata, or asynchronous send failure, and no test covers the separate link-index traffic share or its current privacy-policy asymmetry.

No direct test exercises `/agent-livecast` registration, authentication absence, upstream configuration failure, frame relay, disconnect cleanup, or console logging. Browser proxy tests do not cover this unrelated unversioned relay.

No direct test covers the support proxy's header allowlist and timeout mapping, the partner-integration proxy's upstream-auth boundary, v2 activity cursor pagination, or Fireclaw's play clamping and per-play billing.

No test covers scrape-to-staging mirroring, Fire Engine mirror versus split authority, ZDR exclusion, sample-rate clamping, comparison failure, or alternate-job cleanup. These omissions leave rollout isolation and data-routing policy dependent on source inspection.

## HTTP and controller tests

Controller tests verify route schemas, status ownership, billing projection, feedback, browser proxying, monitoring, and public error envelopes.

End-to-end directories cover no-auth, authenticated v0/v1/v2 behavior, full parameter matrices, map, and extract. Their environment variables select local self-hosted service URLs and test teams.

Route middleware tests assert credit admission and request normalization separately from controller execution, preserving the policy boundary documented in [[lat.md/api/http#Admission pipeline]].

## Persistence and browser tests

Persistence suites cover both provider-neutral artifacts and the local application-database authority.

Local harness tests validate migrations, owner identity, manifest rollback, retention, shutdown, browser-service startup, stale-contract detection, billing outbox, reconciliation, replay checkpoints, and filesystem state.

The dedicated `test:package-migrations` Node suite exercises packaging faults, path identity, exact inventory, rollback, and concurrent publishers for [[lat.md/api/persistence#Persistence and Storage#Database migrations]]. CI validates packaging through the API image build but does not invoke this suite directly.

MinIO integration tests and GCS cache tests require their named services or mocks; pure manifest tests verify consistency without a provider.

## Browser protocol and recovery tests

Browser suites treat the local runtime as a fenced distributed state machine rather than only an HTTP proxy.

Coverage includes startup handoff, reconciliation snapshots, mutation-gate drain behavior, profile writer exclusion, action identity and side-effect replay, operation timeouts, proxy-grant redemption, replay ingestion, terminal claims, billing outbox receipts, and admission cleanup.

Controller and snip suites separately exercise the hosted compatibility path, local browser path, scrape-bound interaction, public error sanitization, ownership, and billing.

## Monitoring tests

Monitoring suites cover schedules, durable check transitions, snapshot semantics, billing settlement, and notification consent.

Tests exercise cron parsing, jitter and scheduler overlap, monitor store operations, scrape/crawl runner recovery, stale checks, markdown and JSON diffs, meaningful-change judgment, email recipient synchronization, and page/check webhook delivery.

## Harness and lifecycle tests

Harness tests verify dependency startup order, readiness, process supervision, command routing, and shutdown.

The local Firecrawl lifecycle script is separate from Vitest because it starts the full service graph. Browser-local and local-persistence scripts deliberately serialize selected tests to avoid port, socket, and state collisions.

## Coverage boundaries

The suite is broad but intentionally split by deployment capability.

Hosted-only billing, provider credentials, external engines, search services, browser services, RabbitMQ, FoundationDB, MinIO, and PostgreSQL behaviors cannot all run in a minimal local unit pass. Script names and exclusions communicate which backing services are required.

There is no `require-code-mention` frontmatter here because this file documents existing organization and invariants rather than declaring one-to-one test specifications.
