import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: {
    createSession: vi.fn(),
    executeSession: vi.fn(),
    stopSession: vi.fn(),
    listSessions: vi.fn(),
  },
  getRuntime: vi.fn(),
  checkCredits: vi.fn(),
  activeCount: vi.fn(),
  logRequest: vi.fn(),
  billTeam: vi.fn(),
  updateCredits: vi.fn(),
  didPrompt: vi.fn(),
  mirrorAcquire: vi.fn(),
  mirrorRelease: vi.fn(),
}));

vi.mock("../../lib/scrape-interact/browser-agent", () => ({
  getPublicBrowserRuntime: mocks.getRuntime,
  PublicBrowserRuntimeError: class PublicBrowserRuntimeError extends Error {
    constructor(public readonly category: string) {
      super(category);
    }
  },
}));
vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: mocks.checkCredits },
}));
vi.mock("../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: mocks.activeCount,
  mirrorExternalSlotAcquire: mocks.mirrorAcquire,
  mirrorExternalSlotRelease: mocks.mirrorRelease,
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
}));
vi.mock("../../lib/browser-session-activity", () => ({
  enqueueBrowserSessionActivity: vi.fn(),
}));
vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));
vi.mock("../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  getBrowserSession: vi.fn(),
  getBrowserSessionByBrowserId: vi.fn(),
  listBrowserSessions: vi.fn(),
  updateBrowserSessionActivity: vi.fn(async () => undefined),
  updateBrowserSessionStatus: vi.fn(async () => undefined),
  updateBrowserSessionCreditsUsed: mocks.updateCredits,
  claimBrowserSessionDestroyed: vi.fn(),
  invalidateActiveBrowserSessionCount: vi.fn(async () => undefined),
  didBrowserSessionUsePrompt: mocks.didPrompt,
  clearBrowserSessionPromptFlag: vi.fn(async () => undefined),
}));

import { config } from "../../config";
import {
  browserCreateController,
  browserCreateRequestSchema,
  browserDeleteController,
  browserExecuteController,
  browserListController,
} from "./browser";

function response() {
  const result = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      result.statusCode = code;
      return result;
    },
    json(body: unknown) {
      result.body = body;
      return result;
    },
  };
  return result;
}

function request(body: unknown = {}, params: Record<string, string> = {}) {
  return {
    body,
    params,
    query: {},
    path: "/v2/browser",
    protocol: "http",
    get: (name: string) => (name === "host" ? "api.example.test" : undefined),
    auth: { team_id: randomUUID() },
    acuc: { concurrency: 2, api_key_id: randomUUID() },
  } as never;
}

