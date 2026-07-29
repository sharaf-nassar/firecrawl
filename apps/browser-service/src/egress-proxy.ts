import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerOptions,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import {
  NetworkPolicyError,
  parseConnectAuthority,
  resolvePublicTarget,
  systemPublicLookup,
  type PublicLookup,
  type ResolvedPublicTarget,
} from "./network-policy.js";

export const MAX_REQUEST_HEADER_BYTES = 32 * 1024;
export const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
export const MAX_HTTP_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_CONNECT_DIRECTION_BYTES = 128 * 1024 * 1024;
export const MAX_CONNECT_TUNNELS = 32;
export const PROXY_IDLE_TIMEOUT_MS = 60_000;
export const PROXY_MAX_LIFETIME_MS = 3_600_000;
export const AD_SERVING_DOMAINS = Object.freeze([
  "doubleclick.net",
  "adservice.google.com",
  "googlesyndication.com",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adsystem.com",
  "adservice.com",
  "adnxs.com",
  "ads-twitter.com",
  "facebook.net",
  "fbcdn.net",
  "amazon-adsystem.com",
]);

export type EgressDial = (options: {
  address: string;
  port: number;
  hostname: string;
  signal: AbortSignal;
}) => Socket | Promise<Socket>;

export type EgressDecision = {
  outcome: "allowed" | "blocked";
  hostname: string;
};

export type EgressProxyLimits = {
  tunnelDirectionBytes?: number;
  httpBodyBytes?: number;
  responseHeaderBytes?: number;
  idleTimeoutMs?: number;
  lifetimeMs?: number;
};

export type EgressProxyOptions = {
  lookup?: PublicLookup;
  dial?: EgressDial;
  signal?: AbortSignal;
  deadlineAtMs?: number | (() => number);
  maxTunnels?: number;
  limits?: EgressProxyLimits;
  tlsCa?: string | Buffer;
  onDecision?: (decision: EgressDecision) => void;
  restoreGate?: RestoreGate;
  allowedDomains?: readonly string[];
  blockAds?: boolean;
};

export type EgressProxy = {
  url: string;
  port: number;
  restoreGate: RestoreGate | undefined;
  liveSocketCount: () => number;
  close: () => Promise<void>;
};

export type RestoreGateState = "restore_closed" | "open" | "closed";
export type RestoreIngressCategory = "http" | "connect" | "upgrade";
export type RestoreGateCounter =
  | "ingressAttempts"
  | "ingressViolations"
  | "dnsResolutions"
  | "policyDecisions"
  | "dials";
export type RestoreGateCounters = Record<RestoreGateCounter, number>;
export type RestorePositiveControlBaseline = {
  counters: RestoreGateCounters;
  controlId: number;
};
export type RestoreIngressToken = Readonly<{ sequence: number }>;

export type RestoreGate = {
  readonly state: RestoreGateState;
  readonly counters: Readonly<RestoreGateCounters>;
  readonly recordedCategory: RestoreIngressCategory | null;
  beginIngress(
    category: RestoreIngressCategory,
    target?: string,
  ): RestoreIngressToken | false;
  recordDnsResolution(token?: RestoreIngressToken): void;
  recordPolicyDecision(token?: RestoreIngressToken): void;
  recordDial(token?: RestoreIngressToken): void;
  completeIngress(token: RestoreIngressToken): void;
  assertZeroViolations(): void;
  open(): void;
  close(): void;
  snapshot(): {
    state: RestoreGateState;
    counters: RestoreGateCounters;
  };
  completeCounterSnapshot(): RestoreGateCounters;
  markPositiveControlBaseline(
    requestedUrl: string,
  ): RestorePositiveControlBaseline;
  assertPositiveControl(
    baseline: RestorePositiveControlBaseline,
    requestedUrl: string,
  ): void;
};

export class RestoreGateError extends Error {
  readonly category:
    | "restore_gate_invalid_state"
    | "restore_ingress_violation"
    | "restore_counter_overflow";

  constructor(category: RestoreGateError["category"]) {
    super(category);
    this.name = "RestoreGateError";
    this.category = category;
  }
}

