import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createReplayIngestClientForTesting,
  registerReplayIngestTransportRoute,
} from "./replay-ingest";
import type { PersistScrapeReplayStateInput } from "./replay-store";

const apiKey = "s".repeat(32);
const input: PersistScrapeReplayStateInput = {
  requestId: "11111111-1111-4111-8111-111111111111",
  scrapeId: "22222222-2222-4222-8222-222222222222",
  ownerId: "33333333-3333-4333-8333-333333333333",
  url: "https://example.test",
  options: {},
  callerOrigin: "api",
  zeroDataRetention: false,
  replayCheckpoint: {
    version: 1,
    storageState: { cookies: [], origins: [] },
    finalUrl: "https://example.test",
    fingerprint: {
      finalUrl: "https://example.test",
      titleSha256: "a".repeat(64),
      bodyTextSha256: "b".repeat(64),
    },
    browserSettings: {
      headers: {},
      cookies: [],
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
      userAgent: "test",
      locale: "en-US",
      timezoneId: "UTC",
      location: { country: "US", languages: ["en-US"] },
      proxy: { kind: "auto" },
      skipTlsVerification: false,
      blockAds: false,
      lockdown: true,
    },
  },
};

function authorizedBody() {
  const { zeroDataRetention: _zeroDataRetention, ...body } = input;
  return { version: 1, ...body };
}

function postAuthorized(
  app: express.Application,
  body: ReturnType<typeof authorizedBody>,
  overrides: Record<string, string | string[]> = {},
) {
  const encoded = JSON.stringify(body);
  const headers: Record<string, string | string[]> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-firecrawl-idempotency-key": createHash("sha256")
      .update(encoded)
      .digest("hex"),
    "x-firecrawl-correlation-id": body.requestId,
    "x-firecrawl-deadline-ms": String(Date.now() + 60_000),
    ...overrides,
  };
  let result = request(app).post("/internal/v1/browser/replay-checkpoints");
  for (const [name, value] of Object.entries(headers)) {
    result =
      typeof value === "string"
        ? result.set(name, value)
        : result.set(name as "Cookie", value);
  }
  return result.send(encoded);
}

describe("replay ingest authority boundary", () => {
  it("authenticates before parsing and performs no work while closed", async () => {
    const app = express();
    const persist = vi.fn();
    let gate:
      | {
          withBrowserStateMutationLease: ReturnType<typeof vi.fn>;
        }
      | undefined;
    registerReplayIngestTransportRoute(app, {
      apiKey,
      getGate: () => gate as never,
      persist,
    });

    await request(app)
      .post("/internal/v1/browser/replay-checkpoints")
      .set("content-type", "application/json")
      .send("{not-json")
      .expect(401, { error: "unauthorized" });
    await postAuthorized(app, authorizedBody()).expect(503, {
      error: "browser_state_unavailable",
    });
    gate = {
      withBrowserStateMutationLease: vi.fn(async () => {
        throw new Error("durable control mismatch");
      }),
    };
    await postAuthorized(app, authorizedBody()).expect(503, {
      error: "browser_state_unavailable",
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("persists only inside the browser mutation lease", async () => {
    const app = express();
    const persist = vi.fn(async () => ({ persisted: true }));
    const transaction = {
      query: vi.fn(),
      databaseControlEpoch: 1,
    };
    const gate = {
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
        operation({
          epoch: 1,
          scope: "filesystem_and_database",
          binding: {},
          transaction,
        }),
      ),
    };
    registerReplayIngestTransportRoute(app, {
      apiKey,
      getGate: () => gate as never,
      persist,
    });

    await postAuthorized(app, authorizedBody()).expect(200, {
      persisted: true,
    });
    expect(gate.withBrowserStateMutationLease).toHaveBeenCalledWith(
      "filesystem_and_database",
      expect.any(Function),
    );
    expect(persist).toHaveBeenCalledOnce();
  });

  it("rejects duplicate, mismatched, and expired protocol headers", async () => {
    const app = express();
    const persist = vi.fn(async () => ({ persisted: true }));
    const gate = {
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
        operation({}),
      ),
    };
    registerReplayIngestTransportRoute(app, {
      apiKey,
      getGate: () => gate as never,
      persist,
    });
    const body = authorizedBody();

    await postAuthorized(app, body, {
      "x-firecrawl-correlation-id": [
        body.requestId,
        "44444444-4444-4444-8444-444444444444",
      ],
    }).expect(400, { error: "invalid_protocol" });
    await postAuthorized(app, body, {
      "x-firecrawl-idempotency-key": "f".repeat(64),
    }).expect(400, { error: "invalid_request" });
    await postAuthorized(app, body, {
      "x-firecrawl-deadline-ms": String(Date.now() - 1),
    }).expect(400, { error: "invalid_protocol" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("retries byte-identical requests and skips ZDR before fetch", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport"))
      .mockResolvedValueOnce(
        new Response('{"error":"browser_state_unavailable"}', { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response('{"persisted":true}', { status: 200 }),
      );
    const sleeps: number[] = [];
    const persist = createReplayIngestClientForTesting({
      enabled: true,
      fetch,
      baseUrl: "http://127.0.0.1:3002",
      apiKey,
      now: () => 1_000,
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
      },
      budgetMs: 60_000,
      requestTimeoutMs: 30_000,
    });
    await expect(persist(input)).resolves.toEqual({ persisted: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[2]?.[1]?.body);
    expect(sleeps).toEqual([250, 500]);

    await expect(
      persist({ ...input, zeroDataRetention: true }),
    ).resolves.toEqual({ persisted: false, reason: "zdr" });
    expect(fetch).toHaveBeenCalledTimes(3);

    const unauthorizedFetch = vi.fn(
      async () => new Response("", { status: 401 }),
    );
    const persistUnauthorized = createReplayIngestClientForTesting({
      enabled: true,
      fetch: unauthorizedFetch,
      baseUrl: "http://127.0.0.1:3002",
      apiKey,
    });
    await expect(persistUnauthorized(input)).rejects.toMatchObject({
      category: "replay_persistence_unavailable",
    });
    expect(unauthorizedFetch).toHaveBeenCalledOnce();
  });

  it("rejects an oversized streamed authority response", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(3_000));
              controller.enqueue(new Uint8Array(3_000));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    const persist = createReplayIngestClientForTesting({
      enabled: true,
      fetch,
      baseUrl: "http://127.0.0.1:3002",
      apiKey,
    });
    await expect(persist(input)).rejects.toMatchObject({
      category: "replay_persistence_unavailable",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not transport or mutate when the local browser is disabled", async () => {
    const fetch = vi.fn();
    const persist = createReplayIngestClientForTesting({
      enabled: false,
      fetch,
      baseUrl: "",
      apiKey: "",
    });

    await expect(persist(input)).resolves.toEqual({
      persisted: false,
      reason: "disabled",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
