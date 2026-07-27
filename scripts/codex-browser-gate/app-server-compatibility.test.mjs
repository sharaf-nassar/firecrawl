import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveSafeSchemaMismatchDetails,
  loadRequiredV2Contract,
  validateAppServerCompatibility,
} from "./app-server-compatibility.mjs";
import { validateGateSchemaBundle } from "./app-server-protocol.mjs";
import { gateError } from "./gate-contract.mjs";
import { renderGateFailure } from "./lifecycle.mjs";
import { validateSnapshotBundle } from "./snapshot-protocol.mjs";

const contractPath = new URL(
  "../../host/browser-runtime/protocol/compatibility/required-v2-contract.json",
  import.meta.url,
);
const contract = await loadRequiredV2Contract(contractPath);
const bytes = value => Buffer.from(JSON.stringify(value), "utf8");
let cases = 0;

function compatibleSchema() {
  const definitions = {};
  for (const [name, shape] of Object.entries(contract.requiredDefinitions)) {
    definitions[name] = {
      type: "object",
      properties: Object.fromEntries(
        shape.properties.map(field => [field, { type: "string" }]),
      ),
      required: [...shape.required],
    };
  }
  return { $schema: "http://json-schema.org/draft-07/schema#", definitions };
}

function bundle(schema = compatibleSchema(), release = "compatible-a") {
  return {
    files: [
      ["codex_app_server_protocol.v2.schemas.json", bytes(schema)],
      ...Object.keys(contract.requiredDefinitions).map(name => [
        `v2/${name}.json`,
        bytes(
          schema.definitions[name] ?? {
            type: "object",
            properties: {},
            required: [],
          },
        ),
      ]),
    ],
    metadata: { release },
  };
}

function failureOf(operation) {
  try {
    operation();
  } catch (error) {
    return { category: error?.code, detail: error?.detail };
  }
  assert.fail("expected compatibility failure");
}

function equal(actual, expected) {
  cases += 1;
  assert.deepEqual(actual, expected);
}

equal(contract.contractVersion, 1);
equal(Object.isFrozen(contract), true);
equal(Object.isFrozen(contract.requiredDefinitions), true);
equal(Object.isFrozen(contract.supportedSchemaVocabulary), true);
equal(
  Object.keys(contract.requiredDefinitions),
  [
    "ItemCompletedNotification",
    "ThreadStartParams",
    "ThreadStartResponse",
    "TurnCompletedNotification",
    "TurnStartParams",
  ],
);
equal(
  deriveSafeSchemaMismatchDetails(contract),
  [
    "ItemCompletedNotification",
    "ThreadStartParams",
    "ThreadStartResponse",
    "TurnCompletedNotification",
    "TurnStartParams",
    "required_field",
    "schema_vocabulary",
  ],
);
assert.throws(() => contract.supportedSchemaVocabulary.push("pattern"));
assert.throws(() => {
  contract.requiredDefinitions.ThreadStartParams = [];
});
cases += 2;

const compatible = bundle();
validateAppServerCompatibility(compatible, contract);
validateGateSchemaBundle(compatible, contract);
validateSnapshotBundle(compatible, contract);
cases += 3;

for (const release of [
  "compatible-release-label-a",
  "compatible-release-label-b",
]) {
  const fixture = bundle(compatibleSchema(), release);
  validateGateSchemaBundle(fixture, contract);
  validateSnapshotBundle(fixture, contract);
  cases += 2;
}

const mutations = [
  {
    detail: "ThreadStartParams",
    mutate(schema) {
      delete schema.definitions.ThreadStartParams;
    },
  },
  {
    detail: "required_field",
    mutate(schema) {
      schema.definitions.TurnCompletedNotification.required =
        schema.definitions.TurnCompletedNotification.required.filter(
          field => field !== "turn",
        );
    },
  },
  {
    detail: "schema_vocabulary",
    mutate(schema) {
      schema.definitions.ThreadStartResponse.pattern = "^unsafe$";
    },
  },
];
for (const mutation of mutations) {
  const schema = compatibleSchema();
  mutation.mutate(schema);
  const mutated = bundle(schema);
  const expected = {
    category: "codex_protocol_schema_mismatch",
    detail: mutation.detail,
  };
  equal(failureOf(() => validateGateSchemaBundle(mutated, contract)), expected);
  equal(
    failureOf(() => validateSnapshotBundle(mutated, contract)),
    expected,
  );
}

