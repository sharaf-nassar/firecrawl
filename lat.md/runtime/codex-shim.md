# Codex Shim

The host-side Codex Shim adapts OpenAI chat-completion requests to ephemeral Codex CLI executions without exposing host authentication material.

## Completion translation

Each completion flattens role-tagged messages into a Codex prompt and returns the final agent-message JSON event in an OpenAI-compatible single-choice response.

`createCodexTranslator` in `apps/codex-shim/src/translate.mjs` runs `codex exec --ephemeral --json` with the requested model and reasoning effort. JSON-schema response formats use a per-call schema file that is removed after execution.

Codex process failures and malformed event streams become generic OpenAI-style errors. Child stderr, request authorization, and host authentication paths are never included in responses.

## Model tiers and readiness

The shim maps caller-facing model names to two configurable Codex tiers and reports healthy only when the active Codex package and auth file pass host-runtime safety checks.

Incoming model names containing `mini` or `nano` use `gpt-5.6-luna` with low reasoning effort. All other names use `gpt-5.6-terra` with medium effort. `CODEX_SHIM_SMALL_MODEL` and `CODEX_SHIM_MAIN_MODEL` override the model ids without changing tier effort.

Readiness resolves exactly one `@openai/codex` package entrypoint and requires `~/.codex/auth.json` to be a singly linked regular file owned by the current user with mode `0400` or `0600`. Failure details and authentication contents stay private.

## HTTP and capacity boundary

The HTTP boundary serves chat completions, model discovery, and readiness, rejects embeddings, implements no Responses API, and limits concurrent Codex children with a FIFO queue.

`createCodexShimServer` in `apps/codex-shim/src/server.mjs` binds to `0.0.0.0:3030` by default. `CODEX_SHIM_HOST`, `CODEX_SHIM_PORT`, and `CODEX_SHIM_MAX_CONCURRENCY` override the defaults; concurrency defaults to two.

`GET /v1/models` lists both configured tiers. `GET /health` returns the backend, tier mapping, and concurrency only while runtime checks pass; unavailable responses disclose no host path or authentication content.

API deployments targeting the shim enable `OPENAI_CHAT_COMPLETIONS_ONLY` so [[apps/api/src/lib/generic-ai.ts#getModel]] selects its supported chat endpoint. Both current and `fire-0` extraction share this provider path; extraction does not request embeddings.

Fresh local environments leave extract disabled while preselecting chat-only mode and `gpt-5.6-luna`. Operators explicitly start the shim, then set its base URL and a nonsecret API-key placeholder.

## Host lifecycle

The local wrapper owns explicit shim startup, verified shutdown, bounded logs, and extract-capability reporting while keeping Compose unaware of host Codex credentials.

Startup reuses the wrapper's Codex runtime preflight and requires `/health` after spawn. The private control PID is accepted for termination only when `/proc` proves the process belongs to the user and runs this shim server.

Runtime stop always terminates a managed shim; restart restores it only when previously running. Start never enables it, and crashes are not auto-restarted. This keeps opt-in behavior visible and prevents an orphan listener during stack teardown.
