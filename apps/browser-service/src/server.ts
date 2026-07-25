import {
  STATUS_CODES,
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z, type ZodType } from "zod";

import { ActionCacheError } from "./action-cache.js";
import {
  PRIVATE_AUTH_HEADERS,
  PRIVATE_FENCING_HEADERS,
  authorizePrivateRequest,
  type AuthorizedPrivateRequest,
} from "./auth.js";
import {
  MAX_PRIVATE_REQUEST_BYTES,
  MAX_PRIVATE_RESPONSE_BYTES,
  MAX_RECONCILIATION_REFERENCES,
  MAX_REPLAY_REQUEST_BYTES,
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  artifactMetadataV1Schema,
  canonicalUuidSchema,
  closeSessionV1Schema,
  closedSessionV1Schema,
  controlGenerationV1Schema,
  createControlGenerationV1Schema,
  createRelayGrantV1Schema,
  createSessionV1Schema,
  deletedProfileGenerationV1Schema,
  deleteProfileGenerationV1Schema,
  finalizedProfileGenerationV1Schema,
  finalizeProfileGenerationV1Schema,
  liveDiscoveryV1Schema,
  privateErrorV1Schema,
  readyHealthV1Schema,
  reconciliationRequestV1Schema,
  reconciliationResultV1Schema,
  relayGrantV1Schema,
  revokeRelayGrantV1Schema,
  revokedRelayGrantV1Schema,
  scopedLiveHealthV1Schema,
  sessionV1Schema,
  tokenSchema,
  unreadyHealthV1Schema,
  type ReconciliationRequestV1,
} from "./contracts.js";
import { BROWSER_SERVICE_ERROR_STATUS, BrowserServiceError } from "./errors.js";
import { ProfileStoreError, type ProfileStore } from "./profile-store.js";
import type { InternalReconciliationOutcome } from "./reconciliation.js";
import {
  SessionRegistryError,
  type SessionRegistry,
} from "./session-registry.js";
import { STREAM_LIMITS, type RelayGrantManager } from "./streams.js";
import type {
  ControlGenerationBinding,
  ControlGenerationDrainAdmission,
  InternalStartupAdmission,
  ReconciliationExecutionAdmission,
} from "./startup-state.js";
import { artifactMetadataHeaders, type ArtifactService } from "./artifacts.js";

export const RELAY_TOKEN_HEADER = "x-firecrawl-relay-token";

const RECONCILIATION_DEADLINE_MS = 60_000;
const ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  browser_unavailable: 503,
  replay_unavailable: 409,
  replay_unsupported: 409,
  concurrency_exceeded: 429,
  session_not_found: 404,
  profile_prepare_failed: 503,
  profile_finalize_failed: 409,
  profile_discard_failed: 409,
});

type ProfileTransport = Pick<
  ProfileStore,
  | "finalizePreparedGenerationByAuthorization"
  | "deletePreparedGenerationByAuthorization"
>;

export type BrowserGenerationRuntime = Readonly<{
  binding: ControlGenerationBinding;
  fenceRouteAdmission(): void;
  registry: SessionRegistry;
  grants: RelayGrantManager;
  artifacts: ArtifactService;
  profileStore: ProfileTransport;
}>;

export type BrowserServiceServerOptions = Readonly<{
  apiKey: string;
  admission: InternalStartupAdmission;
  runtime: Readonly<{
    current(): BrowserGenerationRuntime | null;
    release(runtime: BrowserGenerationRuntime): void;
  }>;
  reconcile(
    request: ReconciliationRequestV1,
    admission: ReconciliationExecutionAdmission,
    correlationId: string,
  ): Promise<InternalReconciliationOutcome>;
  internalErrorSink?(cause: unknown): void;
  sweepIntervalMs?: number;
}>;

export type BrowserServiceServer = Readonly<{
  listen(port: number, host?: string): Promise<AddressInfo>;
  beginShutdown(): Promise<void>;
  listenerClosed(): Promise<void>;
  address(): AddressInfo | null;
}>;

type RequestContext = Readonly<{
  authorization: AuthorizedPrivateRequest;
  binding: ControlGenerationBinding;
  runtime: BrowserGenerationRuntime;
}>;

type ErrorEnvelope = Readonly<{
  status: number;
  body: { version: 1; category: string; message: string };
}>;

