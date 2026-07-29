import {
  createHash,
  randomBytes as systemRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import type WebSocket from "ws";
import { z } from "zod";

import {
  canonicalUuidSchema,
  createRelayGrantV1Schema,
  relayGrantV1Schema,
  revokeRelayGrantV1Schema,
  revokedRelayGrantV1Schema,
  tokenSchema,
  type CreateRelayGrantV1,
  type RelayGrantV1,
  type RevokeRelayGrantV1,
  type RevokedRelayGrantV1,
} from "./contracts.js";
import { BrowserServiceError } from "./errors.js";
import {
  closeSessionCdpChannel,
  openSessionCdpChannel,
  sendSessionCdpCommand,
  sessionRuntimeSignal,
  subscribeSessionCdpEvent,
  type SessionCdpChannel,
  type SessionRegistry,
  type SessionRuntimeLease,
} from "./session-registry.js";
import type { ControlGenerationBinding } from "./startup-state.js";

export const STREAM_LIMITS = Object.freeze({
  frameBytes: 1024 * 1024,
  interactiveInputBytes: 4 * 1024,
  cdpFrameBytes: 256 * 1024,
  cdpOutstandingIds: 64,
  queuedMessages: 64,
  queuedBytes: 4 * 1024 * 1024,
  backpressureBytes: 1024 * 1024,
  closeTimeoutMs: 5_000,
  jsonDepth: 16,
  jsonArrayEntries: 1_000,
  jsonObjectEntries: 256,
  jsonStringBytes: 64 * 1024,
  grantHistory: 1_024,
});

export const STREAM_CLOSE_CODES = Object.freeze({
  normal: 1000,
  policyViolation: 1008,
  messageTooBig: 1009,
  internalError: 1011,
  serviceRestart: 1012,
  tryAgainLater: 1013,
});

const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const SCREENCAST_FRAME_EVENT = "Page.screencastFrame";
const MAX_AUTH_BINDING_BYTES = 4_096;

const finiteNumberSchema = z.number().finite();
const nonnegativeIntegerSchema = z.number().int().min(0);
const modifiersSchema = z.number().int().min(0).max(15);
const mouseButtonSchema = z.enum([
  "none",
  "left",
  "middle",
  "right",
  "back",
  "forward",
]);

const interactiveInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("pointer"),
    action: z.enum(["move", "down", "up"]),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    button: mouseButtonSchema.optional(),
    buttons: z.number().int().min(0).max(31).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: modifiersSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("wheel"),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    deltaX: finiteNumberSchema,
    deltaY: finiteNumberSchema,
    modifiers: modifiersSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("key"),
    action: z.enum(["down", "up", "rawDown", "char"]),
    key: z.string().min(1).max(256),
    code: z.string().min(1).max(256),
    text: z.string().max(4_096).optional(),
    unmodifiedText: z.string().max(4_096).optional(),
    windowsVirtualKeyCode: z.number().int().min(0).max(65_535).optional(),
    nativeVirtualKeyCode: z.number().int().min(0).max(65_535).optional(),
    modifiers: modifiersSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("text"),
    text: z.string().min(1).max(4_096),
  }),
]);

const authoritySchema = z.strictObject({
  processNonce: tokenSchema,
  controlGenerationNonce: tokenSchema,
  authBinding: z
    .string()
    .min(1)
    .superRefine((value, context) => {
      if (Buffer.byteLength(value, "utf8") > MAX_AUTH_BINDING_BYTES) {
        context.addIssue({
          code: "custom",
          message: "authentication binding is too large",
        });
      }
    }),
});

const openRelaySchema = z.strictObject({
  runtimeSessionId: canonicalUuidSchema,
  permission: z.enum(["passive", "interactive", "cdp"]),
  relayToken: tokenSchema,
  authority: authoritySchema,
});

const cdpRequestSchema = z.strictObject({
  id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});

const screencastFrameSchema = z.strictObject({
  data: z.string().min(1),
  sessionId: nonnegativeIntegerSchema,
  metadata: z.strictObject({
    offsetTop: finiteNumberSchema,
    pageScaleFactor: finiteNumberSchema,
    deviceWidth: finiteNumberSchema,
    deviceHeight: finiteNumberSchema,
    scrollOffsetX: finiteNumberSchema,
    scrollOffsetY: finiteNumberSchema,
    timestamp: finiteNumberSchema.optional(),
  }),
});

