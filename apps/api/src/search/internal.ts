import type { SearchResult } from "../lib/entities";
import { SEARCH_PROVIDER_WARNING } from "./errors";
import { search } from "./index";

type InternalSearchOptions = Omit<Parameters<typeof search>[0], "onWarning">;

type InternalSearchResponse = {
  results: SearchResult[];
  warning?: typeof SEARCH_PROVIDER_WARNING;
};

// @lat: [[http#Internal search consumers]]
export async function searchForInternalConsumer(
  options: InternalSearchOptions,
): Promise<InternalSearchResponse> {
  let warning: typeof SEARCH_PROVIDER_WARNING | undefined;
  const results = await search({
    ...options,
    onWarning: providerWarning => {
      warning = providerWarning;
    },
  });

  return {
    results,
    ...(warning ? { warning } : {}),
  };
}
