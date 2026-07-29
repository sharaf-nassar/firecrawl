import { describe, expect, it } from "vitest";

import { browserOperationSchema } from "./protocol";
import { BROWSER_ACTION_OPERATION_TIMEOUT_MS } from "./operation-timeout";

describe("browser action operation timeout", () => {
  it("keeps a completion margin above the maximum browser wait", () => {
    const maximumWait = browserOperationSchema.parse({
      kind: "wait",
      milliseconds: 30_000,
    });
    if (maximumWait.kind !== "wait") {
      throw new Error("maximum wait did not parse as a wait operation");
    }

    expect(maximumWait.milliseconds).toBe(30_000);
    expect(BROWSER_ACTION_OPERATION_TIMEOUT_MS).toBe(45_000);
    expect(BROWSER_ACTION_OPERATION_TIMEOUT_MS - maximumWait.milliseconds).toBe(
      15_000,
    );
    expect(
      browserOperationSchema.safeParse({
        kind: "wait",
        milliseconds: 30_001,
      }).success,
    ).toBe(false);
  });
});
