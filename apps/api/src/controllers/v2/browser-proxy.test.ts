import { EventEmitter } from "node:events";
import type { Server } from "node:http";

import express, { type Request } from "express";
import expressWs from "express-ws";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  createBrowserProxyHandlers,
  registerBrowserProxyRuntime,
} from "./browser-proxy";

class FakeSocket extends EventEmitter {
  readonly OPEN = WebSocket.OPEN;
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly CLOSED = WebSocket.CLOSED;
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly send = vi.fn(
    (
      _data: unknown,
      optionsOrCallback?: { binary?: boolean } | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) => {
      const complete =
        typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      complete?.();
    },
  );
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly close = vi.fn((code?: number, reason?: string) => {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason ?? ""));
  });
  readonly terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
}

function setup(overrides: Record<string, unknown> = {}) {
  const upstream = new FakeSocket();
  let open = true;
  let active = 0;
  let drainResolve!: () => void;
  const drained = new Promise<void>(resolve => {
    drainResolve = resolve;
  });
  const binding = {
    apiInstanceId: "00000000-0000-4000-8000-000000000001",
    databaseControlEpoch: 1,
    processNonce: "p".repeat(43),
    controlGenerationNonce: "g".repeat(43),
    snapshotDigest: "a".repeat(64),
  };
  const transaction = {
    commitOutcome: Promise.resolve("committed" as const),
    query: vi.fn(async (text: string) => {
      if (text.includes("FROM browser_sessions")) {
        return {
          rows: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              owner_id: "00000000-0000-4000-8000-000000000003",
              browser_id: "00000000-0000-4000-8000-000000000004",
              runtime_epoch: 3,
              workspace_id: JSON.stringify(["example.com"]),
              absolute_deadline_at: new Date(Date.now() + 60_000),
              idle_deadline_at: new Date(Date.now() + 60_000),
            },
          ],
        };
      }
      return { rows: [] };
    }),
  };
  const gate = {
    assertOpen: vi.fn(() => {
      if (!open)
        throw Object.assign(new Error("closed"), {
          category: "browser_state_unavailable",
        });
      return binding;
    }),
    close: vi.fn(() => {
      open = false;
      if (active === 0) drainResolve();
      return { drained };
    }),
    withBrowserStateMutationLease: vi.fn(async (_scope, operation) => {
      if (!open)
        throw Object.assign(new Error("closed"), {
          category: "browser_state_unavailable",
        });
      active += 1;
      try {
        return await operation({
          binding,
          transaction,
          epoch: 1,
          scope: "filesystem_and_database",
        });
      } finally {
        active -= 1;
        if (active === 0 && !open) drainResolve();
      }
    }),
  };
  const grantStore = {
    redeemWithLease: vi.fn(async (_lease, _token, permission) =>
      permission === "passive"
        ? {
            id: "00000000-0000-4000-8000-000000000005",
            ownerId: "00000000-0000-4000-8000-000000000003",
            sessionId: "00000000-0000-4000-8000-000000000002",
            permission,
            useLimit: 1,
            uses: 1,
            issuedAt: new Date(),
            redeemedAt: new Date(),
            revokedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
          }
        : null,
    ),
  };
  const browserClient = {
    createRelayGrant: vi.fn(async () => ({
      relayToken: "r".repeat(43),
    })),
    revokeRelayGrant: vi.fn(async (_session, grantId) => ({ grantId })),
    openPassiveStream: vi.fn(async () => upstream),
    openInteractiveStream: vi.fn(async () => upstream),
    openCdpStream: vi.fn(async () => upstream),
  };
  const deps = {
    gate,
    grantStore,
    browserClient,
    publicApiOrigin: "http://127.0.0.1:3002",
    now: () => new Date(),
    commitOutcomeTimeoutMs: undefined as number | undefined,
    ...overrides,
  };
  return {
    deps,
    gate,
    grantStore,
    browserClient,
    upstream,
    transaction,
    binding,
  };
}

