import { randomUUID } from "node:crypto";

import type { Request, RequestHandler, Response } from "express";
import type WebSocket from "ws";

import type {
  BrowserProxyGrant,
  BrowserProxyPermission,
  createBrowserProxyGrantStore,
} from "../../lib/browser-state/proxy-grant-store";
import type {
  BrowserMutationCommitOutcome,
  BrowserStateMutationLease,
  BrowserStartupBinding,
  BrowserStartupGate,
} from "../../lib/browser-runtime/startup-gate";
import type { BrowserServiceClient } from "../../lib/scrape-interact/browser-service-client";

const MAX_RELAY_FRAME_BYTES = 64 * 1024;
const MAX_RELAY_BUFFERED_BYTES = 64 * 1024;
const PRIVATE_GRANT_LIFETIME_MS = 30_000;
const RELAY_CLEANUP_TIMEOUT_MS = 10_000;
const COMMIT_OUTCOME_TIMEOUT_MS = 5_000;

const VIEWER_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Firecrawl browser</title><link rel="stylesheet" href="/v2/browser/proxy/view.css"></head><body><main><canvas aria-label="Browser live view" tabindex="0"></canvas><p role="status">Connecting…</p></main><script src="/v2/browser/proxy/view.js" defer></script></body></html>';
const VIEWER_CSS =
  "html,body,main{width:100%;height:100%;margin:0;background:#111;color:#eee;font:14px sans-serif}main{display:grid;place-items:center;overflow:hidden}canvas{max-width:100%;max-height:100%}p{position:fixed;inset:auto 12px 12px auto;margin:0}";
const VIEWER_SCRIPT =
  '(()=>{"use strict";const p=location.pathname.split("/"),t=p.at(-2),b=location.protocol==="https:"?"wss:":"ws:",u=n=>`${b}//${location.host}/v2/browser/proxy/${t}/${n}`,s=document.querySelector("[role=status]"),c=document.querySelector("canvas"),x=c.getContext("2d");let w,m;const send=o=>{const v=JSON.stringify({version:1,...o});if(m==="interactive"&&w?.readyState===1&&v.length<=4096)w.send(v)},xy=e=>{const r=c.getBoundingClientRect();return{x:(e.clientX-r.left)*c.width/r.width,y:(e.clientY-r.top)*c.height/r.height}},mods=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0),open=n=>{m=n;w=new WebSocket(u(n));w.onopen=()=>{s.textContent="Connected";c.focus()};w.onmessage=e=>{if(typeof e.data!=="string")return;try{const v=JSON.parse(e.data);if(v.version===1&&v.kind==="frame"&&typeof v.data==="string"){const i=new Image;i.onload=()=>{c.width=i.width;c.height=i.height;x.drawImage(i,0,0)};i.src=`data:image/jpeg;base64,${v.data}`}}catch{w.close(1008)}};w.onclose=e=>{if(n==="interactive"&&e.code===1008){open("passive");return}s.textContent="Disconnected"};w.onerror=()=>{s.textContent="Connection failed"}};for(const [e,a]of[["pointermove","move"],["pointerdown","down"],["pointerup","up"]])c.addEventListener(e,v=>{const q=xy(v);send({kind:"pointer",action:a,...q,button:["left","middle","right"][v.button]??"none",buttons:v.buttons,clickCount:v.detail||1,modifiers:mods(v)})});c.addEventListener("wheel",e=>{e.preventDefault();send({kind:"wheel",...xy(e),deltaX:e.deltaX,deltaY:e.deltaY,modifiers:mods(e)})},{passive:false});for(const [e,a]of[["keydown","down"],["keyup","up"]])c.addEventListener(e,v=>{v.preventDefault();send({kind:"key",action:a,key:v.key,code:v.code,modifiers:mods(v)})});c.addEventListener("paste",e=>{e.preventDefault();const v=e.clipboardData?.getData("text");if(v)send({kind:"text",text:v.slice(0,4096)})});open("interactive");addEventListener("beforeunload",()=>w?.close())})();';

type ProxyGrantStore = Pick<
  ReturnType<typeof createBrowserProxyGrantStore>,
  "redeemWithLease"
