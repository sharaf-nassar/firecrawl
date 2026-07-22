import { describe, expect, test, vi } from "vitest";

import { authorizePrivateRequest } from "./auth.js";

describe("private request authorization", () => {
  test("requires key, correlation, and future deadline", () => {
    expect(() =>
      authorizePrivateRequest(
        {
          authorization: "Bearer wrong",
          correlationId: "",
          deadline: new Date(Date.now() - 1).toISOString(),
        },
        "expected",
      ),
    ).toThrow(/unauthorized|deadline/i);
  });

  test("accepts exact bearer key and canonical bounded headers", () => {
    const now = new Date("2026-07-21T00:00:00.000Z");
    vi.setSystemTime(now);
    const authorized = authorizePrivateRequest(
      {
        authorization: "Bearer expected",
        correlationId: "correlation-1",
        deadline: "2026-07-21T00:01:00.000Z",
      },
      "expected",
    );
    expect(authorized).toEqual({
      correlationId: "correlation-1",
      deadline: new Date("2026-07-21T00:01:00.000Z"),
    });
    vi.useRealTimers();
  });

  test("rejects noncanonical and overly distant deadlines", () => {
    const now = new Date("2026-07-21T00:00:00.000Z");
    vi.setSystemTime(now);
    for (const deadline of [
      "2026-07-21T00:00:00Z",
      "2026-07-21T00:05:00.001Z",
      "not-a-date",
    ]) {
      expect(() =>
        authorizePrivateRequest(
          {
            authorization: "Bearer expected",
            correlationId: "correlation-1",
            deadline,
          },
          "expected",
        ),
      ).toThrow(/deadline/i);
    }
    vi.useRealTimers();
  });

  test("enforces bearer cap in UTF-8 bytes", () => {
    const key = "é".repeat(2_048);
    expect(() =>
      authorizePrivateRequest(
        {
          authorization: `Bearer ${key}`,
          correlationId: "correlation-1",
          deadline: new Date(Date.now() + 60_000).toISOString(),
        },
        key,
      ),
    ).toThrow(/unauthorized/i);
  });
});