const emptyParamsSchema = z.strictObject({});
const cdpParamsByMethod = {
  "Runtime.enable": emptyParamsSchema,
  "Runtime.disable": emptyParamsSchema,
  "Runtime.getProperties": z.strictObject({
    objectId: z.string().min(1).max(4_096),
    ownProperties: z.boolean().optional(),
    accessorPropertiesOnly: z.boolean().optional(),
    generatePreview: z.boolean().optional(),
    nonIndexedPropertiesOnly: z.boolean().optional(),
  }),
  "Runtime.releaseObject": z.strictObject({
    objectId: z.string().min(1).max(4_096),
  }),
  "Runtime.releaseObjectGroup": z.strictObject({
    objectGroup: z.string().min(1).max(256),
  }),
  "DOM.enable": z.strictObject({
    includeWhitespace: z.enum(["none", "all"]).optional(),
  }),
  "DOM.disable": emptyParamsSchema,
  "DOM.getDocument": z.strictObject({
    depth: z.number().int().min(-1).max(1_024).optional(),
    pierce: z.boolean().optional(),
  }),
  "DOM.querySelector": z.strictObject({
    nodeId: nonnegativeIntegerSchema,
    selector: z
      .string()
      .min(1)
      .max(16 * 1024),
  }),
  "DOM.querySelectorAll": z.strictObject({
    nodeId: nonnegativeIntegerSchema,
    selector: z
      .string()
      .min(1)
      .max(16 * 1024),
  }),
  "DOM.getOuterHTML": z
    .strictObject({
      nodeId: nonnegativeIntegerSchema.optional(),
      backendNodeId: nonnegativeIntegerSchema.optional(),
      objectId: z.string().min(1).max(4_096).optional(),
      includeShadowDOM: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      const count =
        Number(value.nodeId !== undefined) +
        Number(value.backendNodeId !== undefined) +
        Number(value.objectId !== undefined);
      if (count !== 1) {
        context.addIssue({
          code: "custom",
          message: "exactly one node identity is required",
        });
      }
    }),
  "DOM.describeNode": z.strictObject({
    nodeId: nonnegativeIntegerSchema.optional(),
    backendNodeId: nonnegativeIntegerSchema.optional(),
    objectId: z.string().min(1).max(4_096).optional(),
    depth: z.number().int().min(-1).max(1_024).optional(),
    pierce: z.boolean().optional(),
  }),
  "DOM.resolveNode": z.strictObject({
    nodeId: nonnegativeIntegerSchema.optional(),
    backendNodeId: nonnegativeIntegerSchema.optional(),
    objectGroup: z.string().max(256).optional(),
    executionContextId: nonnegativeIntegerSchema.optional(),
  }),
  "Page.enable": z.strictObject({
    enableFileChooserOpenedEvent: z.boolean().optional(),
  }),
  "Page.disable": emptyParamsSchema,
  "Page.getFrameTree": emptyParamsSchema,
  "Page.getLayoutMetrics": emptyParamsSchema,
  "Page.getNavigationHistory": emptyParamsSchema,
  "Page.navigateToHistoryEntry": z.strictObject({
    entryId: nonnegativeIntegerSchema,
  }),
  "Page.reload": z.strictObject({
    ignoreCache: z.boolean().optional(),
    scriptToEvaluateOnLoad: z
      .string()
      .max(64 * 1024)
      .optional(),
    loaderId: z.string().min(1).max(4_096).optional(),
  }),
  "Page.stopLoading": emptyParamsSchema,
  "Page.navigate": z.strictObject({
    url: z.string().min(1).max(8_192),
    referrer: z.string().max(8_192).optional(),
    transitionType: z.string().min(1).max(64).optional(),
    frameId: z.string().min(1).max(4_096).optional(),
    referrerPolicy: z.string().min(1).max(128).optional(),
  }),
  "Page.captureScreenshot": z.strictObject({
    format: z.enum(["jpeg", "png", "webp"]).optional(),
    quality: z.number().int().min(0).max(100).optional(),
    fromSurface: z.boolean().optional(),
    captureBeyondViewport: z.boolean().optional(),
    optimizeForSpeed: z.boolean().optional(),
  }),
  "Network.enable": z.strictObject({
    maxTotalBufferSize: nonnegativeIntegerSchema
      .max(16 * 1024 * 1024)
      .optional(),
    maxResourceBufferSize: nonnegativeIntegerSchema
      .max(16 * 1024 * 1024)
      .optional(),
    maxPostDataSize: nonnegativeIntegerSchema.max(1024 * 1024).optional(),
    reportDirectSocketTraffic: z.boolean().optional(),
    enableDurableMessages: z.boolean().optional(),
  }),
  "Network.disable": emptyParamsSchema,
  "Network.getCookies": z.strictObject({
    urls: z.array(z.string().min(1).max(8_192)).max(32).optional(),
  }),
  "Network.getAllCookies": emptyParamsSchema,
  "Network.deleteCookies": z.strictObject({
    name: z.string().min(1).max(4_096),
    url: z.string().min(1).max(8_192).optional(),
    domain: z.string().min(1).max(4_096).optional(),
    path: z.string().min(1).max(4_096).optional(),
    partitionKey: z.unknown().optional(),
  }),
  "Network.clearBrowserCookies": emptyParamsSchema,
  "Input.dispatchMouseEvent": z.strictObject({
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    modifiers: modifiersSchema.optional(),
    timestamp: finiteNumberSchema.optional(),
    button: mouseButtonSchema.optional(),
    buttons: z.number().int().min(0).max(31).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    force: finiteNumberSchema.optional(),
    tangentialPressure: finiteNumberSchema.optional(),
    tiltX: z.number().int().min(-90).max(90).optional(),
    tiltY: z.number().int().min(-90).max(90).optional(),
    twist: z.number().int().min(0).max(359).optional(),
    deltaX: finiteNumberSchema.optional(),
    deltaY: finiteNumberSchema.optional(),
    pointerType: z.enum(["mouse", "pen"]).optional(),
  }),
  "Input.dispatchKeyEvent": z.strictObject({
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    modifiers: modifiersSchema.optional(),
    timestamp: finiteNumberSchema.optional(),
    text: z.string().max(4_096).optional(),
    unmodifiedText: z.string().max(4_096).optional(),
    keyIdentifier: z.string().max(256).optional(),
    code: z.string().max(256).optional(),
    key: z.string().max(256).optional(),
    windowsVirtualKeyCode: nonnegativeIntegerSchema.max(65_535).optional(),
    nativeVirtualKeyCode: nonnegativeIntegerSchema.max(65_535).optional(),
    autoRepeat: z.boolean().optional(),
    isKeypad: z.boolean().optional(),
    isSystemKey: z.boolean().optional(),
    location: nonnegativeIntegerSchema.max(3).optional(),
    commands: z.array(z.string().max(256)).max(32).optional(),
  }),
  "Input.insertText": z.strictObject({
    text: z.string().min(1).max(4_096),
  }),
} as const;

type AllowedCdpMethod = keyof typeof cdpParamsByMethod;

const CDP_EVENT_ALLOWLIST = Object.freeze([
  "Runtime.consoleAPICalled",
  "Runtime.exceptionRevoked",
  "Runtime.exceptionThrown",
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
  "Page.domContentEventFired",
  "Page.fileChooserOpened",
  "Page.frameAttached",
  "Page.frameDetached",
  "Page.frameNavigated",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.javascriptDialogClosed",
  "Page.javascriptDialogOpening",
  "Page.lifecycleEvent",
  "Page.loadEventFired",
  "Page.navigatedWithinDocument",
  "Network.dataReceived",
  "Network.loadingFailed",
  "Network.loadingFinished",
  "Network.requestServedFromCache",
  "Network.requestWillBeSent",
  "Network.requestWillBeSentExtraInfo",
  "Network.responseReceived",
  "Network.responseReceivedExtraInfo",
] as const);

