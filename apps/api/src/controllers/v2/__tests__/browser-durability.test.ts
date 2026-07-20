import { vi } from "vitest";

const { mocks, logger } = vi.hoisted(() => {
  const hoistedLogger = {
    child: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  hoistedLogger.child.mockReturnValue(hoistedLogger);
  return {
    logger: hoistedLogger,
    mocks: {
      getBrowserSession: vi.fn(),
      getBrowserSessionFromScrape: vi.fn(),
      updateBrowserSessionActivity: vi.fn(),
      markBrowserSessionUsedPrompt: vi.fn(),
      browserServiceRequest: vi.fn(),
      fetch: vi.fn(),
      executePromptViaBrowserAgent: vi.fn(),
      executeCodeViaBrowserSession: vi.fn(),
      enqueueBrowserSessionActivity: vi.fn(),
      supabaseGetScrapeById: vi.fn(),
    },
  };
});

vi.mock("../../../config", () => ({
  config: { BROWSER_SERVICE_URL: "http://browser-service.test" },
}));
vi.mock("../../../lib/logger", () => ({ logger }));
vi.mock("../../../lib/browser-sessions", () => ({
  getBrowserSession: mocks.getBrowserSession,
  getBrowserSessionFromScrape: mocks.getBrowserSessionFromScrape,
  updateBrowserSessionActivity: mocks.updateBrowserSessionActivity,
  markBrowserSessionUsedPrompt: mocks.markBrowserSessionUsedPrompt,
}));
vi.mock("../../../lib/browser-session-activity", () => ({
  enqueueBrowserSessionActivity: mocks.enqueueBrowserSessionActivity,
}));
vi.mock("../../../lib/scrape-interact/browser-service-client", () => ({
  browserServiceRequest: mocks.browserServiceRequest,
  BrowserServiceError: class BrowserServiceError extends Error {},
}));
vi.mock("../../../lib/scrape-interact/browser-agent", () => ({
  executePromptViaBrowserAgent: mocks.executePromptViaBrowserAgent,
  executeCodeViaBrowserSession: mocks.executeCodeViaBrowserSession,
}));
vi.mock("../../../lib/scrape-interact/scrape-replay", () => ({
  buildReplayContextFromScrape: () => ({
    context: {
      targetUrl: "https://example.com",
      waitForMs: 0,
      actions: [],
    },
  }),
  estimateReplayTimeoutSeconds: vi.fn(),
  buildReplayScript: vi.fn(),
}));
vi.mock("../../../lib/scrape-interact/langsmith", () => ({
  sanitizeUrlForTrace: (url: string) => url,
}));
vi.mock("../../../lib/zdr-helpers", () => ({
  getScrapeZDR: () => "disabled",
}));
vi.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetScrapeById: mocks.supabaseGetScrapeById,
}));
vi.mock("../../../lib/local-owner", () => ({
  isScrapeOwnedBy: (ownerId: string, requesterId: string) =>
    ownerId === requesterId,
  createLocalOwnerAuthenticator: () => vi.fn(),
}));
vi.mock("../../../lib/concurrency-limit", () => ({}));
vi.mock("../../../services/redis", () => ({
  deleteKey: vi.fn(),
  getValue: vi.fn(),
  setValue: vi.fn(),
}));
vi.mock("../../../services/worker/nuq-router", () => ({
  getCombinedTeamActiveCount: vi.fn(),
  mirrorExternalSlotAcquire: vi.fn(),
  mirrorExternalSlotRelease: vi.fn(),
}));
vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(),
}));
vi.mock("../../../lib/keyless", () => ({
  KEYLESS_CREDITS_MESSAGE: "credits",
  adjustKeylessCredits: vi.fn(),
  logKeylessCreditUsage: vi.fn(),
  reserveKeylessCredits: vi.fn(),
}));
vi.mock("../../../services/logging/log_job", () => ({ logRequest: vi.fn() }));
vi.mock("../../../services/autumn/autumn.service", () => ({
  autumnService: {},
}));
vi.mock("../../../lib/agent-auth-discovery", () => ({
  applyAgentAuthDiscoveryHeader: vi.fn(),
}));

import { browserExecuteController } from "../browser";
import { scrapeInteractController } from "../scrape-browser";

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

