import assert from "node:assert/strict";
import test from "node:test";

import {
  createDisabledLocalTools,
  filterToolList,
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
        { name: "firecrawl_interact", description: "supported" },
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
        { name: "firecrawl_interact", description: "supported" },
      ],
      nextCursor: "next",
    },
    metadata: "preserved",
  });
  assert.equal(message.result.tools.length, 9);

  const notification = { jsonrpc: "2.0", method: "notifications/progress" };
  assert.equal(filterToolList(notification), notification);
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
