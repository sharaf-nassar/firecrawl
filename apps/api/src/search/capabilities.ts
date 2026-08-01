import { config } from "../config";

export const LOCAL_SEARCH_WEB_ONLY_MESSAGE =
  "Local search supports web results only.";

class LocalSearchCapabilityError extends Error {
  constructor() {
    super(LOCAL_SEARCH_WEB_ONLY_MESSAGE);
    this.name = "LocalSearchCapabilityError";
  }
}

function sourceType(source: unknown): unknown {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    return (source as Record<string, unknown>).type;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const unsupportedSearchOptionKeys = [
  "tbs",
  "country",
  "location",
  "enterprise",
  "feedback",
] as const;

function requestsUnsupportedOptions(body: Record<string, unknown>): boolean {
  return unsupportedSearchOptionKeys.some(key => hasOwn(body, key));
}

function requestedSources(
  body: Record<string, unknown>,
  searchOptions: Record<string, unknown> | undefined,
): unknown {
  if (body.sources !== undefined) return body.sources;
  return searchOptions?.sources;
}

function requestsUnsupportedSource(source: unknown): boolean {
  if (sourceType(source) !== "web") return true;
  const options = asRecord(source);
  return options !== undefined && requestsUnsupportedOptions(options);
}

// @lat: [[http#Search]]
export function validateLocalSearchCapabilities(body: unknown): void {
  if (!config.LOCAL_SEARCH_WEB_ONLY || !body || typeof body !== "object") {
    return;
  }

  const request = body as Record<string, unknown>;
  const searchOptions = asRecord(request.searchOptions);
  const sources = requestedSources(request, searchOptions);
  if (
    (sources !== undefined && !Array.isArray(sources)) ||
    (Array.isArray(sources) && sources.some(requestsUnsupportedSource)) ||
    requestsUnsupportedOptions(request) ||
    (searchOptions !== undefined && requestsUnsupportedOptions(searchOptions))
  ) {
    throw new LocalSearchCapabilityError();
  }
}

// @lat: [[http#Endpoint feedback]]
export function validateLocalSearchFeedbackCapability(
  endpoint: unknown = "search",
): void {
  if (config.LOCAL_SEARCH_WEB_ONLY && endpoint === "search") {
    throw new LocalSearchCapabilityError();
  }
}

export function toLocalSearchCapabilityHttpError(error: unknown) {
  if (!(error instanceof LocalSearchCapabilityError)) return undefined;

  return {
    status: 400 as const,
    body: {
      success: false as const,
      code: "BAD_REQUEST" as const,
      error: LOCAL_SEARCH_WEB_ONLY_MESSAGE,
    },
  };
}
