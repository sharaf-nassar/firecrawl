import assert from "node:assert/strict";
import test from "node:test";

import {
  finalModelDecisionEnvelopeSchema,
  MAX_BROWSER_ACTIONS,
  modelDecisionEnvelopeSchema,
  modelDecisionEnvelopeSchemaForTurn,
  parseAndNormalizeModelEnvelopeForTurn,
  schemaIsStable,
  validateDecisionRequest,
} from "./protocol.mjs";

const finalEnvelope = JSON.stringify({
  decision: {
    version: 1,
    type: "final",
    output: "best available result",
  },
});

const actionEnvelope = JSON.stringify({
  decision: {
    version: 1,
    type: "action",
    action: {
      kind: "extract",
      ref: null,
    },
  },
});

test("decision schemas remain JSON-stable and turn 25 is final-only", () => {
  assert.equal(schemaIsStable(), true);
  assert.equal(
    modelDecisionEnvelopeSchemaForTurn(MAX_BROWSER_ACTIONS - 1),
    modelDecisionEnvelopeSchema,
  );
  assert.equal(
    modelDecisionEnvelopeSchemaForTurn(MAX_BROWSER_ACTIONS),
    finalModelDecisionEnvelopeSchema,
  );
  assert.equal(
    finalModelDecisionEnvelopeSchema.properties.decision.properties.type
      .enum[0],
    "final",
  );
  assert.equal(
    Object.hasOwn(
      finalModelDecisionEnvelopeSchema.properties.decision.properties,
      "action",
    ),
    false,
  );
});

test("turn 25 accepts and normalizes a final decision", () => {
  assert.deepEqual(
    parseAndNormalizeModelEnvelopeForTurn(finalEnvelope, MAX_BROWSER_ACTIONS),
    {
      decision: {
        version: 1,
        type: "final",
        output: "best available result",
      },
    },
  );
});

test("turn 25 rejects an attempted action before browser dispatch", () => {
  let browserDispatches = 0;
  const dispatchDecision = (raw, turn) => {
    const envelope = parseAndNormalizeModelEnvelopeForTurn(raw, turn);
    if (envelope.decision.type === "action") browserDispatches += 1;
  };

  assert.throws(
    () => dispatchDecision(actionEnvelope, MAX_BROWSER_ACTIONS),
    (error) =>
      error?.category === "codex_protocol_error" &&
      error?.diagnostic === "action_budget_exhausted",
  );
  assert.equal(browserDispatches, 0);
});

test("turn 24 remains action-capable", () => {
  assert.deepEqual(
    parseAndNormalizeModelEnvelopeForTurn(
      actionEnvelope,
      MAX_BROWSER_ACTIONS - 1,
    ),
    {
      decision: {
        version: 1,
        type: "action",
        action: {
          kind: "extract",
        },
      },
    },
  );
});

test("deadline final-only mode rejects an action before turn 25", () => {
  assert.equal(
    modelDecisionEnvelopeSchemaForTurn(7, true),
    finalModelDecisionEnvelopeSchema,
  );
  assert.throws(
    () => parseAndNormalizeModelEnvelopeForTurn(actionEnvelope, 7, true),
    (error) =>
      error?.category === "codex_protocol_error" &&
      error?.diagnostic === "final_decision_required",
  );
  assert.deepEqual(
    parseAndNormalizeModelEnvelopeForTurn(finalEnvelope, 7, true),
    {
      decision: {
        version: 1,
        type: "final",
        output: "best available result",
      },
    },
  );
});

test("decision request carries one bounded whole-run deadline", () => {
  const request = {
    runId: "019fad5f-f024-7330-aac1-0ecb8454e20a",
    prompt: "Extract the character profile.",
    turn: 0,
    startedAtMs: 1_000_000,
    deadlineMs: 1_060_000,
    history: [],
    observation: {
      version: 1,
      type: "initial",
      sequence: 0,
      page: {
        url: "https://example.com/",
        title: "Example",
        snapshotExcerpt: "",
      },
    },
  };

  assert.deepEqual(
    {
      startedAtMs: validateDecisionRequest(request).startedAtMs,
      deadlineMs: validateDecisionRequest(request).deadlineMs,
    },
    { startedAtMs: 1_000_000, deadlineMs: 1_060_000 },
  );
  assert.throws(() =>
    validateDecisionRequest({
      ...request,
      deadlineMs: request.startedAtMs + 300_001,
    }),
  );
});

