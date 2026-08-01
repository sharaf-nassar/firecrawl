import type { Logger } from "winston";
import type { DocumentWithCostTracking } from "../../search/scrape";
import { searchForInternalConsumer } from "../../search/internal";
import { scrapeSearchResults } from "../../search/scrape";
import { fromV1ScrapeOptions } from "../../controllers/v2/types";

// @lat: [[http#Internal search consumers]]
export async function searchAndScrapeSearchResult(
  query: string,
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: any;
    apiKeyId: number | null;
    requestId?: string;
  },
  logger: Logger,
  flags: any,
) {
  const { results: searchResults, warning } = await searchForInternalConsumer({
    query,
    logger,
    num_results: 5,
  });

  const { scrapeOptions } = fromV1ScrapeOptions(
    options.scrapeOptions,
    options.timeout,
    options.teamId,
  );

  const documents: DocumentWithCostTracking[] = await scrapeSearchResults(
    searchResults.map(result => ({
      url: result.url,
      title: result.title,
      description: result.description,
    })),
    {
      teamId: options.teamId,
      origin: options.origin,
      timeout: options.timeout,
      scrapeOptions,
      apiKeyId: options.apiKeyId,
      requestId: options.requestId,
    },
    logger,
    flags,
  );

  return {
    documents,
    ...(warning ? { warning } : {}),
  };
}
