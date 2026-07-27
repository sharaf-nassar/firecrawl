import { randomUUID } from "node:crypto";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type ScenarioHandle = {
  scenarioId: string;
  marker: string;
};

function validatedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Real adapter fixture URL must be exact loopback HTTP");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Real adapter fixture URL must be exact loopback HTTP");
  }
  return parsed.href;
}

function validatedScenarioId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new Error("Real adapter fixture returned invalid scenarioId");
  }
  return value;
}

function validatedScenarioHandle(value: unknown): ScenarioHandle {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "marker,scenarioId"
  ) {
    throw new Error("Real adapter fixture returned invalid scenario handle");
  }
  const handle = value as Record<string, unknown>;
  const scenarioId = validatedScenarioId(handle.scenarioId);
  if (
    typeof handle.marker !== "string" ||
    !CANONICAL_UUID.test(handle.marker)
  ) {
    throw new Error("Real adapter fixture returned invalid marker");
  }
  return { scenarioId, marker: handle.marker };
}

async function readBoundedResponse(
  response: Response,
  path: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Real adapter fixture ${path} response is too large`);
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Real adapter fixture ${path} response is too large`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class RealAdapterFixture {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = validatedBaseUrl(baseUrl);
    if (
      !STRONG_TOKEN.test(token) ||
      Buffer.from(token, "base64url").byteLength !== 32 ||
      Buffer.from(token, "base64url").toString("base64url") !== token
    ) {
      throw new Error(
        "REAL_CODEX_BROWSER_TEST_ADAPTER_TOKEN must be 32-byte base64url",
      );
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.redirected) {
      throw new Error(`Real adapter fixture ${path} redirected`);
    }
    if (!response.ok) {
      throw new Error(
        `Real adapter fixture ${path} returned ${response.status}`,
      );
    }
    const bytes = await readBoundedResponse(response, path);
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      throw new Error(`Real adapter fixture ${path} returned invalid JSON`);
    }
  }

  async begin(kind: string): Promise<ScenarioHandle> {
    const response = await this.request<unknown>("/v1/scenarios", {
      method: "POST",
      body: JSON.stringify({
        contractVersion: 1,
        kind,
        marker: randomUUID(),
      }),
    });
    return validatedScenarioHandle(response);
  }

  async waitForPhase(scenarioId: string, phase: string): Promise<void> {
    await this.request(
      `/v1/scenarios/${encodeURIComponent(
        validatedScenarioId(scenarioId),
      )}/wait`,
      {
        method: "POST",
        body: JSON.stringify({ phase, timeoutMs: 30_000 }),
      },
      35_000,
    );
  }

  async promptTrace<T>(scenarioId: string): Promise<T> {
    return this.request(
      `/v1/scenarios/${encodeURIComponent(
        validatedScenarioId(scenarioId),
      )}/trace`,
    );
  }

  async codeTrace<T>(scenarioId: string): Promise<T> {
    return this.request(
      `/v1/scenarios/${encodeURIComponent(
        validatedScenarioId(scenarioId),
      )}/trace`,
    );
  }

  async release(scenarioId: string): Promise<void> {
    await this.request(
      `/v1/scenarios/${encodeURIComponent(validatedScenarioId(scenarioId))}`,
      {
        method: "DELETE",
      },
    );
  }
}
