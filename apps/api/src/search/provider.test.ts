import { describe, expect, it } from "vitest";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../lib/error-serde";
import {
  SEARCH_PROVIDER_BAD_RESPONSE_MESSAGE,
  SEARCH_PROVIDER_UNAVAILABLE_MESSAGE,
  SearchProviderBadResponseError,
  SearchProviderUnavailableError,
  SEARCH_PROVIDER_WARNING,
  splitSearchProviderResponse,
  toSearchProviderHttpError,
} from "./errors";
import { resolveSearchProvider, SearchProviderConfig } from "./provider";

const defaults: SearchProviderConfig = {
  LOCAL_SEARCH_WEB_ONLY: false,
  FIRE_ENGINE_BETA_URL: undefined,
  SEARXNG_ENDPOINT: undefined,
  SEARXNG_ENGINES: undefined,
  SEARXNG_CATEGORIES: undefined,
};

describe("resolveSearchProvider", () => {
  it("enforces the local and non-local precedence matrix", () => {
    expect(
      resolveSearchProvider({
        ...defaults,
        LOCAL_SEARCH_WEB_ONLY: true,
        FIRE_ENGINE_BETA_URL: "https://fire-engine.example",
        SEARXNG_ENDPOINT: "http://searxng:8080",
      }),
    ).toEqual({
      type: "searxng",
      endpoint: "http://searxng:8080",
      engines: undefined,
      categories: undefined,
    });

    expect(
      resolveSearchProvider({
        ...defaults,
        FIRE_ENGINE_BETA_URL: "https://fire-engine.example",
        SEARXNG_ENDPOINT: "https://search.example",
      }),
    ).toEqual({ type: "fire-engine" });

    expect(
      resolveSearchProvider({
        ...defaults,
        SEARXNG_ENDPOINT: " https://search.example ",
      }),
    ).toEqual({
      type: "searxng",
      endpoint: "https://search.example",
      engines: undefined,
      categories: undefined,
    });
  });

  it("fails when local mode or a provider-explicit deployment has no provider", () => {
    expect(() =>
      resolveSearchProvider({
        ...defaults,
        LOCAL_SEARCH_WEB_ONLY: true,
        FIRE_ENGINE_BETA_URL: "https://fire-engine.example",
      }),
    ).toThrow(SearchProviderUnavailableError);
    expect(() => resolveSearchProvider(defaults)).toThrow(
      SearchProviderUnavailableError,
    );
    expect(() =>
      resolveSearchProvider({ ...defaults, SEARXNG_ENDPOINT: "  " }),
    ).toThrow(SearchProviderUnavailableError);
  });
});

describe("search provider errors", () => {
  it("moves only the canonical provider warning out of result data", () => {
    expect(
      splitSearchProviderResponse({
        web: [{ url: "https://example.com" }],
        warning: SEARCH_PROVIDER_WARNING,
      }),
    ).toEqual({
      data: { web: [{ url: "https://example.com" }] },
      warning: SEARCH_PROVIDER_WARNING,
    });
    expect(
      splitSearchProviderResponse({ web: [], warning: "private detail" }),
    ).toEqual({ data: { web: [] } });
  });

  it("maps only canonical errors to stable 502 and 503 envelopes", () => {
    expect(
      toSearchProviderHttpError(new SearchProviderUnavailableError()),
    ).toEqual({
      status: 503,
      body: {
        success: false,
        code: "SEARCH_PROVIDER_UNAVAILABLE",
        error: SEARCH_PROVIDER_UNAVAILABLE_MESSAGE,
      },
    });
    expect(
      toSearchProviderHttpError(new SearchProviderBadResponseError()),
    ).toEqual({
      status: 502,
      body: {
        success: false,
        code: "SEARCH_PROVIDER_BAD_RESPONSE",
        error: SEARCH_PROVIDER_BAD_RESPONSE_MESSAGE,
      },
    });
    expect(toSearchProviderHttpError(new Error("unexpected"))).toBeUndefined();
  });

  it("round-trips canonical errors through worker serialization", () => {
    const unavailable = deserializeTransportableError(
      serializeTransportableError(new SearchProviderUnavailableError()),
    );
    const badResponse = deserializeTransportableError(
      serializeTransportableError(new SearchProviderBadResponseError()),
    );

    expect(unavailable).toBeInstanceOf(SearchProviderUnavailableError);
    expect(badResponse).toBeInstanceOf(SearchProviderBadResponseError);
  });
});