export function createRestoreGate(
  initialCounters: Partial<RestoreGateCounters> = {},
): RestoreGate {
  let state: RestoreGateState = "restore_closed";
  const counters: RestoreGateCounters = {
    ingressAttempts: 0,
    ingressViolations: 0,
    dnsResolutions: 0,
    policyDecisions: 0,
    dials: 0,
    ...initialCounters,
  };
  for (const value of Object.values(counters)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        "restore gate counters must be safe nonnegative integers",
      );
    }
  }
  let recordedCategory: RestoreIngressCategory | null = null;
  type IngressAttempt = {
    token: RestoreIngressToken;
    category: RestoreIngressCategory;
    target: string;
    pipeline: string[];
  };
  const activeIngressAttempts = new Map<number, IngressAttempt>();
  const completedIngressAttempts = new Map<number, IngressAttempt>();
  const completedIngressTokens = new WeakSet<RestoreIngressToken>();
  const positiveControls = new Map<
    number,
    {
      requestedUrl: string;
      pipeline: string[] | undefined;
      sequence: number | undefined;
      minimumSequence: number;
    }
  >();
  let nextControlId = 1;

  function incrementMany(values: readonly RestoreGateCounter[]): void {
    if (
      values.some((counter) => counters[counter] === Number.MAX_SAFE_INTEGER)
    ) {
      state = "closed";
      throw new RestoreGateError("restore_counter_overflow");
    }
    for (const counter of values) counters[counter] += 1;
  }

  function increment(counter: RestoreGateCounter): void {
    incrementMany([counter]);
  }

  function activeAttempt(
    token: RestoreIngressToken | undefined,
  ): IngressAttempt {
    if (token === undefined) {
      state = "closed";
      throw new RestoreGateError("restore_ingress_violation");
    }
    const attempt = activeIngressAttempts.get(token.sequence);
    if (attempt === undefined || attempt.token !== token) {
      state = "closed";
      throw new RestoreGateError("restore_ingress_violation");
    }
    return attempt;
  }

  function latchPositiveControls(attempt: IngressAttempt): void {
    const completedPipeline = [
      "ingress-linearize",
      "dns",
      "policy",
      "dial",
    ].join("\0");
    if (attempt.pipeline.join("\0") !== completedPipeline) return;
    for (const control of positiveControls.values()) {
      if (
        control.pipeline === undefined &&
        attempt.token.sequence > control.minimumSequence &&
        ingressTargetsMatch(attempt, control.requestedUrl)
      ) {
        control.pipeline = [...attempt.pipeline];
        control.sequence = attempt.token.sequence;
      }
    }
  }

  function completeIngressAttempt(token: RestoreIngressToken): void {
    if (completedIngressTokens.has(token)) return;
    const attempt = activeAttempt(token)!;
    activeIngressAttempts.delete(token.sequence);
    completedIngressTokens.add(token);
    completedIngressAttempts.set(token.sequence, attempt);
    if (completedIngressAttempts.size > 256) {
      const oldest = completedIngressAttempts.keys().next().value;
      if (oldest !== undefined) completedIngressAttempts.delete(oldest);
    }
    latchPositiveControls(attempt);
  }

  const gate: RestoreGate = {
    get state() {
      return state;
    },
    get counters() {
      return Object.freeze({ ...counters });
    },
    get recordedCategory() {
      return recordedCategory;
    },
    beginIngress(category, target) {
      if (state === "restore_closed") {
        incrementMany(["ingressAttempts", "ingressViolations"]);
        recordedCategory = category;
        return false;
      }
      if (state !== "open") {
        increment("ingressAttempts");
        return false;
      }
      if (activeIngressAttempts.size >= 256) {
        state = "closed";
        throw new RestoreGateError("restore_ingress_violation");
      }
      increment("ingressAttempts");
      const token = Object.freeze({ sequence: counters.ingressAttempts });
      const normalized =
        target === undefined ? null : normalizeIngressTarget(category, target);
      activeIngressAttempts.set(token.sequence, {
        token,
        category,
        target: normalized ?? "",
        pipeline: ["ingress-linearize"],
      });
      return token;
    },
    recordDnsResolution(token) {
      if (state !== "open") {
        throw new RestoreGateError("restore_gate_invalid_state");
      }
      const attempt = activeAttempt(token);
      increment("dnsResolutions");
      attempt.pipeline.push("dns");
    },
    recordPolicyDecision(token) {
      if (state !== "open") {
        throw new RestoreGateError("restore_gate_invalid_state");
      }
      const attempt = activeAttempt(token);
      increment("policyDecisions");
      attempt.pipeline.push("policy");
    },
    recordDial(token) {
      if (state !== "open") {
        throw new RestoreGateError("restore_gate_invalid_state");
      }
      const attempt = activeAttempt(token);
      increment("dials");
      attempt.pipeline.push("dial");
      latchPositiveControls(attempt);
    },
    completeIngress(token) {
      completeIngressAttempt(token);
    },
    assertZeroViolations() {
      if (counters.ingressViolations !== 0) {
        throw new RestoreGateError("restore_ingress_violation");
      }
    },
    open() {
      if (state !== "restore_closed") {
        throw new RestoreGateError("restore_gate_invalid_state");
      }
      if (counters.ingressViolations !== 0) {
        throw new RestoreGateError("restore_ingress_violation");
      }
      state = "open";
    },
    close() {
      state = "closed";
    },
    snapshot() {
      return { state, counters: { ...counters } };
    },
    completeCounterSnapshot() {
      return { ...counters };
    },
    markPositiveControlBaseline(requestedUrl) {
      if (state !== "open") {
        throw new RestoreGateError("restore_gate_invalid_state");
      }
      const controlId = nextControlId;
      nextControlId += 1;
      positiveControls.set(controlId, {
        requestedUrl: new URL(requestedUrl).href,
        pipeline: undefined,
        sequence: undefined,
        minimumSequence: counters.ingressAttempts,
      });
      if (positiveControls.size > 16) {
        state = "closed";
        throw new RestoreGateError("restore_ingress_violation");
      }
      return {
        counters: { ...counters },
        controlId,
      };
    },
    assertPositiveControl(baseline, requestedUrl) {
      const before = baseline.counters;
      const countersMatch =
        counters.ingressAttempts > before.ingressAttempts &&
        counters.ingressViolations === before.ingressViolations &&
        counters.dnsResolutions > before.dnsResolutions &&
        counters.policyDecisions > before.policyDecisions &&
        counters.dials > before.dials;
      const control = positiveControls.get(baseline.controlId);
      positiveControls.delete(baseline.controlId);
      const controlMatches =
        control !== undefined &&
        control.requestedUrl === new URL(requestedUrl).href &&
        control.pipeline?.join("\0") ===
          ["ingress-linearize", "dns", "policy", "dial"].join("\0");
      if (!countersMatch || !controlMatches) {
        state = "closed";
        throw new RestoreGateError("restore_ingress_violation");
      }
    },
  };
  return gate;
}

