import { describe, expect, it } from "vitest";

import {
  browserOperationSchema,
  codeRunInputSchema,
  codeRunResultSchema,
  modelDecisionEnvelopeV1Schema,
  normalizeModelDecisionEnvelopeV1,
  observationV1Schema,
  promptRunInputSchema,
} from "./protocol";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SUPERVISOR = "123e4567-e89b-42d3-a456-426614174001";
const CAPABILITY_TOKEN = "c".repeat(43);
const initialObservation = {
  version: 1,
  type: "initial",
  sequence: 0,
  page: { url: "https://example.com/", title: "Example", snapshotExcerpt: "" },
} as const;

describe("browser runtime protocol", () => {
  it("separates strict model wire operations from trusted internal operations", () => {
    const missingRef = {
      decision: { version: 1, type: "action", action: { kind: "get_text" } },
    };
    const nullableRef = {
      decision: {
        version: 1,
        type: "action",
        action: { kind: "get_text", ref: null },
      },
    };
    const nonemptyWireArgs = {
      decision: {
        version: 1,
        type: "action",
        action: { kind: "evaluate", expression: "x", args: { x: 1 } },
      },
    };
    const emptyWireArgs = {
      decision: {
        version: 1,
        type: "action",
        action: { kind: "evaluate", expression: "1", args: {} },
      },
    };

    expect(modelDecisionEnvelopeV1Schema.safeParse(missingRef).success).toBe(
      false,
    );
    expect(modelDecisionEnvelopeV1Schema.safeParse(nullableRef).success).toBe(
      true,
    );
    expect(
      modelDecisionEnvelopeV1Schema.safeParse(nonemptyWireArgs).success,
    ).toBe(false);
    expect(
      modelDecisionEnvelopeV1Schema.safeParse({
        decision: { version: 1, type: "final", output: "done" },
        capabilityToken: CAPABILITY_TOKEN,
      }).success,
    ).toBe(false);
    expect(normalizeModelDecisionEnvelopeV1(emptyWireArgs)).toEqual({
      version: 1,
      type: "action",
      action: { kind: "evaluate", expression: "1", args: {} },
    });
    expect(normalizeModelDecisionEnvelopeV1(nullableRef)).toEqual({
      version: 1,
      type: "action",
      action: { kind: "get_text" },
    });
    expect(browserOperationSchema.safeParse({ kind: "get_text" }).success).toBe(
      true,
    );
    expect(
      browserOperationSchema.safeParse({
        kind: "evaluate",
        expression: "x",
        args: { x: 1 },
      }).success,
    ).toBe(true);
  });

  it("rejects noncanonical IDs, non-HTTP URLs, and oversized observations", () => {
    expect(
      promptRunInputSchema.safeParse({
        runId: UUID.toUpperCase(),
        adapterJobId: UUID,
        adapterSupervisorId: SUPERVISOR,
        capabilityToken: CAPABILITY_TOKEN,
        prompt: "inspect",
        initialObservation,
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        decisionSchemaVersion: 1,
        observationSchemaVersion: 1,
        loopPolicy: {
          maxPromptCharacters: 10_000,
          maxSnapshotExcerptCharacters: 40_000,
          maxObservationBytes: 64 * 1024,
          maxAggregateObservationBytes: 1024 * 1024,
          maxFinalOutputBytes: 256 * 1024,
          maxActions: 25,
          maxTurns: 26,
          maxRuntimeMs: 300_000,
        },
        deadline: new Date(Date.now() + 1_000),
        correlationId: UUID,
        onAccepted: async () => {},
      }).success,
    ).toBe(false);
    for (const url of [
      "file:///tmp/x",
      "mailto:test@example.com",
      "ftp://example.com/",
    ]) {
      expect(
        browserOperationSchema.safeParse({ kind: "navigate", url }).success,
      ).toBe(false);
    }
    expect(
      observationV1Schema.safeParse({
        ...initialObservation,
        page: {
          ...initialObservation.page,
          snapshotExcerpt: "x".repeat(40_001),
        },
      }).success,
    ).toBe(false);
  });

  it("bounds code input and returned output", () => {
    expect(
      codeRunInputSchema.safeParse({
        runId: UUID,
        adapterJobId: UUID,
        adapterSupervisorId: SUPERVISOR,
        capabilityToken: CAPABILITY_TOKEN,
        language: "node",
        source: "x".repeat(100_001),
        deadline: new Date(Date.now() + 1_000),
        correlationId: UUID,
        onAccepted: async () => {},
      }).success,
    ).toBe(false);
    expect(
      codeRunResultSchema.safeParse({
        stdout: "x".repeat(256 * 1024 + 1),
        result: "",
        stderr: "",
        exitCode: 0,
        killed: false,
      }).success,
    ).toBe(false);
  });

  it("rejects nil identities and cyclic or excessively deep JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      browserOperationSchema.safeParse({
        kind: "evaluate",
        expression: "args",
        args: { cyclic },
      }),
    ).not.toThrow();
    expect(
      browserOperationSchema.safeParse({
        kind: "evaluate",
        expression: "args",
        args: { cyclic },
      }).success,
    ).toBe(false);

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    expect(
      browserOperationSchema.safeParse({
        kind: "evaluate",
        expression: "args",
        args: root,
      }).success,
    ).toBe(false);

    expect(
      codeRunInputSchema.safeParse({
        runId: "00000000-0000-0000-0000-000000000000",
        adapterJobId: UUID,
        adapterSupervisorId: SUPERVISOR,
        capabilityToken: CAPABILITY_TOKEN,
        language: "node",
        source: "",
        deadline: new Date(Date.now() + 1_000),
        correlationId: UUID,
        onAccepted: async () => {},
      }).success,
    ).toBe(false);
  });
});
