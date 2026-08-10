---
lat:
  require-code-mention: true
---

# Local Extract End-to-End

These opt-in tests verify local structured extraction against an assembled stack and the host Codex Shim.

## Completes through the Codex Shim

Raw extract polling returns schema-conformant data after at least three shim calls, preserves the placeholder API key, and leaves the extract DLQ unchanged.

## JSON scrape uses the shim

A JSON-format scrape of the deterministic host fixture returns schema-conformant data and reaches the shim chat-completions route.

## Survives a local restart

Structured extraction still completes after the wrapper restarts the local stack with its existing provider configuration.

## Fails when the shim dies in flight

Killing the shim during its first chat completion yields an actionable failed extract within the retry budget and does not park the job in the DLQ.

## Rejects extract while the shim is down

After the liveness cache expires, a raw extract request against a stopped shim returns an actionable HTTP 400 without enqueueing work.
