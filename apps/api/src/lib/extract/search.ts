import type { Logger } from "winston";
import { searchForInternalConsumer } from "../../search/internal";

// @lat: [[http#Internal search consumers]]
export async function discoverExtractionUrls(query: string, logger: Logger) {
  const { results, warning } = await searchForInternalConsumer({
    query,
    logger,
    num_results: 10,
  });

  return {
    urls: results.map(result => result.url),
    ...(warning ? { warning } : {}),
  };
}
