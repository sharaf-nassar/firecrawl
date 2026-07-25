import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import WebSocket, { type ClientOptions } from "ws";
import type { z } from "zod";

import {
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  API_PRIVATE_ROUTE_CONTRACTS,
  ARTIFACT_METADATA_HEADERS,
  artifactMetadataV1Schema,
  AUTH_DEADLINE_MAX_MS,
  BROWSER_SERVICE_ERROR_STATUS,
  canonicalUuidSchema,
  closeSessionV1Schema,
  closedSessionV1Schema,
  controlGenerationV1Schema,
  createControlGenerationV1Schema,
  createRelayGrantV1Schema,
  createSessionV1Schema,
  deleteProfileGenerationV1Schema,
  deletedProfileGenerationV1Schema,
  fetchArtifactV1Schema,
  finalizeProfileGenerationV1Schema,
  finalizedProfileGenerationV1Schema,
  liveDiscoveryV1Schema,
  privateErrorV1Schema,
  PRIVATE_AUTH_HEADERS,
  PRIVATE_FENCING_HEADERS,
  readyHealthV1Schema,
  reconciliationResultV1Schema,
  relayGrantV1Schema,
  revokeRelayGrantV1Schema,
  revokedRelayGrantV1Schema,
  scopedLiveHealthV1Schema,
  sessionV1Schema,
  tokenSchema,
  unreadyHealthV1Schema,
  type ArtifactMetadataV1,
  type BrowserActionExecutionResultV1,
  type BrowserActionExecutionV1,
  type ClosedSessionV1,
  type ControlGenerationV1,
  type CreateControlGenerationV1,
  type CreateRelayGrantV1,
  type CreateSessionV1,
  type DeleteProfileGenerationV1,
  type DeletedProfileGenerationV1,
  type FetchArtifactV1,
  type FinalizeProfileGenerationV1,
  type FinalizedProfileGenerationV1,
  type LiveDiscoveryV1,
  type ReadyHealthV1,
  type ReconciliationResultV1,
  type RelayGrantV1,
  type RevokeRelayGrantV1,
  type RevokedRelayGrantV1,
  type ScopedLiveHealthV1,
  type SessionV1,
  type UnreadyHealthV1,
} from "./browser-service-contracts";

const MAX_ERROR_BYTES = 4 * 1024;
const RELAY_TOKEN_HEADER = "x-firecrawl-relay-token";
const JSON_CONTENT_TYPE = "application/json";

function requireHttpRoute(route: (typeof API_PRIVATE_ROUTE_CONTRACTS)[number]) {
  if (route.method === "WS" || route.responseBytes === null) {
    throw new TypeError("API private HTTP route inventory is invalid");
  }
  return {
    ...route,
    method: route.method,
    responseBytes: route.responseBytes,
  };
}

const PRIVATE_ROUTES = {
  createControlGeneration: API_PRIVATE_ROUTE_CONTRACTS[0],
  createSession: API_PRIVATE_ROUTE_CONTRACTS[1],
  getSession: API_PRIVATE_ROUTE_CONTRACTS[2],
  closeSession: API_PRIVATE_ROUTE_CONTRACTS[3],
  executeAction: API_PRIVATE_ROUTE_CONTRACTS[4],
  createRelayGrant: API_PRIVATE_ROUTE_CONTRACTS[5],
  revokeRelayGrant: API_PRIVATE_ROUTE_CONTRACTS[6],
  fetchArtifact: API_PRIVATE_ROUTE_CONTRACTS[7],
  finalizeProfile: API_PRIVATE_ROUTE_CONTRACTS[8],
  discardProfile: API_PRIVATE_ROUTE_CONTRACTS[9],
  reconcile: API_PRIVATE_ROUTE_CONTRACTS[10],
  passiveStream: API_PRIVATE_ROUTE_CONTRACTS[11],
  interactiveStream: API_PRIVATE_ROUTE_CONTRACTS[12],
  cdpStream: API_PRIVATE_ROUTE_CONTRACTS[13],
  live: requireHttpRoute(API_PRIVATE_ROUTE_CONTRACTS[14]),
  ready: requireHttpRoute(API_PRIVATE_ROUTE_CONTRACTS[15]),
} as const;

function routePath(
  template: string,
  parameters: Readonly<Record<string, string>> = {},
): string {
  let path = template;
  for (const [name, value] of Object.entries(parameters)) {
    path = path.replace(`:${name}`, value);
  }
  if (path.includes(":")) throw protocolError();
  return path;
}