>;

type ProxyBrowserClient = Pick<
  BrowserServiceClient,
  | "createRelayGrant"
  | "revokeRelayGrant"
  | "openPassiveStream"
  | "openInteractiveStream"
  | "openCdpStream"
>;

type BrowserProxyRuntime = {
  gate: BrowserStartupGate;
  grantStore: ProxyGrantStore;
  browserClient: ProxyBrowserClient;
  publicApiOrigin: string;
  now?: () => Date;
  cleanupTimeoutMs?: number;
  commitOutcomeTimeoutMs?: number;
};

type SessionRelayRow = {
  id: string;
  owner_id: string;
  browser_id: string | null;
  runtime_epoch: number;
  workspace_id: string | null;
  absolute_deadline_at: string | Date;
  idle_deadline_at: string | Date;
};

class BrowserProxyPolicyError extends Error {}

let registeredRuntime: BrowserProxyRuntime | undefined;

/** @public Registers the API-owned browser relay authority. */
export function registerBrowserProxyRuntime(
  runtime: BrowserProxyRuntime | undefined,
): void {
  registeredRuntime = runtime;
}

function fixedHeaders(response: Response, contentType: string): void {
  response.set({
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Content-Security-Policy":
      "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function exactOrigin(
  request: Request,
):
  | { present: false; valid: true }
  | { present: true; valid: boolean; value?: string } {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() !== "origin") continue;
    if (
      value === undefined ||
      value.length === 0 ||
      value.trim() !== value ||
      /[\r\n]/u.test(value)
    ) {
      return { present: true, valid: false };
    }
    values.push(value);
  }
  if (values.length === 0) return { present: false, valid: true };
  if (values.length !== 1) return { present: true, valid: false };
  return { present: true, valid: true, value: values[0]! };
}

function sameBinding(
  left: BrowserStartupBinding,
  right: BrowserStartupBinding,
): boolean {
  return (
    left.apiInstanceId === right.apiInstanceId &&
    left.databaseControlEpoch === right.databaseControlEpoch &&
    left.processNonce === right.processNonce &&
    left.controlGenerationNonce === right.controlGenerationNonce
  );
}

function allowedDomains(row: SessionRelayRow): string[] {
  if (row.workspace_id === null) return [];
  try {
    const parsed: unknown = JSON.parse(row.workspace_id);
    return Array.isArray(parsed) &&
      parsed.every(value => typeof value === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

async function loadRelaySession(
  lease: BrowserStateMutationLease,
  grant: BrowserProxyGrant,
  now: Date,
): Promise<SessionRelayRow> {
  const result = await lease.transaction.query<SessionRelayRow>(
    `SELECT id, owner_id, browser_id, runtime_epoch, workspace_id,
            absolute_deadline_at, idle_deadline_at
       FROM browser_sessions
      WHERE id = $1
        AND owner_id = $2
        AND state IN ('ready', 'executing')
        AND absolute_deadline_at > $3
        AND idle_deadline_at > $3
      FOR UPDATE`,
    [grant.sessionId, grant.ownerId, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row || row.browser_id === null) throw new BrowserProxyPolicyError();
  return row;
}

function frameBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, value) => total + frameBytes(value), 0);
  }
  return MAX_RELAY_FRAME_BYTES + 1;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (
    socket.readyState === socket.OPEN ||
    socket.readyState === socket.CONNECTING
  ) {
    socket.close(code, reason);
  }
}

function createFrameForwarder(
  source: WebSocket,
  destination: WebSocket,
  overflow: () => void,
): (data: unknown, isBinary: boolean) => void {
  let inFlightBytes = 0;
  return (data, isBinary) => {
    const bytes = frameBytes(data);
    const projectedBytes =
      Math.max(destination.bufferedAmount, inFlightBytes) + bytes;
    if (
      bytes > MAX_RELAY_FRAME_BYTES ||
      projectedBytes > MAX_RELAY_BUFFERED_BYTES
    ) {
      overflow();
      return;
    }
    if (destination.readyState !== destination.OPEN) return;
    source.pause();
    inFlightBytes += bytes;
    try {
      destination.send(data as never, { binary: isBinary }, error => {
        inFlightBytes = Math.max(0, inFlightBytes - bytes);
        if (error !== undefined) {
          overflow();
          return;
        }
        if (source.readyState === source.OPEN) source.resume();
      });
    } catch {
      inFlightBytes = Math.max(0, inFlightBytes - bytes);
      overflow();
    }
  };
}

