# Firecrawl (local fork) — repo guide for agents

Fork of the Firecrawl web-data API/worker monorepo whose supported runtime
here is the hardened Docker Compose local stack. Polyglot `apps/` tree
(TS/Node API + browser services, Rust/Go/Python/etc SDKs) with NO root
workspace — each app/SDK is a package island with its own lockfile and
commands.

## Ground rules

- Task tracking is Beads: `bd ready`, `bd show <id>`, `bd close <id>`;
  `bd prime` when context is stale.
- Architecture/operations/testing intent in `lat.md/`; search before
  coding, update after changes, `lat check` before done (CI pins
  `lat.md@0.11.0`). Feature specs in `specs/`; dated design docs in
  `docs/superpowers/`.
- Lifecycle is WRAPPER-ONLY: use `scripts/local-firecrawl <start|stop|
  restart|status|health|logs|probe-egress|shim-start|...>` — direct
  `docker compose` bypasses lock/ordering/provenance/health invariants.
  NEVER `docker compose down --volumes`; named volumes are durable state.
- DB migrations are immutable once applied: add a lexically later file
  under `apps/api/src/db/migrations`, never edit an applied one.

## Build, test, gates

CI (PRs/main) runs: shellcheck + `bash -n` on the lifecycle scripts;
compose config render; `node --test` suites for the wrapper, MCP launcher,
browser-interaction-worker, codex-shim, and migration packaging; focused
API vitest (`pnpm exec vitest run --no-file-parallelism src/search/...
src/controllers/*/search*.test.ts`) + `pnpm run build` + Docker image
builds; playwright-service build+test; test-site build; `lat check`.

Local per-package (run inside the package dir):

```bash
cd apps/api && pnpm install --frozen-lockfile && pnpm run build   # tsc + package migrations
cd apps/api && pnpm test        # full suite needs local services; CI runs only the focused subset
```

API Husky pre-commit runs `pnpm knip --cache && pnpm lint-staged` from
`apps/api`. Integration tests skip without `TEST_APPLICATION_DATABASE_URL`
/ `TEST_REDIS_URL` / MinIO env.

## Dev run

- Fresh start: `./scripts/init-local-env.sh && scripts/local-firecrawl
  start && scripts/local-firecrawl health`. Only `http://127.0.0.1:3002`
  is host-published.
- `start`/`restart`/`health` require a host `codex` from `@openai/codex`
  with authenticated `~/.codex/auth.json` (unpinned — restart the stack
  after Codex upgrades).
- MCP: `FIRECRAWL_API_URL=http://127.0.0.1:3002`, no API key, launch
  `scripts/local-firecrawl-mcp`. Optional extract: `shim-start` then
  `OPENAI_BASE_URL=http://host.docker.internal:3030/v1`.
- Exclude `.worktrees/` when searching — it holds nested checkouts.
- `CONTRIBUTING.md`/`SELF_HOST.md` describe upstream/manual setups; for
  this checkout `LOCAL_DEPLOYMENT.md` + the wrapper are authoritative.