class ResponseSerializationError extends Error {}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length > 1) {
    throw new BrowserServiceError(
      "invalid_request",
      `duplicate ${name} header`,
    );
  }
  return values[0];
}

function authorize(
  request: IncomingMessage,
  apiKey: string,
): AuthorizedPrivateRequest {
  return authorizePrivateRequest(
    {
      authorization: singleHeader(request, PRIVATE_AUTH_HEADERS.authorization),
      correlationId: singleHeader(request, PRIVATE_AUTH_HEADERS.correlationId),
      deadline: singleHeader(request, PRIVATE_AUTH_HEADERS.deadline),
    },
    apiKey,
  );
}

function fencing(request: IncomingMessage): ControlGenerationBinding {
  try {
    return {
      processNonce: tokenSchema.parse(
        singleHeader(request, PRIVATE_FENCING_HEADERS.processNonce),
      ),
      controlGenerationNonce: tokenSchema.parse(
        singleHeader(request, PRIVATE_FENCING_HEADERS.controlGenerationNonce),
      ),
    };
  } catch (cause) {
    if (cause instanceof BrowserServiceError) throw cause;
    throw new BrowserServiceError(
      "invalid_request",
      "invalid generation fencing headers",
    );
  }
}

function sameBinding(
  left: ControlGenerationBinding,
  right: ControlGenerationBinding,
): boolean {
  return (
    left.processNonce === right.processNonce &&
    left.controlGenerationNonce === right.controlGenerationNonce
  );
}

function isProvenNoEffectActionError(cause: unknown): boolean {
  if (cause instanceof ActionCacheError) return true;
  if (cause instanceof BrowserServiceError) return true;
  return (
    cause instanceof SessionRegistryError &&
    (cause.category === "invalid_request" ||
      cause.category === "concurrency_exceeded" ||
      cause.category === "session_not_found")
  );
}

function safeMessage(value: unknown): string {
  const message =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "browser unavailable";
  let safe = "";
  for (const character of Array.from(message)) {
    const code = character.codePointAt(0) ?? 0;
    safe += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
    if (Array.from(safe).length >= 1_024) break;
  }
  return safe;
}

function errorEnvelope(cause: unknown): ErrorEnvelope {
  let category: string;
  let message: string;
  let status: number;
  if (cause instanceof BrowserServiceError) {
    category = cause.category;
    message = cause.message;
    status = cause.statusCode;
  } else if (
    cause instanceof SessionRegistryError ||
    cause instanceof ProfileStoreError
  ) {
    category = cause.category;
    message = safeMessage(cause);
    status =
      (ERROR_STATUS as Readonly<Record<string, number>>)[category] ?? 503;
  } else if (cause instanceof z.ZodError || cause instanceof SyntaxError) {
    category = "invalid_request";
    message = "invalid private request";
    status = BROWSER_SERVICE_ERROR_STATUS.invalid_request;
  } else {
    category = "browser_unavailable";
    message = "browser unavailable";
    status = BROWSER_SERVICE_ERROR_STATUS.browser_unavailable;
  }
  const candidate = {
    version: 1 as const,
    category,
    message: safeMessage(message),
  };
  const parsed = privateErrorV1Schema.safeParse(candidate);
  return Object.freeze({
    status,
    body: parsed.success
      ? parsed.data
      : {
          version: 1 as const,
          category: "browser_unavailable",
          message: "browser unavailable",
        },
  });
}

function encodeJson(
  schema: ZodType,
  value: unknown,
  maximumBytes: number,
): string {
  let parsed: unknown;
  let encoded: string;
  try {
    parsed = schema.parse(value);
    encoded = JSON.stringify(parsed);
  } catch (cause) {
    throw new ResponseSerializationError("response serialization failed", {
      cause,
    });
  }
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new ResponseSerializationError("response exceeds its byte limit");
  }
  return encoded;
}

function writeJson(
  response: ServerResponse,
  status: number,
  schema: ZodType,
  value: unknown,
  maximumBytes = MAX_PRIVATE_RESPONSE_BYTES,
): void {
  const encoded = encodeJson(schema, value, maximumBytes);
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(encoded, "utf8"));
  response.end(encoded);
}

