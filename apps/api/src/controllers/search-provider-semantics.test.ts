import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SEARCH_PROVIDER_BAD_RESPONSE_MESSAGE,
  SEARCH_PROVIDER_UNAVAILABLE_MESSAGE,
  SEARCH_PROVIDER_WARNING,
  SearchProviderBadResponseError,
  SearchProviderUnavailableError,
} from "../search/errors";
import { LOCAL_SEARCH_WEB_ONLY_MESSAGE } from "../search/capabilities";

const mocks = vi.hoisted(() => {
  const logger: Record<string, ReturnType<typeof vi.fn>> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockImplementation(() => logger);

  return {
    logger,
    authenticateUser: vi.fn(),
    billTeam: vi.fn(),
    checkTeamCredits: vi.fn(),
    legacySearch: vi.fn(),
    executeSearch: vi.fn(),
    reserveKeyless: vi.fn(),
    adjustKeyless: vi.fn(),
    logKeyless: vi.fn(),
    logRequest: vi.fn(),
    logSearch: vi.fn(),
    addScrapeJob: vi.fn(),
    waitForJob: vi.fn(),
    captureException: vi.fn(),
    captureExceptionWithZdrCheck: vi.fn(),
  };
});

vi.mock("./auth", () => ({ authenticateUser: mocks.authenticateUser }));
vi.mock("../services/billing/credit_billing", () => ({
  billTeam: mocks.billTeam,
  checkTeamCredits: mocks.checkTeamCredits,
}));
vi.mock("../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logSearch: mocks.logSearch,
}));
vi.mock("../search", () => ({ search: mocks.legacySearch }));
vi.mock("../search/execute", () => ({ executeSearch: mocks.executeSearch }));
vi.mock("../lib/logger", () => ({ logger: mocks.logger }));
vi.mock("../services/redis", () => ({
  redisEvictConnection: { sadd: vi.fn(() => Promise.resolve()) },
}));
vi.mock("../../src/services/redis", () => ({
  redisEvictConnection: { sadd: vi.fn(() => Promise.resolve()) },
}));
vi.mock("../services/queue-jobs", () => ({
  addScrapeJob: mocks.addScrapeJob,
  waitForJob: mocks.waitForJob,
}));
vi.mock("../services/worker/nuq-router", () => ({
  scrapeQueue: { removeJobs: vi.fn() },
}));
vi.mock("../lib/job-priority", () => ({
  getJobPriority: vi.fn(() => Promise.resolve(1)),
}));
vi.mock("../lib/keyless", () => ({
  KEYLESS_CREDITS_MESSAGE: "Insufficient credits",
  reserveKeylessCredits: mocks.reserveKeyless,
  adjustKeylessCredits: mocks.adjustKeyless,
  logKeylessCreditUsage: mocks.logKeyless,
}));
vi.mock("../services/sentry", () => ({
  applyZdrScope: vi.fn(),
  captureExceptionWithZdrCheck: mocks.captureExceptionWithZdrCheck,
}));
vi.mock("../lib/agent-auth-discovery", () => ({
  applyAgentAuthDiscoveryHeader: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  captureException: mocks.captureException,
}));
vi.mock("ioredis", () => {
  class Redis {
    status = "ready";

    on() {
      return this;
    }

    sadd() {
      return Promise.resolve();
    }
  }

  return { default: Redis, Redis };
});

import { config } from "../config";
import { searchController as searchControllerV0 } from "./v0/search";
import { searchController as searchControllerV1 } from "./v1/search";
import { searchController as searchControllerV2 } from "./v2/search";

type Version = "v0" | "v1" | "v2";

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
  version: Version,
  bodyOverrides: Record<string, unknown> = {},
) {
  if (version === "v0") {
    const searchOptions =
      bodyOverrides.searchOptions &&
      typeof bodyOverrides.searchOptions === "object" &&
      !Array.isArray(bodyOverrides.searchOptions)
        ? (bodyOverrides.searchOptions as Record<string, unknown>)
        : {};
    return {
      body: {
        query: "private query",
        origin: "api",
        pageOptions: { fetchPageContent: false },
        ...bodyOverrides,
        searchOptions: { limit: 5, ...searchOptions },
      },
    } as never;
  }

  return {
    body: {
      query: "private query",
      origin: "api",
      limit: 5,
      ...(version === "v2" ? { sources: [{ type: "web" }] } : {}),
      scrapeOptions: { formats: [] },
      ...bodyOverrides,
    },
    auth: { team_id: "team-id" },
    acuc: { api_key_id: 1, sub_id: "subscription-id", flags: {} },
  } as never;
}

