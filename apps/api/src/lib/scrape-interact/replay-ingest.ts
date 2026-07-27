import { createHash, timingSafeEqual } from "node:crypto";

import bodyParser from "body-parser";
import type { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";

import { config } from "../../config";
import type { BrowserStartupGate } from "../browser-runtime/startup-gate";
import type { BrowserStateMutationLease } from "../browser-runtime/startup-gate";
import { canonicalizeBrowserStateCheckpoint } from "../browser-state/filesystem-store";
import type {
  PersistScrapeReplayStateInput,
  ReplayPersistenceResult,
} from "./replay-store";
import {
  replayBrowserSettingsV1Schema,
  replayScrapeOptionsSchema,
  replayStorageStateV1Schema,
} from "./replay-envelope";

const REPLAY_INGEST_PATH = "/internal/v1/browser/replay-checkpoints";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4_096;
const MAX_DEADLINE_FUTURE_MS = 60_000;
const RETRY_DELAYS_MS = [0, 250, 500, 1_000] as const;
const IDEMPOTENCY_HEADER = "x-firecrawl-idempotency-key";
const CORRELATION_HEADER = "x-firecrawl-correlation-id";
const DEADLINE_HEADER = "x-firecrawl-deadline-ms";
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const rawBody = Symbol("replayIngestRawBody");
const replayProtocol = Symbol("replayIngestProtocol");

const requestSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().uuid(),
  scrapeId: z.string().uuid(),
  ownerId: z.string().uuid(),
  url: z.url().regex(/^https?:\/\//i),
  options: replayScrapeOptionsSchema,
  callerOrigin: z.string().trim().min(1).max(256),
  replayCheckpoint: z.strictObject({
    version: z.literal(1),
    storageState: replayStorageStateV1Schema,
    finalUrl: z.url().regex(/^https?:\/\//i),
    fingerprint: z.strictObject({
      finalUrl: z.url().regex(/^https?:\/\//i),
      titleSha256: z.string().regex(HEX_SHA256),
      bodyTextSha256: z.string().regex(HEX_SHA256),
    }),
    browserSettings: replayBrowserSettingsV1Schema,
  }),
});

const responseSchema = z.strictObject({
  persisted: z.boolean(),
  reason: z.enum(["disabled", "zdr", "checkpoint_unavailable"]).optional(),
});

/** @public */
export class ReplayIngestClientError extends Error {
  readonly category = "replay_persistence_unavailable";

  constructor(cause?: unknown) {
    super("Replay persistence is unavailable", { cause });
    this.name = "ReplayIngestClientError";
  }
}

function bearerMatches(header: string | undefined, apiKey: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const expectedDigest = createHash("sha256").update(apiKey).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function singletonHeader(request: Request, name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBoundedResponse(
  response: globalThis.Response,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new ReplayIngestClientError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ReplayIngestClientError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(
    chunks.map(chunk => Buffer.from(chunk)),
    length,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ReplayIngestClientError(error);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

type ReplayIngestClientDependencies = {
  enabled: boolean;
  fetch: typeof fetch;
  baseUrl: string;
  apiKey: string;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  budgetMs: number;
  requestTimeoutMs: number;
};

async function persistScrapeReplayStateWithDependencies(
  input: PersistScrapeReplayStateInput,
  deps: ReplayIngestClientDependencies,
): Promise<ReplayPersistenceResult> {
  if (input.zeroDataRetention) return { persisted: false, reason: "zdr" };
  if (!input.replayCheckpoint) {
    return { persisted: false, reason: "checkpoint_unavailable" };
  }
  if (!deps.enabled) return { persisted: false, reason: "disabled" };
  if (Buffer.byteLength(deps.apiKey, "utf8") < 32 || !deps.baseUrl) {
    throw new ReplayIngestClientError();
  }
  let body: string;
  try {
    canonicalizeBrowserStateCheckpoint(input.replayCheckpoint.storageState);
    body = JSON.stringify(
      requestSchema.parse({
        version: 1,
        requestId: input.requestId,
        scrapeId: input.scrapeId,
        ownerId: input.ownerId,
        url: input.url,
        options: input.options,
        callerOrigin: input.callerOrigin,
        replayCheckpoint: input.replayCheckpoint,
      }),
    );
  } catch (error) {
    throw new ReplayIngestClientError(error);
  }
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new ReplayIngestClientError();
  }
  const idempotencyKey = digest(body);
  const startedAt = deps.now();
  const deadline = startedAt + deps.budgetMs;
  let lastError: unknown;

  for (const delay of RETRY_DELAYS_MS) {
    const remaining = startedAt + deps.budgetMs - deps.now();
    if (remaining <= 0) break;
    if (delay > 0) {
      await deps.sleep(Math.min(delay, remaining));
      if (startedAt + deps.budgetMs - deps.now() <= 0) break;
    }
    try {
      const response = await deps.fetch(
        new URL(REPLAY_INGEST_PATH, deps.baseUrl),
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${deps.apiKey}`,
            "content-type": "application/json",
            [IDEMPOTENCY_HEADER]: idempotencyKey,
            [CORRELATION_HEADER]: input.requestId,
            [DEADLINE_HEADER]: String(deadline),
          },
          body,
          signal: AbortSignal.timeout(
            Math.max(
              1,
              Math.min(
                deps.requestTimeoutMs,
                startedAt + deps.budgetMs - deps.now(),
              ),
            ),
          ),
        },
      );
      const responseBody = await readBoundedResponse(response);
      if (response.ok) {
        try {
          return responseSchema.parse(JSON.parse(responseBody));
        } catch (error) {
          throw new ReplayIngestClientError(error);
        }
      }
      if (![500, 503].includes(response.status)) {
        throw new ReplayIngestClientError();
      }
      lastError = new ReplayIngestClientError();
    } catch (error) {
      if (error instanceof ReplayIngestClientError) throw error;
      lastError = error;
    }
  }
  throw new ReplayIngestClientError(lastError);
}

function productionClientDependencies(): ReplayIngestClientDependencies {
  return {
    enabled: config.LOCAL_BROWSER_SERVICE_ENABLED === true,
    fetch,
    baseUrl: config.BROWSER_REPLAY_INGEST_URL ?? "",
    apiKey: config.BROWSER_REPLAY_INGEST_API_KEY ?? "",
    now: Date.now,
    sleep: wait,
    budgetMs: config.BROWSER_RECONCILIATION_STARTUP_BUDGET_MS,
    requestTimeoutMs: config.BROWSER_SERVICE_REQUEST_TIMEOUT_MS,
  };
}

/** @public */
export function persistScrapeReplayStateThroughAuthority(
  input: PersistScrapeReplayStateInput,
): Promise<ReplayPersistenceResult> {
  return persistScrapeReplayStateWithDependencies(
    input,
    productionClientDependencies(),
  );
}

/** @internal Test-only dependency injection for authority transport. */
export function createReplayIngestClientForTesting(
  dependencies: Partial<ReplayIngestClientDependencies>,
): (input: PersistScrapeReplayStateInput) => Promise<ReplayPersistenceResult> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Replay ingest test client is unavailable");
  }
  const deps = { ...productionClientDependencies(), ...dependencies };
  return input => persistScrapeReplayStateWithDependencies(input, deps);
}

/** @internal Transport registration; persistence authority supplies mutation. */
export function registerReplayIngestTransportRoute(
  app: Application,
  deps: {
    apiKey: string | undefined;
    getGate: () => BrowserStartupGate | undefined;
    persist: (
      input: PersistScrapeReplayStateInput,
      lease: BrowserStateMutationLease,
    ) => Promise<ReplayPersistenceResult>;
  },
): void {
  const parser = bodyParser.json({
    limit: MAX_REQUEST_BYTES,
    strict: true,
    type: "application/json",
    verify: (request, _response, bytes) => {
      const typed = request as Request & {
        [rawBody]?: Buffer;
        [replayProtocol]?: { idempotencyKey: string };
      };
      const protocol = typed[replayProtocol];
      if (!protocol || !HEX_SHA256.test(protocol.idempotencyKey)) {
        throw new Error("invalid replay ingest protocol");
      }
      const captured = Buffer.from(bytes);
      if (digest(captured) !== protocol.idempotencyKey) {
        throw new Error("replay ingest digest mismatch");
      }
      typed[rawBody] = captured;
    },
  });
  app.post(
    REPLAY_INGEST_PATH,
    (request: Request, response: Response, next: NextFunction) => {
      const authorization = singletonHeader(request, "authorization");
      if (
        deps.apiKey === undefined ||
        !bearerMatches(authorization, deps.apiKey)
      ) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      const contentType = singletonHeader(request, "content-type");
      const idempotencyKey = singletonHeader(request, IDEMPOTENCY_HEADER);
      const correlationId = singletonHeader(request, CORRELATION_HEADER);
      const deadlineHeader = singletonHeader(request, DEADLINE_HEADER);
      const now = Date.now();
      const deadline =
        deadlineHeader && /^\d+$/.test(deadlineHeader)
          ? Number(deadlineHeader)
          : Number.NaN;
      if (
        contentType === undefined ||
        !/^application\/json(?:\s*;|$)/i.test(contentType) ||
        idempotencyKey === undefined ||
        !HEX_SHA256.test(idempotencyKey) ||
        correlationId === undefined ||
        !z.string().uuid().safeParse(correlationId).success ||
        !Number.isSafeInteger(deadline) ||
        deadline <= now ||
        deadline > now + MAX_DEADLINE_FUTURE_MS
      ) {
        response.status(400).json({ error: "invalid_protocol" });
        return;
      }
      (
        request as Request & {
          [replayProtocol]?: {
            correlationId: string;
            deadline: number;
            idempotencyKey: string;
          };
        }
      )[replayProtocol] = { correlationId, deadline, idempotencyKey };
      next();
    },
    parser,
    async (request: Request, response: Response) => {
      response.setHeader("cache-control", "no-store");
      const typedRequest = request as Request & {
        [rawBody]?: Buffer;
        [replayProtocol]?: {
          correlationId: string;
          deadline: number;
          idempotencyKey: string;
        };
      };
      const protocol = typedRequest[replayProtocol];
      const parsed = requestSchema.safeParse(request.body);
      if (
        !parsed.success ||
        !protocol ||
        !typedRequest[rawBody] ||
        parsed.data.requestId !== protocol.correlationId
      ) {
        response.status(400).json({ error: "invalid_request" });
        return;
      }
      if (request.aborted || Date.now() >= protocol.deadline) {
        response.status(408).json({ error: "deadline_exceeded" });
        return;
      }
      const gate = deps.getGate();
      if (!gate) {
        response.status(503).json({ error: "browser_state_unavailable" });
        return;
      }
      try {
        const result = await gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease => {
            if (request.aborted || Date.now() >= protocol.deadline) {
              const error = new Error("Replay ingest deadline exceeded");
              error.name = "ReplayIngestDeadlineError";
              throw error;
            }
            // The outer transaction holds only the control-row fence. Replay
            // persistence deliberately commits its preparing intent before the
            // filesystem rename so a process crash cannot create an
            // untracked file.
            return deps.persist(
              {
                ...parsed.data,
                zeroDataRetention: false,
              },
              lease,
            );
          },
        );
        response.status(200).json(result);
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "ReplayIngestDeadlineError"
        ) {
          response.status(408).json({ error: "deadline_exceeded" });
          return;
        }
        response.status(503).json({ error: "browser_state_unavailable" });
      }
    },
  );
  app.use(
    REPLAY_INGEST_PATH,
    (
      _error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (!response.headersSent) {
        response.status(400).json({ error: "invalid_request" });
      }
    },
  );
}
