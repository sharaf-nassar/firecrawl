# Firecrawl Command-Line Client

The Firecrawl CLI is the terminal-facing client for search, scrape, crawl, map, interaction, and agent jobs, but its implementation is maintained outside this repository.

`firecrawl-cli/README.md` is a locator for `https://github.com/firecrawl/cli`. This checkout contains no CLI package manifest, executable source, command parser, tests, or release workflow, so CLI behavior must be verified in that external repository.

## Command role

The CLI turns Firecrawl API operations into shell workflows for people and coding agents.

Immediate commands such as scrape, search, and map can print results directly. Crawl, interaction, and agent commands can involve server-side jobs, so automation must follow the current CLI's documented identifier and terminal-status behavior.

The main repository README presents the CLI alongside Python, JavaScript, and cURL examples. That documentation demonstrates product interoperability but does not make the CLI part of the in-tree build.

## Configuration boundary

The CLI is an API consumer, not a local service dependency.

Hosted use requires the CLI's supported API-key configuration; self-hosted use requires its supported base-URL configuration. Exact flags, config-file precedence, output modes, and credential storage belong to the CLI repository and must not be inferred from SDK conventions here.

## Repository integration

Server changes should consider CLI compatibility even though CLI code and releases are independent.

API route, request, response, status, pagination, or authentication changes can affect CLI commands. Compatibility review should use the external CLI's current source and tests, then coordinate CLI and SDK releases through their separate external processes.

See [[ui-and-extensions#CLI skills]] for the agent instructions that teach session-time CLI use and [[sdk-architecture#Asynchronous jobs]] for the shared server-side job model.
