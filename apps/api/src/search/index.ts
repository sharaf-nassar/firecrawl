import { SearchResult } from "../../src/lib/entities";
import { searxng_search } from "./searxng";
import { fire_engine_search } from "./fireEngine";
import { Logger } from "winston";
import { resolveSearchProvider } from "./provider";
import { SEARCH_PROVIDER_WARNING, splitSearchProviderResponse } from "./errors";

type LegacySearchResponse = SearchResult[] & {
  warning?: typeof SEARCH_PROVIDER_WARNING;
};

export async function search({
  query,
  logger,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  onWarning,
}: {
  query: string;
  logger: Logger;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  onWarning?: (warning: typeof SEARCH_PROVIDER_WARNING) => void;
}): Promise<LegacySearchResponse> {
  const provider = resolveSearchProvider();
  if (provider.type === "fire-engine") {
    logger.info("Using fire engine search");
    return fire_engine_search(query, {
      numResults: num_results,
      tbs,
      filter,
      lang,
      country,
      location,
    });
  }

  logger.info("Using searxng search");
  const providerResponse = await searxng_search(query, {
    endpoint: provider.endpoint,
    engines: provider.engines,
    categories: provider.categories,
    num_results,
    lang,
  });
  const { data: results, warning } =
    splitSearchProviderResponse(providerResponse);
  if (warning) onWarning?.(warning);
  const mappedResults = (results.web?.map(
    result => new SearchResult(result.url, result.title, result.description),
  ) ?? []) as LegacySearchResponse;
  if (warning) mappedResults.warning = warning;
  return mappedResults;
}