/** @public */
export type BrowserServiceBootstrapRequestContext = {
  correlationId: string;
  deadline: Date;
  signal: AbortSignal;
};

/** @public */
export type BrowserServiceControlBinding = {
  processNonce: string;
  controlGenerationNonce: string;
};

/** @public */
export type BrowserServiceRequestContext =
  BrowserServiceBootstrapRequestContext & BrowserServiceControlBinding;

/** @public */
export type BrowserArtifact = {
  metadata: ArtifactMetadataV1;
  bytes: Uint8Array;
};

/** @public */
export class BrowserServiceClientError extends Error {
  constructor(
    public readonly category: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BrowserServiceClientError";
  }
}

type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

/** @public */
export type BrowserServiceClientOptions = {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  reconciliationTimeoutMs: number;
  onControlGenerationMismatch: (
    rejectedBinding: BrowserServiceControlBinding,
  ) => void;
  fetch?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
};

/** @public */
export const API_INSTANCE_ID = randomUUID();

/** @public */
export function createHandoffIdempotencyKey(): string {
  return randomBytes(32).toString("base64url");
}

function protocolError(): BrowserServiceClientError {
  return new BrowserServiceClientError(
    "browser_service_protocol_error",
    "Browser Service returned an invalid private response",
  );
}

function unavailableError(): BrowserServiceClientError {
  return new BrowserServiceClientError(
    "browser_service_unavailable",
    "Browser Service is unavailable",
  );
}

function validatePrivateErrorStatus(
  error: z.infer<typeof privateErrorV1Schema>,
  status: number | undefined,
): void {
  if (
    status === undefined ||
    !Object.hasOwn(BROWSER_SERVICE_ERROR_STATUS, error.category) ||
    BROWSER_SERVICE_ERROR_STATUS[
      error.category as keyof typeof BROWSER_SERVICE_ERROR_STATUS
    ] !== status
  ) {
    throw protocolError();
  }
}

function encodeJson<T>(
  schema: z.ZodType<T>,
  input: unknown,
  maximumBytes: number,
): string {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw protocolError();
  let body: string;
  try {
    body = JSON.stringify(parsed.data);
  } catch {
    throw protocolError();
  }
  if (Buffer.byteLength(body, "utf8") > maximumBytes) throw protocolError();
  return body;
}

function parseLength(value: string | null, maximum: number): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw protocolError();
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximum) throw protocolError();
  return length;
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = parseLength(
    response.headers.get("content-length"),
    maximumBytes,
  );
  if (response.body === null) {
    if (declared !== null && declared !== 0) throw protocolError();
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((reason: BrowserServiceClientError) => void) | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let abortCancellationFired = false;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    abortTimer ??= setTimeout(() => {
      abortCancellationFired = true;
      void reader.cancel().catch(() => undefined);
      rejectAbort?.(unavailableError());
    }, 0);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    while (true) {
      const next =
        signal === undefined
          ? await reader.read()
          : await Promise.race([reader.read(), aborted]);
      if (abortCancellationFired) throw unavailableError();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw protocolError();
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (
      cause instanceof BrowserServiceClientError &&
      cause.category === "browser_service_protocol_error"
    ) {
      throw cause;
    }
    throw unavailableError();
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (declared !== null && declared !== total) throw protocolError();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedNodeResponse(
  response: NodeJS.ReadableStream,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const stream = response as NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void;
  };
  const iterator = (response as AsyncIterable<Buffer | Uint8Array | string>)[
    Symbol.asyncIterator
  ]();
  const chunks: Buffer[] = [];
  let total = 0;
  let rejectAbort: ((reason: BrowserServiceClientError) => void) | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const destroy = () => {
    if (typeof stream.destroy === "function") stream.destroy();
  };
  const onAbort = () => {
    abortTimer ??= setTimeout(() => {
      destroy();
      rejectAbort?.(unavailableError());
    }, 0);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        destroy();
        throw protocolError();
      }
      chunks.push(chunk);
    }
  } catch (cause) {
    destroy();
    if (cause instanceof BrowserServiceClientError) throw cause;
    throw unavailableError();
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks);
}

function decodeJsonBytes<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw protocolError();
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw protocolError();
  return result.data;
}

function requireJson(response: Response): void {
  const value = response.headers.get("content-type");
  if (value === null || value.split(";", 1)[0]?.trim() !== JSON_CONTENT_TYPE) {
    throw protocolError();
  }
}

