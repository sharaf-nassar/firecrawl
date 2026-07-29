import { describe, expect, it } from "vitest";

import {
  batchScrapeRequestSchema,
  projectBaseScrapeOptions,
  scrapeRequestSchema,
} from "../types";

describe("v2 scrape option projection", () => {
  it("keeps only base scrape options from a single scrape request", () => {
    const request = scrapeRequestSchema.parse({
      url: "https://example.test",
      origin: "mcp-fastmcp",
      integration: "cli",
      waitFor: 1_000,
      mobile: true,
    });

    const options = projectBaseScrapeOptions(request);

    expect(options).toMatchObject({
      waitFor: 1_000,
      mobile: true,
    });
    expect(options).not.toHaveProperty("url");
    expect(options).not.toHaveProperty("origin");
    expect(options).not.toHaveProperty("integration");
  });

  it("keeps only base scrape options from a batch scrape request", () => {
    const request = batchScrapeRequestSchema.parse({
      urls: ["https://example.test"],
      origin: "api",
      integration: "cli",
      appendToId: "11111111-1111-4111-8111-111111111111",
      headers: { "x-test": "value" },
    });

    const options = projectBaseScrapeOptions(request);

    expect(options).toMatchObject({
      headers: { "x-test": "value" },
    });
    expect(options).not.toHaveProperty("urls");
    expect(options).not.toHaveProperty("origin");
    expect(options).not.toHaveProperty("integration");
    expect(options).not.toHaveProperty("appendToId");
  });
});
