# Browser Interaction Worker

Browser Interaction Worker turns bounded browser observations into one validated action or final answer by running a tightly constrained Codex child process.

It is an internal decision service, not a browser. The API owns the action loop and supplies observation history; the worker performs one model decision per request and cannot directly reach Browser Service.

## Unix socket boundary

The worker serves HTTP over `/run/firecrawl-interaction/worker.sock`, shared read-only into the API container.

`createWorkerServer` in `apps/browser-interaction-worker/src/server.mjs` exposes `GET /health/live`, `GET /health/ready`, authenticated `POST /v1/decisions`, and authenticated `DELETE /v1/runs/:runId`.

The socket directory and socket must be canonical, nonsymlinked, owned by the worker UID/GID, and mode `0770`/`0660`. Startup removes only a verified stale socket; shutdown removes only the exact device/inode it created.

Decision bodies are JSON, capped at 24 MiB, and protected by a constant-time bearer token comparison. Client disconnect cancels the run and waits for confirmed process termination and scratch cleanup.

## Decision protocol

A request carries the whole browser-run context needed for one turn without granting model-side tools.

`validateDecisionRequest` in `apps/browser-interaction-worker/src/protocol.mjs` validates run ID, user prompt, turn, complete action history, current observation, optional PNG screenshot, start time, and one whole-run deadline of at most five minutes.

History length must equal turn number. Each observation must match its preceding action and sequence; the current observation must equal the last history entry. JSON depth, node count, observation bytes, aggregate history, image bytes, and PNG structure are bounded.

The response is exactly one closed JSON envelope:

- `action` selects navigate, click, hover, hover-batch, type, wait, extract, or screenshot;
- `final` returns up to 262,144 characters of plain text.

Turn 25 and final-only deadline mode accept only `final`. `parseAndNormalizeModelEnvelopeForTurn` normalizes and revalidates model output against the turn-specific schema.

## Codex execution sandbox

Each decision runs an ephemeral Codex process in a fresh private directory with no persistent conversation history.

`createCodexRunner` in `apps/browser-interaction-worker/src/codex-runner.mjs` writes a closed config, output schema, hooks, optional screenshot, and copied authentication state into the run directory. It invokes Codex with JSON events and structured output, then deletes all run files.

The child uses read-only sandbox mode, approval policy `never`, disabled web search, disabled apps, disabled agents, and an empty MCP server table. A `PreToolUse` hook denies every tool call.

The parent also parses Codex JSONL and rejects tool, command, file-change, MCP, browser, collaboration, or approval-shaped events. Only bounded message/reasoning items are accepted, so hook bypass or protocol drift fails the decision.

Run homes live on a noexec tmpfs outside the OS temporary directory. This keeps runs ephemeral while allowing current Codex releases to establish their guarded `CODEX_HOME` aliases.

## Model provider inheritance

Local startup inherits only the host Codex model and selected provider routing, preserving user choice without importing the rest of the host configuration.

`scripts/prepare-codex-worker-config.py` reads an owned, mode-0600 host `config.toml` and writes bounded mode-0600 snapshots containing `model`, `model_provider`, and the selected provider table. Required provider credentials and present nonempty optional header values enter a separate environment snapshot.

Supported retry and timeout scalars preserve their validated unsigned values, including WebSocket connection timeout. Unsupported provider fields fail startup before Docker mutation.

After atomic snapshot refresh, start and restart force-recreate only the worker and egress proxy so their bind mounts resolve the new inodes. Failed startup and stop remove all snapshots; the next start regenerates them.

The runner combines that snapshot with its worker-owned approval, sandbox, history, feature, agent, MCP, and hook policy. Host project config, profiles, MCP servers, apps, agents, rules, hooks, history, and arbitrary environment variables never enter the child.

## Prompt trust model

Page observations are explicitly treated as untrusted data and never as model authority.

`buildPrompt` in `apps/browser-interaction-worker/src/codex-runner.mjs` supplies the allowed action vocabulary, action budget, task, history, current observation, optional image context, and instructions to prefer bounded extraction.

The model may describe a desired browser action but cannot execute it. The API validates the returned action again before Browser Service executes it, preserving separation between model reasoning and browser authority.

## Deadline policy

One whole-run deadline governs every decision, including final synthesis and cleanup.

