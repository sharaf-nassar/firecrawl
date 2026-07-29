import { describe, expect, it } from "vitest";

import {
  canonicalBrowserActionJson,
  normalizeBrowserAction,
  parseSubmitBrowserActionV1,
} from "./action-normalization";

const JOB = "10000000-0000-4000-8000-000000000001";
const ACTION = "10000000-0000-4000-8000-000000000002";

describe("browser action normalization", () => {
  it("sorts recursive object keys without changing array order", () => {
    expect(
      canonicalBrowserActionJson({ z: [2, 1], a: { y: true, x: null } }),
    ).toBe('{"a":{"x":null,"y":true},"z":[2,1]}');
  });

  it.each(["extract", "hover", "hover_batch", "screenshot", "wait"] as const)(
    "classifies %s as read only",
    kind => {
      const operation =
        kind === "wait"
          ? ({ kind, milliseconds: 1 } as const)
          : kind === "hover"
            ? ({ kind, ref: "e1" } as const)
            : kind === "hover_batch"
              ? { kind, refs: ["e1", "e2"] }
              : ({ kind } as const);
      expect(normalizeBrowserAction(operation).effect).toBe("read_only");
    },
  );

  it("rejects non-JSON values, non-finite numbers, and cycles", () => {
    expect(() => canonicalBrowserActionJson(undefined)).toThrow();
    expect(() => canonicalBrowserActionJson(Number.NaN)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalBrowserActionJson(cyclic)).toThrow();
  });

  it("rejects mismatched adapter-derived hash and effect", () => {
    expect(() =>
      parseSubmitBrowserActionV1({
        version: 1,
        adapterJobId: JOB,
        sequence: 1,
        actionId: ACTION,
        proposalHash: "0".repeat(64),
        effect: "read_only",
        operation: { kind: "click", ref: "e1" },
      }),
    ).toThrow(/normalization/);
  });
});