type RelayPermission = "passive" | "interactive" | "cdp";

export type RelayGrantAuthority = z.infer<typeof authoritySchema>;
export type OpenRelayStream = z.infer<typeof openRelaySchema>;

export type SessionStreamRuntimeApi = Readonly<{
  signal(lease: SessionRuntimeLease): AbortSignal;
  openCdp(lease: SessionRuntimeLease): Promise<SessionCdpChannel>;
  sendCdp(
    channel: SessionCdpChannel,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  subscribeCdp(
    channel: SessionCdpChannel,
    event: string,
    listener: (params: unknown) => void,
  ): () => void;
  closeCdp(channel: SessionCdpChannel): Promise<void>;
}>;

type GrantRecord = {
  grantId: string;
  runtimeSessionId: string;
  permission: RelayPermission;
  expiresAt: string;
  expiresAtMs: number;
  tokenHash: Buffer;
  authHash: Buffer;
  processNonce: string;
  controlGenerationNonce: string;
  state: "active" | "redeemed" | "revoked" | "consumed" | "expired";
  active?: ActiveStream;
};

type ActiveStream = {
  abort: AbortController;
  socket?: WebSocket;
  done: Promise<void>;
  settle(): void;
};

type QueuedMessage = {
  bytes: number;
  data: string;
};

type SocketSender = {
  send(value: unknown, mode: "required" | "droppable"): boolean;
  close(): void;
};

type StreamLifecycle = Readonly<{
  beginClosing(): void;
  isClosing(): boolean;
  whenClosing: Promise<void>;
  commit<T>(effect: () => Promise<T>): Promise<T>;
  cleanup(closeChannel: () => Promise<void>): Promise<void>;
}>;

export type RelayGrantInventory = Readonly<{
  grants: number;
  streams: number;
}>;

export type RelayGrantManager = Readonly<{
  create(runtimeSessionId: string, input: unknown): RelayGrantV1;
  revoke(
    runtimeSessionId: string,
    input: unknown,
  ): Promise<RevokedRelayGrantV1>;
  open(input: unknown, upgrade: () => Promise<WebSocket>): Promise<void>;
  sweepExpired(): number;
  drain(): Promise<void>;
  inventory(): RelayGrantInventory;
}>;

function invalidRequest(message: string): BrowserServiceError {
  return new BrowserServiceError("invalid_request", message);
}

function unauthorizedGrant(): BrowserServiceError {
  return new BrowserServiceError("unauthorized", "relay grant is invalid");
}

function browserUnavailable(message: string): BrowserServiceError {
  return new BrowserServiceError("browser_unavailable", message);
}

function createStreamLifecycle(cleanupTimeoutMs: number): StreamLifecycle {
  const committedEffects = new Set<Promise<unknown>>();
  let closing = false;
  let resolveClosing!: () => void;
  const whenClosing = new Promise<void>((resolve) => {
    resolveClosing = resolve;
  });
  const beginClosing = (): void => {
    if (closing) return;
    closing = true;
    resolveClosing();
  };

  const observeWithin = async (
    effect: Promise<unknown>,
  ): Promise<"fulfilled" | "rejected" | "timeout"> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        effect.then(
          () => "fulfilled" as const,
          () => "rejected" as const,
        ),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(resolve, cleanupTimeoutMs, "timeout");
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return Object.freeze({
    beginClosing,
    isClosing() {
      return closing;
    },
    whenClosing,
    commit<T>(start: () => Promise<T>): Promise<T> {
      let effect: Promise<T>;
      try {
        effect = Promise.resolve(start());
      } catch (cause) {
        effect = Promise.reject(cause);
      }
      committedEffects.add(effect);
      void effect.then(
        () => committedEffects.delete(effect),
        () => committedEffects.delete(effect),
      );
      return effect;
    },
    async cleanup(closeChannel) {
      beginClosing();
      let closeEffect: Promise<void>;
      try {
        closeEffect = Promise.resolve(closeChannel());
      } catch (cause) {
        closeEffect = Promise.reject(cause);
      }
      const drainEffect = Promise.allSettled([...committedEffects]);
      const [closeState, drainState] = await Promise.all([
        observeWithin(closeEffect),
        observeWithin(drainEffect),
      ]);
      if (closeState !== "fulfilled") {
        throw browserUnavailable("stream CDP cleanup is unverified");
      }
      if (drainState === "timeout") {
        throw browserUnavailable("stream browser effect cleanup is unverified");
      }
    },
  });
}

async function openStreamCdpChannel(options: {
  socket: WebSocket;
  lease: SessionRuntimeLease;
  runtimeApi: SessionStreamRuntimeApi;
  externalAbort: AbortSignal;
  cleanupTimeoutMs: number;
}): Promise<
  Readonly<{
    channel: SessionCdpChannel;
    lifecycle: StreamLifecycle;
    runtimeSignal: AbortSignal;
  }>
> {
  const { socket, lease, runtimeApi, externalAbort, cleanupTimeoutMs } =
    options;
  const lifecycle = createStreamLifecycle(cleanupTimeoutMs);
  const runtimeSignal = runtimeApi.signal(lease);
  const onAbort = (): void => {
    lifecycle.beginClosing();
    closeSocket(
      socket,
      STREAM_CLOSE_CODES.serviceRestart,
      "stream authority ended",
    );
  };
  const onSocketClose = (): void => lifecycle.beginClosing();
  runtimeSignal.addEventListener("abort", onAbort, { once: true });
  externalAbort.addEventListener("abort", onAbort, { once: true });
  socket.on("close", onSocketClose);
  try {
    if (
      runtimeSignal.aborted ||
      externalAbort.aborted ||
      socket.readyState >= SOCKET_CLOSING
    ) {
      onAbort();
    }
    if (lifecycle.isClosing()) {
      throw browserUnavailable("relay stream authority ended");
    }
    const opening = lifecycle.commit(async () => {
      const channel = await runtimeApi.openCdp(lease);
      if (lifecycle.isClosing()) {
        await runtimeApi.closeCdp(channel);
        throw browserUnavailable("relay stream authority ended");
      }
      return channel;
    });
    const outcome = await Promise.race([
      opening.then((channel) => Object.freeze({ channel })),
      lifecycle.whenClosing.then(() => undefined),
    ]);
    if (outcome === undefined) {
      await lifecycle.cleanup(async () => undefined);
      throw browserUnavailable("relay stream authority ended");
    }
    return Object.freeze({
      channel: outcome.channel,
      lifecycle,
      runtimeSignal,
    });
  } finally {
    runtimeSignal.removeEventListener("abort", onAbort);
    externalAbort.removeEventListener("abort", onAbort);
    socket.off("close", onSocketClose);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseJsonFrame(data: WebSocket.RawData): unknown {
  if (typeof data === "string") return JSON.parse(data);
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf8"));
  if (data instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(data).toString("utf8"));
  }
  if (Array.isArray(data)) {
    return JSON.parse(Buffer.concat(data).toString("utf8"));
  }
  throw invalidRequest("stream frame encoding is unsupported");
}

function assertJsonSafe(value: unknown, depth = 0): void {
  if (depth > STREAM_LIMITS.jsonDepth) {
    throw invalidRequest("CDP JSON exceeds its depth limit");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > STREAM_LIMITS.jsonStringBytes) {
      throw invalidRequest("CDP JSON string exceeds its limit");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > STREAM_LIMITS.jsonArrayEntries) {
      throw invalidRequest("CDP JSON array exceeds its limit");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw invalidRequest("CDP JSON arrays must be dense");
      }
      assertJsonSafe(value[index], depth + 1);
    }
    return;
  }
  if (
    typeof value !== "object" ||
    value === undefined ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidRequest("CDP JSON value is unsupported");
  }
  const symbols = Object.getOwnPropertySymbols(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors);
  if (
    symbols.length !== 0 ||
    entries.length > STREAM_LIMITS.jsonObjectEntries
  ) {
    throw invalidRequest("CDP JSON object exceeds its limit");
  }
  for (const [key, descriptor] of entries) {
    if (
      key.length > 256 ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw invalidRequest("CDP JSON object is unsupported");
    }
    assertJsonSafe(descriptor.value, depth + 1);
  }
}

function parseHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidRequest("CDP URL is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw invalidRequest("CDP URL must use HTTP(S)");
  }
}

function validateCdpParams(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(cdpParamsByMethod, method)) {
    throw invalidRequest("CDP method is not permitted");
  }
  const schema = cdpParamsByMethod[method as AllowedCdpMethod];
  const parsed = schema.parse(params) as Record<string, unknown>;
  assertJsonSafe(parsed);
  if (method === "Page.navigate") {
    parseHttpUrl(parsed.url as string);
    if (parsed.referrer !== undefined && parsed.referrer !== "") {
      parseHttpUrl(parsed.referrer as string);
    }
  } else if (method === "Network.getCookies") {
    for (const url of (parsed.urls as string[] | undefined) ?? []) {
      parseHttpUrl(url);
    }
  } else if (method === "Network.deleteCookies" && parsed.url !== undefined) {
    parseHttpUrl(parsed.url as string);
  }
  return parsed;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState >= SOCKET_CLOSING) return;
  const boundedReason = Array.from(reason).slice(0, 60).join("");
  socket.close(code, boundedReason);
  const timeout = setTimeout(() => {
    if (socket.readyState !== SOCKET_CLOSED) socket.terminate();
  }, STREAM_LIMITS.closeTimeoutMs);
  timeout.unref();
  socket.once("close", () => clearTimeout(timeout));
}

function createSocketSender(
  socket: WebSocket,
  onFailure: (code: number, reason: string) => void,
): SocketSender {
  const queue: QueuedMessage[] = [];
  let queuedBytes = 0;
  let sending = false;
  let closed = false;

  const pump = (): void => {
    if (closed || sending || socket.readyState !== SOCKET_OPEN) return;
    const next = queue.shift();
    if (next === undefined) return;
    queuedBytes -= next.bytes;
    sending = true;
    socket.send(next.data, (error) => {
      sending = false;
      if (error !== undefined) {
        onFailure(STREAM_CLOSE_CODES.internalError, "stream send failed");
        return;
      }
      pump();
    });
  };

  return Object.freeze({
    send(value, mode) {
      if (closed || socket.readyState !== SOCKET_OPEN) return false;
      let data: string;
      try {
        assertJsonSafe(value);
        data = JSON.stringify(value);
      } catch {
        onFailure(STREAM_CLOSE_CODES.internalError, "stream output is invalid");
        return false;
      }
      const bytes = Buffer.byteLength(data, "utf8");
      if (bytes > STREAM_LIMITS.frameBytes) {
        onFailure(
          STREAM_CLOSE_CODES.messageTooBig,
          "stream output is too large",
        );
        return false;
      }
      if (
        socket.bufferedAmount > STREAM_LIMITS.backpressureBytes ||
        queue.length >= STREAM_LIMITS.queuedMessages ||
        queuedBytes + bytes > STREAM_LIMITS.queuedBytes
      ) {
        if (mode === "droppable") return false;
        onFailure(
          STREAM_CLOSE_CODES.tryAgainLater,
          "stream backpressure limit",
        );
        return false;
      }
      queue.push({ bytes, data });
      queuedBytes += bytes;
      pump();
      return true;
    },
    close() {
      closed = true;
      queue.length = 0;
      queuedBytes = 0;
    },
  });
}

function onceSocketClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === SOCKET_CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
}

async function closeSocketAndWait(
  socket: WebSocket,
  code: number,
  reason: string,
): Promise<void> {
  if (socket.readyState !== SOCKET_CLOSED) {
    closeSocket(socket, code, reason);
    await onceSocketClosed(socket);
  }
}

