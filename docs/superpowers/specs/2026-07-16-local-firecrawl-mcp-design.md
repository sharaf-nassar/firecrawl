# Local Firecrawl MCP Integration Design

## Goal

Replace the paid Firecrawl MCP connection used by local Claude Code and Codex
sessions with the self-hosted Firecrawl API at `http://127.0.0.1:3002`.
Provide a safe, repository-owned command that either agent can use to recover
the Docker Compose stack on demand.

## Scope

Update the single effective user-level Firecrawl MCP registration for Claude
Code and the single effective user-level registration for Codex. Preserve all
unrelated MCP registrations and settings.

Add lifecycle automation and operator guidance to this repository. Do not
auto-start Docker whenever an MCP process launches. Recovery happens only
after an agent observes a Firecrawl connection or health failure.

## MCP Configuration

Both clients run the pinned official MCP package:

```text
npx -y firecrawl-mcp@3.22.3
```

Set the MCP process environment to:

```text
FIRECRAWL_API_URL=http://127.0.0.1:3002
```

Remove `FIRECRAWL_API_KEY` from both effective registrations. The local API
does not require Firecrawl authentication, and retaining the paid cloud key
would create needless credential exposure and an ambiguous fallback path.

Use each client's supported MCP management interface where possible instead
of hand-editing secret-bearing configuration files. Claude Code keeps the
registration in user scope so it applies to all projects. Codex keeps the
registration in its global user configuration. New client sessions are
required to load the changed MCP process environment.

## Lifecycle Command

Add a checked-in executable command under this repository's `scripts/`
directory. It resolves the repository path from its own location and always
passes both the absolute Compose file and project directory, so it behaves the
same from any working directory.

Supported subcommands:

- `start`: run `docker compose up -d --wait` for the existing project.
- `restart`: run `docker compose stop`, followed by
  `docker compose up -d --wait`.
- `status`: show scoped Compose service state.
- `health`: validate the Compose model, service health, and local API health.
- `logs`: show a bounded tail of scoped Firecrawl project logs.

The command does not expose `down`, volume removal, image pruning, or any
broad Docker cleanup operation. It does not use `docker compose restart`,
because that path previously raced RabbitMQ readiness. The ordered stop and
health-waiting start sequence is the supported recovery path.

## Shared Agent Guidance

Claude Code's global instruction file and Codex's global `AGENTS.md` resolve
to the same underlying file. Add one concise operational section there so
both clients receive identical guidance.

When a Firecrawl MCP operation fails because the local service is unavailable,
an agent should:

1. Run the lifecycle command's `health` or `status` subcommand.
2. Run `start` when the project is stopped, then retry the MCP operation once.
3. Inspect bounded project logs when services are unhealthy.
4. Run the ordered `restart` only when startup or health recovery requires it,
   then retry once.
5. Surface the remaining failure instead of looping or performing destructive
   Docker operations.

The guidance also records the self-hosted feature boundary. Agents may use the
MCP tools for open-source scrape, crawl, map, and search operations. Batch
operations are supported through direct calls to the local Firecrawl API, not
through a batch MCP tool. They must not assume hosted Agent, Browser sandbox,
Actions, managed proxy, or AI extraction features are available unless those
dependencies are configured separately.

## Error Handling

The lifecycle command exits nonzero for an unknown subcommand, invalid Compose
configuration, unavailable Docker daemon, failed health wait, unhealthy
service, or failed API health request. Errors remain visible to the invoking
agent. Expected command failures are not converted into success.

All Compose operations remain scoped to `/home/mamba/work/firecrawl`. The
command never acts on unrelated containers or volumes. Logs are bounded to
avoid flooding an agent session.

## Verification and Acceptance

No new automated test code is required. Acceptance requires:

1. The lifecycle command passes shell syntax validation and reports useful
   usage for invalid input.
2. `status`, `health`, `start`, and ordered `restart` work from outside the
   repository directory.
3. All normal-profile Compose services return healthy after recovery.
4. Claude Code reports the user-scoped Firecrawl MCP connected with only the
   local API URL environment.
5. Codex reports the global Firecrawl MCP with the pinned package and only the
   local API URL environment.
6. Neither effective configuration retains the paid cloud API key.
7. A fresh MCP process lists Firecrawl tools and completes a real scrape
   through `http://127.0.0.1:3002`.
8. Existing named volumes remain present across the restart verification.

## Rollback

If the local integration must be reverted, remove the Firecrawl MCP
registration from each client or replace it with another explicitly supplied
endpoint. Do not restore the paid cloud credential from repository files: it
is never copied into the repository, lifecycle command, documentation, or
shared instructions.

Removing the lifecycle command and shared instruction section has no effect
on the Docker volumes or the underlying local Firecrawl deployment.
