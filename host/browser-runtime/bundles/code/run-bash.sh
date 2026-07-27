#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 0 ]] || {
  printf '%s\n' invalid_runner_invocation >&2
  exit 1
}

relay_pid=
agent_pid=

cleanup() {
  local status=$?
  if [[ -n "${agent_pid}" ]]; then
    kill -TERM "${agent_pid}" 2>/dev/null || true
    wait "${agent_pid}" 2>/dev/null || true
  fi
  if [[ -n "${relay_pid}" ]]; then
    kill -TERM "${relay_pid}" 2>/dev/null || true
    wait "${relay_pid}" 2>/dev/null || true
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

/usr/local/bin/node /opt/firecrawl/bin/cdp-relay.mjs --serve &
relay_pid=$!

for _ in {1..1000}; do
  [[ -s /run/firecrawl-job/cdp-endpoint ]] && break
  kill -0 "${relay_pid}" 2>/dev/null || exit 1
  sleep 0.01
done
[[ -s /run/firecrawl-job/cdp-endpoint ]]

/opt/firecrawl/bin/agent-browser.py --server &
agent_pid=$!
for _ in {1..1000}; do
  [[ -S /run/firecrawl-job/agent-browser.sock ]] && break
  kill -0 "${agent_pid}" 2>/dev/null || exit 1
  sleep 0.01
done
[[ -S /run/firecrawl-job/agent-browser.sock ]]

/bin/bash --noprofile --norc
status=$?

kill -TERM "${agent_pid}"
wait "${agent_pid}"
agent_pid=
exit "${status}"