function installHeartbeat(
  socket: WebSocket,
  intervalMs: number,
  timeoutMs: number,
): () => void {
  let pongReceived = true;
  let timeout: NodeJS.Timeout | undefined;
  const onPong = (): void => {
    pongReceived = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  socket.on("pong", onPong);
  const interval = setInterval(() => {
    if (socket.readyState !== SOCKET_OPEN) return;
    if (!pongReceived) {
      socket.terminate();
      return;
    }
    pongReceived = false;
    socket.ping();
    timeout = setTimeout(() => {
      if (!pongReceived && socket.readyState === SOCKET_OPEN)
        socket.terminate();
    }, timeoutMs);
    timeout.unref();
  }, intervalMs);
  interval.unref();
  return () => {
    clearInterval(interval);
    if (timeout !== undefined) clearTimeout(timeout);
    socket.off("pong", onPong);
  };
}

function interactiveCommand(
  input: z.infer<typeof interactiveInputSchema>,
): Readonly<{ method: string; params: Record<string, unknown> }> {
  if (input.kind === "text") {
    return { method: "Input.insertText", params: { text: input.text } };
  }
  if (input.kind === "wheel") {
    return {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseWheel",
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        ...(input.modifiers === undefined
          ? {}
          : { modifiers: input.modifiers }),
      },
    };
  }
  if (input.kind === "pointer") {
    return {
      method: "Input.dispatchMouseEvent",
      params: {
        type:
          input.action === "move"
            ? "mouseMoved"
            : input.action === "down"
              ? "mousePressed"
              : "mouseReleased",
        x: input.x,
        y: input.y,
        ...(input.button === undefined ? {} : { button: input.button }),
        ...(input.buttons === undefined ? {} : { buttons: input.buttons }),
        ...(input.clickCount === undefined
          ? {}
          : { clickCount: input.clickCount }),
        ...(input.modifiers === undefined
          ? {}
          : { modifiers: input.modifiers }),
      },
    };
  }
  return {
    method: "Input.dispatchKeyEvent",
    params: {
      type:
        input.action === "down"
          ? "keyDown"
          : input.action === "rawDown"
            ? "rawKeyDown"
            : input.action,
      key: input.key,
      code: input.code,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.unmodifiedText === undefined
        ? {}
        : { unmodifiedText: input.unmodifiedText }),
      ...(input.windowsVirtualKeyCode === undefined
        ? {}
        : { windowsVirtualKeyCode: input.windowsVirtualKeyCode }),
      ...(input.nativeVirtualKeyCode === undefined
        ? {}
        : { nativeVirtualKeyCode: input.nativeVirtualKeyCode }),
      ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
    },
  };
}

async function serveLiveStream(options: {
  socket: WebSocket;
  lease: SessionRuntimeLease;
  permission: "passive" | "interactive";
  runtimeApi: SessionStreamRuntimeApi;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  cleanupTimeoutMs: number;
  externalAbort: AbortSignal;
}): Promise<void> {
  const { socket, lease, permission, runtimeApi, externalAbort } = options;
  const { channel, lifecycle, runtimeSignal } = await openStreamCdpChannel({
    socket,
    lease,
    runtimeApi,
    externalAbort,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
  });
  let cleanupHeartbeat = (): void => undefined;
  let unsubscribe = (): void => undefined;
  let commandQueue = Promise.resolve();
  let queuedInputs = 0;
  let queuedInputBytes = 0;
  let lastFrameAt = Number.NEGATIVE_INFINITY;
  let sender: SocketSender | undefined;
  const fail = (code: number, reason: string): void => {
    lifecycle.beginClosing();
    sender?.close();
    closeSocket(socket, code, reason);
  };
  sender = createSocketSender(socket, fail);

  const onFrame = (raw: unknown): void => {
    if (lifecycle.isClosing() || socket.readyState !== SOCKET_OPEN) {
      lifecycle.beginClosing();
      return;
    }
    const parsed = screencastFrameSchema.safeParse(raw);
    if (!parsed.success) {
      fail(STREAM_CLOSE_CODES.internalError, "invalid screencast frame");
      return;
    }
    const frame = parsed.data.data;
    let frameBytes: number;
    try {
      const decoded = Buffer.from(frame, "base64");
      if (decoded.toString("base64") !== frame) {
        fail(STREAM_CLOSE_CODES.internalError, "invalid screencast encoding");
        return;
      }
      frameBytes = decoded.byteLength;
    } catch {
      fail(STREAM_CLOSE_CODES.internalError, "invalid screencast encoding");
      return;
    } finally {
      if (!lifecycle.isClosing()) {
        void lifecycle
          .commit(() =>
            runtimeApi.sendCdp(channel, "Page.screencastFrameAck", {
              sessionId: parsed.data.sessionId,
            }),
          )
          .catch(() =>
            fail(STREAM_CLOSE_CODES.internalError, "frame ack failed"),
          );
      }
    }
    if (frameBytes > STREAM_LIMITS.frameBytes) {
      fail(STREAM_CLOSE_CODES.messageTooBig, "screencast frame is too large");
      return;
    }
    const now = Date.now();
    if (now - lastFrameAt < 100) return;
    lastFrameAt = now;
    sender.send(
      {
        version: 1,
        kind: "frame",
        data: frame,
        metadata: parsed.data.metadata,
      },
      "droppable",
    );
  };

  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    if (lifecycle.isClosing() || socket.readyState !== SOCKET_OPEN) {
      lifecycle.beginClosing();
      return;
    }
    const bytes =
      typeof data === "string"
        ? Buffer.byteLength(data, "utf8")
        : Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data.byteLength;
    if (isBinary) {
      fail(STREAM_CLOSE_CODES.policyViolation, "binary input is forbidden");
      return;
    }
    if (permission === "passive") {
      fail(STREAM_CLOSE_CODES.policyViolation, "passive input is forbidden");
      return;
    }
    if (bytes > STREAM_LIMITS.interactiveInputBytes) {
      fail(STREAM_CLOSE_CODES.messageTooBig, "interactive input is too large");
      return;
    }
    let parsed: z.infer<typeof interactiveInputSchema>;
    try {
      parsed = interactiveInputSchema.parse(parseJsonFrame(data));
    } catch {
      fail(STREAM_CLOSE_CODES.policyViolation, "interactive input is invalid");
      return;
    }
    if (
      queuedInputs >= STREAM_LIMITS.queuedMessages ||
      queuedInputBytes + bytes > STREAM_LIMITS.interactiveInputBytes * 8
    ) {
      fail(STREAM_CLOSE_CODES.tryAgainLater, "interactive input queue is full");
      return;
    }
    const command = interactiveCommand(parsed);
    queuedInputs += 1;
    queuedInputBytes += bytes;
    commandQueue = commandQueue
      .then(() => {
        if (lifecycle.isClosing() || socket.readyState !== SOCKET_OPEN) {
          lifecycle.beginClosing();
          return;
        }
        return runtimeApi.sendCdp(channel, command.method, command.params);
      })
      .then(
        () => undefined,
        () =>
          fail(STREAM_CLOSE_CODES.internalError, "interactive input failed"),
      )
      .finally(() => {
        queuedInputs -= 1;
        queuedInputBytes -= bytes;
      });
    lifecycle.commit(() => commandQueue);
  };

  const onAbort = (): void =>
    fail(STREAM_CLOSE_CODES.serviceRestart, "stream authority ended");
  const onSocketClose = (): void => lifecycle.beginClosing();
  const onSocketError = (): void =>
    fail(STREAM_CLOSE_CODES.internalError, "stream socket failed");
  try {
    unsubscribe = runtimeApi.subscribeCdp(
      channel,
      SCREENCAST_FRAME_EVENT,
      onFrame,
    );
    socket.on("message", onMessage);
    socket.on("close", onSocketClose);
    socket.on("error", onSocketError);
    runtimeSignal.addEventListener("abort", onAbort, { once: true });
    externalAbort.addEventListener("abort", onAbort, { once: true });
    cleanupHeartbeat = installHeartbeat(
      socket,
      options.heartbeatIntervalMs,
      options.heartbeatTimeoutMs,
    );
    if (
      runtimeSignal.aborted ||
      externalAbort.aborted ||
      socket.readyState >= SOCKET_CLOSING
    ) {
      onAbort();
    }
    if (!lifecycle.isClosing()) {
      const started = lifecycle.commit(() =>
        runtimeApi.sendCdp(channel, "Page.startScreencast", {
          format: "jpeg",
          quality: 70,
          maxWidth: 1280,
          maxHeight: 720,
          everyNthFrame: 1,
        }),
      );
      const outcome = await Promise.race([
        started.then(() => "started" as const),
        lifecycle.whenClosing.then(() => "closing" as const),
      ]);
      if (outcome === "started" && !lifecycle.isClosing()) {
        await Promise.race([onceSocketClosed(socket), lifecycle.whenClosing]);
      }
    }
  } finally {
    lifecycle.beginClosing();
    sender.close();
    cleanupHeartbeat();
    socket.off("message", onMessage);
    socket.off("close", onSocketClose);
    socket.off("error", onSocketError);
    runtimeSignal.removeEventListener("abort", onAbort);
    externalAbort.removeEventListener("abort", onAbort);
    unsubscribe();
    await lifecycle.cleanup(() => runtimeApi.closeCdp(channel));
  }
}

