import { describe, expect, it } from "vitest";

import { configSchema } from "./config";

const llmConfigSchema = configSchema.pick({
  OPENAI_API_KEY: true,
  OPENAI_BASE_URL: true,
  MODEL_NAME: true,
  MODEL_EMBEDDING_NAME: true,
  OLLAMA_BASE_URL: true,
  OPENROUTER_API_KEY: true,
});
const openAICompatibilitySchema = configSchema.pick({
  OPENAI_CHAT_COMPLETIONS_ONLY: true,
});

describe("LLM configuration", () => {
  it("treats exactly the five empty LLM settings as unset", () => {
    // @lat: [[runtime-operations#Runtime and Operations Testing#API LLM compatibility coverage#Extract LLM admission]]
    expect(
      llmConfigSchema.parse({
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        MODEL_NAME: "",
        MODEL_EMBEDDING_NAME: "",
        OLLAMA_BASE_URL: "",
        OPENROUTER_API_KEY: "",
      }),
    ).toEqual({
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      MODEL_NAME: undefined,
      MODEL_EMBEDDING_NAME: undefined,
      OLLAMA_BASE_URL: undefined,
      OPENROUTER_API_KEY: "",
    });
  });

  it("preserves non-empty base URLs", () => {
    expect(
      llmConfigSchema.parse({
        OPENAI_BASE_URL: "https://openai.example/v1",
        OLLAMA_BASE_URL: "http://ollama.example:11434/api",
      }),
    ).toEqual({
      OPENAI_BASE_URL: "https://openai.example/v1",
      OLLAMA_BASE_URL: "http://ollama.example:11434/api",
    });
  });

  it("keeps Chat Completions compatibility disabled by default", () => {
    expect(openAICompatibilitySchema.parse({})).toEqual({
      OPENAI_CHAT_COMPLETIONS_ONLY: false,
    });
    expect(
      openAICompatibilitySchema.parse({
        OPENAI_CHAT_COMPLETIONS_ONLY: "true",
      }),
    ).toEqual({ OPENAI_CHAT_COMPLETIONS_ONLY: true });
  });
});
