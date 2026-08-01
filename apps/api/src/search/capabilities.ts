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

function requestedSources(body: Record<string, unknown>): unknown {
  if (body.sources !== undefined) return body.sources;

  const searchOptions = body.searchOptions;
  if (searchOptions && typeof searchOptions === "object") {
    return (searchOptions as Record<string, unknown>).sources;
  }

  return undefined;
}

// @lat: [[http#Search]]
export function validateLocalSearchCapabilities(body: unknown): void {
  if (!config.LOCAL_SEARCH_WEB_ONLY || !body || typeof body !== "object") {
    return;
  }

  const sources = requestedSources(body as Record<string, unknown>);
  if (
    Array.isArray(sources) &&
    sources.some(source => sourceType(source) !== "web")
  ) {
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
