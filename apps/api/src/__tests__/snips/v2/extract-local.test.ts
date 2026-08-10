import { ChildProcess, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parse } from "dotenv";
import request from "supertest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(__dirname, "../../../../../..");
const wrapper = join(repoRoot, "scripts/local-firecrawl");
const shimEntrypoint = join(repoRoot, "apps/codex-shim/src/server.mjs");
const testApiUrl = process.env.TEST_API_URL ?? "http://127.0.0.1:3002";
const successDeadlineMs = 90_000;
// Three AI SDK attempts plus the fire-0 phase timeout fit inside this budget.
const failureDeadlineMs = 90_000;
const pollIntervalMs = 500;

// Opt in only after the root .env enables the shim and isolated local URLs.

type ExtractStatus = {
  success: boolean;
  status: "processing" | "completed" | "failed";
  data?: Record<string, unknown>;
  error?: string;
};

type AccessEntry = {
  method: string;
  path: string;
  model?: string;
  usedPlaceholder: boolean;
};

type Identity = { apiKey: string };

function readLocalSettings(): Record<string, string> {
  try {
    return parse(readFileSync(join(repoRoot, ".env")));
  } catch {
    return {};
  }
}

const localSettings = readLocalSettings();
const configuredShim = (() => {
  try {
    const url = new URL(localSettings.OPENAI_BASE_URL ?? "");
    return (
      url.protocol === "http:" &&
      url.hostname === "host.docker.internal" &&
      url.pathname === "/v1" &&
      url.port !== ""
    );
  } catch {
    return false;
  }
})();
const localExtractEnabled =
  process.env.TEST_LOCAL_EXTRACT_E2E === "true" &&
  configuredShim &&
  localSettings.USE_DB_AUTHENTICATION === "false" &&
  localSettings.ALLOW_LOCAL_WEBHOOKS === "true" &&
  localSettings.OPENAI_API_KEY === "local-codex-shim";

function listen(server: Server, port = 0): Promise<AddressInfo> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolveListen(server.address() as AddressInfo);
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolveClose, reject) => {
    server.close(error => (error ? reject(error) : resolveClose()));
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const address = await listen(server);
  await closeServer(server);
  return address.port;
}

async function waitFor(
  check: () => Promise<boolean>,
  deadlineMs: number,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() <= deadline) {
    if (await check()) return;
    await new Promise(resolveSleep => setTimeout(resolveSleep, pollIntervalMs));
  }
  throw new Error(failure);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit =>
    child.once("exit", () => resolveExit()),
  );
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited.finally(() => clearTimeout(timer));
}

const describeLocalExtract = localExtractEnabled ? describe : describe.skip;

