import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import ts from "typescript";

export type BrowserContractSource = { path: string; text: string };
export type BrowserContractFinding = {
  ruleId: string;
  path: string;
  line: number;
  match: string;
};
export type BrowserSchemaRole =
  | "browser_schema"
  | "reviewed_non_browser_schema"
  | "non_schema";
export type BridgeImportClassification =
  | "browser_follow"
  | "reviewed_non_browser_boundary";

export const browserContractDiscovery = {
  recursiveTypeScriptRoots: [
    "apps/browser-service/src",
    "apps/api/src/lib/browser-state",
    "apps/api/src/lib/browser-runtime",
    "apps/api/src/lib/scrape-interact",
    "apps/api/src/db/schema",
  ],
  recursiveDatabaseGlobs: ["apps/api/src/db/migrations/*browser*.sql"],
  closureEntryPoints: [
    "apps/api/src/lib/local-runtime-config.ts",
    "apps/api/src/services/local-retention-worker.ts",
    "apps/api/src/controllers/v2/browser.ts",
    "apps/api/src/controllers/v2/scrape-browser.ts",
    "apps/api/src/controllers/v2/browser-proxy.ts",
    "apps/api/src/harness-browser-service.ts",
  ],
  scanOnlyBridgeFiles: [
    "apps/api/src/config.ts",
    "apps/api/src/controllers/v2/types.ts",
    "apps/api/src/routes/v2.ts",
    "apps/api/src/index.ts",
    "apps/api/src/harness.ts",
    "apps/api/src/harness-browser-command.ts",
    "apps/api/src/services/browser-admission-cleanup.ts",
    "apps/api/src/services/browser-billing-outbox.ts",
  ],
  explicitProductionRoots: [
    "apps/browser-service/contracts/private-v1.contract.json",
    "apps/browser-service/package.json",
    "apps/browser-service/tsconfig.json",
    "apps/browser-service/Dockerfile",
    "apps/browser-service/src/runtime-preflight.mjs",
    "scripts/local-firecrawl",
    "apps/api/package.json",
    "compose.local.yaml",
    ".env.example.local",
  ],
  requiredProductionPaths: [
    "apps/api/src/lib/browser-state/filesystem-store-internal.ts",
    "apps/api/src/lib/browser-state/transitions.ts",
    "apps/api/src/lib/browser-state/process-identity.ts",
    "apps/api/src/lib/browser-state/legacy-compatibility.ts",
    "apps/api/src/lib/scrape-interact/replay-envelope.ts",
  ],
  taskPlan: null,
  reviewedExclusions: [
    {
      id: "test_or_negative_fixture",
      suffix: /(?:\.test|\.spec|\.integration\.test)\.[cm]?[jt]sx?$/,
      requireMatch: true,
    },
    {
      id: "snip_fixture",
      prefix: "apps/api/src/__tests__/snips/",
      requireMatch: true,
    },
    {
      id: "scanner_rule_literal_source",
      exact: "apps/api/src/cli/browser-stale-contract-scan.ts",
      requireMatch: true,
    },
    {
      id: "generated_lockfile",
      exact: "apps/browser-service/pnpm-lock.yaml",
      requireMatch: true,
    },
    {
      id: "generated_or_vendor_tree",
      prefixes: ["apps/browser-service/dist/", "node_modules/"],
      requireMatchWhenPresent: true,
    },
  ],
} as const;

export const browserSchemaRolePolicy = {
  browserOwnedRoots: [
    "apps/browser-service/src/",
    "apps/api/src/lib/browser-state/",
    "apps/api/src/lib/browser-runtime/",
    "apps/api/src/lib/scrape-interact/",
  ],
  browserSchemaExactFiles: [
    "apps/api/src/controllers/v2/browser.ts",
    "apps/api/src/controllers/v2/scrape-browser.ts",
    "apps/api/src/controllers/v2/browser-proxy.ts",
  ],
  reviewedNonBrowserSchemaExactFiles: [
    "apps/api/src/config.ts",
    "apps/api/src/controllers/v2/types.ts",
  ],
} as const;

/**
 * This is deliberately target-based and closed: bridge imports may only point
 * at the exact targets present when this scanner was reviewed. Classification
 * is checked in both directions before any stale-contract rule runs.
 */
export const browserBridgeImportClassifications: Readonly<
  Record<string, Readonly<Record<string, BridgeImportClassification>>>
