import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  createDisabledLocalTools,
  filterToolList,
  interceptCodeCall,
  interceptUnsupportedSearchCall,
  isSearchToolCall,
  probeShimHealth,
  rewriteInteractTool,
  rewriteSearchCallResult,
  rewriteSearchTool,
  unsupportedToolResponse,
} from "./local-firecrawl-mcp.lib.mjs";

const upstreamInteractFixture = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/firecrawl-mcp-3.22.3-interact-tool.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const rewrittenInteractSnapshot = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/firecrawl-mcp-3.22.3-interact-tool.snapshot.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const upstreamSearchFixture = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/firecrawl-mcp-3.22.3-search-tool.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const rewrittenSearchSnapshot = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/firecrawl-mcp-3.22.3-search-tool.snapshot.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const disabledToolNames = [
  "firecrawl_agent",
  "firecrawl_agent_status",
  "firecrawl_research_search_papers",
  "firecrawl_research_inspect_paper",
  "firecrawl_research_related_papers",
  "firecrawl_research_read_paper",
  "firecrawl_research_search_github",
  "firecrawl_search_feedback",
  "firecrawl_monitor_create",
  "firecrawl_monitor_get",
  "firecrawl_monitor_list",
  "firecrawl_monitor_update",
  "firecrawl_monitor_delete",
  "firecrawl_monitor_run",
  "firecrawl_monitor_check",
  "firecrawl_monitor_checks",
  "firecrawl_feedback",
];

async function temporaryLauncher(t, envSource, copySources = false) {
  const root = await mkdtemp(join(tmpdir(), "local-firecrawl-mcp-"));
  const scriptsDirectory = join(root, "scripts");
  const launcherPath = join(scriptsDirectory, "local-firecrawl-mcp");
  await mkdir(scriptsDirectory);
  await writeFile(
    launcherPath,
    copySources
      ? await readFile(new URL("./local-firecrawl-mcp", import.meta.url))
      : "// probe fixture\n",
    { mode: 0o755 },
  );
  if (copySources) {
    await writeFile(
      join(scriptsDirectory, "local-firecrawl-mcp.lib.mjs"),
      await readFile(new URL("./local-firecrawl-mcp.lib.mjs", import.meta.url)),
    );
  }
  await writeFile(join(root, ".env"), envSource);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, launcherPath };
}

async function startHealthServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function runLauncher(launcherPath, cwd, pathPrefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath, "stub-upstream"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${pathPrefix}${delimiter}${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `launcher exited with ${code ?? signal}: ${stderr || stdout}`,
        ),
      );
    });
  });
}

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#Local MCP launcher suite#Extract capability health gating]]
test("probeShimHealth parses repo env and translates the shim host", async (t) => {
  let requestedUrl;
  const port = await startHealthServer(t, (request, response) => {
    requestedUrl = request.url;
    response.writeHead(200).end("ok");
  });
  const { launcherPath } = await temporaryLauncher(
    t,
    `# local shim\nexport OPENAI_BASE_URL = "http://host.docker.internal:${port}/v1" # route\n`,
  );

  assert.equal(await probeShimHealth({ launcherPath }), true);
  assert.equal(requestedUrl, "/health");
});

test("probeShimHealth fails closed for down and timed-out shims", async (t) => {
  const downPort = await startHealthServer(t, (_request, response) => {
    response.writeHead(503).end("down");
  });
  const timeoutPort = await startHealthServer(t, (_request, response) => {
    setTimeout(() => response.writeHead(200).end("late"), 100);
  });
  const down = await temporaryLauncher(
    t,
    `OPENAI_BASE_URL=http://127.0.0.1:${downPort}/v1\n`,
  );
  const timedOut = await temporaryLauncher(
    t,
    `OPENAI_BASE_URL=http://127.0.0.1:${timeoutPort}/v1\n`,
  );

  assert.equal(
    await probeShimHealth({ launcherPath: down.launcherPath }),
    false,
  );
  assert.equal(
    await probeShimHealth({
      launcherPath: timedOut.launcherPath,
      timeoutMs: 20,
    }),
    false,
  );
});

