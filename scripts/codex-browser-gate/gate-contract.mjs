import { createHash } from "node:crypto";

export const CODEX_VERSION_OUTPUT = "codex-cli 0.144.5";
export const CODEX_VERSION = "0.144.5";
export const MODEL = "gpt-5.6-terra";
export const EFFORT = "medium";
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const WATCHDOG_MS = 120_000;
export const MAX_RUNS = 10;
export const CLEANUP_TERM_GRACE_MS = 250;
export const CLEANUP_KILL_GRACE_MS = 1_000;
export const CLEANUP_POLL_MS = 10;
export const CLEANUP_TOTAL_GRACE_MS = 5_000;
export const CLEANUP_DRAIN_GRACE_MS = 1_000;
export const REQUIRED_SCHEMA_DEFINITIONS = [
  "ThreadStartParams",
  "TurnStartParams",
  "ThreadStartResponse",
  "TurnCompletedNotification",
];

export const CONFIG = `model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[history]
persistence = "none"

[analytics]
enabled = false

[features]
apps = false
artifact = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
code_mode = false
code_mode_host = false
code_mode_only = false
computer_use = false
enable_mcp_apps = false
goals = false
hooks = false
image_generation = false
in_app_browser = false
memories = false
multi_agent = false
plugins = false
plugin_sharing = false
remote_plugin = false
request_permissions_tool = false
shell_snapshot = false
shell_tool = false
skill_mcp_dependency_install = false
standalone_web_search = false
tool_call_mcp_elicitation = false
tool_suggest = false
unified_exec = false
workspace_dependencies = false
`;

export const DISABLED_FEATURES = [
  "apps",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "enable_mcp_apps",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
];

export const REVIEWED_ENABLED_NON_TOOL_FEATURES = new Map([
  ["guardian_approval", "stable"],
  ["remote_compaction_v2", "stable"],
  ["resize_all_images", "removed"],
  ["tool_search_always_defer_mcp_tools", "removed"],
  ["tui_app_server", "removed"],
]);

export const TOOL_SURFACE_PATTERN =
  /tool|browser|computer|code_mode|image|app|plugin|shell|web_search|skill|mcp|artifact/;
export const FORBIDDEN_EVENT_PATTERN =
  /command|file|mcp|dynamic.?tool|browser|computer|code.?mode|web.?search|image|app|plugin|shell|approval|collab/i;
export const ALLOWED_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
]);

export function gateError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export function hashFeatureInventory(output) {
  const inventory = [];
  const names = new Set();

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^(\S+)\s{2,}(.+?)\s{2,}(true|false)$/.exec(line);
    if (!match || names.has(match[1])) {
      throw gateError("codex_feature_surface_changed");
    }
    names.add(match[1]);
    inventory.push({
      name: match[1],
      stage: match[2],
      enabled: match[3] === "true",
    });
  }

  if (inventory.length === 0) {
    throw gateError("codex_feature_surface_changed");
  }

  const byName = new Map(inventory.map(feature => [feature.name, feature]));
  for (const name of DISABLED_FEATURES) {
    if (!byName.has(name) || byName.get(name).enabled) {
      throw gateError("codex_feature_surface_changed", name);
    }
  }

  for (const feature of inventory) {
    if (!feature.enabled || !TOOL_SURFACE_PATTERN.test(feature.name)) continue;
    if (REVIEWED_ENABLED_NON_TOOL_FEATURES.get(feature.name) !== feature.stage) {
      throw gateError("codex_feature_surface_changed", feature.name);
    }
  }

  const canonical = inventory
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(feature => `${feature.name}\t${feature.stage}\t${feature.enabled}\n`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}
