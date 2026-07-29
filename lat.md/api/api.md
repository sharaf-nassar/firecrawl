# API

The API domain covers Firecrawl's public request contracts, scrape execution, asynchronous jobs, persistence, admission policy, billing, delivery, operations, and tests.

- [[overview]] — Service boundaries, startup, configuration, versioning, and architectural invariants.
- [[http]] — HTTP and WebSocket routes, contracts, middleware, and endpoint workflows.
- [[jobs]] — Queue backends, job and group lifecycle, concurrency, and worker topology.
- [[scraping]] — Engine selection, waterfall execution, transformations, discovery, cache behavior, and scrape billing.
- [[browser]] — Interactive browser sessions, replay, profiles, action ordering, startup fencing, proxy grants, and terminal accounting.
- [[monitoring]] — Scheduled checks, scrape/crawl reuse, snapshot comparison, billing, notifications, and recovery.
- [[persistence]] — PostgreSQL, Redis, artifacts, index storage, analytics, retention, and data authority.
- [[trust-and-operations]] — Authentication, authorization, limits, credits, webhooks, observability, and errors.
- [[tests]] — Unit, integration, end-to-end, queue, scraper, persistence, and harness test organization.
