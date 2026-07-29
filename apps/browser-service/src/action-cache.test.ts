import { describe, expect, test, vi } from "vitest";

import { createHash } from "node:crypto";

import { canonicalJson } from "./contracts.js";
import type {
  BrowserActionExecutionResultV1,
  BrowserActionExecutionV1,
  BrowserOperation,
} from "./contracts.js";
import { ActionCacheError, SessionActionCache } from "./action-cache.js";

const ACTION_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_ACTION_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const RUN_ID = "cccccccc-3333-4333-8333-333333333333";
const OTHER_RUN_ID = "dddddddd-4444-4444-8444-444444444444";
const CLICK_OPERATION = { kind: "click", ref: "e1" } as const;

function operationHash(operation: BrowserOperation): string {
  return createHash("sha256")
    .update(canonicalJson(operation), "utf8")
    .digest("hex");
}

const HASH = operationHash(CLICK_OPERATION);

function action(
  overrides: Partial<BrowserActionExecutionV1> = {},
): BrowserActionExecutionV1 {
  return {
    version: 1,
    actionId: ACTION_ID,
    runId: RUN_ID,
    sequence: 1,
    normalizedProposalHash: HASH,
    effect: "side_effecting",
    expectedSessionVersion: 0,
    allowedDomains: ["example.test"],
    operation: CLICK_OPERATION,
    ...overrides,
  };
}

function succeeded(
  overrides: Partial<BrowserActionExecutionResultV1> = {},
): BrowserActionExecutionResultV1 {
  return {
    version: 1,
    actionId: ACTION_ID,
    sequence: 1,
    normalizedProposalHash: HASH,
    outcome: "succeeded",
    result: { kind: "click", applied: true },
    page: {
      url: "https://example.test/",
      title: "Example",
      snapshotExcerpt: "Example",
    },
    sessionVersion: 1,
    ...overrides,
  };
}

function failedNoEffect(
  overrides: Partial<BrowserActionExecutionResultV1> = {},
): BrowserActionExecutionResultV1 {
  return {
    version: 1,
    actionId: ACTION_ID,
    sequence: 1,
    normalizedProposalHash: HASH,
    outcome: "failed_no_effect",
    error: {
      category: "stale_ref",
      message: "Locator reference is stale",
    },
    page: {
      url: "https://example.test/",
      title: "Example",
      snapshotExcerpt: "Example",
    },
    sessionVersion: 0,
    ...overrides,
  };
}

function expectProtocolError(operation: () => unknown): void {
  expect(operation).toThrow(ActionCacheError);
  expect(operation).toThrow(
    expect.objectContaining({ category: "model_protocol_error" }),
  );
}

