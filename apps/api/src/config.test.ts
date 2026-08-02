import { describe, expect, it } from "vitest";

import { configSchema } from "./config";

const llmBaseUrlSchema = configSchema.pick({
  OPENAI_BASE_URL: true,
  OLLAMA_BASE_URL: true,
});

describe("LLM base URL configuration", () => {
  it("treats empty base URLs as unset", () => {
    // @lat: [[tests#API Test Organization#Unit and component tests]]
    expect(
      llmBaseUrlSchema.parse({
        OPENAI_BASE_URL: "",
        OLLAMA_BASE_URL: "",
      }),
    ).toEqual({
      OPENAI_BASE_URL: undefined,
      OLLAMA_BASE_URL: undefined,
    });
  });

  it("preserves non-empty base URLs", () => {
    expect(
      llmBaseUrlSchema.parse({
        OPENAI_BASE_URL: "https://openai.example/v1",
        OLLAMA_BASE_URL: "http://ollama.example:11434/api",
      }),
    ).toEqual({
      OPENAI_BASE_URL: "https://openai.example/v1",
      OLLAMA_BASE_URL: "http://ollama.example:11434/api",
    });
  });
});