async function waitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | "timed_out"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timed_out">(resolve => {
        timer = setTimeout(resolve, timeoutMs, "timed_out");
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeSocketAndWait(
  socket: WebSocket,
  code: number,
  reason: string,
  timeoutMs: number,
): Promise<boolean> {
  if (socket.readyState === socket.CLOSED) return true;
  const closed = new Promise<void>(resolve => socket.once("close", resolve));
  closeSocket(socket, code, reason);
  if ((await waitWithin(closed, timeoutMs)) !== "timed_out") return true;
  socket.terminate();
  if (Number(socket.readyState) === socket.CLOSED) return true;
  return (await waitWithin(closed, timeoutMs)) !== "timed_out";
}

type PrivateRelayOwnership = {
  socket?: WebSocket;
  sessionId: string;
  grantId: string;
  binding: BrowserStartupBinding;
  sessionDeadline: Date;
  commitOutcome?: Promise<BrowserMutationCommitOutcome>;
  handshakeInterrupted?: () => boolean;
  releaseHandshakeGuard?: () => void;
  cleanup?: Promise<void>;
};

async function revokeOwnedPrivateGrant(
  runtime: BrowserProxyRuntime,
  ownership: PrivateRelayOwnership,
): Promise<void> {
  const timeoutMs = runtime.cleanupTimeoutMs ?? RELAY_CLEANUP_TIMEOUT_MS;
  const deadline = new Date(Date.now() + timeoutMs);
  await runtime.browserClient.revokeRelayGrant(
    ownership.sessionId,
    ownership.grantId,
    { version: 1, grantId: ownership.grantId },
    {
      correlationId: randomUUID(),
      deadline,
      signal: AbortSignal.timeout(timeoutMs),
      processNonce: ownership.binding.processNonce,
      controlGenerationNonce: ownership.binding.controlGenerationNonce,
    },
  );
}

function cleanupOwnedPrivateRelay(
  runtime: BrowserProxyRuntime,
  ownership: PrivateRelayOwnership,
  code: number,
  reason: string,
): Promise<void> {
  ownership.cleanup ??= (async () => {
    const timeoutMs = runtime.cleanupTimeoutMs ?? RELAY_CLEANUP_TIMEOUT_MS;
    let closeVerified = true;
    if (ownership.socket !== undefined) {
      closeVerified = await closeSocketAndWait(
        ownership.socket,
        code,
        reason,
        timeoutMs,
      );
    }
    let revokeVerified = false;
    try {
      await revokeOwnedPrivateGrant(runtime, ownership);
      revokeVerified = true;
    } finally {
      if (!closeVerified || !revokeVerified) {
        runtime.gate.close("browser_proxy_relay_cleanup_failed");
      }
    }
    if (!closeVerified) {
      throw Object.assign(new Error("Relay socket close is unverified"), {
        category: "browser_state_unavailable",
      });
    }
  })();
  return ownership.cleanup;
}

async function resolveCommitOutcome(
  runtime: BrowserProxyRuntime,
  ownership: PrivateRelayOwnership,
): Promise<BrowserMutationCommitOutcome | "timed_out"> {
  if (ownership.commitOutcome === undefined) return "unknown";
  return waitWithin(
    ownership.commitOutcome,
    runtime.commitOutcomeTimeoutMs ?? COMMIT_OUTCOME_TIMEOUT_MS,
  );
}

async function cleanupAfterCommitFailure(
  runtime: BrowserProxyRuntime,
  ownership: PrivateRelayOwnership,
): Promise<void> {
  const outcome = await resolveCommitOutcome(runtime, ownership);
  try {
    await cleanupOwnedPrivateRelay(
      runtime,
      ownership,
      1011,
      "relay_authority_unavailable",
    );
  } finally {
    if (outcome === "unknown" || outcome === "timed_out") {
      runtime.gate.close("browser_proxy_commit_outcome_unknown");
    }
  }
}

