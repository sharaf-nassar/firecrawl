import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { gateError } from "./gate-contract.mjs";
import {
  canonicalizeJsonBytes,
  parseLosslessJson,
} from "./schema-canonicalizer.mjs";

const closed = properties => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const stringLiteral = value => ({ type: "string", enum: [value] });
const versionOne = { type: "integer", enum: [1] };

function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null ||
    typeof value !== "object" ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

const modelWireBrowserOperationV1Schema = {
  anyOf: [
    closed({ kind: stringLiteral("snapshot") }),
    closed({
      kind: stringLiteral("click"),
      ref: { type: "string", minLength: 1, maxLength: 128 },
    }),
    closed({
      kind: stringLiteral("fill"),
      ref: { type: "string", minLength: 1, maxLength: 128 },
      value: { type: "string", maxLength: 20000 },
    }),
    closed({
      kind: stringLiteral("type"),
      ref: { type: "string", minLength: 1, maxLength: 128 },
      value: { type: "string", maxLength: 20000 },
      delayMs: { type: "integer", minimum: 0, maximum: 250 },
    }),
    closed({
      kind: stringLiteral("press"),
      ref: { type: "string", minLength: 1, maxLength: 128 },
      key: { type: "string", minLength: 1, maxLength: 64 },
    }),
    closed({
      kind: stringLiteral("select"),
      ref: { type: "string", minLength: 1, maxLength: 128 },
      values: {
        type: "array",
        items: { type: "string", maxLength: 512 },
        maxItems: 20,
      },
    }),
    closed({
      kind: stringLiteral("scroll"),
      deltaX: { type: "integer", minimum: -10000, maximum: 10000 },
      deltaY: { type: "integer", minimum: -10000, maximum: 10000 },
    }),
    closed({
      kind: stringLiteral("wait"),
      milliseconds: { type: "integer", minimum: 0, maximum: 30000 },
    }),
    closed({
      kind: stringLiteral("get_text"),
      ref: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 128 },
          { type: "null" },
        ],
      },
    }),
    closed({ kind: stringLiteral("get_url") }),
    closed({
      kind: stringLiteral("navigate"),
      url: { type: "string", maxLength: 8192 },
    }),
    closed({
      kind: stringLiteral("evaluate"),
      expression: { type: "string", maxLength: 20000 },
      args: closed({}),
    }),
  ],
};

export const modelDecisionEnvelopeSchema = deepFreeze(
  closed({
    decision: {
      anyOf: [
        closed({
          version: versionOne,
          type: stringLiteral("action"),
          action: modelWireBrowserOperationV1Schema,
        }),
        closed({
          version: versionOne,
          type: stringLiteral("final"),
          output: { type: "string", maxLength: 262144 },
        }),
      ],
    },
  }),
);

function hasExactKeys(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  );
}

function modelProtocolError() {
  throw gateError("model_protocol_error");
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      );
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return false;
  }
}

function auditModelDecisionSchema(schema) {
  const reject = () => {
    throw gateError("model_protocol_error");
  };
  if (
    !hasExactKeys(schema, [
      "type",
      "properties",
      "required",
      "additionalProperties",
    ]) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !hasExactKeys(schema.properties, ["decision"]) ||
    !Array.isArray(schema.required) ||
    schema.required.length !== 1 ||
    schema.required[0] !== "decision" ||
    !hasExactKeys(schema.properties.decision, ["anyOf"]) ||
    !Array.isArray(schema.properties.decision.anyOf) ||
    schema.properties.decision.anyOf.length !== 2
  ) {
    reject();
  }

  function visit(node) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      reject();
    }
    if (Object.hasOwn(node, "const")) reject();
    if (Object.hasOwn(node, "enum")) {
      if (
        typeof node.type !== "string" ||
        !Array.isArray(node.enum) ||
        node.enum.length === 0 ||
        !node.enum.every(value => schemaTypeMatches(value, node.type))
      ) {
        reject();
      }
    }
    const scalarAssertions = [
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
    ];
    if (
      scalarAssertions.some(key => Object.hasOwn(node, key)) &&
      typeof node.type !== "string"
    ) {
      reject();
    }
    if (Object.hasOwn(node, "properties")) {
      if (
        node.type !== "object" ||
        node.properties === null ||
        typeof node.properties !== "object" ||
        Array.isArray(node.properties) ||
        node.additionalProperties !== false ||
        !Array.isArray(node.required)
      ) {
        reject();
      }
      const propertyKeys = Object.keys(node.properties);
      if (
        node.required.length !== propertyKeys.length ||
        !propertyKeys.every(key => node.required.includes(key))
      ) {
        reject();
      }
      for (const child of Object.values(node.properties)) visit(child);
    }
    if (Object.hasOwn(node, "items")) visit(node.items);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (!Object.hasOwn(node, key)) continue;
      if (!Array.isArray(node[key])) reject();
      for (const child of node[key]) visit(child);
    }
  }
  visit(schema);
}