function successfulResult(
  responseData: Record<string, unknown>,
  warning?: typeof SEARCH_PROVIDER_WARNING,
) {
  const result = {
    response: responseData,
    totalResultsCount: responseData.web ? 1 : 0,
    searchCredits: responseData.web ? 2 : 0,
    scrapeCredits: 0,
    totalCredits: responseData.web ? 2 : 0,
    shouldScrape: false,
  };
  return warning ? { ...result, warning } : result;
}

async function invoke(
  version: Version,
  bodyOverrides: Record<string, unknown> = {},
) {
  const res = response();
  const req = request(version, bodyOverrides);
  if (version === "v0") await searchControllerV0(req, res as never);
  if (version === "v1") await searchControllerV1(req, res as never);
  if (version === "v2") await searchControllerV2(req, res as never);
  return res;
}

function searchBodyOverride(
  version: Version,
  options: Record<string, unknown>,
): Record<string, unknown> {
  return version === "v0" ? { searchOptions: options } : options;
}

function unsupportedLocalRequests(version: Version) {
  return [
    {
      name: "image source",
      body: searchBodyOverride(version, { sources: [{ type: "images" }] }),
    },
    {
      name: "news source",
      body: searchBodyOverride(version, { sources: ["news"] }),
    },
    {
      name: "country targeting",
      body: searchBodyOverride(version, { country: "ca" }),
    },
    {
      name: "location targeting",
      body: searchBodyOverride(version, { location: "Toronto, Ontario" }),
    },
    {
      name: "recency filter",
      body: searchBodyOverride(version, { tbs: "qdr:d" }),
    },
    {
      name: "nested web recency filter",
      body: searchBodyOverride(version, {
        sources: [{ type: "web", tbs: "qdr:d" }],
      }),
    },
    {
      name: "enterprise mode",
      body: searchBodyOverride(version, { enterprise: ["zdr"] }),
    },
    {
      name: "feedback option",
      body: searchBodyOverride(version, { feedback: { rating: "good" } }),
    },
  ];
}

function rejectProvider(version: Version, error: Error) {
  if (version === "v0") mocks.legacySearch.mockRejectedValueOnce(error);
  else mocks.executeSearch.mockRejectedValueOnce(error);
}

