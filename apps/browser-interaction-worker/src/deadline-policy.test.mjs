import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedDecisionDeadlineMs,
  decisionChildDeadlineMs,
  FINAL_ONLY_HANDOFF_MARGIN_MS,
  MAX_FINALIZATION_RESERVE_MS,
  MIN_FINAL_DECISION_TIME_MS,
  planDecisionTiming,
} from "./deadline-policy.mjs";
import {
  finalModelDecisionEnvelopeSchema,
  modelDecisionEnvelopeSchema,
  modelDecisionEnvelopeSchemaForTurn,
} from "./protocol.mjs";

test("60-second run reserves its final 30 seconds for output", () => {
  const input = {
    startedAtMs: 1_000_000,
    deadlineMs: 1_060_000,
    actionBudgetExhausted: false,
  };

  assert.deepEqual(planDecisionTiming(input, 1_029_999), {
    mode: "action_or_final",
    remainingMs: 30_001,
    reserveMs: MAX_FINALIZATION_RESERVE_MS,
  });
  assert.deepEqual(planDecisionTiming(input, 1_030_000), {
    mode: "final_only",
    remainingMs: 30_000,
    reserveMs: MAX_FINALIZATION_RESERVE_MS,
  });
});

test("observed 60-second timeline offers only final output at decision four", () => {
  const input = {
    startedAtMs: 5_000_000,
    deadlineMs: 5_060_000,
    actionBudgetExhausted: false,
  };
  const decisionTimesMs = [0, 19_000, 25_000, 38_000];

  for (const [turn, elapsedMs] of decisionTimesMs.entries()) {
    const timing = planDecisionTiming(input, input.startedAtMs + elapsedMs);
    const schema = modelDecisionEnvelopeSchemaForTurn(
      turn,
      timing.mode === "final_only",
    );
    assert.equal(
      schema,
      turn < 3
        ? modelDecisionEnvelopeSchema
        : finalModelDecisionEnvelopeSchema,
    );
  }
});

test("300-second run retains all 25 action-capable turns before reserve", () => {
  for (let turn = 0; turn < 25; turn += 1) {
    assert.deepEqual(
      planDecisionTiming(
        {
          startedAtMs: 2_000_000,
          deadlineMs: 2_300_000,
          actionBudgetExhausted: turn >= 25,
        },
        2_269_999,
      ),
      {
        mode: "action_or_final",
        remainingMs: 30_001,
        reserveMs: MAX_FINALIZATION_RESERVE_MS,
      },
    );
  }
  assert.equal(
    planDecisionTiming(
      {
        startedAtMs: 2_000_000,
        deadlineMs: 2_300_000,
        actionBudgetExhausted: false,
      },
      2_270_000,
    ).mode,
    "final_only",
  );
});

test("exhausted action budget stays final-only with ample time", () => {
  assert.equal(
    planDecisionTiming(
      {
        startedAtMs: 3_000_000,
        deadlineMs: 3_300_000,
        actionBudgetExhausted: true,
      },
      3_001_000,
    ).mode,
    "final_only",
  );
});

test("hard deadline wins when too little final-turn time remains", () => {
  const input = {
    startedAtMs: 4_000_000,
    deadlineMs: 4_060_000,
    actionBudgetExhausted: true,
  };

  assert.deepEqual(
    planDecisionTiming(input, input.deadlineMs - MIN_FINAL_DECISION_TIME_MS),
    {
      mode: "timed_out",
      remainingMs: MIN_FINAL_DECISION_TIME_MS,
      reserveMs: MAX_FINALIZATION_RESERVE_MS,
    },
  );
  assert.equal(
    planDecisionTiming(
      input,
      input.deadlineMs - MIN_FINAL_DECISION_TIME_MS + 1,
    ).mode,
    "timed_out",
  );
  assert.equal(
    planDecisionTiming(input, input.deadlineMs + 1).mode,
    "timed_out",
  );
  assert.equal(
    boundedDecisionDeadlineMs(input.deadlineMs, 120_000, 4_050_000),
    input.deadlineMs,
  );
  assert.equal(
    boundedDecisionDeadlineMs(input.deadlineMs, 3_000, 4_050_000),
    4_053_000,
  );
});

test("final-only child deadline reserves a fixed return and cleanup margin", () => {
  const nowMs = 6_030_000;
  const absoluteDeadlineMs = 6_060_000;

  assert.equal(
    decisionChildDeadlineMs(
      absoluteDeadlineMs,
      120_000,
      true,
      nowMs,
    ),
    absoluteDeadlineMs - FINAL_ONLY_HANDOFF_MARGIN_MS,
  );
  assert.equal(
    decisionChildDeadlineMs(
      absoluteDeadlineMs,
      120_000,
      false,
      nowMs,
    ),
    absoluteDeadlineMs,
  );
  assert.equal(
    decisionChildDeadlineMs(absoluteDeadlineMs, 2_000, true, nowMs),
    nowMs + 2_000,
  );
});

test("five-second final policy leaves time for bounded fallback handoff", () => {
  const input = {
    startedAtMs: 7_000_000,
    deadlineMs: 7_060_000,
    actionBudgetExhausted: false,
  };

  assert.equal(
    planDecisionTiming(
      input,
      input.deadlineMs - MIN_FINAL_DECISION_TIME_MS,
    ).mode,
    "timed_out",
  );
  assert.equal(
    input.deadlineMs -
      decisionChildDeadlineMs(
        input.deadlineMs,
        120_000,
        true,
        input.deadlineMs - MIN_FINAL_DECISION_TIME_MS - 1,
      ),
    FINAL_ONLY_HANDOFF_MARGIN_MS,
  );
});
