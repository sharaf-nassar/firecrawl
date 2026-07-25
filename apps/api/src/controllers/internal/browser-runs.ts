import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { NextFunction, Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { z } from "zod";

import { getArtifactStore, type ArtifactStore } from "../../lib/artifacts";
import {
  CapabilityDeniedError,
  createCapabilityStore,
} from "../../lib/browser-state/capability-store";
import {
  getActiveBrowserRunAuthority,
  type ActiveBrowserRunAuthority,
} from "../../lib/browser-state/store";
import {
  BrowserActionCoordinatorError,
  createBrowserActionCoordinator,
} from "../../lib/browser-runtime/action-coordinator";
import {
  BrowserArtifactError,
  createBrowserArtifactService,
  parseBrowserArtifactHeaders,
  readBrowserArtifactBody,
} from "../../lib/browser-runtime/artifacts";
import type { BrowserStartupGate } from "../../lib/browser-runtime/startup-gate";
import type { BrowserStateMutationLease } from "../../lib/browser-runtime/startup-gate";
import { canonicalUuidSchema } from "../../lib/scrape-interact/browser-service-contracts";
import type { BrowserServiceClient } from "../../lib/scrape-interact/browser-service-client";

const MAX_OBSERVATION_BYTES = 64 * 1024;
const MAX_RELAY_FRAME_BYTES = 256 * 1024;
const MAX_RELAY_BUFFERED_BYTES = 256 * 1024;
const RELAY_CLEANUP_TIMEOUT_MS = 5_000;
const RELAY_RELEASE_TIMEOUT_MS = 16_000;
const PROCESS_ID = /^[1-9][0-9]*$/;

type InternalBrowserRuntime = {
  gate: BrowserStartupGate;
  browserClient: Pick<
    BrowserServiceClient,
    "executeAction" | "createRelayGrant" | "revokeRelayGrant" | "openCdpStream"
  >;
};

export type InternalBrowserRunsDependencies = {
  getRuntime(): InternalBrowserRuntime | undefined;
  adapterTokenFile?: string;
  readAdapterToken?: () => Promise<string>;
  getAuthority?: typeof getActiveBrowserRunAuthority;
  inspectBinding?: (
    runtime: InternalBrowserRuntime,
    authority: ActiveBrowserRunAuthority,
    headers: AdapterHeaders,
  ) => Promise<void>;
  redeemCdpWithLease?: (
    runtime: InternalBrowserRuntime,
    lease: BrowserStateMutationLease,
    authority: ActiveBrowserRunAuthority,
    headers: AdapterHeaders,
  ) => Promise<void>;
  now?: () => Date;
  getArtifactStore?: () => ArtifactStore | null;
  createArtifactService?: typeof createBrowserArtifactService;
};

type AdapterHeaders = {
  adapterJobId: string;
  adapterSupervisorId: string;
  adapterProcessId: number;
};

const authorityByRequest = new WeakMap<Request, ActiveBrowserRunAuthority>();
const headersByRequest = new WeakMap<Request, AdapterHeaders>();

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalSecret(left: string, right: string): boolean {
  const a = sha256(left);
  const b = sha256(right);
  return timingSafeEqual(a, b);
}

function exactSingleRawHeader(request: Request, name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const rawName = request.rawHeaders[index];
    const rawValue = request.rawHeaders[index + 1];
    if (rawName?.toLowerCase() !== name) continue;
    if (rawName !== name || rawValue === undefined) return null;
    values.push(rawValue);
  }
  if (values.length !== 1) return null;
  const [value] = values;
  if (value.length === 0 || value.trim() !== value || /[\r\n]/u.test(value)) {
    return null;
  }
  return value;
}

function parseAdapterHeaders(request: Request): AdapterHeaders | null {
  const job = exactSingleRawHeader(request, "x-firecrawl-adapter-job-id");
  const supervisor = exactSingleRawHeader(
    request,
    "x-firecrawl-adapter-supervisor-id",
  );
  const process = exactSingleRawHeader(
    request,
    "x-firecrawl-adapter-process-id",
  );
  if (job === null || supervisor === null || process === null) return null;
  const parsedJob = canonicalUuidSchema.safeParse(job);
  const parsedSupervisor = canonicalUuidSchema.safeParse(supervisor);
  if (
    !parsedJob.success ||
    !parsedSupervisor.success ||
    !PROCESS_ID.test(process)
  ) {
    return null;
  }
  const adapterProcessId = Number(process);
  if (!Number.isSafeInteger(adapterProcessId)) return null;
  return {
    adapterJobId: parsedJob.data,
    adapterSupervisorId: parsedSupervisor.data,
    adapterProcessId,
  };
}

function relayFrameBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, item) => total + relayFrameBytes(item), 0);
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

async function closeRelaySocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) return;
  closeSocket(socket, 1000, "relay_closed");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const terminable = socket as WebSocket & { terminate?: () => void };
      terminable.terminate?.();
      reject(new Error("Browser relay writer release timed out"));
    }, RELAY_CLEANUP_TIMEOUT_MS);
    timer.unref?.();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sendBounded(
  destination: WebSocket,
  data: unknown,
  onOverflow: () => void,
): void {
  if (
    relayFrameBytes(data) > MAX_RELAY_FRAME_BYTES ||
    destination.bufferedAmount > MAX_RELAY_BUFFERED_BYTES
  ) {
    onOverflow();
    return;
  }
  if (destination.readyState !== destination.OPEN) return;
  try {
    destination.send(data as never, error => {
      if (
        error !== undefined ||
        destination.bufferedAmount > MAX_RELAY_BUFFERED_BYTES
      ) {
        onOverflow();
      }
    });
  } catch {
    onOverflow();
    return;
  }
  if (destination.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) {
    onOverflow();
  }
}

function sanitizedError(
  response: Response,
  status: number,
  category: string,
  message: string,
): void {
  response.status(status).json({ success: false, error: category, message });
}

function browserArtifactErrorStatus(category: string): number {
  if (category === "capability_denied") return 403;
  if (category === "artifact_too_large") return 413;
  if (
    category === "artifact_duplicate" ||
    category === "artifact_budget_exceeded"
  ) {
    return 409;
  }
  if (
    category === "artifact_invalid_headers" ||
    category === "artifact_length_mismatch" ||
    category === "artifact_checksum_mismatch" ||
    category === "artifact_upload_interrupted"
  ) {
    return 400;
  }
  return 503;
}

function createArtifactCancellation(
  request: Request,
  response: Response,
  authority: ActiveBrowserRunAuthority,
  now: Date,
): {
  signal: AbortSignal;
  markSuccessfulResponse(): void;
} {
  const controller = new AbortController();
  let successfulResponseExpected = false;
  let completed = false;
  const abort = () => {
    if (!completed) controller.abort();
  };
  const cleanup = () => {
    clearTimeout(timer);
    request.off("aborted", abort);
    response.off("close", abort);
    request.socket.off("close", abort);
    response.off("finish", finish);
  };
  const finish = () => {
    if (successfulResponseExpected) completed = true;
    else controller.abort();
    cleanup();
  };
  const remainingRunMs = authority.deadline.getTime() - now.getTime();
  const remainingMs = Math.max(
    1,
    Math.min(remainingRunMs, authority.perOperationTimeoutMs),
  );
  const timer = setTimeout(abort, remainingMs);
  timer.unref?.();
  request.once("aborted", abort);
  response.once("close", abort);
  request.socket.once("close", abort);
  response.once("finish", finish);
  return {
    signal: controller.signal,
    markSuccessfulResponse() {
      successfulResponseExpected = true;
    },
  };
}

/** @public Sanitized internal callback status mapping. */
export function browserActionErrorStatus(category: string): number {
  if (
    category === "duplicate_side_effect" ||
    category === "action_in_flight" ||
    category === "cancelled"
  ) {
    return 409;
  }
  if (
    category === "action_limit_exceeded" ||
    category === "concurrency_exceeded"
  ) {
    return 429;
  }
  if (category === "capability_denied" || category === "target_blocked") {
    return 403;
  }
  if (
    [
      "browser_state_unavailable",
      "browser_unavailable",
      "codex_unavailable",
      "sandbox_unavailable",
      "model_unavailable",
    ].includes(category)
  ) {
    return 503;
  }
  if (category === "deadline_exceeded") return 504;
  if (
    category === "model_protocol_error" ||
    category === "action_outcome_unknown"
  ) {
    return 502;
  }
  return 500;
}