describe.each<Version>(["v0", "v1", "v2"])(
  "%s ordinary search provider semantics",
  version => {
    beforeEach(() => {
      vi.clearAllMocks();
      (config as { LOCAL_SEARCH_WEB_ONLY: boolean }).LOCAL_SEARCH_WEB_ONLY =
        false;
      mocks.authenticateUser.mockResolvedValue({
        success: true,
        team_id: "team-id",
        chunk: { api_key_id: 1, sub_id: "subscription-id", flags: {} },
      });
      mocks.checkTeamCredits.mockResolvedValue({
        success: true,
        message: "",
      });
      mocks.reserveKeyless.mockResolvedValue({ ok: true });
      mocks.adjustKeyless.mockResolvedValue(undefined);
      mocks.logKeyless.mockResolvedValue(undefined);
      mocks.logRequest.mockResolvedValue(undefined);
      mocks.billTeam.mockResolvedValue(undefined);
    });

    // @lat: [[tests#API Test Organization#HTTP and controller tests]]
    it.each([
      {
        error: new SearchProviderUnavailableError({
          cause: new Error(
            "https://provider.internal/search?q=private%20query&key=secret",
          ),
        }),
        status: 503,
        code: "SEARCH_PROVIDER_UNAVAILABLE",
        message: SEARCH_PROVIDER_UNAVAILABLE_MESSAGE,
      },
      {
        error: new SearchProviderBadResponseError({
          cause: new Error(
            "https://provider.internal/search?q=private%20query&key=secret",
          ),
        }),
        status: 502,
        code: "SEARCH_PROVIDER_BAD_RESPONSE",
        message: SEARCH_PROVIDER_BAD_RESPONSE_MESSAGE,
      },
    ])(
      "returns exact $status provider envelope without billing",
      async test => {
        rejectProvider(version, test.error);

        const res = await invoke(version);

        expect(res.statusCode).toBe(test.status);
        expect(res.body).toEqual({
          success: false,
          code: test.code,
          error: test.message,
        });
        expect(mocks.billTeam).not.toHaveBeenCalled();
        expect(mocks.addScrapeJob).not.toHaveBeenCalled();
        expect(mocks.captureException).not.toHaveBeenCalled();
        expect(mocks.captureExceptionWithZdrCheck).not.toHaveBeenCalled();
        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
          "Search provider request failed",
          { code: test.code },
        );
        expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
          "private query",
        );
        expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
          "provider.internal",
        );
        expect(JSON.stringify(mocks.logger.child.mock.calls)).not.toContain(
          "private query",
        );
        if (version !== "v0") {
          expect(mocks.reserveKeyless).toHaveBeenCalledOnce();
          expect(mocks.adjustKeyless).toHaveBeenCalledWith("team-id", -2);
        }
      },
    );

    it.each(unsupportedLocalRequests(version))(
      "rejects local $name before reservation or provider work",
      async ({ body }) => {
        (config as { LOCAL_SEARCH_WEB_ONLY: boolean }).LOCAL_SEARCH_WEB_ONLY =
          true;

        const res = await invoke(version, body);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
          success: false,
          code: "BAD_REQUEST",
          error: LOCAL_SEARCH_WEB_ONLY_MESSAGE,
        });
        expect(mocks.reserveKeyless).not.toHaveBeenCalled();
        expect(mocks.checkTeamCredits).not.toHaveBeenCalled();
        expect(mocks.legacySearch).not.toHaveBeenCalled();
        expect(mocks.executeSearch).not.toHaveBeenCalled();
        expect(mocks.billTeam).not.toHaveBeenCalled();
      },
    );

    it("accepts supported local web, filter, language, and scrape inputs", async () => {
      (config as { LOCAL_SEARCH_WEB_ONLY: boolean }).LOCAL_SEARCH_WEB_ONLY =
        true;
      if (version === "v0") {
        mocks.legacySearch.mockResolvedValueOnce([]);
      } else {
        mocks.executeSearch.mockResolvedValueOnce(successfulResult({}));
      }
      const body =
        version === "v0"
          ? {
              searchOptions: { filter: "site:example.test", lang: "fr" },
              pageOptions: { fetchPageContent: false, includeHtml: true },
            }
          : version === "v1"
            ? {
                filter: "site:example.test",
                lang: "fr",
                scrapeOptions: { formats: [] },
              }
            : {
                sources: [{ type: "web", filter: "site:example.test" }],
                categories: ["pdf"],
                includeDomains: ["example.test"],
                lang: "fr",
                scrapeOptions: { formats: [] },
              };

      const res = await invoke(version, body);

      expect(res.statusCode).toBe(200);
      if (version === "v0") {
        expect(mocks.checkTeamCredits).toHaveBeenCalledOnce();
        expect(mocks.legacySearch).toHaveBeenCalledOnce();
      } else {
        expect(mocks.reserveKeyless).toHaveBeenCalledOnce();
        expect(mocks.executeSearch).toHaveBeenCalledOnce();
      }
    });

    it("returns partial diagnostics only as an exact top-level warning", async () => {
      const web = [
        {
          url: "https://example.test",
          title: "Example",
          description: "Result",
        },
      ];
      if (version === "v0") {
        const legacy = [...web] as typeof web & { warning?: string };
        legacy.warning = SEARCH_PROVIDER_WARNING;
        mocks.legacySearch.mockResolvedValueOnce(legacy);
      } else {
        mocks.executeSearch.mockResolvedValueOnce(
          successfulResult({ web }, SEARCH_PROVIDER_WARNING),
        );
      }

      const res = await invoke(version);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        warning: SEARCH_PROVIDER_WARNING,
      });
      expect((res.body as any).data).not.toHaveProperty("warning");
    });

    it("returns valid empty success with zero credits and no billing", async () => {
      if (version === "v0") mocks.legacySearch.mockResolvedValueOnce([]);
      else mocks.executeSearch.mockResolvedValueOnce(successfulResult({}));

      const res = await invoke(version);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body).not.toHaveProperty("warning");
      expect(mocks.billTeam).not.toHaveBeenCalled();
      expect(mocks.addScrapeJob).not.toHaveBeenCalled();
      if (version === "v2") {
        expect(res.body).toMatchObject({ creditsUsed: 0 });
      }
      if (version !== "v0") {
        expect(mocks.adjustKeyless).toHaveBeenCalledWith("team-id", -2);
        expect(mocks.logKeyless).toHaveBeenCalledWith("team-id", 0);
      }
    });
  },
);
