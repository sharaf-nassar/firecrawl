# Codex Shim

The host-side Codex Shim adapts OpenAI chat-completion requests to ephemeral Codex CLI executions without exposing host authentication material.

## Completion translation

Each completion flattens role-tagged messages into a Codex prompt and returns the final agent-message JSON event in an OpenAI-compatible single-choice response.

`createCodexTranslator` in `apps/codex-shim/src/translate.mjs` runs `codex exec --ephemeral --json` with the requested model and reasoning effort. JSON-schema response formats use a per-call schema file that is removed after execution.

Codex process failures and malformed event streams become generic OpenAI-style errors. Child stderr, request authorization, and host authentication paths are never included in responses.

## HTTP and capacity boundary

The HTTP boundary accepts chat completions, rejects embeddings as unsupported, and limits concurrent Codex children with a FIFO queue.

`createCodexShimServer` in `apps/codex-shim/src/server.mjs` binds to `0.0.0.0:3030` by default. `CODEX_SHIM_HOST`, `CODEX_SHIM_PORT`, and `CODEX_SHIM_MAX_CONCURRENCY` override the defaults; concurrency defaults to two.
