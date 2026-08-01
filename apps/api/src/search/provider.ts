import { config } from "../config";
import { SearchProviderUnavailableError } from "./errors";

type SearchProvider =
  | { type: "fire-engine" }
  | {
      type: "searxng";
      endpoint: string;
      engines?: string;
      categories?: string;
    };

export type SearchProviderConfig = Pick<
  typeof config,
  | "LOCAL_SEARCH_WEB_ONLY"
  | "FIRE_ENGINE_BETA_URL"
  | "SEARXNG_ENDPOINT"
  | "SEARXNG_ENGINES"
  | "SEARXNG_CATEGORIES"
>;

function configured(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// @lat: [[http#Search]]
export function resolveSearchProvider(
  values: SearchProviderConfig = config,
): SearchProvider {
  if (values.LOCAL_SEARCH_WEB_ONLY) {
    if (!configured(values.SEARXNG_ENDPOINT)) {
      throw new SearchProviderUnavailableError();
    }

    return {
      type: "searxng",
      endpoint: values.SEARXNG_ENDPOINT.trim(),
      engines: values.SEARXNG_ENGINES,
      categories: values.SEARXNG_CATEGORIES,
    };
  }

  if (configured(values.FIRE_ENGINE_BETA_URL)) {
    return { type: "fire-engine" };
  }

  if (configured(values.SEARXNG_ENDPOINT)) {
    return {
      type: "searxng",
      endpoint: values.SEARXNG_ENDPOINT.trim(),
      engines: values.SEARXNG_ENGINES,
      categories: values.SEARXNG_CATEGORIES,
    };
  }

  throw new SearchProviderUnavailableError();
}