const defaultDial: EgressDial = ({ address, port, signal }) =>
  netConnect({ allowHalfOpen: true, host: address, port, signal });

export async function proxyConnect(
  authority: string,
  options: Pick<EgressProxyOptions, "lookup" | "dial" | "signal"> = {},
): Promise<Socket> {
  const linked = linkedAbortController(options.signal);
  const controller = linked.controller;
  let socket: Socket | undefined;
  let ownershipTransferred = false;
  try {
    const parsed = parseConnectAuthority(authority);
    const target = await abortable(
      resolvePublicTarget(
        `https://${parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname}:${parsed.port}/`,
        options.lookup ?? systemPublicLookup,
      ),
      controller.signal,
    );
    socket = await dialWithAbort(
      options.dial ?? defaultDial,
      {
        address: target.addresses[0]!,
        port: parsed.port,
        hostname: target.hostname,
      },
      controller.signal,
    );
    await waitForConnectionWithAbort(socket, controller.signal);
    if (controller.signal.aborted || socket.destroyed) {
      throw abortError(controller.signal.reason);
    }
    socket.once("close", linked.unlink);
    ownershipTransferred = true;
    return socket;
  } finally {
    if (!ownershipTransferred) {
      socket?.destroy();
      linked.unlink();
    }
  }
}

export async function createEgressProxy(
  options: EgressProxyOptions = {},
): Promise<EgressProxy> {
  const lookup = options.lookup ?? systemPublicLookup;
  const dial = options.dial ?? defaultDial;
  const maxTunnels = validatedLimit(
    "maxTunnels",
    options.maxTunnels,
    MAX_CONNECT_TUNNELS,
  );
  const limits = effectiveLimits(options.limits);
  const requestHeaderBytes = validatedLimit(
    "requestHeaderBytes",
    undefined,
    MAX_REQUEST_HEADER_BYTES,
  );
  const rootLink = linkedAbortController(options.signal);
  const rootController = rootLink.controller;
  const sockets = new Set<Socket>();
  let activeTunnels = 0;
  let closed = false;

  const serverOptions: ServerOptions & { allowHalfOpen: boolean } = {
    allowHalfOpen: true,
    maxHeaderSize: requestHeaderBytes,
    keepAliveTimeout: limits.idleTimeoutMs,
    requestTimeout: limits.idleTimeoutMs,
  };
  const server = createServer(serverOptions);

  const forwardOptions = (
    restoreAttempt: RestoreIngressToken | undefined,
  ): ForwardOptions => ({
    lookup: async (hostname) => {
      options.restoreGate?.recordDnsResolution(restoreAttempt);
      return lookup(hostname);
    },
    dial: (dialOptions) => {
      options.restoreGate?.recordDial(restoreAttempt);
      return dial(dialOptions);
    },
    rootSignal: rootController.signal,
    deadlineAtMs: options.deadlineAtMs,
    onDecision: options.onDecision,
    restoreGate: options.restoreGate,
    restoreAttempt,
    allowedDomains: options.allowedDomains,
    blockAds: options.blockAds === true,
    limits,
    tlsCa: options.tlsCa,
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(limits.idleTimeoutMs, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) {
      socket.end(
        "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n",
      );
    }
  });

  server.on("request", (request, response) => {
    const ingress = admitIngress(options.restoreGate, "http", request.url);
    if (!ingress.admitted) {
      writeResponseError(response, 503);
      return;
    }
    void forwardHttpRequest(
      request,
      response,
      forwardOptions(ingress.token),
    )
      .catch(() => {
        writeResponseError(response, 503);
      })
      .finally(() =>
        completeAdmittedIngress(options.restoreGate, ingress.token),
      );
  });

  server.on("connect", (request, client, head) => {
    const clientSocket = client as Socket;
    const ingress = admitIngress(options.restoreGate, "connect", request.url);
    if (!ingress.admitted) {
      writeSocketError(clientSocket, 503, "Service Unavailable");
      return;
    }
    if (activeTunnels >= maxTunnels) {
      completeAdmittedIngress(options.restoreGate, ingress.token);
      writeSocketError(clientSocket, 503, "Service Unavailable");
      return;
    }
    activeTunnels += 1;
    void forwardConnect(
      request,
      clientSocket,
      head,
      forwardOptions(ingress.token),
    )
      .catch(() => {
        writeSocketError(clientSocket, 503, "Service Unavailable");
      })
      .finally(() => {
        completeAdmittedIngress(options.restoreGate, ingress.token);
        activeTunnels -= 1;
      });
  });

  server.on("upgrade", (request, client, head) => {
    const clientSocket = client as Socket;
    const ingress = admitIngress(options.restoreGate, "upgrade", request.url);
    if (!ingress.admitted) {
      writeSocketError(clientSocket, 503, "Service Unavailable");
      return;
    }
    if (activeTunnels >= maxTunnels) {
      completeAdmittedIngress(options.restoreGate, ingress.token);
      writeSocketError(clientSocket, 503, "Service Unavailable");
      return;
    }
    activeTunnels += 1;
    void forwardUpgrade(
      request,
      clientSocket,
      head,
      forwardOptions(ingress.token),
    )
      .catch(() => {
        writeSocketError(clientSocket, 503, "Service Unavailable");
      })
      .finally(() => {
        completeAdmittedIngress(options.restoreGate, ingress.token);
        activeTunnels -= 1;
      });
  });

  rootController.signal.addEventListener(
    "abort",
    () => {
      for (const socket of sockets) socket.destroy();
    },
    { once: true },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    rootController.abort();
    rootLink.unlink();
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    rootController.abort();
    rootLink.unlink();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    await waitForSocketSetToDrain(sockets);
    throw new Error("egress proxy did not bind TCP");
  }

  let closePromise: Promise<void> | undefined;
  let listenerClosed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closePromise !== undefined) return closePromise;
    options.restoreGate?.close();
    rootController.abort();
    rootLink.unlink();
    for (const socket of sockets) socket.destroy();
    closePromise = (async () => {
      if (!listenerClosed) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        });
        listenerClosed = true;
      }
      for (const socket of sockets) socket.destroy();
      await waitForSocketSetToDrain(sockets);
      if (sockets.size !== 0) {
        throw new Error("egress proxy sockets did not drain");
      }
      closed = true;
    })().finally(() => {
      if (!closed) closePromise = undefined;
    });
    return closePromise;
  };

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    restoreGate: options.restoreGate,
    liveSocketCount: () => sockets.size,
    close,
  };
}