function closeCategory(error: unknown): { code: number; reason: string } {
  if (error instanceof BrowserProxyPolicyError) {
    return { code: 1008, reason: "proxy_grant_denied" };
  }
  const category = (error as { category?: string }).category;
  if (
    category === "browser_state_unavailable" ||
    category === "control_generation_mismatch"
  ) {
    return { code: 1013, reason: "browser_state_unavailable" };
  }
  return { code: 1011, reason: "browser_unavailable" };
}

function isProxyPermission(value: string): value is BrowserProxyPermission {
  return value === "passive" || value === "interactive" || value === "cdp";
}

async function openPrivateRelay(
  runtime: BrowserProxyRuntime,
  permission: BrowserProxyPermission,
  token: string,
  signal: AbortSignal,
): Promise<PrivateRelayOwnership & { socket: WebSocket }> {
  const now = runtime.now ?? (() => new Date());
  let ownership: PrivateRelayOwnership | undefined;
  try {
    return await runtime.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      async lease => {
        const redeemed = await runtime.grantStore.redeemWithLease(
          lease,
          token,
          permission,
        );
        if (redeemed === null) throw new BrowserProxyPolicyError();
        const at = now();
        const session = await loadRelaySession(lease, redeemed, at);
        const sessionDeadline = new Date(session.absolute_deadline_at);
        const handshakeDeadline = new Date(
          Math.min(
            sessionDeadline.getTime(),
            at.getTime() + PRIVATE_GRANT_LIFETIME_MS,
          ),
        );
        const grantId = randomUUID();
        ownership = {
          sessionId: session.browser_id!,
          grantId,
          binding: lease.binding,
          sessionDeadline,
          commitOutcome: lease.transaction.commitOutcome,
        };
        const context = {
          correlationId: randomUUID(),
          deadline: handshakeDeadline,
          signal,
          processNonce: lease.binding.processNonce,
          controlGenerationNonce: lease.binding.controlGenerationNonce,
        };
        try {
          const grant = await runtime.browserClient.createRelayGrant(
            session.browser_id!,
            {
              version: 1,
              grantId,
              permission,
              expiresAt: handshakeDeadline.toISOString(),
              useLimit: 1,
              expectedSessionVersion: session.runtime_epoch,
              allowedDomains: allowedDomains(session),
            },
            context,
          );
          if (!sameBinding(runtime.gate.assertOpen(), lease.binding)) {
            throw Object.assign(new Error("Browser state changed"), {
              category: "browser_state_unavailable",
            });
          }
          const socket =
            permission === "passive"
              ? await runtime.browserClient.openPassiveStream(
                  session.browser_id!,
                  grant.relayToken,
                  context,
                )
              : permission === "interactive"
                ? await runtime.browserClient.openInteractiveStream(
                    session.browser_id!,
                    grant.relayToken,
                    context,
                  )
                : await runtime.browserClient.openCdpStream(
                    session.browser_id!,
                    grant.relayToken,
                    context,
                  );
          ownership.socket = socket;
          let interrupted = false;
          const onEarlyEnd = () => {
            interrupted = true;
          };
          socket.on("error", onEarlyEnd);
          socket.on("close", onEarlyEnd);
          ownership.handshakeInterrupted = () => interrupted;
          ownership.releaseHandshakeGuard = () => {
            socket.off("error", onEarlyEnd);
            socket.off("close", onEarlyEnd);
          };
          return ownership as PrivateRelayOwnership & { socket: WebSocket };
        } catch (error) {
          try {
            await cleanupOwnedPrivateRelay(
              runtime,
              ownership!,
              1011,
              "relay_handshake_failed",
            );
          } catch {
            runtime.gate.close("browser_proxy_relay_cleanup_failed");
          }
          throw error;
        }
      },
      { commitTimeoutMs: PRIVATE_GRANT_LIFETIME_MS, signal },
    );
  } catch (error) {
    if (ownership?.socket !== undefined && ownership.cleanup === undefined) {
      try {
        await cleanupAfterCommitFailure(runtime, ownership);
      } catch {
        runtime.gate.close("browser_proxy_relay_cleanup_failed");
      }
    }
    throw error;
  }
}