test("probeShimHealth rejects empty, malformed, and unreachable URLs", async (t) => {
  const port = await unusedPort();
  const empty = await temporaryLauncher(t, "OPENAI_BASE_URL=\n");
  const malformed = await temporaryLauncher(t, "OPENAI_BASE_URL=not-a-url\n");
  const unreachable = await temporaryLauncher(
    t,
    `OPENAI_BASE_URL=http://127.0.0.1:${port}/v1\n`,
  );

  assert.equal(
    await probeShimHealth({ launcherPath: empty.launcherPath }),
    false,
  );
  assert.equal(
    await probeShimHealth({ launcherPath: malformed.launcherPath }),
    false,
  );
  assert.equal(
    await probeShimHealth({ launcherPath: unreachable.launcherPath }),
    false,
  );
});

test("extract capability uses the existing disabled-tool behavior", () => {
  const disabledTools = createDisabledLocalTools(["firecrawl_extract"]);
  const discovery = filterToolList(
    {
      result: {
        tools: [{ name: "firecrawl_extract" }, { name: "firecrawl_scrape" }],
      },
    },
    disabledTools,
  );

  assert.deepEqual(discovery.result.tools, [{ name: "firecrawl_scrape" }]);
  assert.deepEqual(
    unsupportedToolResponse(
      {
        jsonrpc: "2.0",
        id: "extract",
        method: "tools/call",
        params: { name: "firecrawl_extract", arguments: {} },
      },
      disabledTools,
    ),
    {
      jsonrpc: "2.0",
      id: "extract",
      error: {
        code: -32601,
        message:
          "firecrawl_extract is disabled in the local Firecrawl MCP because its external service is not configured",
      },
    },
  );
});