async function waitForSocketSetToDrain(sockets: Set<Socket>): Promise<void> {
  await Promise.all(
    [...sockets].map(
      (socket) =>
        new Promise<void>((resolve) => socket.once("close", resolve)),
    ),
  );
}

type ForwardOptions = {
  lookup: PublicLookup;
  dial: EgressDial;
  rootSignal: AbortSignal;
  deadlineAtMs: number | (() => number) | undefined;
  onDecision: ((decision: EgressDecision) => void) | undefined;
  restoreGate: RestoreGate | undefined;
  restoreAttempt: RestoreIngressToken | undefined;
  allowedDomains: readonly string[] | undefined;
  blockAds: boolean;
  limits: EffectiveLimits;
  tlsCa: string | Buffer | undefined;
};

function admitIngress(
  gate: RestoreGate | undefined,
  category: RestoreIngressCategory,
  target: string | undefined,
): { admitted: boolean; token: RestoreIngressToken | undefined } {
  if (gate === undefined) return { admitted: true, token: undefined };
  try {
    const token = gate.beginIngress(category, target);
    return token === false
      ? { admitted: false, token: undefined }
      : { admitted: true, token };
  } catch (error) {
    if (error instanceof RestoreGateError)
      return { admitted: false, token: undefined };
    throw error;
  }
}

function completeAdmittedIngress(
  gate: RestoreGate | undefined,
  token: RestoreIngressToken | undefined,
): void {
  if (gate === undefined || token === undefined) return;
  try {
    gate.completeIngress(token);
  } catch (error) {
    if (!(error instanceof RestoreGateError)) throw error;
  }
}

function ingressTargetsMatch(
  observation: { category: RestoreIngressCategory; target: string },
  requestedUrl: string,
): boolean {
  try {
    const requested = new URL(requestedUrl);
    if (observation.category === "connect") {
      const expectedPort = Number(
        requested.port ||
          (requested.protocol === "https:" || requested.protocol === "wss:"
            ? "443"
            : "80"),
      );
      return (
        observation.target ===
        `${requested.hostname.toLowerCase()}\0${expectedPort}`
      );
    }
    return observation.target === requested.href;
  } catch {
    return false;
  }
}

function normalizeIngressTarget(
  category: RestoreIngressCategory,
  target: string,
): string | null {
  if (Buffer.byteLength(target, "utf8") > MAX_REQUEST_HEADER_BYTES) return null;
  try {
    if (category === "connect") {
      const authority = parseConnectAuthority(target);
      return `${authority.hostname}\0${authority.port}`;
    }
    return new URL(target).href;
  } catch {
    return null;
  }
}

function reportDecision(
  options: ForwardOptions,
  decision: EgressDecision,
): void {
  options.restoreGate?.recordPolicyDecision(options.restoreAttempt);
  options.onDecision?.(decision);
}

function assertEgressPolicy(options: ForwardOptions, hostname: string): void {
  const normalized = hostname.toLowerCase();
  if (
    options.allowedDomains !== undefined &&
    !options.allowedDomains.some((allowed) => {
      const domain = allowed.toLowerCase();
      return normalized === domain || normalized.endsWith(`.${domain}`);
    })
  ) {
    throw new NetworkPolicyError(
      "target_blocked",
      "target domain is not allowed",
      normalized,
    );
  }
  if (
    options.blockAds &&
    AD_SERVING_DOMAINS.some((domain) => normalized.includes(domain))
  ) {
    throw new NetworkPolicyError(
      "target_blocked",
      "ad-serving target is blocked",
      normalized,
    );
  }
}

function reportBlockedDecision(
  error: unknown,
  target: string | undefined,
  options: ForwardOptions,
): void {
  if (error instanceof RestoreGateError) return;
  options.restoreGate?.recordPolicyDecision(options.restoreAttempt);
  reportBlocked(error, target, options.onDecision);
}

type EffectiveLimits = {
  tunnelDirectionBytes: number;
  httpBodyBytes: number;
  responseHeaderBytes: number;
  idleTimeoutMs: number;
  lifetimeMs: number;
};

