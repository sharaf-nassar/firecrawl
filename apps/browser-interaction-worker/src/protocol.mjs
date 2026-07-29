import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_SCREENSHOT_BASE64_CHARACTERS =
  Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_BIT_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

export const MAX_BROWSER_ACTIONS = 25;

const closedObject = (properties) =>
  Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze(Object.keys(properties)),
    additionalProperties: false,
  });

const stringLiteral = (value) =>
  Object.freeze({ type: "string", enum: Object.freeze([value]) });

const nullable = (schema) =>
  Object.freeze({ anyOf: Object.freeze([schema, { type: "null" }]) });

const refSchema = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 128,
});

const actionDecisionSchema = closedObject({
  version: Object.freeze({ type: "integer", enum: Object.freeze([1]) }),
  type: stringLiteral("action"),
  action: Object.freeze({
    anyOf: Object.freeze([
      closedObject({
        kind: stringLiteral("navigate"),
        url: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 8_192,
        }),
      }),
      closedObject({
        kind: stringLiteral("click"),
        ref: refSchema,
      }),
      closedObject({
        kind: stringLiteral("hover"),
        ref: refSchema,
      }),
      closedObject({
        kind: stringLiteral("hover_batch"),
        refs: Object.freeze({
          type: "array",
          items: refSchema,
          minItems: 1,
          maxItems: 16,
        }),
      }),
      closedObject({
        kind: stringLiteral("type"),
        ref: refSchema,
        text: Object.freeze({ type: "string", maxLength: 20_000 }),
        clear: nullable(Object.freeze({ type: "boolean" })),
      }),
      closedObject({
        kind: stringLiteral("wait"),
        milliseconds: Object.freeze({
          type: "integer",
          minimum: 0,
          maximum: 30_000,
        }),
      }),
      closedObject({
        kind: stringLiteral("extract"),
        ref: nullable(refSchema),
      }),
      closedObject({
        kind: stringLiteral("screenshot"),
        fullPage: nullable(Object.freeze({ type: "boolean" })),
      }),
    ]),
  }),
});

const finalDecisionSchema = closedObject({
  version: Object.freeze({ type: "integer", enum: Object.freeze([1]) }),
  type: stringLiteral("final"),
  output: Object.freeze({ type: "string", maxLength: 262_144 }),
});

export const modelDecisionEnvelopeSchema = closedObject({
  decision: Object.freeze({
    anyOf: Object.freeze([actionDecisionSchema, finalDecisionSchema]),
  }),
});

export const finalModelDecisionEnvelopeSchema = closedObject({
  decision: finalDecisionSchema,
});

export function modelDecisionEnvelopeSchemaForTurn(turn, finalOnly = false) {
  if (!Number.isInteger(turn) || turn < 0 || turn > MAX_BROWSER_ACTIONS) {
    throw new RangeError("invalid browser decision turn");
  }
  if (typeof finalOnly !== "boolean") {
    throw new TypeError("finalOnly must be a boolean");
  }
  return turn === MAX_BROWSER_ACTIONS || finalOnly
    ? finalModelDecisionEnvelopeSchema
    : modelDecisionEnvelopeSchema;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function hasOnlyKeys(value, required, optional) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => required.includes(key) || optional.includes(key))
  );
}

function codePointLength(value) {
  return typeof value === "string" ? [...value].length : -1;
}

function boundedString(value, minimum, maximum) {
  const length = codePointLength(value);
  return length >= minimum && length <= maximum;
}

function boundedRef(value) {
  return boundedString(value, 1, 128);
}

function optionalBoolean(value) {
  return value === undefined || value === null || typeof value === "boolean";
}

function validHttpUrl(value) {
  if (!boundedString(value, 1, 8_192)) return false;
  try {
    const parsed = new URL(value);
    return (
      HTTP_PROTOCOLS.has(parsed.protocol) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname !== ""
    );
  } catch {
    return false;
  }
}

