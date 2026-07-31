import assert from "node:assert/strict";
import test from "node:test";

import {
  createDisabledLocalTools,
  filterToolList,
  interceptCodeCall,
  rewriteInteractTool,
  unsupportedToolResponse,
} from "./local-firecrawl-mcp.lib.mjs";

const disabledToolNames = [
  "firecrawl_agent",
  "firecrawl_agent_status",
  "firecrawl_research_search_papers",
  "firecrawl_research_inspect_paper",
  "firecrawl_research_related_papers",
  "firecrawl_research_read_paper",
  "firecrawl_research_search_github",
];

// @lat: [[testing/runtime-operations#Runtime and Operations Testing#Local MCP launcher suite]]
test("disabled local tools contain the seven unsupported capabilities", () => {
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
  assert.equal(message.result.tools.length, 9);

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
