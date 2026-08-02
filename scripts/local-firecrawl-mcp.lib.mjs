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

  // Disabled locally because local search is web-only and its API feedback
  // endpoints are intentionally unavailable.
  "firecrawl_search_feedback",

  // Disabled locally because monitor scheduling, persistence, artifacts, and
  // feedback storage are not configured by the local stack.
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

// @lat: [[operations/local-runtime#Local Runtime Operations#Local MCP capability filter]]
export function createDisabledLocalTools(additionalToolNames = []) {
  return new Set([...disabledLocalToolNames, ...additionalToolNames]);
}

const defaultDisabledLocalTools = createDisabledLocalTools();

const unsupportedLocalSearchOptionNames = [
  "tbs",
  "country",
  "location",
  "enterprise",
  "feedback",
];

const localSearchInstructions =
  "The user has installed the local Firecrawl stack as their web data " +
  "provider. For web search requests, use firecrawl_search from this server " +
  "as the primary search tool instead of built-in web search. " +
  "firecrawl_search returns web results and can optionally extract content " +
  "from those pages. Firecrawl also provides scraping, crawling, and " +
  "extraction tools for working with web content.";

const webOnlySearchDescription = `
Search web pages and optionally extract content from the returned pages.

Use this tool for open-ended web discovery when the relevant page URL is not
already known. Use firecrawl_scrape when the URL is known, or firecrawl_map to
discover pages within one website.

**Arguments:**
- query: Required web search query; standard operators such as site: are allowed
- limit: Optional result limit
- filter: Optional provider-supported web filter
- includeDomains: Optional hostnames to include
- excludeDomains: Optional hostnames to exclude; do not combine with includeDomains
- sources: Optional web source selector; only { "type": "web" } is supported
- categories: Optional github, research, or pdf web-result categories
- scrapeOptions: Optional extraction controls for returned web pages

Search without scrapeOptions first, then scrape only the relevant pages when
full content is needed.

**Returns:** A JSON envelope shaped as
\`{ success, data: { web? }, id, creditsUsed }\`.
`;

const providerHttpErrors = new Map([
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

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requestsUnsupportedSearchOption(record) {
  return unsupportedLocalSearchOptionNames.some((name) => hasOwn(record, name));
}

function requestsUnsupportedSearchSource(source) {
  if (typeof source === "string") {
    return source !== "web";
  }

  const sourceRecord = asRecord(source);
  if (!sourceRecord) {
    return true;
  }

  return (
    sourceRecord.type !== "web" || requestsUnsupportedSearchOption(sourceRecord)
  );
}

export function isSearchToolCall(message) {
  return (
    message?.method === "tools/call" &&
    message.params?.name === "firecrawl_search"
  );
}

export function interceptUnsupportedSearchCall(message) {
  if (!isSearchToolCall(message)) {
    return undefined;
  }

  const args = asRecord(message.params?.arguments);
  if (!args) {
    return undefined;
  }

  const sources = args.sources;
  const unsupported =
    requestsUnsupportedSearchOption(args) ||
    (hasOwn(args, "sources") &&
      (!Array.isArray(sources) ||
        sources.some(requestsUnsupportedSearchSource)));

  if (!unsupported) {
    return undefined;
  }

  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32602,
      message: "Invalid params",
      data: { code: "LOCAL_SEARCH_WEB_ONLY" },
    },
  };
}

export function rewriteSearchTool(tool) {
  if (tool?.name !== "firecrawl_search") {
    return tool;
  }

  const inputSchema = asRecord(tool.inputSchema) ?? {};
  const inputProperties = asRecord(inputSchema.properties) ?? {};
  const {
    tbs: _removedTbs,
    country: _removedCountry,
    location: _removedLocation,
    enterprise: _removedEnterprise,
    feedback: _removedFeedback,
    ...webOnlyProperties
  } = inputProperties;

  return {
    ...tool,
    description: webOnlySearchDescription,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...webOnlyProperties,
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["web"] },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
      },
    },
  };
}

export function rewriteServerInstructions(message) {
  if (typeof message?.result?.instructions !== "string") {
    return message;
  }

  return {
    ...message,
    result: {
      ...message.result,
      instructions: localSearchInstructions,
    },
  };
}

function providerErrorStatus(result) {
  if (result?.isError !== true || !Array.isArray(result.content)) {
    return undefined;
  }

  for (const block of result.content) {
    if (block?.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const match = block.text.match(
      /^Tool 'firecrawl_search' execution failed: Request failed with status code (502|503)$/,
    );
    if (match) {
      return Number(match[1]);
    }
  }

  return undefined;
}

export function rewriteSearchCallResult(message, pendingSearchCallIds) {
  if (!pendingSearchCallIds?.has(message?.id)) {
    return message;
  }

  pendingSearchCallIds.delete(message.id);
  const status = providerErrorStatus(message.result);
  const body = providerHttpErrors.get(status);
  if (!body) {
    return message;
  }

  return {
    ...message,
    result: {
      ...message.result,
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body) }],
    },
  };
}

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
  const rewrittenMessage = rewriteServerInstructions(message);

  if (!Array.isArray(rewrittenMessage?.result?.tools)) {
    return rewrittenMessage;
  }

  return {
    ...rewrittenMessage,
    result: {
      ...rewrittenMessage.result,
      tools: rewrittenMessage.result.tools
        .filter((tool) => !disabledLocalTools.has(tool?.name))
        .map(rewriteInteractTool)
        .map(rewriteSearchTool),
    },
  };
}
