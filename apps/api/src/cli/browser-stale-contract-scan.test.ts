import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import {
  browserBridgeImportClassifications,
  browserClosureBoundaryImports,
  browserContractDiscovery,
  browserSchemaRolePolicy,
  buildBrowserContractInventory,
  type BrowserContractSource,
  type BrowserScannerPolicy,
  resolveLocalImportClosure,
  runBrowserStaleContractScan,
  scanSources,
} from "./browser-stale-contract-scan";

const fixturePolicy = (
  bridgeClassifications: BrowserScannerPolicy["bridgeClassifications"] = {},
): BrowserScannerPolicy => ({
  discovery: {
    recursiveTypeScriptRoots: ["src/browser"],
    recursiveDatabaseGlobs: [],
    closureEntryPoints: [],
    scanOnlyBridgeFiles: Object.keys(bridgeClassifications),
    explicitProductionRoots: [],
    requiredProductionPaths: [],
    taskPlan: "plan.md",
    reviewedExclusions: [],
  },
  schemaRoles: {
    browserOwnedRoots: ["src/browser/"],
    browserSchemaExactFiles: [],
    reviewedNonBrowserSchemaExactFiles: [],
  },
  bridgeClassifications,
  closureBoundaryImports: {},
});

function withWorkspace(
  callback: (root: string, write: (path: string, text: string) => void) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "browser-contract-workspace-"));
  const write = (path: string, text: string) => {
    const absolute = join(root, path);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")), {
      recursive: true,
    });
    writeFileSync(absolute, text);
  };
  try {
    write("plan.md", "");
    callback(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ruleIds(sources: readonly BrowserContractSource[]) {
  return scanSources(sources).map(finding => finding.ruleId);
}

describe("stale contract rules", () => {
  test.each([
    [
      "legacy_root_config",
      "x.ts",
      'import * as path from "node:path"; const stateRoot = ""; path.join(stateRoot, namespace);',
    ],
    [
      "legacy_checkpoint_layer",
      "x.ts",
      "const a = `profiles\\\\checkpoints\\\\value`;",
    ],
    ["legacy_zod_strict", "x.ts", "const schema = z.object({}).strict\n();"],
    [
      "typescript_node_test",
      "package.json",
      '{"scripts":{"test":"node --test src/example.ts"}}',
    ],
    [
      "database_storage_payload",
      "migration.sql",
      "ALTER TABLE x ADD storage_state_arbitrary_suffix JSONB;",
    ],
    [
      "database_storage_payload",
      "migration.sql",
      "ALTER TABLE x ADD storage_state JSONB, ADD storage_state_payload JSONB, ADD storage_state_json JSONB;",
    ],
    [
      "database_storage_payload",
      "apps/api/src/db/persistence.ts",
      "const row = db.insert(table).values({ storageStatePayload: value });",
    ],
    [
      "database_storage_payload",
      "apps/api/src/db/persistence.ts",
      "const row = db.insert(table).values({ storageState: value, storageStateJSON: value, storageStateArbitrarySuffix: value });",
    ],
    [
      "legacy_acceptance",
      "x.ts",
      "observer.onAccepted(processId); const x: { processId: string };",
    ],
    [
      "wrong_reconciliation_category",
      "x.ts",
      'throw new Error("reconciliation_execution_failed");',
    ],
  ])("finds %s", (ruleId, path, text) => {
    expect(ruleIds([{ path, text }])).toContain(ruleId);
  });

  test("schema-only URL and UUID rules use derived role input", () => {
    const source = {
      path: "apps/browser-service/src/discovered/schema-contract.ts",
      text: 'import { z } from "zod"; export const s = z.strictObject({ url: z.url(), id: z.string().uuid() });',
    };
    expect(ruleIds([source])).toEqual(
      expect.arrayContaining(["bare_url_validator", "bare_uuid_validator"]),
    );
    expect(
      ruleIds([
        {
          path: "outside/control.ts",
          text: "export const control = { url() {}, uuid() {} };",
        },
      ]),
    ).not.toEqual(
      expect.arrayContaining(["bare_url_validator", "bare_uuid_validator"]),
    );
    const attemptedOverride = (
      scanSources as unknown as (
        input: BrowserContractSource[],
        roles: Record<string, string>,
      ) => ReturnType<typeof scanSources>
    )([source], { [source.path]: "non_schema" });
    expect(attemptedOverride.map(finding => finding.ruleId)).toEqual(
      expect.arrayContaining(["bare_url_validator", "bare_uuid_validator"]),
    );
    expect(
      scanSources([{ ...source, path: "apps/api/src/config.ts" }]).map(
        finding => finding.ruleId,
      ),
    ).toEqual(
      expect.arrayContaining(["bare_url_validator", "bare_uuid_validator"]),
    );
  });

  test.each([
    'import path from "node:path"; path.join(canonicalRoot, browserNamespace);',
    'import * as nodePath from "node:path"; nodePath.resolve(stateRoot, profileRoot);',
    'import { join } from "node:path"; join(localBrowserStateRoot, namespace);',
    'import { resolve as combine } from "node:path"; combine(canonicalRoot, profileRootName);',
    'import nodePath = require("node:path"); nodePath.join(stateRoot, browserNamespace);',
  ])("resolves node:path composition bindings: %s", text => {
    expect(ruleIds([{ path: "x.ts", text }])).toContain("legacy_root_config");
  });

  test("does not treat an unrelated join method as node:path", () => {
    expect(
      ruleIds([
        {
          path: "x.ts",
          text: "customPath.join(canonicalRoot, browserNamespace);",
        },
      ]),
    ).not.toContain("legacy_root_config");
  });

  test.each([
    "node --test src/example.ts",
    "node --test src/example.tsx",
    'node --test --test-reporter spec "src/example.ts"',
    "node --test first.test.mjs second.test.ts",
  ])("rejects TypeScript passed to node --test: %s", command => {
    expect(ruleIds([{ path: "script", text: command }])).toContain(
      "typescript_node_test",
    );
  });

  test.each([
    "node --test scripts/package-migrations.test.mjs",
    "node --test scripts/bootstrap.test.mjs && tsx src/other.ts",
    "node --test scripts/bootstrap.test.mjs\nnode src/other.ts",
  ])("allows dependency-free JavaScript node tests: %s", command => {
    expect(ruleIds([{ path: "script", text: command }])).not.toContain(
      "typescript_node_test",
    );
  });

  test("does not cross package script boundaries after an allowed mjs test", () => {
    const source = {
      path: "package.json",
      text: JSON.stringify(
        {
          scripts: {
            test: "node --test scripts/package-migrations.test.mjs",
            scan: "tsx src/cli/browser-stale-contract-scan.ts",
          },
        },
        null,
        2,
      ),
    };
    expect(ruleIds([source])).not.toContain("typescript_node_test");
  });

  test("only canonical UUID declarations in both exact files are allowed", () => {
    const sources = [
      {
        path: "apps/browser-service/src/contracts.ts",
        text: 'import { z } from "zod"; export const canonicalUuidSchema = z.uuid();',
      },
      {
        path: "apps/api/src/lib/scrape-interact/browser-service-contracts.ts",
        text: 'import { z } from "zod"; export const canonicalUuidSchema = z.string().uuid();',
      },
    ];
    expect(ruleIds(sources)).not.toContain("bare_uuid_validator");
    const renamed = [
      {
        ...sources[0],
        text: sources[0].text.replace("canonicalUuidSchema", "otherUuidSchema"),
      },
    ];
    expect(ruleIds(renamed)).toContain("bare_uuid_validator");
  });
});

describe("checked module closure", () => {
  test("closes every supported local module form exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "browser-contract-closure-"));
    try {
      const write = (path: string, text: string) => {
        const absolute = join(root, path);
        mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")), {
          recursive: true,
        });
        writeFileSync(absolute, text);
      };
      write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@local/*": ["src/alias/*"] },
          },
        }),
      );
      write(
        "src/entry.ts",
        [
          'import "./plain";',
          'export * from "./exported.js";',
          'void import("./dynamic");',
          'require("./common.cjs");',
          'import equal = require("./equal");',
          'import "@local/value";',
          'import "./directory";',
          'require("external-package");',
        ].join("\n"),
      );
      write("src/plain.ts", 'import "./two-hop";');
      write("src/two-hop.ts", "export const two = 2;");
      write("src/exported.ts", "export const value = 1;");
      write("src/dynamic.ts", "export const value = 1;");
      write("src/common.cts", 'require("./common-two.cjs");');
      write("src/common-two.cts", "export const value = 1;");
      write("src/equal.ts", "export = 1;");
      write("src/alias/value.ts", "export const value = 1;");
      write("src/directory/index.ts", "export const value = 1;");

      const result = resolveLocalImportClosure(["src/entry.ts"], root);
      expect(result.findings).toEqual([]);
      expect(result.paths).toEqual([...new Set(result.paths)].sort());
      expect(result.paths).toEqual(
        expect.arrayContaining([
          "src/two-hop.ts",
          "src/exported.ts",
          "src/dynamic.ts",
          "src/common.cts",
          "src/common-two.cts",
          "src/equal.ts",
          "src/alias/value.ts",
          "src/directory/index.ts",
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["nonliteral dynamic import", "const target = './x'; import(target);"],
    ["nonliteral require", "const target = './x'; require(target);"],
    ["unresolved local require", "require('./missing');"],
  ])("fails %s closed", (_name, text) => {
    const root = mkdtempSync(join(tmpdir(), "browser-contract-unresolved-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/entry.ts"), text);
      expect(
        resolveLocalImportClosure(["src/entry.ts"], root).findings.map(
          finding => finding.ruleId,
        ),
      ).toContain("inventory_module_reference_unresolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checked inventory mutation fixtures", () => {
  test.each([
    [
      "legacy_root_config",
      'import { resolve as combine } from "node:path"; const stateRoot = ""; combine(stateRoot, namespace);',
    ],
    ["legacy_checkpoint_layer", "const value = 'root/checkpoints/value';"],
    ["legacy_zod_strict", "const value = schema.strict ();"],
    [
      "typescript_node_test",
      'const command = "node --test source/contract.ts";',
    ],
    ["legacy_acceptance", "const options: { processId: string } = value;"],
    [
      "database_storage_payload",
      "database.insert(table).values({ storageStateArbitrarySuffix: value });",
    ],
    [
      "wrong_reconciliation_category",
      "const category = 'reconciliation_execution_failed';",
    ],
  ])("discovers and import-closes %s mutations", (ruleId, forbidden) => {
    for (const mode of ["discovered", "imported"] as const) {
      withWorkspace((root, write) => {
        write(
          "src/browser/activation.ts",
          "export function activateAdapterProcess() {}",
        );
        const target =
          mode === "discovered"
            ? "src/browser/discovered/negative.ts"
            : "src/outside/negative.ts";
        write(target, forbidden);
        if (mode === "imported") {
          write("src/browser/entry.ts", 'import "../outside/negative";');
        }
        const result = runBrowserStaleContractScan(root, fixturePolicy());
        expect(result.findings).toEqual([]);
        expect(result.inventory).toContain(target);
        expect(
          result.ruleFindings.some(
            finding => finding.ruleId === ruleId && finding.path === target,
          ),
        ).toBe(true);
      });
    }
  });

  test("browser-follow schemas inherit browser role while controls do not", () => {
    withWorkspace((root, write) => {
      write(
        "src/browser/activation.ts",
        "export function activateAdapterProcess() {}",
      );
      write(
        "src/bridge.ts",
        'export * from "./outside/schema"; export * from "./outside/control";',
      );
      write(
        "src/outside/schema.ts",
        'import { z } from "zod"; export const schema = z.strictObject({ url: z.url(), id: z.uuid() });',
      );
      write(
        "src/outside/control.ts",
        "export const control = { url() {}, uuid() {} };",
      );
      const classifications = {
        "src/bridge.ts": {
          "src/outside/schema.ts": "browser_follow" as const,
          "src/outside/control.ts": "browser_follow" as const,
        },
      };
      const result = runBrowserStaleContractScan(
        root,
        fixturePolicy(classifications),
      );
      expect(result.findings).toEqual([]);
      expect(result.roles["src/outside/schema.ts"]).toBe("browser_schema");
      expect(result.roles["src/outside/control.ts"]).toBe("non_schema");
      expect(
        result.ruleFindings
          .filter(finding => finding.path === "src/outside/schema.ts")
          .map(finding => finding.ruleId),
      ).toEqual(
        expect.arrayContaining(["bare_url_validator", "bare_uuid_validator"]),
      );
      expect(
        result.ruleFindings.filter(
          finding => finding.path === "src/outside/control.ts",
        ),
      ).toEqual([]);

      const broken = runBrowserStaleContractScan(
        root,
        fixturePolicy({
          "src/bridge.ts": {
            "src/outside/control.ts": "browser_follow",
          },
        }),
      );
      expect(broken.findings.map(finding => finding.ruleId)).toContain(
        "inventory_bridge_import_unclassified",
      );
      expect(broken.ruleFindings).toEqual([]);
    });
  });

  test("scan-only bridges are scanned without following reviewed boundaries", () => {
    withWorkspace((root, write) => {
      write(
        "src/browser/activation.ts",
        "export function activateAdapterProcess() {}",
      );
      write(
        "src/bridge.ts",
        'import "./generic"; const stale = schema.strict();',
      );
      write("src/generic.ts", 'const hidden = "root/checkpoints/value";');
      const result = runBrowserStaleContractScan(
        root,
        fixturePolicy({
          "src/bridge.ts": {
            "src/generic.ts": "reviewed_non_browser_boundary",
          },
        }),
      );

      expect(result.findings).toEqual([]);
      expect(result.inventory).toContain("src/bridge.ts");
      expect(result.inventory).not.toContain("src/generic.ts");
      expect(result.ruleFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "src/bridge.ts",
            ruleId: "legacy_zod_strict",
          }),
        ]),
      );
      expect(
        result.ruleFindings.some(finding => finding.path === "src/generic.ts"),
      ).toBe(false);
    });
  });

  test("an unowned schema fails role derivation before rule scanning", () => {
    withWorkspace((root, write) => {
      write("src/browser/entry.ts", 'import "../outside/unowned-schema";');
      write(
        "src/outside/unowned-schema.ts",
        'import { z } from "zod"; export const schema = z.strictObject({ value: z.string() });',
      );
      const result = runBrowserStaleContractScan(root, fixturePolicy());
      expect(result.findings.map(finding => finding.ruleId)).toContain(
        "inventory_schema_role_unclassified",
      );
      expect(result.ruleFindings).toEqual([]);
    });
  });

  test("missing paths, escaped plan paths, stale exclusions, and excluded imports fail separately", () => {
    withWorkspace((root, write) => {
      write("plan.md", "- Modify: `src/uncovered.ts`\n");
      write("src/browser/entry.ts", 'import "./hidden.test";');
      write("src/browser/hidden.test.ts", "export const hidden = true;");
      const base = fixturePolicy();
      const policy: BrowserScannerPolicy = {
        ...base,
        discovery: {
          ...base.discovery,
          requiredProductionPaths: ["src/browser/missing.ts"],
          reviewedExclusions: [
            {
              id: "test",
              suffix: /\.test\.ts$/,
              requireMatch: true,
            },
            {
              id: "stale",
              exact: "src/browser/renamed.ts",
              requireMatch: true,
            },
          ],
        },
      };
      const result = runBrowserStaleContractScan(root, policy);
      expect(result.findings.map(finding => finding.ruleId)).toEqual(
        expect.arrayContaining([
          "inventory_required_path_missing",
          "inventory_task_path_uncovered",
          "inventory_stale_exclusion",
          "inventory_import_unclosed",
        ]),
      );
      expect(result.ruleFindings).toEqual([]);
    });
  });
});

describe("production scanner", () => {
  test("derives checked real-tree inventory before reporting rules", () => {
    const root = join(__dirname, "../../../..");
    const result = buildBrowserContractInventory(root);
    expect(result.findings).toEqual([]);
    expect(result.inventory).toEqual([...result.inventory].sort());
    expect(result.inventory).toEqual(
      expect.arrayContaining([
        "apps/api/src/lib/browser-state/filesystem-store-internal.ts",
        "apps/api/src/lib/browser-state/transitions.ts",
        "apps/api/src/lib/browser-state/process-identity.ts",
        "apps/api/src/lib/browser-state/legacy-compatibility.ts",
        "apps/api/src/lib/scrape-interact/replay-envelope.ts",
        "apps/api/src/controllers/v2/types.ts",
        "apps/api/src/harness-browser-command.ts",
        "apps/api/src/services/browser-admission-cleanup.ts",
        "apps/api/src/services/browser-billing-outbox.ts",
      ]),
    );
    expect(result.inventory).not.toContain(
      "apps/api/src/__tests__/snips/v2/browser-local.test.ts",
    );
    expect(result.inventory).not.toContain(
      "apps/api/src/controllers/v1/types.ts",
    );
    expect(result.inventory).not.toContain(
      "apps/api/src/services/monitoring/types.ts",
    );
    expect(result.inventory).not.toContain(
      "apps/api/src/services/webhook/schema.ts",
    );
    expect(result.roles["apps/browser-service/src/contracts.ts"]).toBe(
      "browser_schema",
    );
    expect(result.roles["apps/api/src/config.ts"]).toBe(
      "reviewed_non_browser_schema",
    );
  });

  test("real pipeline exposes inventory and roles with zero findings", () => {
    const result = runBrowserStaleContractScan(join(__dirname, "../../../.."));
    expect(result.inventory.length).toBeGreaterThan(50);
    expect(Object.keys(result.roles).length).toBe(result.sources.length);
    expect(result.findings).toEqual([]);
    expect(result.ruleFindings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("bridge classification fails before rule scanning", () => {
    const root = join(__dirname, "../../../..");
    const base = buildBrowserContractInventory(root);
    expect(base.findings).toEqual([]);
    const policy: BrowserScannerPolicy = {
      discovery: browserContractDiscovery,
      schemaRoles: browserSchemaRolePolicy,
      bridgeClassifications: {
        ...browserBridgeImportClassifications,
        "apps/api/src/config.ts": {},
      },
      closureBoundaryImports: browserClosureBoundaryImports,
    };
    const result = runBrowserStaleContractScan(root, policy);
    expect(result.findings.map(finding => finding.ruleId)).toContain(
      "inventory_bridge_import_unclassified",
    );
    expect(result.ruleFindings).toEqual([]);
  });
});
