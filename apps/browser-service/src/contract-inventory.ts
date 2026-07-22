import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  AUTH_CUSTOM_CONSTANTS,
  AUTH_SEMANTIC_RULE_REGISTRY,
  PRIVATE_AUTH_HEADERS,
  PRIVATE_FENCING_HEADERS,
} from "./auth.js";
import {
  ARTIFACT_METADATA_HEADERS,
  canonicalJson,
  MAX_ACTION_OPERATION_BYTES,
  MAX_ACTION_RESULT_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_EVALUATE_RESULT_BYTES,
  MAX_PRIVATE_REQUEST_BYTES,
  MAX_PRIVATE_RESPONSE_BYTES,
  MAX_RECONCILIATION_REFERENCES,
  MAX_REPLAY_REQUEST_BYTES,
  MAX_RUN_ARTIFACT_BYTES,
  MAX_RUN_ARTIFACTS,
  MAX_STORAGE_STATE_BYTES,
  PRIVATE_V1_CUSTOM_CONSTANTS,
  PRIVATE_V1_SCHEMA_REGISTRY,
  PRIVATE_V1_SCHEMAS,
  PRIVATE_V1_SEMANTIC_RULE_REGISTRY,
  SUPPORTED_LOCATION_COUNTRIES,
} from "./contracts.js";
import {
  BROWSER_SERVICE_ERROR_STATUS,
  ERROR_CUSTOM_CONSTANTS,
  ERROR_SEMANTIC_RULE_REGISTRY,
} from "./errors.js";

type PrivateSchemaName = keyof typeof PRIVATE_V1_SCHEMAS;

type RouteResponse = {
  status: number;
  definition: PrivateSchemaName | null;
};

export type PrivateRouteContract = {
  method: "GET" | "POST" | "DELETE" | "WS";
  path: string;
  request: PrivateSchemaName | null;
  responses: readonly RouteResponse[];
  requestBytes: number | { default: number; withReplay: number };
  responseBytes: number | null;
  fencing: "bootstrap" | "bootstrap_or_generation" | "generation";
  streaming:
    | null
    | { body: "binary"; headers: readonly string[] }
    | { permission: "passive" | "interactive" | "cdp"; transport: "websocket" };
};

