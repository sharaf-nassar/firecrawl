import { afterEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  MODEL_NAME: undefined as string | undefined,
  MODEL_EMBEDDING_NAME: undefined as string | undefined,
  OLLAMA_BASE_URL: undefined as string | undefined,
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: "https://openai.test/v1",
  OPENAI_CHAT_COMPLETIONS_ONLY: false,
  OPENROUTER_API_KEY: undefined as string | undefined,
  VERTEX_CREDENTIALS: undefined as string | undefined,
}));

vi.mock("../config", () => ({ config: mockConfig }));

import { getModel } from "./generic-ai";

function mockRejectedOpenAIRequest() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { message: "test rejection" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function invokeModel() {
  const model = getModel("gpt-4o-mini", "openai");
  await expect(
    model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "test" }],
        },
      ],
    } as Parameters<typeof model.doGenerate>[0]),
  ).rejects.toThrow();
}

afterEach(() => {
  mockConfig.OPENAI_CHAT_COMPLETIONS_ONLY = false;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OpenAI endpoint selection", () => {
  it("uses Chat Completions when compatibility mode is enabled", async () => {
    // @lat: [[tests#API Test Organization#Unit and component tests#OpenAI endpoint selection#Opt-in Chat Completions]]
    mockConfig.OPENAI_CHAT_COMPLETIONS_ONLY = true;
    const fetchMock = mockRejectedOpenAIRequest();

    await invokeModel();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://openai.test/v1/chat/completions",
    );
  });

  it("uses Responses by default", async () => {
    // @lat: [[tests#API Test Organization#Unit and component tests#OpenAI endpoint selection#Default Responses API]]
    const fetchMock = mockRejectedOpenAIRequest();

    await invokeModel();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openai.test/v1/responses");
  });
});
