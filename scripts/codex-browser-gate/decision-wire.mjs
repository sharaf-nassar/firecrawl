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

export const modelDecisionEnvelopeSchema = closed({
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
});

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).toSorted().join("\0") ===
      keys.toSorted().join("\0")
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
    schema.required.length !== 1 ||
    schema.required[0] !== "decision" ||
    !hasExactKeys(schema.properties.decision, ["anyOf"]) ||
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
    if (node.properties) {
      for (const child of Object.values(node.properties)) visit(child);
    }
    if (node.items) visit(node.items);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      for (const child of node[key] ?? []) visit(child);
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
  assert.equal(validString("😀", 1, 1), true);
  assert.equal(validString("😀", 2, 2), false);
  const duplicateDecision = String.raw`
    {"decision":{"version":1,"type":"final","output":"gate-complete"},
    "\u0064ecision":{"version":1,"type":"final",
    "output":"gate-complete"}}
  `;
  assert.throws(
    () => parseModelDecisionEnvelopeV1(duplicateDecision),
    /model_protocol_error/,
  );
}
