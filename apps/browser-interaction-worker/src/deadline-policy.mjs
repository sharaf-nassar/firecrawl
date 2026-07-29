export const FINALIZATION_RESERVE_DIVISOR = 2;
export const MIN_FINALIZATION_RESERVE_MS = 15_000;
export const MAX_FINALIZATION_RESERVE_MS = 30_000;
export const MIN_FINAL_DECISION_TIME_MS = 5_000;
// ActiveRun allows 2 seconds for SIGTERM-to-SIGKILL escalation. The final
// second is reserved for child close delivery, run-home cleanup, and response.
export const FINAL_ONLY_HANDOFF_MARGIN_MS = 3_000;

function assertTimestamp(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function finalizationReserveMs(startedAtMs, deadlineMs) {
  assertTimestamp("startedAtMs", startedAtMs);
  assertTimestamp("deadlineMs", deadlineMs);
  if (deadlineMs <= startedAtMs) {
    throw new RangeError("deadlineMs must follow startedAtMs");
  }
  return Math.min(
    MAX_FINALIZATION_RESERVE_MS,
    Math.max(
      MIN_FINALIZATION_RESERVE_MS,
      Math.floor((deadlineMs - startedAtMs) / FINALIZATION_RESERVE_DIVISOR),
    ),
  );
}

export function planDecisionTiming(
  { startedAtMs, deadlineMs, actionBudgetExhausted },
  nowMs = Date.now(),
) {
  assertTimestamp("nowMs", nowMs);
  const reserveMs = finalizationReserveMs(startedAtMs, deadlineMs);
  const remainingMs = deadlineMs - nowMs;
  const mode =
    remainingMs <= MIN_FINAL_DECISION_TIME_MS
      ? "timed_out"
      : actionBudgetExhausted || remainingMs <= reserveMs
        ? "final_only"
        : "action_or_final";
  return Object.freeze({ mode, remainingMs, reserveMs });
}

export function boundedDecisionDeadlineMs(
  absoluteDeadlineMs,
  configuredTimeoutMs,
  nowMs = Date.now(),
) {
  assertTimestamp("absoluteDeadlineMs", absoluteDeadlineMs);
  assertTimestamp("configuredTimeoutMs", configuredTimeoutMs);
  assertTimestamp("nowMs", nowMs);
  return Math.min(absoluteDeadlineMs, nowMs + configuredTimeoutMs);
}

export function decisionChildDeadlineMs(
  absoluteDeadlineMs,
  configuredTimeoutMs,
  finalOnly,
  nowMs = Date.now(),
) {
  if (typeof finalOnly !== "boolean") {
    throw new TypeError("finalOnly must be a boolean");
  }
  const childAbsoluteDeadlineMs = finalOnly
    ? absoluteDeadlineMs - FINAL_ONLY_HANDOFF_MARGIN_MS
    : absoluteDeadlineMs;
  return boundedDecisionDeadlineMs(
    childAbsoluteDeadlineMs,
    configuredTimeoutMs,
    nowMs,
  );
}
