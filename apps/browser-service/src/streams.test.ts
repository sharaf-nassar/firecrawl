import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test, vi } from "vitest";
import {
  WebSocket as ClientWebSocket,
  WebSocketServer,
  type WebSocket,
} from "ws";

import type {
  SessionCdpChannel,
  SessionRegistry,
  SessionRuntimeLease,
} from "./session-registry.js";
import {
  STREAM_CLOSE_CODES,
  STREAM_LIMITS,
  createRelayGrantManager,
  type SessionStreamRuntimeApi,
} from "./streams.js";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;
const PROCESS_NONCE = Buffer.alloc(32, 1).toString("base64url");
const GENERATION_NONCE = Buffer.alloc(32, 2).toString("base64url");
const AUTH_BINDING = "browser-service-key";
const NOW = Date.parse("2026-07-24T12:00:00.000Z");

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  pingCount = 0;
  terminated = false;

  send(data: string | Uint8Array, callback?: (error?: Error) => void): void {
    this.sent.push(
      typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
    );
    callback?.();
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.closes.push({ code, reason });
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
    });
  }

  ping(): void {
    this.pingCount += 1;
  }

  terminate(): void {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit("close", 1006, Buffer.alloc(0));
  }
}

function harness(
  options: {
    now?: number;
    randomBytes?: () => Uint8Array;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    cleanupTimeoutMs?: number;
    send?: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
  } = {},
) {
  let currentNow = options.now ?? NOW;
  const sessionNow = currentNow;
  let randomByte = 9;
  const lease = Object.freeze({}) as SessionRuntimeLease;
  const channel = Object.freeze({}) as SessionCdpChannel;
  const runtimeController = new AbortController();
  const subscriptions = new Map<string, (params: unknown) => void>();
  const send = vi.fn(
    options.send ??
      (async () => {
        return {};
      }),
  );
  const runtimeApi: SessionStreamRuntimeApi = {
    signal: vi.fn(() => runtimeController.signal),
    openCdp: vi.fn(async () => channel),
    sendCdp: vi.fn((_, method, params) => send(method, params)),
    subscribeCdp: vi.fn((_, event, listener) => {
      subscriptions.set(event, listener);
      return () => subscriptions.delete(event);
    }),
    closeCdp: vi.fn(async () => undefined),
  };
  const withRuntime = vi.fn(
    async (
      _runtimeSessionId: string,
      _mode: "passive" | "writer",
      operation: (runtimeLease: SessionRuntimeLease) => Promise<unknown>,
    ) => operation(lease),
  );
  const registry = {
    get: vi.fn(() => ({
      version: 1,
      runtimeSessionId: IDS[0],
      state: "ready",
      sessionVersion: 0,
      page: {
        url: "https://example.com/",
        title: "",
        snapshotExcerpt: "",
      },
      expiresAt: new Date(sessionNow + 120_000).toISOString(),
      idleExpiresAt: new Date(sessionNow + 60_000).toISOString(),
    })),
    withRuntime,
  } as unknown as Pick<SessionRegistry, "get" | "withRuntime">;
  const manager = createRelayGrantManager({
    registry,
    binding: {
      processNonce: PROCESS_NONCE,
      controlGenerationNonce: GENERATION_NONCE,
    },
    authBinding: AUTH_BINDING,
    now: () => currentNow,
    randomBytes: options.randomBytes ?? (() => Buffer.alloc(32, randomByte++)),
    runtimeApi,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 60_000,
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 100,
  });
  return {
    manager,
    registry,
    runtimeApi,
    runtimeController,
    subscriptions,
    send,
    withRuntime,
    advanceNow(milliseconds: number) {
      currentNow += milliseconds;
    },
  };
}

function grantInput(
  permission: "passive" | "interactive" | "cdp",
  expiresAt = new Date(NOW + 30_000).toISOString(),
) {
  return {
    version: 1 as const,
    grantId: IDS[1],
    permission,
    expiresAt,
    useLimit: 1 as const,
    expectedSessionVersion: 1,
    allowedDomains: [],
  };
}

