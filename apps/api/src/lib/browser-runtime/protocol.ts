import { Buffer } from "node:buffer";

import { z } from "zod";

import type { BrowserOperation } from "../browser-state/types";
import {
  browserOperationResultSchema,
  canonicalUuidSchema,
  httpUrlSchema,
} from "../scrape-interact/browser-service-contracts";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_INTERNAL_JSON_DEPTH = 32;
const MAX_INTERNAL_JSON_NODES = 10_000;

/** @public Canonical, non-nil identity used by the execution boundary. */
export const runtimeUuidSchema = canonicalUuidSchema.refine(
  value => value !== NIL_UUID,
  "nil UUID is not an execution identity",
);

const internalRefSchema = z.string().min(1).max(128);
const internalTextSchema = z.string().max(20_000);
const internalJsonValueSchema = z.unknown().superRefine((root, context) => {
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    nodes += 1;
    if (
      nodes > MAX_INTERNAL_JSON_NODES ||
      entry.depth > MAX_INTERNAL_JSON_DEPTH
    ) {
      context.addIssue({
        code: "custom",
        message: "JSON value exceeds structural bounds",
      });
      return;
    }
    if (
      entry.value === null ||
      typeof entry.value === "string" ||
      typeof entry.value === "boolean"
    ) {
      continue;
    }
    if (typeof entry.value === "number") {
      if (!Number.isFinite(entry.value)) {
        context.addIssue({ code: "custom", message: "JSON number is invalid" });
        return;
      }
      continue;
    }
    if (typeof entry.value !== "object") {
      context.addIssue({ code: "custom", message: "value is not JSON-safe" });
      return;
    }
    if (seen.has(entry.value)) {
      context.addIssue({ code: "custom", message: "cyclic JSON is forbidden" });
      return;
    }
    seen.add(entry.value);
    if (!Array.isArray(entry.value)) {
      const prototype = Object.getPrototypeOf(entry.value);
      if (prototype !== Object.prototype && prototype !== null) {
        context.addIssue({
          code: "custom",
          message: "JSON objects must be plain records",
        });
        return;
      }
    }
    const values = Array.isArray(entry.value)
      ? entry.value
      : Object.values(entry.value);
    for (const value of values) {
      pending.push({ value, depth: entry.depth + 1 });
    }
  }
});

export const browserOperationSchema: z.ZodType<BrowserOperation> =
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("navigate"), url: httpUrlSchema }),
    z.strictObject({ kind: z.literal("click"), ref: internalRefSchema }),
    z.strictObject({ kind: z.literal("hover"), ref: internalRefSchema }),
    z.strictObject({
      kind: z.literal("hover_batch"),
      refs: z
        .array(internalRefSchema)
        .min(1)
        .max(16)
        .superRefine((refs, context) => {
          if (new Set(refs).size !== refs.length) {
            context.addIssue({
              code: "custom",
              message: "duplicate locator ref",
            });
          }
        }),
    }),
    z.strictObject({
      kind: z.literal("type"),
      ref: internalRefSchema,
      text: internalTextSchema,
      clear: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal("wait"),
      milliseconds: z.number().int().min(0).max(30_000),
    }),
    z.strictObject({
      kind: z.literal("extract"),
      ref: internalRefSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("screenshot"),
      fullPage: z.boolean().optional(),
    }),
  ]);

const boundedPageStateSchema = z.strictObject({
  url: httpUrlSchema,
  title: z.string().max(4_096),
  snapshotExcerpt: z.string().max(40_000),
});

const observationBase = {
  version: z.literal(1),
  page: boundedPageStateSchema,
};

