import { readFile } from "node:fs/promises";

import { gateError } from "./gate-contract.mjs";
import { parseLosslessJson } from "./schema-canonicalizer.mjs";

const CONTRACT_KEYS = Object.freeze([
  "contractVersion",
  "normalizationFixtures",
  "requiredDefinitions",
  "supportedSchemaVocabulary",
]);
const NORMALIZATION_FIXTURE_KEYS = Object.freeze([
  "inputPath",
  "normalizedPath",
]);
const REQUIRED_DEFINITION_KEYS = Object.freeze(["properties", "required"]);
const VALIDATOR_DETAILS = Object.freeze([
  "required_field",
  "schema_vocabulary",
]);

function mismatch(detail) {
  throw gateError("codex_protocol_schema_mismatch", detail);
}

function objectMembers(node) {
  if (node?.kind !== "object") mismatch();
  return new Map(node.members.map(member => [member.key, member.value]));
}

function assertExactKeys(members, expected) {
  if (
    members.size !== expected.length ||
    expected.some(key => !members.has(key))
  ) {
    mismatch();
  }
}

function stringValue(node) {
  if (node?.kind !== "string" || node.value === "") mismatch();
  return node.value;
}

function stringArray(node, { allowEmpty = false } = {}) {
  if (
    node?.kind !== "array" ||
    (!allowEmpty && node.items.length === 0)
  ) {
    mismatch();
  }
  const values = node.items.map(stringValue);
  if (new Set(values).size !== values.length) mismatch();
  const sorted = [...values].sort(compareUtf16);
  if (!values.every((value, index) => value === sorted[index])) mismatch();
  return Object.freeze(values);
}

function compareUtf16(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function deepFreezeContract(contract) {
  for (const definition of Object.values(contract.requiredDefinitions)) {
    Object.freeze(definition.properties);
    Object.freeze(definition.required);
    Object.freeze(definition);
  }
  Object.freeze(contract.requiredDefinitions);
  for (const fixture of contract.normalizationFixtures) Object.freeze(fixture);
  Object.freeze(contract.normalizationFixtures);
  Object.freeze(contract.supportedSchemaVocabulary);
  return Object.freeze(contract);
}

function parseContract(raw) {
  let root;
  try {
    root = parseLosslessJson(raw);
  } catch {
    mismatch();
  }
  const members = objectMembers(root);
  assertExactKeys(members, CONTRACT_KEYS);
  const version = members.get("contractVersion");
  if (version?.kind !== "number" || version.raw !== "1") mismatch();

  const requiredDefinitionMembers = objectMembers(
    members.get("requiredDefinitions"),
  );
  if (requiredDefinitionMembers.size === 0) mismatch();
  const requiredDefinitionNames = [...requiredDefinitionMembers.keys()];
  if (
    !requiredDefinitionNames.every(
      (name, index) =>
        name === [...requiredDefinitionNames].sort(compareUtf16)[index],
    )
  ) {
    mismatch();
  }
  const requiredDefinitions = Object.create(null);
  for (const [name, definitionNode] of requiredDefinitionMembers) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) mismatch();
    const definition = objectMembers(definitionNode);
    assertExactKeys(definition, REQUIRED_DEFINITION_KEYS);
    const properties = stringArray(definition.get("properties"));
    const required = stringArray(definition.get("required"), {
      allowEmpty: true,
    });
    if (required.some(field => !properties.includes(field))) mismatch();
    requiredDefinitions[name] = { properties, required };
  }

  const fixturesNode = members.get("normalizationFixtures");
  if (fixturesNode?.kind !== "array" || fixturesNode.items.length === 0) {
    mismatch();
  }
  const normalizationFixtures = fixturesNode.items.map(node => {
    const fixture = objectMembers(node);
    assertExactKeys(fixture, NORMALIZATION_FIXTURE_KEYS);
    const inputPath = stringValue(fixture.get("inputPath"));
    const normalizedPath = stringValue(fixture.get("normalizedPath"));
    if (
      normalizeSchemaPath(inputPath) !== normalizedPath ||
      normalizeSchemaPath(normalizedPath) !== normalizedPath
    ) {
      mismatch();
    }
    return { inputPath, normalizedPath };
  });

  return deepFreezeContract({
    contractVersion: 1,
    normalizationFixtures,
    requiredDefinitions,
    supportedSchemaVocabulary: [
      ...stringArray(members.get("supportedSchemaVocabulary")),
    ],
  });
}

export async function loadRequiredV2Contract(path) {
  if (typeof path !== "string" && !(path instanceof URL)) mismatch();
  let raw;
  try {
    raw = await readFile(path);
  } catch {
    mismatch();
  }
  return parseContract(raw);
}

function normalizeSchemaPath(path) {
  if (typeof path !== "string") mismatch();
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    !normalized.endsWith(".json") ||
    segments.some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    mismatch();
  }
  return normalized;
}

function astObjectMember(node, key) {
  if (node?.kind !== "object") return undefined;
  return node.members.find(member => member.key === key)?.value;
}

const SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function auditSchemaKeywordShapes(schema) {
  const member = key => astObjectMember(schema, key);
  for (const key of ["$schema", "description", "format", "title"]) {
    const value = member(key);
    if (value !== undefined && value.kind !== "string") {
      mismatch("schema_vocabulary");
    }
  }
  const reference = member("$ref");
  if (
    reference !== undefined &&
    (reference.kind !== "string" ||
      !reference.value.startsWith("#/definitions/"))
  ) {
    mismatch("schema_vocabulary");
  }
  for (const key of ["properties", "definitions"]) {
    const value = member(key);
    if (value !== undefined && value.kind !== "object") {
      mismatch("schema_vocabulary");
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "enum"]) {
    const value = member(key);
    if (
      value !== undefined &&
      (value.kind !== "array" || value.items.length === 0)
    ) {
      mismatch("schema_vocabulary");
    }
  }
  const required = member("required");
  if (required !== undefined) {
    if (
      required.kind !== "array" ||
      !required.items.every(item => item.kind === "string") ||
      new Set(required.items.map(item => item.value)).size !==
        required.items.length
    ) {
      mismatch("schema_vocabulary");
    }
  }
  const type = member("type");
  if (type !== undefined) {
    const types =
      type.kind === "string"
        ? [type.value]
        : type.kind === "array" &&
            type.items.length > 0 &&
            type.items.every(item => item.kind === "string")
          ? type.items.map(item => item.value)
          : null;
    if (
      types === null ||
      new Set(types).size !== types.length ||
      types.some(value => !SCHEMA_TYPES.has(value))
    ) {
      mismatch("schema_vocabulary");
    }
  }
  for (const key of [
    "maxItems",
    "maxLength",
    "minItems",
    "minLength",
  ]) {
    const value = member(key);
    if (
      value !== undefined &&
      (value.kind !== "number" || !/^(?:0|[1-9][0-9]*)$/.test(value.raw))
    ) {
      mismatch("schema_vocabulary");
    }
  }
  for (const key of ["maximum", "minimum"]) {
    const value = member(key);
    if (value !== undefined && value.kind !== "number") {
      mismatch("schema_vocabulary");
    }
  }
}

function auditSchemaVocabulary(schema, supported) {
  if (schema?.kind === "true" || schema?.kind === "false") return;
  if (schema?.kind !== "object") mismatch("schema_vocabulary");
  for (const member of schema.members) {
    if (!supported.has(member.key)) mismatch("schema_vocabulary");
  }
  auditSchemaKeywordShapes(schema);
  for (const groupName of ["properties", "definitions"]) {
    const group = astObjectMember(schema, groupName);
    if (group === undefined) continue;
    if (group.kind !== "object") mismatch("schema_vocabulary");
    for (const member of group.members) {
      auditSchemaVocabulary(member.value, supported);
    }
  }
  for (const name of ["items", "additionalProperties"]) {
    const child = astObjectMember(schema, name);
    if (child === undefined) continue;
    if (!["object", "true", "false"].includes(child.kind)) {
      mismatch("schema_vocabulary");
    }
    auditSchemaVocabulary(child, supported);
  }
  for (const name of ["allOf", "anyOf", "oneOf"]) {
    const group = astObjectMember(schema, name);
    if (group === undefined) continue;
    if (group.kind !== "array") mismatch("schema_vocabulary");
    for (const child of group.items) auditSchemaVocabulary(child, supported);
  }
}

function auditMaterializedSchemaVocabulary(schema, supported) {
  if (schema === true || schema === false) return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    mismatch("schema_vocabulary");
  }
  for (const key of Object.keys(schema)) {
    if (!supported.has(key)) mismatch("schema_vocabulary");
  }
  for (const key of ["$schema", "description", "format", "title"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") {
      mismatch("schema_vocabulary");
    }
  }
  if (
    schema.$ref !== undefined &&
    (typeof schema.$ref !== "string" ||
      !schema.$ref.startsWith("#/definitions/"))
  ) {
    mismatch("schema_vocabulary");
  }
  for (const key of ["allOf", "anyOf", "oneOf", "enum"]) {
    if (
      schema[key] !== undefined &&
      (!Array.isArray(schema[key]) || schema[key].length === 0)
    ) {
      mismatch("schema_vocabulary");
    }
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every(value => typeof value === "string") ||
      new Set(schema.required).size !== schema.required.length)
  ) {
    mismatch("schema_vocabulary");
  }
  if (schema.type !== undefined) {
    const types =
      typeof schema.type === "string"
        ? [schema.type]
        : Array.isArray(schema.type) &&
            schema.type.length > 0 &&
            schema.type.every(value => typeof value === "string")
          ? schema.type
          : null;
    if (
      types === null ||
      new Set(types).size !== types.length ||
      types.some(value => !SCHEMA_TYPES.has(value))
    ) {
      mismatch("schema_vocabulary");
    }
  }
  for (const key of [
    "maxItems",
    "maxLength",
    "minItems",
    "minLength",
  ]) {
    if (
      schema[key] !== undefined &&
      (!Number.isSafeInteger(schema[key]) || schema[key] < 0)
    ) {
      mismatch("schema_vocabulary");
    }
  }
  for (const key of ["maximum", "minimum"]) {
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    ) {
      mismatch("schema_vocabulary");
    }
  }
  for (const group of [schema.properties, schema.definitions]) {
    if (group === undefined) continue;
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      mismatch("schema_vocabulary");
    }
    for (const child of Object.values(group)) {
      auditMaterializedSchemaVocabulary(child, supported);
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    if (schema[key] === undefined) continue;
    if (
      typeof schema[key] !== "boolean" &&
      (schema[key] === null ||
        typeof schema[key] !== "object" ||
        Array.isArray(schema[key]))
    ) {
      mismatch("schema_vocabulary");
    }
    auditMaterializedSchemaVocabulary(schema[key], supported);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key])) mismatch("schema_vocabulary");
    for (const child of schema[key]) {
      auditMaterializedSchemaVocabulary(child, supported);
    }
  }
}