describeLocalExtract("local extract and JSON scrape", () => {
  let identity: Identity;
  let fixture: Server | undefined;
  let fixtureUrl: string;
  let proxy: Server | undefined;
  let backend: ChildProcess | undefined;
  let backendPort: number;
  let rabbitContainerId: string;
  let managedShimStopped = false;
  let killBackendOnChat = false;
  const accessLog: AccessEntry[] = [];
  const configuredUrl = new URL(
    localSettings.OPENAI_BASE_URL ?? "http://host.docker.internal:3030/v1",
  );
  const proxyPort = Number(configuredUrl.port);
  async function runWrapper(
    command: "status" | "restart" | "shim-start" | "shim-stop",
    args: string[] = [],
  ) {
    return await execFileAsync(wrapper, [command, ...args], {
      cwd: repoRoot,
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
  }

  async function startBackend(): Promise<void> {
    backendPort = await reservePort();
    backend = spawn(process.execPath, [shimEntrypoint], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_SHIM_HOST: "127.0.0.1",
        CODEX_SHIM_PORT: String(backendPort),
      },
      stdio: "ignore",
    });
    await waitFor(
      async () => {
        if (backend?.exitCode !== null) {
          throw new Error(
            "Codex Shim test backend exited before becoming healthy",
          );
        }
        try {
          const response = await fetch(
            `http://127.0.0.1:${backendPort}/health`,
            {
              signal: AbortSignal.timeout(1_500),
            },
          );
          return response.ok;
        } catch {
          return false;
        }
      },
      10_000,
      "Timed out waiting for the Codex Shim test backend",
    );
  }

  async function stopBackend(): Promise<void> {
    const child = backend;
    backend = undefined;
    await stopChild(child);
  }

  async function startProxy(): Promise<void> {
    proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      let model: string | undefined;
      if (request.url === "/v1/chat/completions") {
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          if (typeof parsed.model === "string") model = parsed.model;
        } catch {
          // The real shim returns the request-shape error.
        }
      }
      accessLog.push({
        method: request.method ?? "",
        path: request.url ?? "",
        model,
        usedPlaceholder:
          request.headers.authorization === "Bearer local-codex-shim",
      });

      if (killBackendOnChat && request.url === "/v1/chat/completions") {
        killBackendOnChat = false;
        await stopBackend();
      }

      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            value !== undefined &&
            !["connection", "content-length", "host"].includes(name)
          ) {
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
        }
        const upstream = await fetch(
          `http://127.0.0.1:${backendPort}${request.url ?? "/"}`,
          {
            method: request.method,
            headers,
            body: body.length === 0 ? undefined : body,
            signal: AbortSignal.timeout(successDeadlineMs),
          },
        );
        const payload = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ??
            "application/json; charset=utf-8",
          "content-length": String(payload.length),
          "cache-control": "no-store",
        });
        response.end(payload);
      } catch {
        const payload = Buffer.from(
          JSON.stringify({
            error: {
              message: "Codex Shim backend became unavailable.",
              type: "server_error",
              code: "codex_shim_unavailable",
            },
          }),
        );
        response.writeHead(502, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(payload.length),
        });
        response.end(payload);
      }
    });
    await listen(proxy, proxyPort);
  }

  async function getDlqCount(): Promise<number> {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "exec",
        rabbitContainerId,
        "rabbitmqctl",
        "list_queues",
        "name",
        "messages",
      ],
      { timeout: 10_000, encoding: "utf8" },
    );
    const match = stdout.match(/^extract\.dlq\s+(\d+)$/mu);
    if (!match) throw new Error("RabbitMQ did not report extract.dlq");
    return Number(match[1]);
  }

  async function getExtractStatus(id: string): Promise<ExtractStatus> {
    const response = await fetch(
      `${testApiUrl}/v2/extract/${encodeURIComponent(id)}`,
      {
        headers: { authorization: `Bearer ${identity.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as ExtractStatus;
  }

  async function waitForExtract(
    id: string,
    deadlineMs: number,
  ): Promise<ExtractStatus> {
    let status: ExtractStatus | undefined;
    await waitFor(
      async () => {
        status = await getExtractStatus(id);
        return status.status !== "processing";
      },
      deadlineMs,
      `Timed out waiting for extract ${id}`,
    );
    return status!;
  }

  function extractRequest() {
    return {
      urls: [`${fixtureUrl}/fixture/*`],
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "price", "description"],
      },
      scrapeOptions: { timeout: 60_000 },
      timeout: successDeadlineMs,
      origin: "local-extract-snip",
    };
  }

  async function startExtract(): Promise<string> {
    const response = await request(testApiUrl)
      .post("/v2/extract")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send(extractRequest());
    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(typeof response.body.id).toBe("string");
    return response.body.id;
  }

  beforeAll(async () => {
    const status = JSON.parse(
      (await runWrapper("status", ["--json"])).stdout,
    ) as {
      services: Array<{ ID: string; Service: string }>;
    };
    rabbitContainerId =
      status.services.find(service => service.Service === "rabbitmq")?.ID ?? "";
    if (!rabbitContainerId) {
      throw new Error("Local RabbitMQ container is unavailable");
    }
    identity = { apiKey: localSettings.TEST_API_KEY ?? "local-self-host" };

    fixture = createServer((request, response) => {
      const host = request.headers.host ?? "host.docker.internal";
      if (request.url === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("User-agent: *\nAllow: /\n");
      } else if (request.url === "/sitemap.xml") {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(
          `<?xml version="1.0"?><urlset><url><loc>http://${host}/fixture/product.html</loc></url></urlset>`,
        );
      } else if (
        request.url === "/fixture/" ||
        request.url === "/fixture/product.html"
      ) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          '<!doctype html><html><body><main><h1>Ember Camping Mug</h1><p data-price>$18.00</p><p>Red enamel mug for campfire coffee.</p><a href="/fixture/product.html">Product</a></main></body></html>',
        );
      } else {
        response.writeHead(404).end();
      }
    });
    const fixtureAddress = await listen(fixture);
    fixtureUrl = `http://host.docker.internal:${fixtureAddress.port}`;

    await runWrapper("shim-stop");
    managedShimStopped = true;
    await startBackend();
    await startProxy();
  }, 30_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of [
      () => closeServer(proxy),
      stopBackend,
      () => closeServer(fixture),
      async () => {
        if (managedShimStopped) {
          await runWrapper("shim-start");
          managedShimStopped = false;
        }
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Local extract fixture cleanup failed",
      );
    }
  }, 30_000);

  // @lat: [[local-extract#Local Extract End-to-End#Completes through the Codex Shim]]
  it("completes raw extract through every shim phase without DLQ parking", async () => {
    const dlqBefore = await getDlqCount();
    const accessBefore = accessLog.length;
    const result = await waitForExtract(
      await startExtract(),
      successDeadlineMs,
    );

    expect(result.status).toBe("completed");
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      name: expect.any(String),
      price: expect.any(String),
      description: expect.any(String),
    });
    const calls = accessLog
      .slice(accessBefore)
      .filter(entry => entry.path === "/v1/chat/completions");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every(entry => entry.usedPlaceholder)).toBe(true);
    expect(await getDlqCount()).toBe(dlqBefore);
  }, 120_000);

  // @lat: [[local-extract#Local Extract End-to-End#JSON scrape uses the shim]]
  it("returns schema-conformant JSON scrape data through the shim", async () => {
    const accessBefore = accessLog.length;
    const response = await request(testApiUrl)
      .post("/v2/scrape")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({
        url: `${fixtureUrl}/fixture/product.html`,
        formats: [{ type: "json", schema: extractRequest().schema }],
        maxAge: 0,
        timeout: 60_000,
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.json).toEqual({
      name: expect.any(String),
      price: expect.any(String),
      description: expect.any(String),
    });
    expect(
      accessLog
        .slice(accessBefore)
        .some(entry => entry.path === "/v1/chat/completions"),
    ).toBe(true);
  }, 120_000);

  // @lat: [[local-extract#Local Extract End-to-End#Survives a local restart]]
  it(
    "completes extract after the local stack restarts",
    async () => {
      await runWrapper("restart");
      const result = await waitForExtract(
        await startExtract(),
        successDeadlineMs,
      );
      expect(result.status).toBe("completed");
      expect(result.data).toEqual({
        name: expect.any(String),
        price: expect.any(String),
        description: expect.any(String),
      });
    },
    12 * 60_000,
  );

  // @lat: [[local-extract#Local Extract End-to-End#Fails when the shim dies in flight]]
  it("fails actionably and boundedly when the shim dies in flight", async () => {
    const dlqBefore = await getDlqCount();
    killBackendOnChat = true;
    const startedAt = Date.now();
    const result = await waitForExtract(
      await startExtract(),
      failureDeadlineMs,
    );

    expect(result.status).toBe("failed");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/codex|shim|backend|unavailable|connect/i);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(failureDeadlineMs);
    expect(await getDlqCount()).toBe(dlqBefore);
    await startBackend();
  }, 120_000);

  // @lat: [[local-extract#Local Extract End-to-End#Rejects extract while the shim is down]]
  it("returns an actionable 400 while the shim is down", async () => {
    await closeServer(proxy);
    proxy = undefined;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 16_000));
    const response = await request(testApiUrl)
      .post("/v2/extract")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send(extractRequest());
    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(
      /backend.*unreachable|unreachable.*backend/i,
    );
    await startProxy();
  }, 30_000);
});
