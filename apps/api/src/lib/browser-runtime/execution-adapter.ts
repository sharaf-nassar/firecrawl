import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";

import { z } from "zod";

import { MAX_ARTIFACT_BYTES } from "../scrape-interact/browser-service-contracts";
import {
  decisionHistoryV1Schema,
  observationV1Schema,
  PROMPT_LOOP_POLICY_V1,
  runtimeUuidSchema,
  type DecisionHistoryEntryV1,
  type ModelDecisionEnvelopeV1,
  type ObservationV1,
} from "./protocol";

type ExecutionAdapterErrorCategory =
  | "adapter_unavailable"
  | "adapter_protocol_error"
  | "concurrency_exceeded"
  | "cancelled"
  | "timed_out"
  | "model_protocol_error"
  | "action_outcome_unknown"
  | "capability_denied"
  | "not_found";

const EXECUTION_ADAPTER_ERROR_MESSAGES: Record<
  ExecutionAdapterErrorCategory,
  string
> = {
  adapter_unavailable: "Browser execution is unavailable",
  adapter_protocol_error: "Browser execution adapter protocol failed",
  concurrency_exceeded: "Browser execution capacity was reached",
  cancelled: "Browser execution was cancelled",
  timed_out: "Browser execution timed out",
  model_protocol_error: "Browser execution returned an invalid protocol result",
  action_outcome_unknown: "Browser action outcome is unknown",
  capability_denied: "Browser execution capability was denied",
  not_found: "Browser execution job was not found",
};

/** @public */
export class ExecutionAdapterError extends Error {
  constructor(public readonly category: ExecutionAdapterErrorCategory) {
    super(EXECUTION_ADAPTER_ERROR_MESSAGES[category]);
    this.name = "ExecutionAdapterError";
  }
}

/**
 * Prompt-only execution boundary. Implementations may delegate the constrained
 * action loop to a Docker worker, but must not expose shell or page-script
 * execution.
 */
export interface BrowserExecutionAdapter {
  requestDecision(
    input: {
      runId: string;
      prompt: string;
      turn: number;
      startedAtMs: number;
      deadlineMs: number;
      history: readonly DecisionHistoryEntryV1[];
      observation: ObservationV1;
      screenshot?: DecisionScreenshotV1;
    },
    signal: AbortSignal,
  ): Promise<ModelDecisionEnvelopeV1>;
  cancelExecutionRun(runId: string, reason: string): Promise<{ killed: true }>;
}

/** Transient screenshot input. Never include these bytes in durable history. */
type DecisionScreenshotV1 = Readonly<{
  metadata: Readonly<{
    artifactId: string;
    contentType: "image/png";
    byteSize: number;
    checksum: string;
  }>;
  bytes: Uint8Array;
}>;

/** @public */
export function createUnavailableExecutionAdapter(): BrowserExecutionAdapter {
  return {
    async requestDecision() {
      throw new ExecutionAdapterError("adapter_unavailable");
    },
    async cancelExecutionRun() {
      return { killed: true };
    },
  };
}

/** @public */
export const unavailableExecutionAdapter = createUnavailableExecutionAdapter();

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const decisionScreenshotSchema = z
  .strictObject({
    metadata: z.strictObject({
      artifactId: runtimeUuidSchema,
      contentType: z.literal("image/png"),
      byteSize: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
      checksum: sha256Schema,
    }),
    bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array),
  })
  .superRefine((screenshot, context) => {
    if (
      screenshot.bytes.byteLength !== screenshot.metadata.byteSize ||
      createHash("sha256").update(screenshot.bytes).digest("hex") !==
        screenshot.metadata.checksum
    ) {
      context.addIssue({
        code: "custom",
        message: "screenshot bytes do not match their metadata",
      });
    }
  });