function effectiveLimits(
  input: EgressProxyLimits | undefined,
): EffectiveLimits {
  return {
    tunnelDirectionBytes: validatedLimit(
      "tunnelDirectionBytes",
      input?.tunnelDirectionBytes,
      MAX_CONNECT_DIRECTION_BYTES,
    ),
    httpBodyBytes: validatedLimit(
      "httpBodyBytes",
      input?.httpBodyBytes,
      MAX_HTTP_BODY_BYTES,
    ),
    responseHeaderBytes: validatedLimit(
      "responseHeaderBytes",
      input?.responseHeaderBytes,
      MAX_RESPONSE_HEADER_BYTES,
    ),
    idleTimeoutMs: validatedLimit(
      "idleTimeoutMs",
      input?.idleTimeoutMs,
      PROXY_IDLE_TIMEOUT_MS,
    ),
    lifetimeMs: validatedLimit(
      "lifetimeMs",
      input?.lifetimeMs,
      PROXY_MAX_LIFETIME_MS,
    ),
  };
}

function validatedLimit(
  name: string,
  input: number | undefined,
  maximum: number,
): number {
  const value = input ?? maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

async function forwardHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ForwardOptions,
): Promise<void> {
  const controller = requestController(options);
  controller.bind(request.socket);
  request.once("aborted", () => controller.abort());
  response.once("close", () => controller.finish());
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string" &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > options.limits.httpBodyBytes
  ) {
    writeResponseError(response, 413);
    controller.abort();
    return;
  }
  let target: ResolvedPublicTarget;
  try {
    target = await abortable(
      resolvePlainRequestTarget(request.url, options.lookup),
      controller.signal,
    );
    assertEgressPolicy(options, target.hostname);
    reportDecision(options, { outcome: "allowed", hostname: target.hostname });
  } catch (error) {
    reportBlockedDecision(error, request.url, options);
    writeResponseError(response, statusForError(error));
    controller.abort();
    return;
  }

  const headers = sanitizedHeaders(request.headers);
  headers.host = target.url.host;
  let upstreamSocket: Socket;
  let agent: HttpAgent | HttpsAgent;
  try {
    const pinned = await pinnedAgent(
      target,
      options.dial,
      controller.signal,
      options.tlsCa,
    );
    upstreamSocket = pinned.rawSocket;
    agent = pinned.agent;
  } catch {
    writeResponseError(response, 502);
    controller.abort();
    return;
  }
  const requester =
    target.url.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = requester(
    {
      protocol: target.url.protocol,
      hostname: target.addresses[0],
      port: target.port,
      method: request.method,
      path: `${target.url.pathname}${target.url.search}`,
      headers,
      agent,
      maxHeaderSize: options.limits.responseHeaderBytes,
      signal: controller.signal,
      servername: target.hostname,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        sanitizedHeaders(upstreamResponse.headers),
      );
      pipeBounded(
        upstreamResponse,
        response,
        options.limits.httpBodyBytes,
        () => {
          upstreamResponse.destroy();
          response.destroy();
        },
      );
    },
  );
  upstream.once("error", () => {
    if (!response.headersSent) writeResponseError(response, 502);
    else response.destroy();
  });
  response.once("close", () => {
    upstream.destroy();
    upstreamSocket.destroy();
  });
  pipeBounded(request, upstream, options.limits.httpBodyBytes, () => {
    controller.abort();
    request.destroy();
    upstream.destroy();
    if (!response.headersSent) writeResponseError(response, 413);
  });
}

async function forwardConnect(
  request: IncomingMessage,
  client: Socket,
  head: Buffer,
  options: ForwardOptions,
): Promise<void> {
  const controller = requestController(options);
  controller.bind(client);
  client.once("close", () => controller.abort());
  if (head.length > options.limits.tunnelDirectionBytes) {
    controller.abort();
    return;
  }
  let parsed: ReturnType<typeof parseConnectAuthority>;
  try {
    parsed = parseConnectAuthority(request.url ?? "");
    assertConnectHost(request, parsed);
  } catch (error) {
    reportBlockedDecision(error, request.url, options);
    writeSocketError(
      client,
      statusForError(error),
      statusText(statusForError(error)),
    );
    controller.abort();
    return;
  }
  let target: ResolvedPublicTarget;
  try {
    target = await abortable(
      resolvePublicTarget(
        `https://${parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname}:${parsed.port}/`,
        options.lookup,
      ),
      controller.signal,
    );
  } catch (error) {
    reportBlockedDecision(error, parsed.hostname, options);
    writeSocketError(
      client,
      statusForError(error),
      statusText(statusForError(error)),
    );
    controller.abort();
    return;
  }
  try {
    assertEgressPolicy(options, target.hostname);
    reportDecision(options, { outcome: "allowed", hostname: target.hostname });
  } catch (error) {
    reportBlockedDecision(error, target.hostname, options);
    writeSocketError(
      client,
      statusForError(error),
      statusText(statusForError(error)),
    );
    controller.abort();
    return;
  }
  let upstream: Socket;
  try {
    upstream = await options.dial({
      address: target.addresses[0]!,
      port: parsed.port,
      hostname: target.hostname,
      signal: controller.signal,
    });
    await waitForConnection(upstream);
  } catch {
    writeSocketError(client, 502, "Bad Gateway");
    controller.abort();
    return;
  }

  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  joinBoundedSockets(
    client,
    upstream,
    controller,
    head.length,
    0,
    options.limits.tunnelDirectionBytes,
    options.limits.idleTimeoutMs,
  );
  await new Promise<void>((resolve) => {
    let remaining = 2;
    const done = () => {
      remaining -= 1;
      if (remaining === 0) {
        controller.finish();
        resolve();
      }
    };
    client.once("close", done);
    upstream.once("close", done);
  });
}