> = {
  "apps/api/src/services/local-retention-worker.ts": Object.fromEntries([
    ...[
      "apps/api/src/lib/browser-runtime/startup-gate.ts",
      "apps/api/src/lib/browser-state/process-identity.ts",
      "apps/api/src/lib/local-runtime-config.ts",
    ].map(path => [path, "browser_follow"]),
    ...[
      "apps/api/src/config.ts",
      "apps/api/src/lib/artifacts/index.ts",
      "apps/api/src/lib/logger.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
  "apps/api/src/controllers/v2/browser.ts": Object.fromEntries([
    [
      "apps/api/src/lib/browser-runtime/public-browser-runtime.ts",
      "browser_follow",
    ],
    ...[
      "apps/api/src/config.ts",
      "apps/api/src/controllers/v2/types.ts",
      "apps/api/src/lib/browser-billing.ts",
      "apps/api/src/lib/browser-session-activity.ts",
      "apps/api/src/lib/browser-sessions.ts",
      "apps/api/src/lib/logger.ts",
      "apps/api/src/services/autumn/autumn.service.ts",
      "apps/api/src/services/billing/credit_billing.ts",
      "apps/api/src/services/logging/log_job.ts",
      "apps/api/src/services/worker/nuq-router.ts",
      "apps/api/src/utils/integration.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
  "apps/api/src/controllers/v2/scrape-browser.ts": Object.fromEntries([
    ...[
      "apps/api/src/controllers/v2/browser.ts",
      "apps/api/src/lib/browser-runtime/public-browser-runtime.ts",
      "apps/api/src/lib/scrape-interact/legacy-browser-service-client.ts",
      "apps/api/src/lib/scrape-interact/langsmith.ts",
      "apps/api/src/lib/scrape-interact/scrape-replay.ts",
    ].map(path => [path, "browser_follow"]),
    ...[
      "apps/api/src/config.ts",
      "apps/api/src/controllers/v2/types.ts",
      "apps/api/src/lib/agent-auth-discovery.ts",
      "apps/api/src/lib/browser-billing.ts",
      "apps/api/src/lib/browser-session-activity.ts",
      "apps/api/src/lib/browser-sessions.ts",
      "apps/api/src/lib/keyless.ts",
      "apps/api/src/lib/local-owner.ts",
      "apps/api/src/lib/logger.ts",
      "apps/api/src/lib/supabase-jobs.ts",
      "apps/api/src/lib/zdr-helpers.ts",
      "apps/api/src/services/autumn/autumn.service.ts",
      "apps/api/src/services/billing/credit_billing.ts",
      "apps/api/src/services/logging/log_job.ts",
      "apps/api/src/services/worker/nuq-router.ts",
      "apps/api/src/utils/integration.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
  "apps/api/src/controllers/v2/browser-proxy.ts": Object.fromEntries(
    [
      "apps/api/src/lib/browser-runtime/startup-gate.ts",
      "apps/api/src/lib/browser-state/proxy-grant-store.ts",
      "apps/api/src/lib/scrape-interact/browser-service-client.ts",
    ].map(path => [path, "browser_follow"]),
  ),
  "apps/api/src/harness-browser-service.ts": {
    "apps/api/src/harness-browser-command.ts": "browser_follow",
  },
  "apps/api/src/harness-browser-command.ts": {},
  "apps/api/src/services/browser-admission-cleanup.ts": Object.fromEntries([
    ...[
      "apps/api/src/lib/browser-runtime/startup-gate.ts",
      "apps/api/src/lib/browser-state/store.ts",
    ].map(path => [path, "browser_follow"]),
    ...[
      "apps/api/src/lib/logger.ts",
      "apps/api/src/services/worker/nuq-router.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
  "apps/api/src/services/browser-billing-outbox.ts": Object.fromEntries([
    ...[
      "apps/api/src/lib/browser-runtime/startup-gate.ts",
      "apps/api/src/lib/browser-state/store.ts",
    ].map(path => [path, "browser_follow"]),
    ...[
      "apps/api/src/config.ts",
      "apps/api/src/lib/keyless.ts",
      "apps/api/src/lib/logger.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
  "apps/api/src/config.ts": {
    "apps/api/src/lib/local-runtime-config.ts": "browser_follow",
  },
  "apps/api/src/controllers/v2/types.ts": Object.fromEntries(
    [
      "apps/api/src/config.ts",
      "apps/api/src/lib/validateUrl.ts",
      "apps/api/src/lib/validate-country.ts",
      "apps/api/src/lib/format-utils.ts",
      "apps/api/src/lib/entities.ts",
      "apps/api/src/controllers/v1/types.ts",
      "apps/api/src/scraper/scrapeURL/index.ts",
      "apps/api/src/lib/error.ts",
      "apps/api/src/utils/integration.ts",
      "apps/api/src/services/webhook/schema.ts",
      "apps/api/src/types/branding.ts",
      "apps/api/src/types/product.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ),
  "apps/api/src/routes/v2.ts": Object.fromEntries([
    ...[
      "apps/api/src/controllers/v2/browser.ts",
      "apps/api/src/controllers/v2/scrape-browser.ts",
      "apps/api/src/controllers/v2/browser-proxy.ts",
    ].map(path => [path, "browser_follow"]),
    ...[
      "apps/api/src/config.ts",
      "apps/api/src/types.ts",
      "apps/api/src/services/autumn/autumn.service.ts",
      "apps/api/src/controllers/v2/search.ts",
      "apps/api/src/controllers/v2/feedback/controller.ts",
      "apps/api/src/controllers/v2/search-feedback.ts",
      "apps/api/src/controllers/v2/x402-search.ts",
      "apps/api/src/controllers/v2/scrape.ts",
      "apps/api/src/controllers/v2/keyless-eligibility.ts",
      "apps/api/src/controllers/v2/parse.ts",
      "apps/api/src/controllers/v2/batch-scrape.ts",
      "apps/api/src/controllers/v2/crawl.ts",
      "apps/api/src/controllers/v2/crawl-params-preview.ts",
      "apps/api/src/controllers/v2/crawl-status.ts",
      "apps/api/src/controllers/v2/map.ts",
      "apps/api/src/controllers/v2/crawl-errors.ts",
      "apps/api/src/controllers/v2/crawl-ongoing.ts",
      "apps/api/src/controllers/v2/scrape-status.ts",
      "apps/api/src/controllers/v2/credit-usage.ts",
      "apps/api/src/controllers/v2/token-usage.ts",
      "apps/api/src/controllers/v2/crawl-cancel.ts",
      "apps/api/src/controllers/v2/concurrency-check.ts",
      "apps/api/src/controllers/v2/crawl-status-ws.ts",
      "apps/api/src/controllers/v2/extract.ts",
      "apps/api/src/controllers/v2/extract-status.ts",
      "apps/api/src/routes/shared.ts",
      "apps/api/src/controllers/v2/queue-status.ts",
      "apps/api/src/controllers/v2/credit-usage-historical.ts",
      "apps/api/src/controllers/v2/token-usage-historical.ts",
      "apps/api/src/lib/x402.ts",
      "apps/api/src/lib/deprecations.ts",
      "apps/api/src/controllers/v2/agent.ts",
      "apps/api/src/controllers/v2/agent-status.ts",
      "apps/api/src/controllers/v2/agent-cancel.ts",
      "apps/api/src/controllers/v1/activity.ts",
      "apps/api/src/controllers/v2/support-proxy.ts",
      "apps/api/src/controllers/v2/research-proxy.ts",
      "apps/api/src/controllers/v2/monitor.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
  "apps/api/src/index.ts": Object.fromEntries([
    ...[
      "apps/api/src/lib/browser-runtime/api-startup-lifecycle.ts",
      "apps/api/src/lib/browser-runtime/execution-adapter.ts",
      "apps/api/src/lib/browser-runtime/public-browser-runtime.ts",
      "apps/api/src/lib/browser-runtime/reconciliation-coordinator.ts",
      "apps/api/src/lib/browser-runtime/reconciliation-snapshot.ts",
      "apps/api/src/lib/browser-runtime/startup-gate.ts",
      "apps/api/src/lib/browser-state/process-identity.ts",
      "apps/api/src/lib/browser-state/proxy-grant-store.ts",
      "apps/api/src/lib/browser-state/store.ts",
      "apps/api/src/lib/local-runtime-config.ts",
      "apps/api/src/lib/scrape-interact/browser-service-client.ts",
      "apps/api/src/lib/scrape-interact/replay-store.ts",
      "apps/api/src/controllers/v2/browser-proxy.ts",
      "apps/api/src/services/local-retention-worker.ts",
      "apps/api/src/services/browser-admission-cleanup.ts",
      "apps/api/src/services/browser-billing-outbox.ts",
    ].map(path => [path, "browser_follow"]),
    ...[
      "apps/api/src/config.ts",
      "apps/api/src/services/sentry.ts",
      "apps/api/src/routes/v0.ts",
      "apps/api/src/lib/logger.ts",
      "apps/api/src/routes/admin.ts",
      "apps/api/src/routes/v1.ts",
      "apps/api/src/lib/queue-full-error.ts",
      "apps/api/src/services/agentLivecastWS.ts",
      "apps/api/src/scraper/scrapeURL/lib/cacheableLookup.ts",
      "apps/api/src/routes/v2.ts",
      "apps/api/src/services/worker/nuq.ts",
      "apps/api/src/lib/deployment.ts",
      "apps/api/src/scraper/WebScraper/utils/blocklist.ts",
      "apps/api/src/scraper/WebScraper/utils/engine-forcing.ts",
      "apps/api/src/services/webhook/index.ts",
      "apps/api/src/services/indexing/indexer-queue.ts",
      "apps/api/src/db/migrate.ts",
      "apps/api/src/controllers/v1/types.ts",
      "apps/api/src/services/queue-service.ts",
      "apps/api/src/services/worker/nuq-router.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
  "apps/api/src/harness.ts": Object.fromEntries([
    ...[
      "apps/api/src/harness-browser-command.ts",
      "apps/api/src/harness-browser-service.ts",
    ].map(path => [path, "browser_follow"]),
    ...[
      "apps/api/src/config.ts",
      "apps/api/src/natives.ts",
      "apps/api/src/harness-container.ts",
      "apps/api/src/harness-local-persistence.ts",
      "apps/api/src/harness-shutdown.ts",
    ].map(path => [path, "reviewed_non_browser_boundary"]),
  ]),
} as const;

export const browserClosureBoundaryImports: Readonly<
  Record<string, readonly string[]>
> = {
  "apps/api/src/lib/browser-runtime/public-browser-runtime.ts": [
    "apps/api/src/services/worker/nuq-router.ts",
  ],
} as const;

export type BrowserContractDiscoveryPolicy = {
  recursiveTypeScriptRoots: readonly string[];
  recursiveDatabaseGlobs: readonly string[];
  closureEntryPoints: readonly string[];
  scanOnlyBridgeFiles: readonly string[];
  explicitProductionRoots: readonly string[];
  requiredProductionPaths: readonly string[];
  taskPlan: string | null;
  reviewedExclusions: readonly (
    | { id: string; suffix: RegExp; requireMatch?: boolean }
    | { id: string; prefix: string; requireMatch?: boolean }
    | { id: string; exact: string; requireMatch?: boolean }
    | {
        id: string;
        prefixes: readonly string[];
        requireMatchWhenPresent?: boolean;
      }
  )[];
};

export type BrowserSchemaRolePolicy = {
  browserOwnedRoots: readonly string[];
  browserSchemaExactFiles: readonly string[];
  reviewedNonBrowserSchemaExactFiles: readonly string[];
};

export type BrowserScannerPolicy = {
  discovery: BrowserContractDiscoveryPolicy;
  schemaRoles: BrowserSchemaRolePolicy;
  bridgeClassifications: Readonly<
    Record<string, Readonly<Record<string, BridgeImportClassification>>>
  >;
  closureBoundaryImports: Readonly<Record<string, readonly string[]>>;
};

const defaultPolicy: BrowserScannerPolicy = {
  discovery: browserContractDiscovery,
  schemaRoles: browserSchemaRolePolicy,
  bridgeClassifications: browserBridgeImportClassifications,
  closureBoundaryImports: browserClosureBoundaryImports,
};

const TS_EXTENSIONS = [".ts", ".tsx", ".cts", ".mts"] as const;
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
] as const;

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function sanitize(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function finding(
  ruleId: string,
  source: BrowserContractSource,
  offset: number,
  match: string,
): BrowserContractFinding {
  return {
    ruleId,
    path: source.path,
    line: lineOf(source.text, Math.max(0, offset)),
    match: sanitize(match),
  };
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      out.push(path);
    }
  };
  visit(root);
  return out;
}

function isTestPath(path: string): boolean {
  return /(?:\.test|\.spec|\.integration\.test)\.[cm]?[jt]sx?$/.test(path);
}

function isExcluded(
  path: string,
  policy: BrowserContractDiscoveryPolicy,
): boolean {
  return policy.reviewedExclusions.some(exclusion => {
    if ("exact" in exclusion && exclusion.exact === path) return true;
    if ("prefix" in exclusion && path.startsWith(exclusion.prefix)) return true;
    if ("prefixes" in exclusion) {
      return exclusion.prefixes.some(prefix => path.startsWith(prefix));
    }
    return "suffix" in exclusion && exclusion.suffix.test(path);
  });
}

/** Discover production roots without following imports. */
export function discoverBrowserContractSources(
  workspaceRoot: string,
  policy: BrowserScannerPolicy = defaultPolicy,
): string[] {
  const root = realpathSync(workspaceRoot);
  const candidates = new Set<string>();
  for (const relativeRoot of policy.discovery.recursiveTypeScriptRoots) {
    for (const absolute of walkFiles(resolve(root, relativeRoot))) {
      const path = normalize(relative(root, absolute));
      if (TS_EXTENSIONS.some(extension => path.endsWith(extension))) {
        candidates.add(path);
      }
    }
  }
  for (const glob of policy.discovery.recursiveDatabaseGlobs) {
    const directory = glob.slice(0, glob.lastIndexOf("/"));
    const pattern = glob.slice(glob.lastIndexOf("/") + 1);
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
    );
    for (const absolute of walkFiles(resolve(root, directory))) {
      const path = normalize(relative(root, absolute));
      if (regex.test(path.slice(path.lastIndexOf("/") + 1)))
        candidates.add(path);
    }
  }
  for (const path of [
    ...policy.discovery.closureEntryPoints,
    ...policy.discovery.scanOnlyBridgeFiles,
    ...policy.discovery.explicitProductionRoots,
  ]) {
    if (existsSync(resolve(root, path))) candidates.add(path);
  }
  return [...candidates]
    .filter(path => !isExcluded(path, policy.discovery))
    .sort();
}

type ModuleReference = {
  specifier?: string;
  offset: number;
  text: string;
};

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".cjs") || path.endsWith(".mjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function moduleReferences(path: string, text: string): ModuleReference[] {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const references: ModuleReference[] = [];
  const add = (node: ts.Node | undefined) => {
    if (!node) return;
    references.push({
      specifier: ts.isStringLiteralLike(node) ? node.text : undefined,
      offset: node.getStart(source),
      text: node.getText(source),
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node.arguments[0]);
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

type TsconfigPaths = {
  baseUrl: string;
  paths: Record<string, readonly string[]>;
};

function readTsconfigPaths(workspaceRoot: string): TsconfigPaths {
  const candidates = [
    resolve(workspaceRoot, "apps/api/tsconfig.json"),
    resolve(workspaceRoot, "tsconfig.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = ts.parseConfigFileTextToJson(
      path,
      readFileSync(path, "utf8"),
    );
    const options = parsed.config?.compilerOptions ?? {};
    return {
      baseUrl: resolve(dirname(path), options.baseUrl ?? "."),
      paths: options.paths ?? {},
    };
  }
  return { baseUrl: workspaceRoot, paths: {} };
}

function aliasedCandidates(
  specifier: string,
  paths: TsconfigPaths,
): string[] | undefined {
  for (const [pattern, replacements] of Object.entries(paths.paths)) {
    const star = pattern.indexOf("*");
    if (
      (star < 0 && pattern !== specifier) ||
      (star >= 0 &&
        (!specifier.startsWith(pattern.slice(0, star)) ||
          !specifier.endsWith(pattern.slice(star + 1))))
    ) {
      continue;
    }
    const capture =
      star < 0
        ? ""
        : specifier.slice(
            pattern.slice(0, star).length,
            specifier.length - pattern.slice(star + 1).length,
          );
    return replacements.map(replacement =>
      resolve(paths.baseUrl, replacement.replace("*", capture)),
    );
  }
  return undefined;
}

function sourceCandidates(base: string): string[] {
  const extension = extname(base);
  const out: string[] = [];
  if (
    SOURCE_EXTENSIONS.includes(extension as (typeof SOURCE_EXTENSIONS)[number])
  ) {
    const stem = base.slice(0, -extension.length);
    const mapped =
      extension === ".js"
        ? [".ts", ".tsx", ".js"]
        : extension === ".cjs"
          ? [".cts", ".cjs"]
          : extension === ".mjs"
            ? [".mts", ".mjs"]
            : [extension];
    for (const suffix of mapped) out.push(stem + suffix);
  } else {
    for (const suffix of TS_EXTENSIONS) out.push(base + suffix);
    for (const suffix of TS_EXTENSIONS) out.push(join(base, `index${suffix}`));
  }
  return [...new Set(out)];
}

function resolveModule(
  specifier: string,
  importer: string,
  workspaceRoot: string,
  paths: TsconfigPaths,
): { kind: "external" } | { kind: "local"; path: string } | undefined {
  let bases: string[] | undefined;
  if (specifier.startsWith(".")) {
    bases = [resolve(workspaceRoot, dirname(importer), specifier)];
  } else if (isAbsolute(specifier)) {
    bases = [specifier];
  } else {
    bases = aliasedCandidates(specifier, paths);
    if (!bases) return { kind: "external" };
  }
  for (const base of bases) {
    for (const candidate of sourceCandidates(base)) {
      if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
      const path = normalize(relative(workspaceRoot, realpathSync(candidate)));
      if (path.startsWith("../") || path === "..") return undefined;
      return { kind: "local", path };
    }
  }
  return undefined;
}

export type ClosureResult = {
  paths: string[];
  findings: BrowserContractFinding[];
  edges: ReadonlyMap<string, readonly string[]>;
};

/** Resolve every supported local module edge to a fixed point. */
export function resolveLocalImportClosure(
  entryPaths: readonly string[],
  workspaceRoot: string,
): ClosureResult {
  return resolveLocalImportClosureChecked(entryPaths, workspaceRoot, new Set());
}

export function resolveLocalImportClosureChecked(
  entryPaths: readonly string[],
  workspaceRoot: string,
  stopPaths: ReadonlySet<string>,
  stopEdges: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ClosureResult {
  const root = realpathSync(workspaceRoot);
  const paths = readTsconfigPaths(root);
  const queue = [...new Set(entryPaths.map(normalize))].sort();
  const visited = new Set<string>();
  const findings: BrowserContractFinding[] = [];
  const edges = new Map<string, string[]>();
  while (queue.length) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const absolute = resolve(root, path);
    if (
      !existsSync(absolute) ||
      !SOURCE_EXTENSIONS.some(ext => path.endsWith(ext))
    ) {
      continue;
    }
    const source = { path, text: readFileSync(absolute, "utf8") };
    const targets: string[] = [];
    if (stopPaths.has(path)) {
      edges.set(path, targets);
      continue;
    }
    for (const reference of moduleReferences(path, source.text)) {
      if (reference.specifier === undefined) {
        findings.push(
          finding(
            "inventory_module_reference_unresolved",
            source,
            reference.offset,
            reference.text,
          ),
        );
        continue;
      }
      const resolved = resolveModule(reference.specifier, path, root, paths);
      if (!resolved) {
        findings.push(
          finding(
            "inventory_module_reference_unresolved",
            source,
            reference.offset,
            reference.text,
          ),
        );
      } else if (resolved.kind === "local") {
        if (stopEdges.get(path)?.has(resolved.path)) continue;
        targets.push(resolved.path);
        if (!visited.has(resolved.path)) queue.push(resolved.path);
      }
    }
    edges.set(path, [...new Set(targets)].sort());
    queue.sort();
  }
  return { paths: [...visited].sort(), findings, edges };
}

function isZodSchemaBearing(source: BrowserContractSource): boolean {
  if (!SOURCE_EXTENSIONS.some(extension => source.path.endsWith(extension))) {
    return false;
  }
  const file = ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(source.path),
  );
  const zodNames = new Set<string>();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "zod"
    ) {
      const clause = statement.importClause;
      if (clause?.name) zodNames.add(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          zodNames.add(clause.namedBindings.name.text);
        } else {
          for (const element of clause.namedBindings.elements) {
            if ((element.propertyName ?? element.name).text === "z") {
              zodNames.add(element.name.text);
            }
          }
        }
      }
    }
  }
  let bearing = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      zodNames.has(node.expression.expression.text)
    ) {
      bearing = true;
    }
    if (!bearing) ts.forEachChild(node, visit);
  };
  visit(file);
  return bearing;
}

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => path.startsWith(prefix));
}

function taskPaths(plan: string): string[] {
  const paths = new Set<string>();
  const regex = /^-\s+(?:Create|Modify):\s+`([^`]+)`/gm;
  for (const match of plan.matchAll(regex)) paths.add(normalize(match[1]));
  return [...paths].sort();
}

function exclusionCoverage(
  workspaceRoot: string,
  policy: BrowserScannerPolicy,
): BrowserContractFinding[] {
  const findings: BrowserContractFinding[] = [];
  const discovery = policy.discovery;
  const candidates = new Set<string>();
  for (const root of discovery.recursiveTypeScriptRoots) {
    for (const file of walkFiles(resolve(workspaceRoot, root))) {
      candidates.add(normalize(relative(workspaceRoot, file)));
    }
  }
  for (const path of [
    "apps/api/src/__tests__/snips",
    "apps/api/src/cli/browser-stale-contract-scan.ts",
    "apps/browser-service/pnpm-lock.yaml",
    "apps/browser-service/dist",
  ]) {
    for (const file of walkFiles(resolve(workspaceRoot, path))) {
      candidates.add(normalize(relative(workspaceRoot, file)));
    }
    if (
      existsSync(resolve(workspaceRoot, path)) &&
      !lstatSync(resolve(workspaceRoot, path)).isDirectory()
    ) {
      candidates.add(path);
    }
    if (existsSync(resolve(workspaceRoot, path))) candidates.add(`${path}/`);
  }
  if (existsSync(resolve(workspaceRoot, "node_modules"))) {
    candidates.add("node_modules/");
  }
  const source = { path: "<inventory>", text: "" };
  for (const exclusion of discovery.reviewedExclusions) {
    let matches = false;
    for (const path of candidates) {
      if ("exact" in exclusion && path === exclusion.exact) matches = true;
      if ("prefix" in exclusion && path.startsWith(exclusion.prefix))
        matches = true;
      if (
        "prefixes" in exclusion &&
        exclusion.prefixes.some(p => path.startsWith(p))
      ) {
        matches = true;
      }
      if ("suffix" in exclusion && exclusion.suffix.test(path)) matches = true;
    }
    const required =
      ("requireMatch" in exclusion && exclusion.requireMatch) ||
      ("requireMatchWhenPresent" in exclusion &&
        exclusion.requireMatchWhenPresent &&
        "prefixes" in exclusion &&
        exclusion.prefixes.some(prefix =>
          existsSync(resolve(workspaceRoot, prefix)),
        ));
    if (required && !matches) {
      findings.push(
        finding("inventory_stale_exclusion", source, 0, exclusion.id),
      );
    }
  }
  return findings;
}

export type BrowserContractInventoryResult = {
  inventory: string[];
  roles: Record<string, BrowserSchemaRole>;
  findings: BrowserContractFinding[];
  sources: BrowserContractSource[];
};

export function buildBrowserContractInventory(
  workspaceRoot: string,
  policy: BrowserScannerPolicy = defaultPolicy,
): BrowserContractInventoryResult {
  const root = realpathSync(workspaceRoot);
  const findings = exclusionCoverage(root, policy);
  const discovered = discoverBrowserContractSources(root, policy);
  const bridgeSet = new Set<string>(policy.discovery.scanOnlyBridgeFiles);
  const pathsConfig = readTsconfigPaths(root);
  const mutableClosureBoundaryEdges = new Map<string, Set<string>>();
  for (const [importer, classifications] of Object.entries(
    policy.bridgeClassifications,
  )) {
    for (const [target, classification] of Object.entries(classifications)) {
      if (classification !== "reviewed_non_browser_boundary") continue;
      const boundaries =
        mutableClosureBoundaryEdges.get(importer) ?? new Set<string>();
      boundaries.add(target);
      mutableClosureBoundaryEdges.set(importer, boundaries);
    }
  }
  for (const [importer, declaredTargets] of Object.entries(
    policy.closureBoundaryImports,
  ).sort(([first], [second]) => first.localeCompare(second))) {
    const absolute = resolve(root, importer);
    if (!existsSync(absolute)) {
      findings.push({
        ruleId: "inventory_required_path_missing",
        path: importer,
        line: 1,
        match: importer,
      });
      continue;
    }
    const source = { path: importer, text: readFileSync(absolute, "utf8") };
    const actual = new Set<string>();
    for (const reference of moduleReferences(importer, source.text)) {
      if (reference.specifier === undefined) continue;
      const resolved = resolveModule(
        reference.specifier,
        importer,
        root,
        pathsConfig,
      );
      if (resolved?.kind === "local") actual.add(resolved.path);
    }
    for (const target of declaredTargets) {
      if (!actual.has(target)) {
        findings.push(
          finding(
            "inventory_bridge_import_unclassified",
            source,
            0,
            `stale closure boundary ${importer} -> ${target}`,
          ),
        );
      }
      if (
        hasPrefix(target, policy.schemaRoles.browserOwnedRoots) ||
        policy.schemaRoles.browserSchemaExactFiles.includes(target)
      ) {
        findings.push(
          finding(
            "inventory_bridge_import_unclassified",
            source,
            0,
            `${target} is browser-owned`,
          ),
        );
      }
    }
    const boundaries =
      mutableClosureBoundaryEdges.get(importer) ?? new Set<string>();
    for (const target of declaredTargets) boundaries.add(target);
    mutableClosureBoundaryEdges.set(importer, boundaries);
  }
  const closureBoundaryEdges: ReadonlyMap<
    string,
    ReadonlySet<string>
  > = mutableClosureBoundaryEdges;
  const closureSeeds = discovered.filter(path => !bridgeSet.has(path));
  const closure = resolveLocalImportClosureChecked(
    closureSeeds,
    root,
    bridgeSet,
    closureBoundaryEdges,
  );
  findings.push(...closure.findings);
  const inventory = new Set([...discovered, ...closure.paths]);
  for (const path of closure.paths) {
    if (isExcluded(path, policy.discovery) && !discovered.includes(path)) {
      findings.push({
        ruleId: "inventory_import_unclosed",
        path,
        line: 1,
        match: "production import crosses reviewed exclusion",
      });
      inventory.delete(path);
    }
  }
  const browserFollowRoots = new Set<string>();

  for (const bridge of Object.keys(policy.bridgeClassifications).sort()) {
    const absolute = resolve(root, bridge);
    if (!existsSync(absolute)) continue;
    const source = { path: bridge, text: readFileSync(absolute, "utf8") };
    const actual = new Set<string>();
    for (const reference of moduleReferences(bridge, source.text)) {
      if (reference.specifier === undefined) {
        findings.push(
          finding(
            "inventory_module_reference_unresolved",
            source,
            reference.offset,
            reference.text,
          ),
        );
        continue;
      }
      const resolved = resolveModule(
        reference.specifier,
        bridge,
        root,
        pathsConfig,
      );
      if (!resolved) {
        findings.push(
          finding(
            "inventory_module_reference_unresolved",
            source,
            reference.offset,
            reference.text,
          ),
        );
      } else if (resolved.kind === "local") {
        actual.add(resolved.path);
      }
    }
    const declared = policy.bridgeClassifications[bridge] ?? {};
    for (const target of actual) {
      const classification = declared[target];
      if (!classification) {
        findings.push(
          finding(
            "inventory_bridge_import_unclassified",
            source,
            0,
            `${bridge} -> ${target}`,
          ),
        );
        continue;
      }
      const browserTarget =
        hasPrefix(target, policy.schemaRoles.browserOwnedRoots) ||
        policy.schemaRoles.browserSchemaExactFiles.includes(target) ||
        policy.discovery.closureEntryPoints.includes(target);
      if (classification === "reviewed_non_browser_boundary" && browserTarget) {
        findings.push(
          finding(
            "inventory_bridge_import_unclassified",
            source,
            0,
            `${target} is browser-owned`,
          ),
        );
      }
      if (classification === "browser_follow") browserFollowRoots.add(target);
    }
    for (const target of Object.keys(declared)) {
      if (!actual.has(target)) {
        findings.push(
          finding(
            "inventory_bridge_import_unclassified",
            source,
            0,
            `stale ${bridge} -> ${target}`,
          ),
        );
      }
    }
  }

  if (browserFollowRoots.size) {
    const followed = resolveLocalImportClosureChecked(
      [...browserFollowRoots],
      root,
      bridgeSet,
      closureBoundaryEdges,
    );
    findings.push(...followed.findings);
    for (const path of followed.paths) {
      if (isExcluded(path, policy.discovery)) {
        findings.push({
          ruleId: "inventory_import_unclosed",
          path,
          line: 1,
          match: "browser-follow import crosses reviewed exclusion",
        });
      } else {
        inventory.add(path);
      }
    }
    for (const rootPath of browserFollowRoots) inventory.add(rootPath);
  }

  for (const required of policy.discovery.requiredProductionPaths) {
    if (!existsSync(resolve(root, required))) {
      findings.push({
        ruleId: "inventory_required_path_missing",
        path: required,
        line: 1,
        match: required,
      });
    } else if (!inventory.has(required)) {
      findings.push({
        ruleId: "inventory_discovery_unlisted",
        path: required,
        line: 1,
        match: required,
      });
    }
  }

  const planPath =
    policy.discovery.taskPlan === null
      ? null
      : resolve(root, policy.discovery.taskPlan);
  if (planPath !== null && existsSync(planPath)) {
    for (const path of taskPaths(readFileSync(planPath, "utf8"))) {
      if (
        isExcluded(path, policy.discovery) ||
        isTestPath(path) ||
        path.startsWith("docs/")
      ) {
        continue;
      }
      if (!inventory.has(path)) {
        findings.push({
          ruleId: "inventory_task_path_uncovered",
          path,
          line: 1,
          match: path,
        });
      }
    }
  }

  const normalizedInventory = [...inventory].sort();
  const sources = normalizedInventory
    .filter(path => existsSync(resolve(root, path)))
    .map(path => ({ path, text: readFileSync(resolve(root, path), "utf8") }));
  const roles: Record<string, BrowserSchemaRole> = {};
  const followedClosure =
    browserFollowRoots.size === 0
      ? new Set<string>()
      : new Set(
          resolveLocalImportClosureChecked(
            [...browserFollowRoots],
            root,
            bridgeSet,
            closureBoundaryEdges,
          ).paths,
        );

  for (const source of sources) {
    const bearing = isZodSchemaBearing(source);
    if (!bearing) {
      roles[source.path] = "non_schema";
      continue;
    }
    if (
      policy.schemaRoles.reviewedNonBrowserSchemaExactFiles.includes(
        source.path,
      )
    ) {
      roles[source.path] = "reviewed_non_browser_schema";
    } else if (
      hasPrefix(source.path, policy.schemaRoles.browserOwnedRoots) ||
      policy.schemaRoles.browserSchemaExactFiles.includes(source.path) ||
      followedClosure.has(source.path)
    ) {
      roles[source.path] = "browser_schema";
    } else {
      findings.push(
        finding("inventory_schema_role_unclassified", source, 0, source.path),
      );
    }
  }
  for (const reviewed of policy.schemaRoles
    .reviewedNonBrowserSchemaExactFiles) {
    const source = sources.find(candidate => candidate.path === reviewed);
    if (!source || !isZodSchemaBearing(source)) {
      findings.push({
        ruleId: "inventory_schema_role_unclassified",
        path: reviewed,
        line: 1,
        match: "stale reviewed schema boundary",
      });
    }
  }

  return {
    inventory: normalizedInventory,
    roles,
    findings: findings.sort(compareFindings),
    sources,
  };
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

function declarationName(node: ts.Node): string | undefined {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return undefined;
}

function isZodValidatorCall(
  node: ts.CallExpression,
  method: "url" | "uuid",
): boolean {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== method
  ) {
    return false;
  }
  const receiver = node.expression.expression;
  if (ts.isIdentifier(receiver) && receiver.text === "z") return true;
  return (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === "string" &&
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === "z"
  );
}

function databaseObjectContext(node: ts.Node, path: string): boolean {
  if (path.includes("/db/") || /(?:database|persistence)/i.test(path))
    return true;
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      /^(?:select|insert|values|returning)$/.test(current.expression.name.text)
    ) {
      return true;
    }
    if (
      (ts.isInterfaceDeclaration(current) ||
        ts.isTypeAliasDeclaration(current)) &&
      /(?:Row|Record|Select|Insert|Database|Persistence)/.test(
        current.name.text,
      )
    ) {
      return true;
    }
  }
  return false;
}

function lexicalMatches(
  source: BrowserContractSource,
  ruleId: string,
  regex: RegExp,
): BrowserContractFinding[] {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...source.text.matchAll(new RegExp(regex.source, flags))].map(match =>
    finding(ruleId, source, match.index ?? 0, match[0]),
  );
}

function typescriptNodeTestFindings(
  source: BrowserContractSource,
): BrowserContractFinding[] {
  // Keep matching inside one shell command. In particular, `\s` is not used
  // here because package.json scripts are line-separated and a cross-line
  // match can incorrectly join an allowed `.mjs` test to a later TypeScript
  // build command.
  return lexicalMatches(
    source,
    "typescript_node_test",
    /\bnode[ \t]+--test\b[^\r\n;&|]*?\.tsx?\b/g,
  );
}

function scanTypeScript(
  source: BrowserContractSource,
  role: BrowserSchemaRole,
): BrowserContractFinding[] {
  const out: BrowserContractFinding[] = [];
  const file = ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(source.path),
  );
  const pathNamespaces = new Set<string>();
  const pathCompositionFunctions = new Set<string>();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      (statement.moduleSpecifier.text === "node:path" ||
        statement.moduleSpecifier.text === "path")
    ) {
      const clause = statement.importClause;
      if (clause?.name) pathNamespaces.add(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          pathNamespaces.add(clause.namedBindings.name.text);
        } else {
          for (const element of clause.namedBindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (imported === "join" || imported === "resolve") {
              pathCompositionFunctions.add(element.name.text);
            }
          }
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteral(statement.moduleReference.expression) &&
      (statement.moduleReference.expression.text === "node:path" ||
        statement.moduleReference.expression.text === "path")
    ) {
      pathNamespaces.add(statement.name.text);
    }
  }

  const isPathCompositionCall = (node: ts.CallExpression): boolean =>
    (ts.isPropertyAccessExpression(node.expression) &&
      pathNamespaces.has(node.expression.expression.getText(file)) &&
      (node.expression.name.text === "join" ||
        node.expression.name.text === "resolve")) ||
    (ts.isIdentifier(node.expression) &&
      pathCompositionFunctions.has(node.expression.text));

  const rootCompositionFlags = (node: ts.CallExpression) => {
    let root = false;
    let legacyLayer = false;
    const inspect = (child: ts.Node) => {
      if (ts.isIdentifier(child)) {
        root ||= /^(?:canonicalRoot|stateRoot|localBrowserStateRoot)$/.test(
          child.text,
        );
        legacyLayer ||=
          /namespace/i.test(child.text) || /profileRoot/i.test(child.text);
      }
      if (
        (ts.isStringLiteralLike(child) ||
          ts.isNoSubstitutionTemplateLiteral(child)) &&
        child.text.split(/[\\/]/).includes("checkpoints")
      ) {
        legacyLayer = true;
      }
      ts.forEachChild(child, inspect);
    };
    for (const argument of node.arguments) inspect(argument);
    return { root, legacyLayer };
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "strict"
      ) {
        out.push(
          finding(
            "legacy_zod_strict",
            source,
            node.expression.name.getStart(file),
            node.getText(file),
          ),
        );
      }
      if (role === "browser_schema" && isZodValidatorCall(node, "url")) {
        out.push(
          finding(
            "bare_url_validator",
            source,
            node.getStart(file),
            node.getText(file),
          ),
        );
      }
      if (role === "browser_schema" && isZodValidatorCall(node, "uuid")) {
        const allowed =
          declarationName(node) === "canonicalUuidSchema" &&
          (source.path === "apps/browser-service/src/contracts.ts" ||
            source.path ===
              "apps/api/src/lib/scrape-interact/browser-service-contracts.ts");
        if (!allowed) {
          out.push(
            finding(
              "bare_uuid_validator",
              source,
              node.getStart(file),
              node.getText(file),
            ),
          );
        }
      }
      if (isPathCompositionCall(node)) {
        const flags = rootCompositionFlags(node);
        if (flags.root && flags.legacyLayer) {
          out.push(
            finding(
              "legacy_root_config",
              source,
              node.getStart(file),
              node.getText(file),
            ),
          );
        }
      }
    }
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.split(/[\\/]/).includes("checkpoints")
    ) {
      out.push(
        finding(
          "legacy_checkpoint_layer",
          source,
          node.getStart(file),
          node.getText(file),
        ),
      );
    }
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isPropertySignature(node)) &&
      /^storageState(?:[A-Z][A-Za-z0-9]*)?$/.test(
        propertyName(node.name) ?? "",
      ) &&
      databaseObjectContext(node, source.path)
    ) {
      out.push(
        finding(
          "database_storage_payload",
          source,
          node.getStart(file),
          node.getText(file),
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

function compareFindings(
  left: BrowserContractFinding,
  right: BrowserContractFinding,
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.ruleId.localeCompare(right.ruleId) ||
    left.match.localeCompare(right.match)
  );
}

function scanSourcesWithDerivedRoles(
  sources: readonly BrowserContractSource[],
  roles: Readonly<Record<string, BrowserSchemaRole>>,
): BrowserContractFinding[] {
  const findings: BrowserContractFinding[] = [];
  for (const source of sources) {
    if (SOURCE_EXTENSIONS.some(extension => source.path.endsWith(extension))) {
      findings.push(
        ...scanTypeScript(source, roles[source.path] ?? "non_schema"),
      );
    }
    if (source.path.endsWith(".sql")) {
      findings.push(
        ...lexicalMatches(
          source,
          "database_storage_payload",
          /\bstorage_state(?:_[a-z0-9]+)*\b/gi,
        ),
      );
    }
    findings.push(
      ...typescriptNodeTestFindings(source),
      ...lexicalMatches(
        source,
        "legacy_acceptance",
        /observer\.onAccepted\s*\(|onAccepted\s*\(\s*processId\s*\)|processId\s*:\s*string/g,
      ),
      ...lexicalMatches(
        source,
        "wrong_reconciliation_category",
        /\breconciliation_execution_failed\b/g,
      ),
    );
  }
  return findings.sort(compareFindings);
}

/**
 * Apply rules to an isolated source set. Every schema-bearing isolated source
 * is conservatively browser-owned, so neither caller metadata nor a spoofed
 * reviewed path can suppress URL/UUID findings. Checked workspace scans use
 * roles derived by buildBrowserContractInventory.
 */
export function scanSources(
  sources: readonly BrowserContractSource[],
): BrowserContractFinding[] {
  const roles: Record<string, BrowserSchemaRole> = {};
  for (const source of sources) {
    roles[source.path] = isZodSchemaBearing(source)
      ? "browser_schema"
      : "non_schema";
  }
  return scanSourcesWithDerivedRoles(sources, roles);
}

export type BrowserStaleContractScanResult = BrowserContractInventoryResult & {
  ruleFindings: BrowserContractFinding[];
  ok: boolean;
};

export function runBrowserStaleContractScan(
  workspaceRoot: string,
  policy: BrowserScannerPolicy = defaultPolicy,
): BrowserStaleContractScanResult {
  const inventoryResult = buildBrowserContractInventory(workspaceRoot, policy);
  const ruleFindings =
    inventoryResult.findings.length === 0
      ? scanSourcesWithDerivedRoles(
          inventoryResult.sources,
          inventoryResult.roles,
        )
      : [];
  return {
    ...inventoryResult,
    ruleFindings,
    ok: inventoryResult.findings.length === 0 && ruleFindings.length === 0,
  };
}

function main(): void {
  const workspaceArgument = process.argv.find(argument =>
    argument.startsWith("--workspace-root="),
  );
  const workspaceRoot = workspaceArgument
    ? workspaceArgument.slice("--workspace-root=".length)
    : resolve(__dirname, "../../../..");
  const result = runBrowserStaleContractScan(workspaceRoot);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.ok,
        inventory: result.inventory,
        roles: result.roles,
        findings: [...result.findings, ...result.ruleFindings],
      },
      null,
      2,
    )}\n`,
  );
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main();
}
