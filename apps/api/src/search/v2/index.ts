import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "../searxng";
import { resolveSearchProvider } from "../provider";
import { Logger } from "winston";

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
  type = undefined,
  enterprise = undefined,
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
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
}): Promise<SearchV2Response> {
  const provider = resolveSearchProvider();
  if (provider.type === "fire-engine") {
    logger.info("Using fire engine search");
    return fire_engine_search_v2(query, {
      numResults: num_results,
      tbs,
      filter,
      lang,
      country,
      location,
      type,
      enterprise,
    });
  }

  logger.info("Using searxng search");
  return searxng_search(query, {
    endpoint: provider.endpoint,
    engines: provider.engines,
    categories: provider.categories,
    num_results,
    lang,
  });
}