async function writeJsonConfirmed(
  response: ServerResponse,
  status: number,
  schema: ZodType,
  value: unknown,
): Promise<boolean> {
  const encoded = encodeJson(schema, value, MAX_PRIVATE_RESPONSE_BYTES);
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(encoded, "utf8"));
  return new Promise<boolean>((resolve) => {
    const settle = (delivered: boolean): void => {
      response.off("finish", onFinish);
      response.off("close", onClose);
      response.off("error", onError);
      resolve(delivered);
    };
    const onFinish = (): void => settle(true);
    const onClose = (): void => settle(response.writableFinished);
    const onError = (): void => settle(false);
    response.once("finish", onFinish);
    response.once("close", onClose);
    response.once("error", onError);
    response.end(encoded);
  });
}

function writeError(response: ServerResponse, cause: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const error = errorEnvelope(cause);
  try {
    writeJson(
      response,
      error.status,
      privateErrorV1Schema,
      error.body,
      4 * 1024,
    );
  } catch {
    response.destroy();
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Readonly<{ value: unknown; bytes: number }>> {
  const contentType = singleHeader(request, "content-type");
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new BrowserServiceError(
      "invalid_request",
      "content type must be application/json",
    );
  }
  if (singleHeader(request, "content-encoding") !== undefined) {
    throw new BrowserServiceError(
      "invalid_request",
      "encoded request bodies are unsupported",
    );
  }
  const declared = singleHeader(request, "content-length");
  if (declared !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared)) {
      throw new BrowserServiceError(
        "invalid_request",
        "invalid content length",
      );
    }
    if (Number(declared) > maximumBytes) {
      throw new BrowserServiceError(
        "request_too_large",
        "private request exceeds its byte limit",
      );
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) {
      throw new BrowserServiceError(
        "request_too_large",
        "private request exceeds its byte limit",
      );
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new BrowserServiceError("invalid_request", "request body is empty");
  }
  try {
    return Object.freeze({
      value: JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")),
      bytes,
    });
  } catch {
    throw new BrowserServiceError(
      "invalid_request",
      "request body is invalid JSON",
    );
  }
}

function canonicalParameter(
  value: string | string[] | undefined,
  label: string,
): string {
  try {
    return canonicalUuidSchema.parse(value);
  } catch {
    throw new BrowserServiceError("invalid_request", `${label} is invalid`);
  }
}

function ensureRepeatedId(
  routeValue: string,
  bodyValue: string,
  label: string,
): void {
  if (routeValue !== bodyValue) {
    throw new BrowserServiceError("invalid_request", `${label} does not match`);
  }
}

function requestAbort(
  request: IncomingMessage,
  response: ServerResponse,
  externalSignal?: AbortSignal,
): Readonly<{ signal: AbortSignal; cleanup(): void }> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const abortExternally = (): void => {
    controller.abort();
    if (!request.destroyed) request.destroy();
    if (!response.writableEnded) response.destroy();
  };
  const close = (): void => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abort);
  request.socket.once("close", abort);
  response.once("close", close);
  if (externalSignal?.aborted) abortExternally();
  else {
    externalSignal?.addEventListener("abort", abortExternally, { once: true });
  }
  return Object.freeze({
    signal: controller.signal,
    cleanup() {
      request.off("aborted", abort);
      request.socket.off("close", abort);
      response.off("close", close);
      externalSignal?.removeEventListener("abort", abortExternally);
    },
  });
}

function boundedReconciliationAdmission(
  admission: ReconciliationExecutionAdmission,
  transportSignal: AbortSignal,
  deadlineAtMs: number,
): Readonly<{
  admission: ReconciliationExecutionAdmission;
  cleanup(): void;
}> {
  const controller = new AbortController();
  let deadlineExpired = Date.now() >= deadlineAtMs;
  const abortForDeadline = (): void => {
    deadlineExpired = true;
    controller.abort();
  };
  const abort = (): void => controller.abort();
  const remainingMs = Math.max(0, deadlineAtMs - Date.now());
  const timer = setTimeout(abortForDeadline, remainingMs);
  timer.unref();
  if (admission.signal.aborted || transportSignal.aborted) controller.abort();
  else {
    admission.signal.addEventListener("abort", abort, { once: true });
    transportSignal.addEventListener("abort", abort, { once: true });
  }
  return Object.freeze({
    admission: Object.freeze({
      signal: controller.signal,
      assertAdmitted(): void {
        if (deadlineExpired || Date.now() >= deadlineAtMs) {
          abortForDeadline();
          throw new BrowserServiceError(
            "reconciliation_deadline_exceeded",
            "reconciliation deadline exceeded",
          );
        }
        if (transportSignal.aborted) {
          throw new BrowserServiceError(
            "reconciliation_required",
            "reconciliation transport is unavailable",
          );
        }
        admission.assertAdmitted();
      },
    }),
    cleanup() {
      clearTimeout(timer);
      admission.signal.removeEventListener("abort", abort);
      transportSignal.removeEventListener("abort", abort);
    },
  });
}