function rejectLeaseCommit(
  fixture: ReturnType<typeof setup>,
  commitOutcome: Promise<"committed" | "rolled_back" | "unknown">,
): void {
  fixture.gate.withBrowserStateMutationLease.mockImplementationOnce(
    async (_scope, operation) => {
      await operation({
        binding: fixture.binding,
        transaction: {
          ...fixture.transaction,
          commitOutcome,
        },
        epoch: 1,
        scope: "filesystem_and_database",
      });
      throw new Error("COMMIT acknowledgement failed");
    },
  );
}

function createApp() {
  const app = expressWs(express()).app;
  const handlers = createBrowserProxyHandlers();
  app.get("/v2/browser/proxy/view.js", handlers.script);
  app.get("/v2/browser/proxy/view.css", handlers.style);
  app.get("/v2/browser/proxy/:token/view", handlers.view);
  app.ws("/v2/browser/proxy/:token/:permission", handlers.relay);
  return app;
}

function openProxy(
  server: Server,
  token: string,
  permission: string,
  origin?: string,
) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return new Promise<{
    socket: WebSocket;
    close: Promise<{ code: number; reason: string }>;
  }>((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v2/browser/proxy/${token}/${permission}`,
      origin === undefined ? undefined : { origin },
    );
    const close = new Promise<{ code: number; reason: string }>(done => {
      socket.once("close", (code, reason) =>
        done({ code, reason: reason.toString() }),
      );
    });
    socket.once("open", () => resolve({ socket, close }));
    socket.once("error", reject);
  });
}

afterEach(() => registerBrowserProxyRuntime(undefined));

describe("browser proxy", () => {
  it("serves a fixed no-store viewer and assets", async () => {
    const app = createApp();
    const first = await request(app).get(
      `/v2/browser/proxy/${"t".repeat(43)}/view`,
    );
    const second = await request(app).get(
      `/v2/browser/proxy/${"u".repeat(43)}/view`,
    );
    expect(first.status).toBe(200);
    expect(first.text).toBe(second.text);
    expect(first.text).not.toContain("t".repeat(43));
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(first.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });

  it("separates permissions and requires configured origin for view streams", async () => {
    const fixture = setup();
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const wrong = await openProxy(
        server,
        "t".repeat(43),
        "interactive",
        "http://127.0.0.1:3002",
      );
      expect(await wrong.close).toMatchObject({ code: 1008 });
      expect(fixture.browserClient.createRelayGrant).not.toHaveBeenCalled();

      const missing = await openProxy(server, "t".repeat(43), "passive");
      expect(await missing.close).toMatchObject({ code: 1008 });
      expect(fixture.browserClient.createRelayGrant).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("does not call the private service when the startup gate is closed", async () => {
    const fixture = setup();
    registerBrowserProxyRuntime(fixture.deps as never);
    fixture.gate.close();
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      expect(await connection.close).toMatchObject({ code: 1013 });
      expect(fixture.browserClient.createRelayGrant).not.toHaveBeenCalled();
      expect(fixture.browserClient.openPassiveStream).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("revokes the exact private grant when the gate closes before handshake", async () => {
    let release!: () => void;
    const privateGrantCreated = new Promise<void>(resolve => {
      release = resolve;
    });
    const fixture = setup({
      browserClient: undefined,
    });
    fixture.deps.browserClient = fixture.browserClient;
    fixture.browserClient.createRelayGrant.mockImplementation(async () => {
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      return { relayToken: "r".repeat(43) };
    });
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const opening = openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      await privateGrantCreated;
      fixture.gate.close();
      const connection = await opening;
      expect(await connection.close).toMatchObject({ code: 1013 });
      expect(fixture.browserClient.openPassiveStream).not.toHaveBeenCalled();
      expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });

  it("revokes the exact private grant when the upstream handshake fails", async () => {
    const fixture = setup();
    fixture.browserClient.openPassiveStream.mockRejectedValueOnce(
      new Error("private handshake failed"),
    );
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      expect(await connection.close).toMatchObject({ code: 1011 });
      expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce();
      const createCalls = fixture.browserClient.createRelayGrant.mock
        .calls as unknown as unknown[][];
      const revokeCalls = fixture.browserClient.revokeRelayGrant.mock
        .calls as unknown as unknown[][];
      expect(revokeCalls[0]?.[1]).toBe(
        (createCalls[0]?.[1] as { grantId: string }).grantId,
      );
    } finally {
      server.close();
    }
  });

  it("rejects a grant whose owner-bound session cannot be loaded", async () => {
    const fixture = setup();
    fixture.transaction.query.mockResolvedValueOnce({ rows: [] });
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      expect(await connection.close).toMatchObject({ code: 1008 });
      expect(fixture.browserClient.createRelayGrant).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("allows CDP to omit Origin only with a CDP grant", async () => {
    const fixture = setup();
    fixture.grantStore.redeemWithLease.mockImplementation(
      async (_lease, _token, permission) => ({
        id: "00000000-0000-4000-8000-000000000005",
        ownerId: "00000000-0000-4000-8000-000000000003",
        sessionId: "00000000-0000-4000-8000-000000000002",
        permission,
        useLimit: 1,
        uses: 1,
        issuedAt: new Date(),
        redeemedAt: new Date(),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(server, "t".repeat(43), "cdp");
      expect(fixture.browserClient.openCdpStream).toHaveBeenCalledOnce();
      connection.socket.close();
    } finally {
      server.close();
    }
  });

  it("releases the mutation lease after handshake, before stream lifetime", async () => {
    const fixture = setup();
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      const drain = fixture.gate.close();
      await expect(drain.drained).resolves.toBeUndefined();
      expect(fixture.gate.withBrowserStateMutationLease).toHaveBeenCalledOnce();
      expect(connection.socket.readyState).toBe(WebSocket.OPEN);
      connection.socket.close();
    } finally {
      server.close();
    }
  });

  it("limits private grant redemption to the 30 second handshake", async () => {
    const fixture = setup();
    const startedAt = new Date();
    fixture.deps.now = () => startedAt;
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      const createCalls = fixture.browserClient.createRelayGrant.mock
        .calls as unknown as unknown[][];
      const request = createCalls[0]?.[1] as { expiresAt: string };
      expect(Date.parse(request.expiresAt)).toBe(startedAt.getTime() + 30_000);
      connection.socket.close();
      await vi.waitFor(() =>
        expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce(),
      );
    } finally {
      server.close();
    }
  });

  it("denies replay after a public grant has been redeemed", async () => {
    const fixture = setup();
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const first = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      first.socket.close();
      await vi.waitFor(() =>
        expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce(),
      );
      fixture.grantStore.redeemWithLease.mockResolvedValueOnce(null);
      const replay = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      expect(await replay.close).toMatchObject({ code: 1008 });
      expect(fixture.browserClient.createRelayGrant).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });

  it("cleans up a relay when COMMIT is rejected with known rollback", async () => {
    const fixture = setup();
    rejectLeaseCommit(fixture, Promise.resolve("rolled_back"));
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      expect(await connection.close).toMatchObject({ code: 1011 });
      expect(fixture.upstream.close).toHaveBeenCalledWith(
        1011,
        "relay_authority_unavailable",
      );
      expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce();
      expect(fixture.gate.close).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it.each([
    ["unknown", Promise.resolve("unknown" as const)],
    ["hung", new Promise<"unknown">(() => undefined)],
  ])(
    "fail-closes after a %s COMMIT outcome and verifies cleanup",
    async (_label, commitOutcome) => {
      const fixture = setup();
      fixture.deps.commitOutcomeTimeoutMs = 5;
      rejectLeaseCommit(fixture, commitOutcome);
      registerBrowserProxyRuntime(fixture.deps as never);
      const server = createApp().listen(0);
      try {
        const connection = await openProxy(
          server,
          "t".repeat(43),
          "passive",
          "http://127.0.0.1:3002",
        );
        expect(await connection.close).toMatchObject({ code: 1011 });
        expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce();
        expect(fixture.gate.close).toHaveBeenCalledWith(
          "browser_proxy_commit_outcome_unknown",
        );
      } finally {
        server.close();
      }
    },
  );

  it("closes an upstream that finishes opening after downstream disconnect", async () => {
    let completeHandshake!: (socket: FakeSocket) => void;
    const fixture = setup();
    fixture.browserClient.openPassiveStream.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          completeHandshake = resolve;
        }),
    );
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      connection.socket.close();
      completeHandshake(fixture.upstream);
      await vi.waitFor(() =>
        expect(fixture.upstream.close).toHaveBeenCalledWith(
          1000,
          "relay_closed",
        ),
      );
      await vi.waitFor(() =>
        expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce(),
      );
    } finally {
      server.close();
    }
  });

  it("caps relayed messages at 64 KiB and closes both sides", async () => {
    const fixture = setup();
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      connection.socket.send(Buffer.alloc(64 * 1024 + 1));
      expect(await connection.close).toMatchObject({ code: 1009 });
      expect(fixture.upstream.close).toHaveBeenCalledWith(
        1009,
        "relay_overflow",
      );
    } finally {
      server.close();
    }
  });

  it("rejects an oversized upstream frame", async () => {
    const fixture = setup();
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      fixture.upstream.emit("message", Buffer.alloc(64 * 1024 + 1), true);
      expect(await connection.close).toMatchObject({ code: 1009 });
      await vi.waitFor(() =>
        expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce(),
      );
    } finally {
      server.close();
    }
  });

  it("rejects projected buffered bytes before forwarding", async () => {
    const fixture = setup();
    fixture.upstream.bufferedAmount = 1;
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      connection.socket.send(Buffer.alloc(64 * 1024));
      expect(await connection.close).toMatchObject({ code: 1009 });
      expect(fixture.upstream.send).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce(),
      );
    } finally {
      server.close();
    }
  });

  it("rejects projected downstream bytes before forwarding upstream data", async () => {
    const fixture = setup();
    const downstream = new FakeSocket();
    downstream.bufferedAmount = 1;
    const handlers = createBrowserProxyHandlers(() => fixture.deps as never);

    await handlers.relay(
      downstream as unknown as WebSocket,
      {
        params: {
          token: "t".repeat(43),
          permission: "passive",
        },
        rawHeaders: ["Origin", "http://127.0.0.1:3002"],
      } as unknown as Request,
    );
    fixture.upstream.emit("message", Buffer.alloc(64 * 1024), true);

    expect(downstream.send).not.toHaveBeenCalled();
    expect(downstream.close).toHaveBeenCalledWith(1009, "relay_overflow");
    await vi.waitFor(() =>
      expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce(),
    );
  });

  it("waits for revoke writer release after downstream disconnect", async () => {
    let releaseWriter!: () => void;
    const writerReleased = new Promise<void>(resolve => {
      releaseWriter = resolve;
    });
    const fixture = setup();
    fixture.browserClient.revokeRelayGrant.mockImplementationOnce(async () => {
      await writerReleased;
      return { grantId: "00000000-0000-4000-8000-000000000006" };
    });
    registerBrowserProxyRuntime(fixture.deps as never);
    const server = createApp().listen(0);
    try {
      const connection = await openProxy(
        server,
        "t".repeat(43),
        "passive",
        "http://127.0.0.1:3002",
      );
      connection.socket.close();
      await vi.waitFor(() =>
        expect(fixture.browserClient.revokeRelayGrant).toHaveBeenCalledOnce(),
      );
      expect(fixture.gate.close).not.toHaveBeenCalled();
      releaseWriter();
      await vi.waitFor(() =>
        expect(fixture.upstream.close).toHaveBeenCalledWith(
          1000,
          "relay_closed",
        ),
      );
      expect(fixture.gate.close).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