export const observationV1Schema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...observationBase,
      type: z.literal("initial"),
      sequence: z.literal(0),
    }),
    z.strictObject({
      ...observationBase,
      type: z.literal("action_result"),
      sequence: z.number().int().min(1).max(25),
      actionId: runtimeUuidSchema,
      actionKind: z.enum([
        "navigate",
        "click",
        "hover",
        "hover_batch",
        "type",
        "wait",
        "extract",
        "screenshot",
      ]),
      outcome: z.enum(["succeeded", "rejected_no_effect", "failed_no_effect"]),
      result: browserOperationResultSchema.optional(),
      error: z
        .strictObject({
          category: z.string().min(1).max(128),
          message: z.string().max(4_096),
        })
        .optional(),
    }),
  ])
  .superRefine((observation, context) => {
    if (observation.type === "action_result") {
      const successful = observation.outcome === "succeeded";
      if (
        successful !== (observation.result !== undefined) ||
        successful === (observation.error !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "observation result/error does not match outcome",
        });
      }
      if (
        observation.result !== undefined &&
        observation.result.kind !== observation.actionKind
      ) {
        context.addIssue({
          code: "custom",
          message: "operation result kind does not match action",
        });
      }
    }
    let bytes = Number.POSITIVE_INFINITY;
    try {
      bytes = Buffer.byteLength(JSON.stringify(observation), "utf8");
    } catch {
      // The bounded protocol rejects non-JSON-safe values.
    }
    if (bytes > 64 * 1024) {
      context.addIssue({
        code: "custom",
        message: "observation exceeds 64 KiB",
      });
    }
  });

/** @public */
export type BoundedPageState = z.infer<typeof boundedPageStateSchema>;
export type ObservationV1 = z.infer<typeof observationV1Schema>;

const decisionHistoryEntryV1Schema = z
  .strictObject({
    turn: z.number().int().min(0).max(24),
    action: browserOperationSchema,
    observation: observationV1Schema,
  })
  .superRefine((entry, context) => {
    if (
      entry.observation.type !== "action_result" ||
      entry.observation.sequence !== entry.turn + 1 ||
      entry.observation.actionKind !== entry.action.kind
    ) {
      context.addIssue({
        code: "custom",
        message: "decision history entry does not match its turn and action",
      });
    }
  });

export const decisionHistoryV1Schema = z
  .array(decisionHistoryEntryV1Schema)
  .max(25)
  .superRefine((history, context) => {
    for (const [index, entry] of history.entries()) {
      if (entry.turn !== index) {
        context.addIssue({
          code: "custom",
          message: "decision history must be contiguous and ordered",
        });
        return;
      }
    }
    const observationBytes = history.reduce(
      (total, entry) =>
        total + Buffer.byteLength(JSON.stringify(entry.observation), "utf8"),
      0,
    );
    if (observationBytes > 1024 * 1024) {
      context.addIssue({
        code: "custom",
        message: "decision history observations exceed 1 MiB",
      });
    }
  });

/** @public */
export type DecisionHistoryEntryV1 = z.infer<
  typeof decisionHistoryEntryV1Schema
>;

/** @public */
export type ModelDecisionV1 =
  | { version: 1; type: "action"; action: BrowserOperation }
  | { version: 1; type: "final"; output: string };

/** @public */
export type ModelWireBrowserOperationV1 =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: string }
  | { kind: "hover"; ref: string }
  | { kind: "hover_batch"; refs: string[] }
  | { kind: "type"; ref: string; text: string; clear?: boolean | null }
  | { kind: "wait"; milliseconds: number }
  | { kind: "extract"; ref?: string | null }
  | { kind: "screenshot"; fullPage?: boolean | null };

/** @public */
export type ModelWireDecisionV1 =
  | { version: 1; type: "action"; action: ModelWireBrowserOperationV1 }
  | { version: 1; type: "final"; output: string };

/** @public */
export interface ModelDecisionEnvelopeV1 {
  decision: ModelWireDecisionV1;
}

/** @public */
export const modelDecisionV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    type: z.literal("action"),
    action: browserOperationSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("final"),
    output: z.string().superRefine((value, context) => {
      if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
        context.addIssue({ code: "custom", message: "output exceeds bound" });
      }
    }),
  }),
]);

/** @public */
export const modelWireBrowserOperationV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("navigate"), url: httpUrlSchema }),
  z.strictObject({ kind: z.literal("click"), ref: internalRefSchema }),
  z.strictObject({ kind: z.literal("hover"), ref: internalRefSchema }),
  z.strictObject({
    kind: z.literal("hover_batch"),
    refs: z
      .array(internalRefSchema)
      .min(1)
      .max(16)
      .superRefine((refs, context) => {
        if (new Set(refs).size !== refs.length) {
          context.addIssue({
            code: "custom",
            message: "duplicate locator ref",
          });
        }
      }),
  }),
  z.strictObject({
    kind: z.literal("type"),
    ref: internalRefSchema,
    text: internalTextSchema,
    clear: z.boolean().nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(30_000),
  }),
  z.strictObject({
    kind: z.literal("extract"),
    ref: internalRefSchema.nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal("screenshot"),
    fullPage: z.boolean().nullable().optional(),
  }),
]);

