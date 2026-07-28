import { z } from "zod";

import { adapterAuthorizationBindingSchema } from "../browser-state/types";
import { canonicalUuidSchema } from "../scrape-interact/browser-service-contracts";
import {
  codeRunInputSchema,
  codeRunResultSchema,
  promptRunInputSchema,
  promptRunResultSchema,
  runtimeUuidSchema,
} from "./protocol";

/** @public */
export const EXECUTION_ADAPTER_PROTOCOL_VERSION = 1 as const;
export const EXECUTION_ADAPTER_MAX_LINE_BYTES = 2 * 1024 * 1024;
export const EXECUTION_ADAPTER_MAX_RUNTIME_MS = 300_000;

/** @public */
export const adapterRequestIdSchema = canonicalUuidSchema;

const serializedDeadlineSchema = z.string().datetime({ offset: true });

/** @public */
export const promptRunRequestSchema = promptRunInputSchema
  .omit({ onAccepted: true, deadline: true })
  .extend({ deadline: serializedDeadlineSchema });

/** @public */
export const codeRunRequestSchema = codeRunInputSchema
  .omit({ onAccepted: true, deadline: true })
  .extend({ deadline: serializedDeadlineSchema });

/** @public */
export const adapterCancellationReasonSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => value.trim() === value, "reason must be trimmed")
  .regex(/^[^\u0000-\u001f\u007f]*$/u);

/** @public */
export const cancelRunRequestSchema = z.strictObject({
  runId: runtimeUuidSchema,
  reason: adapterCancellationReasonSchema,
});

const adapterRequestBase = {
  version: z.literal(EXECUTION_ADAPTER_PROTOCOL_VERSION),
  requestId: adapterRequestIdSchema,
};

/** @public */
export const executePromptAdapterRequestSchema = z.strictObject({
  ...adapterRequestBase,
  method: z.literal("execute_prompt"),
  body: promptRunRequestSchema,
});

/** @public */
export const executeCodeAdapterRequestSchema = z.strictObject({
  ...adapterRequestBase,
  method: z.literal("execute_code"),
  body: codeRunRequestSchema,
});