function authority(overrides: Record<string, unknown> = {}) {
  return {
    processNonce: PROCESS_NONCE,
    controlGenerationNonce: GENERATION_NONCE,
    authBinding: AUTH_BINDING,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("locks the private stream wire limits", () => {
  expect(STREAM_LIMITS.cdpFrameBytes).toBe(256 * 1024);
  expect(STREAM_LIMITS.cdpOutstandingIds).toBe(64);
});

describe("relay grant authority", () => {
  test("stores only hashes and atomically redeems once for the exact binding", async () => {
    const h = harness();
    const grant = h.manager.create(IDS[0], grantInput("passive"));
    expect(grant).toEqual({
      version: 1,
      grantId: IDS[1],
      permission: "passive",
      expiresAt: new Date(NOW + 30_000).toISOString(),
      relayToken: Buffer.alloc(32, 9).toString("base64url"),
    });
    expect(JSON.stringify(h.manager.inventory())).not.toContain(
      grant.relayToken,
    );

    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "passive",
          relayToken: grant.relayToken,
          authority: authority({ authBinding: "wrong" }),
        },
        async () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "unauthorized" });
    expect(h.withRuntime).not.toHaveBeenCalled();

    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[1],
          permission: "passive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "unauthorized" });
    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "passive",
          relayToken: grant.relayToken,
          authority: authority({
            controlGenerationNonce: Buffer.alloc(32, 3).toString("base64url"),
          }),
        },
        async () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "unauthorized" });
    expect(h.withRuntime).not.toHaveBeenCalled();

    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "passive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    expect(h.withRuntime).toHaveBeenCalledWith(
      IDS[0],
      "passive",
      expect.any(Function),
    );
    socket.close();
    await opened;

    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "passive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "unauthorized" });
    expect(h.withRuntime).toHaveBeenCalledTimes(1);
  });

  test("rejects strict-schema, permission, session, expiry, and revocation drift", async () => {
    const h = harness();
    expect(() =>
      h.manager.create(IDS[0], {
        ...grantInput("passive"),
        unknown: true,
      }),
    ).toThrow();
    expect(() =>
      h.manager.create(
        IDS[0],
        grantInput("passive", new Date(NOW).toISOString()),
      ),
    ).toThrow(/expiry/i);
    const grant = h.manager.create(IDS[0], grantInput("interactive"));

    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "cdp",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "unauthorized" });
    await expect(
      h.manager.revoke(IDS[0], {
        version: 1,
        grantId: grant.grantId,
      }),
    ).resolves.toEqual({ version: 1, grantId: IDS[1], revoked: true });
    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "interactive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "unauthorized" });
  });

  test("revocation is idempotent and acknowledges writer release", async () => {
    const h = harness();
    const grant = h.manager.create(IDS[0], grantInput("cdp"));
    let releaseWriter!: () => void;
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerExited = false;
    h.withRuntime.mockImplementationOnce(
      async (_runtimeSessionId, _mode, operation) => {
        try {
          return await operation(Object.freeze({}) as SessionRuntimeLease);
        } finally {
          await writerRelease;
          writerExited = true;
        }
      },
    );
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();

    let acknowledged = false;
    const revoked = h.manager
      .revoke(IDS[0], { version: 1, grantId: grant.grantId })
      .then((result) => {
        acknowledged = true;
        return result;
      });
    await settle();
    expect(acknowledged).toBe(false);
    expect(writerExited).toBe(false);

    releaseWriter();
    await expect(revoked).resolves.toEqual({
      version: 1,
      grantId: grant.grantId,
      revoked: true,
    });
    await opened;
    expect(writerExited).toBe(true);
    await expect(
      h.manager.revoke(IDS[0], {
        version: 1,
        grantId: "33333333-3333-4333-8333-333333333333",
      }),
    ).resolves.toEqual({
      version: 1,
      grantId: "33333333-3333-4333-8333-333333333333",
      revoked: true,
    });
  });

  test("expires unused grants without allowing a late redemption", async () => {
    const h = harness();
    const grant = h.manager.create(IDS[0], grantInput("passive"));
    h.advanceNow(30_001);
    expect(h.manager.sweepExpired()).toBe(1);
    expect(h.manager.inventory()).toEqual({ grants: 0, streams: 0 });
    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "passive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => new FakeSocket() as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "unauthorized" });
  });

  test("never reissues a consumed relay token hash", async () => {
    const h = harness({
      randomBytes: () => Buffer.alloc(32, 9),
    });
    const grant = h.manager.create(IDS[0], grantInput("passive"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "passive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    socket.close();
    await opened;
    expect(() =>
      h.manager.create(IDS[0], {
        ...grantInput("passive"),
        grantId: IDS[0],
      }),
    ).toThrow(/duplicate token/i);
  });
});