async function serveCdpStream(options: {
  socket: WebSocket;
  lease: SessionRuntimeLease;
  runtimeApi: SessionStreamRuntimeApi;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  cleanupTimeoutMs: number;
  externalAbort: AbortSignal;
}): Promise<void> {
  const { socket, lease, runtimeApi, externalAbort } = options;
  const { channel, lifecycle, runtimeSignal } = await openStreamCdpChannel({
    socket,
    lease,
    runtimeApi,
    externalAbort,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
  });
  const outstanding = new Map<number, Promise<void>>();
  const unsubscribers: Array<() => void> = [];
  let cleanupHeartbeat = (): void => undefined;
  let sender: SocketSender | undefined;
  const fail = (code: number, reason: string): void => {
    lifecycle.beginClosing();
    sender?.close();
    closeSocket(socket, code, reason);
  };
  sender = createSocketSender(socket, fail);

  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    if (lifecycle.isClosing() || socket.readyState !== SOCKET_OPEN) {
      lifecycle.beginClosing();
      return;
    }
    const bytes =
      typeof data === "string"
        ? Buffer.byteLength(data, "utf8")
        : Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data.byteLength;
    if (isBinary) {
      fail(STREAM_CLOSE_CODES.policyViolation, "binary CDP is forbidden");
      return;
    }
    if (bytes > STREAM_LIMITS.cdpFrameBytes) {
      fail(STREAM_CLOSE_CODES.messageTooBig, "CDP frame is too large");
      return;
    }
    let request: z.infer<typeof cdpRequestSchema>;
    let params: Record<string, unknown>;
    try {
      const raw = parseJsonFrame(data);
      request = cdpRequestSchema.parse(raw);
      params = validateCdpParams(request.method, request.params ?? {});
    } catch {
      fail(STREAM_CLOSE_CODES.policyViolation, "CDP request is invalid");
      return;
    }
    if (
      outstanding.has(request.id) ||
      outstanding.size >= STREAM_LIMITS.cdpOutstandingIds
    ) {
      fail(STREAM_CLOSE_CODES.policyViolation, "CDP request ID is invalid");
      return;
    }
    const operation = lifecycle
      .commit(() => runtimeApi.sendCdp(channel, request.method, params))
      .then(
        (result) => {
          assertJsonSafe(result);
          const response = { id: request.id, result };
          if (encodedBytes(response) > STREAM_LIMITS.cdpFrameBytes) {
            fail(STREAM_CLOSE_CODES.messageTooBig, "CDP response is too large");
            return;
          }
          sender.send(response, "required");
        },
        () => {
          sender.send(
            {
              id: request.id,
              error: { code: -32_000, message: "CDP command failed" },
            },
            "required",
          );
        },
      )
      .catch(() => {
        fail(STREAM_CLOSE_CODES.internalError, "CDP response is invalid");
      })
      .finally(() => {
        outstanding.delete(request.id);
      });
    outstanding.set(request.id, operation);
    lifecycle.commit(() => operation);
  };

  const onAbort = (): void =>
    fail(STREAM_CLOSE_CODES.serviceRestart, "stream authority ended");
  const onSocketClose = (): void => lifecycle.beginClosing();
  const onSocketError = (): void =>
    fail(STREAM_CLOSE_CODES.internalError, "stream socket failed");
  try {
    for (const event of CDP_EVENT_ALLOWLIST) {
      unsubscribers.push(
        runtimeApi.subscribeCdp(channel, event, (params) => {
          if (lifecycle.isClosing()) return;
          try {
            assertJsonSafe(params);
            const response = { method: event, params };
            if (encodedBytes(response) > STREAM_LIMITS.cdpFrameBytes) {
              fail(STREAM_CLOSE_CODES.messageTooBig, "CDP event is too large");
              return;
            }
            sender.send(response, "required");
          } catch {
            fail(STREAM_CLOSE_CODES.internalError, "CDP event is invalid");
          }
        }),
      );
    }
    socket.on("message", onMessage);
    socket.on("close", onSocketClose);
    socket.on("error", onSocketError);
    runtimeSignal.addEventListener("abort", onAbort, { once: true });
    externalAbort.addEventListener("abort", onAbort, { once: true });
    cleanupHeartbeat = installHeartbeat(
      socket,
      options.heartbeatIntervalMs,
      options.heartbeatTimeoutMs,
    );
    if (
      runtimeSignal.aborted ||
      externalAbort.aborted ||
      socket.readyState >= SOCKET_CLOSING
    ) {
      onAbort();
    }
    if (!lifecycle.isClosing()) {
      await Promise.race([onceSocketClosed(socket), lifecycle.whenClosing]);
    }
  } finally {
    lifecycle.beginClosing();
    sender.close();
    cleanupHeartbeat();
    socket.off("message", onMessage);
    socket.off("close", onSocketClose);
    socket.off("error", onSocketError);
    runtimeSignal.removeEventListener("abort", onAbort);
    externalAbort.removeEventListener("abort", onAbort);
    for (const unsubscribe of unsubscribers) unsubscribe();
    await lifecycle.cleanup(() => runtimeApi.closeCdp(channel));
  }
}