test("launcher discovers repo env from a foreign working directory", async (t) => {
  const port = await startHealthServer(t, (_request, response) => {
    response.writeHead(200).end("ok");
  });
  const { root, launcherPath } = await temporaryLauncher(
    t,
    `OPENAI_BASE_URL=http://host.docker.internal:${port}/v1\n`,
    true,
  );
  const foreignCwd = await mkdtemp(join(tmpdir(), "local-firecrawl-cwd-"));
  const foreignScripts = join(foreignCwd, "scripts");
  const launcherLink = join(foreignScripts, "local-firecrawl-mcp");
  const binDirectory = join(root, "bin");
  await mkdir(foreignScripts);
  await symlink(launcherPath, launcherLink);
  await mkdir(binDirectory);
  await writeFile(
    join(binDirectory, "npx"),
    `#!/usr/bin/env node\nprocess.stdout.write('${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "firecrawl_extract" }, { name: "firecrawl_scrape" }],
      },
    }).replaceAll("'", "\\'")}\\n');\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(foreignCwd, ".env"),
    "OPENAI_BASE_URL=http://127.0.0.1:1/v1\n",
  );
  t.after(() => rm(foreignCwd, { recursive: true, force: true }));

  const healthyTools = JSON.parse(
    (await runLauncher(launcherLink, foreignCwd, binDirectory)).trim(),
  ).result.tools;
  assert.deepEqual(healthyTools, [
    { name: "firecrawl_extract" },
    { name: "firecrawl_scrape" },
  ]);

  await writeFile(join(root, ".env"), "OPENAI_BASE_URL=not-a-url\n");
  const disabledTools = JSON.parse(
    (await runLauncher(launcherLink, foreignCwd, binDirectory)).trim(),
  ).result.tools;
  assert.deepEqual(disabledTools, [{ name: "firecrawl_scrape" }]);
});

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#Local MCP launcher suite]]
test("disabled local tools contain the seventeen unsupported capabilities", () => {
  assert.deepEqual([...createDisabledLocalTools()], disabledToolNames);
});

test("filterToolList removes disabled tools without changing passthrough data", () => {
  const message = {
    jsonrpc: "2.0",
    id: 17,
    result: {
      tools: [
        { name: "firecrawl_scrape", description: "supported" },
        ...disabledToolNames.map((name) => ({ name })),
        {
          name: "firecrawl_interact",
          description: "code via bash",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              code: { type: "string" },
              language: { enum: ["bash", "python", "node"] },
            },
          },
        },
      ],
      nextCursor: "next",
    },
    metadata: "preserved",
  };

  assert.deepEqual(filterToolList(message), {
    jsonrpc: "2.0",
    id: 17,
    result: {
      tools: [
        { name: "firecrawl_scrape", description: "supported" },
        rewriteInteractTool({
          name: "firecrawl_interact",
          description: "code via bash",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              code: { type: "string" },
              language: { enum: ["bash", "python", "node"] },
            },
          },
        }),
      ],
      nextCursor: "next",
    },
    metadata: "preserved",
  });
  assert.equal(message.result.tools.length, 19);

  const notification = { jsonrpc: "2.0", method: "notifications/progress" };
  assert.equal(filterToolList(notification), notification);
});

test("rewriteInteractTool advertises prompt-driven interaction only", () => {
  const upstreamTool = {
    name: "firecrawl_interact",
    annotations: { title: "Interact with a scraped page" },
    description:
      "Use prompt or code with Bash, Python, or Node. Returns stdout, stderr, and exit code.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        scrapeId: { type: "string" },
        prompt: { type: "string", minLength: 1 },
        code: { type: "string", minLength: 1 },
        language: {
          type: "string",
          enum: ["bash", "python", "node"],
        },
        timeout: { type: "number" },
      },
      required: ["scrapeId", "code"],
      additionalProperties: false,
    },
  };

  const rewritten = rewriteInteractTool(upstreamTool);
  const advertisedSurface = JSON.stringify(rewritten).toLowerCase();

  for (const forbiddenClaim of [
    '"code"',
    "bash",
    "python",
    "stdout",
    "stderr",
    "exit code",
  ]) {
    assert.equal(advertisedSurface.includes(forbiddenClaim), false);
  }
  assert.deepEqual(rewritten.inputSchema.properties.language, {
    type: "string",
    const: "node",
  });
  assert.deepEqual(rewritten.inputSchema.required, ["scrapeId", "prompt"]);
  assert.equal(rewritten.annotations, upstreamTool.annotations);
  assert.equal(upstreamTool.inputSchema.properties.code.type, "string");

  const otherTool = { name: "firecrawl_interact_stop" };
  assert.equal(rewriteInteractTool(otherTool), otherTool);
});

test("launcher pin matches the captured upstream interact fixture", async () => {
  const launcherSource = await readFile(
    new URL("./local-firecrawl-mcp", import.meta.url),
    "utf8",
  );
  const pinnedVersions = [
    ...launcherSource.matchAll(/firecrawl-mcp@(\d+\.\d+\.\d+)/g),
  ].map((match) => match[1]);

  assert.deepEqual(pinnedVersions, [upstreamInteractFixture.upstreamVersion]);
});

test("pinned upstream interact rewrite matches the prompt-only snapshot", () => {
  assert.deepEqual(
    rewriteInteractTool(upstreamInteractFixture.tool),
    rewrittenInteractSnapshot,
  );
});

test("initialize instructions advertise local web search only", () => {
  const message = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "firecrawl-fastmcp",
        version: upstreamSearchFixture.upstreamVersion,
      },
      instructions: upstreamSearchFixture.instructions,
    },
  };

  const rewritten = filterToolList(message);
  assert.equal(
    rewritten.result.instructions,
    rewrittenSearchSnapshot.instructions,
  );
  assert.deepEqual(rewritten.result.capabilities, { tools: {} });

  const instructions = rewritten.result.instructions.toLowerCase();
  assert.match(instructions, /web search/);
  for (const forbiddenClaim of [
    "images",
    "news",
    "feedback",
    "enterprise",
    "recency",
  ]) {
    assert.equal(instructions.includes(forbiddenClaim), false);
  }
});

test("rewriteSearchTool exposes only supported web search arguments", () => {
  const rewritten = rewriteSearchTool(upstreamSearchFixture.tool);
  assert.deepEqual(rewritten, rewrittenSearchSnapshot.tool);

  assert.deepEqual(Object.keys(rewritten.inputSchema.properties), [
    "query",
    "limit",
    "filter",
    "includeDomains",
    "excludeDomains",
    "sources",
    "categories",
    "scrapeOptions",
  ]);
  assert.deepEqual(rewritten.inputSchema.properties.sources, {
    type: "array",
    items: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["web"] },
      },
      required: ["type"],
      additionalProperties: false,
    },
  });
  assert.match(rewritten.description, /Search web pages/);
  for (const forbiddenClaim of [
    "images",
    "news",
    "feedback",
    "country",
    "location",
    "recency",
    "enterprise",
  ]) {
    assert.equal(
      rewritten.description.toLowerCase().includes(forbiddenClaim),
      false,
    );
  }

  assert.equal(
    upstreamSearchFixture.tool.inputSchema.properties.tbs.type,
    "string",
  );
  assert.deepEqual(
    upstreamSearchFixture.tool.inputSchema.properties.sources.items.properties
      .type.enum,
    ["web", "images", "news"],
  );
  const otherTool = { name: "firecrawl_scrape" };
  assert.equal(rewriteSearchTool(otherTool), otherTool);
});

test("tool discovery publishes web search and hides search feedback", () => {
  const rewritten = filterToolList({
    jsonrpc: "2.0",
    id: "tools",
    result: {
      tools: [
        upstreamSearchFixture.tool,
        { name: "firecrawl_search_feedback" },
      ],
    },
  });

  assert.deepEqual(rewritten.result.tools, [rewrittenSearchSnapshot.tool]);
  assert.equal(
    rewritten.result.tools.some(
      (tool) => tool.name === "firecrawl_search_feedback",
    ),
    false,
  );
});

test("pinned upstream search rewrite matches the web-only snapshot", () => {
  assert.deepEqual(
    rewriteSearchTool(upstreamSearchFixture.tool),
    rewrittenSearchSnapshot.tool,
  );
  assert.equal(upstreamSearchFixture.upstreamVersion, "3.22.3");
});

test("interceptCodeCall rejects unsupported interact arguments clearly", () => {
  for (const [index, argumentsValue] of [
    { prompt: "click", code: "agent-browser click @e5" },
    { prompt: "click", language: "bash" },
    { prompt: "click", language: "python" },
  ].entries()) {
    assert.deepEqual(
      interceptCodeCall({
        jsonrpc: "2.0",
        id: index,
        method: "tools/call",
        params: {
          name: "firecrawl_interact",
          arguments: argumentsValue,
        },
      }),
      {
        jsonrpc: "2.0",
        id: index,
        error: {
          code: -32602,
          message:
            'firecrawl_interact is prompt-driven only in the local Firecrawl MCP; omit code and use language "node" or leave language unset',
        },
      },
    );
  }
});

test("interceptCodeCall passes through prompt and stop calls", () => {
  for (const message of [
    {
      method: "tools/call",
      params: {
        name: "firecrawl_interact",
        arguments: { scrapeId: "scrape-id", prompt: "click" },
      },
    },
    {
      method: "tools/call",
      params: {
        name: "firecrawl_interact",
        arguments: {
          scrapeId: "scrape-id",
          prompt: "click",
          language: "node",
        },
      },
    },
    {
      method: "tools/call",
      params: {
        name: "firecrawl_interact_stop",
        arguments: { scrapeId: "scrape-id" },
      },
    },
  ]) {
    assert.equal(interceptCodeCall(message), undefined);
  }
});

test("interceptUnsupportedSearchCall rejects local-only bypasses exactly", () => {
  const unsupportedArguments = [
    { query: "query", tbs: "qdr:d" },
    { query: "query", country: "us" },
    { query: "query", location: "Seattle" },
    { query: "query", enterprise: ["zdr"] },
    { query: "query", feedback: { rating: "good" } },
    { query: "query", sources: "web" },
    { query: "query", sources: [{ type: "images" }] },
    { query: "query", sources: [{ type: "news" }] },
    { query: "query", sources: ["news"] },
    { query: "query", sources: [{}] },
    { query: "query", sources: [{ type: "web", tbs: "qdr:d" }] },
  ];

  for (const [index, argumentsValue] of unsupportedArguments.entries()) {
    assert.deepEqual(
      interceptUnsupportedSearchCall({
        jsonrpc: "2.0",
        id: index,
        method: "tools/call",
        params: {
          name: "firecrawl_search",
          arguments: argumentsValue,
        },
      }),
      {
        jsonrpc: "2.0",
        id: index,
        error: {
          code: -32602,
          message: "Invalid params",
          data: { code: "LOCAL_SEARCH_WEB_ONLY" },
        },
      },
    );
  }
});

test("interceptUnsupportedSearchCall passes supported and unrelated calls", () => {
  const searchCall = {
    jsonrpc: "2.0",
    id: "search-id",
    method: "tools/call",
    params: {
      name: "firecrawl_search",
      arguments: {
        query: "query",
        limit: 5,
        filter: "site:example.test",
        sources: [{ type: "web" }],
        categories: ["pdf"],
        includeDomains: ["example.test"],
        scrapeOptions: { formats: ["markdown"] },
      },
    },
  };

  assert.equal(interceptUnsupportedSearchCall(searchCall), undefined);
  assert.equal(isSearchToolCall(searchCall), true);
  assert.equal(
    interceptUnsupportedSearchCall({
      method: "tools/call",
      params: { name: "firecrawl_scrape", arguments: {} },
    }),
    undefined,
  );
});

test("rewriteSearchCallResult restores exact provider REST errors", () => {
  const expectedByStatus = new Map([
    [
      502,
      {
        success: false,
        code: "SEARCH_PROVIDER_BAD_RESPONSE",
        error:
          "Search provider returned an invalid response. Please try again later.",
      },
    ],
    [
      503,
      {
        success: false,
        code: "SEARCH_PROVIDER_UNAVAILABLE",
        error:
          "Search provider is temporarily unavailable. Please try again later.",
      },
    ],
  ]);

  for (const [status, body] of expectedByStatus) {
    const id = `provider-${status}`;
    const pending = new Set([id]);
    const rewritten = rewriteSearchCallResult(
      {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text:
                "Tool 'firecrawl_search' execution failed: " +
                `Request failed with status code ${status}`,
            },
          ],
          isError: true,
          _meta: { trace: "preserved" },
        },
      },
      pending,
    );

    assert.deepEqual(rewritten, {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError: true,
        _meta: { trace: "preserved" },
      },
    });
    assert.equal(rewritten.result.content.length, 1);
    assert.deepEqual(JSON.parse(rewritten.result.content[0].text), body);
    assert.equal(pending.size, 0);
  }
});

test("rewriteSearchCallResult preserves empty success and unrelated errors", () => {
  const empty = {
    jsonrpc: "2.0",
    id: "empty",
    result: {
      content: [
        {
          type: "text",
          text: '{"success":true,"data":{"web":[]}}',
        },
      ],
    },
  };
  const emptyPending = new Set([empty.id]);
  assert.equal(rewriteSearchCallResult(empty, emptyPending), empty);
  assert.equal(emptyPending.size, 0);

  const otherToolError = {
    jsonrpc: "2.0",
    id: "other",
    result: {
      content: [
        {
          type: "text",
          text:
            "Tool 'firecrawl_scrape' execution failed: " +
            "Request failed with status code 503",
        },
      ],
      isError: true,
    },
  };
  const otherPending = new Set();
  assert.equal(
    rewriteSearchCallResult(otherToolError, otherPending),
    otherToolError,
  );
});

test("unsupportedToolResponse rejects all disabled tools with exact errors", () => {
  for (const [index, name] of disabledToolNames.entries()) {
    assert.deepEqual(
      unsupportedToolResponse({
        jsonrpc: "2.0",
        id: index,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
      {
        jsonrpc: "2.0",
        id: index,
        error: {
          code: -32601,
          message: `${name} is disabled in the local Firecrawl MCP because its external service is not configured`,
        },
      },
    );
  }
});

test("unsupportedToolResponse rejects monitor calls before forwarding", () => {
  assert.deepEqual(
    unsupportedToolResponse({
      jsonrpc: "2.0",
      id: "monitor-create",
      method: "tools/call",
      params: { name: "firecrawl_monitor_create", arguments: {} },
    }),
    {
      jsonrpc: "2.0",
      id: "monitor-create",
      error: {
        code: -32601,
        message:
          "firecrawl_monitor_create is disabled in the local Firecrawl MCP " +
          "because its external service is not configured",
      },
    },
  );
});

test("unsupportedToolResponse passes through supported and unrelated calls", () => {
  assert.equal(
    unsupportedToolResponse({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "firecrawl_scrape", arguments: {} },
    }),
    undefined,
  );
  assert.equal(
    unsupportedToolResponse({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
    undefined,
  );
});