describe("live streams", () => {
  test("already-revoked runtime does not start CDP setup", async () => {
    const h = harness();
    h.runtimeController.abort();
    const grant = h.manager.create(IDS[0], grantInput("interactive"));
    const socket = new FakeSocket();

    await expect(
      h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "interactive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => socket as unknown as WebSocket,
      ),
    ).rejects.toMatchObject({ category: "browser_unavailable" });
    expect(h.runtimeApi.openCdp).not.toHaveBeenCalled();
    expect(socket.closes[0]?.code).toBe(STREAM_CLOSE_CODES.serviceRestart);
  });

  test("passive streams never acquire the writer and reject all input", async () => {
    const h = harness();
    const grant = h.manager.create(IDS[0], grantInput("passive"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "passive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    expect(h.withRuntime.mock.calls[0]?.[1]).toBe("passive");
    expect(h.send).toHaveBeenCalledWith("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });

    socket.emit(
      "message",
      Buffer.from('{"kind":"pointer","x":1,"y":1}'),
      false,
    );
    await opened;
    expect(socket.closes.at(-1)?.code).toBe(STREAM_CLOSE_CODES.policyViolation);
  });

  test("interactive streams hold the writer and validate a strict 4 KiB input union", async () => {
    const h = harness();
    const grant = h.manager.create(IDS[0], grantInput("interactive"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "interactive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    expect(h.withRuntime.mock.calls[0]?.[1]).toBe("writer");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "pointer",
          action: "move",
          x: 12,
          y: 34,
          buttons: 0,
          modifiers: 0,
        }),
      ),
      false,
    );
    await settle();
    expect(h.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 12,
      y: 34,
      buttons: 0,
      modifiers: 0,
    });

    socket.emit(
      "message",
      Buffer.alloc(STREAM_LIMITS.interactiveInputBytes + 1),
      false,
    );
    await opened;
    expect(socket.closes.at(-1)?.code).toBe(STREAM_CLOSE_CODES.messageTooBig);
  });

  test("frames are validated, acknowledged, bounded, and dropped under backpressure", async () => {
    const h = harness();
    const grant = h.manager.create(IDS[0], grantInput("passive"));
    const socket = new FakeSocket();
    socket.bufferedAmount = STREAM_LIMITS.backpressureBytes + 1;
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "passive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    h.subscriptions.get("Page.screencastFrame")?.({
      data: Buffer.from("jpeg").toString("base64"),
      sessionId: 7,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });
    await settle();
    expect(h.send).toHaveBeenCalledWith("Page.screencastFrameAck", {
      sessionId: 7,
    });
    expect(socket.sent.some((value) => value.includes('"kind":"frame"'))).toBe(
      false,
    );
    socket.close();
    await opened;
  });

  test("detaches before draining a committed interactive command", async () => {
    const order: string[] = [];
    let rejectInput!: (error: Error) => void;
    const input = new Promise<void>((_resolve, reject) => {
      rejectInput = reject;
    });
    const h = harness({
      send: async (method) => (method === "Input.insertText" ? input : {}),
    });
    const grant = h.manager.create(IDS[0], grantInput("interactive"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "interactive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ version: 1, kind: "text", text: "held" })),
      false,
    );
    await settle();
    h.runtimeApi.closeCdp = vi.fn(async () => {
      order.push("detach");
      rejectInput(new Error("detached"));
    });
    socket.close();
    await settle();
    expect(order).toEqual(["detach"]);
    await opened;
    expect(h.runtimeApi.closeCdp).toHaveBeenCalledOnce();
  });

  test.each(["socket", "revoke", "drain"] as const)(
    "%s cancellation detaches early and drops queued interactive input",
    { timeout: 1_000 },
    async (mode) => {
      const calls: string[] = [];
      let rejectInput!: (error: Error) => void;
      const input = new Promise<void>((_resolve, reject) => {
        rejectInput = reject;
      });
      const h = harness({
        cleanupTimeoutMs: 25,
        send: async (method, params) => {
          if (method === "Input.insertText") {
            calls.push(params.text as string);
            if (params.text === "first") return input;
          }
          return {};
        },
      });
      h.runtimeApi.closeCdp = vi.fn(async () => {
        calls.push("detach");
        rejectInput(new Error("detached"));
      });
      const grant = h.manager.create(IDS[0], grantInput("interactive"));
      const socket = new FakeSocket();
      const opened = h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "interactive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => socket as unknown as WebSocket,
      );
      await settle();
      for (const text of ["first", "second"]) {
        socket.emit(
          "message",
          Buffer.from(JSON.stringify({ version: 1, kind: "text", text })),
          false,
        );
      }
      await vi.waitFor(() => expect(calls).toContain("first"));
      let drained: Promise<void> | undefined;
      if (mode === "socket") {
        socket.close();
      } else if (mode === "revoke") {
        await h.manager.revoke(IDS[0], {
          version: 1,
          grantId: grant.grantId,
        });
      } else {
        drained = h.manager.drain();
      }
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({ version: 1, kind: "text", text: "after-close" }),
        ),
        false,
      );

      await opened;
      await drained;
      expect(calls).toEqual(["first", "detach"]);
      expect(h.runtimeApi.closeCdp).toHaveBeenCalledOnce();
      expect(socket.closes[0]?.code).toBe(
        mode === "revoke"
          ? STREAM_CLOSE_CODES.policyViolation
          : mode === "drain"
            ? STREAM_CLOSE_CODES.serviceRestart
            : STREAM_CLOSE_CODES.normal,
      );
    },
  );

  test("peer close prevents an accepted input microtask from committing", async () => {
    const h = harness();
    const grant = h.manager.create(IDS[0], grantInput("interactive"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "interactive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ version: 1, kind: "text", text: "do-not-run" }),
      ),
      false,
    );
    socket.close();

    await opened;
    expect(h.send).not.toHaveBeenCalledWith("Input.insertText", {
      text: "do-not-run",
    });
  });

  test.each(["revoke", "drain"] as const)(
    "%s fail-stops within the cleanup bound when input remains unresolved",
    { timeout: 1_000 },
    async (mode) => {
      const input = new Promise<never>(() => undefined);
      const h = harness({
        cleanupTimeoutMs: 25,
        send: async (method) => (method === "Input.insertText" ? input : {}),
      });
      const grant = h.manager.create(IDS[0], grantInput("interactive"));
      const socket = new FakeSocket();
      const opened = h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "interactive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => socket as unknown as WebSocket,
      );
      await settle();
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({ version: 1, kind: "text", text: "unresolved" }),
        ),
        false,
      );
      await vi.waitFor(() =>
        expect(h.send).toHaveBeenCalledWith("Input.insertText", {
          text: "unresolved",
        }),
      );
      let drained: Promise<void> | undefined;
      let revoked: Promise<unknown> | undefined;
      if (mode === "revoke") {
        revoked = h.manager.revoke(IDS[0], {
          version: 1,
          grantId: grant.grantId,
        });
      } else {
        drained = h.manager.drain();
      }

      await expect(opened).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      await revoked;
      await drained;
      expect(h.runtimeApi.closeCdp).toHaveBeenCalledOnce();
    },
  );

  test.each(["revoke", "drain"] as const)(
    "%s completes bounded fail-stop when CDP channel opening hangs",
    { timeout: 1_000 },
    async (mode) => {
      const h = harness({ cleanupTimeoutMs: 25 });
      h.runtimeApi.openCdp = vi.fn(
        () => new Promise<SessionCdpChannel>(() => undefined),
      );
      const grant = h.manager.create(IDS[0], grantInput("interactive"));
      const socket = new FakeSocket();
      const opened = h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "interactive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => socket as unknown as WebSocket,
      );
      await vi.waitFor(() =>
        expect(h.runtimeApi.openCdp).toHaveBeenCalledOnce(),
      );
      let drained: Promise<void> | undefined;
      let revoked: Promise<unknown> | undefined;
      if (mode === "revoke") {
        revoked = h.manager.revoke(IDS[0], {
          version: 1,
          grantId: grant.grantId,
        });
      } else {
        drained = h.manager.drain();
      }

      await expect(opened).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      await revoked;
      await drained;
      expect(h.runtimeApi.closeCdp).not.toHaveBeenCalled();
    },
  );

  test("tracks ACK failure and closes with the existing internal code", async () => {
    const h = harness({
      send: async (method) => {
        if (method === "Page.screencastFrameAck") {
          throw new Error("ACK failed");
        }
        return {};
      },
    });
    const grant = h.manager.create(IDS[0], grantInput("passive"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "passive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    h.subscriptions.get("Page.screencastFrame")?.({
      data: Buffer.from("jpeg").toString("base64"),
      sessionId: 7,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });
    await opened;
    expect(socket.closes[0]?.code).toBe(STREAM_CLOSE_CODES.internalError);
    expect(h.runtimeApi.closeCdp).toHaveBeenCalledOnce();
  });

  test(
    "fail-stops within the cleanup bound when an ACK remains unresolved",
    { timeout: 1_000 },
    async () => {
      const ack = new Promise<never>(() => undefined);
      const h = harness({
        cleanupTimeoutMs: 25,
        send: async (method) =>
          method === "Page.screencastFrameAck" ? ack : {},
      });
      const grant = h.manager.create(IDS[0], grantInput("passive"));
      const socket = new FakeSocket();
      const opened = h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "passive",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => socket as unknown as WebSocket,
      );
      await settle();
      h.subscriptions.get("Page.screencastFrame")?.({
        data: Buffer.from("jpeg").toString("base64"),
        sessionId: 7,
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 1280,
          deviceHeight: 720,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      });
      await settle();
      const revoked = h.manager.revoke(IDS[0], {
        version: 1,
        grantId: grant.grantId,
      });

      await expect(opened).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      await revoked;
      expect(h.runtimeApi.closeCdp).toHaveBeenCalledOnce();
    },
  );
});