const defaultRuntimeApi: SessionStreamRuntimeApi = Object.freeze({
  signal: sessionRuntimeSignal,
  openCdp: openSessionCdpChannel,
  sendCdp: sendSessionCdpCommand,
  subscribeCdp: subscribeSessionCdpEvent,
  closeCdp: closeSessionCdpChannel,
});

export function createRelayGrantManager(options: {
  registry: Pick<SessionRegistry, "get" | "withRuntime">;
  binding: ControlGenerationBinding;
  authBinding: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  runtimeApi?: SessionStreamRuntimeApi;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}): RelayGrantManager {
  const binding = z
    .strictObject({
      processNonce: tokenSchema,
      controlGenerationNonce: tokenSchema,
    })
    .parse(options.binding);
  const auth = authoritySchema.shape.authBinding.parse(options.authBinding);
  const authHash = digest(auth);
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? systemRandomBytes;
  const runtimeApi = options.runtimeApi ?? defaultRuntimeApi;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
  const cleanupTimeoutMs =
    options.cleanupTimeoutMs ?? STREAM_LIMITS.closeTimeoutMs;
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    !Number.isSafeInteger(heartbeatTimeoutMs) ||
    heartbeatTimeoutMs <= 0 ||
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0
  ) {
    throw new RangeError("stream timing bounds must be positive integers");
  }

  const grantsById = new Map<string, GrantRecord>();
  const grantsByHash = new Map<string, GrantRecord>();
  const issuedTokenHashes = new Set<string>();
  const activeStreams = new Set<ActiveStream>();
  let draining = false;
  let drainPromise: Promise<void> | undefined;

  const expireRecord = (record: GrantRecord): void => {
    if (record.state === "active") {
      record.state = "expired";
      grantsByHash.delete(record.tokenHash.toString("hex"));
    }
  };

  const manager: RelayGrantManager = Object.freeze({
    create(runtimeSessionId, input) {
      if (draining) throw browserUnavailable("relay grants are draining");
      canonicalUuidSchema.parse(runtimeSessionId);
      const request = createRelayGrantV1Schema.parse(input);
      if (grantsById.has(request.grantId)) {
        throw invalidRequest("relay grant ID already exists");
      }
      if (grantsById.size >= STREAM_LIMITS.grantHistory) {
        throw browserUnavailable("relay grant history is exhausted");
      }
      const session = options.registry.get(runtimeSessionId);
      if (
        session === undefined ||
        session.runtimeSessionId !== runtimeSessionId
      ) {
        throw invalidRequest("relay grant session is unavailable");
      }
      const expiresAtMs = Date.parse(request.expiresAt);
      if (expiresAtMs <= now() || expiresAtMs > Date.parse(session.expiresAt)) {
        throw invalidRequest("relay grant expiry is invalid");
      }
      const tokenBytes = Buffer.from(randomBytes(32));
      if (tokenBytes.byteLength !== 32) {
        throw new Error("relay token source returned an invalid byte count");
      }
      const relayToken = tokenBytes.toString("base64url");
      const tokenHash = digest(relayToken);
      const tokenKey = tokenHash.toString("hex");
      if (issuedTokenHashes.has(tokenKey)) {
        throw new Error("relay token source returned a duplicate token");
      }
      const record: GrantRecord = {
        grantId: request.grantId,
        runtimeSessionId,
        permission: request.permission,
        expiresAt: request.expiresAt,
        expiresAtMs,
        tokenHash,
        authHash,
        processNonce: binding.processNonce,
        controlGenerationNonce: binding.controlGenerationNonce,
        state: "active",
      };
      grantsById.set(record.grantId, record);
      grantsByHash.set(tokenKey, record);
      issuedTokenHashes.add(tokenKey);
      return relayGrantV1Schema.parse({
        version: 1,
        grantId: request.grantId,
        permission: request.permission,
        expiresAt: request.expiresAt,
        relayToken,
      });
    },

    async revoke(runtimeSessionId, input) {
      canonicalUuidSchema.parse(runtimeSessionId);
      const request = revokeRelayGrantV1Schema.parse(input);
      const record = grantsById.get(request.grantId);
      if (
        record !== undefined &&
        record.runtimeSessionId !== runtimeSessionId
      ) {
        throw invalidRequest("relay grant is unavailable");
      }
      if (record === undefined) {
        return revokedRelayGrantV1Schema.parse({
          version: 1,
          grantId: request.grantId,
          revoked: true,
        });
      }
      grantsByHash.delete(record.tokenHash.toString("hex"));
      if (record.state !== "consumed") record.state = "revoked";
      if (record.active?.socket !== undefined) {
        closeSocket(
          record.active.socket,
          STREAM_CLOSE_CODES.policyViolation,
          "relay grant revoked",
        );
      }
      const active = record.active;
      active?.abort.abort();
      if (active !== undefined) {
        const releaseTimeoutMs =
          STREAM_LIMITS.closeTimeoutMs + cleanupTimeoutMs + 250;
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          active.done.then(() => "released" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(resolve, releaseTimeoutMs, "timeout");
            timer.unref();
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === "timeout") {
          throw browserUnavailable("relay writer release is unverified");
        }
      }
      return revokedRelayGrantV1Schema.parse({
        version: 1,
        grantId: request.grantId,
        revoked: true,
      });
    },

    async open(input, upgrade) {
      if (draining) throw browserUnavailable("relay streams are draining");
      const request = openRelaySchema.parse(input);
      const presentedHash = digest(request.relayToken);
      const record = grantsByHash.get(presentedHash.toString("hex"));
      const presentedAuthHash = digest(request.authority.authBinding);
      if (
        record === undefined ||
        record.state !== "active" ||
        !sameDigest(record.tokenHash, presentedHash) ||
        !sameDigest(record.authHash, presentedAuthHash) ||
        record.runtimeSessionId !== request.runtimeSessionId ||
        record.permission !== request.permission ||
        record.processNonce !== request.authority.processNonce ||
        record.controlGenerationNonce !==
          request.authority.controlGenerationNonce ||
        request.authority.processNonce !== binding.processNonce ||
        request.authority.controlGenerationNonce !==
          binding.controlGenerationNonce
      ) {
        throw unauthorizedGrant();
      }
      if (record.expiresAtMs <= now()) {
        expireRecord(record);
        throw unauthorizedGrant();
      }
      grantsByHash.delete(record.tokenHash.toString("hex"));
      record.state = "redeemed";

      let settle!: () => void;
      const active: ActiveStream = {
        abort: new AbortController(),
        done: new Promise<void>((resolve) => {
          settle = resolve;
        }),
        settle: () => settle(),
      };
      record.active = active;
      activeStreams.add(active);
      let streamFailure: unknown;
      try {
        const mode = request.permission === "passive" ? "passive" : "writer";
        await options.registry.withRuntime(
          request.runtimeSessionId,
          mode,
          async (lease) => {
            if (active.abort.signal.aborted || draining) {
              throw browserUnavailable("relay stream authority ended");
            }
            const socket = await upgrade();
            active.socket = socket;
            if (active.abort.signal.aborted || draining) {
              await closeSocketAndWait(
                socket,
                STREAM_CLOSE_CODES.serviceRestart,
                "stream authority ended",
              );
              throw browserUnavailable("relay stream authority ended");
            }
            try {
              if (request.permission === "cdp") {
                await serveCdpStream({
                  socket,
                  lease,
                  runtimeApi,
                  heartbeatIntervalMs,
                  heartbeatTimeoutMs,
                  cleanupTimeoutMs,
                  externalAbort: active.abort.signal,
                });
              } else {
                await serveLiveStream({
                  socket,
                  lease,
                  permission: request.permission,
                  runtimeApi,
                  heartbeatIntervalMs,
                  heartbeatTimeoutMs,
                  cleanupTimeoutMs,
                  externalAbort: active.abort.signal,
                });
              }
            } catch (cause) {
              streamFailure = cause;
              await closeSocketAndWait(
                socket,
                STREAM_CLOSE_CODES.internalError,
                "stream setup or cleanup failed",
              );
              throw cause;
            } finally {
              await closeSocketAndWait(
                socket,
                STREAM_CLOSE_CODES.normal,
                "stream complete",
              );
            }
          },
        );
      } catch (cause) {
        if (streamFailure instanceof BrowserServiceError) {
          throw streamFailure;
        }
        if (cause instanceof AggregateError) {
          throw browserUnavailable("stream runtime cleanup is unverified");
        }
        throw cause;
      } finally {
        activeStreams.delete(active);
        delete record.active;
        if (record.state === "redeemed") record.state = "consumed";
        active.settle();
      }
    },

    sweepExpired() {
      let count = 0;
      const timestamp = now();
      for (const record of grantsById.values()) {
        if (record.state === "active" && record.expiresAtMs <= timestamp) {
          expireRecord(record);
          count += 1;
        }
      }
      return count;
    },

    drain() {
      if (drainPromise !== undefined) return drainPromise;
      draining = true;
      drainPromise = (async () => {
        const completions = [...activeStreams].map((active) => {
          active.abort.abort();
          if (active.socket !== undefined) {
            closeSocket(
              active.socket,
              STREAM_CLOSE_CODES.serviceRestart,
              "service runtime draining",
            );
          }
          return active.done;
        });
        for (const record of grantsById.values()) {
          grantsByHash.delete(record.tokenHash.toString("hex"));
          if (record.state !== "consumed") record.state = "revoked";
        }
        await Promise.all(completions);
        grantsByHash.clear();
        issuedTokenHashes.clear();
        grantsById.clear();
      })();
      return drainPromise;
    },

    inventory() {
      let grants = 0;
      for (const record of grantsById.values()) {
        if (record.state === "active" || record.state === "redeemed") {
          grants += 1;
        }
      }
      return Object.freeze({ grants, streams: activeStreams.size });
    },
  });
  return manager;
}

export type {
  CreateRelayGrantV1,
  RelayGrantV1,
  RevokeRelayGrantV1,
  RevokedRelayGrantV1,
};
