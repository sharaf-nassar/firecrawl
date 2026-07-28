import { EventEmitter, once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

import express from "express";
import expressWs from "express-ws";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  BROWSER_RELAY_LIMITS,
  BROWSER_RELAY_READY_FRAME,
  browserActionErrorStatus,
  createBrowserRunsInternalRouter,
} from "./browser-runs";
import { BROWSER_RELAY_WS_OPTIONS } from "../../lib/browser-runtime/relay-limits";

const ID = (tail: number) =>
  `10000000-0000-4000-8000-${tail.toString().padStart(12, "0")}`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeUpstream extends EventEmitter {
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSED = WebSocket.CLOSED;
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;

  send() {}

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }
}

function fixture() {
  const inspectBinding = vi.fn();
  const gate = {
    withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
      operation({
        binding: {
          processNonce: "p",
          controlGenerationNonce: "g",
        },
      }),
    ),
  };
  const authority = {
    runId: ID(1),
    ownerId: ID(2),
    sessionId: ID(3),
    runtimeSessionId: ID(4),
    expectedSessionVersion: 1,
    adapterJobId: ID(5),
    adapterSupervisorId: ID(6),
    adapterProcessId: 42,
    deadline: new Date(Date.now() + 60_000),
    perOperationTimeoutMs: 30_000,
    zeroDataRetention: false as const,
  };
  const app = expressWs(express()).app;
  app.use(
    createBrowserRunsInternalRouter({
      getRuntime: () =>
        ({
          gate,
          browserClient: {},
        }) as never,
      readAdapterToken: async () => "x".repeat(32),
      getAuthority: vi.fn().mockResolvedValue(authority),
      inspectBinding,
    }),
  );
  return { app, authority, inspectBinding };
}