const decisionRequestSchema = z
  .strictObject({
    runId: runtimeUuidSchema,
    prompt: z.string().max(10_000),
    turn: z.number().int().min(0).max(25),
    startedAtMs: z.number().int().nonnegative(),
    deadlineMs: z.number().int().positive(),
    history: decisionHistoryV1Schema,
    observation: observationV1Schema,
    screenshot: decisionScreenshotSchema.optional(),
  })
  .superRefine((request, context) => {
    if (
      request.deadlineMs <= request.startedAtMs ||
      request.deadlineMs - request.startedAtMs >
        PROMPT_LOOP_POLICY_V1.maxRuntimeMs
    ) {
      context.addIssue({
        code: "custom",
        message: "decision deadline must follow start within 300 seconds",
      });
    }
    if (request.history.length !== request.turn) {
      context.addIssue({
        code: "custom",
        message: "decision history length must match turn",
      });
      return;
    }
    if (request.turn === 0) {
      if (
        request.observation.type !== "initial" ||
        request.observation.sequence !== 0 ||
        request.screenshot !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "first decision requires the initial observation",
        });
      }
      return;
    }
    const latest = request.history.at(-1);
    if (
      latest === undefined ||
      JSON.stringify(latest.observation) !== JSON.stringify(request.observation)
    ) {
      context.addIssue({
        code: "custom",
        message: "current observation must match the latest history entry",
      });
      return;
    }
    const screenshotResult =
      request.observation.type === "action_result" &&
      request.observation.outcome === "succeeded" &&
      request.observation.actionKind === "screenshot" &&
      request.observation.result?.kind === "screenshot"
        ? request.observation.result
        : undefined;
    if (
      (screenshotResult === undefined) !== (request.screenshot === undefined) ||
      (screenshotResult !== undefined &&
        request.screenshot !== undefined &&
        (request.screenshot.metadata.artifactId !==
          screenshotResult.artifactId ||
          request.screenshot.metadata.contentType !==
            screenshotResult.contentType ||
          request.screenshot.metadata.byteSize !== screenshotResult.byteSize ||
          request.screenshot.metadata.checksum !== screenshotResult.checksum))
    ) {
      context.addIssue({
        code: "custom",
        message: "screenshot input must match the current observation",
      });
    }
  });

const BROWSER_INTERACTION_WORKER_SOCKET_PATH =
  "/run/firecrawl-interaction/worker.sock";

const adapterOptionsSchema = z.strictObject({
  socketPath: z.literal(BROWSER_INTERACTION_WORKER_SOCKET_PATH),
  token: z.string().min(32).max(4_096),
});

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const workerErrorEnvelopeSchema = z.strictObject({
  error: z.enum([
    "invalid_request",
    "request_too_large",
    "run_conflict",
    "worker_capacity",
    "codex_timeout",
    "codex_cancelled",
    "codex_protocol_error",
    "codex_failed",
    "cancellation_timeout",
    "cancellation_capacity",
    "internal_error",
    "not_ready",
    "not_found",
    "unauthorized",
  ]),
});
const workerCancellationSuccessSchema = z.strictObject({
  status: z.literal("cancelled"),
});

function mapWorkerFailure(status: number, body: unknown): never {
  const parsed = workerErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new ExecutionAdapterError("adapter_protocol_error");
  }
  const category = parsed.data.error;
  if (status === 504 && category === "codex_timeout") {
    throw new ExecutionAdapterError("timed_out");
  }
  if (status === 504 && category === "cancellation_timeout") {
    throw new ExecutionAdapterError("timed_out");
  }
  if (status === 429 && category === "worker_capacity") {
    throw new ExecutionAdapterError("concurrency_exceeded");
  }
  if (status === 409 && category === "codex_cancelled") {
    throw new ExecutionAdapterError("cancelled");
  }
  if (status === 409 && category === "run_conflict") {
    throw new ExecutionAdapterError("adapter_protocol_error");
  }
  if (status === 502 && category === "codex_protocol_error") {
    throw new ExecutionAdapterError("model_protocol_error");
  }
  if (
    (status === 502 && category === "codex_failed") ||
    (status === 500 && category === "internal_error") ||
    (status === 503 &&
      (category === "not_ready" || category === "cancellation_capacity"))
  ) {
    throw new ExecutionAdapterError("adapter_unavailable");
  }
  if (status === 404 && category === "not_found") {
    throw new ExecutionAdapterError("not_found");
  }
  if (
    (status === 400 && category === "invalid_request") ||
    (status === 413 && category === "request_too_large") ||
    (status === 401 && category === "unauthorized")
  ) {
    throw new ExecutionAdapterError("adapter_protocol_error");
  }
  throw new ExecutionAdapterError("adapter_protocol_error");
}