function validateContext(context: BrowserServiceBootstrapRequestContext): void {
  const now = Date.now();
  const deadlineMs =
    context.deadline instanceof Date ? context.deadline.getTime() : Number.NaN;
  if (
    context.signal === undefined ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= now ||
    deadlineMs > now + AUTH_DEADLINE_MAX_MS ||
    context.correlationId.length < 1 ||
    context.correlationId.length > 128 ||
    !/^[\x20-\x7e]+$/.test(context.correlationId)
  ) {
    throw new BrowserServiceClientError(
      "browser_service_invalid_request",
      "Browser Service request context is invalid",
    );
  }
}

function bindingFrom(
  context: BrowserServiceRequestContext,
): BrowserServiceControlBinding {
  const processNonce = tokenSchema.safeParse(context.processNonce);
  const controlGenerationNonce = tokenSchema.safeParse(
    context.controlGenerationNonce,
  );
  if (!processNonce.success || !controlGenerationNonce.success) {
    throw new BrowserServiceClientError(
      "browser_service_invalid_request",
      "Browser Service fencing context is invalid",
    );
  }
  return Object.freeze({
    processNonce: processNonce.data,
    controlGenerationNonce: controlGenerationNonce.data,
  });
}

function validateIdentifier(value: string): string {
  const parsed = canonicalUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new BrowserServiceClientError(
      "browser_service_invalid_request",
      "Browser Service identifier is invalid",
    );
  }
  return parsed.data;
}

