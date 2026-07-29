import process from "node:process";

import { createCodexRunner } from "./codex-runner.mjs";
import { preflightConfig, readConfig } from "./config.mjs";
import { schemaIsStable } from "./protocol.mjs";
import { createLoopbackProxyRelay } from "./proxy-relay.mjs";
import { createWorkerServer } from "./server.mjs";

const STARTUP_FAILURE_CATEGORIES = new Set([
  "startup_canary_timeout",
  "startup_canary_codex_failed",
  "startup_canary_failed",
  "startup_canary_action",
  "startup_canary_output",
  "startup_canary_hook_audit_missing",
  "startup_canary_hook_audit_count",
  "startup_canary_hook_audit_invalid",
  "startup_canary_hook_audit_mismatch",
]);

function startupFailureCategory(cause) {
  return STARTUP_FAILURE_CATEGORIES.has(cause?.category)
    ? cause.category
    : "startup_preflight_failed";
}

async function main() {
  const config = readConfig();
  await preflightConfig(config);
  if (!schemaIsStable()) throw new Error("decision schema is not JSON-stable");

  const runner = createCodexRunner(config);
  const server = createWorkerServer(config, runner);
  const relay = createLoopbackProxyRelay(config);
  await relay.listen();
  try {
    await server.listen();
  } catch (cause) {
    await relay.close();
    throw cause;
  }
  try {
    await runner.initialize();
    await runner.runStartupCanary();
  } catch (cause) {
    const category = startupFailureCategory(cause);
    server.markReadinessFailure(category);
    await Promise.allSettled([server.close(), relay.close()]);
    throw Object.assign(new Error("worker startup failed"), {
      category,
      diagnostic: cause?.diagnostic,
    });
  }
  server.markReady();
  process.stdout.write(
    `${JSON.stringify({
      event: "browser_interaction_worker_ready",
      socketPath: config.socketPath,
    })}\n`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const results = await Promise.allSettled([server.close(), relay.close()]);
    process.exitCode = results.every(result => result.status === "fulfilled")
      ? 0
      : 1;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((cause) => {
  const diagnostic =
    typeof cause?.diagnostic === "string" && cause.diagnostic !== ""
      ? cause.diagnostic
      : undefined;
  process.stderr.write(
    `${JSON.stringify({
      event: "browser_interaction_worker_startup_failed",
      category: startupFailureCategory(cause),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    })}\n`,
  );
  process.exitCode = 1;
});