describe("session action cache", () => {
  test("replays a matching succeeded action without dispatching twice", async () => {
    const cache = new SessionActionCache();
    const dispatch = vi.fn(async () => succeeded());

    const execute = async (): Promise<BrowserActionExecutionResultV1> => {
      const lookup = cache.begin(action());
      if (lookup.kind === "replay") return lookup.result;
      const result = await dispatch();
      return cache.succeed(lookup.pending, result);
    };

    const first = await execute();
    const replay = await execute();

    expect(replay).toEqual(first);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    expect(cache.has(ACTION_ID)).toBe(true);
  });

  test("rejects action-ID and same-run sequence collisions", () => {
    const byActionId = new SessionActionCache();
    const first = byActionId.begin(action());
    if (first.kind !== "dispatch") throw new Error("expected dispatch");
    byActionId.succeed(first.pending, succeeded());

    expectProtocolError(() =>
      byActionId.begin(
        action({
          runId: OTHER_RUN_ID,
        }),
      ),
    );

    const bySequence = new SessionActionCache();
    const sequenceFirst = bySequence.begin(action());
    if (sequenceFirst.kind !== "dispatch") throw new Error("expected dispatch");
    bySequence.succeed(sequenceFirst.pending, succeeded());

    expectProtocolError(() =>
      bySequence.begin(
        action({
          actionId: OTHER_ACTION_ID,
        }),
      ),
    );
  });

  test("scopes sequence identity and replay caching to each run", () => {
    const cache = new SessionActionCache();

    const firstRun = cache.begin(action());
    if (firstRun.kind !== "dispatch") throw new Error("expected dispatch");
    const firstResult = cache.succeed(firstRun.pending, succeeded());

    const secondRequest = action({
      actionId: OTHER_ACTION_ID,
      runId: OTHER_RUN_ID,
    });
    const secondRun = cache.begin(secondRequest);
    if (secondRun.kind !== "dispatch") throw new Error("expected dispatch");
    const secondResult = cache.succeed(
      secondRun.pending,
      succeeded({ actionId: OTHER_ACTION_ID }),
    );

    expect(cache.begin(action())).toEqual({
      kind: "replay",
      result: firstResult,
    });
    expect(cache.begin(secondRequest)).toEqual({
      kind: "replay",
      result: secondResult,
    });
    expect(cache.size).toBe(2);
    expect(cache.has(ACTION_ID)).toBe(true);
    expect(cache.has(OTHER_ACTION_ID)).toBe(true);
  });

  test("keeps pending work outside the terminal cache", () => {
    const cache = new SessionActionCache();
    const first = cache.begin(action());
    if (first.kind !== "dispatch") throw new Error("expected dispatch");

    expect(cache.size).toBe(0);
    expect(cache.has(ACTION_ID)).toBe(false);
    expect(cache.pending).toBe(true);
    expectProtocolError(() => cache.begin(action()));

    cache.abandon(first.pending);
    expect(cache.pending).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.begin(action()).kind).toBe("dispatch");
  });

  test("replays a matching failed_no_effect result", () => {
    const cache = new SessionActionCache();
    const first = cache.begin(action());
    if (first.kind !== "dispatch") throw new Error("expected dispatch");
    const inserted = cache.failNoEffect(first.pending, failedNoEffect());

    const replay = cache.begin(action());
    expect(replay).toEqual({ kind: "replay", result: inserted });
    expect(cache.size).toBe(1);
  });

  test("leaves no entry after an ambiguous outcome", () => {
    const cache = new SessionActionCache();
    const first = cache.begin(action());
    if (first.kind !== "dispatch") throw new Error("expected dispatch");

    cache.abandon(first.pending);

    expect(cache.size).toBe(0);
    expect(cache.has(ACTION_ID)).toBe(false);
    expect(cache.begin(action()).kind).toBe("dispatch");
  });

  test("validates trusted effects before creating pending work", () => {
    const cache = new SessionActionCache();

    expectProtocolError(() => cache.begin(action({ effect: "read_only" })));
    expect(cache.pending).toBe(false);
    expect(cache.size).toBe(0);
  });

  test("requires the normalized proposal hash to match the operation", () => {
    const cache = new SessionActionCache();

    expectProtocolError(() =>
      cache.begin(action({ normalizedProposalHash: "f".repeat(64) })),
    );
    expect(cache.pending).toBe(false);
    expect(cache.size).toBe(0);
  });

  test("requires exact replay identity beyond action ID and hash", () => {
    const cache = new SessionActionCache();
    const first = cache.begin(action());
    if (first.kind !== "dispatch") throw new Error("expected dispatch");
    cache.succeed(first.pending, succeeded());

    expectProtocolError(() =>
      cache.begin(action({ expectedSessionVersion: 1 })),
    );
  });

  test("rejects invalid terminal responses without caching them", () => {
    const invalidCases = [
      succeeded({
        result: {
          kind: "screenshot",
          byteSize: 0,
          checksum: "a".repeat(64),
        },
      }),
      succeeded({ actionId: OTHER_ACTION_ID }),
      succeeded({
        page: {
          url: "https://example.test/",
          title: "x".repeat(4_097),
          snapshotExcerpt: "",
        },
      }),
    ];

    for (const result of invalidCases) {
      const cache = new SessionActionCache();
      const first = cache.begin(action());
      if (first.kind !== "dispatch") throw new Error("expected dispatch");

      expect(() => cache.succeed(first.pending, result)).toThrow();
      expect(cache.pending).toBe(false);
      expect(cache.size).toBe(0);
      expect(cache.has(ACTION_ID)).toBe(false);
    }
  });

  test("enforces outcome-specific terminal insertion APIs", () => {
    const successCache = new SessionActionCache();
    const success = successCache.begin(action());
    if (success.kind !== "dispatch") throw new Error("expected dispatch");
    expect(() =>
      successCache.failNoEffect(success.pending, succeeded()),
    ).toThrow();
    expect(successCache.size).toBe(0);

    const failureCache = new SessionActionCache();
    const failure = failureCache.begin(action());
    if (failure.kind !== "dispatch") throw new Error("expected dispatch");
    expect(() =>
      failureCache.succeed(failure.pending, failedNoEffect()),
    ).toThrow();
    expect(failureCache.size).toBe(0);
  });
});
