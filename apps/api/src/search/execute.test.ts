import type { Logger } from "winston";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SEARCH_PROVIDER_WARNING,
  SearchProviderBadResponseError,
  SearchProviderUnavailableError,
} from "./errors";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  scrapeSearchResults: vi.fn(),
  trackSearchRequest: vi.fn(),
  trackSearchResults: vi.fn(),
}));

vi.mock("./v2", () => ({ search: mocks.search }));
vi.mock("./scrape", () => ({
  getItemsToScrape: vi.fn(() => []),
  scrapeSearchResults: mocks.scrapeSearchResults,
  mergeScrapedContent: vi.fn(),
  calculateScrapeCredits: vi.fn(() => 0),
}));
vi.mock("./highlights", () => ({
  applySearchHighlights: vi.fn(),
  highlightsEnvReady: vi.fn(() => false),
}));
vi.mock("../lib/tracking", () => ({
  trackSearchRequest: mocks.trackSearchRequest,
  trackSearchResults: mocks.trackSearchResults,
}));

import { executeSearch } from "./execute";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function options(scrape = false) {
  return {
    query: "redacted-query",
    limit: 5,
    sources: [{ type: "web" }],
    scrapeOptions: scrape
      ? ({ formats: [{ type: "markdown" }] } as never)
      : undefined,
    timeout: 60_000,
  };
}

const context = {
  teamId: "team-id",
  origin: "api",
  apiKeyId: 1,
  flags: null,
  requestId: "request-id",
  jobId: "job-id",
  apiVersion: "v2",
};

describe("executeSearch provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trackSearchRequest.mockResolvedValue(undefined);
    mocks.trackSearchResults.mockResolvedValue(undefined);
  });

  // @lat: [[tests#API Test Organization#Unit and component tests]]
  it.each([
    new SearchProviderUnavailableError(),
    new SearchProviderBadResponseError(),
  ])(
    "propagates %s without scrape dispatch or success tracking",
    async error => {
      mocks.search.mockRejectedValueOnce(error);

      await expect(executeSearch(options(true), context, logger)).rejects.toBe(
        error,
      );
      expect(mocks.scrapeSearchResults).not.toHaveBeenCalled();
      expect(mocks.trackSearchRequest).not.toHaveBeenCalled();
      expect(mocks.trackSearchResults).not.toHaveBeenCalled();
    },
  );

  it("lifts sanitized provider warnings out of result data", async () => {
    mocks.search.mockResolvedValueOnce({
      web: [
        {
          url: "https://example.test",
          title: "Example",
          description: "Result",
        },
      ],
      warning: SEARCH_PROVIDER_WARNING,
    });

    const result = await executeSearch(options(), context, logger);

    expect(result.warning).toBe(SEARCH_PROVIDER_WARNING);
    expect(result.response).not.toHaveProperty("warning");
    expect(result.searchCredits).toBe(2);
  });

  it("preserves valid empty results as zero-credit success without scraping", async () => {
    mocks.search.mockResolvedValueOnce({});

    const result = await executeSearch(options(true), context, logger);

    expect(result).toMatchObject({
      response: {},
      totalResultsCount: 0,
      searchCredits: 0,
      scrapeCredits: 0,
      totalCredits: 0,
    });
    expect(mocks.scrapeSearchResults).not.toHaveBeenCalled();
  });
});
