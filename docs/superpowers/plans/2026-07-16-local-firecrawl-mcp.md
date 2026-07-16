# Local Firecrawl MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Claude Code and Codex Firecrawl MCP traffic to the local API and give both agents a safe on-demand recovery command.

**Architecture:** A repository-owned Bash command wraps only scoped Docker Compose lifecycle and diagnostic operations. Both user-level MCP registrations run a pinned official package with `FIRECRAWL_API_URL`, while one shared global instruction section defines bounded recovery behavior for Claude Code and Codex.

**Tech Stack:** Bash, Docker Compose, Firecrawl API v2, `firecrawl-mcp@3.22.3`, Claude Code MCP CLI, Codex MCP CLI

---

## File Structure

- Create `scripts/local-firecrawl`: single interface for start, ordered restart,
  status, health, and bounded logs.
- Modify `LOCAL_DEPLOYMENT.md`: document the agent-facing lifecycle command and
  its safety boundary.
- Modify `/home/mamba/.claude/CLAUDE.md`: shared global Firecrawl recovery
  instructions; `/home/mamba/.codex/AGENTS.md` resolves to this file.
- Update `/home/mamba/.claude.json` through `claude mcp`: replace only the
  user-scoped Firecrawl registration.
- Update `/home/mamba/.codex/config.toml` through `codex mcp`: replace only the
  global Firecrawl registration.

No automated test files are added because repository instructions prohibit
test code unless explicitly requested. Each task uses executable syntax,
configuration, health, and end-to-end checks instead.

### Task 1: Add the scoped lifecycle command

**Files:**
- Create: `scripts/local-firecrawl`
- Modify: `LOCAL_DEPLOYMENT.md`

- [ ] **Step 1: Confirm the command does not already exist**

Run:

```bash
test ! -e scripts/local-firecrawl
```

Expected: exit 0 with no output.

- [ ] **Step 2: Create the lifecycle command**

Create `scripts/local-firecrawl` with this complete content:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/compose.yaml"
compose=(
  docker compose
  --project-directory "${repo_root}"
  -f "${compose_file}"
)
services=(api playwright-service nuq-postgres redis rabbitmq)

usage() {
  printf 'Usage: %s {start|restart|status|health|logs}\n' "$0" >&2
}

validate_compose() {
  "${compose[@]}" config --quiet
}

check_health() {
  validate_compose
  "${compose[@]}" exec -T redis redis-cli ping | grep -qx PONG
  "${compose[@]}" exec -T rabbitmq rabbitmq-diagnostics -q check_running
  "${compose[@]}" exec -T nuq-postgres sh -ec \
    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  "${compose[@]}" exec -T playwright-service node -e \
    "fetch('http://127.0.0.1:3000/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:3002/ >/dev/null
  printf 'Local Firecrawl is healthy at http://127.0.0.1:3002\n'
}

case "${1:-}" in
  start)
    validate_compose
    "${compose[@]}" up -d --wait
    ;;
  restart)
    validate_compose
    "${compose[@]}" stop
    "${compose[@]}" up -d --wait
    ;;
  status)
    validate_compose
    "${compose[@]}" ps --all
    ;;
  health)
    check_health
    ;;
  logs)
    validate_compose
    "${compose[@]}" logs --tail=200 "${services[@]}"
    ;;
  *)
    usage
    exit 64
    ;;
esac
```

- [ ] **Step 3: Make the command executable**

Run:

```bash
chmod 755 scripts/local-firecrawl
```

Expected: `stat -c '%a' scripts/local-firecrawl` prints `755`.

- [ ] **Step 4: Validate syntax and invalid-input behavior**

Run:

```bash
bash -n scripts/local-firecrawl
```

Expected: exit 0 with no output.

Run:

```bash
scripts/local-firecrawl unsupported
```

Expected: exit 64 and
`Usage: scripts/local-firecrawl {start|restart|status|health|logs}`.

- [ ] **Step 5: Verify path-independent status and health**

Run from `/tmp`:

```bash
/home/mamba/work/firecrawl/scripts/local-firecrawl status
/home/mamba/work/firecrawl/scripts/local-firecrawl health
```

Expected: five normal-profile services are running and the final line is
`Local Firecrawl is healthy at http://127.0.0.1:3002`.

- [ ] **Step 6: Document the command**

Add this subsection immediately under `## Routine operation` in
`LOCAL_DEPLOYMENT.md`:

````markdown
Claude Code and Codex use this path-independent wrapper for on-demand recovery:

```bash
scripts/local-firecrawl status
scripts/local-firecrawl health
scripts/local-firecrawl start
scripts/local-firecrawl restart
scripts/local-firecrawl logs
```

`restart` performs an ordered `docker compose stop` followed by
`docker compose up -d --wait`. The wrapper intentionally provides no volume
deletion, project teardown, or broad Docker cleanup command.
````

- [ ] **Step 7: Review and commit repository changes**

Run:

```bash
git diff --check
git diff -- scripts/local-firecrawl LOCAL_DEPLOYMENT.md
```

Expected: no whitespace errors; diff contains only the wrapper and its
operator documentation.

Confirm this repository has no configured hook path or executable default
pre-commit entrypoint:

```bash
git config --get core.hooksPath
test ! -x .git/hooks/pre-commit
```

Expected: the first command prints no path and the second exits 0. Then stage
only these files and create a conventional commit whose body explains recovery
behavior:

```bash
git add scripts/local-firecrawl LOCAL_DEPLOYMENT.md
git commit -m "feat: add local Firecrawl recovery command" -m "Add a path-independent wrapper for scoped Firecrawl status, health,
startup, ordered restart, and bounded log operations.

Document the agent recovery interface and keep destructive Docker and
volume operations outside its supported surface."
```

Expected: commit succeeds on the first attempt.

### Task 2: Add shared Claude Code and Codex recovery guidance

**Files:**
- Modify: `/home/mamba/.claude/CLAUDE.md`
- Verify symlink: `/home/mamba/.codex/AGENTS.md`

- [ ] **Step 1: Confirm both clients share the same instruction file**

Run:

```bash
readlink -f /home/mamba/.claude/CLAUDE.md
readlink -f /home/mamba/.codex/AGENTS.md
```

Expected: both commands print `/home/mamba/.claude/CLAUDE.md`.

- [ ] **Step 2: Add the shared operational section**

Append this exact section to `/home/mamba/.claude/CLAUDE.md` without modifying
existing instructions:

```markdown
## Local Firecrawl MCP

- Firecrawl MCP uses the self-hosted API at `http://127.0.0.1:3002`.
- Recovery command: `/home/mamba/work/firecrawl/scripts/local-firecrawl`.
- On connection failure, run `health` or `status`. If stopped, run `start`,
  then retry the MCP operation once.
- If services remain unhealthy, inspect `logs`; use `restart` only when needed,
  then retry once. Surface any remaining failure instead of looping.
- Never run `docker compose restart`, delete Firecrawl volumes, or use broad
  Docker prune/cleanup commands for recovery.
- Supported self-hosted MCP tools: scrape, crawl, map, and search. Batch
  operations are supported through direct calls to the local Firecrawl API,
  not through a batch MCP tool. Hosted Agent, Browser sandbox, Actions,
  managed proxy, and AI extraction require separate services and must not be
  assumed available.
```

- [ ] **Step 3: Verify the section is visible through both paths**

Run:

```bash
rg -n -A14 '^## Local Firecrawl MCP$' /home/mamba/.claude/CLAUDE.md
rg -n -A14 '^## Local Firecrawl MCP$' /home/mamba/.codex/AGENTS.md
```

Expected: both outputs contain one identical section and the absolute recovery
command path.

This user-level instruction file is outside the repository and is not
committed.

### Task 3: Migrate both effective MCP registrations

**Files:**
- Update via CLI: `/home/mamba/.claude.json`
- Update via CLI: `/home/mamba/.codex/config.toml`

- [ ] **Step 1: Verify the installed CLIs support required flags**

Run:

```bash
claude mcp add --help
codex mcp add --help
```

Expected: Claude documents `--scope` and `--env`; Codex documents `--env` and
the `-- <COMMAND>...` stdio form. If either required flag is missing, stop
without changing registrations and report the installed client version.

- [ ] **Step 2: Preflight the pinned MCP package against the local URL**

Run:

```bash
env FIRECRAWL_API_URL=http://127.0.0.1:3002 timeout 5s \
  npx -y firecrawl-mcp@3.22.3