function assertConnectHost(
  request: IncomingMessage,
  authority: { hostname: string; port: number },
): void {
  const hosts: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      hosts.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (hosts.length !== 1) {
    throw new NetworkPolicyError("target_invalid", "one Host header required");
  }
  const host = parseConnectAuthority(hosts[0]!);
  if (host.hostname !== authority.hostname || host.port !== authority.port) {
    throw new NetworkPolicyError(
      "target_invalid",
      "CONNECT Host must match authority",
    );
  }
}

async function forwardUpgrade(
  request: IncomingMessage,
  client: Socket,
  head: Buffer,
  options: ForwardOptions,
): Promise<void> {
  const controller = requestController(options);
  controller.bind(client);
  const onClientTermination = () => controller.abort();
  const detachPreUpgradeListeners = () => {
    client.removeListener("close", onClientTermination);
    client.removeListener("error", onClientTermination);
  };
  client.once("close", onClientTermination);
  client.once("error", onClientTermination);

  try {
    if (client.destroyed || controller.signal.aborted) {
      controller.abort();
      return;
    }
    if (head.length > options.limits.tunnelDirectionBytes) {
      controller.abort();
      return;
    }
    const upgrade = request.headers.upgrade;
    if (typeof upgrade !== "string" || upgrade.length === 0) {
      writeSocketError(client, 400, "Bad Request");
      controller.abort();
      return;
    }

    let target: ResolvedPublicTarget;
    try {
      target = await abortable(
        resolveUpgradeTarget(request.url, options.lookup),
        controller.signal,
      );
      if (client.destroyed || controller.signal.aborted) {
        controller.abort();
        return;
      }
      assertEgressPolicy(options, target.hostname);
      reportDecision(options, {
        outcome: "allowed",
        hostname: target.hostname,
      });
    } catch (error) {
      if (!client.destroyed && !controller.signal.aborted) {
        reportBlockedDecision(error, request.url, options);
        writeSocketError(
          client,
          statusForError(error),
          statusText(statusForError(error)),
        );
      }
      controller.abort();
      return;
    }

    const headers = sanitizedHeaders(request.headers);
    headers.host = target.url.host;
    headers.connection = "Upgrade";
    headers.upgrade = upgrade;
    let agent: HttpAgent | HttpsAgent;
    try {
      const pinned = await pinnedAgent(
        target,
        options.dial,
        controller.signal,
        options.tlsCa,
      );
      controller.bind(pinned.rawSocket);
      if (client.destroyed || controller.signal.aborted) {
        pinned.rawSocket.destroy();
        controller.abort();
        return;
      }
      agent = pinned.agent;
    } catch {
      if (!client.destroyed && !controller.signal.aborted) {
        writeSocketError(client, 502, "Bad Gateway");
      }
      controller.abort();
      return;
    }

    const requester =
      target.url.protocol === "https:" ? httpsRequest : httpRequest;
    let upstreamRequest: ClientRequest;
    try {
      upstreamRequest = requester({
        hostname: target.addresses[0],
        port: target.port,
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers,
        agent,
        maxHeaderSize: options.limits.responseHeaderBytes,
        signal: controller.signal,
      });
    } catch {
      controller.abort();
      return;
    }

    let upgraded: Awaited<ReturnType<typeof waitForUpgradeResponse>>;
    try {
      upgraded = await waitForUpgradeResponse(
        upstreamRequest,
        controller.signal,
        client,
      );
    } catch {
      controller.abort();
      return;
    }
    const {
      response: upstreamResponse,
      socket: upstream,
      head: upstreamHead,
    } = upgraded;
    if (controller.signal.aborted || client.destroyed) {
      upstream.destroy();
      controller.abort();
      return;
    }

    let responseHeaders: IncomingHttpHeaders;
    try {
      responseHeaders = safeUpgradeResponseHeaders(
        upstreamResponse.headers,
        upgrade,
      );
    } catch {
      upstream.destroy();
      controller.abort();
      return;
    }
    if (upstreamHead.length > options.limits.tunnelDirectionBytes) {
      upstream.destroy();
      controller.abort();
      return;
    }
    if (controller.signal.aborted || client.destroyed) {
      upstream.destroy();
      controller.abort();
      return;
    }

    controller.bind(upstream);
    detachPreUpgradeListeners();
    client.write(
      `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`,
    );
    for (const [name, value] of Object.entries(responseHeaders)) {
      if (value !== undefined) client.write(`${name}: ${String(value)}\r\n`);
    }
    client.write("\r\n");
    if (upstreamHead.length > 0) client.write(upstreamHead);
    if (head.length > 0) upstream.write(head);
    joinBoundedSockets(
      client,
      upstream,
      controller,
      head.length,
      upstreamHead.length,
      options.limits.tunnelDirectionBytes,
      options.limits.idleTimeoutMs,
    );
    await waitForBothSocketsToClose(client, upstream);
    controller.finish();
  } finally {
    detachPreUpgradeListeners();
  }
}

