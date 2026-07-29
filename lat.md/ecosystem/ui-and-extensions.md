# User Interfaces and Agent Extensions

Firecrawl's adjacent user experiences include an in-tree legacy UI template and external repositories for product-building skills, CLI skills, and repeatable workflows.

These assets help people and agents consume Firecrawl; they are not part of the main API runtime.

This checkout contains no browser-extension manifest or browser-extension source. “Extensions” here means agent and platform integrations, not a shipped browser add-on.

## Ingestion UI template

`apps/ui/ingestion-ui` is a standalone Vite and React demonstration for configuring scrape and crawl requests.

The application switches between [[apps/ui/ingestion-ui/src/components/ingestion.tsx#FirecrawlComponent|v0]] and [[apps/ui/ingestion-ui/src/components/ingestionV1.tsx#FirecrawlComponentV1|v1]] components. It calls HTTP endpoints directly, displays selectable output formats and crawl options, and polls v0 crawl jobs.

This UI is a compatibility artifact, not the current v2 product frontend. Its labels and endpoint paths deliberately expose older API generations and should not define new client behavior.

### Legacy job behavior

The two modes do not model one shared crawl lifecycle.

The v0 component submits a crawl and polls until `completed`, without a deadline or explicit failed and cancelled handling. The v1 component's “crawl sub-pages” path maps links first, then lets the user scrape selected URLs; it is not a v2 crawl job.

Production code must use current terminal states, bounded waits, cancellation, and continuation behavior from [[sdk-architecture#Asynchronous jobs]] instead of copying these loops.

### Security boundary

The template embeds API URL and key placeholders in client-side source, which exposes substituted credentials to every browser user.

It is safe only as a local demonstration with a disposable or suitably restricted key. A production adaptation must move authenticated Firecrawl calls behind a server, add application authorization, and apply an appropriate CORS policy.

### Build boundary

The template owns its Vite, TypeScript, Tailwind, and pnpm configuration and is not imported by the API.

Its build proves only that the example frontend compiles. Server and SDK tests do not depend on this UI, and API changes require manual review against its legacy request shapes if continued compatibility matters.

## Firecrawl skills

`firecrawl-skills/README.md` points to `https://github.com/firecrawl/skills`, whose skills guide coding agents while adding Firecrawl to product code.

Those instructions focus on endpoint selection, SDK wiring, and credential setup. This repository contains only the pointer README, so skill source, installation metadata, tests, and release history must be inspected in the external repository.

## CLI skills

`firecrawl-cli-skills/README.md` points to skills maintained under the external CLI repository.

CLI skills teach coding agents to invoke live web commands during a session. They depend on the separately released [[cli]], its installed authentication, and its current output contract; they do not add commands to this monorepo.

## Firecrawl workflows

`firecrawl-workflows/README.md` points to `https://github.com/firecrawl/firecrawl-workflows`.

Workflow skills package multi-step deliverables such as competitor analysis and website design-clone briefs. They orchestrate API or CLI capabilities but own their prompts, templates, and deliverable contracts in the external workflow repository.

## MCP and platform integrations

The root README catalogs Firecrawl MCP plus external platform integrations such as Lovable, Zapier, and n8n.

No MCP server, platform connector, package manifest, or connector test suite is vendored here. Those links are discovery metadata; the linked project or platform owns installation, credential storage, request mapping, releases, and support.

Compatibility reviews must distinguish first-party API behavior from an integration's mapping layer. A server or SDK change can be valid in this repository while an external connector still needs an independent update.

## Extension compatibility

Agent-facing instructions amplify public contract changes because they encode both method choice and operational sequencing.

When an endpoint, SDK method, CLI flag, job lifecycle, or credential flow changes, review affected external skills, workflows, MCP servers, and platform connectors separately. A passing in-tree build cannot establish their compatibility because their executable content is absent here.