describe("CDP stream", () => {
  test("does not complete upgrade until writer acquisition and enforces policy", async () => {
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const h = harness();
    h.withRuntime.mockImplementationOnce(
      async (
        _runtimeSessionId: string,
        _mode: "passive" | "writer",
        operation: (lease: SessionRuntimeLease) => Promise<unknown>,
      ) => {
        await writerGate;
        return operation(Object.freeze({}) as SessionRuntimeLease);
      },
    );
    const grant = h.manager.create(IDS[0], grantInput("cdp"));
    const socket = new FakeSocket();
    const upgrade = vi.fn(async () => socket as unknown as WebSocket);
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      upgrade,
    );
    await settle();
    expect(upgrade).not.toHaveBeenCalled();
    releaseWriter();
    await settle();
    expect(upgrade).toHaveBeenCalledOnce();

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: 1,
          method: "Target.createTarget",
          params: { url: "https://example.com/" },
        }),
      ),
      false,
    );
    await opened;
    expect(socket.closes.at(-1)?.code).toBe(STREAM_CLOSE_CODES.policyViolation);
    expect(h.send).not.toHaveBeenCalledWith(
      "Target.createTarget",
      expect.anything(),
    );
  });

  test("forwards only validated allowlisted requests and closes on duplicate IDs", async () => {
    let releaseCommand!: (value: unknown) => void;
    const command = new Promise<unknown>((resolve) => {
      releaseCommand = resolve;
    });
    const h = harness({
      send: async (method) =>
        method === "Runtime.getProperties" ? command : {},
    });
    const grant = h.manager.create(IDS[0], grantInput("cdp"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    const request = Buffer.from(
      JSON.stringify({
        id: 9,
        method: "Runtime.getProperties",
        params: { objectId: "remote-object-1", ownProperties: true },
      }),
    );
    socket.emit("message", request, false);
    socket.emit("message", request, false);
    await settle();
    expect(socket.closes.at(-1)?.code).toBe(STREAM_CLOSE_CODES.policyViolation);
    releaseCommand({ result: { type: "string", value: "Example" } });
    await opened;
  });

  test("caps outstanding IDs at 64 and rejects malformed response values", async () => {
    let resolveCommands!: (value: unknown) => void;
    const commands = new Promise<unknown>((resolve) => {
      resolveCommands = resolve;
    });
    const h = harness({
      send: async () => commands,
    });
    const grant = h.manager.create(IDS[0], grantInput("cdp"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    for (let id = 0; id <= STREAM_LIMITS.cdpOutstandingIds; id += 1) {
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            id,
            method: "Runtime.enable",
            params: {},
          }),
        ),
        false,
      );
    }
    await settle();
    expect(socket.closes.at(-1)?.code).toBe(STREAM_CLOSE_CODES.policyViolation);
    expect(h.send).toHaveBeenCalledTimes(STREAM_LIMITS.cdpOutstandingIds);
    resolveCommands({});
    await opened;

    const invalid = harness({
      send: async () => ({ value: 1n }),
    });
    const invalidGrant = invalid.manager.create(IDS[0], grantInput("cdp"));
    const invalidSocket = new FakeSocket();
    const invalidOpen = invalid.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken: invalidGrant.relayToken,
        authority: authority(),
      },
      async () => invalidSocket as unknown as WebSocket,
    );
    await settle();
    invalidSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }),
      ),
      false,
    );
    await invalidOpen;
    expect(invalidSocket.closes.at(-1)?.code).toBe(
      STREAM_CLOSE_CODES.internalError,
    );
  });

  test("detaches before draining committed CDP sends", async () => {
    const order: string[] = [];
    let rejectEffect!: (error: Error) => void;
    const effect = new Promise<unknown>((_resolve, reject) => {
      rejectEffect = reject;
    });
    const h = harness({ send: async () => effect });
    h.runtimeApi.closeCdp = vi.fn(async () => {
      order.push("detach");
      rejectEffect(new Error("detached"));
    });
    const grant = h.manager.create(IDS[0], grantInput("cdp"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }),
      ),
      false,
    );
    await settle();
    socket.close();
    await settle();
    expect(order).toEqual(["detach"]);
    await opened;
    expect(h.runtimeApi.closeCdp).toHaveBeenCalledOnce();
  });

  test(
    "fail-stops within the cleanup bound when detach does not settle",
    { timeout: 1_000 },
    async () => {
      const h = harness({ cleanupTimeoutMs: 25 });
      h.runtimeApi.closeCdp = vi.fn(() => new Promise<void>(() => undefined));
      const grant = h.manager.create(IDS[0], grantInput("cdp"));
      const socket = new FakeSocket();
      const opened = h.manager.open(
        {
          runtimeSessionId: IDS[0],
          permission: "cdp",
          relayToken: grant.relayToken,
          authority: authority(),
        },
        async () => socket as unknown as WebSocket,
      );
      await settle();
      socket.close();

      await expect(opened).rejects.toMatchObject({
        category: "browser_unavailable",
      });
      expect(h.runtimeApi.closeCdp).toHaveBeenCalledOnce();
    },
  );

  test("normalizes runtime lease cleanup failure to browser unavailable", async () => {
    const h = harness();
    h.withRuntime.mockImplementationOnce(
      async (
        _runtimeSessionId: string,
        _mode: "passive" | "writer",
        operation: (lease: SessionRuntimeLease) => Promise<unknown>,
      ) => {
        await operation(Object.freeze({}) as SessionRuntimeLease);
        throw new AggregateError([], "runtime lease cleanup is unverified");
      },
    );
    const grant = h.manager.create(IDS[0], grantInput("cdp"));
    const socket = new FakeSocket();
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "cdp",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => socket as unknown as WebSocket,
    );
    await settle();
    socket.close();

    await expect(opened).rejects.toMatchObject({
      category: "browser_unavailable",
    });
  });
});

