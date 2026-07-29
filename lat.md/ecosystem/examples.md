# Consumer Examples

The `examples` tree is a collection of copyable recipes and deployment samples, not a versioned library or a uniformly supported application workspace.

Examples provide integration ideas and historical compatibility evidence. Current SDK source, API contracts, self-hosting documentation, and deployment manifests remain authoritative.

## Content strata

Examples span several artifact types with different maintenance expectations.

- Standalone Python and JavaScript scripts demonstrate scraping, crawling, extraction, research, enrichment, and model-assisted analysis.
- Notebooks, MDX files, and mirrored blog articles preserve tutorial narratives and their dependency assumptions.
- Small application examples compose Firecrawl with model providers, E2B, CRM systems, search providers, or realtime interfaces.
- `full_example_apps/README.md` points to an external application-examples repository rather than vendoring those applications.
- `kubernetes` contains direct manifests and a Helm chart for self-hosting demonstrations.

Directory proximity does not make these artifacts one build. Most examples have no manifest, shared lockfile, common runner, or repository-wide CI job.

## API and dependency compatibility

Example code intentionally reflects the client and provider versions current when each recipe was written.

Many Python recipes still use the legacy `FirecrawlApp` façade or older extract polling shapes, while newer examples use `Firecrawl`. Some call HTTP endpoints directly, and only a subset carries pinned requirements, lockfiles, or environment templates.

An example is therefore a migration signal, not proof of the current public contract. When adapting one, verify imports, method names, response fields, endpoint versions, and provider dependencies against [[sdk-architecture]] and current package documentation.

## Credentials, cost, and side effects

Running an example can invoke multiple paid or stateful external services.

Recipes commonly read `FIRECRAWL_API_KEY` plus model, search, sandbox, database, CRM, or platform credentials. Direct HTTP examples construct bearer headers themselves, while SDK examples generally load credentials from the environment.

Environment templates may contain placeholders, but scripts can still scrape live sites, create remote jobs, send content to third-party models, or mutate connected systems. Use scoped credentials, inspect targets, and understand provider costs before execution.

Never commit populated `.env` files or Kubernetes secrets. Generated datasets, screenshots, and notebook outputs can also contain scraped or model-derived data that needs review before publication.

## Kubernetes samples

The Kubernetes subtree offers both an imperative manifest set and a more complete Helm deployment example.

`cluster-install` applies individual API, worker, queue, database, Redis, and Playwright resources. `firecrawl-helm` adds configurable worker roles, RabbitMQ, overlays, image selection, resources, secrets, and optional multi-architecture image builds.

These assets are examples rather than the canonical deployment release. The Helm defaults can reference third-party multi-architecture images, and neither sample is automatically synchronized with compose files, service workflows, or current self-hosting requirements.

Before production use, compare component roles, environment variables, image tags, persistence, ingress, secret management, architecture support, and upgrade behavior with the current runtime and operations documentation.

## Maintenance boundary

Example changes should optimize clarity and reproducibility without turning the tree into an implicit compatibility promise.

Keep credentials in documented environment variables, add a local manifest when an example needs non-obvious dependencies, and state external side effects. Prefer current v2 clients in new examples while retaining older tutorials only when their historical value is explicit.

API or SDK changes should update high-visibility root examples and directly affected recipes, but do not assume every historical notebook can move in lockstep. External application pointers require coordination in their owning repositories.
