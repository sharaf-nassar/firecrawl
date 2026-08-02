import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexConfig,
  buildPrompt,
  buildTimeoutFallbackDecision,
  makeChildEnvironment,
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

// @lat: [[runtime-operations#Browser Interaction Worker suite#Provider inheritance boundary]]
test("runner combines selected provider routing with closed worker policy", () => {
  const config = buildCodexConfig(`model = "gpt-test"
model_provider = "proxy"
model_providers = { "proxy" = { base_url = "https://proxy.example/v1" } }
`);

  assert.match(config, /model = "gpt-test"/);
  assert.match(config, /model_provider = "proxy"/);
  assert.match(config, /approval_policy = "never"/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /\[mcp_servers\]\s*$/u);

  const environment = makeChildEnvironment("/var/lib/run-1", {
    PROVIDER_API_KEY: "secret",
  });
  assert.equal(environment.PROVIDER_API_KEY, "secret");
  assert.equal(environment.CODEX_HOME, "/var/lib/run-1");
  assert.equal(environment.HOME, "/var/lib/run-1");
  assert.equal(environment.TMPDIR, undefined);
});

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
  assert.match(
    prompt,
    /prefer the exact refs marked with data-tooltip-trigger/,
  );
  assert.match(
    prompt,
    /hover the marked parent rather than the unmarked child/,
  );
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

function requestWithHistory(currentSnapshotExcerpt = "CURRENT_PAGE_SNAPSHOT") {
  const hoverBatchObservation = {
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
        {
          ref: "e4",
          outcome: "failed_no_effect",
          error: {
            category: "target_not_actionable",
            message: "HOVER_BATCH_FAILURE_TEXT",
          },
        },
      ],
    },
    page: {
      url: "https://example.com/old",
      title: "Old",
      snapshotExcerpt: "OLDER_PAGE_SNAPSHOT",
    },
  };
  const hoverObservation = {
    version: 1,
    type: "action_result",
    sequence: 2,
    actionId: "019fad5f-f024-7330-aac1-0ecb8454e20c",
    actionKind: "hover",
    outcome: "succeeded",
    result: {
      kind: "hover",
      applied: true,
    },
    page: {
      url: "https://example.com/hovered",
      title: "Hovered",
      snapshotExcerpt: "HOVER_RESULT_SNAPSHOT",
    },
  };
  const screenshotObservation = {
    version: 1,
    type: "action_result",
    sequence: 3,
    actionId: "019fad5f-f024-7330-aac1-0ecb8454e20d",
    actionKind: "screenshot",
    outcome: "succeeded",
    result: {
      kind: "screenshot",
      artifactId: "019fad5f-f024-7330-aac1-0ecb8454e20d",
      contentType: "image/png",
      byteSize: 128,
      checksum: "a".repeat(64),
    },
    page: {
      url: "https://example.com/screenshot",
      title: "Screenshot",
      snapshotExcerpt: "SCREENSHOT_PAGE_SNAPSHOT",
    },
  };
  const currentObservation = {
    version: 1,
    type: "action_result",
    sequence: 4,
    actionId: "019fad5f-f024-7330-aac1-0ecb8454e20e",
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
    turn: 4,
    startedAtMs: 1_000_000,
    deadlineMs: 1_060_000,
    history: [
      {
        turn: 0,
        action: { kind: "hover_batch", refs: ["e3", "e4"] },
        observation: hoverBatchObservation,
      },
      {
        turn: 1,
        action: { kind: "hover", ref: "e5" },
        observation: hoverObservation,
      },
      {
        turn: 2,
        action: { kind: "screenshot" },
        observation: screenshotObservation,
      },
      {
        turn: 3,
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

test("timeout fallback renders readable typed evidence sections", () => {
  const output =
    buildTimeoutFallbackDecision(requestWithHistory()).decision.output;

  assert.match(output, /^Best-effort browser result\n\n/);
  assert.match(
    output,
    /Page summary\nTitle: Current title\nURL: https:\/\/example\.com\/current/,
  );
  assert.match(
    output,
    /Collected evidence\n\nHover batch 1\nItem 1 — succeeded\nHOVER_BATCH_RESULT_TEXT/,
  );
  assert.match(
    output,
    /Item 2 — failed\ntarget_not_actionable: HOVER_BATCH_FAILURE_TEXT/,
  );
  assert.match(
    output,
    /Hover 1\nVisible page after hover:\nHOVER_RESULT_SNAPSHOT/,
  );
  assert.match(output, /Extract 1\nEXTRACT_RESULT_TEXT/);
  assert.match(output, /Current visible page snapshot\nCURRENT_PAGE_SNAPSHOT$/);
  assert.ok(output.indexOf("Collected evidence") < output.indexOf("Extract 1"));
  assert.ok(
    output.indexOf("EXTRACT_RESULT_TEXT") <
      output.indexOf("Current visible page snapshot"),
  );
});

test("timeout fallback is deterministic and omits protocol identifiers", () => {
  const request = requestWithHistory();
  const first = buildTimeoutFallbackDecision(request);
  const second = buildTimeoutFallbackDecision(request);

  assert.deepEqual(first, second);
  assert.equal(first.decision.type, "final");
  for (const identifier of [
    request.runId,
    "019fad5f-f024-7330-aac1-0ecb8454e20b",
    "019fad5f-f024-7330-aac1-0ecb8454e20c",
    "019fad5f-f024-7330-aac1-0ecb8454e20d",
    "019fad5f-f024-7330-aac1-0ecb8454e20e",
    "e3",
    "e4",
    "e5",
  ]) {
    assert.equal(first.decision.output.includes(identifier), false);
  }
});

test("timeout fallback truncates UTF-8 snapshot after collected evidence", () => {
  const output = buildTimeoutFallbackDecision(
    requestWithHistory("界".repeat(20_000)),
  ).decision.output;

  assert.ok(Buffer.byteLength(output, "utf8") <= 20_000);
  assert.match(output, /HOVER_BATCH_RESULT_TEXT/);
  assert.match(output, /HOVER_RESULT_SNAPSHOT/);
  assert.match(output, /EXTRACT_RESULT_TEXT/);
  assert.match(output, /Current visible page snapshot\n界+/);
  assert.match(output, /Collected data truncated/);
  assert.doesNotMatch(output, /\uFFFD/u);
});

test("timeout fallback keeps page context when no result was collected", () => {
  const request = validateDecisionRequest({
    runId: "019fad5f-f024-7330-aac1-0ecb8454e20a",
    prompt: "Read the page.",
    turn: 0,
    startedAtMs: 1_000_000,
    deadlineMs: 1_060_000,
    history: [],
    observation: {
      version: 1,
      type: "initial",
      sequence: 0,
      page: {
        url: "https://example.com/empty",
        title: "Empty page",
        snapshotExcerpt: "INITIAL_PAGE_SNAPSHOT",
      },
    },
  });
  const output = buildTimeoutFallbackDecision(request).decision.output;

  assert.match(
    output,
    /Page summary\nTitle: Empty page\nURL: https:\/\/example\.com\/empty/,
  );
  assert.match(
    output,
    /Collected evidence\nNo extract or hover evidence was collected\./,
  );
  assert.match(output, /Current visible page snapshot\nINITIAL_PAGE_SNAPSHOT$/);
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
    error => error === timeout,
  );
  assert.throws(
    () => recoverFinalOnlyTimeout(request, true, protocolError),
    error => error === protocolError,
  );
});
