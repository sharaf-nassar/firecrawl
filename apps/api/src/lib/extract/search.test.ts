import type { Logger } from "winston";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchResult } from "../../lib/entities";
import {
  SEARCH_PROVIDER_WARNING,
  SearchProviderBadResponseError,
  SearchProviderUnavailableError,
} from "../../search/errors";
import { discoverExtractionUrls } from "./search";

const { providerSearch } = vi.hoisted(() => ({
  providerSearch: vi.fn(),
}));

vi.mock("../../search", () => ({
  search: providerSearch,
}));

const logger = {} as Logger;

describe("extraction search provider semantics", () => {
  beforeEach(() => {
    providerSearch.mockReset();
  });

  // @lat: [[tests#Internal search consumers#Extraction#Errors propagate]]
  it("bubbles canonical and unexpected errors unchanged with one execution", async () => {
    const errors = [
      new SearchProviderUnavailableError(),
      new SearchProviderBadResponseError(),
      new Error("unexpected"),
    ];

    for (const error of errors) {
      providerSearch.mockRejectedValueOnce(error);

      await expect(discoverExtractionUrls("query", logger)).rejects.toBe(error);
      expect(providerSearch).toHaveBeenCalledTimes(1);
      providerSearch.mockClear();
    }
  });

  // @lat: [[tests#Internal search consumers#Extraction#Valid empty]]
  it("preserves a valid empty result with one provider execution", async () => {
    providerSearch.mockResolvedValueOnce([]);

    await expect(discoverExtractionUrls("query", logger)).resolves.toEqual({
      urls: [],
    });
    expect(providerSearch).toHaveBeenCalledTimes(1);
  });

  // @lat: [[tests#Internal search consumers#Extraction#Partial warning]]
  it("preserves only the sanitized partial warning with one execution", async () => {
    providerSearch.mockImplementationOnce(async options => {
      options.onWarning?.(SEARCH_PROVIDER_WARNING);
      return [
        new SearchResult("https://example.com", "Example", "Provider result"),
      ];
    });

    await expect(discoverExtractionUrls("query", logger)).resolves.toEqual({
      urls: ["https://example.com"],
      warning: SEARCH_PROVIDER_WARNING,
    });
    expect(providerSearch).toHaveBeenCalledTimes(1);
  });
});