test("drain revokes unused grants, aborts active streams, and leaves no inventory", async () => {
  const h = harness();
  h.manager.create(IDS[0], grantInput("passive"));
  const activeGrant = h.manager.create(IDS[0], {
    ...grantInput("cdp"),
    grantId: IDS[0],
  });
  const socket = new FakeSocket();
  const opened = h.manager.open(
    {
      runtimeSessionId: IDS[0],
      permission: "cdp",
      relayToken: activeGrant.relayToken,
      authority: authority(),
    },
    async () => socket as unknown as WebSocket,
  );
  await settle();
  await h.manager.drain();
  await opened;
  expect(socket.closes.at(-1)?.code).toBe(STREAM_CLOSE_CODES.serviceRestart);
  expect(h.manager.inventory()).toEqual({ grants: 0, streams: 0 });
});

test("revoke closes an active stream with policy code before generic abort cleanup", async () => {
  const h = harness();
  const grant = h.manager.create(IDS[0], grantInput("passive"));
  const socket = new FakeSocket();
  const opened = h.manager.open(
    {
      runtimeSessionId: IDS[0],
      permission: "passive",
      relayToken: grant.relayToken,
      authority: authority(),
    },
    async () => socket as unknown as WebSocket,
  );
  await settle();
  await h.manager.revoke(IDS[0], {
    version: 1,
    grantId: grant.grantId,
  });
  await opened;
  expect(socket.closes[0]?.code).toBe(STREAM_CLOSE_CODES.policyViolation);
});