/** @public */
export const cancelAdapterRequestSchema = z.strictObject({
  ...adapterRequestBase,
  method: z.literal("cancel"),
  body: cancelRunRequestSchema,
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const canonicalSemverSchema = z
  .string()
  .regex(
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );

/** @public */
export const adapterHealthRequestSchema = z.strictObject({
  ...adapterRequestBase,
  method: z.literal("health"),
  body: z.strictObject({}),
});

/** @public */
export const adapterHealthResultSchema = z.strictObject({
  version: z.literal(EXECUTION_ADAPTER_PROTOCOL_VERSION),
  status: z.literal("ok"),
  codexCliVersion: canonicalSemverSchema,
  codexArtifactSha256: sha256Schema,
  codexProtocolSchemaSha256: sha256Schema,
  brokerProtocolSha256: sha256Schema,
  model: z.literal("gpt-5.6-terra"),
  reasoningEffort: z.literal("medium"),
});

/** @public */
export const adapterStatusRequestSchema = z.strictObject({
  ...adapterRequestBase,
  method: z.literal("status"),
  body: z.strictObject({}),
});

/** @public */
export const adapterHostStatusResultSchema = z.strictObject({
  version: z.literal(EXECUTION_ADAPTER_PROTOCOL_VERSION),
  preparedHostJobs: z.number().int().nonnegative(),
  startingHostJobs: z.number().int().nonnegative(),
  runningHostJobs: z.number().int().nonnegative(),
  unsettledHostJobs: z.number().int().nonnegative(),
  orphanProcesses: z.number().int().nonnegative(),
});

/** @public */
export const diagnoseHostJobRequestBodySchema = z.strictObject({
  correlationId: canonicalUuidSchema,
  jobId: canonicalUuidSchema,
});

/** @public */
export const diagnoseHostJobAdapterRequestSchema = z.strictObject({
  ...adapterRequestBase,
  method: z.literal("diagnose_host_job"),
  body: diagnoseHostJobRequestBodySchema,
});

/** @public */
export const hostJobPhaseSchema = z.enum([
  "creating",
  "prepared",
  "starting",
  "running",
  "stopping",
  "terminal",
  "absent",
]);

/** @public */
export const hostJobRuncStateSchema = z
  .enum(["created", "running", "stopped"])
  .nullable();

/** @public */
export const diagnoseHostJobResultSchema = z.strictObject({
  version: z.literal(EXECUTION_ADAPTER_PROTOCOL_VERSION),
  correlationId: canonicalUuidSchema,
  jobId: canonicalUuidSchema,
  phase: hostJobPhaseSchema,
  hostInitPid: z.number().int().positive().nullable(),
  pidfdLive: z.boolean(),
  pidfdPidMatches: z.boolean(),
  controlLeaseConnected: z.boolean(),
  inertRelayFdPresent: z.boolean(),
  relayListenerPresent: z.boolean(),
  cdpRelayOpened: z.boolean(),
  payloadStartedCount: z.number().int().nonnegative(),
  payloadMarkerPresent: z.boolean(),
  callbackCount: z.number().int().nonnegative(),
  browserEffectCount: z.number().int().nonnegative(),
  runcState: hostJobRuncStateSchema,
  cgroupPresent: z.boolean(),
  jobDirectoryPresent: z.boolean(),
  childCount: z.number().int().nonnegative(),
  cleanupFailure: z.boolean(),
});

/** @public */
export const adapterRequestSchema = z.discriminatedUnion("method", [
  executePromptAdapterRequestSchema,
  executeCodeAdapterRequestSchema,
  cancelAdapterRequestSchema,
  adapterHealthRequestSchema,
  adapterStatusRequestSchema,
  diagnoseHostJobAdapterRequestSchema,
]);

/** @public */
export const adapterAuthorizationAckSchema = z.strictObject({
  version: z.literal(EXECUTION_ADAPTER_PROTOCOL_VERSION),
  requestId: adapterRequestIdSchema,
  type: z.literal("authorized"),
  binding: adapterAuthorizationBindingSchema,
});

/** @public */
export const adapterErrorCategorySchema = z.enum([
  "codex_unavailable",
  "sandbox_unavailable",
  "cancelled",
  "timed_out",
  "model_protocol_error",
  "action_outcome_unknown",
  "capability_denied",
  "not_found",
]);

/** @public */
export const adapterErrorSchema = z.strictObject({
  category: adapterErrorCategorySchema,
  message: z.string().min(1).max(256),
});

const adapterResponseBase = {
  version: z.literal(EXECUTION_ADAPTER_PROTOCOL_VERSION),
  requestId: adapterRequestIdSchema,
};

/** @public */
export const adapterAcceptedResponseSchema = z.strictObject({
  ...adapterResponseBase,
  type: z.literal("accepted"),
  binding: adapterAuthorizationBindingSchema,
});

/** @public */
export const adapterResultResponseSchema = z.strictObject({
  ...adapterResponseBase,
  type: z.literal("result"),
  body: z.unknown(),
});

/** @public */
export const adapterErrorResponseSchema = z.strictObject({
  ...adapterResponseBase,
  type: z.literal("error"),
  error: adapterErrorSchema,
});

/** @public */
export const adapterResponseSchema = z.discriminatedUnion("type", [
  adapterAcceptedResponseSchema,
  adapterResultResponseSchema,
  adapterErrorResponseSchema,
]);

/** @public */
export const cancelRunResultSchema = z.strictObject({
  killed: z.literal(true),
});

/** @public */
export type AdapterRequest = z.infer<typeof adapterRequestSchema>;
/** @public */
export type AdapterAuthorizationAck = z.infer<
  typeof adapterAuthorizationAckSchema
>;
/** @public */
export type AdapterResponse = z.infer<typeof adapterResponseSchema>;
/** @public */
export type AdapterError = z.infer<typeof adapterErrorSchema>;
/** @public */
export type PromptRunRequest = z.infer<typeof promptRunRequestSchema>;
/** @public */
export type CodeRunRequest = z.infer<typeof codeRunRequestSchema>;
/** @public */
export type CancelRunRequest = z.infer<typeof cancelRunRequestSchema>;
/** @public */
export type AdapterHealthResult = z.infer<typeof adapterHealthResultSchema>;
/** @public */
export type AdapterHostStatusResult = z.infer<
  typeof adapterHostStatusResultSchema
>;
/** @public */
export type DiagnoseHostJobResult = z.infer<typeof diagnoseHostJobResultSchema>;

export { codeRunResultSchema, promptRunResultSchema };
