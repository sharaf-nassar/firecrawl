import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: {
    loadReplayState: vi.fn(),
    interact: vi.fn(),
    stopInteract: vi.fn(),
  },
  getRuntime: vi.fn(),
  getScrape: vi.fn(),
  logRequest: vi.fn(),
  reserveKeyless: vi.fn(),
  adjustKeyless: vi.fn(),
  logKeyless: vi.fn(),
  checkCredits: vi.fn(),
  activeCount: vi.fn(),
  mirrorAcquire: vi.fn(),
  mirrorRelease: vi.fn(),
  billTeam: vi.fn(),
  updateCredits: vi.fn(),
  getSessionFromScrape: vi.fn(),
}));

vi.mock("../../lib/browser-runtime/public-browser-runtime", () => ({
  getPublicBrowserRuntime: mocks.getRuntime,
  PublicBrowserRuntimeError: class PublicBrowserRuntimeError extends Error {
    constructor(public readonly category: string) {
      super(category);
    }
  },
}));
vi.mock("../../lib/supabase-jobs", () => ({
  supabaseGetScrapeById: mocks.getScrape,
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
}));
vi.mock("../../lib/browser-sessions", () => ({
  insertBrowserSession: vi.fn(),
  getBrowserSession: vi.fn(),
  updateBrowserSessionActivity: vi.fn(async () => undefined),
  updateBrowserSessionCreditsUsed: mocks.updateCredits,
  updateBrowserSessionScrapeId: vi.fn(async () => undefined),
  claimBrowserSessionDestroyed: vi.fn(),
  invalidateActiveBrowserSessionCount: vi.fn(async () => undefined),
  getBrowserSessionFromScrape: mocks.getSessionFromScrape,
  markBrowserSessionUsedPrompt: vi.fn(async () => undefined),
  didBrowserSessionUsePrompt: vi.fn(),
  clearBrowserSessionPromptFlag: vi.fn(async () => undefined),
}));
vi.mock("../../lib/keyless", () => ({
  KEYLESS_CREDITS_MESSAGE: "Insufficient credits",
  adjustKeylessCredits: mocks.adjustKeyless,
  logKeylessCreditUsage: mocks.logKeyless,
  reserveKeylessCredits: mocks.reserveKeyless,
  keylessTeamUuid: vi.fn(() => null),
}));
vi.mock("../../lib/local-owner", () => ({
  isScrapeOwnedBy: (persistedTeamId: string, requestTeamId: string) =>
    persistedTeamId === requestTeamId,
}));
vi.mock("../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: mocks.activeCount,
  mirrorExternalSlotAcquire: mocks.mirrorAcquire,
  mirrorExternalSlotRelease: mocks.mirrorRelease,
}));
vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: mocks.checkCredits },
}));
vi.mock("../../lib/browser-session-activity", () => ({
  enqueueBrowserSessionActivity: vi.fn(async () => undefined),
}));
vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
}));

import { config } from "../../config";
import {
  browserExecuteRequestSchema,
  scrapeInteractController,
  scrapeStopInteractiveBrowserController,
} from "./scrape-browser";

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

function request(
  ownerId: string,
  body: unknown,
  jobId = randomUUID(),
  flags: Record<string, unknown> = {},
) {
  return {
    body,
    params: { jobId },
    path: `/v2/scrape/${jobId}/interact`,
    protocol: "http",
    get: (name: string) => (name === "host" ? "api.example.test" : undefined),
    auth: { team_id: ownerId },
    acuc: { api_key_id: randomUUID(), flags },
  } as never;
}

function replay() {
  return {
    kind: "checkpoint" as const,
    envelope: {
      version: 1 as const,
      navigationPolicyVersion: 1 as const,
      canonicalTargetUrl: "https://fixture.example/start",
      callerOrigin: "api",
      waitForMs: 0,
      browserSettings: {
        headers: {},
        cookies: [],
        viewport: {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
        },
        userAgent: "Firecrawl",
        locale: "en-US",
        location: { country: "us-generic", languages: ["en-US"] },
        proxy: { kind: "auto" as const },
        skipTlsVerification: false,
        blockAds: false,
        lockdown: true,
      },
      actions: [],
    },
    checkpoint: {
      version: 1 as const,
      statePath: "replay/owner/scrape/state.json",
      storageState: { cookies: [], origins: [] },
      finalUrl: "https://fixture.example/start",
      fingerprint: {
        finalUrl: "https://fixture.example/start",
        titleSha256: "a".repeat(64),
        bodyTextSha256: "b".repeat(64),
      },
      checksum: "c".repeat(64),
      byteSize: 32,
    },
  };
}

