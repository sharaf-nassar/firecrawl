# Firecrawl

Firecrawl is a web-data platform that discovers pages, renders difficult sites, and returns LLM-ready documents or structured results through APIs, SDKs, and agent integrations.

The repository contains the public API and asynchronous workers, specialized browser and conversion services, first-party clients, integration surfaces, test systems, and self-hosting assets. This graph documents their contracts and design intent.

## Product boundary

Firecrawl owns the path from a web-oriented request to normalized, consumable output while isolating callers from browser orchestration, proxying, retries, content cleanup, and distributed job management.

Search and map discover sources. Scrape converts one source. Crawl and batch scrape coordinate many sources. Extract and agent workflows add model-guided structure or research. Browser interaction continues work against retained browser state.

## Architectural shape

The system separates request admission from execution so fast operations can return directly while expensive or multi-page work is represented as observable jobs.

The TypeScript API is the contract and orchestration boundary. Queue-backed workers and browser services perform expensive work; Redis, PostgreSQL, artifact storage, and browser-state storage preserve distinct kinds of coordination and durable state.

## Contract families

External contracts are versioned independently from internal engines so routing, scraping strategy, persistence, and deployment topology can evolve without forcing every client to change at once.

REST endpoints define the canonical behavior. First-party SDKs and the CLI translate language-native inputs into those contracts, including polling and streaming conventions for asynchronous jobs.

## Deployment models

Firecrawl supports a hosted product and self-hosted deployments with different capability envelopes.

The base self-hosted topology provides API, workers, queue storage, Redis coordination, and Playwright rendering. The repository's local topology adds application persistence, artifact storage, and isolated stateful browser interaction for development.

## Repository map

The monorepo groups independently deployable services and independently released clients beside shared operational and validation assets.

Detailed subsystem pages linked from this index are the authoritative map. Examples and generated documentation remain usage material rather than architecture definitions.

- [[api]] — HTTP contracts, execution pipelines, state, and API operations.
- [[clients]] — Language SDK and command-line client architecture.
- [[ecosystem]] — Repository organization and adjacent UI/agent extensions.
- [[operations]] — Local deployment, persistence, health, and recovery.
- [[runtime]] — Browser execution, interaction, conversion, and support services.
- [[testing]] — Client, fixture, integration, and benchmark testing.

## Design invariants

These principles connect the otherwise independent subsystems.

- Protected public request paths validate and authorize before expensive work is admitted. The unversioned [[http#Agent livecast]] relay is a legacy exception and must not be used as precedent.
- Job identifiers remain the stable handle for status, cancellation, streaming, and result retrieval.
- Scraping engines are selected behind one normalized document contract.
- New optional credentials and services must fail explicitly or select a documented fallback. Current exceptions are named in their owning contracts rather than treated as architecture patterns.
- Durable records, queue state, ephemeral coordination, artifacts, and live browser state have separate ownership and retention rules.
- Self-hosting must not silently imply parity with hosted-only providers or managed infrastructure.
- SDK convenience must preserve API semantics rather than invent a second behavior model.