describe("local direct Browser compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of Object.values(mocks.runtime)) method.mockReset();
    (
      config as { LOCAL_BROWSER_SERVICE_ENABLED?: boolean }
    ).LOCAL_BROWSER_SERVICE_ENABLED = true;
    (
      config as { LOCAL_PERSISTENCE_ENABLED?: boolean }
    ).LOCAL_PERSISTENCE_ENABLED = true;
    (
      config as { BROWSER_PUBLIC_API_ORIGIN?: string }
    ).BROWSER_PUBLIC_API_ORIGIN = "http://api.example.test";
    mocks.getRuntime.mockReturnValue(mocks.runtime);
    mocks.checkCredits.mockResolvedValue(null);
    mocks.activeCount.mockResolvedValue(0);
    mocks.logRequest.mockResolvedValue(undefined);
    mocks.billTeam.mockResolvedValue(undefined);
    mocks.updateCredits.mockResolvedValue(undefined);
    mocks.didPrompt.mockResolvedValue(false);
    mocks.mirrorAcquire.mockResolvedValue(undefined);
    mocks.mirrorRelease.mockResolvedValue(undefined);
  });

  it("keeps direct defaults and returns only opaque API URLs", async () => {
    const id = randomUUID();
    mocks.runtime.createSession.mockResolvedValue({
      id,
      state: "ready",
      status: "active",
      streamWebView: true,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      cdpUrl: `ws://api.example.test/v2/browser/proxy/${"a".repeat(43)}/cdp`,
      liveViewUrl: `http://api.example.test/v2/browser/proxy/${"b".repeat(43)}/view`,
      interactiveLiveViewUrl: `http://api.example.test/v2/browser/proxy/${"c".repeat(43)}/view`,
    });
    const res = response();

    await browserCreateController(request(), res as never);

    expect(mocks.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlSeconds: 600,
        activityTtlSeconds: 300,
        initialUrl: "about:blank",
        allowedDomains: [],
        publicBase: "http://api.example.test",
        publicWsBase: "ws://api.example.test",
      }),
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { cdpUrl: string }).cdpUrl).toContain(
      "/v2/browser/proxy/",
    );
    expect(JSON.stringify(res.body)).not.toContain("browser-service");
  });

  it("normalizes idle lifetime and validates public domain policy", () => {
    expect(
      browserCreateRequestSchema.parse({ ttl: 60, activityTtl: 300 }),
    ).toMatchObject({ ttl: 60, activityTtl: 60 });
    for (const domain of [
      "localhost",
      "127.0.0.1",
      "https://example.com",
      "example.com:443",
      "*.example.com",
      "user@example.com",
      "Éxample.com",
    ]) {
      expect(
        browserCreateRequestSchema.safeParse({ allowedDomains: [domain] })
          .success,
      ).toBe(false);
    }
    expect(
      browserCreateRequestSchema.safeParse({
        allowedDomains: Array.from(
          { length: 9 },
          (_, index) => `d${index}.example`,
        ),
      }).success,
    ).toBe(false);
  });

  it("maps profile locking and expired execution without private details", async () => {
    mocks.runtime.createSession.mockRejectedValue(
      Object.assign(new Error("private profile path"), {
        category: "profile_locked",
      }),
    );
    mocks.runtime.executeSession.mockRejectedValue(
      Object.assign(new Error("private browser id"), {
        category: "browser_expired",
      }),
    );
    const create = response();
    const execute = response();

    await browserCreateController(
      request({ profile: { name: "saved" } }),
      create as never,
    );
    await browserExecuteController(
      request({ code: "1" }, { sessionId: randomUUID() }),
      execute as never,
    );

    expect(create.statusCode).toBe(409);
    expect(JSON.stringify(create.body)).not.toContain("private");
    expect(execute.statusCode).toBe(410);
    expect(JSON.stringify(execute.body)).not.toContain("private");
  });

  it("rotates list URLs and keeps duplicate delete idempotent", async () => {
    const id = randomUUID();
    const base = {
      id,
      state: "ready",
      status: "active",
      streamWebView: true,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    mocks.runtime.listSessions
      .mockResolvedValueOnce([
        {
          ...base,
          cdpUrl: "ws://api.example.test/v2/browser/proxy/first/cdp",
          liveViewUrl: "http://api.example.test/v2/browser/proxy/first/view",
          interactiveLiveViewUrl:
            "http://api.example.test/v2/browser/proxy/first-input/view",
        },
      ])
      .mockResolvedValueOnce([
        {
          ...base,
          cdpUrl: "ws://api.example.test/v2/browser/proxy/second/cdp",
          liveViewUrl: "http://api.example.test/v2/browser/proxy/second/view",
          interactiveLiveViewUrl:
            "http://api.example.test/v2/browser/proxy/second-input/view",
        },
      ]);
    mocks.runtime.stopSession.mockResolvedValue({ stopped: true });
    const first = response();
    const second = response();

    await browserListController(request(), first as never);
    await browserListController(request(), second as never);
    await browserDeleteController(
      request({}, { sessionId: id }),
      response() as never,
    );
    await browserDeleteController(
      request({}, { sessionId: id }),
      response() as never,
    );

    expect(
      (first.body as { sessions: Array<{ cdpUrl: string }> }).sessions[0]
        ?.cdpUrl,
    ).not.toBe(
      (second.body as { sessions: Array<{ cdpUrl: string }> }).sessions[0]
        ?.cdpUrl,
    );
    expect(mocks.runtime.stopSession).toHaveBeenCalledTimes(2);
  });

  it("does not complete delete before runtime cleanup finishes", async () => {
    const id = randomUUID();
    let finishStop:
      | ((result: { stopped: boolean; sessionId: string }) => void)
      | undefined;
    mocks.runtime.stopSession.mockReturnValue(
      new Promise(resolve => {
        finishStop = resolve;
      }),
    );
    const res = response();
    const deleting = browserDeleteController(
      request({}, { sessionId: id }),
      res as never,
    );

    await vi.waitFor(() =>
      expect(mocks.runtime.stopSession).toHaveBeenCalledWith(
        expect.any(String),
        id,
      ),
    );
    expect(res.statusCode).toBe(0);
    expect(res.body).toBeUndefined();

    finishStop!({ stopped: true, sessionId: id });
    await deleting;
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("routes create, execute, delete, and list failures to typed 503", async () => {
    const unavailable = Object.assign(new Error("closed"), {
      category: "browser_state_unavailable",
    });
    mocks.runtime.createSession.mockRejectedValue(unavailable);
    mocks.runtime.executeSession.mockRejectedValue(unavailable);
    mocks.runtime.stopSession.mockRejectedValue(unavailable);
    mocks.runtime.listSessions.mockRejectedValue(unavailable);
    const id = randomUUID();

    const calls = [
      () => browserCreateController(request(), response() as never),
      () =>
        browserExecuteController(
          request({ code: "1" }, { sessionId: id }),
          response() as never,
        ),
      () =>
        browserDeleteController(
          request({}, { sessionId: id }),
          response() as never,
        ),
      () => browserListController(request(), response() as never),
    ];
    for (const invoke of calls) {
      const res = (await invoke()) as unknown as ReturnType<typeof response>;
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        success: false,
        error: "Browser state is temporarily unavailable.",
      });
    }
  });

  it("preserves local credit, concurrency, and stop billing hooks", async () => {
    const id = randomUUID();
    mocks.runtime.createSession.mockResolvedValue({
      id,
      state: "ready",
      status: "active",
      streamWebView: true,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      cdpUrl: "ws://api.example.test/v2/browser/proxy/cdp/cdp",
      liveViewUrl: "http://api.example.test/v2/browser/proxy/live/view",
      interactiveLiveViewUrl:
        "http://api.example.test/v2/browser/proxy/input/view",
    });
    mocks.runtime.stopSession
      .mockResolvedValueOnce({
        stopped: true,
        sessionDurationMs: 120_000,
        creditsBilled: 4,
        usedPrompt: false,
      })
      .mockResolvedValueOnce({
        stopped: false,
        sessionDurationMs: 120_000,
      });

    await browserCreateController(request(), response() as never);
    await browserDeleteController(
      request({}, { sessionId: id }),
      response() as never,
    );
    await browserDeleteController(
      request({}, { sessionId: id }),
      response() as never,
    );

    expect(mocks.checkCredits).not.toHaveBeenCalled();
    expect(mocks.activeCount).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ concurrencyLimit: 2 }),
    );
    expect(mocks.mirrorAcquire).not.toHaveBeenCalled();
    expect(mocks.updateCredits).not.toHaveBeenCalled();
    expect(mocks.billTeam).not.toHaveBeenCalled();
    expect(mocks.mirrorRelease).not.toHaveBeenCalled();
  });

  it("passes strict execute domains with a fresh request attribution", async () => {
    const id = randomUUID();
    mocks.runtime.executeSession.mockResolvedValue({
      stdout: "ok",
      result: "done",
      stderr: "",
      exitCode: 0,
      killed: false,
    });

    await browserExecuteController(
      request(
        { code: "1", allowedDomains: ["fixture.example"] },
        { sessionId: id },
      ),
      response() as never,
    );

    expect(mocks.runtime.executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        allowedDomains: ["fixture.example"],
      }),
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "browser" }),
    );
  });

  it("fails closed without a trusted public origin and ignores Host", async () => {
    (
      config as { BROWSER_PUBLIC_API_ORIGIN?: string }
    ).BROWSER_PUBLIC_API_ORIGIN = undefined;
    const unavailable = response();
    await browserCreateController(request(), unavailable as never);
    expect(unavailable.statusCode).toBe(503);
    expect(mocks.runtime.createSession).not.toHaveBeenCalled();
  });
});