test("validated request builds compact final history without page snapshots", () => {
  const firstObservation = {
    version: 1,
    type: "action_result",
    sequence: 1,
    actionId: "019fad5f-f024-7330-aac1-0ecb8454e20b",
    actionKind: "hover_batch",
    outcome: "succeeded",
    result: {
      kind: "hover_batch",
      items: [{ ref: "e3", outcome: "succeeded", text: "Tooltip text" }],
    },
    page: {
      url: "https://example.com/first",
      title: "First",
      snapshotExcerpt: "OLDER_PAGE_SNAPSHOT",
    },
  };
  const currentObservation = {
    version: 1,
    type: "action_result",
    sequence: 2,
    actionId: "019fad5f-f024-7330-aac1-0ecb8454e20c",
    actionKind: "extract",
    outcome: "failed_no_effect",
    error: { category: "stale_ref", message: "Target changed" },
    page: {
      url: "https://example.com/current",
      title: "Current",
      snapshotExcerpt: "CURRENT_PAGE_SNAPSHOT",
    },
  };
  const request = validateDecisionRequest({
    runId: "019fad5f-f024-7330-aac1-0ecb8454e20a",
    prompt: "Extract the character profile.",
    turn: 2,
    startedAtMs: 1_000_000,
    deadlineMs: 1_060_000,
    history: [
      {
        turn: 0,
        action: { kind: "hover_batch", refs: ["e3"] },
        observation: firstObservation,
      },
      {
        turn: 1,
        action: { kind: "extract" },
        observation: currentObservation,
      },
    ],
    observation: currentObservation,
  });
  const compact = JSON.parse(request.finalHistoryJson);

  assert.equal(request.historyJson.includes("OLDER_PAGE_SNAPSHOT"), true);
  assert.equal(request.finalHistoryJson.includes("PAGE_SNAPSHOT"), false);
  assert.deepEqual(compact[0], {
    turn: 0,
    action: { kind: "hover_batch", refs: ["e3"] },
    observation: {
      version: 1,
      type: "action_result",
      sequence: 1,
      actionKind: "hover_batch",
      outcome: "succeeded",
      result: firstObservation.result,
    },
  });
  assert.deepEqual(compact[1].observation.error, {
    category: "stale_ref",
    message: "Target changed",
  });
  assert.equal(Object.hasOwn(compact[0].observation, "actionId"), false);
  assert.equal(Object.hasOwn(compact[0].observation, "page"), false);
});

test("hover schema and parser require an exact bounded ref", () => {
  const hoverEnvelope = (action) =>
    JSON.stringify({
      decision: {
        version: 1,
        type: "action",
        action,
      },
    });

  assert.deepEqual(
    parseAndNormalizeModelEnvelopeForTurn(
      hoverEnvelope({ kind: "hover", ref: "e7" }),
      0,
    ),
    {
      decision: {
        version: 1,
        type: "action",
        action: { kind: "hover", ref: "e7" },
      },
    },
  );
  assert.throws(() =>
    parseAndNormalizeModelEnvelopeForTurn(hoverEnvelope({ kind: "hover" }), 0),
  );
  assert.throws(() =>
    parseAndNormalizeModelEnvelopeForTurn(
      hoverEnvelope({ kind: "hover", ref: "e7", selector: "div" }),
      0,
    ),
  );
});

test("hover_batch parser requires 1 to 16 unique exact refs", () => {
  const envelope = (action) =>
    JSON.stringify({
      decision: {
        version: 1,
        type: "action",
        action,
      },
    });

  assert.deepEqual(
    parseAndNormalizeModelEnvelopeForTurn(
      envelope({ kind: "hover_batch", refs: ["e3", "e7"] }),
      0,
    ),
    {
      decision: {
        version: 1,
        type: "action",
        action: { kind: "hover_batch", refs: ["e3", "e7"] },
      },
    },
  );
  for (const action of [
    { kind: "hover_batch", refs: [] },
    {
      kind: "hover_batch",
      refs: Array.from({ length: 17 }, (_, index) => `e${index}`),
    },
    { kind: "hover_batch", refs: ["e1", "e1"] },
    { kind: "hover_batch", refs: ["e1"], selector: "button" },
  ]) {
    assert.throws(() =>
      parseAndNormalizeModelEnvelopeForTurn(envelope(action), 0),
    );
  }
});

test("hover_batch model schema omits unsupported uniqueItems", () => {
  const actionVariants =
    modelDecisionEnvelopeSchema.properties.decision.anyOf[0].properties.action
      .anyOf;
  const hoverBatchSchema = actionVariants.find(
    (variant) => variant.properties.kind.enum[0] === "hover_batch",
  );

  assert.ok(hoverBatchSchema);
  assert.equal(
    Object.hasOwn(hoverBatchSchema.properties.refs, "uniqueItems"),
    false,
  );
  assert.equal(hoverBatchSchema.properties.refs.minItems, 1);
  assert.equal(hoverBatchSchema.properties.refs.maxItems, 16);
});