/** @public */
export class BrowserServiceClient {
  readonly #baseUrl: string;
  readonly #webSocketBaseUrl: string;
  readonly #apiKey: string;
  readonly #requestTimeoutMs: number;
  readonly #reconciliationTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #onControlGenerationMismatch: (
    rejectedBinding: BrowserServiceControlBinding,
  ) => void;

  constructor(options: BrowserServiceClientOptions) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new TypeError("invalid Browser Service base URL");
    }
    if (
      base.protocol !== "http:" ||
      base.username !== "" ||
      base.password !== "" ||
      (base.pathname !== "" && base.pathname !== "/") ||
      base.search !== "" ||
      base.hash !== ""
    ) {
      throw new TypeError("Browser Service base URL must be an HTTP origin");
    }
    if (
      Buffer.byteLength(options.apiKey, "utf8") < 32 ||
      Buffer.byteLength(options.apiKey, "utf8") > 4_089 ||
      !Number.isInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0 ||
      options.requestTimeoutMs > 60_000 ||
      !Number.isInteger(options.reconciliationTimeoutMs) ||
      options.reconciliationTimeoutMs <= 0 ||
      options.reconciliationTimeoutMs > 60_000
    ) {
      throw new TypeError("invalid Browser Service client options");
    }
    this.#baseUrl = base.origin;
    this.#webSocketBaseUrl = `${base.protocol === "http:" ? "ws:" : "wss:"}//${base.host}`;
    this.#apiKey = options.apiKey;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#reconciliationTimeoutMs = options.reconciliationTimeoutMs;
    this.#fetch = options.fetch ?? fetch;
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, websocketOptions) => new WebSocket(url, websocketOptions));
    this.#onControlGenerationMismatch = options.onControlGenerationMismatch;
  }

  #headers(
    context: BrowserServiceBootstrapRequestContext,
    binding?: BrowserServiceControlBinding,
  ): Record<string, string> {
    validateContext(context);
    return {
      [PRIVATE_AUTH_HEADERS.authorization]: `Bearer ${this.#apiKey}`,
      "content-type": JSON_CONTENT_TYPE,
      [PRIVATE_AUTH_HEADERS.correlationId]: context.correlationId,
      [PRIVATE_AUTH_HEADERS.deadline]: context.deadline.toISOString(),
      ...(binding === undefined
        ? {}
        : {
            [PRIVATE_FENCING_HEADERS.processNonce]: binding.processNonce,
            [PRIVATE_FENCING_HEADERS.controlGenerationNonce]:
              binding.controlGenerationNonce,
          }),
    };
  }

  async #fetchResponse(
    method: "GET" | "POST" | "DELETE",
    path: string,
    context: BrowserServiceBootstrapRequestContext,
    body: string | undefined,
    timeoutMs: number,
    binding?: BrowserServiceControlBinding,
  ): Promise<Response> {
    const headers = this.#headers(context, binding);
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(
        Math.min(
          timeoutMs,
          Math.max(1, context.deadline.getTime() - Date.now()),
        ),
      ),
    ]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body,
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      if (context.signal.aborted) throw context.signal.reason;
      if (cause instanceof BrowserServiceClientError) throw cause;
      throw unavailableError();
    }
    if (response.status >= 300 && response.status < 400) {
      try {
        await response.body?.cancel();
      } catch {
        // A rejected redirect is already terminal.
      }
      throw protocolError();
    }
    return response;
  }

  async #decodeError(
    response: Response,
    binding?: BrowserServiceControlBinding,
  ): Promise<never> {
    requireJson(response);
    const error = decodeJsonBytes(
      await readBoundedResponse(response, MAX_ERROR_BYTES),
      privateErrorV1Schema,
    );
    validatePrivateErrorStatus(error, response.status);
    if (
      binding !== undefined &&
      error.category === "control_generation_mismatch"
    ) {
      this.#onControlGenerationMismatch(binding);
    }
    throw new BrowserServiceClientError(
      error.category,
      "Browser Service rejected the private request",
      response.status,
    );
  }

  async #json<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    context: BrowserServiceBootstrapRequestContext,
    expectedStatus: number,
    responseSchema: z.ZodType<T>,
    responseBytes: number,
    request?: { schema: z.ZodType; value: unknown; maximumBytes: number },
    binding?: BrowserServiceControlBinding,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<T> {
    const body =
      request === undefined
        ? undefined
        : encodeJson(request.schema, request.value, request.maximumBytes);
    const response = await this.#fetchResponse(
      method,
      path,
      context,
      body,
      timeoutMs,
      binding,
    );
    if (response.status !== expectedStatus) {
      return this.#decodeError(response, binding);
    }
    requireJson(response);
    return decodeJsonBytes(
      await readBoundedResponse(response, responseBytes),
      responseSchema,
    );
  }

  discoverLive(
    context: BrowserServiceBootstrapRequestContext,
  ): Promise<LiveDiscoveryV1> {
    return this.#json(
      PRIVATE_ROUTES.live.method,
      PRIVATE_ROUTES.live.path,
      context,
      PRIVATE_ROUTES.live.responses[0].status,
      liveDiscoveryV1Schema,
      PRIVATE_ROUTES.live.responseBytes,
    );
  }

  async createControlGeneration(
    request: CreateControlGenerationV1,
    context: BrowserServiceBootstrapRequestContext,
  ): Promise<ControlGenerationV1> {
    const result = await this.#json(
      PRIVATE_ROUTES.createControlGeneration.method,
      PRIVATE_ROUTES.createControlGeneration.path,
      context,
      PRIVATE_ROUTES.createControlGeneration.responses[0].status,
      controlGenerationV1Schema,
      PRIVATE_ROUTES.createControlGeneration.responseBytes,
      {
        schema: createControlGenerationV1Schema,
        value: request,
        maximumBytes: PRIVATE_ROUTES.createControlGeneration.requestBytes,
      },
    );
    if (
      result.processNonce !== request.processNonce ||
      result.apiInstanceId !== request.apiInstanceId
    ) {
      throw protocolError();
    }
    return result;
  }

  async getLive(
    context: BrowserServiceRequestContext,
  ): Promise<ScopedLiveHealthV1> {
    const binding = bindingFrom(context);
    const result = await this.#json(
      PRIVATE_ROUTES.live.method,
      PRIVATE_ROUTES.live.path,
      context,
      PRIVATE_ROUTES.live.responses[1]!.status,
      scopedLiveHealthV1Schema,
      PRIVATE_ROUTES.live.responseBytes,
      undefined,
      binding,
    );
    if (
      result.processNonce !== binding.processNonce ||
      result.controlGenerationNonce !== binding.controlGenerationNonce
    ) {
      throw protocolError();
    }
    return result;
  }

  async getReady(
    context: BrowserServiceRequestContext,
  ): Promise<ReadyHealthV1 | UnreadyHealthV1> {
    const binding = bindingFrom(context);
    const response = await this.#fetchResponse(
      PRIVATE_ROUTES.ready.method,
      PRIVATE_ROUTES.ready.path,
      context,
      undefined,
      this.#requestTimeoutMs,
      binding,
    );
    if (
      response.status !== PRIVATE_ROUTES.ready.responses[0].status &&
      response.status !== PRIVATE_ROUTES.ready.responses[1]!.status
    ) {
      return this.#decodeError(response, binding);
    }
    requireJson(response);
    const bytes = await readBoundedResponse(
      response,
      PRIVATE_ROUTES.ready.responseBytes,
    );
    if (response.status === PRIVATE_ROUTES.ready.responses[0].status) {
      const ready = decodeJsonBytes(bytes, readyHealthV1Schema);
      if (
        ready.processNonce !== binding.processNonce ||
        ready.controlGenerationNonce !== binding.controlGenerationNonce
      ) {
        throw protocolError();
      }
      return ready;
    }
    const unready = unreadyHealthV1Schema.safeParse(
      (() => {
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          throw protocolError();
        }
      })(),
    );
    if (unready.success) {
      if (
        unready.data.processNonce !== binding.processNonce ||
        unready.data.controlGenerationNonce !== binding.controlGenerationNonce
      ) {
        throw protocolError();
      }
      return unready.data;
    }
    const privateError = privateErrorV1Schema.safeParse(
      (() => {
        try {
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return undefined;
        }
      })(),
    );
    if (privateError.success) {
      validatePrivateErrorStatus(privateError.data, response.status);
      if (privateError.data.category === "control_generation_mismatch") {
        this.#onControlGenerationMismatch(binding);
      }
      throw new BrowserServiceClientError(
        privateError.data.category,
        "Browser Service rejected the private request",
        response.status,
      );
    }
    throw protocolError();
  }

  async reconcile(
    canonicalRequestBody: string,
    context: BrowserServiceRequestContext,
  ): Promise<ReconciliationResultV1> {
    if (
      typeof canonicalRequestBody !== "string" ||
      Buffer.byteLength(canonicalRequestBody, "utf8") >
        PRIVATE_ROUTES.reconcile.requestBytes
    ) {
      throw protocolError();
    }
    const binding = bindingFrom(context);
    const response = await this.#fetchResponse(
      PRIVATE_ROUTES.reconcile.method,
      PRIVATE_ROUTES.reconcile.path,
      context,
      canonicalRequestBody,
      this.#reconciliationTimeoutMs,
      binding,
    );
    if (response.status !== PRIVATE_ROUTES.reconcile.responses[0].status) {
      return this.#decodeError(response, binding);
    }
    requireJson(response);
    const result = decodeJsonBytes(
      await readBoundedResponse(
        response,
        PRIVATE_ROUTES.reconcile.responseBytes,
      ),
      reconciliationResultV1Schema,
    );
    if (
      result.processNonce !== binding.processNonce ||
      result.controlGenerationNonce !== binding.controlGenerationNonce
    ) {
      throw protocolError();
    }
    return result;
  }

  createSession(
    request: CreateSessionV1,
    context: BrowserServiceRequestContext,
  ): Promise<SessionV1> {
    const binding = bindingFrom(context);
    return this.#json(
      PRIVATE_ROUTES.createSession.method,
      PRIVATE_ROUTES.createSession.path,
      context,
      PRIVATE_ROUTES.createSession.responses[0].status,
      sessionV1Schema,
      PRIVATE_ROUTES.createSession.responseBytes,
      {
        schema: createSessionV1Schema,
        value: request,
        maximumBytes:
          request.replay === null
            ? PRIVATE_ROUTES.createSession.requestBytes.default
            : PRIVATE_ROUTES.createSession.requestBytes.withReplay,
      },
      binding,
    );
  }

  async getSession(
    runtimeSessionId: string,
    context: BrowserServiceRequestContext,
  ): Promise<SessionV1> {
    const id = validateIdentifier(runtimeSessionId);
    const binding = bindingFrom(context);
    const result = await this.#json(
      PRIVATE_ROUTES.getSession.method,
      routePath(PRIVATE_ROUTES.getSession.path, { runtimeSessionId: id }),
      context,
      PRIVATE_ROUTES.getSession.responses[0].status,
      sessionV1Schema,
      PRIVATE_ROUTES.getSession.responseBytes,
      undefined,
      binding,
    );
    if (result.runtimeSessionId !== id) throw protocolError();
    return result;
  }

  async closeSession(
    runtimeSessionId: string,
    request: z.infer<typeof closeSessionV1Schema>,
    context: BrowserServiceRequestContext,
  ): Promise<ClosedSessionV1> {
    const id = validateIdentifier(runtimeSessionId);
    const binding = bindingFrom(context);
    const result = await this.#json(
      PRIVATE_ROUTES.closeSession.method,
      routePath(PRIVATE_ROUTES.closeSession.path, { runtimeSessionId: id }),
      context,
      PRIVATE_ROUTES.closeSession.responses[0].status,
      closedSessionV1Schema,
      PRIVATE_ROUTES.closeSession.responseBytes,
      {
        schema: closeSessionV1Schema,
        value: request,
        maximumBytes: PRIVATE_ROUTES.closeSession.requestBytes,
      },
      binding,
    );
    if (result.runtimeSessionId !== id) throw protocolError();
    return result;
  }

  async executeAction(
    runtimeSessionId: string,
    action: BrowserActionExecutionV1,
    context: BrowserServiceRequestContext,
  ): Promise<BrowserActionExecutionResultV1> {
    const id = validateIdentifier(runtimeSessionId);
    const binding = bindingFrom(context);
    const result = await this.#json(
      PRIVATE_ROUTES.executeAction.method,
      routePath(PRIVATE_ROUTES.executeAction.path, { runtimeSessionId: id }),
      context,
      PRIVATE_ROUTES.executeAction.responses[0].status,
      actionExecutionResultSchema,
      PRIVATE_ROUTES.executeAction.responseBytes,
      {
        schema: actionExecutionRequestSchema,
        value: action,
        maximumBytes: PRIVATE_ROUTES.executeAction.requestBytes,
      },
      binding,
    );
    if (
      result.actionId !== action.actionId ||
      result.sequence !== action.sequence ||
      result.normalizedProposalHash !== action.normalizedProposalHash ||
      (result.outcome === "succeeded" &&
        result.result.kind !== action.operation.kind)
    ) {
      throw protocolError();
    }
    return result;
  }

  async createRelayGrant(
    runtimeSessionId: string,
    request: CreateRelayGrantV1,
    context: BrowserServiceRequestContext,
  ): Promise<RelayGrantV1> {
    const id = validateIdentifier(runtimeSessionId);
    const binding = bindingFrom(context);
    const result = await this.#json(
      PRIVATE_ROUTES.createRelayGrant.method,
      routePath(PRIVATE_ROUTES.createRelayGrant.path, {
        runtimeSessionId: id,
      }),
      context,
      PRIVATE_ROUTES.createRelayGrant.responses[0].status,
      relayGrantV1Schema,
      PRIVATE_ROUTES.createRelayGrant.responseBytes,
      {
        schema: createRelayGrantV1Schema,
        value: request,
        maximumBytes: PRIVATE_ROUTES.createRelayGrant.requestBytes,
      },
      binding,
    );
    if (
      result.grantId !== request.grantId ||
      result.permission !== request.permission ||
      result.expiresAt !== request.expiresAt
    ) {
      throw protocolError();
    }
    return result;
  }

  async revokeRelayGrant(
    runtimeSessionId: string,
    grantId: string,
    request: RevokeRelayGrantV1,
    context: BrowserServiceRequestContext,
  ): Promise<RevokedRelayGrantV1> {
    const sessionId = validateIdentifier(runtimeSessionId);
    const canonicalGrantId = validateIdentifier(grantId);
    const binding = bindingFrom(context);
    if (request.grantId !== canonicalGrantId) throw protocolError();
    const result = await this.#json(
      PRIVATE_ROUTES.revokeRelayGrant.method,
      routePath(PRIVATE_ROUTES.revokeRelayGrant.path, {
        runtimeSessionId: sessionId,
        grantId: canonicalGrantId,
      }),
      context,
      PRIVATE_ROUTES.revokeRelayGrant.responses[0].status,
      revokedRelayGrantV1Schema,
      PRIVATE_ROUTES.revokeRelayGrant.responseBytes,
      {
        schema: revokeRelayGrantV1Schema,
        value: request,
        maximumBytes: PRIVATE_ROUTES.revokeRelayGrant.requestBytes,
      },
      binding,
    );
    if (result.grantId !== canonicalGrantId) throw protocolError();
    return result;
  }

  async fetchArtifact(
    runtimeSessionId: string,
    request: FetchArtifactV1,
    context: BrowserServiceRequestContext,
  ): Promise<BrowserArtifact> {
    const id = validateIdentifier(runtimeSessionId);
    const binding = bindingFrom(context);
    const response = await this.#fetchResponse(
      PRIVATE_ROUTES.fetchArtifact.method,
      routePath(PRIVATE_ROUTES.fetchArtifact.path, {
        runtimeSessionId: id,
      }),
      context,
      encodeJson(
        fetchArtifactV1Schema,
        request,
        PRIVATE_ROUTES.fetchArtifact.requestBytes,
      ),
      this.#requestTimeoutMs,
      binding,
    );
    if (response.status !== PRIVATE_ROUTES.fetchArtifact.responses[0].status) {
      return this.#decodeError(response, binding);
    }
    try {
      const metadata = artifactMetadataV1Schema.safeParse({
        version: Number(
          response.headers.get(ARTIFACT_METADATA_HEADERS.version),
        ),
        artifactId: response.headers.get(ARTIFACT_METADATA_HEADERS.artifactId),
        kind: response.headers.get(ARTIFACT_METADATA_HEADERS.kind),
        byteSize: Number(
          response.headers.get(ARTIFACT_METADATA_HEADERS.byteSize),
        ),
        checksum: response.headers.get(ARTIFACT_METADATA_HEADERS.checksum),
        contentType:
          response.headers
            .get(ARTIFACT_METADATA_HEADERS.contentType)
            ?.split(";", 1)[0]
            ?.trim() ?? null,
      });
      if (!metadata.success) throw protocolError();
      const declared = parseLength(
        response.headers.get(ARTIFACT_METADATA_HEADERS.contentLength),
        PRIVATE_ROUTES.fetchArtifact.responseBytes,
      );
      if (
        declared === null ||
        declared !== metadata.data.byteSize ||
        metadata.data.artifactId !== request.artifactId ||
        metadata.data.kind !== request.kind
      ) {
        throw protocolError();
      }
      const bytes = await readBoundedResponse(
        response,
        PRIVATE_ROUTES.fetchArtifact.responseBytes,
      );
      if (
        bytes.byteLength !== metadata.data.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !==
          metadata.data.checksum
      ) {
        throw protocolError();
      }
      return { metadata: metadata.data, bytes };
    } catch (cause) {
      try {
        await response.body?.cancel();
      } catch {
        // Validation failure is already terminal.
      }
      throw cause;
    }
  }

  async finalizeProfile(
    generationId: string,
    request: FinalizeProfileGenerationV1,
    context: BrowserServiceRequestContext,
  ): Promise<FinalizedProfileGenerationV1> {
    const id = validateIdentifier(generationId);
    const binding = bindingFrom(context);
    if (request.generationId !== id) throw protocolError();
    const result = await this.#json(
      PRIVATE_ROUTES.finalizeProfile.method,
      routePath(PRIVATE_ROUTES.finalizeProfile.path, { generationId: id }),
      context,
      PRIVATE_ROUTES.finalizeProfile.responses[0].status,
      finalizedProfileGenerationV1Schema,
      PRIVATE_ROUTES.finalizeProfile.responseBytes,
      {
        schema: finalizeProfileGenerationV1Schema,
        value: request,
        maximumBytes: PRIVATE_ROUTES.finalizeProfile.requestBytes,
      },
      binding,
    );
    if (
      result.profileId !== request.profileId ||
      result.generationId !== request.generationId ||
      result.checksum !== request.checksum
    ) {
      throw protocolError();
    }
    return result;
  }

  async discardProfile(
    generationId: string,
    request: DeleteProfileGenerationV1,
    context: BrowserServiceRequestContext,
  ): Promise<DeletedProfileGenerationV1> {
    const id = validateIdentifier(generationId);
    const binding = bindingFrom(context);
    if (request.generationId !== id) throw protocolError();
    const result = await this.#json(
      PRIVATE_ROUTES.discardProfile.method,
      routePath(PRIVATE_ROUTES.discardProfile.path, { generationId: id }),
      context,
      PRIVATE_ROUTES.discardProfile.responses[0].status,
      deletedProfileGenerationV1Schema,
      PRIVATE_ROUTES.discardProfile.responseBytes,
      {
        schema: deleteProfileGenerationV1Schema,
        value: request,
        maximumBytes: PRIVATE_ROUTES.discardProfile.requestBytes,
      },
      binding,
    );
    if (
      result.profileId !== request.profileId ||
      result.generationId !== request.generationId ||
      result.checksum !== request.checksum
    ) {
      throw protocolError();
    }
    return result;
  }

  openPassiveStream(
    runtimeSessionId: string,
    relayToken: string,
    context: BrowserServiceRequestContext,
  ): Promise<WebSocket> {
    return this.#openStream("passive", runtimeSessionId, relayToken, context);
  }

  openInteractiveStream(
    runtimeSessionId: string,
    relayToken: string,
    context: BrowserServiceRequestContext,
  ): Promise<WebSocket> {
    return this.#openStream(
      "interactive",
      runtimeSessionId,
      relayToken,
      context,
    );
  }

  openCdpStream(
    runtimeSessionId: string,
    relayToken: string,
    context: BrowserServiceRequestContext,
  ): Promise<WebSocket> {
    return this.#openStream("cdp", runtimeSessionId, relayToken, context);
  }

  #openStream(
    permission: "passive" | "interactive" | "cdp",
    runtimeSessionId: string,
    relayToken: string,
    context: BrowserServiceRequestContext,
  ): Promise<WebSocket> {
    const id = validateIdentifier(runtimeSessionId);
    const token = tokenSchema.safeParse(relayToken);
    if (!token.success) throw protocolError();
    const binding = bindingFrom(context);
    const headers = {
      ...this.#headers(context, binding),
      [RELAY_TOKEN_HEADER]: token.data,
    };
    delete headers["content-type"];
    const streamRoute =
      permission === "passive"
        ? PRIVATE_ROUTES.passiveStream
        : permission === "interactive"
          ? PRIVATE_ROUTES.interactiveStream
          : PRIVATE_ROUTES.cdpStream;
    const handshakeTimeoutMs = Math.min(
      this.#requestTimeoutMs,
      Math.max(1, context.deadline.getTime() - Date.now()),
    );
    const upgradeSignal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(handshakeTimeoutMs),
    ]);
    let socket: WebSocket;
    try {
      socket = this.#webSocketFactory(
        `${this.#webSocketBaseUrl}${routePath(streamRoute.path, {
          runtimeSessionId: id,
        })}`,
        {
          headers,
          followRedirects: false,
          handshakeTimeout: handshakeTimeoutMs,
        },
      );
    } catch {
      throw unavailableError();
    }
    return new Promise<WebSocket>((resolve, reject) => {
      let phase: "opening" | "decoding_upgrade" | "settled" = "opening";
      const swallowSocketError = () => undefined;
      const detach = () => {
        socket.removeListener("open", onOpen);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        socket.removeListener("unexpected-response", onUnexpectedResponse);
        upgradeSignal.removeEventListener("abort", onAbort);
      };
      const terminateFailedSocket = () => {
        detach();
        socket.on("error", swallowSocketError);
        try {
          socket.terminate();
        } catch {
          try {
            socket.close();
          } catch {
            // Failed upgrades may already have destroyed their socket.
          }
        }
      };
      const failOpening = (error: unknown) => {
        if (phase !== "opening") return;
        phase = "settled";
        terminateFailedSocket();
        reject(
          error instanceof BrowserServiceClientError
            ? error
            : unavailableError(),
        );
      };
      const onOpen = () => {
        if (phase !== "opening") return;
        phase = "settled";
        detach();
        resolve(socket);
      };
      const onError = () => failOpening(unavailableError());
      const onClose = () => failOpening(unavailableError());
      const onAbort = () => failOpening(unavailableError());
      const onUnexpectedResponse = (
        _request: unknown,
        response: Response | NodeJS.ReadableStream,
      ) => {
        if (phase !== "opening") return;
        phase = "decoding_upgrade";
        void this.#decodeWebSocketError(response, binding, upgradeSignal).catch(
          error => {
            if (phase !== "decoding_upgrade") return;
            phase = "settled";
            terminateFailedSocket();
            reject(
              error instanceof BrowserServiceClientError
                ? error
                : protocolError(),
            );
          },
        );
      };
      socket.once("open", onOpen);
      socket.on("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
      upgradeSignal.addEventListener("abort", onAbort, { once: true });
      if (upgradeSignal.aborted) onAbort();
    });
  }

  async #decodeWebSocketError(
    response: Response | NodeJS.ReadableStream,
    binding: BrowserServiceControlBinding,
    signal: AbortSignal,
  ): Promise<never> {
    let bytes: Uint8Array;
    let status: number | undefined;
    if (response instanceof Response) {
      status = response.status;
      try {
        requireJson(response);
        bytes = await readBoundedResponse(response, MAX_ERROR_BYTES, signal);
      } catch (cause) {
        try {
          await response.body?.cancel();
        } catch {
          // Upgrade decoding failure is already terminal.
        }
        throw cause;
      }
    } else {
      const upgradeResponse = response as NodeJS.ReadableStream & {
        statusCode?: number;
        headers?: Record<string, string | string[] | undefined>;
      };
      status = upgradeResponse.statusCode;
      const contentType = upgradeResponse.headers?.["content-type"];
      if (
        typeof contentType !== "string" ||
        contentType.split(";", 1)[0]?.trim() !== JSON_CONTENT_TYPE
      ) {
        const destroy = (
          response as NodeJS.ReadableStream & {
            destroy?: (error?: Error) => void;
          }
        ).destroy;
        if (typeof destroy === "function") destroy.call(response);
        throw protocolError();
      }
      bytes = await readBoundedNodeResponse(response, MAX_ERROR_BYTES, signal);
    }
    const error = decodeJsonBytes(bytes, privateErrorV1Schema);
    validatePrivateErrorStatus(error, status);
    if (error.category === "control_generation_mismatch") {
      this.#onControlGenerationMismatch(binding);
    }
    throw new BrowserServiceClientError(
      error.category,
      "Browser Service rejected the private WebSocket upgrade",
      status,
    );
  }
}
