const disabledLocalToolNames = [
  // Disabled locally, not deleted upstream: these require Firecrawl's
  // external Agent service, which this self-hosted stack does not configure.
  "firecrawl_agent",
  "firecrawl_agent_status",

  // Disabled locally, not deleted upstream: these require the external
  // research proxy, which this self-hosted stack does not configure.
  "firecrawl_research_search_papers",
  "firecrawl_research_inspect_paper",
  "firecrawl_research_related_papers",
  "firecrawl_research_read_paper",
  "firecrawl_research_search_github",
];

// @lat: [[operations/local-runtime#Local Runtime Operations#Local MCP capability filter]]
export function createDisabledLocalTools(additionalToolNames = []) {
  return new Set([...disabledLocalToolNames, ...additionalToolNames]);
}

const defaultDisabledLocalTools = createDisabledLocalTools();

const promptOnlyInteractDescription = `
Interact with a page in a live browser session using a natural-language prompt.

**Best for:** Multi-step workflows on a single page, including clicking through
results, filling forms, and extracting dynamic content.

**Page selection:**
- Pass a \`url\` to open a fresh page for interaction.
- Pass a \`scrapeId\` from a previous firecrawl_scrape to reuse that page.

**Arguments:**
- url: Page to interact with (use this OR scrapeId)
- scrapeId: Scrape job ID from a previous scrape (use this OR url)
- prompt: Required natural-language instruction describing the browser task
- language: Optional compatibility marker; when provided, it must be "node"
- timeout: Execution timeout in seconds, 1-300 (optional, defaults to 30)
- scrapeOptions: Optional scrape controls used only with url mode

**Returns:** Interaction result and live view URLs.
`;

// @lat: [[operations/local-runtime#Local Runtime Operations#Local MCP capability filter]]
export function rewriteInteractTool(tool) {
  if (tool?.name !== "firecrawl_interact") {
    return tool;
  }

  const inputSchema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : {};
  const inputProperties =
    inputSchema.properties && typeof inputSchema.properties === "object"
      ? inputSchema.properties
      : {};
  const { code: _removedCode, ...promptOnlyProperties } = inputProperties;
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((name) => name !== "code")
    : [];

  if (!required.includes("prompt")) {
    required.push("prompt");
  }

  return {
    ...tool,
    description: promptOnlyInteractDescription,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...promptOnlyProperties,
        language: {
          type: "string",
          const: "node",
        },
      },
      required,
    },
  };
}

// @lat: [[operations/local-runtime#Local Runtime Operations#Local MCP capability filter]]
export function interceptCodeCall(message) {
  if (
    message?.method !== "tools/call" ||
    message.params?.name !== "firecrawl_interact"
  ) {
    return undefined;
  }

  const args = message.params.arguments;
  const hasCode =
    args !== null &&
    typeof args === "object" &&
    Object.prototype.hasOwnProperty.call(args, "code");
  const language = args?.language;

  if (!hasCode && (language === undefined || language === "node")) {
    return undefined;
  }

  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32602,
      message:
        'firecrawl_interact is prompt-driven only in the local Firecrawl MCP; omit code and use language "node" or leave language unset',
    },
  };
}

export function unsupportedToolResponse(
  message,
  disabledLocalTools = defaultDisabledLocalTools,
) {
  if (
    message?.method !== "tools/call" ||
    !disabledLocalTools.has(message.params?.name)
  ) {
    return undefined;
  }

  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `${message.params.name} is disabled in the local Firecrawl MCP because its external service is not configured`,
    },
  };
}

export function filterToolList(
  message,
  disabledLocalTools = defaultDisabledLocalTools,
) {
  if (!Array.isArray(message?.result?.tools)) {
    return message;
  }

  return {
    ...message,
    result: {
      ...message.result,
      tools: message.result.tools
        .filter((tool) => !disabledLocalTools.has(tool?.name))
        .map(rewriteInteractTool),
    },
  };
}