export function createBrowserProxyHandlers(
  getRuntime: () => BrowserProxyRuntime | undefined = () => registeredRuntime,
): {
  view: RequestHandler;
  script: RequestHandler;
  style: RequestHandler;
  relay: (socket: WebSocket, request: Request) => Promise<void>;
} {
  return {
    view: (_request, response) => {
      fixedHeaders(response, "text/html; charset=utf-8");
      response.status(200).send(VIEWER_HTML);
    },
    script: (_request, response) => {
      fixedHeaders(response, "text/javascript; charset=utf-8");
      response.status(200).send(VIEWER_SCRIPT);
    },
    style: (_request, response) => {
      fixedHeaders(response, "text/css; charset=utf-8");
      response.status(200).send(VIEWER_CSS);
    },
    relay: async (downstream, request) => {
      const runtime = getRuntime();
      const permission = request.params.permission;
      if (runtime === undefined || !isProxyPermission(permission)) {
        closeSocket(
          downstream,
          runtime === undefined ? 1013 : 1008,
          runtime === undefined
            ? "browser_state_unavailable"
            : "proxy_grant_denied",
        );
        return;
      }
      const origin = exactOrigin(request);
      if (
        !origin.valid ||
        (permission !== "cdp" &&
          (!origin.present || origin.value !== runtime.publicApiOrigin)) ||
        (permission === "cdp" &&
          origin.present &&
          origin.value !== runtime.publicApiOrigin)
      ) {
        closeSocket(downstream, 1008, "origin_denied");
        return;
      }
      const cancellation = new AbortController();
      downstream.once("close", () => cancellation.abort());
      try {
        const relay = await openPrivateRelay(
          runtime,
          permission,
          request.params.token,
          cancellation.signal,
        );
        const { socket: upstream, sessionDeadline } = relay;
        let finalized = false;
        const finalize = (code = 1000, reason = "relay_closed") => {
          if (finalized) return;
          finalized = true;
          void cleanupOwnedPrivateRelay(runtime, relay, code, reason).catch(
            () => {
              runtime.gate.close("browser_proxy_relay_cleanup_failed");
            },
          );
        };
        const overflow = () => {
          closeSocket(downstream, 1009, "relay_overflow");
          finalize(1009, "relay_overflow");
        };
        upstream.on(
          "message",
          createFrameForwarder(upstream, downstream, overflow),
        );
        downstream.on(
          "message",
          createFrameForwarder(downstream, upstream, overflow),
        );
        upstream.once("error", () => {
          closeSocket(downstream, 1011, "browser_unavailable");
          finalize(1011, "browser_unavailable");
        });
        downstream.once("error", () =>
          finalize(1011, "downstream_unavailable"),
        );
        const lifetime = Math.max(1, sessionDeadline.getTime() - Date.now());
        const timer = setTimeout(() => {
          closeSocket(downstream, 1008, "relay_deadline");
          finalize(1008, "relay_deadline");
        }, lifetime);
        timer.unref?.();
        upstream.once("close", () => {
          clearTimeout(timer);
          if (downstream.readyState !== downstream.CLOSED) downstream.close();
          finalize();
        });
        downstream.once("close", () => {
          clearTimeout(timer);
          finalize();
        });
        const interrupted = relay.handshakeInterrupted?.() ?? false;
        relay.releaseHandshakeGuard?.();
        if (
          interrupted ||
          upstream.readyState !== upstream.OPEN ||
          downstream.readyState !== downstream.OPEN
        ) {
          if (downstream.readyState === downstream.OPEN) {
            closeSocket(downstream, 1011, "browser_unavailable");
          }
          finalize(1011, "browser_unavailable");
        }
      } catch (error) {
        const closed = closeCategory(error);
        closeSocket(downstream, closed.code, closed.reason);
      }
    },
  };
}

const handlers = createBrowserProxyHandlers();

export const browserProxyViewController = handlers.view;
export const browserProxyScriptController = handlers.script;
export const browserProxyStyleController = handlers.style;
export const browserProxyRelayController = handlers.relay;
