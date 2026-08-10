import { config } from "../../config";

const PROBE_TIMEOUT_MS = 1_500;
const PROBE_CACHE_TTL_MS = 15_000;

let cachedProbe:
  | { endpoint: string; error: string | undefined; expiresAt: number }
  | undefined;

function backend() {
  if (config.OLLAMA_BASE_URL) {
    const base = config.OLLAMA_BASE_URL.replace(/\/+$/, "").replace(
      /\/api$/,
      "",
    );
    return {
      endpoint: `${base}/api/tags`,
      headers: undefined,
      name: "Ollama",
      setting: "OLLAMA_BASE_URL",
    };
  }

  if (config.OPENAI_BASE_URL || config.OPENAI_API_KEY) {
    const base = (
      config.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    return {
      endpoint: `${base}/models`,
      headers: config.OPENAI_API_KEY
        ? { Authorization: `Bearer ${config.OPENAI_API_KEY}` }
        : undefined,
      name: "OpenAI-compatible",
      setting: "OPENAI_BASE_URL and OPENAI_API_KEY",
    };
  }
}

// @lat: [[overview#API Service Architecture#Configuration contract]]
export async function getExtractLlmPreconditionError(): Promise<
  string | undefined
> {
  const selected = backend();
  if (!selected) {
    return "Extract requires an LLM backend. Set OPENAI_API_KEY or OPENAI_BASE_URL for an OpenAI-compatible backend, or set OLLAMA_BASE_URL for Ollama.";
  }

  if (
    cachedProbe?.endpoint === selected.endpoint &&
    cachedProbe.expiresAt > Date.now()
  ) {
    return cachedProbe.error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let error: string | undefined;
  try {
    await fetch(selected.endpoint, {
      headers: selected.headers,
      method: "GET",
      signal: controller.signal,
    });
  } catch {
    error = `Extract ${selected.name} LLM backend at ${selected.endpoint} is unreachable. Check ${selected.setting} and backend availability.`;
  } finally {
    clearTimeout(timeout);
  }

  cachedProbe = {
    endpoint: selected.endpoint,
    error,
    expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
  };
  return error;
}