export function createBrowserServiceServer(
  options: BrowserServiceServerOptions,
): BrowserServiceServer {
  const app = express();
  app.disable("x-powered-by");
  const httpServer = createHttpServer(app);
  const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: STREAM_LIMITS.cdpFrameBytes,
  });
  const sweepIntervalMs = options.sweepIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs <= 0) {
    throw new RangeError("sweepIntervalMs must be a positive safe integer");
  }
  let accepting = true;
  let listening = false;
  let shutdownPromise: Promise<void> | undefined;
  let listenerClosePromise: Promise<void> = Promise.resolve();
  let resolveListenerClosed: (() => void) | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let activeRequests = 0;
  const shutdownController = new AbortController();
  const requestWaiters = new Set<() => void>();
  const grantIdsBySession = new Map<string, Set<string>>();

  const signalRequestSettled = (): void => {
    if (activeRequests !== 0) return;
    for (const resolve of requestWaiters) resolve();
    requestWaiters.clear();
  };
  const waitForRequests = (): Promise<void> =>
    activeRequests === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => requestWaiters.add(resolve));

  const currentRuntime = (
    request: IncomingMessage,
    authorization: AuthorizedPrivateRequest,
  ): RequestContext => {
    const binding = fencing(request);
    options.admission.requireReady(binding);
    const runtime = options.runtime.current();
    if (runtime === null) {
      throw new BrowserServiceError(
        "browser_unavailable",
        "generation runtime is unavailable",
      );
    }
    if (!sameBinding(runtime.binding, binding)) {
      throw new BrowserServiceError(
        "control_generation_mismatch",
        "generation runtime does not match",
      );
    }
    return Object.freeze({ authorization, binding, runtime });
  };

  const drainCurrentRuntime = async (
    reason: "handoff" | "shutdown",
    admission?: ControlGenerationDrainAdmission,
  ): Promise<void> => {
    const runtime = options.runtime.current();
    if (runtime === null) return;
    runtime.fenceRouteAdmission();
    const failures: unknown[] = [];
    try {
      await runtime.grants.drain();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      runtime.artifacts.drainAll();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      await runtime.registry.drainAll(reason, admission);
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length !== 0) {
      throw new BrowserServiceError(
        "browser_unavailable",
        "generation runtime drain is unverified",
        { detail: "close_failed" },
      );
    }
    grantIdsBySession.clear();
    options.runtime.release(runtime);
  };

  const failStopAmbiguousAction = async (
    context: RequestContext,
    runtimeSessionId: string,
  ): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await context.runtime.registry.close(runtimeSessionId, "error");
    } catch (cause) {
      failures.push(cause);
    }
    for (const grantId of grantIdsBySession.get(runtimeSessionId) ?? []) {
      try {
        await context.runtime.grants.revoke(runtimeSessionId, {
          version: 1,
          grantId,
        });
      } catch (cause) {
        failures.push(cause);
      }
    }
    grantIdsBySession.delete(runtimeSessionId);
    try {
      context.runtime.artifacts.releaseSession({
        ...context.binding,
        runtimeSessionId,
      });
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length !== 0) {
      throw new AggregateError(
        failures,
        "ambiguous action cleanup is unverified",
      );
    }
  };

  const route = (
    handler: (request: Request, response: Response) => Promise<void>,
  ): RequestHandler => {
    return (request, response) => {
      if (!accepting) {
        writeError(
          response,
          new BrowserServiceError(
            "browser_unavailable",
            "browser server is shutting down",
          ),
        );
        return;
      }
      activeRequests += 1;
      void handler(request, response)
        .catch((cause) => writeError(response, cause))
        .finally(() => {
          activeRequests -= 1;
          signalRequestSettled();
        });
    };
  };

  app.get(
    "/health/live",
    route(async (request, response) => {
      authorize(request, options.apiKey);
      const processHeader = singleHeader(
        request,
        PRIVATE_FENCING_HEADERS.processNonce,
      );
      const generationHeader = singleHeader(
        request,
        PRIVATE_FENCING_HEADERS.controlGenerationNonce,
      );
      if (processHeader === undefined && generationHeader === undefined) {
        writeJson(
          response,
          200,
          liveDiscoveryV1Schema,
          options.admission.liveHealth(),
          4 * 1024,
        );
        return;
      }
      const binding = fencing(request);
      const health = options.admission.scopedLiveHealth(binding);
      writeJson(response, 200, scopedLiveHealthV1Schema, health, 4 * 1024);
    }),
  );

  app.post(
    "/v1/control-generations",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const transport = requestAbort(
        request,
        response,
        shutdownController.signal,
      );
      try {
        const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
        const input = createControlGenerationV1Schema.parse(body.value);
        const result = await options.admission.createControlGeneration(
          input,
          {
            transportSignal: transport.signal,
            deadlineAtMs: Math.min(
              authorization.deadline.getTime(),
              Date.now() + RECONCILIATION_DEADLINE_MS,
            ),
          },
          (admission) => drainCurrentRuntime("handoff", admission),
        );
        writeJson(response, 201, controlGenerationV1Schema, result);
      } finally {
        transport.cleanup();
      }
    }),
  );

  app.get(
    "/health/ready",
    route(async (request, response) => {
      authorize(request, options.apiKey);
      const binding = fencing(request);
      options.admission.scopedLiveHealth(binding);
      const health = options.admission.readyHealth();
      writeJson(
        response,
        health.status === "ready" ? 200 : 503,
        health.status === "ready" ? readyHealthV1Schema : unreadyHealthV1Schema,
        health,
        4 * 1024,
      );
    }),
  );

  app.post(
    "/v1/reconciliation",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const binding = fencing(request);
      options.admission.scopedLiveHealth(binding);
      const transport = requestAbort(
        request,
        response,
        shutdownController.signal,
      );
      try {
        let body: Awaited<ReturnType<typeof readJsonBody>>;
        try {
          body = await readJsonBody(request, MAX_REPLAY_REQUEST_BYTES);
        } catch (cause) {
          if (
            cause instanceof BrowserServiceError &&
            cause.category === "request_too_large"
          ) {
            throw new BrowserServiceError(
              "reconciliation_snapshot_too_large",
              "reconciliation snapshot exceeds its limit",
            );
          }
          if (
            cause instanceof BrowserServiceError &&
            cause.category === "invalid_request"
          ) {
            throw new BrowserServiceError(
              "reconciliation_snapshot_invalid",
              "reconciliation snapshot is invalid",
            );
          }
          throw cause;
        }
        if (
          body.value !== null &&
          typeof body.value === "object" &&
          Array.isArray((body.value as { references?: unknown }).references) &&
          (body.value as { references: unknown[] }).references.length >
            MAX_RECONCILIATION_REFERENCES
        ) {
          throw new BrowserServiceError(
            "reconciliation_snapshot_too_large",
            "reconciliation snapshot exceeds its limit",
          );
        }
        let input: ReconciliationRequestV1;
        try {
          input = reconciliationRequestV1Schema.parse(body.value);
        } catch {
          throw new BrowserServiceError(
            "reconciliation_snapshot_invalid",
            "reconciliation snapshot is invalid",
          );
        }
        if (binding.processNonce !== input.processNonce) {
          throw new BrowserServiceError(
            "reconciliation_nonce_mismatch",
            "reconciliation process binding does not match",
          );
        }
        if (binding.controlGenerationNonce !== input.controlGenerationNonce) {
          throw new BrowserServiceError(
            "control_generation_mismatch",
            "reconciliation generation binding does not match",
          );
        }
        const deadlineAtMs = Math.min(
          authorization.deadline.getTime(),
          Date.now() + RECONCILIATION_DEADLINE_MS,
        );
        const result = await options.admission.reconcileWithAuthority(
          input,
          async (requestValue, admission) => {
            const bounded = boundedReconciliationAdmission(
              admission,
              transport.signal,
              deadlineAtMs,
            );
            try {
              bounded.admission.assertAdmitted();
              return await options.reconcile(
                requestValue,
                bounded.admission,
                authorization.correlationId,
              );
            } finally {
              bounded.cleanup();
            }
          },
        );
        writeJson(
          response,
          200,
          reconciliationResultV1Schema,
          result,
          4 * 1024,
        );
      } finally {
        transport.cleanup();
      }
    }),
  );

  app.post(
    "/v1/sessions",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const body = await readJsonBody(request, MAX_REPLAY_REQUEST_BYTES);
      const input = createSessionV1Schema.parse(body.value);
      if (input.replay === null && body.bytes > MAX_PRIVATE_REQUEST_BYTES) {
        throw new BrowserServiceError(
          "request_too_large",
          "session request exceeds its byte limit",
        );
      }
      const result = await context.runtime.registry.create(input);
      try {
        writeJson(response, 201, sessionV1Schema, result);
      } catch (cause) {
        await context.runtime.registry
          .close(result.runtimeSessionId, "error")
          .catch(() => undefined);
        response.destroy();
        if (!(cause instanceof ResponseSerializationError)) throw cause;
      }
    }),
  );

  app.get(
    "/v1/sessions/:runtimeSessionId",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const runtimeSessionId = canonicalParameter(
        request.params.runtimeSessionId,
        "runtime session ID",
      );
      const result = context.runtime.registry.touch(runtimeSessionId);
      writeJson(response, 200, sessionV1Schema, result);
    }),
  );

  app.delete(
    "/v1/sessions/:runtimeSessionId",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const runtimeSessionId = canonicalParameter(
        request.params.runtimeSessionId,
        "runtime session ID",
      );
      const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
      const input = closeSessionV1Schema.parse(body.value);
      const active = context.runtime.registry.get(runtimeSessionId);
      if (
        active !== undefined &&
        active.sessionVersion !== input.expectedSessionVersion
      ) {
        throw new SessionRegistryError(
          "concurrency_exceeded",
          "session version does not match",
        );
      }
      const result = await context.runtime.registry.close(
        runtimeSessionId,
        input.reason,
      );
      for (const grantId of grantIdsBySession.get(runtimeSessionId) ?? []) {
        await context.runtime.grants.revoke(runtimeSessionId, {
          version: 1,
          grantId,
        });
      }
      grantIdsBySession.delete(runtimeSessionId);
      context.runtime.artifacts.releaseSession({
        ...context.binding,
        runtimeSessionId,
      });
      writeJson(response, 200, closedSessionV1Schema, result);
    }),
  );

  app.post(
    "/v1/sessions/:runtimeSessionId/actions",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const runtimeSessionId = canonicalParameter(
        request.params.runtimeSessionId,
        "runtime session ID",
      );
      const transport = requestAbort(
        request,
        response,
        shutdownController.signal,
      );
      try {
        const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
        const input = actionExecutionRequestSchema.parse(body.value);
        if (transport.signal.aborted) return;
        const failStopAndDestroy = async (primary: unknown): Promise<void> => {
          let internalFailure = primary;
          try {
            await failStopAmbiguousAction(context, runtimeSessionId);
          } catch (cleanupFailure) {
            internalFailure = new AggregateError(
              [primary, cleanupFailure],
              "ambiguous action and cleanup failed",
            );
          } finally {
            response.destroy();
          }
          try {
            options.internalErrorSink?.(internalFailure);
          } catch {
            // Diagnostics cannot alter fail-stop transport behavior.
          }
        };
        try {
          const result = await context.runtime.registry.executeAction(
            runtimeSessionId,
            input,
          );
          if (transport.signal.aborted) {
            await failStopAndDestroy(
              new Error("action response transport closed after dispatch"),
            );
            return;
          }
          try {
            const delivered = await writeJsonConfirmed(
              response,
              200,
              actionExecutionResultSchema,
              result,
            );
            if (!delivered || transport.signal.aborted) {
              await failStopAndDestroy(
                new Error("action response transport closed after dispatch"),
              );
            }
          } catch (cause) {
            await failStopAndDestroy(cause);
          }
        } catch (cause) {
          if (isProvenNoEffectActionError(cause)) {
            if (transport.signal.aborted) response.destroy();
            else throw cause;
            return;
          }
          await failStopAndDestroy(cause);
        }
      } finally {
        transport.cleanup();
      }
    }),
  );

  app.post(
    "/v1/sessions/:runtimeSessionId/grants",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const runtimeSessionId = canonicalParameter(
        request.params.runtimeSessionId,
        "runtime session ID",
      );
      const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
      const input = createRelayGrantV1Schema.parse(body.value);
      await context.runtime.registry.extendAuthority(
        runtimeSessionId,
        input.expectedSessionVersion,
        input.allowedDomains,
      );
      const result = context.runtime.grants.create(runtimeSessionId, input);
      let grants = grantIdsBySession.get(runtimeSessionId);
      if (grants === undefined) {
        grants = new Set();
        grantIdsBySession.set(runtimeSessionId, grants);
      }
      grants.add(input.grantId);
      writeJson(response, 201, relayGrantV1Schema, result);
    }),
  );

  app.delete(
    "/v1/sessions/:runtimeSessionId/grants/:grantId",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const runtimeSessionId = canonicalParameter(
        request.params.runtimeSessionId,
        "runtime session ID",
      );
      const grantId = canonicalParameter(request.params.grantId, "grant ID");
      const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
      const input = revokeRelayGrantV1Schema.parse(body.value);
      ensureRepeatedId(grantId, input.grantId, "grant ID");
      const result = await context.runtime.grants.revoke(
        runtimeSessionId,
        input,
      );
      grantIdsBySession.get(runtimeSessionId)?.delete(grantId);
      writeJson(response, 200, revokedRelayGrantV1Schema, result);
    }),
  );

  app.post(
    "/v1/sessions/:runtimeSessionId/artifacts",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const runtimeSessionId = canonicalParameter(
        request.params.runtimeSessionId,
        "runtime session ID",
      );
      const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
      const transport = requestAbort(request, response);
      try {
        const artifact = await context.runtime.artifacts.capture(
          { ...context.binding, runtimeSessionId },
          body.value,
          { signal: transport.signal },
        );
        const metadata = artifactMetadataV1Schema.parse(artifact.metadata);
        response.statusCode = 200;
        response.setHeader("cache-control", "no-store");
        for (const [name, value] of Object.entries(
          artifactMetadataHeaders(metadata),
        )) {
          response.setHeader(name, value);
        }
        await pipeline(artifact.stream, response);
      } finally {
        transport.cleanup();
      }
    }),
  );

  app.post(
    "/v1/profile-generations/:generationId/finalize",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const generationId = canonicalParameter(
        request.params.generationId,
        "profile generation ID",
      );
      const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
      const input = finalizeProfileGenerationV1Schema.parse(body.value);
      ensureRepeatedId(generationId, input.generationId, "generation ID");
      const result =
        await context.runtime.profileStore.finalizePreparedGenerationByAuthorization(
          input,
        );
      writeJson(response, 200, finalizedProfileGenerationV1Schema, result);
    }),
  );

  app.delete(
    "/v1/profile-generations/:generationId",
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const context = currentRuntime(request, authorization);
      const generationId = canonicalParameter(
        request.params.generationId,
        "profile generation ID",
      );
      const body = await readJsonBody(request, MAX_PRIVATE_REQUEST_BYTES);
      const input = deleteProfileGenerationV1Schema.parse(body.value);
      ensureRepeatedId(generationId, input.generationId, "generation ID");
      const result =
        await context.runtime.profileStore.deletePreparedGenerationByAuthorization(
          input,
        );
      writeJson(response, 200, deletedProfileGenerationV1Schema, result);
    }),
  );

  app.use(
    route(async (request, response) => {
      const authorization = authorize(request, options.apiKey);
      const pathname = new URL(request.originalUrl, "http://browser.invalid")
        .pathname;
      const isBootstrapRoute =
        (request.method === "GET" && pathname === "/health/live") ||
        (request.method === "POST" && pathname === "/v1/control-generations");
      if (pathname === "/health/ready" || pathname === "/v1/reconciliation") {
        options.admission.scopedLiveHealth(fencing(request));
      } else if (!isBootstrapRoute) {
        currentRuntime(request, authorization);
      }
      writeError(
        response,
        new BrowserServiceError("invalid_request", "private route not found"),
      );
    }),
  );

  const writeUpgradeFailure = (socket: Duplex, cause: unknown): void => {
    const error = errorEnvelope(cause);
    const body = encodeJson(privateErrorV1Schema, error.body, 4 * 1024);
    const reason = STATUS_CODES[error.status] ?? "Error";
    socket.end(
      `HTTP/1.1 ${error.status} ${reason}\r\n` +
        "Connection: close\r\n" +
        "Cache-Control: no-store\r\n" +
        "Content-Type: application/json; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n` +
        body,
    );
  };

  httpServer.on("upgrade", (request, socket, head) => {
    void (async () => {
      let upgraded = false;
      try {
        if (!accepting) {
          throw new BrowserServiceError(
            "browser_unavailable",
            "browser server is shutting down",
          );
        }
        const authorization = authorize(request, options.apiKey);
        const context = currentRuntime(request, authorization);
        const url = new URL(request.url ?? "", "http://browser.invalid");
        if (url.search !== "") {
          throw new BrowserServiceError(
            "invalid_request",
            "stream query parameters are forbidden",
          );
        }
        const match =
          /^\/v1\/sessions\/([0-9a-f-]+)\/streams\/(passive|interactive|cdp)$/.exec(
            url.pathname,
          );
        if (match === null) {
          throw new BrowserServiceError(
            "invalid_request",
            "private stream route is invalid",
          );
        }
        const runtimeSessionId = canonicalParameter(
          match[1],
          "runtime session ID",
        );
        const permission = match[2] as "passive" | "interactive" | "cdp";
        const relayToken = tokenSchema.parse(
          singleHeader(request, RELAY_TOKEN_HEADER),
        );
        await context.runtime.grants.open(
          {
            runtimeSessionId,
            permission,
            relayToken,
            authority: {
              processNonce: context.binding.processNonce,
              controlGenerationNonce: context.binding.controlGenerationNonce,
              authBinding: options.apiKey,
            },
          },
          () =>
            new Promise<WebSocket>((resolve, reject) => {
              try {
                websocketServer.handleUpgrade(
                  request,
                  socket,
                  head,
                  (websocket) => {
                    websocket.on("error", () => undefined);
                    upgraded = true;
                    resolve(websocket);
                  },
                );
              } catch (cause) {
                reject(cause);
              }
            }),
        );
      } catch (cause) {
        if (!upgraded && !socket.destroyed) writeUpgradeFailure(socket, cause);
      }
    })();
  });

  const server: BrowserServiceServer = Object.freeze({
    async listen(port, host = "127.0.0.1") {
      if (!accepting || listening) {
        throw new BrowserServiceError(
          "browser_unavailable",
          "browser listener is unavailable",
        );
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (cause: Error): void => {
          httpServer.off("listening", onListening);
          reject(cause);
        };
        const onListening = (): void => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, host);
      });
      listening = true;
      sweepTimer = setInterval(() => {
        const runtime = options.runtime.current();
        if (runtime === null) return;
        runtime.grants.sweepExpired();
        runtime.artifacts.sweepExpired();
        void runtime.registry.sweepExpired().catch(() => undefined);
        void runtime.registry.sweepCleanupFailed().catch(() => undefined);
      }, sweepIntervalMs);
      sweepTimer.unref();
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        throw new BrowserServiceError(
          "browser_unavailable",
          "browser listener address is unavailable",
        );
      }
      return address;
    },
    beginShutdown() {
      if (shutdownPromise !== undefined) return shutdownPromise;
      accepting = false;
      options.runtime.current()?.fenceRouteAdmission();
      options.admission.beginDraining();
      shutdownController.abort();
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      listenerClosePromise = new Promise<void>((resolve) => {
        resolveListenerClosed = resolve;
      });
      let physicalClose: Promise<void>;
      if (listening) {
        physicalClose = new Promise<void>((resolve, reject) => {
          httpServer.close((cause) => {
            if (cause === undefined) resolve();
            else reject(cause);
          });
        });
        resolveListenerClosed?.();
      } else {
        physicalClose = Promise.resolve();
        resolveListenerClosed?.();
      }
      shutdownPromise = (async () => {
        let failure: unknown;
        try {
          await waitForRequests();
          await drainCurrentRuntime("shutdown");
          await options.admission.closeInstalledAuthority();
        } catch (cause) {
          failure = cause;
        }
        try {
          await physicalClose;
        } catch (cause) {
          failure ??= cause;
        }
        if (failure !== undefined) throw failure;
      })();
      return shutdownPromise;
    },
    listenerClosed() {
      return listenerClosePromise;
    },
    address() {
      const address = httpServer.address();
      return address === null || typeof address === "string" ? null : address;
    },
  });
  return server;
}