describe("internal browser run callbacks", () => {
  it("derives global WebSocket maxPayload from the shared relay frame limit", () => {
    expect(BROWSER_RELAY_WS_OPTIONS.maxPayload).toBe(
      BROWSER_RELAY_LIMITS.frameBytes,
    );
    expect(BROWSER_RELAY_WS_OPTIONS.maxPayload).toBe(24 * 1024 * 1024);
  });

  it("maps action cap and concurrency conflicts without collapsing them", () => {
    expect(browserActionErrorStatus("action_limit_exceeded")).toBe(429);
    expect(browserActionErrorStatus("duplicate_side_effect")).toBe(409);
    expect(browserActionErrorStatus("action_in_flight")).toBe(409);
    expect(browserActionErrorStatus("adapter_protocol_error")).toBe(502);
  });

  it("closes admission before acknowledging an authenticated drain", async () => {
    const drained = deferred<void>();
    let admitting = true;
    const app = expressWs(express()).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          admitting
            ? ({
                gate: {
                  withBrowserStateMutationLease: vi.fn(),
                },
                browserClient: {},
              } as never)
            : undefined,
        readAdapterToken: async () => "x".repeat(32),
        drainRuntime: async () => {
          admitting = false;
          await drained.promise;
        },
      }),
    );

    const drainRequest = request(app)
      .post("/internal/browser-runtime/drain")
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .then(response => response);
    await vi.waitFor(() => expect(admitting).toBe(false));
    const rejected = await request(app)
      .post(`/internal/browser-runs/${ID(1)}/actions`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", ID(2))
      .set("x-firecrawl-adapter-supervisor-id", ID(3))
      .set("x-firecrawl-adapter-process-id", "42")
      .send({});
    expect(rejected.status).toBe(503);
    expect(rejected.body.error).toBe("browser_state_unavailable");

    drained.resolve();
    await expect(drainRequest).resolves.toMatchObject({
      status: 200,
      body: { version: 1, status: "drained" },
    });
  });

  it("rejects unauthenticated or nonempty drain controls", async () => {
    const drained = vi.fn(async () => undefined);
    const app = expressWs(express()).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () => undefined,
        readAdapterToken: async () => "x".repeat(32),
        drainRuntime: drained,
      }),
    );
    const unauthorized = await request(app).post(
      "/internal/browser-runtime/drain",
    );
    expect(unauthorized.status).toBe(403);
    const nonempty = await request(app)
      .post("/internal/browser-runtime/drain")
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .send({ unexpected: true });
    expect(nonempty.status).toBe(400);
    expect(drained).not.toHaveBeenCalled();
  });

  it.each([
    { authorization: "Bearer wrong" },
    { authorization: `Bearer ${"x".repeat(32)}`, job: ID(9) },
    { authorization: `Bearer ${"x".repeat(32)}`, supervisor: ID(9) },
    { authorization: `Bearer ${"x".repeat(32)}`, process: "99" },
  ])("rejects stale adapter bindings before action parsing", async input => {
    const { app, authority } = fixture();
    const response = await request(app)
      .post(`/internal/browser-runs/${authority.runId}/actions`)
      .set("authorization", input.authorization)
      .set("x-firecrawl-adapter-job-id", input.job ?? authority.adapterJobId)
      .set(
        "x-firecrawl-adapter-supervisor-id",
        input.supervisor ?? authority.adapterSupervisorId,
      )
      .set(
        "x-firecrawl-adapter-process-id",
        input.process ?? String(authority.adapterProcessId),
      )
      .send({ malformed: true });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("capability_denied");
  });

  it.each([
    {
      name: "duplicate authorization",
      headers: {
        authorization: [`Bearer ${"x".repeat(32)}`, `Bearer ${"x".repeat(32)}`],
      },
    },
    {
      name: "authorization casing",
      headers: { Authorization: `Bearer ${"x".repeat(32)}` },
    },
    {
      name: "authorization whitespace",
      headers: { authorization: `Bearer  ${"x".repeat(32)}` },
    },
    {
      name: "duplicate process identity",
      headers: {
        authorization: `Bearer ${"x".repeat(32)}`,
        "x-firecrawl-adapter-process-id": ["42", "42"],
      },
    },
  ])("rejects $name from raw singleton headers", async input => {
    const { app, authority, inspectBinding } = fixture();
    const response = await request(app)
      .post(`/internal/browser-runs/${authority.runId}/actions`)
      .set(input.headers as never)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set(
        "x-firecrawl-adapter-process-id",
        input.headers["x-firecrawl-adapter-process-id"] === undefined
          ? String(authority.adapterProcessId)
          : (input.headers["x-firecrawl-adapter-process-id"] as never),
      )
      .send({ malformed: true });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("capability_denied");
    expect(inspectBinding).not.toHaveBeenCalled();
  });

  it("mounts authenticated artifact callback fail closed", async () => {
    const { app, authority } = fixture();
    const response = await request(app)
      .post(`/internal/browser-runs/${authority.runId}/artifacts`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set(
        "x-firecrawl-adapter-process-id",
        String(authority.adapterProcessId),
      );
    expect([400, 403, 503]).toContain(response.status);
  });

  it("streams one strictly bounded artifact after binding authentication", async () => {
    const { authority, inspectBinding } = fixture();
    const body = Buffer.from("verified artifact");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const ingest = vi.fn().mockResolvedValue({
      artifactId: ID(7),
      kind: "screenshot",
      contentType: "image/png",
      byteSize: body.byteLength,
      sha256,
    });
    const callbackApp = expressWs(express()).app;
    callbackApp.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate: {},
            browserClient: {},
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding,
        getArtifactStore: () => ({}) as never,
        createArtifactService: vi.fn(() => ({ ingest })) as never,
      }),
    );
    const response = await request(callbackApp)
      .post(`/internal/browser-runs/${authority.runId}/artifacts`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set("x-firecrawl-adapter-process-id", String(authority.adapterProcessId))
      .set("x-firecrawl-artifact-id", ID(7))
      .set("x-firecrawl-artifact-kind", "screenshot")
      .set("x-firecrawl-artifact-content-type", "image/png")
      .set("x-firecrawl-artifact-byte-size", String(body.byteLength))
      .set("x-firecrawl-artifact-sha256", sha256)
      .set("content-length", String(body.byteLength))
      .send(body);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      version: 1,
      artifactId: ID(7),
      kind: "screenshot",
      contentType: "image/png",
      byteSize: body.byteLength,
      sha256,
    });
    expect(inspectBinding).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(
      authority,
      expect.objectContaining({ sha256, byteSize: body.byteLength }),
      body,
      expect.any(AbortSignal),
    );
  });

  it("rejects explicit ZDR authority before artifact ingestion", async () => {
    const { authority, inspectBinding } = fixture();
    const ingest = vi.fn();
    const callbackApp = expressWs(express()).app;
    callbackApp.use(
      createBrowserRunsInternalRouter({
        getRuntime: () => ({ gate: {}, browserClient: {} }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi
          .fn()
          .mockResolvedValue({ ...authority, zeroDataRetention: true }),
        inspectBinding,
        getArtifactStore: () => ({}) as never,
        createArtifactService: vi.fn(() => ({ ingest })) as never,
      }),
    );
    const response = await request(callbackApp)
      .post(`/internal/browser-runs/${authority.runId}/artifacts`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set("x-firecrawl-adapter-process-id", String(authority.adapterProcessId))
      .send(Buffer.from("must not stream"));
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("capability_denied");
    expect(inspectBinding).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("aborts artifact ingestion at the per-operation deadline", async () => {
    const { authority, inspectBinding } = fixture();
    const ingest = vi.fn(
      async (
        _authority: unknown,
        _headers: unknown,
        _body: unknown,
        signal: AbortSignal,
      ) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("interrupted"), {
                  category: "artifact_upload_interrupted",
                }),
              ),
            { once: true },
          );
        }),
    );
    const callbackApp = expressWs(express()).app;
    callbackApp.use(
      createBrowserRunsInternalRouter({
        getRuntime: () => ({ gate: {}, browserClient: {} }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi
          .fn()
          .mockResolvedValue({ ...authority, perOperationTimeoutMs: 20 }),
        inspectBinding,
        getArtifactStore: () => ({}) as never,
        createArtifactService: vi.fn(() => ({ ingest })) as never,
      }),
    );
    const body = Buffer.from("deadline artifact");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const response = await request(callbackApp)
      .post(`/internal/browser-runs/${authority.runId}/artifacts`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set("x-firecrawl-adapter-process-id", String(authority.adapterProcessId))
      .set("x-firecrawl-artifact-id", ID(7))
      .set("x-firecrawl-artifact-kind", "screenshot")
      .set("x-firecrawl-artifact-content-type", "image/png")
      .set("x-firecrawl-artifact-byte-size", String(body.byteLength))
      .set("x-firecrawl-artifact-sha256", sha256)
      .set("content-length", String(body.byteLength))
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("artifact_upload_interrupted");
  });

  it("aborts after the body when the response socket disconnects", async () => {
    const { authority, inspectBinding } = fixture();
    let observedSignal!: AbortSignal;
    let ingestStarted!: () => void;
    const started = new Promise<void>(resolve => {
      ingestStarted = resolve;
    });
    const ingest = vi.fn(
      async (
        _authority: unknown,
        _headers: unknown,
        _body: unknown,
        signal: AbortSignal,
      ) => {
        observedSignal = signal;
        ingestStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("disconnected"), {
                  category: "artifact_upload_interrupted",
                }),
              ),
            { once: true },
          );
        });
      },
    );
    const callbackApp = expressWs(express()).app;
    callbackApp.use(
      createBrowserRunsInternalRouter({
        getRuntime: () => ({ gate: {}, browserClient: {} }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding,
        getArtifactStore: () => ({}) as never,
        createArtifactService: vi.fn(() => ({ ingest })) as never,
      }),
    );
    const server = callbackApp.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const body = Buffer.from("disconnect artifact");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/internal/browser-runs/${authority.runId}/artifacts`,
      headers: {
        authorization: `Bearer ${"x".repeat(32)}`,
        "x-firecrawl-adapter-job-id": authority.adapterJobId,
        "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
        "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        "x-firecrawl-artifact-id": ID(7),
        "x-firecrawl-artifact-kind": "screenshot",
        "x-firecrawl-artifact-content-type": "image/png",
        "x-firecrawl-artifact-byte-size": String(body.byteLength),
        "x-firecrawl-artifact-sha256": sha256,
        "content-length": String(body.byteLength),
      },
    });
    client.on("error", () => undefined);
    client.end(body);
    try {
      await started;
      client.destroy();
      await vi.waitFor(() => expect(observedSignal.aborted).toBe(true));
    } finally {
      client.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects unknown artifact headers without invoking ingestion", async () => {
    const { authority, inspectBinding } = fixture();
    const ingest = vi.fn();
    const callbackApp = expressWs(express()).app;
    callbackApp.use(
      createBrowserRunsInternalRouter({
        getRuntime: () => ({ gate: {}, browserClient: {} }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding,
        getArtifactStore: () => ({}) as never,
        createArtifactService: vi.fn(() => ({ ingest })) as never,
      }),
    );
    const response = await request(callbackApp)
      .post(`/internal/browser-runs/${authority.runId}/artifacts`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set("x-firecrawl-adapter-process-id", String(authority.adapterProcessId))
      .set("x-firecrawl-artifact-extra", "forbidden")
      .send(Buffer.from("x"));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("artifact_invalid_headers");
    expect(inspectBinding).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("sanitizes malformed JSON after authenticating the binding", async () => {
    const { app, authority, inspectBinding } = fixture();
    const response = await request(app)
      .post(`/internal/browser-runs/${authority.runId}/actions`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set("x-firecrawl-adapter-process-id", String(authority.adapterProcessId))
      .set("content-type", "application/json")
      .send('{"version":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "model_protocol_error",
      message: "Browser action proposal is invalid",
    });
    expect(inspectBinding).toHaveBeenCalledTimes(1);
  });

  it("returns a sanitized 413 for oversized callback JSON", async () => {
    const { app, authority, inspectBinding } = fixture();
    const response = await request(app)
      .post(`/internal/browser-runs/${authority.runId}/actions`)
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
      .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
      .set("x-firecrawl-adapter-process-id", String(authority.adapterProcessId))
      .set("content-type", "application/json")
      .send(JSON.stringify({ value: "x".repeat(129 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      success: false,
      error: "model_protocol_error",
      message: "Browser action proposal exceeds its bound",
    });
    expect(inspectBinding).toHaveBeenCalledTimes(1);
  });

  it("awaits writer release and revokes a successful CDP grant", async () => {
    const upstream = new FakeUpstream();
    const events: string[] = [];
    let acknowledgeWriterRelease!: () => void;
    const writerRelease = new Promise<void>(resolve => {
      acknowledgeWriterRelease = resolve;
    });
    const binding = {
      apiInstanceId: ID(20),
      databaseControlEpoch: 1,
      processNonce: "a".repeat(43),
      controlGenerationNonce: "b".repeat(43),
      snapshotDigest: "c".repeat(64),
    };
    const createRelayGrant = vi.fn(async () => {
      events.push("grant");
      return { relayToken: "r".repeat(43) };
    });
    const openCdpStream = vi.fn(async () => {
      events.push("open");
      return upstream;
    });
    const revokeRelayGrant = vi.fn(async () => {
      events.push("revoke:start");
      await writerRelease;
      events.push("revoke:released");
    });
    let currentBinding = binding;
    const gate = {
      assertOpen: vi.fn(() => currentBinding),
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) => {
        events.push("lease:start");
        try {
          return await operation({ binding });
        } finally {
          events.push("lease:end");
        }
      }),
    };
    const authority = {
      runId: ID(1),
      ownerId: ID(2),
      sessionId: ID(3),
      runtimeSessionId: ID(4),
      expectedSessionVersion: 1,
      adapterJobId: ID(5),
      adapterSupervisorId: ID(6),
      adapterProcessId: 42,
      deadline: new Date(Date.now() + 60_000),
      perOperationTimeoutMs: 30_000,
      zeroDataRetention: false as const,
    };
    const app = expressWs(express(), undefined, {
      wsOptions: { ...BROWSER_RELAY_WS_OPTIONS },
    }).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate,
            browserClient: {
              createRelayGrant,
              openCdpStream,
              revokeRelayGrant,
            },
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding: vi.fn(),
        redeemCdpWithLease: vi.fn(),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
      {
        headers: {
          authorization: `Bearer ${"x".repeat(32)}`,
          "x-firecrawl-adapter-job-id": authority.adapterJobId,
          "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
          "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        },
      },
    );
    try {
      await once(socket, "open");
      await vi.waitFor(() => expect(openCdpStream).toHaveBeenCalledTimes(1));
      const closed = once(socket, "close");
      socket.close();
      await closed;
      await vi.waitFor(() => expect(revokeRelayGrant).toHaveBeenCalledTimes(1));
      expect(upstream.readyState).toBe(WebSocket.CLOSED);
      expect(events).toEqual([
        "lease:start",
        "grant",
        "open",
        "lease:end",
        "lease:start",
        "revoke:start",
      ]);
      const release = request(server)
        .post(`/internal/browser-runs/${authority.runId}/cdp/released`)
        .set("authorization", `Bearer ${"x".repeat(32)}`)
        .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
        .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
        .set(
          "x-firecrawl-adapter-process-id",
          String(authority.adapterProcessId),
        )
        .send();
      acknowledgeWriterRelease();
      expect((await release).status).toBe(204);
      const retry = await request(server)
        .post(`/internal/browser-runs/${authority.runId}/cdp/released`)
        .set("authorization", `Bearer ${"x".repeat(32)}`)
        .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
        .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
        .set(
          "x-firecrawl-adapter-process-id",
          String(authority.adapterProcessId),
        )
        .send();
      expect(retry.status).toBe(204);
      const wrongBinding = await request(server)
        .post(`/internal/browser-runs/${authority.runId}/cdp/released`)
        .set("authorization", `Bearer ${"x".repeat(32)}`)
        .set("x-firecrawl-adapter-job-id", ID(99))
        .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
        .set(
          "x-firecrawl-adapter-process-id",
          String(authority.adapterProcessId),
        )
        .send();
      expect(wrongBinding.status).toBe(403);
      currentBinding = {
        ...binding,
        databaseControlEpoch: binding.databaseControlEpoch + 1,
      };
      const staleGeneration = await request(server)
        .post(`/internal/browser-runs/${authority.runId}/cdp/released`)
        .set("authorization", `Bearer ${"x".repeat(32)}`)
        .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
        .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
        .set(
          "x-firecrawl-adapter-process-id",
          String(authority.adapterProcessId),
        )
        .send();
      expect(staleGeneration.status).toBe(409);
      await vi.waitFor(() => expect(events).toContain("revoke:released"));
      expect(revokeRelayGrant).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toBe("lease:end");
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("emits relay ready only after lease redemption and upstream opening", async () => {
    const upstream = new FakeUpstream();
    const leaseAllowed = deferred<void>();
    const upstreamOpened = deferred<FakeUpstream>();
    const binding = {
      apiInstanceId: ID(20),
      databaseControlEpoch: 1,
      processNonce: "a".repeat(43),
      controlGenerationNonce: "b".repeat(43),
      snapshotDigest: "c".repeat(64),
    };
    const redeemCdpWithLease = vi.fn();
    const createRelayGrant = vi.fn(async () => ({
      relayToken: "r".repeat(43),
    }));
    const openCdpStream = vi.fn(() => upstreamOpened.promise);
    const revokeRelayGrant = vi.fn();
    const gate = {
      assertOpen: vi.fn(() => binding),
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) => {
        await leaseAllowed.promise;
        return operation({ binding });
      }),
    };
    const authority = {
      runId: ID(1),
      ownerId: ID(2),
      sessionId: ID(3),
      runtimeSessionId: ID(4),
      expectedSessionVersion: 1,
      adapterJobId: ID(5),
      adapterSupervisorId: ID(6),
      adapterProcessId: 42,
      deadline: new Date(Date.now() + 60_000),
      perOperationTimeoutMs: 30_000,
      zeroDataRetention: false as const,
    };
    const app = expressWs(express(), undefined, {
      wsOptions: { ...BROWSER_RELAY_WS_OPTIONS },
    }).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate,
            browserClient: {
              createRelayGrant,
              openCdpStream,
              revokeRelayGrant,
            },
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding: vi.fn(),
        redeemCdpWithLease,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
      {
        headers: {
          authorization: `Bearer ${"x".repeat(32)}`,
          "x-firecrawl-adapter-job-id": authority.adapterJobId,
          "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
          "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        },
      },
    );
    const messages: Array<{ data: string; isBinary: boolean }> = [];
    socket.on("message", (data, isBinary) => {
      messages.push({ data: data.toString(), isBinary });
    });
    try {
      await once(socket, "open");
      expect(messages).toEqual([]);
      expect(redeemCdpWithLease).not.toHaveBeenCalled();
      expect(createRelayGrant).not.toHaveBeenCalled();
      expect(openCdpStream).not.toHaveBeenCalled();

      leaseAllowed.resolve();
      await vi.waitFor(() => expect(openCdpStream).toHaveBeenCalledOnce());
      expect(redeemCdpWithLease).toHaveBeenCalledOnce();
      expect(createRelayGrant).toHaveBeenCalledOnce();
      expect(messages).toEqual([]);

      const ready = once(socket, "message");
      upstreamOpened.resolve(upstream);
      const [data, isBinary] = await ready;
      expect(isBinary).toBe(false);
      expect(data.toString()).toBe(BROWSER_RELAY_READY_FRAME);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(messages).toEqual([
        { data: BROWSER_RELAY_READY_FRAME, isBinary: false },
      ]);
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("fails closed when relay setup lease commit is ambiguous", async () => {
    const upstream = new FakeUpstream();
    const binding = {
      apiInstanceId: ID(20),
      databaseControlEpoch: 1,
      processNonce: "a".repeat(43),
      controlGenerationNonce: "b".repeat(43),
      snapshotDigest: "c".repeat(64),
    };
    const close = vi.fn();
    const redeemCdpWithLease = vi.fn();
    const createRelayGrant = vi.fn(async () => ({
      relayToken: "r".repeat(43),
    }));
    const openCdpStream = vi.fn(async () => upstream);
    const revokeRelayGrant = vi.fn();
    const gate = {
      assertOpen: vi.fn(() => binding),
      close,
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) => {
        await operation({ binding });
        throw new Error("lease commit outcome unknown");
      }),
    };
    const authority = {
      runId: ID(1),
      ownerId: ID(2),
      sessionId: ID(3),
      runtimeSessionId: ID(4),
      expectedSessionVersion: 1,
      adapterJobId: ID(5),
      adapterSupervisorId: ID(6),
      adapterProcessId: 42,
      deadline: new Date(Date.now() + 60_000),
      perOperationTimeoutMs: 30_000,
      zeroDataRetention: false as const,
    };
    const app = expressWs(express(), undefined, {
      wsOptions: { ...BROWSER_RELAY_WS_OPTIONS },
    }).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate,
            browserClient: {
              createRelayGrant,
              openCdpStream,
              revokeRelayGrant,
            },
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding: vi.fn(),
        redeemCdpWithLease,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
      {
        headers: {
          authorization: `Bearer ${"x".repeat(32)}`,
          "x-firecrawl-adapter-job-id": authority.adapterJobId,
          "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
          "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        },
      },
    );
    const messages: string[] = [];
    socket.on("message", data => messages.push(data.toString()));
    socket.on("error", () => undefined);
    try {
      await once(socket, "close");
      expect(redeemCdpWithLease).toHaveBeenCalledOnce();
      expect(createRelayGrant).toHaveBeenCalledOnce();
      expect(openCdpStream).toHaveBeenCalledOnce();
      expect(messages).toEqual([]);
      expect(upstream.readyState).toBe(WebSocket.CLOSED);
      expect(revokeRelayGrant).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith("cdp_relay_cleanup_failed");

      const release = await request(server)
        .post(`/internal/browser-runs/${authority.runId}/cdp/released`)
        .set("authorization", `Bearer ${"x".repeat(32)}`)
        .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
        .set("x-firecrawl-adapter-supervisor-id", authority.adapterSupervisorId)
        .set(
          "x-firecrawl-adapter-process-id",
          String(authority.adapterProcessId),
        )
        .send();
      expect(release.status).toBe(503);
      expect(release.body.error).toBe("browser_unavailable");
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("does not emit relay ready when upstream opening fails", async () => {
    const binding = {
      apiInstanceId: ID(20),
      databaseControlEpoch: 1,
      processNonce: "a".repeat(43),
      controlGenerationNonce: "b".repeat(43),
      snapshotDigest: "c".repeat(64),
    };
    const revokeRelayGrant = vi.fn();
    const gate = {
      assertOpen: vi.fn(() => binding),
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
        operation({ binding }),
      ),
    };
    const authority = {
      runId: ID(1),
      ownerId: ID(2),
      sessionId: ID(3),
      runtimeSessionId: ID(4),
      expectedSessionVersion: 1,
      adapterJobId: ID(5),
      adapterSupervisorId: ID(6),
      adapterProcessId: 42,
      deadline: new Date(Date.now() + 60_000),
      perOperationTimeoutMs: 30_000,
      zeroDataRetention: false as const,
    };
    const app = expressWs(express(), undefined, {
      wsOptions: { ...BROWSER_RELAY_WS_OPTIONS },
    }).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate,
            browserClient: {
              createRelayGrant: vi.fn(async () => ({
                relayToken: "r".repeat(43),
              })),
              openCdpStream: vi.fn(async () => {
                throw new Error("upstream unavailable");
              }),
              revokeRelayGrant,
            },
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding: vi.fn(),
        redeemCdpWithLease: vi.fn(),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
      {
        headers: {
          authorization: `Bearer ${"x".repeat(32)}`,
          "x-firecrawl-adapter-job-id": authority.adapterJobId,
          "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
          "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        },
      },
    );
    const messages: string[] = [];
    socket.on("message", data => messages.push(data.toString()));
    socket.on("error", () => undefined);
    try {
      await once(socket, "close");
      expect(messages).toEqual([]);
      expect(revokeRelayGrant).toHaveBeenCalledOnce();
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([
    ["upstream frame overflow", "upstream", 1009],
    ["downstream frame overflow", "downstream", 1009],
    ["upstream backpressure", "backpressure", 1009],
    ["near-cap incoming frame", "near-cap", 1009],
    ["duplicate request ID", "duplicate-id", 1008],
    ["too many outstanding request IDs", "outstanding-ids", 1008],
    ["unknown response ID", "unknown-id", 1008],
    ["relay deadline", "deadline", 1008],
  ] as const)("fails closed on %s", async (_name, failure, expectedCode) => {
    const upstream = new FakeUpstream();
    const binding = {
      apiInstanceId: ID(20),
      databaseControlEpoch: 1,
      processNonce: "a".repeat(43),
      controlGenerationNonce: "b".repeat(43),
      snapshotDigest: "c".repeat(64),
    };
    const revokeRelayGrant = vi.fn();
    const close = vi.fn();
    const gate = {
      assertOpen: vi.fn(() => binding),
      close,
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
        operation({ binding }),
      ),
    };
    const authority = {
      runId: ID(1),
      ownerId: ID(2),
      sessionId: ID(3),
      runtimeSessionId: ID(4),
      expectedSessionVersion: 1,
      adapterJobId: ID(5),
      adapterSupervisorId: ID(6),
      adapterProcessId: 42,
      deadline: new Date(Date.now() + (failure === "deadline" ? 250 : 60_000)),
      perOperationTimeoutMs: 30_000,
      zeroDataRetention: false as const,
    };
    const app = expressWs(express(), undefined, {
      wsOptions: { ...BROWSER_RELAY_WS_OPTIONS },
    }).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate,
            browserClient: {
              createRelayGrant: vi.fn(async () => ({
                relayToken: "r".repeat(43),
              })),
              openCdpStream: vi.fn(async () => upstream),
              revokeRelayGrant,
            },
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding: vi.fn(),
        redeemCdpWithLease: vi.fn(),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
      {
        headers: {
          authorization: `Bearer ${"x".repeat(32)}`,
          "x-firecrawl-adapter-job-id": authority.adapterJobId,
          "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
          "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        },
      },
    );
    try {
      await once(socket, "open");
      const closed = once(socket, "close");
      if (failure === "upstream") {
        upstream.emit(
          "message",
          Buffer.alloc(BROWSER_RELAY_LIMITS.frameBytes + 1),
        );
      } else if (failure === "downstream") {
        socket.send(Buffer.alloc(BROWSER_RELAY_LIMITS.frameBytes + 1));
      } else if (failure === "backpressure") {
        upstream.bufferedAmount = BROWSER_RELAY_LIMITS.queueBytes + 1;
        socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      } else if (failure === "near-cap") {
        upstream.bufferedAmount = BROWSER_RELAY_LIMITS.queueBytes - 8;
        socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      } else if (failure === "duplicate-id") {
        socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
        socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      } else if (failure === "outstanding-ids") {
        for (
          let id = 1;
          id <= BROWSER_RELAY_LIMITS.outstandingIds + 1;
          id += 1
        ) {
          socket.send(JSON.stringify({ id, method: "Runtime.enable" }));
        }
      } else if (failure === "unknown-id") {
        upstream.emit(
          "message",
          Buffer.from(JSON.stringify({ id: 999, result: {} })),
          false,
        );
      }
      const [code] = await closed;
      expect(code).toBe(expectedCode);
      await vi.waitFor(() => expect(revokeRelayGrant).toHaveBeenCalledOnce());
      expect(close).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("closes mutation authority when CDP grant revocation fails", async () => {
    const upstream = new FakeUpstream();
    const binding = {
      apiInstanceId: ID(20),
      databaseControlEpoch: 1,
      processNonce: "a".repeat(43),
      controlGenerationNonce: "b".repeat(43),
      snapshotDigest: "c".repeat(64),
    };
    const close = vi.fn();
    const gate = {
      assertOpen: vi.fn(() => binding),
      close,
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
        operation({ binding }),
      ),
    };
    const authority = {
      runId: ID(1),
      ownerId: ID(2),
      sessionId: ID(3),
      runtimeSessionId: ID(4),
      expectedSessionVersion: 1,
      adapterJobId: ID(5),
      adapterSupervisorId: ID(6),
      adapterProcessId: 42,
      deadline: new Date(Date.now() + 60_000),
      perOperationTimeoutMs: 30_000,
      zeroDataRetention: false as const,
    };
    const app = expressWs(express()).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate,
            browserClient: {
              createRelayGrant: vi.fn(async () => ({
                relayToken: "r".repeat(43),
              })),
              openCdpStream: vi.fn(async () => upstream),
              revokeRelayGrant: vi.fn(async () => {
                throw new Error("unavailable");
              }),
            },
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding: vi.fn(),
        redeemCdpWithLease: vi.fn(),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
      {
        headers: {
          authorization: `Bearer ${"x".repeat(32)}`,
          "x-firecrawl-adapter-job-id": authority.adapterJobId,
          "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
          "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        },
      },
    );
    try {
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.close();
      await closed;
      await vi.waitFor(() =>
        expect(close).toHaveBeenCalledWith("cdp_relay_cleanup_failed"),
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const release = await request(server)
          .post(`/internal/browser-runs/${authority.runId}/cdp/released`)
          .set("authorization", `Bearer ${"x".repeat(32)}`)
          .set("x-firecrawl-adapter-job-id", authority.adapterJobId)
          .set(
            "x-firecrawl-adapter-supervisor-id",
            authority.adapterSupervisorId,
          )
          .set(
            "x-firecrawl-adapter-process-id",
            String(authority.adapterProcessId),
          )
          .send();
        expect(release.status).toBe(503);
        expect(release.body.error).toBe("browser_unavailable");
      }
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([
    { failure: "lost response", revokeFails: false },
    { failure: "invalid response", revokeFails: false },
    { failure: "lost response and cleanup failure", revokeFails: true },
  ])(
    "revokes the deterministic grant after a $failure from create",
    async ({ failure, revokeFails }) => {
      const binding = {
        apiInstanceId: ID(20),
        databaseControlEpoch: 1,
        processNonce: "a".repeat(43),
        controlGenerationNonce: "b".repeat(43),
        snapshotDigest: "c".repeat(64),
      };
      let requestedGrantId: string | undefined;
      const createRelayGrant = vi.fn(
        async (_runtimeSessionId: string, input: { grantId: string }) => {
          requestedGrantId = input.grantId;
          throw new Error(failure);
        },
      );
      const revokeRelayGrant = vi.fn(async () => {
        if (revokeFails) throw new Error("cleanup unavailable");
      });
      const openCdpStream = vi.fn();
      const close = vi.fn();
      const gate = {
        assertOpen: vi.fn(() => binding),
        close,
        withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
          operation({ binding }),
        ),
      };
      const authority = {
        runId: ID(1),
        ownerId: ID(2),
        sessionId: ID(3),
        runtimeSessionId: ID(4),
        expectedSessionVersion: 1,
        adapterJobId: ID(5),
        adapterSupervisorId: ID(6),
        adapterProcessId: 42,
        deadline: new Date(Date.now() + 60_000),
        perOperationTimeoutMs: 30_000,
        zeroDataRetention: false as const,
      };
      const app = expressWs(express()).app;
      app.use(
        createBrowserRunsInternalRouter({
          getRuntime: () =>
            ({
              gate,
              browserClient: {
                createRelayGrant,
                openCdpStream,
                revokeRelayGrant,
              },
            }) as never,
          readAdapterToken: async () => "x".repeat(32),
          getAuthority: vi.fn().mockResolvedValue(authority),
          inspectBinding: vi.fn(),
          redeemCdpWithLease: vi.fn(),
        }),
      );
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = (server.address() as AddressInfo).port;
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
        {
          headers: {
            authorization: `Bearer ${"x".repeat(32)}`,
            "x-firecrawl-adapter-job-id": authority.adapterJobId,
            "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
            "x-firecrawl-adapter-process-id": String(
              authority.adapterProcessId,
            ),
          },
        },
      );
      socket.on("error", () => undefined);
      try {
        await new Promise<void>(resolve => {
          socket.once("close", () => resolve());
        });
        expect(requestedGrantId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(revokeRelayGrant).toHaveBeenCalledWith(
          authority.runtimeSessionId,
          requestedGrantId,
          { version: 1, grantId: requestedGrantId },
          expect.objectContaining({
            processNonce: binding.processNonce,
            controlGenerationNonce: binding.controlGenerationNonce,
          }),
        );
        expect(openCdpStream).not.toHaveBeenCalled();
        if (revokeFails) {
          expect(close).toHaveBeenCalledWith("cdp_relay_cleanup_failed");
        } else {
          expect(close).not.toHaveBeenCalled();
        }
      } finally {
        socket.terminate();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );

  it("revokes before release when the CDP gate recheck fails", async () => {
    const events: string[] = [];
    const binding = {
      apiInstanceId: ID(20),
      databaseControlEpoch: 1,
      processNonce: "a".repeat(43),
      controlGenerationNonce: "b".repeat(43),
      snapshotDigest: "c".repeat(64),
    };
    const createRelayGrant = vi.fn(async () => {
      events.push("grant");
      return { relayToken: "r".repeat(43) };
    });
    const openCdpStream = vi.fn();
    const revokeRelayGrant = vi.fn(async () => {
      events.push("revoke");
    });
    const gate = {
      assertOpen: vi
        .fn()
        .mockReturnValueOnce(binding)
        .mockImplementation(() => {
          throw new Error("gate closed");
        }),
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) => {
        events.push("lease:start");
        try {
          return await operation({ binding });
        } finally {
          events.push("lease:end");
        }
      }),
    };
    const authority = {
      runId: ID(1),
      ownerId: ID(2),
      sessionId: ID(3),
      runtimeSessionId: ID(4),
      expectedSessionVersion: 1,
      adapterJobId: ID(5),
      adapterSupervisorId: ID(6),
      adapterProcessId: 42,
      deadline: new Date(Date.now() + 60_000),
      perOperationTimeoutMs: 30_000,
      zeroDataRetention: false as const,
    };
    const app = expressWs(express()).app;
    app.use(
      createBrowserRunsInternalRouter({
        getRuntime: () =>
          ({
            gate,
            browserClient: {
              createRelayGrant,
              openCdpStream,
              revokeRelayGrant,
            },
          }) as never,
        readAdapterToken: async () => "x".repeat(32),
        getAuthority: vi.fn().mockResolvedValue(authority),
        inspectBinding: vi.fn(),
        redeemCdpWithLease: vi.fn(),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/internal/browser-runs/${authority.runId}/cdp`,
      {
        headers: {
          authorization: `Bearer ${"x".repeat(32)}`,
          "x-firecrawl-adapter-job-id": authority.adapterJobId,
          "x-firecrawl-adapter-supervisor-id": authority.adapterSupervisorId,
          "x-firecrawl-adapter-process-id": String(authority.adapterProcessId),
        },
      },
    );
    socket.on("error", () => undefined);
    try {
      const closed = once(socket, "close");
      await closed;
      expect(openCdpStream).not.toHaveBeenCalled();
      expect(revokeRelayGrant).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["lease:start", "grant", "revoke", "lease:end"]);
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