/** @public */
export const modelWireDecisionV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    type: z.literal("action"),
    action: modelWireBrowserOperationV1Schema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("final"),
    output: z.string().superRefine((value, context) => {
      if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
        context.addIssue({ code: "custom", message: "output exceeds bound" });
      }
    }),
  }),
]);

const modelDecisionEnvelopeV1Schema = z.strictObject({
  decision: modelWireDecisionV1Schema,
});

/** @public */
export class ModelProtocolError extends Error {
  readonly category = "model_protocol_error";

  constructor() {
    super("Model output did not match the browser decision protocol");
    this.name = "ModelProtocolError";
  }
}

export function normalizeModelDecisionEnvelopeV1(
  envelope: unknown,
): ModelDecisionV1 {
  const parsed = modelDecisionEnvelopeV1Schema.safeParse(envelope);
  if (!parsed.success) throw new ModelProtocolError();
  const decision = parsed.data.decision;
  if (decision.type === "final") return decision;
  const operation = decision.action;
  if (operation.kind === "extract") {
    return {
      version: 1,
      type: "action",
      action:
        operation.ref == null
          ? { kind: "extract" }
          : { kind: "extract", ref: operation.ref },
    };
  }
  if (operation.kind === "type") {
    return {
      version: 1,
      type: "action",
      action: {
        kind: "type",
        ref: operation.ref,
        text: operation.text,
        ...(operation.clear == null ? {} : { clear: operation.clear }),
      },
    };
  }
  if (operation.kind === "screenshot") {
    return {
      version: 1,
      type: "action",
      action:
        operation.fullPage == null
          ? { kind: "screenshot" }
          : { kind: "screenshot", fullPage: operation.fullPage },
    };
  }
  return { version: 1, type: "action", action: operation };
}

export const PROMPT_LOOP_POLICY_V1 = {
  maxPromptCharacters: 10_000,
  maxSnapshotExcerptCharacters: 40_000,
  maxObservationBytes: 64 * 1024,
  maxAggregateObservationBytes: 1024 * 1024,
  maxFinalOutputBytes: 256 * 1024,
  maxActions: 25,
  maxTurns: 26,
  maxRuntimeMs: 300_000,
} as const;

const promptLoopPolicySchema = z.strictObject({
  maxPromptCharacters: z.literal(10_000),
  maxSnapshotExcerptCharacters: z.literal(40_000),
  maxObservationBytes: z.literal(64 * 1024),
  maxAggregateObservationBytes: z.literal(1024 * 1024),
  maxFinalOutputBytes: z.literal(256 * 1024),
  maxActions: z.literal(25),
  maxTurns: z.literal(26),
  maxRuntimeMs: z.literal(300_000),
});

const boundedDeadlineSchema = z.date().superRefine((deadline, context) => {
  const remaining = deadline.getTime() - Date.now();
  if (remaining <= 0 || remaining > 300_000) {
    context.addIssue({
      code: "custom",
      message: "deadline must be within the next 300 seconds",
    });
  }
});

export const promptRunInputSchema = z.strictObject({
  runId: runtimeUuidSchema,
  prompt: z.string().max(10_000),
  initialObservation: observationV1Schema.refine(
    value => value.type === "initial" && value.sequence === 0,
  ),
  decisionSchemaVersion: z.literal(1),
  observationSchemaVersion: z.literal(1),
  loopPolicy: promptLoopPolicySchema,
  deadline: boundedDeadlineSchema,
  correlationId: runtimeUuidSchema,
});

export const promptRunResultSchema = z.strictObject({
  output: z.string().superRefine((value, context) => {
    if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
      context.addIssue({ code: "custom", message: "output exceeds bound" });
    }
  }),
  turnCount: z.number().int().min(0).max(26),
  actionCount: z.number().int().min(0).max(25),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  protocol: z.strictObject({
    toolEventCount: z.literal(0),
    approvalEventCount: z.literal(0),
    decisionSchemaVersion: z.literal(1),
    observationSchemaVersion: z.literal(1),
  }),
});
export type PromptRunResult = z.infer<typeof promptRunResultSchema>;
