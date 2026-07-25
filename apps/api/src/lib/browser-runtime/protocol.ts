import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  browserOperationResultSchema,
  canonicalUuidSchema,
  httpUrlSchema,
} from "../scrape-interact/browser-service-contracts";
import type {
  AdapterPendingAuthorizationInput,
  BrowserOperation,
} from "../browser-state/types";

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
    z.strictObject({ kind: z.literal("snapshot") }),
    z.strictObject({ kind: z.literal("click"), ref: internalRefSchema }),
    z.strictObject({
      kind: z.literal("fill"),
      ref: internalRefSchema,
      value: internalTextSchema,
    }),
    z.strictObject({
      kind: z.literal("type"),
      ref: internalRefSchema,
      value: internalTextSchema,
      delayMs: z.number().int().min(0).max(250),
    }),
    z.strictObject({
      kind: z.literal("press"),
      ref: internalRefSchema,
      key: z.string().min(1).max(64),
    }),
    z.strictObject({
      kind: z.literal("select"),
      ref: internalRefSchema,
      values: z.array(z.string().max(512)).max(20),
    }),
    z.strictObject({
      kind: z.literal("scroll"),
      deltaX: z.number().int().min(-10_000).max(10_000),
      deltaY: z.number().int().min(-10_000).max(10_000),
    }),
    z.strictObject({
      kind: z.literal("wait"),
      milliseconds: z.number().int().min(0).max(30_000),
    }),
    z.strictObject({
      kind: z.literal("get_text"),
      ref: internalRefSchema.optional(),
    }),
    z.strictObject({ kind: z.literal("get_url") }),
    z.strictObject({ kind: z.literal("navigate"), url: httpUrlSchema }),
    z.strictObject({
      kind: z.literal("evaluate"),
      expression: internalTextSchema,
      args: z.record(z.string(), internalJsonValueSchema),
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

/** @public */
export type ModelDecisionV1 =
  | { version: 1; type: "action"; action: BrowserOperation }
  | { version: 1; type: "final"; output: string };

/** @public */
export type ModelWireBrowserOperationV1 =
  | { kind: "snapshot" }
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string }
  | { kind: "type"; ref: string; value: string; delayMs: number }
  | { kind: "press"; ref: string; key: string }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "wait"; milliseconds: number }
  | { kind: "get_text"; ref: string | null }
  | { kind: "get_url" }
  | { kind: "navigate"; url: string }
  | {
      kind: "evaluate";
      expression: string;
      args: Record<string, never>;
    };

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

const emptyModelWireArgsSchema = z
  .strictObject({})
  .transform((): Record<string, never> => ({}));

/** @public */
export const modelWireBrowserOperationV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot") }),
  z.strictObject({ kind: z.literal("click"), ref: internalRefSchema }),
  z.strictObject({
    kind: z.literal("fill"),
    ref: internalRefSchema,
    value: internalTextSchema,
  }),
  z.strictObject({
    kind: z.literal("type"),
    ref: internalRefSchema,
    value: internalTextSchema,
    delayMs: z.number().int().min(0).max(250),
  }),
  z.strictObject({
    kind: z.literal("press"),
    ref: internalRefSchema,
    key: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("select"),
    ref: internalRefSchema,
    values: z.array(z.string().max(512)).max(20),
  }),
  z.strictObject({
    kind: z.literal("scroll"),
    deltaX: z.number().int().min(-10_000).max(10_000),
    deltaY: z.number().int().min(-10_000).max(10_000),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(30_000),
  }),
  z.strictObject({
    kind: z.literal("get_text"),
    ref: internalRefSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("get_url") }),
  z.strictObject({ kind: z.literal("navigate"), url: httpUrlSchema }),
  z.strictObject({
    kind: z.literal("evaluate"),
    expression: internalTextSchema,
    args: emptyModelWireArgsSchema,
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

export const modelDecisionEnvelopeV1Schema = z.strictObject({
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
  if (operation.kind === "get_text") {
    return {
      version: 1,
      type: "action",
      action:
        operation.ref === null
          ? { kind: "get_text" }
          : { kind: "get_text", ref: operation.ref },
    };
  }
  return {
    version: 1,
    type: "action",
    action:
      operation.kind === "evaluate"
        ? { ...operation, args: {} }
        : (operation as BrowserOperation),
  };
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

const adapterPendingSchema = {
  adapterJobId: runtimeUuidSchema,
  adapterSupervisorId: runtimeUuidSchema,
  capabilityToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  onAccepted: z.custom<AdapterPendingAuthorizationInput["onAccepted"]>(
    value => typeof value === "function",
  ),
};

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
  ...adapterPendingSchema,
  runId: runtimeUuidSchema,
  prompt: z.string().max(10_000),
  initialObservation: observationV1Schema.refine(
    value => value.type === "initial" && value.sequence === 0,
  ),
  model: z.literal("gpt-5.6-terra"),
  reasoningEffort: z.literal("medium"),
  decisionSchemaVersion: z.literal(1),
  observationSchemaVersion: z.literal(1),
  loopPolicy: promptLoopPolicySchema,
  deadline: boundedDeadlineSchema,
  correlationId: runtimeUuidSchema,
});

export type PromptRunInput = z.infer<typeof promptRunInputSchema>;

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

export const codeRunInputSchema = z.strictObject({
  ...adapterPendingSchema,
  runId: runtimeUuidSchema,
  language: z.enum(["node", "python", "bash"]),
  source: z.string().max(100_000),
  deadline: boundedDeadlineSchema,
  correlationId: runtimeUuidSchema,
});
export type CodeRunInput = z.infer<typeof codeRunInputSchema>;

const boundedCodeTextSchema = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
    context.addIssue({ code: "custom", message: "code output exceeds bound" });
  }
});

export const codeRunResultSchema = z
  .strictObject({
    stdout: boundedCodeTextSchema,
    result: boundedCodeTextSchema,
    stderr: boundedCodeTextSchema,
    exitCode: z.number().int().min(0).max(255),
    killed: z.boolean(),
  })
  .superRefine((value, context) => {
    const total =
      Buffer.byteLength(value.stdout, "utf8") +
      Buffer.byteLength(value.result, "utf8") +
      Buffer.byteLength(value.stderr, "utf8");
    if (total > 512 * 1024) {
      context.addIssue({
        code: "custom",
        message: "code result exceeds bound",
      });
    }
  });
export type CodeRunResult = z.infer<typeof codeRunResultSchema>;