async function defaultReadToken(path: string | undefined): Promise<string> {
  if (!path) throw new Error("Adapter token file is not configured");
  const raw = await readFile(path, { encoding: "utf8" });
  const token = raw.trim();
  if (token.length < 32 || token.length > 4_096) {
    throw new Error("Adapter token file is invalid");
  }
  return token;
}

/** @public */
export function createBrowserRunsInternalRouter(
  deps: InternalBrowserRunsDependencies,
) {
  const router = express.Router();
  const readToken =
    deps.readAdapterToken ?? (() => defaultReadToken(deps.adapterTokenFile));
  const getAuthority = deps.getAuthority ?? getActiveBrowserRunAuthority;
  const resolveArtifactStore = deps.getArtifactStore ?? getArtifactStore;
  const buildArtifactService =
    deps.createArtifactService ?? createBrowserArtifactService;
  const now = deps.now ?? (() => new Date());
  const authenticate = async (request: Request) => {
    const authorization = exactSingleRawHeader(request, "authorization");
    const expected = await readToken();
    if (
      authorization === null ||
      !/^Bearer [^\s]+$/u.test(authorization) ||
      !equalSecret(authorization.slice(7), expected)
    ) {
      throw new CapabilityDeniedError();
    }
    const runId = canonicalUuidSchema.safeParse(request.params.runId);
    const headers = parseAdapterHeaders(request);
    const runtime = deps.getRuntime();
    if (runtime === undefined) {
      throw Object.assign(new Error("Browser state is unavailable"), {
        category: "browser_state_unavailable",
      });
    }
    if (!runId.success || headers === null) throw new CapabilityDeniedError();
    const authority = await getAuthority(runId.data);
    if (
      authority === null ||
      authority.adapterJobId !== headers.adapterJobId ||
      authority.adapterSupervisorId !== headers.adapterSupervisorId ||
      authority.adapterProcessId !== headers.adapterProcessId ||
      authority.zeroDataRetention !== false
    ) {
      throw new CapabilityDeniedError();
    }
    if (deps.inspectBinding) {
      await deps.inspectBinding(runtime, authority, headers);
    } else {
      const capabilities = createCapabilityStore({ gate: runtime.gate });
      await capabilities.inspectBinding({
        ownerId: authority.ownerId,
        sessionId: authority.sessionId,
        runId: authority.runId,
        ...headers,
      });
    }
    return { runtime, authority, headers };
  };

  router.use(
    "/internal/browser-runs/:runId",
    async (request, response, next) => {
      try {
        const { authority, headers } = await authenticate(request);
        authorityByRequest.set(request, authority);
        headersByRequest.set(request, headers);
        next();
      } catch (error) {
        const category =
          error instanceof CapabilityDeniedError
            ? "capability_denied"
            : ((error as { category?: string }).category ??
              "browser_state_unavailable");
        sanitizedError(
          response,
          browserActionErrorStatus(category),
          category,
          category === "capability_denied"
            ? "Browser capability was denied"
            : "Browser state is unavailable",
        );
      }
    },
  );

  router.post(
    "/internal/browser-runs/:runId/actions",
    express.json({ limit: "128kb", strict: true, type: "application/json" }),
    async (request, response) => {
      const runtime = deps.getRuntime();
      const authority = authorityByRequest.get(request);
      const headers = headersByRequest.get(request);
      if (!runtime || !authority || !headers) {
        sanitizedError(
          response,
          503,
          "browser_state_unavailable",
          "Browser state is unavailable",
        );
        return;
      }
      try {
        const coordinator = createBrowserActionCoordinator({
          gate: runtime.gate,
          browserClient: runtime.browserClient,
        });
        const observation = await coordinator.handleProposal(
          authority,
          request.body,
          {
            adapterSupervisorId: headers.adapterSupervisorId,
            adapterProcessId: headers.adapterProcessId,
            correlationId: randomUUID(),
            deadline: authority.deadline,
            signal: AbortSignal.timeout(
              Math.max(1, authority.deadline.getTime() - now().getTime()),
            ),
          },
        );
        const bytes = Buffer.byteLength(JSON.stringify(observation), "utf8");
        if (bytes > MAX_OBSERVATION_BYTES) {
          throw new BrowserActionCoordinatorError(
            "action_outcome_unknown",
            "Browser action observation exceeded its bound",
          );
        }
        response.status(200).json(observation);
      } catch (error) {
        const category =
          (error as { category?: string; code?: string }).category ??
          (error as { code?: string }).code ??
          (error instanceof z.ZodError
            ? "model_protocol_error"
            : "browser_unavailable");
        sanitizedError(
          response,
          browserActionErrorStatus(category),
          category,
          category === "capability_denied"
            ? "Browser capability was denied"
            : "Browser action failed",
        );
      }
    },
  );
  router.use(
    "/internal/browser-runs/:runId/actions",
    (
      error: Error & { status?: number; type?: string },
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (error.type === "entity.too.large" || error.status === 413) {
        sanitizedError(
          response,
          413,
          "model_protocol_error",
          "Browser action proposal exceeds its bound",
        );
        return;
      }
      if (
        error instanceof SyntaxError ||
        error.type === "entity.parse.failed" ||
        error.status === 400
      ) {
        sanitizedError(
          response,
          400,
          "model_protocol_error",
          "Browser action proposal is invalid",
        );
        return;
      }
      next(error);
    },
  );

  router.post(
    "/internal/browser-runs/:runId/artifacts",
    async (request, response) => {
      const runtime = deps.getRuntime();
      const authority = authorityByRequest.get(request);
      const store = resolveArtifactStore();
      if (!runtime || !authority || !store) {
        sanitizedError(
          response,
          503,
          "browser_unavailable",
          "Browser artifact ingestion is unavailable",
        );
        return;
      }
      const cancellation = createArtifactCancellation(
        request,
        response,
        authority,
        now(),
      );
      try {
        const headers = parseBrowserArtifactHeaders(request.rawHeaders);
        const body = await readBrowserArtifactBody(
          request,
          headers,
          cancellation.signal,
        );
        const artifact = await buildArtifactService({
          gate: runtime.gate,
          store,
        }).ingest(authority, headers, body, cancellation.signal);
        cancellation.markSuccessfulResponse();
        response.status(201).json({
          version: 1,
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          contentType: artifact.contentType,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
        });
      } catch (error) {
        const category =
          error instanceof BrowserArtifactError
            ? error.category
            : ((error as { category?: string }).category ??
              "artifact_store_unavailable");
        sanitizedError(
          response,
          browserArtifactErrorStatus(category),
          category,
          category === "capability_denied"
            ? "Browser capability was denied"
            : "Browser artifact ingestion failed",
        );
      }
    },
  );

  router.ws(
    "/internal/browser-runs/:runId/cdp",
    async (downstream: WebSocket, request: Request) => {
      let authenticated: Awaited<ReturnType<typeof authenticate>> | undefined;
      try {
        const runtime = deps.getRuntime();
        const authority = authorityByRequest.get(request);
        const headers = headersByRequest.get(request);
        authenticated =
          runtime && authority && headers
            ? { runtime, authority, headers }
            : await authenticate(request);
      } catch {
        downstream.close(1008, "capability_denied");
        return;
      }
      const { runtime, authority, headers } = authenticated;
      const controller = new AbortController();
      downstream.once("close", () => controller.abort());
      const grantId = randomUUID();
      let upstream: WebSocket | undefined;
      let grantCleanupOwed = false;
      try {
        upstream = await runtime.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease => {
            if (deps.redeemCdpWithLease) {
              await deps.redeemCdpWithLease(runtime, lease, authority, headers);
            } else {
              const capabilities = createCapabilityStore({
                gate: runtime.gate,
              });
              await capabilities.redeemCdpWithLease(lease, {
                ownerId: authority.ownerId,
                sessionId: authority.sessionId,
                runId: authority.runId,
                ...headers,
              });
            }
            const deadline = new Date(
              Math.min(authority.deadline.getTime(), now().getTime() + 30_000),
            );
            const context = {
              correlationId: randomUUID(),
              deadline,
              signal: controller.signal,
              processNonce: lease.binding.processNonce,
              controlGenerationNonce: lease.binding.controlGenerationNonce,
            };
            grantCleanupOwed = true;
            try {
              const grant = await runtime.browserClient.createRelayGrant(
                authority.runtimeSessionId,
                {
                  version: 1,
                  grantId,
                  permission: "cdp",
                  expiresAt: deadline.toISOString(),
                  useLimit: 1,
                },
                context,
              );
              const openBinding = runtime.gate.assertOpen();
              if (
                openBinding.apiInstanceId !== lease.binding.apiInstanceId ||
                openBinding.databaseControlEpoch !==
                  lease.binding.databaseControlEpoch ||
                openBinding.processNonce !== lease.binding.processNonce ||
                openBinding.controlGenerationNonce !==
                  lease.binding.controlGenerationNonce
              ) {
                throw Object.assign(
                  new Error("Browser state changed before relay setup"),
                  { category: "browser_state_unavailable" },
                );
              }
              return await runtime.browserClient.openCdpStream(
                authority.runtimeSessionId,
                grant.relayToken,
                context,
              );
            } catch (error) {
              const revokeDeadline = new Date(
                Math.min(
                  authority.deadline.getTime(),
                  now().getTime() + RELAY_RELEASE_TIMEOUT_MS,
                ),
              );
              try {
                await runtime.browserClient.revokeRelayGrant(
                  authority.runtimeSessionId,
                  grantId,
                  { version: 1, grantId },
                  {
                    ...context,
                    deadline: revokeDeadline,
                    signal: AbortSignal.timeout(
                      Math.max(1, revokeDeadline.getTime() - now().getTime()),
                    ),
                  },
                );
                grantCleanupOwed = false;
              } catch {
                try {
                  runtime.gate.close("cdp_relay_cleanup_failed");
                } catch {
                  // Already closed.
                }
              }
              throw error;
            }
          },
        );
        const connected = upstream;
        let finalized = false;
        const finalize = async () => {
          if (finalized) return;
          finalized = true;
          await closeRelaySocket(connected).catch(() => undefined);
          try {
            if (grantCleanupOwed) {
              await runtime.gate.withBrowserStateMutationLease(
                "filesystem_and_database",
                async lease => {
                  const deadline = new Date(
                    Math.min(
                      authority.deadline.getTime(),
                      now().getTime() + RELAY_RELEASE_TIMEOUT_MS,
                    ),
                  );
                  await runtime.browserClient.revokeRelayGrant(
                    authority.runtimeSessionId,
                    grantId,
                    { version: 1, grantId },
                    {
                      correlationId: randomUUID(),
                      deadline,
                      signal: AbortSignal.timeout(
                        Math.max(1, deadline.getTime() - now().getTime()),
                      ),
                      processNonce: lease.binding.processNonce,
                      controlGenerationNonce:
                        lease.binding.controlGenerationNonce,
                    },
                  );
                  grantCleanupOwed = false;
                },
              );
            }
          } catch {
            // A grant or writer that cannot be proven released is incompatible
            // with an open mutation authority. Drained recovery must reconcile
            // the Browser Service before another generation opens.
            try {
              runtime.gate.close("cdp_relay_cleanup_failed");
            } catch {
              // An already-closed gate is already fail closed.
            }
          }
        };
        const overflow = () => {
          closeSocket(downstream, 1009, "relay_overflow");
          closeSocket(connected, 1009, "relay_overflow");
          void finalize();
        };
        connected.on("message", data => {
          sendBounded(downstream, data, overflow);
        });
        downstream.on("message", data => {
          sendBounded(connected, data, overflow);
        });
        connected.once("error", () => {
          closeSocket(downstream, 1011, "browser_unavailable");
          void finalize();
        });
        downstream.once("error", () => {
          void finalize();
        });
        const relayLifetime = Math.max(
          1,
          authority.deadline.getTime() - now().getTime(),
        );
        const lifetimeTimer = setTimeout(() => {
          closeSocket(downstream, 1008, "relay_deadline");
          void finalize();
        }, relayLifetime);
        lifetimeTimer.unref?.();
        connected.once("close", () => {
          clearTimeout(lifetimeTimer);
          if (downstream.readyState !== downstream.CLOSED) downstream.close();
          void finalize();
        });
        downstream.once("close", () => {
          clearTimeout(lifetimeTimer);
          void finalize();
        });
      } catch {
        if (upstream) {
          await closeRelaySocket(upstream).catch(() => {
            try {
              runtime.gate.close("cdp_relay_cleanup_failed");
            } catch {
              // Already closed.
            }
          });
        }
        downstream.close(1011, "browser_unavailable");
      }
    },
  );

  return router;
}
