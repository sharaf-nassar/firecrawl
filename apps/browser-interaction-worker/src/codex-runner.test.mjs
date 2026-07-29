import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrompt,
  buildTimeoutFallbackDecision,
  recoverFinalOnlyTimeout,
} from "./codex-runner.mjs";
import { MAX_BROWSER_ACTIONS, validateDecisionRequest } from "./protocol.mjs";

function requestAtTurn(turn) {
  return {
    runId: "019fad5f-f024-7330-aac1-0ecb8454e20a",
    prompt: "Extract the character profile.",
    turn,
    historyJson: "[]",
    observationJson: '{"type":"action_result"}',
  };
}

test("turn 25 prompt requires best-effort final output", () => {
  const prompt = buildPrompt({
    ...requestAtTurn(MAX_BROWSER_ACTIONS),
    finalOnly: true,
  });

  assert.match(prompt, /Actions used: 25 of 25\./);
  assert.match(prompt, /Actions remaining: 0\./);
  assert.match(
    prompt,
    /When actions remaining is 0, return a final decision\./,
  );
  assert.match(prompt, /Use the best available\s+plain-text answer/);
  assert.match(prompt, /never request another action/);
  assert.match(prompt, /Explicitly disclose requested details/);
});

test("earlier prompt reports remaining actions and extraction strategy", () => {
  const prompt = buildPrompt(requestAtTurn(MAX_BROWSER_ACTIONS - 1));

  assert.match(prompt, /Actions used: 24 of 25\./);
  assert.match(prompt, /Actions remaining: 1\./);
  assert.match(prompt, /Prefer one whole-page extract/);
  assert.match(prompt, /Prefer this over repeated\s+hover actions/);
  assert.match(prompt, /prefer the exact refs marked with data-tooltip-trigger/);
  assert.match(prompt, /hover the marked parent rather than the unmarked child/);
  assert.match(prompt, /Do not repeat a failed action/);
  assert.doesNotMatch(prompt, /Final-only mode is active/);
});

test("deadline reserve prompt requires best-effort final before turn 25", () => {
  const prompt = buildPrompt({
    ...requestAtTurn(7),
    finalOnly: true,
  });

  assert.match(prompt, /Actions used: 7 of 25\./);
  assert.match(prompt, /Actions remaining: 18\./);
  assert.match(prompt, /Final-only mode is active/);
  assert.match(prompt, /whole-run deadline reserve has begun/);
  assert.match(prompt, /Never request another action/);
});

function requestWithHistory(
  currentSnapshotExcerpt = "CURRENT_PAGE_SNAPSHOT",
) {
  const firstObservation = {
    version: 1,
    type: "action_result",
    sequence: 1,
    actionId: "019fad5f-f024-7330-aac1-0ecb8454e20b",
    actionKind: "hover_batch",
    outcome: "succeeded",
    result: {
      kind: "hover_batch",
      items: [
        {
          ref: "e3",
          outcome: "succeeded",
          text: "HOVER_BATCH_RESULT_TEXT",
        },
      ],
    },
    page: {
      url: "https://example.com/old",
      title: "Old",
      snapshotExcerpt: "OLDER_PAGE_SNAPSHOT",
    },
  };
  const currentObservation = {
    version: 1,
    type: "action_result",
    sequence: 2,
    actionId: "019fad5f-f024-7330-aac1-0ecb8454e20c",
    actionKind: "extract",
    outcome: "succeeded",
    result: {
      kind: "extract",
      text: "EXTRACT_RESULT_TEXT",
    },
    page: {
      url: "https://example.com/current",
      title: "Current title",
      snapshotExcerpt: currentSnapshotExcerpt,
    },
  };
  return validateDecisionRequest({
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
}

test("final-only prompt compacts history but retains current page and results", () => {
  const request = requestWithHistory();
  const finalPrompt = buildPrompt({ ...request, finalOnly: true });

  assert.doesNotMatch(finalPrompt, /OLDER_PAGE_SNAPSHOT/);
  assert.match(finalPrompt, /HOVER_BATCH_RESULT_TEXT/);
  assert.match(finalPrompt, /CURRENT_PAGE_SNAPSHOT/);
  assert.match(finalPrompt, /https:\/\/example\.com\/current/);
});

test("action-capable prompt retains the original full history JSON", () => {
  const request = requestWithHistory();
  const actionPrompt = buildPrompt({ ...request, finalOnly: false });

  assert.match(actionPrompt, /OLDER_PAGE_SNAPSHOT/);
  assert.equal(actionPrompt.includes(request.historyJson), true);
});

test("timeout fallback is deterministic, bounded, and omits protocol IDs", () => {
  const request = requestWithHistory("界".repeat(20_000));

  const first = buildTimeoutFallbackDecision(request);
  const second = buildTimeoutFallbackDecision(request);

  assert.deepEqual(first, second);
  assert.equal(first.decision.type, "final");
  assert.ok(Buffer.byteLength(first.decision.output, "utf8") <= 20_000);
  assert.match(first.decision.output, /model synthesis was unavailable/);
  assert.match(first.decision.output, /HOVER_BATCH_RESULT_TEXT/);
  assert.match(first.decision.output, /EXTRACT_RESULT_TEXT/);
  assert.match(first.decision.output, /Collected data truncated/);
  assert.doesNotMatch(first.decision.output, /019fad5f/);
  assert.doesNotMatch(first.decision.output, /e3/);
});

test("only a final-only Codex timeout recovers with fallback output", () => {
  const request = requestWithHistory();
  const timeout = Object.assign(new Error("deadline"), {
    category: "codex_timeout",
  });
  const protocolError = Object.assign(new Error("schema"), {
    category: "codex_protocol_error",
  });

  assert.equal(
    recoverFinalOnlyTimeout(request, true, timeout).decision.type,
    "final",
  );
  assert.throws(
    () => recoverFinalOnlyTimeout(request, false, timeout),
    (error) => error === timeout,
  );
  assert.throws(
    () => recoverFinalOnlyTimeout(request, true, protocolError),
    (error) => error === protocolError,
  );
});