function assertPng(bytes) {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new TypeError("screenshot is not a PNG image");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compressionMethod = bytes[26];
  const filterMethod = bytes[27];
  const interlaceMethod = bytes[28];
  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !PNG_BIT_DEPTHS.get(colorType)?.has(bitDepth) ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    (interlaceMethod !== 0 && interlaceMethod !== 1)
  ) {
    throw new TypeError("screenshot has an invalid PNG IHDR");
  }
}

function normalizeScreenshotImage(image) {
  const keys = [
    "version",
    "artifactId",
    "contentType",
    "byteSize",
    "checksum",
    "encoding",
    "data",
  ];
  if (
    !hasExactKeys(image, keys) ||
    image.version !== 1 ||
    typeof image.artifactId !== "string" ||
    image.artifactId === NIL_UUID ||
    !UUID_PATTERN.test(image.artifactId) ||
    image.contentType !== "image/png" ||
    !Number.isSafeInteger(image.byteSize) ||
    image.byteSize <= 0 ||
    image.byteSize > MAX_SCREENSHOT_BYTES ||
    typeof image.checksum !== "string" ||
    !SHA256_PATTERN.test(image.checksum) ||
    image.encoding !== "base64" ||
    typeof image.data !== "string" ||
    image.data.length === 0 ||
    image.data.length > MAX_SCREENSHOT_BASE64_CHARACTERS ||
    !BASE64_PATTERN.test(image.data)
  ) {
    throw new TypeError("invalid screenshot image");
  }
  const data = Buffer.from(image.data, "base64");
  if (
    data.length !== image.byteSize ||
    data.toString("base64") !== image.data ||
    createHash("sha256").update(data).digest("hex") !== image.checksum
  ) {
    throw new TypeError("screenshot image integrity check failed");
  }
  assertPng(data);
  return Object.freeze({
    version: 1,
    artifactId: image.artifactId,
    contentType: "image/png",
    byteSize: image.byteSize,
    checksum: image.checksum,
    encoding: "base64",
    data,
  });
}

function normalizeAction(action) {
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("invalid model action");
  }
  switch (action.kind) {
    case "navigate":
      if (!hasExactKeys(action, ["kind", "url"]) || !validHttpUrl(action.url)) {
        throw new TypeError("invalid navigate action");
      }
      return { kind: "navigate", url: action.url };
    case "click":
      if (!hasExactKeys(action, ["kind", "ref"]) || !boundedRef(action.ref)) {
        throw new TypeError("invalid click action");
      }
      return { kind: "click", ref: action.ref };
    case "hover":
      if (!hasExactKeys(action, ["kind", "ref"]) || !boundedRef(action.ref)) {
        throw new TypeError("invalid hover action");
      }
      return { kind: "hover", ref: action.ref };
    case "hover_batch":
      if (
        !hasExactKeys(action, ["kind", "refs"]) ||
        !Array.isArray(action.refs) ||
        action.refs.length < 1 ||
        action.refs.length > 16 ||
        action.refs.some((ref) => !boundedRef(ref)) ||
        new Set(action.refs).size !== action.refs.length
      ) {
        throw new TypeError("invalid hover_batch action");
      }
      return { kind: "hover_batch", refs: [...action.refs] };
    case "type": {
      const keys = Object.keys(action);
      if (
        !["kind", "ref", "text"].every((key) => keys.includes(key)) ||
        keys.some((key) => !["kind", "ref", "text", "clear"].includes(key)) ||
        !boundedRef(action.ref) ||
        !boundedString(action.text, 0, 20_000) ||
        !optionalBoolean(action.clear)
      ) {
        throw new TypeError("invalid type action");
      }
      return action.clear === undefined || action.clear === null
        ? { kind: "type", ref: action.ref, text: action.text }
        : {
            kind: "type",
            ref: action.ref,
            text: action.text,
            clear: action.clear,
          };
    }
    case "wait":
      if (
        !hasExactKeys(action, ["kind", "milliseconds"]) ||
        !Number.isInteger(action.milliseconds) ||
        action.milliseconds < 0 ||
        action.milliseconds > 30_000
      ) {
        throw new TypeError("invalid wait action");
      }
      return { kind: "wait", milliseconds: action.milliseconds };
    case "extract": {
      const keys = Object.keys(action);
      if (
        !keys.includes("kind") ||
        keys.some((key) => !["kind", "ref"].includes(key)) ||
        !(
          action.ref === undefined ||
          action.ref === null ||
          boundedRef(action.ref)
        )
      ) {
        throw new TypeError("invalid extract action");
      }
      return action.ref === undefined || action.ref === null
        ? { kind: "extract" }
        : { kind: "extract", ref: action.ref };
    }
    case "screenshot": {
      const keys = Object.keys(action);
      if (
        !keys.includes("kind") ||
        keys.some((key) => !["kind", "fullPage"].includes(key)) ||
        !optionalBoolean(action.fullPage)
      ) {
        throw new TypeError("invalid screenshot action");
      }
      return action.fullPage === undefined || action.fullPage === null
        ? { kind: "screenshot" }
        : { kind: "screenshot", fullPage: action.fullPage };
    }
    default:
      throw new TypeError("unsupported model action");
  }
}

