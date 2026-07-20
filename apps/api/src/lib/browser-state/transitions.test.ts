import { describe, expect, it } from "vitest";

import {
  assertBrowserSessionTransition,
  assertInteractActionTransition,
  assertInteractRunTransition,
  browserSessionTransitions,
  interactActionTransitions,
  interactRunTransitions,
  isBrowserSessionTransition,
  isInteractActionTransition,
  isInteractRunTransition,
} from "./transitions";

describe("browser session transitions", () => {
  it("matches the complete transition map", () => {
    expect(browserSessionTransitions).toEqual({
      creating: ["replaying", "stopping", "interrupted", "error"],
      replaying: ["ready", "stopping", "interrupted", "error"],
      ready: ["executing", "stopping", "expired", "interrupted", "error"],
      executing: ["ready", "stopping", "expired", "interrupted", "error"],
      stopping: ["destroyed", "expired", "interrupted", "error"],
      destroyed: [],
      expired: [],
      interrupted: [],
      error: [],
    });
  });

  it("accepts only listed transitions", () => {
    expect(isBrowserSessionTransition("ready", "executing")).toBe(true);
    expect(isBrowserSessionTransition("executing", "succeeded" as never)).toBe(
      false,
    );
    expect(() =>
      assertBrowserSessionTransition("ready", "executing"),
    ).not.toThrow();
    expect(() =>
      assertBrowserSessionTransition("executing", "succeeded" as never),
    ).toThrow(/browser session transition/i);
  });

  it.each(["destroyed", "expired", "interrupted", "error"] as const)(
    "rejects every outgoing transition from terminal state %s",
    state => {
      for (const target of Object.keys(browserSessionTransitions)) {
        expect(isBrowserSessionTransition(state, target as never)).toBe(false);
      }
    },
  );
});

describe("interact run transitions", () => {
  it("matches the complete transition map", () => {
    expect(interactRunTransitions).toEqual({
      queued: ["starting", "cancelled", "timed_out", "interrupted"],
      starting: ["running", "failed", "cancelled", "timed_out", "interrupted"],
      running: ["succeeded", "failed", "cancelled", "timed_out", "interrupted"],
      succeeded: [],
      failed: [],
      cancelled: [],
      timed_out: [],
      interrupted: [],
    });
  });

  it("accepts only listed transitions", () => {
    expect(isInteractRunTransition("running", "succeeded")).toBe(true);
    expect(isInteractRunTransition("succeeded", "running")).toBe(false);
    expect(() =>
      assertInteractRunTransition("running", "succeeded"),
    ).not.toThrow();
    expect(() => assertInteractRunTransition("succeeded", "running")).toThrow(
      /interact run transition/i,
    );
  });

  it.each([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ] as const)(
    "rejects every outgoing transition from terminal state %s",
    state => {
      for (const target of Object.keys(interactRunTransitions)) {
        expect(isInteractRunTransition(state, target as never)).toBe(false);
      }
    },
  );
});

describe("interact action transitions", () => {
  it("matches the complete transition map", () => {
    expect(interactActionTransitions).toEqual({
      prepared: ["executing", "rejected_no_effect", "cancelled_no_effect"],
      executing: ["succeeded", "failed_no_effect", "outcome_unknown"],
      succeeded: [],
      rejected_no_effect: [],
      failed_no_effect: [],
      cancelled_no_effect: [],
      outcome_unknown: [],
    });
  });

  it("requires dispatch to persist executing before success", () => {
    expect(isInteractActionTransition("prepared", "succeeded")).toBe(false);
    expect(() =>
      assertInteractActionTransition("prepared", "succeeded"),
    ).toThrow(/interact action transition/i);
    expect(isInteractActionTransition("prepared", "executing")).toBe(true);
    expect(() =>
      assertInteractActionTransition("prepared", "executing"),
    ).not.toThrow();
  });

  it.each([
    "succeeded",
    "rejected_no_effect",
    "failed_no_effect",
    "cancelled_no_effect",
    "outcome_unknown",
  ] as const)(
    "rejects every outgoing transition from terminal state %s",
    state => {
      for (const target of Object.keys(interactActionTransitions)) {
        expect(isInteractActionTransition(state, target as never)).toBe(false);
      }
    },
  );
});
