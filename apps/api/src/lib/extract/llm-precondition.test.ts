import { afterEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  OLLAMA_BASE_URL: undefined as string | undefined,
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_BASE_URL: undefined as string | undefined,
}));

vi.mock("../../config", () => ({ config: mockConfig }));

import { getExtractLlmPreconditionError } from "./llm-precondition";

afterEach(() => {
  mockConfig.OLLAMA_BASE_URL = undefined;
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.OPENAI_BASE_URL = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("extract LLM admission", () => {
  it("explains how to configure a missing backend", async () => {
    expect(await getExtractLlmPreconditionError()).toContain(
      "Set OPENAI_API_KEY or OPENAI_BASE_URL",
    );
  });

  it("reports a configured backend that cannot be reached", async () => {
    mockConfig.OPENAI_BASE_URL = "http://unreachable.test/v1";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    expect(await getExtractLlmPreconditionError()).toBe(
      "Extract OpenAI-compatible LLM backend at http://unreachable.test/v1/models is unreachable. Check OPENAI_BASE_URL and OPENAI_API_KEY and backend availability.",
    );
  });

  it.each([401, 403, 404])(
    "accepts any HTTP response, including %i",
    async status => {
      mockConfig.OPENAI_BASE_URL = `https://status-${status}.test/v1`;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );

      expect(await getExtractLlmPreconditionError()).toBeUndefined();
    },
  );

  it("probes hosted OpenAI with the configured bearer key", async () => {
    mockConfig.OPENAI_API_KEY = "real-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getExtractLlmPreconditionError()).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer real-key" },
        method: "GET",
      }),
    );
  });

  it("normalizes Ollama bases ending in api", async () => {
    mockConfig.OLLAMA_BASE_URL = "http://ollama.test:11434/api/";
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetchMock);

    expect(await getExtractLlmPreconditionError()).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://ollama.test:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails closed when the probe times out", async () => {
    vi.useFakeTimers();
    mockConfig.OPENAI_BASE_URL = "http://timeout.test/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    );

    const result = getExtractLlmPreconditionError();
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(result).resolves.toContain("is unreachable");
  });

  it("reuses probes for about 15 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockConfig.OPENAI_BASE_URL = "http://cache.test/v1";
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetchMock);

    await getExtractLlmPreconditionError();
    vi.setSystemTime(14_999);
    await getExtractLlmPreconditionError();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(15_000);
    await getExtractLlmPreconditionError();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
