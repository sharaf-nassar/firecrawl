import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDisabledLocalTools,
  filterToolList,
  interceptCodeCall,
  interceptUnsupportedSearchCall,
  isSearchToolCall,
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
];

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#Local MCP launcher suite]]
test("disabled local tools contain the eight unsupported capabilities", () => {
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
  assert.equal(message.result.tools.length, 10);

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