function waitForUpgradeResponse(
  request: ClientRequest,
  signal: AbortSignal,
  client: Socket,
): Promise<{ response: IncomingMessage; socket: Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      request.removeListener("upgrade", onUpgrade);
      request.removeListener("response", onResponse);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      request.destroy();
      rejectOnce(abortError(signal.reason));
    };
    const onUpgrade = (
      response: IncomingMessage,
      socket: Socket,
      head: Buffer,
    ) => {
      if (signal.aborted || client.destroyed) {
        socket.destroy();
        request.destroy();
        rejectOnce(abortError(signal.reason));
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      cleanup();
      resolve({ response, socket, head });
    };
    const onResponse = (response: IncomingMessage) => {
      response.destroy();
      rejectOnce(
        new NetworkPolicyError("target_invalid", "upgrade was rejected"),
      );
    };
    const onError = (error: Error) => rejectOnce(error);

    request.once("upgrade", onUpgrade);
    request.once("response", onResponse);
    request.once("error", onError);
    if (signal.aborted || client.destroyed) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      request.end();
    }
  });
}

function waitForBothSocketsToClose(
  first: Socket,
  second: Socket,
): Promise<void> {
  return new Promise((resolve) => {
    let remaining = Number(!first.destroyed) + Number(!second.destroyed);
    if (remaining === 0) {
      resolve();
      return;
    }
    const done = () => {
      remaining -= 1;
      if (remaining === 0) resolve();
    };
    if (!first.destroyed) first.once("close", done);
    if (!second.destroyed) second.once("close", done);
  });
}

async function resolvePlainRequestTarget(
  rawUrl: string | undefined,
  lookup: PublicLookup,
): Promise<ResolvedPublicTarget> {
  if (rawUrl === undefined || !/^https?:\/\//iu.test(rawUrl)) {
    throw new NetworkPolicyError(
      "target_invalid",
      "absolute-form URL required",
    );
  }
  return resolvePublicTarget(rawUrl, lookup);
}

async function resolveUpgradeTarget(
  rawUrl: string | undefined,
  lookup: PublicLookup,
): Promise<ResolvedPublicTarget> {
  if (rawUrl === undefined || !/^wss?:\/\//iu.test(rawUrl)) {
    throw new NetworkPolicyError(
      "target_invalid",
      "absolute-form WebSocket URL required",
    );
  }
  return resolvePublicTarget(
    rawUrl.replace(/^ws:/iu, "http:").replace(/^wss:/iu, "https:"),
    lookup,
  );
}

function sanitizedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const output = { ...headers };
  const connectionTokens = String(output.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    ...connectionTokens,
  ]) {
    delete output[name];
  }
  delete output.connection;
  return output;
}

function safeUpgradeResponseHeaders(
  headers: IncomingHttpHeaders,
  requestedUpgrade: string,
): IncomingHttpHeaders {
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  const responseUpgrade = headers.upgrade;
  if (
    !connectionTokens.includes("upgrade") ||
    typeof responseUpgrade !== "string" ||
    responseUpgrade.toLowerCase() !== requestedUpgrade.toLowerCase()
  ) {
    throw new NetworkPolicyError("target_invalid", "invalid upgrade response");
  }
  const output = sanitizedHeaders(headers);
  output.connection = "Upgrade";
  output.upgrade = responseUpgrade;
  return output;
}

class RequestLifetime {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly #sockets = new Map<Socket, () => void>();
  readonly #parent: AbortSignal;
  readonly #onParentAbort: () => void;
  readonly #timer: NodeJS.Timeout;
  #finished = false;

  constructor(options: ForwardOptions) {
    this.#parent = options.rootSignal;
    this.#onParentAbort = () => this.abort(this.#parent.reason);
    const maximumEnd = Date.now() + options.limits.lifetimeMs;
    const privateDeadline =
      typeof options.deadlineAtMs === "function"
        ? options.deadlineAtMs()
        : options.deadlineAtMs;
    const end = Math.min(privateDeadline ?? maximumEnd, maximumEnd);
    this.#timer = setTimeout(
      () => this.abort(new DOMException("deadline exceeded", "TimeoutError")),
      Math.max(0, end - Date.now()),
    );
    this.#timer.unref();
    if (this.#parent.aborted) this.abort(this.#parent.reason);
    else this.#parent.addEventListener("abort", this.#onParentAbort);
  }