describe("local scrape Interact compatibility", () => {
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
    mocks.logRequest.mockResolvedValue(undefined);
    mocks.reserveKeyless.mockResolvedValue({ ok: true });
    mocks.adjustKeyless.mockResolvedValue(undefined);
    mocks.logKeyless.mockResolvedValue(undefined);
    mocks.checkCredits.mockResolvedValue(null);
    mocks.activeCount.mockResolvedValue(0);
    mocks.mirrorAcquire.mockResolvedValue(undefined);
    mocks.mirrorRelease.mockResolvedValue(undefined);
    mocks.billTeam.mockResolvedValue(undefined);
    mocks.updateCredits.mockResolvedValue(undefined);
    mocks.getSessionFromScrape.mockResolvedValue(null);
    mocks.runtime.loadReplayState.mockResolvedValue(replay());
  });

  it("accepts only bounded prompt requests and allowed domains", () => {
    expect(browserExecuteRequestSchema.safeParse({}).success).toBe(false);
    expect(
      browserExecuteRequestSchema.safeParse({ prompt: "read", code: "1" })
        .success,
    ).toBe(false);
    expect(
      browserExecuteRequestSchema.safeParse({
        prompt: "read",
        language: "node",
      }).success,
    ).toBe(true);
    expect(
      browserExecuteRequestSchema.safeParse({
        prompt: "read",
        language: "python",
      }).success,
    ).toBe(false);
    expect(
      browserExecuteRequestSchema.safeParse({
        prompt: "read",
        existingSessionId: randomUUID().toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      browserExecuteRequestSchema.safeParse({
        code: "1",
        allowedDomains: Array.from(
          { length: 9 },
          (_, index) => `d${index}.example`,
        ),
      }).success,
    ).toBe(false);
  });

  it("submits one full prompt job and returns action and turn counts", async () => {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: ownerId,
      url: "https://fixture.example/start",
      options: {},
    });
    mocks.runtime.interact.mockResolvedValue({
      session: {
        cdpUrl: "ws://api.example.test/v2/browser/proxy/cdp/cdp",
        liveViewUrl: "http://api.example.test/v2/browser/proxy/live/view",
        interactiveLiveViewUrl:
          "http://api.example.test/v2/browser/proxy/input/view",
      },
      result: {
        output: "done",
        turnCount: 3,
        actionCount: 2,
        usage: { inputTokens: 100, outputTokens: 20 },
        protocol: {
          toolEventCount: 0,
          approvalEventCount: 0,
          decisionSchemaVersion: 1,
          observationSchemaVersion: 1,
        },
      },
    });
    const res = response();
    const requestStartedAt = Date.now();

    await scrapeInteractController(
      request(ownerId, { prompt: "Read the heading" }, jobId),
      res as never,
    );

    expect(mocks.runtime.interact).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.interact).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Read the heading",
        deadline: expect.any(Date),
      }),
    );
    const submittedDeadline = mocks.runtime.interact.mock.calls[0]![0]
      .deadline as Date;
    expect(submittedDeadline.getTime()).toBeGreaterThanOrEqual(
      requestStartedAt + 30_000,
    );
    expect(submittedDeadline.getTime()).toBeLessThanOrEqual(
      Date.now() + 30_000,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      output: "done",
      turnCount: 3,
      actionCount: 2,
    });
  });

  it("maps unavailable local adapters without cloud fallback", async () => {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: ownerId,
      url: "https://fixture.example/start",
      options: {},
    });
    mocks.runtime.interact.mockRejectedValue(
      Object.assign(new Error("missing"), { category: "adapter_unavailable" }),
    );
    const res = response();

    await scrapeInteractController(
      request(ownerId, { prompt: "read" }, jobId),
      res as never,
    );

    expect(res.statusCode).toBe(503);
  });

  it("maps adapter protocol faults to a sanitized 502", async () => {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: ownerId,
      url: "https://fixture.example/start",
      options: {},
    });
    mocks.runtime.interact.mockRejectedValue(
      Object.assign(new Error("private worker detail: leaked bytes"), {
        category: "adapter_protocol_error",
      }),
    );
    const res = response();

    await scrapeInteractController(
      request(ownerId, { prompt: "read" }, jobId),
      res as never,
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      success: false,
      error: "Browser execution returned an invalid protocol result.",
    });
    expect(JSON.stringify(res.body)).not.toContain("private worker detail");
  });

  it.each([
    {
      category: "model_protocol_error",
      status: 422,
      message: "Browser model returned an invalid protocol result.",
    },
    {
      category: "action_limit_exceeded",
      status: 422,
      message: "Browser action limit was reached.",
    },
    {
      category: "concurrency_exceeded",
      status: 429,
      message: "Browser concurrency limit was reached.",
    },
  ])(
    "maps $category to a sanitized $status",
    async ({ category, status, message }) => {
      const ownerId = randomUUID();
      const jobId = randomUUID();
      mocks.getScrape.mockResolvedValue({
        id: jobId,
        team_id: ownerId,
        url: "https://fixture.example/start",
        options: {},
      });
      mocks.runtime.interact.mockRejectedValue(
        Object.assign(new Error("private execution detail"), { category }),
      );
      const res = response();

      await scrapeInteractController(
        request(ownerId, { prompt: "read" }, jobId),
        res as never,
      );

      expect(mocks.runtime.interact).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ success: false, error: message });
      expect(JSON.stringify(res.body)).not.toContain(
        "private execution detail",
      );
      expect(res.body).not.toHaveProperty("category");
    },
  );

  it("rejects cross-owner, ZDR, and unavailable replay before execution", async () => {
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const jobId = randomUUID();
    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: otherOwner,
      url: "https://fixture.example/start",
      options: {},
    });
    const forbidden = response();
    await scrapeInteractController(
      request(ownerId, { prompt: "read" }, jobId),
      forbidden as never,
    );
    expect(forbidden.statusCode).toBe(403);

    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: ownerId,
      url: "https://fixture.example/start",
      options: {},
    });
    const zdr = response();
    await scrapeInteractController(
      request(ownerId, { prompt: "read" }, jobId, { forceZDR: true }),
      zdr as never,
    );
    expect(zdr.statusCode).toBe(409);
    expect(mocks.runtime.loadReplayState).not.toHaveBeenCalled();

    mocks.runtime.loadReplayState.mockResolvedValue({
      kind: "error",
      category: "replay_unavailable",
      fields: ["checkpoint"],
      message: "private detail",
    });
    const unavailable = response();
    await scrapeInteractController(
      request(ownerId, { prompt: "read" }, jobId),
      unavailable as never,
    );
    expect(unavailable.statusCode).toBe(409);
    expect(JSON.stringify(unavailable.body)).not.toContain("private");
    expect(mocks.runtime.interact).not.toHaveBeenCalled();
  });

  it("passes owned session reuse, profile, and domain union to one prompt job", async () => {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    const existingSessionId = randomUUID();
    const baseReplay = replay();
    const replayState = {
      ...baseReplay,
      envelope: {
        ...baseReplay.envelope,
        profile: { name: "saved", saveChanges: false },
      },
    };
    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: ownerId,
      url: "https://fixture.example/start",
      options: {},
    });
    mocks.runtime.loadReplayState.mockResolvedValue(replayState);
    mocks.runtime.interact.mockResolvedValue({
      session: {
        cdpUrl: "ws://api.example.test/v2/browser/proxy/cdp/cdp",
        liveViewUrl: "http://api.example.test/v2/browser/proxy/live/view",
        interactiveLiveViewUrl:
          "http://api.example.test/v2/browser/proxy/input/view",
      },
      result: {
        output: "marker",
        turnCount: 2,
        actionCount: 1,
        usage: { inputTokens: 80, outputTokens: 12 },
        protocol: {
          toolEventCount: 1,
          approvalEventCount: 0,
          decisionSchemaVersion: 1,
          observationSchemaVersion: 1,
        },
      },
    });
    const res = response();

    await scrapeInteractController(
      request(
        ownerId,
        {
          prompt: "Read the marker",
          existingSessionId,
          allowedDomains: ["assets.example"],
        },
        jobId,
      ),
      res as never,
    );

    expect(mocks.runtime.interact).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.interact).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Read the marker",
        existingSessionId,
        allowedDomains: ["assets.example", "fixture.example"],
        profile: { name: "saved", saveChanges: false },
      }),
    );
    expect(res.body).toMatchObject({
      output: "marker",
      turnCount: 2,
      actionCount: 1,
    });
  });

  it("stops through one idempotent local runtime operation", async () => {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    mocks.runtime.stopInteract.mockResolvedValue({ stopped: true });
    const first = response();
    const second = response();

    await scrapeStopInteractiveBrowserController(
      request(ownerId, {}, jobId),
      first as never,
    );
    await scrapeStopInteractiveBrowserController(
      request(ownerId, {}, jobId),
      second as never,
    );

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(mocks.runtime.stopInteract).toHaveBeenCalledTimes(2);
  });

  it("rejects interact and stop when startup mutation admission closes", async () => {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: ownerId,
      url: "https://fixture.example/start",
      options: {},
    });
    const unavailable = Object.assign(new Error("closed"), {
      category: "browser_state_unavailable",
    });
    mocks.runtime.loadReplayState.mockRejectedValue(unavailable);
    mocks.runtime.stopInteract.mockRejectedValue(unavailable);
    const interact = response();
    const stop = response();

    await scrapeInteractController(
      request(ownerId, { prompt: "read" }, jobId),
      interact as never,
    );
    await scrapeStopInteractiveBrowserController(
      request(ownerId, {}, jobId),
      stop as never,
    );

    expect(interact.statusCode).toBe(503);
    expect(stop.statusCode).toBe(503);
    expect(mocks.runtime.interact).not.toHaveBeenCalled();
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });

  it("runs local Interact admission and finalization hooks exactly once", async () => {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    const sessionId = randomUUID();
    mocks.getScrape.mockResolvedValue({
      id: jobId,
      team_id: ownerId,
      url: "https://fixture.example/start",
      options: {},
    });
    mocks.runtime.interact.mockImplementation(async input => {
      await input.admitSession();
      const session = {
        id: sessionId,
        cdpUrl: "ws://api.example.test/v2/browser/proxy/cdp/cdp",
        liveViewUrl: "http://api.example.test/v2/browser/proxy/live/view",
        interactiveLiveViewUrl:
          "http://api.example.test/v2/browser/proxy/input/view",
      };
      await input.sessionCreated(session);
      return {
        session,
        result: {
          output: "done",
          turnCount: 1,
          actionCount: 1,
          usage: { inputTokens: 40, outputTokens: 8 },
          protocol: {
            toolEventCount: 1,
            approvalEventCount: 0,
            decisionSchemaVersion: 1,
            observationSchemaVersion: 1,
          },
        },
      };
    });
    mocks.runtime.stopInteract
      .mockResolvedValueOnce({
        stopped: true,
        sessionId,
        sessionDurationMs: 120_000,
        creditsBilled: 14,
        ttlTotalSeconds: 3_600,
      })
      .mockResolvedValueOnce({
        stopped: false,
        sessionId,
        sessionDurationMs: 120_000,
      });
    mocks.getSessionFromScrape.mockResolvedValue({
      id: sessionId,
      ttl_total: 3600,
    });

    await scrapeInteractController(
      request(ownerId, { prompt: "Read the page" }, jobId),
      response() as never,
    );
    await scrapeStopInteractiveBrowserController(
      request(ownerId, {}, jobId),
      response() as never,
    );
    await scrapeStopInteractiveBrowserController(
      request(ownerId, {}, jobId),
      response() as never,
    );

    expect(mocks.reserveKeyless).toHaveBeenCalledTimes(1);
    expect(mocks.checkCredits).not.toHaveBeenCalled();
    expect(mocks.runtime.interact).toHaveBeenCalledWith(
      expect.objectContaining({ concurrencyLimit: 2 }),
    );
    expect(mocks.activeCount).not.toHaveBeenCalled();
    expect(mocks.mirrorAcquire).not.toHaveBeenCalled();
    expect(mocks.updateCredits).not.toHaveBeenCalled();
    expect(mocks.adjustKeyless).not.toHaveBeenCalled();
    expect(mocks.logKeyless).not.toHaveBeenCalled();
    expect(mocks.billTeam).not.toHaveBeenCalled();
    expect(mocks.mirrorRelease).not.toHaveBeenCalled();
  });
});
