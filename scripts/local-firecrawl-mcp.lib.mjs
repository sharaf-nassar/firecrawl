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
      tools: message.result.tools.filter(
        (tool) => !disabledLocalTools.has(tool?.name),
      ),
    },
  };
}
