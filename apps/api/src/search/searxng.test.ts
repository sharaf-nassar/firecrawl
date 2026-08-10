import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEARCH_PROVIDER_WARNING,
  SearchProviderBadResponseError,
  SearchProviderUnavailableError,
} from "./errors";
import { createSearxngClient, selectedSearxngEngines } from "./searxng";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function result(index = 1) {
  return {
    url: `https://example.com/${index}`,
    title: `Result ${index}`,
    content: `Description ${index}`,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: "https://search.internal/",
    num_results: 5,
    ...overrides,
  } as Parameters<ReturnType<typeof createSearxngClient>>[1];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SearXNG client", () => {
  it("makes one form-encoded POST and maps a valid result", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ results: [result()], unresponsive_engines: [] }),
    );
    const search = createSearxngClient({ fetch: fetchMock as typeof fetch });

    await expect(
      search(
        "private query",
        options({ engines: " BraveAPI, bing,braveapi " }),
      ),
    ).resolves.toEqual({
      web: [
        {
          url: "https://example.com/1",
          title: "Result 1",
          description: "Description 1",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://search.internal/search");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = init?.body as URLSearchParams;
    expect(body.get("q")).toBe("private query");
    expect(body.get("engines")).toBe("braveapi,bing");
    expect(body.get("pageno")).toBe("1");
    expect(body.get("format")).toBe("json");
  });

  it("caps provider demand at 100 results and five pages", async () => {
    let nextResult = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          results: Array.from({ length: 20 }, () => result(++nextResult)),
          unresponsive_engines: [],
        }),
    );
    const search = createSearxngClient({ fetch: fetchMock as typeof fetch });

    const response = await search("bounded", options({ num_results: 500 }));

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(response.web).toHaveLength(100);
    expect(
      fetchMock.mock.calls.map(call =>
        (call[1]?.body as URLSearchParams).get("pageno"),
      ),
    ).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("enforces a shared ten-second deadline without retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>(() => undefined),
    );
    const search = createSearxngClient({
      fetch: fetchMock as typeof fetch,
      timeoutMs: 10_000,
    });
    const pending = search("deadline", options());
    const rejection = expect(pending).rejects.toBeInstanceOf(
      SearchProviderUnavailableError,
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("limits per-process provider concurrency to four", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve(
              jsonResponse({ results: [result()], unresponsive_engines: [] }),
            );
          });
        }),
    );
    const search = createSearxngClient({
      fetch: fetchMock as typeof fetch,
      maxConcurrency: 4,
    });
    const searches = Array.from({ length: 5 }, (_, index) =>
      search(`query-${index}`, options({ num_results: 1 })),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(peak).toBe(4);
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    while (releases.length > 0) releases.shift()?.();

    await expect(Promise.all(searches)).resolves.toHaveLength(5);
    expect(peak).toBe(4);
  });

  it("preserves valid empty results as terminal", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ results: [], unresponsive_engines: [] }),
    );
    const search = createSearxngClient({ fetch: fetchMock as typeof fetch });

    await expect(
      search("empty", options({ num_results: 100 })),
    ).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns sanitized warnings for partial engine or item failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [result(), { title: "invalid" }],
          unresponsive_engines: [["braveapi", "secret provider detail"]],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [],
          unresponsive_engines: [["bing", "another secret"]],
        }),
      );
    const search = createSearxngClient({ fetch: fetchMock as typeof fetch });

    await expect(search("partial", options())).resolves.toEqual({
      web: [
        {
          url: "https://example.com/1",
          title: "Result 1",
          description: "Description 1",
        },
      ],
      warning: SEARCH_PROVIDER_WARNING,
    });

    await expect(search("empty partial", options())).resolves.toEqual({
      warning: SEARCH_PROVIDER_WARNING,
    });
  });

  it("strictly validates selected and unresponsive engines", async () => {
    expect(selectedSearxngEngines("braveapi, BRAVEAPI, Bing")).toEqual([
      "braveapi",
      "bing",
    ]);
    expect(() => selectedSearxngEngines("unknown")).toThrow(
      SearchProviderBadResponseError,
    );

    for (const unresponsive_engines of [
      "braveapi",
      [["braveapi"]],
      [
        ["braveapi", "timeout"],
        ["braveapi", "again"],
      ],
      [["bing", "timeout"]],
      [["braveapi", ""]],
    ]) {
      const search = createSearxngClient({
        fetch: (async () =>
          jsonResponse({
            results: [],
            unresponsive_engines,
          })) as typeof fetch,
      });
      await expect(
        search("strict", options({ engines: "braveapi" })),
      ).rejects.toBeInstanceOf(SearchProviderBadResponseError);
    }
  });

  it("classifies total engine failure as unavailable", async () => {
    const search = createSearxngClient({
      fetch: (async () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [
            ["braveapi", "failed"],
            ["bing", "failed"],
          ],
        })) as typeof fetch,
    });

    await expect(
      search("all failed", options({ engines: "braveapi,bing" })),
    ).rejects.toBeInstanceOf(SearchProviderUnavailableError);
  });

  it("classifies non-2xx, malformed envelopes, and invalid-only results as bad responses", async () => {
    for (const response of [
      jsonResponse({ error: "upstream" }, 500),
      jsonResponse({ results: "invalid" }),
      jsonResponse({ results: [{ url: "javascript:alert(1)" }] }),
      new Response("not-json", { status: 200 }),
    ]) {
      const search = createSearxngClient({
        fetch: (async () => response) as typeof fetch,
      });
      await expect(search("bad", options())).rejects.toBeInstanceOf(
        SearchProviderBadResponseError,
      );
    }
  });

  it("classifies transport failure as unavailable and never retries", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("connection reset with private endpoint detail");
    });
    const search = createSearxngClient({ fetch: fetchMock as typeof fetch });

    await expect(search("transport", options())).rejects.toBeInstanceOf(
      SearchProviderUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