test("grant expiry bounds redemption but not an already active stream", async () => {
  const h = harness();
  const grant = h.manager.create(IDS[0], grantInput("passive"));
  const socket = new FakeSocket();
  const opened = h.manager.open(
    {
      runtimeSessionId: IDS[0],
      permission: "passive",
      relayToken: grant.relayToken,
      authority: authority(),
    },
    async () => socket as unknown as WebSocket,
  );
  await settle();

  h.advanceNow(30_001);
  expect(h.manager.sweepExpired()).toBe(0);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(h.manager.inventory()).toEqual({ grants: 1, streams: 1 });

  socket.close();
  await opened;
  expect(h.manager.inventory()).toEqual({ grants: 0, streams: 0 });
});

test("post-upgrade setup failure closes the socket and retains inventory until cleanup", async () => {
  const h = harness();
  h.runtimeApi.openCdp = vi.fn(async () => {
    throw new Error("CDP setup failed");
  });
  const grant = h.manager.create(IDS[0], grantInput("passive"));
  const socket = new FakeSocket();
  let inventoryDuringFailure:
    | Readonly<{ grants: number; streams: number }>
    | undefined;
  await expect(
    h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission: "passive",
        relayToken: grant.relayToken,
        authority: authority(),
      },
      async () => {
        inventoryDuringFailure = h.manager.inventory();
        return socket as unknown as WebSocket;
      },
    ),
  ).rejects.toThrow(/CDP setup failed/);
  expect(inventoryDuringFailure).toEqual({ grants: 1, streams: 1 });
  expect(socket.closes[0]?.code).toBe(STREAM_CLOSE_CODES.internalError);
  expect(h.manager.inventory()).toEqual({ grants: 0, streams: 0 });
});