export function parseAndNormalizeModelEnvelope(raw, options = {}) {
  if (Buffer.byteLength(raw, "utf8") > 384 * 1024) {
    throw new RangeError("model decision exceeds its byte bound");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("model decision is not JSON");
  }
  if (!hasExactKeys(value, ["decision"])) {
    throw new TypeError("invalid model envelope");
  }
  const decision = value.decision;
  if (
    decision?.version !== 1 ||
    (decision.type !== "action" && decision.type !== "final")
  ) {
    throw new TypeError("invalid model decision");
  }
  if (decision.type === "final") {
    if (
      !hasExactKeys(decision, ["version", "type", "output"]) ||
      typeof decision.output !== "string" ||
      Buffer.byteLength(decision.output, "utf8") > 256 * 1024
    ) {
      throw new TypeError("invalid final decision");
    }
    return { decision: { version: 1, type: "final", output: decision.output } };
  }
  if (!hasExactKeys(decision, ["version", "type", "action"])) {
    throw new TypeError("invalid action decision");
  }
  if (options.allowAction === false) {
    const error = new TypeError("action decision exceeds action budget");
    error.category = "codex_protocol_error";
    error.diagnostic =
      options.actionDeniedDiagnostic ?? "action_budget_exhausted";
    throw error;
  }
  return {
    decision: {
      version: 1,
      type: "action",
      action: normalizeAction(decision.action),
    },
  };
}

export function parseAndNormalizeModelEnvelopeForTurn(
  raw,
  turn,
  finalOnly = false,
) {
  modelDecisionEnvelopeSchemaForTurn(turn, finalOnly);
  return parseAndNormalizeModelEnvelope(raw, {
    allowAction: turn < MAX_BROWSER_ACTIONS && !finalOnly,
    actionDeniedDiagnostic:
      finalOnly && turn < MAX_BROWSER_ACTIONS
        ? "final_decision_required"
        : "action_budget_exhausted",
  });
}

function validJsonValue(root) {
  const pending = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return false;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    const values = Array.isArray(value) ? value : Object.values(value);
    for (const child of values)
      pending.push({ value: child, depth: depth + 1 });
  }
  return true;
}

