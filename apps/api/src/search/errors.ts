import { ErrorCodes, TransportableError } from "../lib/error";

export const SEARCH_PROVIDER_UNAVAILABLE_MESSAGE =
  "Search provider is temporarily unavailable. Please try again later.";
export const SEARCH_PROVIDER_BAD_RESPONSE_MESSAGE =
  "Search provider returned an invalid response. Please try again later.";
export const SEARCH_PROVIDER_WARNING =
  "Some search results could not be retrieved.";

export function splitSearchProviderResponse<T extends object>(
  response: T,
): {
  data: Omit<T, "warning">;
  warning?: typeof SEARCH_PROVIDER_WARNING;
} {
  const { warning, ...data } = response as T & { warning?: unknown };
  return {
    data,
    ...(warning === SEARCH_PROVIDER_WARNING ? { warning } : {}),
  };
}

export class SearchProviderUnavailableError extends TransportableError {
  constructor(options?: ErrorOptions) {
    super(
      "SEARCH_PROVIDER_UNAVAILABLE",
      SEARCH_PROVIDER_UNAVAILABLE_MESSAGE,
      options,
    );
    this.name = "SearchProviderUnavailableError";
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<TransportableError["serialize"]>,
  ) {
    const error = new SearchProviderUnavailableError({ cause: data.cause });
    error.stack = data.stack;
    return error;
  }
}

export class SearchProviderBadResponseError extends TransportableError {
  constructor(options?: ErrorOptions) {
    super(
      "SEARCH_PROVIDER_BAD_RESPONSE",
      SEARCH_PROVIDER_BAD_RESPONSE_MESSAGE,
      options,
    );
    this.name = "SearchProviderBadResponseError";
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<TransportableError["serialize"]>,
  ) {
    const error = new SearchProviderBadResponseError({ cause: data.cause });
    error.stack = data.stack;
    return error;
  }
}

type SearchProviderHttpError = {
  status: 502 | 503;
  body: {
    success: false;
    code: "SEARCH_PROVIDER_UNAVAILABLE" | "SEARCH_PROVIDER_BAD_RESPONSE";
    error: string;
  };
};

export function toSearchProviderHttpError(
  error: unknown,
): SearchProviderHttpError | undefined {
  if (error instanceof SearchProviderUnavailableError) {
    return {
      status: 503,
      body: {
        success: false,
        code: "SEARCH_PROVIDER_UNAVAILABLE",
        error: SEARCH_PROVIDER_UNAVAILABLE_MESSAGE,
      },
    };
  }

  if (error instanceof SearchProviderBadResponseError) {
    return {
      status: 502,
      body: {
        success: false,
        code: "SEARCH_PROVIDER_BAD_RESPONSE",
        error: SEARCH_PROVIDER_BAD_RESPONSE_MESSAGE,
      },
    };
  }

  return undefined;
}