const splitSchema = compatibleSchema();
const splitBundle = bundle(splitSchema);
splitBundle.files = splitBundle.files.map(([path, raw]) => [
  path,
  path === "v2/ThreadStartParams.json"
    ? bytes({ type: "object", properties: {}, required: [] })
    : raw,
]);
validateGateSchemaBundle(splitBundle, contract);
validateSnapshotBundle(splitBundle, contract);
cases += 2;

const malformedStructure = bundle();
malformedStructure.files.push([
  "experimental/evil.json",
  bytes({ type: "array", items: "allow-anything" }),
]);
equal(
  failureOf(() => validateGateSchemaBundle(malformedStructure, contract)),
  {
    category: "codex_protocol_schema_mismatch",
    detail: "schema_vocabulary",
  },
);
equal(
  failureOf(() => validateSnapshotBundle(malformedStructure, contract)),
  {
    category: "codex_protocol_schema_mismatch",
    detail: "schema_vocabulary",
  },
);

for (const schema of [
  { type: "object", properties: {}, required: "oops" },
  { type: "mystery" },
  { type: "object", properties: [] },
  { type: "string", enum: "oops" },
  { type: "string", minLength: -1 },
  { $ref: "https://schema.invalid/remote.json" },
]) {
  const malformedKeyword = bundle();
  malformedKeyword.files.push([
    "experimental/malformed-keyword.json",
    bytes(schema),
  ]);
  const expected = {
    category: "codex_protocol_schema_mismatch",
    detail: "schema_vocabulary",
  };
  equal(
    failureOf(() => validateGateSchemaBundle(malformedKeyword, contract)),
    expected,
  );
  equal(
    failureOf(() => validateSnapshotBundle(malformedKeyword, contract)),
    expected,
  );
}

for (const detail of deriveSafeSchemaMismatchDetails(contract)) {
  equal(
    renderGateFailure(gateError("codex_protocol_schema_mismatch", detail)),
    `codex_protocol_schema_mismatch: ${detail}\n`,
  );
}
equal(
  renderGateFailure(
    gateError(
      "codex_protocol_schema_mismatch",
      "/tmp/private/fake-definition schema-token",
    ),
  ),
  "codex_protocol_schema_mismatch\n",
);

const root = await mkdtemp(join(tmpdir(), "codex-compatibility-test-"));
try {
  const source = JSON.parse(await readFile(contractPath, "utf8"));
  const invalidContracts = [
    { ...source, unexpected: true },
    { ...source, contractVersion: 2 },
    { ...source, requiredDefinitions: {} },
    {
      ...source,
      supportedSchemaVocabulary: [
        ...source.supportedSchemaVocabulary,
        source.supportedSchemaVocabulary[0],
      ],
    },
    {
      ...source,
      normalizationFixtures: [
        { inputPath: "../escape.json", normalizedPath: "../escape.json" },
      ],
    },
  ];
  for (const [index, invalid] of invalidContracts.entries()) {
    const path = join(root, `invalid-${index}.json`);
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(
      loadRequiredV2Contract(path),
      /codex_protocol_schema_mismatch/,
    );
    cases += 1;
  }
  const duplicate = join(root, "duplicate.json");
  await writeFile(
    duplicate,
    '{"contractVersion":1,"contractVersion":1,"normalizationFixtures":[],"requiredDefinitions":{},"supportedSchemaVocabulary":[]}',
  );
  await assert.rejects(
    loadRequiredV2Contract(duplicate),
    /codex_protocol_schema_mismatch/,
  );
  cases += 1;
} finally {
  await rm(root, { force: true, recursive: true });
}

process.stdout.write(
  `codex_browser_app_server_compatibility: PASS cases=${cases}\n`,
);