async function readBoundedJson(response: IncomingMessage): Promise<unknown> {
  const declared = response.headers["content-length"];
  if (
    declared !== undefined &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    response.destroy();
    throw new ExecutionAdapterError("adapter_protocol_error");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        response.destroy();
        throw new ExecutionAdapterError("adapter_protocol_error");
      }
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch (error) {
    if (error instanceof ExecutionAdapterError) throw error;
    throw new ExecutionAdapterError("adapter_protocol_error");
  }
}

function mapRequestError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof ExecutionAdapterError) throw error;
  if (signal?.aborted) {
    const category =
      signal.reason &&
      typeof signal.reason === "object" &&
      (("category" in signal.reason &&
        signal.reason.category === "timed_out") ||
        ("name" in signal.reason && signal.reason.name === "TimeoutError"))
        ? "timed_out"
        : "cancelled";
    throw new ExecutionAdapterError(category);
  }
  throw new ExecutionAdapterError("adapter_unavailable");
}

type WorkerResponse = Readonly<{
  status: number;
  body: unknown;
}>;

function requestWorker(
  options: Readonly<{
    socketPath: string;
    token: string;
    method: "POST" | "DELETE";
    path: string;
    body?: string;
    signal: AbortSignal;
  }>,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const bodyLength =
      options.body === undefined
        ? undefined
        : Buffer.byteLength(options.body, "utf8");
    const request = httpRequest(
      {
        socketPath: options.socketPath,
        path: options.path,
        method: options.method,
        signal: options.signal,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(bodyLength === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(bodyLength),
              }),
        },
      },
      response => {
        const status = response.statusCode;
        if (status === undefined) {
          response.destroy();
          reject(new ExecutionAdapterError("adapter_protocol_error"));
          return;
        }
        void readBoundedJson(response).then(
          body => resolve({ status, body }),
          reject,
        );
      },
    );
    request.once("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** @public Unix-socket client for the constrained Docker interaction worker. */
export function createUnixSocketBrowserExecutionAdapter(options: {
  socketPath: string;
  token: string;
}): BrowserExecutionAdapter {
  const parsed = adapterOptionsSchema.parse({
    socketPath: options.socketPath,
    token: options.token,
  });

  return {
    async requestDecision(input, signal) {
      const request = decisionRequestSchema.parse(input);
      const { screenshot, ...durableRequest } = request;
      const wireRequest =
        screenshot === undefined
          ? durableRequest
          : {
              ...durableRequest,
              image: {
                version: 1,
                artifactId: screenshot.metadata.artifactId,
                contentType: screenshot.metadata.contentType,
                byteSize: screenshot.metadata.byteSize,
                checksum: screenshot.metadata.checksum,
                encoding: "base64",
                data: Buffer.from(screenshot.bytes).toString("base64"),
              },
            };
      const body = JSON.stringify(wireRequest);
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        throw new ExecutionAdapterError("adapter_protocol_error");
      }
      let response: WorkerResponse;
      try {
        response = await requestWorker({
          socketPath: parsed.socketPath,
          token: parsed.token,
          method: "POST",
          path: "/v1/decisions",
          body,
          signal,
        });
      } catch (error) {
        return mapRequestError(error, signal);
      }
      if (response.status < 200 || response.status >= 300) {
        mapWorkerFailure(response.status, response.body);
      }
      return response.body as ModelDecisionEnvelopeV1;
    },

    async cancelExecutionRun(runId) {
      const parsedRunId = runtimeUuidSchema.parse(runId);
      const signal = AbortSignal.timeout(12_000);
      let response: WorkerResponse;
      try {
        response = await requestWorker({
          socketPath: parsed.socketPath,
          token: parsed.token,
          method: "DELETE",
          path: `/v1/runs/${encodeURIComponent(parsedRunId)}`,
          signal,
        });
      } catch (error) {
        return mapRequestError(error, signal);
      }
      if (response.status === 200) {
        if (!workerCancellationSuccessSchema.safeParse(response.body).success) {
          throw new ExecutionAdapterError("adapter_protocol_error");
        }
        return { killed: true };
      }
      mapWorkerFailure(response.status, response.body);
    },
  };
}