export function validateSchemaVocabulary(schema, contract) {
  if (
    !Object.isFrozen(contract) ||
    !Array.isArray(contract?.supportedSchemaVocabulary)
  ) {
    mismatch();
  }
  auditMaterializedSchemaVocabulary(
    schema,
    new Set(contract.supportedSchemaVocabulary),
  );
}

function parseBundle(bundle) {
  if (
    bundle === null ||
    typeof bundle !== "object" ||
    !Array.isArray(bundle.files) ||
    bundle.files.length === 0
  ) {
    mismatch();
  }
  const files = new Map();
  for (const entry of bundle.files) {
    if (!Array.isArray(entry) || entry.length !== 2) mismatch();
    const path = normalizeSchemaPath(entry[0]);
    if (files.has(path) || !(entry[1] instanceof Uint8Array)) mismatch();
    let ast;
    try {
      ast = parseLosslessJson(entry[1]);
    } catch {
      mismatch();
    }
    files.set(path, ast);
  }
  return files;
}

function auditNamespacedBundle(schema, supported) {
  if (schema?.kind !== "object") mismatch("schema_vocabulary");
  for (const member of schema.members) {
    if (!supported.has(member.key)) mismatch("schema_vocabulary");
  }
  const definitions = astObjectMember(schema, "definitions");
  if (definitions?.kind !== "object") mismatch("schema_vocabulary");
  const auditDefinitionOrNamespace = node => {
    if (node?.kind !== "object") mismatch("schema_vocabulary");
    if (node.members.some(member => supported.has(member.key))) {
      auditSchemaVocabulary(node, supported);
      return;
    }
    for (const child of node.members) {
      auditDefinitionOrNamespace(child.value);
    }
  };
  for (const definition of definitions.members) {
    auditDefinitionOrNamespace(definition.value);
  }
}

export function validateAppServerCompatibility(bundle, contract) {
  if (
    !Object.isFrozen(contract) ||
    contract?.contractVersion !== 1 ||
    contract.requiredDefinitions === null ||
    typeof contract.requiredDefinitions !== "object" ||
    !Array.isArray(contract.supportedSchemaVocabulary)
  ) {
    mismatch();
  }
  const files = parseBundle(bundle);
  const bundleSchema = files.get("codex_app_server_protocol.v2.schemas.json");
  const definitions = astObjectMember(bundleSchema, "definitions");
  if (definitions?.kind !== "object") mismatch();
  const definitionsByName = new Map(
    definitions.members.map(member => [member.key, member.value]),
  );

  for (const [name, requiredDefinition] of Object.entries(
    contract.requiredDefinitions,
  )) {
    const definition = definitionsByName.get(name);
    if (definition === undefined) mismatch(name);
    const properties = astObjectMember(definition, "properties");
    const required = astObjectMember(definition, "required");
    const requiredNames =
      required === undefined
        ? []
        : required.kind === "array" &&
            required.items.every(item => item.kind === "string")
          ? required.items.map(item => item.value)
          : null;
    if (
      properties?.kind !== "object" ||
      requiredNames === null ||
      requiredDefinition.properties.some(
        field => !properties.members.some(member => member.key === field),
      ) ||
      requiredDefinition.required.some(field => !requiredNames.includes(field))
    ) {
      mismatch("required_field");
    }
  }

  const vocabulary = new Set(contract.supportedSchemaVocabulary);
  for (const [path, ast] of files) {
    if (path === "codex_app_server_protocol.schemas.json") {
      auditNamespacedBundle(ast, vocabulary);
    } else {
      auditSchemaVocabulary(ast, vocabulary);
    }
  }
  return Object.freeze({
    allDefinitions: definitions,
    definitions: Object.freeze(
      Object.fromEntries(
        Object.keys(contract.requiredDefinitions).map(name => [
          name,
          definitionsByName.get(name),
        ]),
      ),
    ),
  });
}

export function deriveSafeSchemaMismatchDetails(contract) {
  if (
    !Object.isFrozen(contract) ||
    contract?.contractVersion !== 1 ||
    contract.requiredDefinitions === null ||
    typeof contract.requiredDefinitions !== "object"
  ) {
    mismatch();
  }
  return Object.freeze([
    ...Object.keys(contract.requiredDefinitions),
    ...VALIDATOR_DETAILS,
  ]);
}
