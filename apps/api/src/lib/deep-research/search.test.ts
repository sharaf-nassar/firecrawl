import type { Logger } from "winston";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchResult } from "../../lib/entities";
import {
  SEARCH_PROVIDER_WARNING,
  SearchProviderBadResponseError,
  SearchProviderUnavailableError,
} from "../../search/errors";
import { searchAndScrapeSearchResult } from "./search";

const { providerSearch, scrapeSearchResults } = vi.hoisted(() => ({
  providerSearch: vi.fn(),
  scrapeSearchResults: vi.fn(),
}));

vi.mock("../../search", () => ({
  search: providerSearch,
}));

vi.mock("../../search/scrape", () => ({
  scrapeSearchResults,
}));

const logger = {} as Logger;
const options = {
  teamId: "team",
  origin: "deep-research",
  timeout: 10_000,
  scrapeOptions: { formats: ["markdown"] },
  apiKeyId: null,
  requestId: "research-id",
};

describe("deep-research search provider semantics", () => {
  beforeEach(() => {
    providerSearch.mockReset();
    scrapeSearchResults.mockReset();
  });

  // @lat: [[tests#Internal search consumers#Deep research#Errors propagate]]
  it("bubbles canonical and unexpected errors unchanged with one execution", async () => {
    const errors = [
      new SearchProviderUnavailableError(),
      new SearchProviderBadResponseError(),
      new Error("unexpected"),
    ];

    for (const error of errors) {
      providerSearch.mockRejectedValueOnce(error);

      await expect(
        searchAndScrapeSearchResult("query", options, logger, null),
      ).rejects.toBe(error);
      expect(providerSearch).toHaveBeenCalledTimes(1);
      expect(scrapeSearchResults).not.toHaveBeenCalled();
      providerSearch.mockClear();
    }

    const scrapeError = new Error("unexpected scrape failure");
    providerSearch.mockResolvedValueOnce([
      new SearchResult("https://example.com", "Example", "Provider result"),
    ]);
    scrapeSearchResults.mockRejectedValueOnce(scrapeError);

    await expect(
      searchAndScrapeSearchResult("query", options, logger, null),
    ).rejects.toBe(scrapeError);
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(scrapeSearchResults).toHaveBeenCalledOnce();
  });

  // @lat: [[tests#Internal search consumers#Deep research#Valid empty]]
  it("preserves a valid empty result with one provider execution", async () => {
    providerSearch.mockResolvedValueOnce([]);
    scrapeSearchResults.mockResolvedValueOnce([]);

    await expect(
      searchAndScrapeSearchResult("query", options, logger, null),
    ).resolves.toEqual({ documents: [] });
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(scrapeSearchResults).toHaveBeenCalledOnce();
    expect(scrapeSearchResults.mock.calls[0][0]).toEqual([]);
  });

  // @lat: [[tests#Internal search consumers#Deep research#Partial warning]]
  it("preserves only the sanitized partial warning with one execution", async () => {
    providerSearch.mockImplementationOnce(async searchOptions => {
      searchOptions.onWarning?.(SEARCH_PROVIDER_WARNING);
      return [
        new SearchResult("https://example.com", "Example", "Provider result"),
      ];
    });
    const documents = [
      {
        document: { url: "https://example.com" },
        costTracking: {},
      },
    ];
    scrapeSearchResults.mockResolvedValueOnce(documents);

    await expect(
      searchAndScrapeSearchResult("query", options, logger, null),
    ).resolves.toEqual({
      documents,
      warning: SEARCH_PROVIDER_WARNING,
    });
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(scrapeSearchResults).toHaveBeenCalledOnce();
  });
});