The worker reserves 15–30 seconds, scaled to half the total budget, for finalization. When the reserve begins or the action budget is exhausted, the child receives a final-only schema and prompt.

Each Codex child deadline is also capped by the configured 5–300 second per-decision timeout. Cancellation sends signals to the detached process group, waits through a short grace period, and escalates termination when needed.

If final-only synthesis times out, `buildTimeoutFallbackDecision` returns bounded, validated extract/hover evidence and page state with an explicit unsynthesized-data notice. Earlier-turn timeouts remain failures.

## Capacity and cancellation

Run identity and capacity are enforced before child setup.

The worker allows a configured 1–32 concurrent runs, default four. Duplicate active run IDs return conflict; excess work returns capacity without queuing unbounded state.

Cancellation establishes a five-minute tombstone before looking up the active process. This closes the race where a cancel request arrives just before execution starts. Tombstones themselves are bounded.

## Authentication state

Host Codex authentication is copied into isolated runs and refreshed without mounting a writable host credential file.

Startup accepts only a bounded regular seed file. A worker-owned persistent volume keeps `auth.json` plus the SHA-256 digest of the host seed; seed changes replace worker state atomically.

Each run snapshots authentication under a mutex. Refreshed credentials merge back only when the host seed still matches and the run is demonstrably newer, preventing concurrent children from overwriting newer auth.

## Startup readiness canary

Readiness requires a real Codex invocation plus proof that the hook configuration executed.

After config and socket preflight, the runner executes a final-only canary with a fixed marker. A prompt-submit hook writes a bounded audit record; output, hook count, token binding, and marker must all match.

The worker never becomes ready after canary timeout, Codex failure, action output, malformed output, or missing/mismatched hook audit. Startup logs expose bounded categories and sanitized diagnostics.

## Egress split

The worker container has `network_mode: none`; a separate proxy container is its only model-network path.

Inside the worker, `createLoopbackProxyRelay` listens on fixed loopback port `3128` and relays raw connections to a shared Unix socket. All uppercase and lowercase proxy variables must point to this loopback endpoint, with empty `NO_PROXY`.

The separate proxy owns the `model-uplink` network and `createEgressProxy` accepts CONNECT only for the built-in allowlist plus the exact selected HTTPS provider hostname on port 443.

DNS answers must all be global addresses. The proxy connects only to validated answers and requires TLS ClientHello SNI to exactly match CONNECT authority before forwarding. Hostname normalization, DNS rebinding, private ranges, IP literals, arbitrary plaintext HTTP, and SNI mismatch fail closed.

A host-loopback HTTP provider is rewritten to the fixed Docker host alias and exact configured port. Rendered Compose must map only that alias to Docker's host gateway. Only that derived origin accepts HTTP proxy requests; other plaintext destinations remain denied.

`createEgressProxy` in `apps/browser-interaction-worker/src/egress-proxy.mjs` emits structured allow or deny outcomes. Allowed events include only the validated model hostname; denied events use bounded policy categories rather than request content.

## Container hardening

Deployment treats the model worker and its uplink as different trust zones.

Both containers run UID/GID 1000, read-only roots, dropped capabilities, no-new-privileges, PID/memory/CPU limits, and small noexec tmpfs mounts. The worker adds only derived provider config/environment snapshots to the prior package, auth, CA, state, and socket mounts.

The API sees the interaction socket but not the worker auth or egress socket. The proxy sees the egress socket and uplink network but not the interaction socket or Codex state.

## Operational signals

Operational output is intentionally narrow and structured.

Worker startup emits readiness or one bounded failure category, including canary-specific failures. The egress proxy reports readiness plus allow or deny outcomes, while health separates process liveness from canary-backed readiness.

The worker exposes no metrics endpoint and does not log decision bodies, prompts, observations, screenshots, or model output. Capacity and decision failures are visible to the API through HTTP categories rather than a worker-side request log.

## Failure categories

Worker errors preserve whether failure came from caller input, capacity, cancellation, timeout, model failure, or protocol enforcement.

Invalid input maps to 400/413, conflicts and cancellation to 409, capacity to 429 or 503, timeouts to 504, and Codex/protocol failures to 502. Unknown internal errors remain 500 and never include secrets or page payloads.
