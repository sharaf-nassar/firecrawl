import { createHash } from "node:crypto";

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
const requiredSchemaDefinitions = Object.freeze([
  "ThreadStartParams",
  "TurnStartParams",
  "ThreadStartResponse",
  "TurnCompletedNotification",
]);
export const REQUIRED_SCHEMA_DEFINITIONS = Object.freeze([
  ...requiredSchemaDefinitions,
]);

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
skill_search = false
standalone_web_search = false
tool_call_mcp_elicitation = false
tool_suggest = false
unified_exec = false
workspace_dependencies = false
`;

const disabledFeatures = Object.freeze([
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
  "skill_search",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
]);
export const DISABLED_FEATURES = Object.freeze([...disabledFeatures]);

const reviewedEnabledNonToolFeatures = new Map([
  ["guardian_approval", "stable"],
  ["remote_compaction_v2", "stable"],
  ["resize_all_images", "removed"],
  ["tool_search_always_defer_mcp_tools", "removed"],
  ["tui_app_server", "removed"],
]);

function readonlyMap(source) {
  let facade;
  facade = {
    get size() {
      return source.size;
    },
    get(key) {
      return source.get(key);
    },
    has(key) {
      return source.has(key);
    },
    entries() {
      return source.entries();
    },
    keys() {
      return source.keys();
    },
    values() {
      return source.values();
    },
    forEach(callback, thisArg) {
      source.forEach((value, key) => {
        callback.call(thisArg, value, key, facade);
      });
    },
    [Symbol.iterator]() {
      return source[Symbol.iterator]();
    },
  };
  return Object.freeze(facade);
}

function readonlySet(source) {
  let facade;
  facade = {
    get size() {
      return source.size;
    },
    has(value) {
      return source.has(value);
    },
    entries() {
      return source.entries();
    },
    keys() {
      return source.keys();
    },
    values() {
      return source.values();
    },
    forEach(callback, thisArg) {
      source.forEach(value => {
        callback.call(thisArg, value, value, facade);
      });
    },
    [Symbol.iterator]() {
      return source[Symbol.iterator]();
    },
  };
  return Object.freeze(facade);
}

function readonlyRegExp(pattern) {
  const source = pattern.source;
  const flags = pattern.flags;
  const create = () => new RegExp(source, flags);
  return Object.freeze({
    source,
    flags,
    global: pattern.global,
    ignoreCase: pattern.ignoreCase,
    multiline: pattern.multiline,
    dotAll: pattern.dotAll,
    unicode: pattern.unicode,
    sticky: pattern.sticky,
    hasIndices: pattern.hasIndices,
    unicodeSets: pattern.unicodeSets,
    lastIndex: 0,
    test(value) {
      return create().test(value);
    },
    exec(value) {
      return create().exec(value);
    },
    toString() {
      return pattern.toString();
    },
    [Symbol.match](value) {
      return create()[Symbol.match](value);
    },
    [Symbol.matchAll](value) {
      return create()[Symbol.matchAll](value);
    },
    [Symbol.replace](value, replacement) {
      return create()[Symbol.replace](value, replacement);
    },
    [Symbol.search](value) {
      return create()[Symbol.search](value);
    },
    [Symbol.split](value, limit) {
      return create()[Symbol.split](value, limit);
    },
  });
}

export const REVIEWED_ENABLED_NON_TOOL_FEATURES = readonlyMap(
  reviewedEnabledNonToolFeatures,
);

const toolSurfacePattern =
  /tool|browser|computer|code_mode|image|app|plugin|shell|web_search|skill|mcp|artifact/;
export const TOOL_SURFACE_PATTERN = readonlyRegExp(toolSurfacePattern);
export const FORBIDDEN_EVENT_PATTERN = readonlyRegExp(
  /command|file|mcp|dynamic.?tool|browser|computer|code.?mode|web.?search|image|app|plugin|shell|approval|collab/i,
);
const allowedItemTypes = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
]);
export const ALLOWED_ITEM_TYPES = readonlySet(allowedItemTypes);

export function gateError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  if (detail !== undefined) {
    Object.defineProperty(error, "detail", {
      configurable: false,
      enumerable: true,
      value: detail,
      writable: false,
    });
  }
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
  for (const name of disabledFeatures) {
    if (!byName.has(name) || byName.get(name).enabled) {
      throw gateError("codex_feature_surface_changed", name);
    }
  }

  for (const feature of inventory) {
    if (!feature.enabled || !toolSurfacePattern.test(feature.name)) continue;
    if (reviewedEnabledNonToolFeatures.get(feature.name) !== feature.stage) {
      throw gateError("codex_feature_surface_changed", feature.name);
    }
  }

  const canonical = inventory
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(feature => `${feature.name}\t${feature.stage}\t${feature.enabled}\n`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}