const session = {
  id: "1e94019b-6791-4370-bd00-e4c096f86427",
  team_id: "75dd7306-7bb8-4122-b6bb-11453336ce46",
  browser_id: "browser-1",
  cdp_url: "ws://browser.test/cdp",
  cdp_path: "/view",
  cdp_interactive_path: "/interactive",
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
  logger.child.mockReturnValue(logger);
  mocks.getBrowserSession.mockResolvedValue(session);
  mocks.getBrowserSessionFromScrape.mockResolvedValue(session);
  mocks.updateBrowserSessionActivity.mockResolvedValue(undefined);
  mocks.markBrowserSessionUsedPrompt.mockResolvedValue(undefined);
  mocks.browserServiceRequest.mockResolvedValue({
    stdout: "ok",
    result: "ok",
    stderr: "",
    exitCode: 0,
    killed: false,
  });
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      stdout: "ok",
      result: "ok",
      stderr: "",
      exitCode: 0,
      killed: false,
    }),
  });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.executePromptViaBrowserAgent.mockResolvedValue({
    output: "done",
    stdout: "done",
    stderr: "",
    exitCode: 0,
    killed: false,
  });
  mocks.executeCodeViaBrowserSession.mockResolvedValue({
    stdout: "done",
    result: "done",
    stderr: "",
    exitCode: 0,
    killed: false,
  });
  mocks.enqueueBrowserSessionActivity.mockResolvedValue(undefined);
  mocks.supabaseGetScrapeById.mockResolvedValue({
    id: "bd289d51-c81a-4f21-bf13-865becc93a2a",
    team_id: session.team_id,
    url: "https://example.com",
    options: {},
  });
});

it("waits for durable browser activity before returning success", async () => {
  let release!: () => void;
  const durable = new Promise<void>(resolve => {
    release = resolve;
  });
  mocks.enqueueBrowserSessionActivity.mockReturnValueOnce(durable);
  const res = response();
  const pending = browserExecuteController(
    {
      params: { sessionId: session.id },
      body: { code: "return 1", language: "node", timeout: 30 },
      auth: { team_id: session.team_id },
    } as never,
    res as never,
  );
  await vi.waitFor(() =>
    expect(mocks.enqueueBrowserSessionActivity).toHaveBeenCalledOnce(),
  );
  expect(res.json).not.toHaveBeenCalled();
  release();
  await pending;
  expect(res.status).toHaveBeenCalledWith(200);
});

it("propagates durable browser activity failures before responding", async () => {
  const failure = new Error("activity insert failed");
  const rejected = Promise.reject(failure);
  rejected.catch(() => undefined);
  mocks.enqueueBrowserSessionActivity.mockReturnValueOnce(rejected);
  const res = response();

  await expect(
    browserExecuteController(
      {
        params: { sessionId: session.id },
        body: { code: "return 1", language: "node", timeout: 30 },
        auth: { team_id: session.team_id },
      } as never,
      res as never,
    ),
  ).rejects.toBe(failure);
  expect(res.json).not.toHaveBeenCalled();
});

it("fails closed before prompt execution when billing persistence fails", async () => {
  const failure = new Error("prompt accounting failed");
  mocks.markBrowserSessionUsedPrompt.mockRejectedValueOnce(failure);
  const res = response();

  await expect(
    scrapeInteractController(
      {
        params: { jobId: "bd289d51-c81a-4f21-bf13-865becc93a2a" },
        body: { prompt: "inspect page", language: "node", timeout: 30 },
        auth: { team_id: session.team_id },
        acuc: { flags: {} },
      } as never,
      res as never,
    ),
  ).rejects.toBe(failure);
  expect(mocks.executePromptViaBrowserAgent).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
});

it("propagates durable Interact activity failures before responding", async () => {
  const failure = new Error("interact activity insert failed");
  const rejected = Promise.reject(failure);
  rejected.catch(() => undefined);
  mocks.enqueueBrowserSessionActivity.mockReturnValueOnce(rejected);
  const res = response();

  await expect(
    scrapeInteractController(
      {
        params: { jobId: "bd289d51-c81a-4f21-bf13-865becc93a2a" },
        body: { prompt: "inspect page", language: "node", timeout: 30 },
        auth: { team_id: session.team_id },
        acuc: { flags: {} },
      } as never,
      res as never,
    ),
  ).rejects.toBe(failure);
  expect(res.json).not.toHaveBeenCalled();
});

it("propagates durable code activity failures before responding", async () => {
  const failure = new Error("code activity insert failed");
  const rejected = Promise.reject(failure);
  rejected.catch(() => undefined);
  mocks.enqueueBrowserSessionActivity.mockReturnValueOnce(rejected);
  const res = response();

  await expect(
    scrapeInteractController(
      {
        params: { jobId: "bd289d51-c81a-4f21-bf13-865becc93a2a" },
        body: { code: "return 1", language: "node", timeout: 30 },
        auth: { team_id: session.team_id },
        acuc: { flags: {} },
      } as never,
      res as never,
    ),
  ).rejects.toBe(failure);
  expect(mocks.executeCodeViaBrowserSession).toHaveBeenCalledOnce();
  expect(mocks.markBrowserSessionUsedPrompt).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
});