```

Expected: the MCP stdio server starts without demanding
`FIRECRAWL_API_KEY`; `timeout` may exit 124 because no MCP client is attached.

- [ ] **Step 3: Replace Claude Code's user-scoped registration**

Run as separate commands:

```bash
claude mcp remove --scope user firecrawl
claude mcp add firecrawl --scope user \
  --env FIRECRAWL_API_URL=http://127.0.0.1:3002 \
  -- npx -y firecrawl-mcp@3.22.3
```

Expected: removal and addition both succeed; unrelated MCP servers remain
unchanged.

- [ ] **Step 4: Replace Codex's global registration**

Run as separate commands:

```bash
codex mcp remove firecrawl
codex mcp add firecrawl \
  --env FIRECRAWL_API_URL=http://127.0.0.1:3002 \
  -- npx -y firecrawl-mcp@3.22.3
```

Expected: removal and addition both succeed; unrelated MCP servers and the
existing startup/tool timeouts can be restored in the next step.

- [ ] **Step 5: Restore Codex's Firecrawl timeouts**

After the CLI has removed the secret-bearing registration, add these exact
keys to the `[mcp_servers.firecrawl]` table in
`/home/mamba/.codex/config.toml` with `apply_patch`:

```toml
startup_timeout_sec = 30
tool_timeout_sec = 180
```

Expected: the Firecrawl table retains its previous startup and tool timeout
policy without restoring any cloud credential.

- [ ] **Step 6: Inspect the effective registrations**

Run:

```bash
claude mcp get firecrawl
codex mcp get firecrawl
```

Expected: both show `npx -y firecrawl-mcp@3.22.3` and
`FIRECRAWL_API_URL=http://127.0.0.1:3002`; Codex also shows startup timeout 30
and tool timeout 180.

- [ ] **Step 7: Confirm the cloud key setting was removed without printing it**

Run:

```bash
if rg -q 'FIRECRAWL_API_KEY' /home/mamba/.claude.json /home/mamba/.codex/config.toml; then
  printf 'Cloud Firecrawl key setting still exists\n' >&2
  exit 1
fi
```

Expected: exit 0 with no output. Never print or copy the previous key value.

These user-level configuration files are outside the repository and are not
committed.

### Task 4: Verify recovery and real MCP traffic

**Files:**
- Verify: `scripts/local-firecrawl`
- Verify: `/home/mamba/.claude.json`
- Verify: `/home/mamba/.codex/config.toml`

- [ ] **Step 1: Record the project volume names before recovery**

Run:

```bash
docker volume ls --filter label=com.docker.compose.project=firecrawl \
  --format '{{.Name}}' | sort
```

Expected output includes:

```text
firecrawl_nuq-postgres-data
firecrawl_rabbitmq-data
firecrawl_redis-data
```

- [ ] **Step 2: Exercise the ordered restart from outside the repository**

Run from `/tmp`:

```bash
/home/mamba/work/firecrawl/scripts/local-firecrawl restart
/home/mamba/work/firecrawl/scripts/local-firecrawl health
```

Expected: restart waits for healthy services and health ends with
`Local Firecrawl is healthy at http://127.0.0.1:3002`.

- [ ] **Step 3: Confirm volumes survived recovery**

Run:

```bash
docker volume ls --filter label=com.docker.compose.project=firecrawl \
  --format '{{.Name}}' | sort
```

Expected: the same project volumes recorded in Step 1 remain present.

- [ ] **Step 4: Initialize a fresh MCP process and list its tools**

Run:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"local-verification","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | \
  env FIRECRAWL_API_URL=http://127.0.0.1:3002 \
  npx -y firecrawl-mcp@3.22.3
```

Expected: JSON-RPC responses for IDs 1 and 2; the tools response contains
`firecrawl_scrape`, `firecrawl_crawl`, `firecrawl_map`, and
`firecrawl_search`.

- [ ] **Step 5: Complete a real scrape through a fresh MCP process**

Run:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"local-verification","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"firecrawl_scrape","arguments":{"url":"https://example.com","formats":["markdown"]}}}' | \
  env FIRECRAWL_API_URL=http://127.0.0.1:3002 \
  npx -y firecrawl-mcp@3.22.3
```

Expected: response ID 2 has no JSON-RPC error, reports successful scrape
content, and includes the Example Domain page.

- [ ] **Step 6: Verify final state**

Run:

```bash
/home/mamba/work/firecrawl/scripts/local-firecrawl status
git status --short
```

Expected: all five normal-profile services are healthy and the repository is
clean. Existing Claude Code and Codex sessions still need restarting to spawn
the newly configured MCP process.