async function realUpgradeHarness(
  options: {
    permission?: "passive" | "interactive" | "cdp";
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    failSetup?: boolean;
    configureServerSocket?: (socket: WebSocket) => void;
  } = {},
) {
  const permission = options.permission ?? "cdp";
  const h = harness({
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  });
  if (options.failSetup) {
    h.runtimeApi.openCdp = vi.fn(async () => {
      throw new Error("real setup failed");
    });
  }
  const grant = h.manager.create(IDS[0], grantInput(permission));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: STREAM_LIMITS.cdpFrameBytes,
  });
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  let serverSocket: WebSocket | undefined;
  let openResult: Promise<Readonly<{ error: unknown | undefined }>> | undefined;
  server.on("upgrade", (request, socket, head) => {
    const opened = h.manager.open(
      {
        runtimeSessionId: IDS[0],
        permission,
        relayToken: grant.relayToken,
        authority: authority(),
      },
      () =>
        new Promise<WebSocket>((resolve, reject) => {
          try {
            wss.handleUpgrade(request, socket, head, (webSocket) => {
              serverSocket = webSocket;
              options.configureServerSocket?.(webSocket);
              resolve(webSocket);
            });
          } catch (error) {
            reject(error);
          }
        }),
    );
    openResult = opened.then(
      () => Object.freeze({ error: undefined }),
      (error) => Object.freeze({ error }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const client = new ClientWebSocket(
    `ws://127.0.0.1:${address.port}/v1/private-stream`,
    { autoPong: options.heartbeatIntervalMs === undefined },
  );
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  await vi.waitFor(() => expect(serverSocket).toBeDefined());

  return {
    client,
    h,
    serverSocket: serverSocket!,
    wss,
    async opened() {
      await vi.waitFor(() => expect(openResult).toBeDefined());
      return openResult!;
    },
    async close() {
      if (client.readyState !== ClientWebSocket.CLOSED) client.terminate();
      if (
        serverSocket !== undefined &&
        serverSocket.readyState !== serverSocket.CLOSED
      ) {
        serverSocket.terminate();
      }
      await h.manager.drain();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

describe("real ws no-server upgrade boundary", () => {
  test("uses maxPayload to reject an oversized inbound frame before dispatch", async () => {
    const real = await realUpgradeHarness();
    try {
      expect(real.wss.options.maxPayload).toBe(256 * 1024);
      const closed = new Promise<number>((resolve) => {
        real.client.once("close", (code) => resolve(code));
      });
      real.client.send(Buffer.alloc(STREAM_LIMITS.cdpFrameBytes + 1), {
        binary: false,
      });
      await expect(closed).resolves.toBe(STREAM_CLOSE_CODES.messageTooBig);
      expect(real.h.send).not.toHaveBeenCalled();
      await real.opened();
    } finally {
      await real.close();
    }
  });

  test("terminates a peer that does not answer heartbeat pings", async () => {
    const real = await realUpgradeHarness({
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 20,
    });
    try {
      const closed = new Promise<number>((resolve) => {
        real.client.once("close", (code) => resolve(code));
      });
      await expect(closed).resolves.toBe(1006);
      await real.opened();
    } finally {
      await real.close();
    }
  });

  test("closes a real upgraded socket when post-upgrade setup fails", async () => {
    const real = await realUpgradeHarness({ failSetup: true });
    try {
      const closed = new Promise<number>((resolve) => {
        real.client.once("close", (code) => resolve(code));
      });
      await expect(closed).resolves.toBe(STREAM_CLOSE_CODES.internalError);
      await expect(real.opened()).resolves.toMatchObject({
        error: expect.objectContaining({ message: "real setup failed" }),
      });
      expect(real.h.manager.inventory()).toEqual({ grants: 0, streams: 0 });
    } finally {
      await real.close();
    }
  });

  test(
    "terminates after the bounded close timeout when peer close cannot settle",
    { timeout: STREAM_LIMITS.closeTimeoutMs + 5_000 },
    async () => {
      let terminate!: ReturnType<typeof vi.fn>;
      const real = await realUpgradeHarness({
        configureServerSocket(socket) {
          const originalTerminate = socket.terminate.bind(socket);
          socket.close = vi.fn(() => {
            Reflect.set(socket, "_readyState", socket.CLOSING);
          });
          terminate = vi.fn(() => originalTerminate());
          socket.terminate = terminate;
        },
      });
      try {
        const closed = new Promise<number>((resolve) => {
          real.client.once("close", (code) => resolve(code));
        });
        const revoked = real.h.manager.revoke(IDS[0], {
          version: 1,
          grantId: IDS[1],
        });
        await expect(closed).resolves.toBe(1006);
        await revoked;
        expect(terminate).toHaveBeenCalledOnce();
        await real.opened();
      } finally {
        await real.close();
      }
    },
  );
});