  bind(socket: Socket): void {
    if (this.#sockets.has(socket)) return;
    const onClose = () => this.#sockets.delete(socket);
    this.#sockets.set(socket, onClose);
    socket.once("close", onClose);
    if (this.signal.aborted) socket.destroy();
  }

  abort(reason?: unknown): void {
    if (!this.signal.aborted) this.controller.abort(reason);
    for (const socket of this.#sockets.keys()) socket.destroy();
    this.finish();
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#timer);
    this.#parent.removeEventListener("abort", this.#onParentAbort);
    for (const [socket, listener] of this.#sockets) {
      socket.removeListener("close", listener);
    }
    this.#sockets.clear();
  }
}

function requestController(options: ForwardOptions): RequestLifetime {
  return new RequestLifetime(options);
}

function linkedAbortController(signal?: AbortSignal): {
  controller: AbortController;
  unlink: () => void;
} {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener("abort", forward, { once: true });
  return {
    controller,
    unlink: () => signal?.removeEventListener("abort", forward),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(reason?: unknown): DOMException {
  return new DOMException(
    reason instanceof Error ? reason.message : "operation aborted",
    "AbortError",
  );
}

async function dialWithAbort(
  dial: EgressDial,
  target: { address: string; port: number; hostname: string },
  signal: AbortSignal,
): Promise<Socket> {
  const pending = Promise.resolve().then(() => dial({ ...target, signal }));
  pending.then(
    (socket) => {
      if (signal.aborted) socket.destroy();
    },
    () => undefined,
  );
  return abortable(pending, signal);
}

function joinBoundedSockets(
  client: Socket,
  upstream: Socket,
  controller: RequestLifetime,
  initialOutbound = 0,
  initialInbound = 0,
  maximum = MAX_CONNECT_DIRECTION_BYTES,
  idleTimeoutMs = PROXY_IDLE_TIMEOUT_MS,
): void {
  let outbound = initialOutbound;
  let inbound = initialInbound;
  const destroy = () => {
    controller.abort();
  };
  controller.bind(client);
  controller.bind(upstream);
  client.setTimeout(idleTimeoutMs, destroy);
  upstream.setTimeout(idleTimeoutMs, destroy);
  client.on("data", (chunk: Buffer) => {
    outbound += chunk.length;
    if (outbound > maximum) destroy();
  });
  upstream.on("data", (chunk: Buffer) => {
    inbound += chunk.length;
    if (inbound > maximum) destroy();
  });
  client.once("error", destroy);
  upstream.once("error", destroy);
  client.once("close", destroy);
  upstream.once("close", destroy);
  client.once("end", () => upstream.end());
  upstream.once("end", () => client.end());
  client.pipe(upstream, { end: false });
  upstream.pipe(client, { end: false });
}

function pipeBounded(
  source: NodeJS.ReadableStream,
  destination: NodeJS.WritableStream,
  maximum: number,
  exceeded: () => void,
): void {
  let bytes = 0;
  source.on("data", (chunk: Buffer | string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maximum) exceeded();
  });
  source.pipe(destination);
}

function waitForConnection(socket: Socket): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function waitForConnectionWithAbort(
  socket: Socket,
  signal: AbortSignal,
): Promise<void> {
  const onAbort = () => socket.destroy();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    await abortable(waitForConnection(socket), signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForSecureConnectionWithAbort(
  socket: TLSSocket,
  signal: AbortSignal,
): Promise<void> {
  const secure = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener("secureConnect", onSecure);
      socket.removeListener("error", onError);
    };
    const onSecure = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
  });
  const onAbort = () => socket.destroy();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    await abortable(secure, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function pinnedAgent(
  target: ResolvedPublicTarget,
  dial: EgressDial,
  signal: AbortSignal,
  tlsCa: string | Buffer | undefined,
): Promise<{ agent: HttpAgent | HttpsAgent; rawSocket: Socket }> {
  const rawSocket = await dialWithAbort(
    dial,
    {
      address: target.addresses[0]!,
      port: target.port,
      hostname: target.hostname,
    },
    signal,
  );
  try {
    await waitForConnectionWithAbort(rawSocket, signal);
    rawSocket.setTimeout(PROXY_IDLE_TIMEOUT_MS, () => rawSocket.destroy());
    const onAbort = () => rawSocket.destroy();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    rawSocket.once("close", () => signal.removeEventListener("abort", onAbort));

    let connection: Socket;
    if (target.url.protocol === "https:") {
      const tlsSocket = tlsConnect({
        socket: rawSocket,
        servername: target.hostname,
        ...(tlsCa === undefined ? {} : { ca: tlsCa }),
      });
      await waitForSecureConnectionWithAbort(tlsSocket, signal);
      connection = tlsSocket;
    } else {
      connection = rawSocket;
    }
    if (signal.aborted || connection.destroyed) {
      connection.destroy();
      throw abortError(signal.reason);
    }
    const agent =
      target.url.protocol === "https:"
        ? new HttpsAgent({ keepAlive: false })
        : new HttpAgent({ keepAlive: false });
    agent.createConnection = () => connection;
    return { agent, rawSocket };
  } catch (error) {
    rawSocket.destroy();
    throw error;
  }
}

function reportBlocked(
  error: unknown,
  rawTarget: string | undefined,
  listener: EgressProxyOptions["onDecision"],
): void {
  if (listener === undefined) return;
  let hostname =
    error instanceof NetworkPolicyError ? error.hostname : undefined;
  if (hostname === undefined && rawTarget !== undefined) {
    try {
      const candidate = rawTarget.includes("://")
        ? new URL(rawTarget).hostname
        : parseConnectAuthority(rawTarget).hostname;
      hostname = candidate
        .replace(/^\[/u, "")
        .replace(/\]$/u, "")
        .toLowerCase();
    } catch {
      hostname = "invalid";
    }
  }
  listener({ outcome: "blocked", hostname: hostname ?? "invalid" });
}

function statusForError(error: unknown): number {
  if (error instanceof RestoreGateError) return 503;
  if (error instanceof NetworkPolicyError) {
    return error.category === "target_invalid" ? 400 : 403;
  }
  return 502;
}

function statusText(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 403) return "Forbidden";
  if (status === 413) return "Payload Too Large";
  if (status === 431) return "Request Header Fields Too Large";
  if (status === 503) return "Service Unavailable";
  return "Bad Gateway";
}

function writeResponseError(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { connection: "close", "content-length": "0" });
  response.end();
}

function writeSocketError(socket: Socket, status: number, text: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}