export function validateDecisionRequest(value) {
  if (
    !hasOnlyKeys(
      value,
      [
        "runId",
        "prompt",
        "turn",
        "history",
        "observation",
        "startedAtMs",
        "deadlineMs",
      ],
      ["image"],
    ) ||
    typeof value.runId !== "string" ||
    value.runId === NIL_UUID ||
    !UUID_PATTERN.test(value.runId) ||
    !boundedString(value.prompt, 0, 10_000) ||
    !Number.isInteger(value.turn) ||
    value.turn < 0 ||
    value.turn > MAX_BROWSER_ACTIONS ||
    !Number.isSafeInteger(value.startedAtMs) ||
    value.startedAtMs < 0 ||
    !Number.isSafeInteger(value.deadlineMs) ||
    value.deadlineMs <= value.startedAtMs ||
    value.deadlineMs - value.startedAtMs > 300_000 ||
    !Array.isArray(value.history) ||
    value.history.length !== value.turn ||
    value.history.length > MAX_BROWSER_ACTIONS ||
    value.observation === undefined ||
    !validJsonValue(value.observation)
  ) {
    throw new TypeError("invalid decision request");
  }
  const observationJson = JSON.stringify(value.observation);
  if (Buffer.byteLength(observationJson, "utf8") > 64 * 1024) {
    throw new RangeError("observation exceeds 64 KiB");
  }
  const history = [];
  let aggregateObservationBytes = 0;
  for (const [index, entry] of value.history.entries()) {
    if (
      !hasExactKeys(entry, ["turn", "action", "observation"]) ||
      entry.turn !== index ||
      !validJsonValue(entry.observation)
    ) {
      throw new TypeError("invalid decision history");
    }
    const action = normalizeAction(entry.action);
    const entryObservationJson = JSON.stringify(entry.observation);
    const entryObservationBytes = Buffer.byteLength(
      entryObservationJson,
      "utf8",
    );
    if (
      entryObservationBytes > 64 * 1024 ||
      entry.observation?.type !== "action_result" ||
      entry.observation.sequence !== index + 1 ||
      entry.observation.actionKind !== action.kind
    ) {
      throw new RangeError("decision history observation is invalid");
    }
    aggregateObservationBytes += entryObservationBytes;
    history.push(
      Object.freeze({
        turn: index,
        action: Object.freeze(action),
        observation: entry.observation,
      }),
    );
  }
  if (aggregateObservationBytes > 1024 * 1024) {
    throw new RangeError("decision history observations exceed 1 MiB");
  }
  if (
    (value.turn === 0 &&
      (value.observation?.type !== "initial" ||
        value.observation.sequence !== 0)) ||
    (value.turn > 0 &&
      JSON.stringify(history.at(-1)?.observation) !== observationJson)
  ) {
    throw new TypeError("current observation does not match decision history");
  }
  const historyJson = JSON.stringify(history);
  const finalHistoryJson = JSON.stringify(
    history.map((entry) => {
      const observation = entry.observation;
      return {
        turn: entry.turn,
        action: entry.action,
        observation: {
          version: observation.version,
          type: observation.type,
          sequence: observation.sequence,
          actionKind: observation.actionKind,
          outcome: observation.outcome,
          ...(observation.result === undefined
            ? {}
            : { result: observation.result }),
          ...(observation.error === undefined
            ? {}
            : { error: observation.error }),
        },
      };
    }),
  );
  const image =
    value.image === undefined
      ? undefined
      : normalizeScreenshotImage(value.image);
  const screenshotResult =
    value.observation?.type === "action_result" &&
    value.observation.outcome === "succeeded" &&
    value.observation.actionKind === "screenshot" &&
    value.observation.result?.kind === "screenshot"
      ? value.observation.result
      : undefined;
  if (
    (screenshotResult === undefined) !== (image === undefined) ||
    (screenshotResult !== undefined &&
      image !== undefined &&
      (screenshotResult.artifactId !== image.artifactId ||
        value.observation.actionId !== image.artifactId ||
        screenshotResult.contentType !== image.contentType ||
        screenshotResult.byteSize !== image.byteSize ||
        screenshotResult.checksum !== image.checksum))
  ) {
    throw new TypeError("screenshot image does not match current observation");
  }
  return Object.freeze({
    runId: value.runId,
    prompt: value.prompt,
    turn: value.turn,
    startedAtMs: value.startedAtMs,
    deadlineMs: value.deadlineMs,
    history: Object.freeze(history),
    historyJson,
    finalHistoryJson,
    observation: value.observation,
    observationJson,
    ...(image === undefined ? {} : { image }),
  });
}

export function schemaIsStable() {
  return (
    isDeepStrictEqual(
      JSON.parse(JSON.stringify(modelDecisionEnvelopeSchema)),
      modelDecisionEnvelopeSchema,
    ) &&
    isDeepStrictEqual(
      JSON.parse(JSON.stringify(finalModelDecisionEnvelopeSchema)),
      finalModelDecisionEnvelopeSchema,
    )
  );
}
