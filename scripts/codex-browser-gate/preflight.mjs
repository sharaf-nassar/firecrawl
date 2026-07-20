import { gateError, MAX_RUNS } from "./gate-contract.mjs";

export function parseInvocation(args, checks = {}) {
  const selfTests = new Map([
    ["--action-store-self-test", checks.actionStore],
    ["--hardening-self-test", checks.hardening],
    ["--lifecycle-self-test", checks.lifecycle],
    ["--transport-self-test", checks.transport],
  ]);
  if (args.length === 1 && selfTests.has(args[0])) {
    return { selfTest: selfTests.get(args[0]) };
  }
  if (args.length === 0) return { runCount: 3 };
  if (
    args.length !== 2 ||
    args[0] !== "--runs" ||
    !/^[1-9]\d*$/.test(args[1])
  ) {
    throw gateError("codex_gate_arguments_invalid");
  }
  const runCount = Number(args[1]);
  if (!Number.isSafeInteger(runCount) || runCount > MAX_RUNS) {
    throw gateError("codex_gate_arguments_invalid");
  }
  return { runCount };
}

export async function runPreflight(checks = {}) {
  await checks.actionStore({ silent: true });
  await checks.hardening({ silent: true });
  await checks.transport({ silent: true });
  await checks.lifecycle({ silent: true });
}
