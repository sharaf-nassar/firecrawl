import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_PRIVATE_ROUTE_CONTRACTS,
  MAX_ARTIFACT_BYTES,
} from "./browser-service-contracts";
import {
  API_INSTANCE_ID,
  BrowserServiceClient,
  createHandoffIdempotencyKey,
  type BrowserServiceBootstrapRequestContext,
  type BrowserServiceRequestContext,
} from "./browser-service-client";

const ID = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
const ID_2 = "a4124f0d-94fa-48cc-9b4c-f0c09374887f";
const TOKEN = "A".repeat(43);
const TOKEN_2 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const HASH = "a".repeat(64);

const bootstrapContext = (): BrowserServiceBootstrapRequestContext => ({
  correlationId: "task-7",
  deadline: new Date(Date.now() + 30_000),
  signal: new AbortController().signal,
});
const scopedContext = (): BrowserServiceRequestContext => ({
  ...bootstrapContext(),
  processNonce: TOKEN,
  controlGenerationNonce: TOKEN_2,
});

const action = {
  version: 1 as const,
  actionId: ID,
  runId: ID_2,
  sequence: 1,
  normalizedProposalHash: HASH,
  effect: "read_only" as const,
  expectedSessionVersion: 0,
  allowedDomains: ["example.test"],
  operation: { kind: "get_url" as const },
};
const actionResult = {
  version: 1 as const,
  actionId: ID,
  sequence: 1,
  normalizedProposalHash: HASH,
  page: {
    url: "https://example.test/",
    title: "Example",
    snapshotExcerpt: "",
  },
  sessionVersion: 1,
  outcome: "succeeded" as const,
  result: { kind: "get_url" as const, url: "https://example.test/" },
};
const controlGeneration = {
  version: 1 as const,
  processNonce: TOKEN,
  controlGenerationNonce: TOKEN_2,
  apiInstanceId: ID,
};
const handoffRequest = {
  version: 1 as const,
  processNonce: TOKEN,
  apiInstanceId: ID,
  idempotencyKey: TOKEN_2,
};
const liveDiscovery = {
  version: 1 as const,
  status: "live_unreconciled" as const,
  processNonce: TOKEN,
};
const readyHealth = {
  version: 1 as const,
  status: "ready" as const,
  processNonce: TOKEN,
  controlGenerationNonce: TOKEN_2,
  snapshotDigest: HASH,
};
const reconciliationResult = {
  version: 1 as const,
  processNonce: TOKEN,
  controlGenerationNonce: TOKEN_2,
  snapshotDigest: HASH,
  retained: 0,
  removed: 0,
  missing: 0 as const,
  corrupt: 0 as const,
  ready: true as const,
};

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("BrowserServiceClient", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const onControlGenerationMismatch = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    onControlGenerationMismatch.mockReset();
  });

  function client() {
    return new BrowserServiceClient({
      baseUrl: "http://browser-service:3010",
      apiKey: "secret".repeat(6),
      requestTimeoutMs: 30_000,
      reconciliationTimeoutMs: 60_000,
      fetch: fetchMock,
      onControlGenerationMismatch,
    });
  }

  it("locks process identity and canonical handoff key generation", () => {
    expect(API_INSTANCE_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(API_INSTANCE_ID).toBe(API_INSTANCE_ID);
    const keys = Array.from({ length: 32 }, () =>
      createHandoffIdempotencyKey(),
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const bytes = Buffer.from(key, "base64url");
      expect(bytes).toHaveLength(32);
      expect(bytes.toString("base64url")).toBe(key);
    }
  });

  it("enforces the 32..4089 UTF-8 byte service key boundary", () => {
    const make = (apiKey: string) =>
      new BrowserServiceClient({
        baseUrl: "http://browser-service:3010",
        apiKey,
        requestTimeoutMs: 30_000,
        reconciliationTimeoutMs: 60_000,
        fetch: fetchMock,
        onControlGenerationMismatch,
      });
    expect(() => make("é".repeat(16))).not.toThrow();
    expect(() => make("x".repeat(4_089))).not.toThrow();
    expect(() => make("x".repeat(31))).toThrow(/invalid Browser Service/);
    expect(() => make("x".repeat(4_090))).toThrow(/invalid Browser Service/);
  });

  it("rejects invalid deadlines before fetch without rewriting category", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    try {
      for (const deadline of [
        new Date(Date.now()),
        new Date(Date.now() + 300_001),
        new Date(Number.NaN),
      ]) {
        await expect(
          client().discoverLive({
            ...bootstrapContext(),
            deadline,
          }),
        ).rejects.toMatchObject({
          category: "browser_service_invalid_request",
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, liveDiscovery))
        .mockResolvedValueOnce(jsonResponse(200, liveDiscovery));
      for (const deadline of [
        new Date(Date.now() + 1),
        new Date(Date.now() + 300_000),
      ]) {
        await expect(
          client().discoverLive({
            ...bootstrapContext(),
            deadline,
          }),
        ).resolves.toEqual(liveDiscovery);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts exact action identity with auth, fencing, and deadline", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, actionResult));
    const context = scopedContext();
    await expect(client().executeAction(ID, action, context)).resolves.toEqual(
      actionResult,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `http://browser-service:3010/v1/sessions/${ID}/actions`,
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        body: JSON.stringify(action),
        redirect: "manual",
        headers: expect.objectContaining({
          authorization: `Bearer ${"secret".repeat(6)}`,
          "x-firecrawl-correlation-id": context.correlationId,
          "x-firecrawl-deadline": context.deadline.toISOString(),
          "x-firecrawl-process-nonce": context.processNonce,
          "x-firecrawl-control-generation-nonce":
            context.controlGenerationNonce,
        }),
      }),
    );
  });

  it("binds handoff and reconciliation to current process and generation", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, liveDiscovery))
      .mockResolvedValueOnce(jsonResponse(201, controlGeneration))
      .mockResolvedValueOnce(jsonResponse(200, reconciliationResult))
      .mockResolvedValueOnce(jsonResponse(200, readyHealth));
    const c = client();
    await expect(c.discoverLive(bootstrapContext())).resolves.toEqual(
      liveDiscovery,
    );
    await expect(
      c.createControlGeneration(handoffRequest, bootstrapContext()),
    ).resolves.toEqual(controlGeneration);
    const body = JSON.stringify({
      version: 1,
      processNonce: TOKEN,
      controlGenerationNonce: TOKEN_2,
      snapshotDigest: HASH,
      references: [],
    });
    await expect(c.reconcile(body, scopedContext())).resolves.toEqual(
      reconciliationResult,
    );
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(body);
    await expect(c.getReady(scopedContext())).resolves.toEqual(readyHealth);
  });

  it("retries one handoff identity without changing its bytes", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(jsonResponse(201, controlGeneration));
    const c = client();
    await expect(
      c.createControlGeneration(handoffRequest, bootstrapContext()),
    ).rejects.toMatchObject({ category: "browser_service_unavailable" });
    await expect(
      c.createControlGeneration(handoffRequest, bootstrapContext()),
    ).resolves.toEqual(controlGeneration);
    expect(fetchMock.mock.calls.map(call => call[1]?.body)).toEqual([
      JSON.stringify(handoffRequest),
      JSON.stringify(handoffRequest),
    ]);
  });

  it.each([
    "control_generation_in_progress",
    "control_generation_conflict",
    "control_generation_superseded",
    "control_generation_drain_failed",
    "control_generation_history_exhausted",
  ])("preserves typed bootstrap policy category %s", async category => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        category === "control_generation_drain_failed" ||
          category === "control_generation_history_exhausted"
          ? 503
          : 409,
        { version: 1, category, message: "handoff rejected" },
      ),
    );
    await expect(
      client().createControlGeneration(handoffRequest, bootstrapContext()),
    ).rejects.toMatchObject({ category });
    expect(onControlGenerationMismatch).not.toHaveBeenCalled();
  });

  it("rejects redirects and bounded malformed action responses", async () => {
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: "http://attacker.test/" },
      }),
      jsonResponse(200, { ...actionResult, result: undefined }),
      jsonResponse(200, {
        ...actionResult,
        result: { kind: "wait", waitedMs: 0 },
      }),
      new Response('{"result":NaN}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(128 * 1024 + 1),
        },
      }),
    ];
    const c = client();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(
        c.executeAction(ID, action, scopedContext()),
      ).rejects.toMatchObject({
        category: "browser_service_protocol_error",
      });
    }
  });

  it("validates artifact headers, cap, stream length, and hash", async () => {
    const bytes = new TextEncoder().encode("artifact");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    fetchMock.mockResolvedValueOnce(
      new Response(bytes, {
        status: 200,
        headers: {
          "x-firecrawl-artifact-version": "1",
          "x-firecrawl-artifact-id": ID_2,
          "x-firecrawl-artifact-kind": "trace",
          "x-firecrawl-artifact-byte-size": String(bytes.length),
          "x-firecrawl-artifact-sha256": checksum,
          "content-type": "application/zip",
          "content-length": String(bytes.length),
        },
      }),
    );
    await expect(
      client().fetchArtifact(
        ID,
        {
          version: 1,
          artifactId: ID_2,
          kind: "trace",
          preset: "diagnostic-v1",
        },
        scopedContext(),
      ),
    ).resolves.toMatchObject({
      metadata: { artifactId: ID_2, byteSize: bytes.length, checksum },
      bytes,
    });
  });

  it("rejects malformed, truncated, oversized, and corrupt artifacts", async () => {
    const bytes = new TextEncoder().encode("artifact");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const headers = {
      "x-firecrawl-artifact-version": "1",
      "x-firecrawl-artifact-id": ID_2,
      "x-firecrawl-artifact-kind": "trace",
      "x-firecrawl-artifact-byte-size": String(bytes.length),
      "x-firecrawl-artifact-sha256": checksum,
      "content-type": "application/zip",
      "content-length": String(bytes.length),
    };
    const responses = [
      new Response(bytes, {
        status: 200,
        headers: { ...headers, "content-type": "image/png" },
      }),
      new Response(bytes, {
        status: 200,
        headers: { ...headers, "x-firecrawl-artifact-version": "2" },
      }),
      new Response(bytes, {
        status: 200,
        headers: {
          ...headers,
          "content-length": String(bytes.length + 1),
        },
      }),
      new Response(bytes, {
        status: 200,
        headers: {
          ...headers,
          "content-length": String(bytes.length - 1),
        },
      }),
      new Response(bytes, {
        status: 200,
        headers: {
          ...headers,
          "x-firecrawl-artifact-byte-size": String(16 * 1024 * 1024 + 1),
          "content-length": String(16 * 1024 * 1024 + 1),
        },
      }),
      new Response(bytes, {
        status: 200,
        headers: {
          ...headers,
          "x-firecrawl-artifact-sha256": "b".repeat(64),
        },
      }),
    ];
    const c = client();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(
        c.fetchArtifact(
          ID,
          {
            version: 1,
            artifactId: ID_2,
            kind: "trace",
            preset: "diagnostic-v1",
          },
          scopedContext(),
        ),
      ).rejects.toMatchObject({
        category: "browser_service_protocol_error",
      });
    }
  });

  it("cancels an artifact stream that exceeds its route-owned body cap", async () => {
    const cancel = vi.fn();
    let pull = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pull += 1;
        if (pull === 1) {
          controller.enqueue(new Uint8Array(MAX_ARTIFACT_BYTES));
        } else {
          controller.enqueue(new Uint8Array(1));
        }
      },
      cancel,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: {
          "x-firecrawl-artifact-version": "1",
          "x-firecrawl-artifact-id": ID_2,
          "x-firecrawl-artifact-kind": "trace",
          "x-firecrawl-artifact-byte-size": "1",
          "x-firecrawl-artifact-sha256": "b".repeat(64),
          "content-type": "application/zip",
          "content-length": "1",
        },
      }),
    );

    await expect(
      client().fetchArtifact(
        ID,
        {
          version: 1,
          artifactId: ID_2,
          kind: "trace",
          preset: "diagnostic-v1",
        },
        scopedContext(),
      ),
    ).rejects.toMatchObject({
      category: "browser_service_protocol_error",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses the route inventory response cap in client decoding", async () => {
    const route = API_PRIVATE_ROUTE_CONTRACTS[0] as {
      responseBytes: number;
    };
    const original = route.responseBytes;
    route.responseBytes = 1;
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, controlGeneration));
      await expect(
        client().createControlGeneration(handoffRequest, bootstrapContext()),
      ).rejects.toMatchObject({
        category: "browser_service_protocol_error",
      });
    } finally {
      route.responseBytes = original;
    }
  });

  it("invokes mismatch callback synchronously before rejecting scoped HTTP", async () => {
    let callbackObserved = false;
    onControlGenerationMismatch.mockImplementation(() => {
      callbackObserved = true;
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        version: 1,
        category: "control_generation_mismatch",
        message: "stale generation",
      }),
    );
    const promise = client().getLive(scopedContext());
    await expect(promise).rejects.toMatchObject({
      category: "control_generation_mismatch",
    });
    expect(callbackObserved).toBe(true);
    expect(onControlGenerationMismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        processNonce: TOKEN,
        controlGenerationNonce: TOKEN_2,
      }),
    );
  });

  it("deletes an exact retained profile generation and rejects response drift", async () => {
    const request = {
      version: 1 as const,
      generationId: ID_2,
      statePath: `profiles/${ID}/committed/${ID_2}`,
      checksum: HASH,
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ...request, deleted: true }),
    );
    await expect(
      client().deleteRetainedProfileGeneration(request, scopedContext()),
    ).resolves.toEqual({ ...request, deleted: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://browser-service:3010/v1/profile-generations/${ID_2}/retention`,
    );

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ...request,
        statePath: `profiles/${ID_2}/committed/${ID_2}`,
        deleted: true,
      }),
    );
    await expect(
      client().deleteRetainedProfileGeneration(request, scopedContext()),
    ).rejects.toMatchObject({
      category: "browser_service_protocol_error",
    });
  });

  it.each([
    [
      "getLive",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.getLive(ctx),
    ],
    [
      "getReady",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.getReady(ctx),
    ],
    [
      "reconcile",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.reconcile("{}", ctx),
    ],
    [
      "createSession",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.createSession(
          {
            version: 1,
            sessionId: ID,
            initialUrl: "https://example.test/",
            allowedDomains: ["example.test"],
            ttlSeconds: 60,
            activityTtlSeconds: 30,
            profile: null,
            replay: null,
            settings: {
              headers: {},
              cookies: [],
              viewport: {
                width: 1280,
                height: 720,
                deviceScaleFactor: 1,
                isMobile: false,
                hasTouch: false,
              },
              userAgent: "Task7",
              locale: "en-US",
              location: { country: "us", languages: ["en-US"] },
              proxy: { kind: "basic" },
              skipTlsVerification: false,
              blockAds: false,
              lockdown: true,
            },
          },
          ctx,
        ),
    ],
    [
      "getSession",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.getSession(ID, ctx),
    ],
    [
      "closeSession",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.closeSession(
          ID,
          { version: 1, reason: "requested", expectedSessionVersion: 0 },
          ctx,
        ),
    ],
    [
      "executeAction",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.executeAction(ID, action, ctx),
    ],
    [
      "createRelayGrant",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.createRelayGrant(
          ID,
          {
            version: 1,
            grantId: ID_2,
            permission: "passive",
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
            useLimit: 1,
            expectedSessionVersion: 0,
            allowedDomains: ["example.test"],
          },
          ctx,
        ),
    ],
    [
      "revokeRelayGrant",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.revokeRelayGrant(ID, ID_2, { version: 1, grantId: ID_2 }, ctx),
    ],
    [
      "fetchArtifact",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.fetchArtifact(
          ID,
          {
            version: 1,
            artifactId: ID_2,
            kind: "trace",
            preset: "diagnostic-v1",
          },
          ctx,
        ),
    ],
    [
      "finalizeProfile",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.finalizeProfile(
          ID_2,
          {
            version: 1,
            profileId: ID,
            generationId: ID_2,
            checksum: HASH,
            prepareToken: TOKEN,
          },
          ctx,
        ),
    ],
    [
      "discardProfile",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.discardProfile(
          ID_2,
          {
            version: 1,
            profileId: ID,
            generationId: ID_2,
            checksum: HASH,
            prepareToken: TOKEN,
          },
          ctx,
        ),
    ],
    [
      "persistReplayCheckpoint",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.persistReplayCheckpoint(
          {
            version: 1,
            ownerId: ID,
            scrapeId: ID_2,
            checkpointId: ID,
            storageState: { cookies: [], origins: [] },
          },
          ctx,
        ),
    ],
    [
      "readReplayCheckpoint",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.readReplayCheckpoint(
          {
            version: 1,
            statePath: `replay/${ID}/${ID_2}/${ID}.json`,
            checksum:
              "1f6c35926314be663593452b39441c1ba3a462c142197e633b31ab574cf01a46",
            byteSize: 27,
          },
          ctx,
        ),
    ],
    [
      "deleteReplayCheckpoint",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.deleteReplayCheckpoint(
          {
            version: 1,
            statePath: `replay/${ID}/${ID_2}/${ID}.json`,
            checksum:
              "1f6c35926314be663593452b39441c1ba3a462c142197e633b31ab574cf01a46",
          },
          ctx,
        ),
    ],
    [
      "deleteRetainedProfileGeneration",
      (c: BrowserServiceClient, ctx: BrowserServiceRequestContext) =>
        c.deleteRetainedProfileGeneration(
          {
            version: 1,
            generationId: ID_2,
            statePath: `profiles/${ID}/committed/${ID_2}`,
            checksum: HASH,
          },
          ctx,
        ),
    ],
  ] as const)(
    "closes through mismatch callback on scoped HTTP method %s",
    async (_method, invoke) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, {
          version: 1,
          category: "control_generation_mismatch",
          message: "stale generation",
        }),
      );
      const ctx = scopedContext();
      await expect(invoke(client(), ctx)).rejects.toMatchObject({
        category: "control_generation_mismatch",
      });
      expect(onControlGenerationMismatch).toHaveBeenCalledOnce();
      expect(onControlGenerationMismatch).toHaveBeenCalledWith({
        processNonce: ctx.processNonce,
        controlGenerationNonce: ctx.controlGenerationNonce,
      });
    },
  );

  it.each([
    [
      "finalize",
      "profile_finalize_failed",
      (c: BrowserServiceClient) =>
        c.finalizeProfile(
          ID_2,
          {
            version: 1,
            profileId: ID,
            generationId: ID_2,
            checksum: HASH,
            prepareToken: TOKEN,
          },
          scopedContext(),
        ),
    ],
    [
      "discard",
      "profile_discard_failed",
      (c: BrowserServiceClient) =>
        c.discardProfile(
          ID_2,
          {
            version: 1,
            profileId: ID,
            generationId: ID_2,
            checksum: HASH,
            prepareToken: TOKEN,
          },
          scopedContext(),
        ),
    ],
  ] as const)(
    "decodes declared %s profile errors",
    async (_name, category, invoke) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, {
          version: 1,
          category,
          message: "prepared profile request is invalid",
        }),
      );

      await expect(invoke(client())).rejects.toMatchObject({
        category,
        status: 409,
      });
    },
  );

  it.each([
    ["openPassiveStream", "openPassiveStream"],
    ["openInteractiveStream", "openInteractiveStream"],
    ["openCdpStream", "openCdpStream"],
  ] as const)(
    "closes through mismatch callback on scoped WebSocket method %s",
    async (_name, method) => {
      class FakeSocket extends EventEmitter {
        close = vi.fn();
      }
      const socket = new FakeSocket();
      const c = new BrowserServiceClient({
        baseUrl: "http://browser-service:3010",
        apiKey: "secret".repeat(6),
        requestTimeoutMs: 30_000,
        reconciliationTimeoutMs: 60_000,
        fetch: fetchMock,
        onControlGenerationMismatch,
        webSocketFactory: () => socket as never,
      });
      const opening = c[method](ID, TOKEN, scopedContext());
      socket.emit(
        "unexpected-response",
        {},
        jsonResponse(409, {
          version: 1,
          category: "control_generation_mismatch",
          message: "stale generation",
        }),
      );
      await expect(opening).rejects.toMatchObject({
        category: "control_generation_mismatch",
      });
      expect(onControlGenerationMismatch).toHaveBeenCalledOnce();
    },
  );

  it("invokes mismatch callback for a WebSocket upgrade error", async () => {
    class FakeSocket extends EventEmitter {
      close = vi.fn();
    }
    const socket = new FakeSocket();
    const c = new BrowserServiceClient({
      baseUrl: "http://browser-service:3010",
      apiKey: "secret".repeat(6),
      requestTimeoutMs: 30_000,
      reconciliationTimeoutMs: 60_000,
      fetch: fetchMock,
      onControlGenerationMismatch,
      webSocketFactory: () => socket as never,
    });
    const opening = c.openPassiveStream(ID, TOKEN, scopedContext());
    socket.emit(
      "unexpected-response",
      {},
      jsonResponse(409, {
        version: 1,
        category: "control_generation_mismatch",
        message: "stale generation",
      }),
    );
    await expect(opening).rejects.toMatchObject({
      category: "control_generation_mismatch",
    });
    expect(onControlGenerationMismatch).toHaveBeenCalledOnce();
  });

  it("lets completed Node mismatch decoding win socket and abort races", async () => {
    class FakeSocket extends EventEmitter {
      close = vi.fn();
      terminate = vi.fn();
    }
    const socket = new FakeSocket();
    const controller = new AbortController();
    const context = {
      ...scopedContext(),
      signal: controller.signal,
    };
    const order: string[] = [];
    onControlGenerationMismatch.mockImplementation(() => {
      order.push("callback");
    });
    const c = new BrowserServiceClient({
      baseUrl: "http://browser-service:3010",
      apiKey: "secret".repeat(6),
      requestTimeoutMs: 30_000,
      reconciliationTimeoutMs: 60_000,
      fetch: fetchMock,
      onControlGenerationMismatch,
      webSocketFactory: () => socket as never,
    });
    const response = Object.assign(
      new Readable({
        read() {
          // The test releases the response after all competing events.
        },
      }),
      {
        statusCode: 409,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
    const observed = c.openPassiveStream(ID, TOKEN, context).catch(error => {
      order.push("reject");
      throw error;
    });
    socket.emit("unexpected-response", {}, response);
    socket.emit("error", new Error("private websocket detail"));
    socket.emit("close");
    controller.abort(new Error("caller aborted"));
    expect(order).toEqual([]);

    response.push(
      JSON.stringify({
        version: 1,
        category: "control_generation_mismatch",
        message: "stale generation",
      }),
    );
    response.push(null);

    await expect(observed).rejects.toMatchObject({
      category: "control_generation_mismatch",
    });
    expect(order).toEqual(["callback", "reject"]);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount("open")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("unexpected-response")).toBe(0);
    expect(response.readableEnded).toBe(true);
  });

  it("decodes a buffered WHATWG mismatch before caller abort cancellation", async () => {
    class FakeSocket extends EventEmitter {
      close = vi.fn();
      terminate = vi.fn();
    }
    const socket = new FakeSocket();
    const controller = new AbortController();
    const order: string[] = [];
    onControlGenerationMismatch.mockImplementation(() => {
      order.push("callback");
    });
    const c = new BrowserServiceClient({
      baseUrl: "http://browser-service:3010",
      apiKey: "secret".repeat(6),
      requestTimeoutMs: 30_000,
      reconciliationTimeoutMs: 60_000,
      fetch: fetchMock,
      onControlGenerationMismatch,
      webSocketFactory: () => socket as never,
    });
    const observed = c
      .openPassiveStream(ID, TOKEN, {
        ...scopedContext(),
        signal: controller.signal,
      })
      .catch(error => {
        order.push("reject");
        throw error;
      });
    socket.emit(
      "unexpected-response",
      {},
      jsonResponse(409, {
        version: 1,
        category: "control_generation_mismatch",
        message: "stale generation",
      }),
    );
    controller.abort(new Error("caller aborted"));

    await expect(observed).rejects.toMatchObject({
      category: "control_generation_mismatch",
    });
    expect(order).toEqual(["callback", "reject"]);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it.each(["WHATWG", "Node"] as const)(
    "decodes a buffered %s mismatch before deadline cancellation",
    async responseKind => {
      class FakeSocket extends EventEmitter {
        close = vi.fn();
        terminate = vi.fn();
      }
      const socket = new FakeSocket();
      const deadlineController = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(deadlineController.signal);
      const order: string[] = [];
      onControlGenerationMismatch.mockImplementation(() => {
        order.push("callback");
      });
      const errorBody = JSON.stringify({
        version: 1,
        category: "control_generation_mismatch",
        message: "stale generation",
      });
      const response =
        responseKind === "WHATWG"
          ? new Response(errorBody, {
              status: 409,
              headers: { "content-type": "application/json" },
            })
          : Object.assign(Readable.from([errorBody]), {
              statusCode: 409,
              headers: { "content-type": "application/json" },
            });
      try {
        const c = new BrowserServiceClient({
          baseUrl: "http://browser-service:3010",
          apiKey: "secret".repeat(6),
          requestTimeoutMs: 30_000,
          reconciliationTimeoutMs: 60_000,
          fetch: fetchMock,
          onControlGenerationMismatch,
          webSocketFactory: () => socket as never,
        });
        const observed = c
          .openPassiveStream(ID, TOKEN, scopedContext())
          .catch(error => {
            order.push("reject");
            throw error;
          });
        socket.emit("unexpected-response", {}, response);
        deadlineController.abort(new Error("deadline elapsed"));

        await expect(observed).rejects.toMatchObject({
          category: "control_generation_mismatch",
        });
        expect(order).toEqual(["callback", "reject"]);
        expect(socket.terminate).toHaveBeenCalledOnce();
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("cancels a stalled WHATWG upgrade body on caller abort", async () => {
    class FakeSocket extends EventEmitter {
      close = vi.fn();
      terminate = vi.fn();
    }
    const socket = new FakeSocket();
    const cancel = vi.fn();
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => undefined);
        },
        cancel,
      }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    );
    const c = new BrowserServiceClient({
      baseUrl: "http://browser-service:3010",
      apiKey: "secret".repeat(6),
      requestTimeoutMs: 30_000,
      reconciliationTimeoutMs: 60_000,
      fetch: fetchMock,
      onControlGenerationMismatch,
      webSocketFactory: () => socket as never,
    });
    const opening = c.openPassiveStream(ID, TOKEN, {
      ...scopedContext(),
      signal: controller.signal,
    });
    socket.emit("unexpected-response", {}, response);
    controller.abort(new Error("caller aborted"));

    await expect(opening).rejects.toMatchObject({
      category: "browser_service_unavailable",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("destroys a stalled Node upgrade body at the request deadline", async () => {
    class FakeSocket extends EventEmitter {
      close = vi.fn();
      terminate = vi.fn();
    }
    const socket = new FakeSocket();
    const response = Object.assign(
      new Readable({
        read() {
          // Remain stalled until the client deadline destroys the response.
        },
      }),
      {
        statusCode: 409,
        headers: { "content-type": "application/json" },
      },
    );
    const c = new BrowserServiceClient({
      baseUrl: "http://browser-service:3010",
      apiKey: "secret".repeat(6),
      requestTimeoutMs: 20,
      reconciliationTimeoutMs: 60_000,
      fetch: fetchMock,
      onControlGenerationMismatch,
      webSocketFactory: () => socket as never,
    });
    const opening = c.openPassiveStream(ID, TOKEN, scopedContext());
    socket.emit("unexpected-response", {}, response);

    await expect(opening).rejects.toMatchObject({
      category: "browser_service_unavailable",
    });
    expect(response.destroyed).toBe(true);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("sanitizes synchronous WebSocket factory failures", () => {
    const c = new BrowserServiceClient({
      baseUrl: "http://browser-service:3010",
      apiKey: "secret".repeat(6),
      requestTimeoutMs: 30_000,
      reconciliationTimeoutMs: 60_000,
      fetch: fetchMock,
      onControlGenerationMismatch,
      webSocketFactory: () => {
        throw new Error(
          "dial http://browser-service:3010?authorization=private",
        );
      },
    });
    let error: unknown;
    try {
      c.openPassiveStream(ID, TOKEN, scopedContext());
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      category: "browser_service_unavailable",
      message: "Browser Service is unavailable",
    });
    expect(String(error)).not.toContain("browser-service:3010");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