function greatestCommonDivisor(left, right) {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function safeModelNumber(raw) {
  const match =
    /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(
      raw,
    );
  if (!match) modelProtocolError();
  const coefficient = BigInt(
    `${match[1]}${match[2]}${match[3] ?? ""}`,
  );
  if (coefficient === 0n) return 0;
  const exponent =
    BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
  if (exponent < -100n || exponent > 100n) modelProtocolError();
  let numerator = coefficient < 0n ? -coefficient : coefficient;
  let denominator = 1n;
  if (exponent >= 0n) {
    numerator *= 10n ** BigInt(parseInt(exponent.toString(), 10));
  } else {
    denominator =
      10n ** BigInt(parseInt((-exponent).toString(), 10));
  }
  if (numerator > BigInt(Number.MAX_SAFE_INTEGER) * denominator) {
    modelProtocolError();
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  let reducedDenominator = denominator / divisor;
  while (reducedDenominator % 2n === 0n) reducedDenominator /= 2n;
  if (
    reducedDenominator !== 1n ||
    reducedNumerator > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    modelProtocolError();
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) modelProtocolError();
  return value;
}

function losslessJsonNodeToPlainValue(node) {
  switch (node.kind) {
    case "string":
      return node.value;
    case "number":
      return safeModelNumber(node.raw);
    case "true":
      return true;
    case "false":
      return false;
    case "null":
      return null;
    case "array":
      return node.items.map(losslessJsonNodeToPlainValue);
    case "object": {
      const value = {};
      for (const member of node.members) {
        Object.defineProperty(value, member.key, {
          configurable: true,
          enumerable: true,
          value: losslessJsonNodeToPlainValue(member.value),
          writable: true,
        });
      }
      return value;
    }
    default:
      modelProtocolError();
  }
}

function validString(value, minLength, maxLength) {
  const length = typeof value === "string" ? [...value].length : -1;
  return (
    typeof value === "string" &&
    length >= minLength &&
    length <= maxLength
  );
}

function validInteger(value, minimum, maximum) {
  return (
    Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function validateModelWireBrowserOperationV1(operation) {
  if (operation === null || typeof operation !== "object") {
    modelProtocolError();
  }
  switch (operation.kind) {
    case "snapshot":
    case "get_url":
      if (!hasExactKeys(operation, ["kind"])) modelProtocolError();
      return;
    case "click":
      if (
        !hasExactKeys(operation, ["kind", "ref"]) ||
        !validString(operation.ref, 1, 128)
      ) {
        modelProtocolError();
      }
      return;
    case "fill":
      if (
        !hasExactKeys(operation, ["kind", "ref", "value"]) ||
        !validString(operation.ref, 1, 128) ||
        !validString(operation.value, 0, 20000)
      ) {
        modelProtocolError();
      }
      return;
    case "type":
      if (
        !hasExactKeys(operation, [
          "kind",
          "ref",
          "value",
          "delayMs",
        ]) ||
        !validString(operation.ref, 1, 128) ||
        !validString(operation.value, 0, 20000) ||
        !validInteger(operation.delayMs, 0, 250)
      ) {
        modelProtocolError();
      }
      return;
    case "press":
      if (
        !hasExactKeys(operation, ["kind", "ref", "key"]) ||
        !validString(operation.ref, 1, 128) ||
        !validString(operation.key, 1, 64)
      ) {
        modelProtocolError();
      }
      return;
    case "select":
      if (
        !hasExactKeys(operation, ["kind", "ref", "values"]) ||
        !validString(operation.ref, 1, 128) ||
        !Array.isArray(operation.values) ||
        operation.values.length > 20 ||
        !operation.values.every(value => validString(value, 0, 512))
      ) {
        modelProtocolError();
      }
      return;
    case "scroll":
      if (
        !hasExactKeys(operation, ["kind", "deltaX", "deltaY"]) ||
        !validInteger(operation.deltaX, -10000, 10000) ||
        !validInteger(operation.deltaY, -10000, 10000)
      ) {
        modelProtocolError();
      }
      return;
    case "wait":
      if (
        !hasExactKeys(operation, ["kind", "milliseconds"]) ||
        !validInteger(operation.milliseconds, 0, 30000)
      ) {
        modelProtocolError();
      }
      return;
    case "get_text":
      if (
        !hasExactKeys(operation, ["kind", "ref"]) ||
        !(operation.ref === null || validString(operation.ref, 1, 128))
      ) {
        modelProtocolError();
      }
      return;
    case "navigate":
      if (
        !hasExactKeys(operation, ["kind", "url"]) ||
        !validString(operation.url, 0, 8192)
      ) {
        modelProtocolError();
      }
      return;
    case "evaluate":
      if (
        !hasExactKeys(operation, ["kind", "expression", "args"]) ||
        !validString(operation.expression, 0, 20000) ||
        !hasExactKeys(operation.args, [])
      ) {
        modelProtocolError();
      }
      return;
    default:
      modelProtocolError();
  }
}

function validateModelDecisionEnvelopeV1(envelope) {
  if (!hasExactKeys(envelope, ["decision"])) modelProtocolError();
  const decision = envelope.decision;
  if (decision?.type === "action") {
    if (
      !hasExactKeys(decision, ["version", "type", "action"]) ||
      decision.version !== 1
    ) {
      modelProtocolError();
    }
    validateModelWireBrowserOperationV1(decision.action);
    return;
  }
  if (
    decision?.type !== "final" ||
    !hasExactKeys(decision, ["version", "type", "output"]) ||
    decision.version !== 1 ||
    !validString(decision.output, 0, 262144)
  ) {
    modelProtocolError();
  }
}

export function parseModelDecisionEnvelopeV1(rawText) {
  try {
    const envelope = losslessJsonNodeToPlainValue(
      parseLosslessJson(Buffer.from(rawText, "utf8")),
    );
    validateModelDecisionEnvelopeV1(envelope);
    return envelope;
  } catch {
    throw gateError("model_protocol_error");
  }
}

export function normalizeModelDecisionEnvelopeV1(envelope) {
  const decision = envelope.decision;
  if (decision.type === "final") {
    return { version: 1, type: "final", output: decision.output };
  }
  return {
    version: 1,
    type: "action",
    action: {
      kind: "fill",
      ref: decision.action.ref,
      value: decision.action.value,
    },
  };
}

export function normalizedProposalHash(operation) {
  const raw = Buffer.from(JSON.stringify(operation), "utf8");
  return createHash("sha256")
    .update(canonicalizeJsonBytes(raw))
    .digest("hex");
}

export async function runDecisionWireSelfTest(
  { silent = false } = {},
) {
  void silent;
  const maxRef = "r".repeat(128);
  const maxValue = "v".repeat(20000);
  const maxKey = "k".repeat(64);
  const maxSelectValue = "s".repeat(512);
  const maxUrl = "u".repeat(8192);
  const maxExpression = "e".repeat(20000);
  const validOperations = [
    { kind: "snapshot" },
    { kind: "click", ref: "r" },
    { kind: "click", ref: maxRef },
    { kind: "fill", ref: "r", value: "" },
    { kind: "fill", ref: maxRef, value: maxValue },
    { kind: "type", ref: "r", value: "", delayMs: 0 },
    {
      kind: "type",
      ref: maxRef,
      value: maxValue,
      delayMs: 250,
    },
    { kind: "press", ref: "r", key: "k" },
    { kind: "press", ref: maxRef, key: maxKey },
    { kind: "select", ref: "r", values: [] },
    {
      kind: "select",
      ref: maxRef,
      values: Array(20).fill(maxSelectValue),
    },
    { kind: "scroll", deltaX: -10000, deltaY: 10000 },
    { kind: "wait", milliseconds: 0 },
    { kind: "wait", milliseconds: 30000 },
    { kind: "get_text", ref: null },
    { kind: "get_text", ref: maxRef },
    { kind: "get_url" },
    { kind: "navigate", url: "" },
    { kind: "navigate", url: maxUrl },
    { kind: "evaluate", expression: "", args: {} },
    { kind: "evaluate", expression: maxExpression, args: {} },
  ];
  for (const operation of validOperations) {
    const envelope = {
      decision: { version: 1, type: "action", action: operation },
    };
    assert.deepEqual(
      parseModelDecisionEnvelopeV1(JSON.stringify(envelope)),
      envelope,
    );
  }

  for (const output of ["", "o".repeat(262144)]) {
    const envelope = {
      decision: { version: 1, type: "final", output },
    };
    assert.deepEqual(
      parseModelDecisionEnvelopeV1(JSON.stringify(envelope)),
      envelope,
    );
  }

  const rejectOperation = operation => {
    const envelope = {
      decision: { version: 1, type: "action", action: operation },
    };
    assert.throws(
      () => parseModelDecisionEnvelopeV1(JSON.stringify(envelope)),
      error => error?.code === "model_protocol_error",
    );
  };
  const invalidOperations = [
    null,
    [],
    { kind: "unknown" },
    { kind: "snapshot", extra: true },
    { kind: "click" },
    { kind: "click", ref: "" },
    { kind: "click", ref: "r".repeat(129) },
    { kind: "fill", ref: "r" },
    { kind: "fill", ref: "r", value: "v".repeat(20001) },
    { kind: "type", ref: "r", value: "" },
    { kind: "type", ref: "r", value: "", delayMs: -1 },
    { kind: "type", ref: "r", value: "", delayMs: 251 },
    { kind: "type", ref: "r", value: "", delayMs: 1.5 },
    { kind: "type", ref: "r", value: "", delayMs: 0.1 },
    {
      kind: "type",
      ref: "r",
      value: "",
      delayMs: Number.MAX_SAFE_INTEGER + 1,
    },
    { kind: "press", ref: "r", key: "" },
    { kind: "press", ref: "r", key: "k".repeat(65) },
    { kind: "select", ref: "r", values: Array(21).fill("") },
    { kind: "select", ref: "r", values: ["s".repeat(513)] },
    { kind: "select", ref: "r", values: "value" },
    { kind: "scroll", deltaX: -10001, deltaY: 0 },
    { kind: "scroll", deltaX: 0, deltaY: 10001 },
    { kind: "scroll", deltaX: 0.5, deltaY: 0 },
    {
      kind: "scroll",
      deltaX: Number.MAX_SAFE_INTEGER + 1,
      deltaY: 0,
    },
    { kind: "wait", milliseconds: -1 },
    { kind: "wait", milliseconds: 30001 },
    { kind: "wait", milliseconds: 1.5 },
    {
      kind: "wait",
      milliseconds: Number.MAX_SAFE_INTEGER + 1,
    },
    { kind: "get_text", ref: "" },
    { kind: "get_text", ref: "r".repeat(129) },
    { kind: "get_url", extra: true },
    { kind: "navigate", url: "u".repeat(8193) },
    {
      kind: "evaluate",
      expression: "e".repeat(20001),
      args: {},
    },
    { kind: "evaluate", expression: "", args: { extra: true } },
  ];
  for (const operation of invalidOperations) rejectOperation(operation);

  const invalidEnvelopes = [
    {},
    { decision: null },
    { decision: { version: 1, type: "unknown" } },
    { decision: { version: 0, type: "final", output: "" } },
    { decision: { version: 1.5, type: "final", output: "" } },
    {
      decision: {
        version: Number.MAX_SAFE_INTEGER + 1,
        type: "final",
        output: "",
      },
    },
    { decision: { version: 1, type: "action" } },
    {
      decision: {
        version: 1,
        type: "action",
        action: { kind: "snapshot" },
        extra: true,
      },
    },
    { decision: { version: 1, type: "final" } },
    {
      decision: {
        version: 1,
        type: "final",
        output: "o".repeat(262145),
      },
    },
    {
      decision: { version: 1, type: "final", output: "" },
      extra: true,
    },
  ];
  for (const envelope of invalidEnvelopes) {
    assert.throws(
      () => parseModelDecisionEnvelopeV1(JSON.stringify(envelope)),
      error => error?.code === "model_protocol_error",
    );
  }

  const invalidRawMessages = [
    "{",
    String.raw`
      {"decision":{"version":1,"type":"final",
      "\u0074ype":"action","output":"gate-complete"}}
    `,
    String.raw`
      {"decision":{"version":1,"type":"final",
      "output":"gate-complete"},"\u0064ecision":{}}
    `,
    String.raw`
      {"decision":{"version":1,"type":"action","action":
      {"kind":"evaluate","expression":"1","args":{"":123}}}}
    `,
    String.raw`
      {"decision":{"version":1,"type":"action","action":
      {"kind":"evaluate","expression":"1",
      "args":{"\u0000":123}}}}
    `,
    Buffer.from([0xc3, 0x28]),
  ];
  for (const raw of invalidRawMessages) {
    assert.throws(
      () => parseModelDecisionEnvelopeV1(raw),
      error => error?.code === "model_protocol_error",
    );
  }

  const ordered = {
    kind: "fill",
    ref: "gate-marker",
    value: "approved",
  };
  const permuted = {
    value: "approved",
    kind: "fill",
    ref: "gate-marker",
  };
  assert.equal(
    normalizedProposalHash(ordered),
    normalizedProposalHash(permuted),
  );
  assert.equal(
    normalizedProposalHash(ordered),
    "49ab57bf3d47260c01312dd62320de0a0048b466636b09f20fa7a9821802d1f2",
  );
  auditModelDecisionSchema(modelDecisionEnvelopeSchema);
  const bareConst = structuredClone(modelDecisionEnvelopeSchema);
  bareConst.properties.decision.anyOf[0].properties.version = {
    const: 1,
  };
  assert.throws(
    () => auditModelDecisionSchema(bareConst),
    /model_protocol_error/,
  );
  const untypedEnum = structuredClone(modelDecisionEnvelopeSchema);
  delete untypedEnum.properties.decision.anyOf[0].properties.type.type;
  assert.throws(
    () => auditModelDecisionSchema(untypedEnum),
    /model_protocol_error/,
  );
  const untypedScalar = structuredClone(modelDecisionEnvelopeSchema);
  delete untypedScalar.properties.decision.anyOf[1].properties.output.type;
  assert.throws(
    () => auditModelDecisionSchema(untypedScalar),
    /model_protocol_error/,
  );
  const openRoot = structuredClone(modelDecisionEnvelopeSchema);
  openRoot.additionalProperties = true;
  assert.throws(
    () => auditModelDecisionSchema(openRoot),
    /model_protocol_error/,
  );
  const nestedOpen = structuredClone(modelDecisionEnvelopeSchema);
  const nestedOpenOperations =
    nestedOpen.properties.decision.anyOf[0].properties.action.anyOf;
  const evaluateSchema = nestedOpenOperations.find(
    schema => schema.properties.kind.enum[0] === "evaluate",
  );
  evaluateSchema.properties.args.additionalProperties = true;
  assert.throws(
    () => auditModelDecisionSchema(nestedOpen),
    /model_protocol_error/,
  );
  const mismatchedRequired = structuredClone(
    modelDecisionEnvelopeSchema,
  );
  const mismatchedOperations =
    mismatchedRequired.properties.decision.anyOf[0].properties.action
      .anyOf;
  const clickSchema = mismatchedOperations.find(
    schema => schema.properties.kind.enum[0] === "click",
  );
  clickSchema.required = ["kind"];
  assert.throws(
    () => auditModelDecisionSchema(mismatchedRequired),
    /model_protocol_error/,
  );
  assert.equal(validString("😀", 1, 1), true);
  assert.equal(validString("😀", 2, 2), false);
}
