import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalBrowserActionJson,
  normalizeBrowserAction,
  parseSubmitBrowserActionV1,
} from "./action-normalization";
import { browserOperationSchema } from "./protocol";

const HASH_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../../host/browser-runtime/protocol/browser-operation-hash-v1.vectors.json",
    ),
    "utf8",
  ),
) as {
  fixtureVersion: number;
  algorithm: string;
  hashInput: string;
  objectKeyOrder: string;
  arrayOrder: string;
  vectors: Array<{
    name: string;
    inputJson: string;
    canonicalJson: string;
    sha256: string;
    effect: "read_only" | "side_effecting";
  }>;
};

const JOB = "10000000-0000-4000-8000-000000000001";
const ACTION = "10000000-0000-4000-8000-000000000002";

describe("browser action normalization", () => {
  it("matches every shared production hash and effect vector", () => {
    expect(HASH_FIXTURE).toMatchObject({
      fixtureVersion: 1,
      algorithm: "sha256",
      hashInput: "canonical-operation-utf8",
      objectKeyOrder: "recursive-utf16-ascending",
      arrayOrder: "preserved",
    });
    expect(HASH_FIXTURE.vectors.map(vector => vector.name)).toEqual([
      "snapshot",
      "click",
      "fill",
      "type",
      "press",
      "select",
      "scroll",
      "wait",
      "get_text",
      "get_url",
      "navigate",
      "evaluate",
    ]);

    for (const vector of HASH_FIXTURE.vectors) {
      const operation = browserOperationSchema.parse(
        JSON.parse(vector.inputJson),
      );
      expect(canonicalBrowserActionJson(operation), vector.name).toBe(
        vector.canonicalJson,
      );
      expect(normalizeBrowserAction(operation), vector.name).toEqual({
        normalizedProposalHash: vector.sha256,
        effect: vector.effect,
      });
    }
  });

  it("sorts recursive object keys without changing array order", () => {
    expect(
      canonicalBrowserActionJson({ z: [2, 1], a: { y: true, x: null } }),
    ).toBe('{"a":{"x":null,"y":true},"z":[2,1]}');
  });

  it.each(["snapshot", "get_text", "get_url", "wait"] as const)(
    "classifies %s as read only",
    kind => {
      const operation =
        kind === "get_text"
          ? ({ kind } as const)
          : kind === "wait"
            ? ({ kind, milliseconds: 1 } as const)
            : ({ kind } as const);
      expect(normalizeBrowserAction(operation).effect).toBe("read_only");
    },
  );

  it("classifies evaluate as side effecting", () => {
    expect(
      normalizeBrowserAction({
        kind: "evaluate",
        expression: "1",
        args: {},
      }).effect,
    ).toBe("side_effecting");
  });

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
