import { config } from "../config";
import { SearchV2Response, WebSearchResult } from "../lib/entities";
import {
  SEARCH_PROVIDER_WARNING,
  SearchProviderBadResponseError,
  SearchProviderUnavailableError,
} from "./errors";

const SEARXNG_ENGINES = ["brave", "qwant", "startpage", "bing"] as const;
const SEARXNG_MAX_PAGES = 5;
const SEARXNG_RESULTS_PER_PAGE = 20;

interface SearxngSearchResponse extends SearchV2Response {
  warning?: typeof SEARCH_PROVIDER_WARNING;
}

interface SearxngSearchOptions {
  endpoint: string;
  engines?: string;
  categories?: string;
  lang?: string;
  num_results: number;
  page?: number;
}

type Fetch = typeof globalThis.fetch;

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new SearchProviderUnavailableError());
    }

    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new SearchProviderUnavailableError());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.createRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}

type SearxngClientOptions = {
  fetch?: Fetch;
  timeoutMs?: number;
  maxResults?: number;
  maxConcurrency?: number;
};

function normalizeEngineName(value: string): string {
  return value.trim().toLowerCase();
}

export function selectedSearxngEngines(value?: string): string[] {
  if (value === undefined || value.trim() === "") {
    return [...SEARXNG_ENGINES];
  }

  const selected = [
    ...new Set(value.split(",").map(normalizeEngineName).filter(Boolean)),
  ];
  if (
    selected.length === 0 ||
    selected.some(
      engine => !(SEARXNG_ENGINES as readonly string[]).includes(engine),
    )
  ) {
    throw new SearchProviderBadResponseError();
  }
  return selected;
}

function parseFailures(value: unknown, selected: Set<string>): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw new SearchProviderBadResponseError();

  const failures = new Set<string>();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].trim() === "" ||
      typeof entry[1] !== "string" ||
      entry[1].trim() === ""
    ) {
      throw new SearchProviderBadResponseError();
    }

    const engine = normalizeEngineName(entry[0]);
    if (!selected.has(engine) || failures.has(engine)) {
      throw new SearchProviderBadResponseError();
    }
    failures.add(engine);
  }
  return failures;
}

function parseResult(value: unknown): WebSearchResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.url !== "string" ||
    typeof item.title !== "string" ||
    typeof item.content !== "string" ||
    item.title.trim() === ""
  ) {
    return undefined;
  }

  try {
    const url = new URL(item.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }

  return {
    url: item.url,
    title: item.title,
    description: item.content,
  };
}

function parseEnvelope(value: unknown, selected: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SearchProviderBadResponseError();
  }

  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.results)) {
    throw new SearchProviderBadResponseError();
  }

  const failures = parseFailures(envelope.unresponsive_engines, selected);
  const results = envelope.results
    .map(parseResult)
    .filter((result): result is WebSearchResult => result !== undefined);

  if (envelope.results.length > 0 && results.length === 0) {
    throw new SearchProviderBadResponseError();
  }

  return {
    results,
    failures,
    hasMalformedItems: results.length !== envelope.results.length,
    providerResultCount: envelope.results.length,
  };
}

function searchUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/search`;
}

export function createSearxngClient(options: SearxngClientOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResults = Math.min(options.maxResults ?? 100, 100);
  const semaphore = new Semaphore(options.maxConcurrency ?? 4);

  return async function searchSearxng(
    query: string,
    searchOptions: SearxngSearchOptions,
  ): Promise<SearxngSearchResponse> {
    const requestedResults = Math.min(
      Math.max(Math.trunc(searchOptions.num_results), 0),
      maxResults,
    );
    if (requestedResults === 0) return {};

    const startPage = Math.min(
      Math.max(Math.trunc(searchOptions.page ?? 1), 1),
      SEARXNG_MAX_PAGES,
    );
    const pageCount = Math.min(
      SEARXNG_MAX_PAGES - startPage + 1,
      Math.ceil(requestedResults / SEARXNG_RESULTS_PER_PAGE),
    );
    const engines = selectedSearxngEngines(searchOptions.engines);
    const selected = new Set(engines);
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SearchProviderUnavailableError());
      }, timeoutMs);
    });
    let release: (() => void) | undefined;

    try {
      release = await Promise.race([
        semaphore.acquire(controller.signal),
        deadline,
      ]);
      const results: WebSearchResult[] = [];
      const failedEngines = new Set<string>();
      let warning = false;

      for (let pageOffset = 0; pageOffset < pageCount; pageOffset += 1) {
        const body = new URLSearchParams({
          q: query,
          language: searchOptions.lang ?? "en",
          engines: engines.join(","),
          categories: searchOptions.categories ?? "",
          pageno: String(startPage + pageOffset),
          format: "json",
        });

        let response: Response;
        try {
          response = await Promise.race([
            fetchImpl(searchUrl(searchOptions.endpoint), {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body,
              signal: controller.signal,
            }),
            deadline,
          ]);
        } catch (error) {
          if (error instanceof SearchProviderUnavailableError) throw error;
          throw new SearchProviderUnavailableError({ cause: error });
        }

        if (!response.ok) throw new SearchProviderBadResponseError();

        let envelope: unknown;
        try {
          envelope = await Promise.race([response.json(), deadline]);
        } catch (error) {
          if (error instanceof SearchProviderUnavailableError) throw error;
          throw new SearchProviderBadResponseError({ cause: error });
        }

        const parsed = parseEnvelope(envelope, selected);
        for (const engine of parsed.failures) failedEngines.add(engine);
        warning ||= parsed.hasMalformedItems || parsed.failures.size > 0;
        results.push(...parsed.results);

        if (results.length >= requestedResults) break;
        if (parsed.providerResultCount === 0) break;
      }

      if (results.length === 0 && failedEngines.size === selected.size) {
        throw new SearchProviderUnavailableError();
      }

      const web = results.slice(0, requestedResults);
      return {
        ...(web.length > 0 ? { web } : {}),
        ...(warning ? { warning: SEARCH_PROVIDER_WARNING } : {}),
      };
    } finally {
      clearTimeout(timeout);
      release?.();
    }
  };
}

const defaultClient = createSearxngClient({
  timeoutMs: config.SEARCH_PROVIDER_TIMEOUT_MS,
  maxResults: config.SEARCH_PROVIDER_MAX_RESULTS,
  maxConcurrency: config.SEARCH_PROVIDER_MAX_CONCURRENCY,
});

// @lat: [[http#Search]]
export const searxng_search = defaultClient;
