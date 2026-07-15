# Local Firecrawl Design

## Goal

Run a stable, self-hosted Firecrawl instance directly from
`/home/mamba/work/firecrawl` and replace paid Firecrawl core API usage for an
application running on the same host.

## Scope

The deployment supports Firecrawl's open-source core APIs: scrape, crawl, map,
search, and batch scrape. AI-dependent features, Agent, Browser sandbox,
Actions, managed proxy rotation, and hosted dashboard functionality are out of
scope.

No application integration changes are included because the consuming
application is outside this repository. Its required migration is limited to
using `http://127.0.0.1:3002` as the Firecrawl API base URL and omitting the
cloud API key.

## Source and Repository Layout

Import the official Firecrawl v2.11.0 release into this repository root while
retaining the upstream release as Git history. Firecrawl source files must live
directly in `/home/mamba/work/firecrawl`; no nested Firecrawl source directory
will be created.

Keep the upstream `docker-compose.yaml` intact. Add local deployment behavior
through root-level, tracked configuration and documentation so future upgrades
can distinguish upstream changes from local operational policy.

## Architecture

The Docker Compose project contains these runtime services:

- Firecrawl API and worker harness
- Playwright browser-rendering service
- Redis cache and rate-limit coordination
- RabbitMQ worker transport
- NuQ PostgreSQL queue storage

PostgreSQL is the selected NuQ backend. Experimental FoundationDB services are
placed behind an opt-in Compose profile and do not start during normal local
operation.

The host application sends Firecrawl v2 requests to
`http://127.0.0.1:3002`. Docker publishes only the API port on the IPv4
loopback interface. Playwright, Redis, RabbitMQ, PostgreSQL, and FoundationDB
have no host-published ports and communicate only through the Compose backend
network.

## Local Configuration

Track a safe environment template containing required variable names and local
defaults. Keep the real root `.env` ignored by Git. Generate strong random
values for the PostgreSQL password and `BULL_AUTH_KEY` during setup.

Use these baseline settings:

- `PORT=3002`
- `USE_DB_AUTHENTICATION=false`
- Non-default PostgreSQL database and user names
- Upstream default worker concurrency and resource limits
- No OpenAI, proxy, Supabase, or cloud credentials

The API does not require a Firecrawl API key. Loopback-only publication is the
primary access-control boundary. The generated `BULL_AUTH_KEY` protects the
queue administration route.

## Reliability and Data

Add service restart policies suitable for a persistent local deployment. Add
health checks for Redis, RabbitMQ, and PostgreSQL, then make the API wait for
required dependencies where Compose supports health-based startup ordering.

Use explicit named volumes for PostgreSQL, Redis, and RabbitMQ. Routine stop,
restart, and `docker compose down` operations must preserve these volumes.
Documentation must distinguish normal shutdown from destructive volume
removal and must not recommend broad Docker cleanup commands.

## Operations

Root documentation provides exact commands for:

- Validating the merged Compose configuration
- Building and starting the stack in detached mode
- Inspecting service status and scoped logs
- Restarting or stopping only the Firecrawl project
- Accessing the protected Bull queue UI
- Configuring host-based Firecrawl clients
- Upgrading deliberately to a later verified upstream release

The standard start command is `docker compose up -d --build`. Normal operation
uses the automatically loaded local Compose override and root `.env`.

## Error Handling

Startup failures are diagnosed from `docker compose ps`, dependency-specific
health commands, and scoped logs for Firecrawl services. No success claim is
made from container state alone.

Scraping failures caused by target blocking remain visible to clients and
logs. The local deployment does not silently substitute cloud Fire-engine or
managed proxy behavior. Proxy configuration can be added later if actual
targets require it.

## Verification and Acceptance

No new automated test code is required. Setup verification consists of:

1. `docker compose config` succeeds and shows only the API bound to
   `127.0.0.1:3002`.
2. All normal-profile services start without FoundationDB.
3. RabbitMQ, Redis, and PostgreSQL dependency checks succeed.
4. A real Firecrawl v2 scrape request succeeds.
5. A real Firecrawl v2 crawl request returns a job identifier and its status
   endpoint can be polled successfully.
6. Restarting the Compose project preserves named-volume data and returns the
   API to a working state.

The deployment is complete only after the functional API checks pass from the
host at `http://127.0.0.1:3002`.

## Constraints and Trade-offs

Building the pinned source release takes longer and uses more disk than using
floating prebuilt images, but provides reproducible source and controlled
upgrades. Self-hosted Firecrawl lacks Fire-engine and managed proxy rotation,
so sites with sophisticated blocking may behave differently from the paid
service.

Firecrawl is licensed under AGPL-3.0. This local deployment retains upstream
licensing and notices.