export const PRIVATE_ROUTE_CONTRACTS = [
  {
    method: "POST",
    path: "/v1/control-generations",
    request: "CreateControlGenerationV1",
    responses: [{ status: 201, definition: "ControlGenerationV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "bootstrap",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions",
    request: "CreateSessionV1",
    responses: [{ status: 201, definition: "SessionV1" }],
    requestBytes: {
      default: MAX_PRIVATE_REQUEST_BYTES,
      withReplay: MAX_REPLAY_REQUEST_BYTES,
    },
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "GET",
    path: "/v1/sessions/:runtimeSessionId",
    request: null,
    responses: [{ status: 200, definition: "SessionV1" }],
    requestBytes: 0,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "DELETE",
    path: "/v1/sessions/:runtimeSessionId",
    request: "CloseSessionV1",
    responses: [{ status: 200, definition: "ClosedSessionV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions/:runtimeSessionId/actions",
    request: "BrowserActionExecutionV1",
    responses: [{ status: 200, definition: "BrowserActionExecutionResultV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions/:runtimeSessionId/grants",
    request: "CreateRelayGrantV1",
    responses: [{ status: 201, definition: "RelayGrantV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "DELETE",
    path: "/v1/sessions/:runtimeSessionId/grants/:grantId",
    request: "RevokeRelayGrantV1",
    responses: [{ status: 200, definition: "RevokedRelayGrantV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions/:runtimeSessionId/artifacts",
    request: "FetchArtifactV1",
    responses: [{ status: 200, definition: "ArtifactMetadataV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_ARTIFACT_BYTES,
    fencing: "generation",
    streaming: {
      body: "binary",
      headers: Object.values(ARTIFACT_METADATA_HEADERS).sort((left, right) =>
        left.localeCompare(right),
      ),
    },
  },
  {
    method: "POST",
    path: "/v1/profile-generations/:generationId/finalize",
    request: "FinalizeProfileGenerationV1",
    responses: [{ status: 200, definition: "FinalizedProfileGenerationV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "DELETE",
    path: "/v1/profile-generations/:generationId",
    request: "DeleteProfileGenerationV1",
    responses: [{ status: 200, definition: "DeletedProfileGenerationV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/reconciliation",
    request: "ReconciliationRequestV1",
    responses: [{ status: 200, definition: "ReconciliationResultV1" }],
    requestBytes: MAX_REPLAY_REQUEST_BYTES,
    responseBytes: 4 * 1024,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "WS",
    path: "/v1/sessions/:runtimeSessionId/streams/passive",
    request: null,
    responses: [{ status: 101, definition: null }],
    requestBytes: 0,
    responseBytes: null,
    fencing: "generation",
    streaming: { permission: "passive", transport: "websocket" },
  },
  {
    method: "WS",
    path: "/v1/sessions/:runtimeSessionId/streams/interactive",
    request: null,
    responses: [{ status: 101, definition: null }],
    requestBytes: 0,
    responseBytes: null,
    fencing: "generation",
    streaming: { permission: "interactive", transport: "websocket" },
  },
  {
    method: "WS",
    path: "/v1/sessions/:runtimeSessionId/streams/cdp",
    request: null,
    responses: [{ status: 101, definition: null }],
    requestBytes: 0,
    responseBytes: null,
    fencing: "generation",
    streaming: { permission: "cdp", transport: "websocket" },
  },
  {
    method: "GET",
    path: "/health/live",
    request: null,
    responses: [
      { status: 200, definition: "LiveDiscoveryV1" },
      { status: 200, definition: "ScopedLiveHealthV1" },
    ],
    requestBytes: 0,
    responseBytes: 4 * 1024,
    fencing: "bootstrap_or_generation",
    streaming: null,
  },
  {
    method: "GET",
    path: "/health/ready",
    request: null,
    responses: [
      { status: 200, definition: "ReadyHealthV1" },
      { status: 503, definition: "UnreadyHealthV1" },
    ],
    requestBytes: 0,
    responseBytes: 4 * 1024,
    fencing: "generation",
    streaming: null,
  },
] as const satisfies readonly PrivateRouteContract[];

export type PrivateV1Inventory = {
  version: 1;
  routes: readonly PrivateRouteContract[];
  definitions: {
    schemas: Record<string, unknown>;
    sharedSchema: unknown;
    semanticRules: SemanticRuleRegistry;
    customConstants: Readonly<Record<string, unknown>>;
    headers: {
      auth: Readonly<Record<string, string>>;
      fencing: Readonly<Record<string, string>>;
    };
    errors: {
      envelopeSchema: "PrivateErrorV1";
      statusByCategory: Readonly<Record<string, number>>;
    };
    constants: Readonly<Record<string, unknown>>;
  };
};

export type SemanticRuleRegistry = Readonly<
  Record<
    string,
    {
      target: string;
      constantKeys: readonly string[];
      behaviorKeys: readonly string[];
    }
  >
>;

export type SemanticRuleCase = {
  coveredConstantKeys: readonly string[];
  coveredBehaviorKeys: readonly string[];
  run: () => unknown;
};

function validateExactCoverage(
  ruleKey: string,
  kind: "constant" | "behavior",
  expectedKeys: readonly string[],
  coveredKeys: readonly string[],
): void {
  const expected = new Set(expectedKeys);
  const covered = new Set(coveredKeys);
  if (expected.size !== expectedKeys.length) {
    throw new TypeError(`semantic rule ${ruleKey} has duplicate ${kind} keys`);
  }
  if (covered.size !== coveredKeys.length) {
    throw new TypeError(
      `semantic case ${ruleKey} has duplicate covered ${kind} keys`,
    );
  }
  const missing = expectedKeys.find((key) => !covered.has(key));
  if (missing !== undefined) {
    throw new TypeError(
      `semantic case ${ruleKey} does not cover ${kind} key ${missing}`,
    );
  }
  const extra = coveredKeys.find((key) => !expected.has(key));
  if (extra !== undefined) {
    throw new TypeError(
      `semantic case ${ruleKey} covers unregistered ${kind} key ${extra}`,
    );
  }
}

export function validateSemanticRuleCoverage(
  registry: SemanticRuleRegistry,
  cases: Readonly<Record<string, SemanticRuleCase>>,
  constants: Readonly<Record<string, unknown>>,
): void {
  const ruleKeys = Object.keys(registry).sort((a, b) => a.localeCompare(b));
  const caseKeys = Object.keys(cases).sort((a, b) => a.localeCompare(b));
  const orphanRule = ruleKeys.find((key) => !Object.hasOwn(cases, key));
  if (orphanRule !== undefined) {
    throw new TypeError(`semantic rule has no executable case: ${orphanRule}`);
  }
  const orphanCase = caseKeys.find((key) => !Object.hasOwn(registry, key));
  if (orphanCase !== undefined) {
    throw new TypeError(`semantic case has no registered rule: ${orphanCase}`);
  }
  const referencedConstants = new Set<string>();
  for (const [ruleKey, registration] of Object.entries(registry)) {
    const semanticCase = cases[ruleKey];
    if (semanticCase === undefined) {
      throw new TypeError(`semantic rule has no executable case: ${ruleKey}`);
    }
    if (
      typeof semanticCase.run !== "function" ||
      !Array.isArray(semanticCase.coveredConstantKeys) ||
      !Array.isArray(semanticCase.coveredBehaviorKeys)
    ) {
      throw new TypeError(`semantic case ${ruleKey} has invalid metadata`);
    }
    validateExactCoverage(
      ruleKey,
      "constant",
      registration.constantKeys,
      semanticCase.coveredConstantKeys,
    );
    validateExactCoverage(
      ruleKey,
      "behavior",
      registration.behaviorKeys,
      semanticCase.coveredBehaviorKeys,
    );
    for (const constantKey of registration.constantKeys) {
      if (!Object.hasOwn(constants, constantKey)) {
        throw new TypeError(
          `semantic rule ${ruleKey} references missing constant ${constantKey}`,
        );
      }
      referencedConstants.add(constantKey);
    }
  }
  const orphanConstant = Object.keys(constants)
    .sort((a, b) => a.localeCompare(b))
    .find((constantKey) => !referencedConstants.has(constantKey));
  if (orphanConstant !== undefined) {
    throw new TypeError(
      `custom constant has no registered semantic rule: ${orphanConstant}`,
    );
  }
}

function privateJsonSchemas(): {
  schemas: Record<string, unknown>;
  sharedSchema: unknown;
} {
  const registry = z.registry<{ id: string }>();
  for (const [name, entry] of Object.entries(PRIVATE_V1_SCHEMA_REGISTRY)) {
    registry.add(entry.schema, { id: name });
  }
  const generated = z.toJSONSchema(registry, {
    io: "input",
    reused: "ref",
    target: "draft-2020-12",
    unrepresentable: "any",
  });
  const { __shared: sharedSchema, ...generatedSchemas } = generated.schemas;
  if (sharedSchema === undefined) {
    throw new TypeError(
      "private schema registry did not emit shared definitions",
    );
  }
  const schemas = Object.fromEntries(
    Object.entries(generatedSchemas).map(([name, jsonSchema]) => [
      name,
      {
        jsonSchema,
        semanticRuleKeys:
          PRIVATE_V1_SCHEMA_REGISTRY[
            name as keyof typeof PRIVATE_V1_SCHEMA_REGISTRY
          ].semanticRuleKeys,
      },
    ]),
  );
  return { schemas, sharedSchema };
}

export function buildServicePrivateV1Inventory(): PrivateV1Inventory {
  const { schemas, sharedSchema } = privateJsonSchemas();
  const semanticRules = {
    ...PRIVATE_V1_SEMANTIC_RULE_REGISTRY,
    ...AUTH_SEMANTIC_RULE_REGISTRY,
    ...ERROR_SEMANTIC_RULE_REGISTRY,
  };
  const customConstants = {
    ...PRIVATE_V1_CUSTOM_CONSTANTS,
    ...AUTH_CUSTOM_CONSTANTS,
    ...ERROR_CUSTOM_CONSTANTS,
  };
  return {
    version: 1,
    routes: PRIVATE_ROUTE_CONTRACTS,
    definitions: {
      schemas,
      sharedSchema,
      semanticRules,
      customConstants,
      headers: {
        auth: PRIVATE_AUTH_HEADERS,
        fencing: PRIVATE_FENCING_HEADERS,
      },
      errors: {
        envelopeSchema: "PrivateErrorV1",
        statusByCategory: BROWSER_SERVICE_ERROR_STATUS,
      },
      constants: {
        artifactMetadataHeaders: ARTIFACT_METADATA_HEADERS,
        maxActionOperationBytes: MAX_ACTION_OPERATION_BYTES,
        maxActionResultBytes: MAX_ACTION_RESULT_BYTES,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        maxEvaluateResultBytes: MAX_EVALUATE_RESULT_BYTES,
        maxPrivateRequestBytes: MAX_PRIVATE_REQUEST_BYTES,
        maxPrivateResponseBytes: MAX_PRIVATE_RESPONSE_BYTES,
        maxReconciliationReferences: MAX_RECONCILIATION_REFERENCES,
        maxReplayRequestBytes: MAX_REPLAY_REQUEST_BYTES,
        maxRunArtifactBytes: MAX_RUN_ARTIFACT_BYTES,
        maxRunArtifacts: MAX_RUN_ARTIFACTS,
        maxStorageStateBytes: MAX_STORAGE_STATE_BYTES,
        supportedLocationCountries: SUPPORTED_LOCATION_COUNTRIES,
      },
    },
  };
}

export const servicePrivateV1Inventory = buildServicePrivateV1Inventory();

export function normalizePrivateV1Inventory(
  inventory: PrivateV1Inventory,
): PrivateV1Inventory {
  return JSON.parse(canonicalJson(inventory)) as PrivateV1Inventory;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintPrivateV1Inventory(
  inventory: PrivateV1Inventory,
): string {
  return sha256(canonicalJson(normalizePrivateV1Inventory(inventory)));
}

export async function readCanonicalPrivateV1Fixture(): Promise<PrivateV1Inventory> {
  const raw = await readFile(
    new URL("../contracts/private-v1.contract.json", import.meta.url),
    "utf8",
  );
  return normalizePrivateV1Inventory(JSON.parse(raw) as PrivateV1Inventory);
}
