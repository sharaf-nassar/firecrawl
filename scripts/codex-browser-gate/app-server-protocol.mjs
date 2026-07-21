import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";

import {
  ALLOWED_ITEM_TYPES,
  CLEANUP_DRAIN_GRACE_MS,
  EFFORT,
  FORBIDDEN_EVENT_PATTERN,
  gateError,
  MAX_OUTPUT_BYTES,
  MODEL,
  REQUIRED_SCHEMA_DEFINITIONS,
  WATCHDOG_MS,
} from "./gate-contract.mjs";
import { LifecycleRegistry, ProcessDeadline } from "./lifecycle.mjs";
import {
  hashCanonicalSchemaBundle,
  parseLosslessJson,
} from "./schema-canonicalizer.mjs";

class RawJsonlFramer {
  constructor(onLine) {
    this.onLine = onLine;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      throw gateError("codex_event_json_invalid");
    }
    this.pending =
      this.pending.length === 0
        ? chunk
        : Buffer.concat([this.pending, chunk]);
    let newline;
    while ((newline = this.pending.indexOf(0x0a)) !== -1) {
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      this.onLine(line);
    }
  }

  finish() {
    if (this.pending.length !== 0) {
      throw gateError("codex_event_json_invalid");
    }
  }
}

const TRANSPORT_JSON_NUMBER = Symbol("transportJsonNumber");

function parseExactJsonNumber(raw, errorCode) {
  const reject = () => {
    throw gateError(errorCode);
  };
  if (typeof raw !== "string" || raw.length > 1_024) reject();
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(
    raw,
  );
  if (!match) reject();
  let coefficient;
  let exponent;
  try {
    coefficient = BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`);
    exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
  } catch {
    reject();
  }
  if (exponent < -1_000n || exponent > 1_000n) reject();
  let numerator = coefficient;
  let denominator = 1n;
  if (exponent >= 0n) {
    numerator *= 10n ** exponent;
  } else {
    denominator = 10n ** -exponent;
  }
  const divisor = greatestCommonDivisor(
    numerator < 0n ? -numerator : numerator,
    denominator,
  );
  return {
    denominator: denominator / divisor,
    numerator: numerator / divisor,
    raw,
  };
}

function transportJsonNumber(raw) {
  const exact = parseExactJsonNumber(raw, "codex_event_json_invalid");
  if (!Number.isFinite(Number(raw))) {
    throw gateError("codex_event_json_invalid");
  }
  return Object.freeze({ [TRANSPORT_JSON_NUMBER]: exact });
}

function isTransportJsonNumber(value) {
  return value?.[TRANSPORT_JSON_NUMBER] !== undefined;
}

function exactNumber(value) {
  if (isTransportJsonNumber(value)) return value[TRANSPORT_JSON_NUMBER];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return parseExactJsonNumber(
    String(value),
    "codex_protocol_schema_mismatch",
  );
}

function exactInteger(exact) {
  if (!exact || exact.numerator % exact.denominator !== 0n) return undefined;
  return exact.numerator / exact.denominator;
}

function compareExactNumbers(left, right) {
  const leftExact = exactNumber(left);
  const rightExact = exactNumber(right);
  if (!leftExact || !rightExact) return undefined;
  const difference =
    leftExact.numerator * rightExact.denominator -
    rightExact.numerator * leftExact.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function appServerResponseId(value) {
  const integer = exactInteger(exactNumber(value));
  if (
    integer === undefined ||
    integer < BigInt(Number.MIN_SAFE_INTEGER) ||
    integer > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw gateError("codex_response_id_invalid");
  }
  return Number(integer);
}

function transportJsonNodeToPlainValue(node) {
  switch (node.kind) {
    case "string":
      return node.value;
    case "number":
      return transportJsonNumber(node.raw);
    case "true":
      return true;
    case "false":
      return false;
    case "null":
      return null;
    case "array":
      return node.items.map(transportJsonNodeToPlainValue);
    case "object": {
      const value = {};
      for (const member of node.members) {
        Object.defineProperty(value, member.key, {
          configurable: true,
          enumerable: true,
          value: transportJsonNodeToPlainValue(member.value),
          writable: true,
        });
      }
      return value;
    }
    default:
      throw gateError("codex_event_json_invalid");
  }
}

function parseAppServerMessage(raw) {
  try {
    return transportJsonNodeToPlainValue(parseLosslessJson(raw));
  } catch {
    throw gateError("codex_event_json_invalid");
  }
}

export async function schemaHash(schemaDir) {
  const entries = await readdir(schemaDir, {
    recursive: true,
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw gateError("codex_protocol_schema_mismatch");
    }
    files.push(
      join(entry.parentPath, entry.name)
        .slice(schemaDir.length + 1)
        .replaceAll("\\", "/"),
    );
  }

  if (!files.includes("codex_app_server_protocol.v2.schemas.json")) {
    throw gateError("codex_protocol_schema_mismatch");
  }

  const rawFiles = [];
  try {
    for (const relativePath of files) {
      rawFiles.push([relativePath, await readFile(join(schemaDir, relativePath))]);
    }
  } catch {
    throw gateError("codex_protocol_schema_mismatch");
  }
  const bundleRaw = rawFiles.find(
    ([relativePath]) =>
      relativePath === "codex_app_server_protocol.v2.schemas.json",
  )?.[1];
  let bundleAst;
  try {
    bundleAst = parseLosslessJson(bundleRaw);
  } catch {
    throw gateError("codex_protocol_schema_mismatch");
  }
  const definitions = astObjectMember(bundleAst, "definitions");
  if (definitions?.kind !== "object") {
    throw gateError("codex_protocol_schema_mismatch");
  }
  for (const name of REQUIRED_SCHEMA_DEFINITIONS) {
    if (!definitions.members.some(member => member.key === name)) {
      throw gateError("codex_protocol_schema_mismatch", name);
    }
  }

  try {
    const SCHEMA_LOGICAL_PREFIX =
      "host/browser-runtime/protocol/codex-app-server/";
    return hashCanonicalSchemaBundle(
      rawFiles.map(([relativePath, raw]) => [
        `${SCHEMA_LOGICAL_PREFIX}${relativePath}`,
        raw,
      ]),
    );
  } catch {
    throw gateError("codex_protocol_schema_mismatch");
  }
}

function astObjectMember(node, key) {
  if (node?.kind !== "object") return undefined;
  return node.members.find(member => member.key === key)?.value;
}

const INTEGER_SCHEMA_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
]);

function greatestCommonDivisor(left, right) {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function safeSchemaNumber(raw, keyword) {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(
    raw,
  );
  if (!match) throw gateError("codex_protocol_schema_mismatch");
  const coefficient = BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`);
  if (coefficient === 0n) return 0;
  const exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
  if (exponent < -100n || exponent > 100n) {
    throw gateError("codex_protocol_schema_mismatch");
  }
  let numerator = coefficient < 0n ? -coefficient : coefficient;
  let denominator = 1n;
  if (exponent >= 0n) {
    numerator *= 10n ** BigInt(parseInt(exponent.toString(), 10));
  } else {
    denominator = 10n ** BigInt(parseInt((-exponent).toString(), 10));
  }
  if (INTEGER_SCHEMA_KEYWORDS.has(keyword) && numerator % denominator !== 0n) {
    throw gateError("codex_protocol_schema_mismatch");
  }
  if (numerator > BigInt(Number.MAX_SAFE_INTEGER) * denominator) {
    throw gateError("codex_protocol_schema_mismatch");
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  let reducedDenominator = denominator / divisor;
  while (reducedDenominator % 2n === 0n) reducedDenominator /= 2n;
  if (
    reducedDenominator !== 1n ||
    reducedNumerator > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw gateError("codex_protocol_schema_mismatch");
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw gateError("codex_protocol_schema_mismatch");
  }
  return value;
}

function schemaAstToValue(node, keyword) {
  switch (node.kind) {
    case "string":
      return node.value;
    case "number":
      return safeSchemaNumber(node.raw, keyword);
    case "true":
      return true;
    case "false":
      return false;
    case "null":
      return null;
    case "array":
      return node.items.map(item => schemaAstToValue(item, keyword));
    case "object": {
      const value = Object.create(null);
      for (const member of node.members) {
        value[member.key] = schemaAstToValue(member.value, member.key);
      }
      return value;
    }
    default:
      throw gateError("codex_protocol_schema_mismatch");
  }
}

function schemaTypeMatches(value, type) {
  const numeric = exactNumber(value);
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !isTransportJsonNumber(value)
      );
    case "integer":
      return exactInteger(numeric) !== undefined;
    case "number":
      return numeric !== undefined;
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return false;
  }
}

const INTEGER_FORMAT_RANGES = new Map([
  ["uint", [0n, BigInt(Number.MAX_SAFE_INTEGER)]],
  ["uint16", [0n, 65_535n]],
  ["uint32", [0n, 4_294_967_295n]],
  ["uint64", [0n, BigInt(Number.MAX_SAFE_INTEGER)]],
  ["int32", [-2_147_483_648n, 2_147_483_647n]],
  [
    "int64",
    [BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER)],
  ],
]);

function integerFormatMatches(value, format) {
  const range = INTEGER_FORMAT_RANGES.get(format);
  const integer = exactInteger(exactNumber(value));
  return (
    range !== undefined &&
    integer !== undefined &&
    integer >= range[0] &&
    integer <= range[1]
  );
}

function exactSchemaEqual(left, right) {
  const leftExact = exactNumber(left);
  const rightExact = exactNumber(right);
  if (leftExact || rightExact) {
    return (
      leftExact !== undefined &&
      rightExact !== undefined &&
      compareExactNumbers(left, right) === 0
    );
  }
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => exactSchemaEqual(item, right[index]))
    );
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        key =>
          Object.hasOwn(right, key) && exactSchemaEqual(left[key], right[key]),
      )
    );
  }
  return Object.is(left, right);
}

function materializeTransportValue(value) {
  if (isTransportJsonNumber(value)) {
    const exact = exactNumber(value);
    const integer = exactInteger(exact);
    if (
      integer !== undefined &&
      (integer < BigInt(Number.MIN_SAFE_INTEGER) ||
        integer > BigInt(Number.MAX_SAFE_INTEGER))
    ) {
      throw gateError("codex_protocol_schema_mismatch");
    }
    const materialized = Number(exact.raw);
    if (!Number.isFinite(materialized)) {
      throw gateError("codex_protocol_schema_mismatch");
    }
    if (compareExactNumbers(value, materialized) !== 0) {
      throw gateError("codex_protocol_schema_mismatch");
    }
    return materialized;
  }
  if (Array.isArray(value)) return value.map(materializeTransportValue);
  if (value !== null && typeof value === "object") {
    const materialized = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(materialized, key, {
        configurable: true,
        enumerable: true,
        value: materializeTransportValue(item),
        writable: true,
      });
    }
    return materialized;
  }
  return value;
}

function generatedSchemaMatches(value, schema, rootSchema, activePairs) {
  if (schema === true) return true;
  if (schema === false || schema === null || typeof schema !== "object") {
    return false;
  }
  let activeValues = activePairs.get(schema);
  if (activeValues?.has(value)) return false;
  if (!activeValues) {
    activeValues = new Set();
    activePairs.set(schema, activeValues);
  }
  activeValues.add(value);
  try {
    return generatedSchemaMatchesActive(
      value,
      schema,
      rootSchema,
      activePairs,
    );
  } finally {
    activeValues.delete(value);
    if (activeValues.size === 0) activePairs.delete(schema);
  }
}

function generatedSchemaMatchesActive(
  value,
  schema,
  rootSchema,
  activePairs,
) {
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/definitions/")) return false;
    const name = schema.$ref
      .slice("#/definitions/".length)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
    const target = rootSchema.definitions?.[name];
    return (
      target !== undefined &&
      generatedSchemaMatches(value, target, rootSchema, activePairs)
    );
  }
  if (
    schema.allOf &&
    !schema.allOf.every(part =>
      generatedSchemaMatches(value, part, rootSchema, activePairs),
    )
  ) {
    return false;
  }
  if (
    schema.anyOf &&
    !schema.anyOf.some(part =>
      generatedSchemaMatches(value, part, rootSchema, activePairs),
    )
  ) {
    return false;
  }
  if (
    schema.oneOf &&
    schema.oneOf.filter(part =>
      generatedSchemaMatches(value, part, rootSchema, activePairs),
    ).length !== 1
  ) {
    return false;
  }
  if (
    schema.enum &&
    !schema.enum.some(candidate => exactSchemaEqual(candidate, value))
  ) {
    return false;
  }
  if (
    Object.hasOwn(schema, "const") &&
    !exactSchemaEqual(schema.const, value)
  ) {
    return false;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => schemaTypeMatches(value, type))) return false;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return false;
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return false;
    }
  }
  if (exactNumber(value)) {
    if (schema.format && !integerFormatMatches(value, schema.format)) {
      return false;
    }
    if (
      schema.minimum !== undefined &&
      compareExactNumbers(value, schema.minimum) < 0
    ) {
      return false;
    }
    if (
      schema.maximum !== undefined &&
      compareExactNumbers(value, schema.maximum) > 0
    ) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return false;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return false;
    }
    if (
      schema.items &&
      !value.every(item =>
        generatedSchemaMatches(item, schema.items, rootSchema, activePairs),
      )
    ) {
      return false;
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isTransportJsonNumber(value)
  ) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return false;
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        if (
          !generatedSchemaMatches(
            item,
            schema.properties[key],
            rootSchema,
            activePairs,
          )
        ) {
          return false;
        }
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object" &&
        !generatedSchemaMatches(
          item,
          schema.additionalProperties,
          rootSchema,
          activePairs,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

export function assertGeneratedSchemaValue(value, schemaSource) {
  try {
    auditGeneratedSchemaKeywords(schemaSource.schema);
    if (
      !generatedSchemaMatches(
        value,
        schemaSource.schema,
        schemaSource.schema,
        new Map(),
      )
    ) {
      throw gateError("codex_protocol_schema_mismatch");
    }
    return materializeTransportValue(value);
  } catch (error) {
    if (error?.code === "codex_protocol_schema_mismatch") throw error;
    throw gateError("codex_protocol_schema_mismatch");
  }
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "definitions",
  "description",
  "enum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "properties",
  "required",
  "title",
  "type",
]);

function auditGeneratedSchemaKeywords(schema) {
  if (schema === true || schema === false) return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw gateError("codex_protocol_schema_mismatch");
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      throw gateError("codex_protocol_schema_mismatch");
    }
  }
  if (Object.hasOwn(schema, "format")) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      !INTEGER_FORMAT_RANGES.has(schema.format) ||
      !types.includes("integer")
    ) {
      throw gateError("codex_protocol_schema_mismatch");
    }
  }
  for (const group of [schema.properties, schema.definitions]) {
    for (const child of Object.values(group ?? {})) {
      auditGeneratedSchemaKeywords(child);
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    if (schema[key] !== undefined && typeof schema[key] === "object") {
      auditGeneratedSchemaKeywords(schema[key]);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const child of schema[key] ?? []) auditGeneratedSchemaKeywords(child);
  }
}

export async function loadEventSchemas(schemaDir) {
  try {
    const load = async name => {
      const raw = await readFile(join(schemaDir, "v2", name));
      const ast = parseLosslessJson(raw);
      return { ast, schema: schemaAstToValue(ast) };
    };
    return {
      threadStartParams: await load("ThreadStartParams.json"),
      turnStartParams: await load("TurnStartParams.json"),
      threadStartResponse: await load("ThreadStartResponse.json"),
      itemCompleted: await load("ItemCompletedNotification.json"),
      turnCompleted: await load("TurnCompletedNotification.json"),
    };
  } catch {
    throw gateError("codex_protocol_schema_mismatch");
  }
}

export class AppServerClient {
  constructor({
    command,
    cwd,
    env,
    eventsPath,
    deadline,
    spawnChild = spawn,
    supervisor,
    scheduleTimer = setTimeout,
    cancelTimer = clearTimeout,
  }) {
    if (typeof command !== "string" || command === "") {
      throw gateError("codex_app_server_spawn_failed");
    }
    this.eventsPath = eventsPath;
    this.supervisor = supervisor;
    this.scheduleTimer = scheduleTimer;
    this.cancelTimer = cancelTimer;
    this.messages = [];
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.stderrRetainedBytes = 0;
    this.stdoutLines = [];
    this.stderrChunks = [];
    this.failure = null;
    this.cleanupFailure = null;
    this.groupCleanupPromise = null;
    this.stopPromise = null;
    this.stopping = false;
    this.closed = false;
    this.deadline =
      deadline ??
      new ProcessDeadline(WATCHDOG_MS, () => performance.now(), () => {
        this.fail(gateError("codex_app_server_timeout"));
      });

    this.child = spawnChild(
      command,
      ["app-server", "--strict-config", "--stdio"],
      {
        cwd,
        detached: true,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.pid = this.child.pid;
    this.closedPromise = new Promise(resolve => {
      this.resolveClosed = resolve;
    });
    this.stdoutFramer = new RawJsonlFramer(line => {
      const frame = Buffer.concat([line, Buffer.from("\n")]);
      this.stdoutLines.push(frame);
      this.handleLine(line);
    });

    this.child.on("error", () => {
      this.fail(gateError("codex_app_server_spawn_failed"));
    });
    try {
      this.supervisor.ownProcessGroup(this.child, error => this.fail(error));
    } catch (error) {
      this.supervisor.adoptProcessGroupForCleanup(this.child);
      this.fail(error);
    }
    this.child.stdout.on("data", chunk => this.handleStdout(chunk));
    this.child.stderr.on("data", chunk => this.handleStderr(chunk));
    this.child.on("close", (code, signal) => {
      this.cancelTimer(this.processWatchdog);
      this.closed = true;
      this.resolveClosed({ code, signal });
      if (!this.failure && (!this.stopping || this.pending.size > 0)) {
        this.fail(
          gateError(
            "codex_app_server_exited",
            `code=${String(code)} signal=${String(signal)}`,
          ),
        );
      }
    });
    this.processWatchdog = this.scheduleTimer(() => {
      this.deadline.expire();
    }, this.deadline.remaining());
  }

  checkLimit() {
    if (this.stdoutBytes + this.stderrBytes > MAX_OUTPUT_BYTES) {
      this.fail(gateError("codex_output_limit"));
    }
  }

  handleStdout(chunk) {
    this.stdoutBytes += chunk.length;
    this.checkLimit();
    if (this.failure) return;
    try {
      this.stdoutFramer.push(chunk);
    } catch (error) {
      this.fail(error);
    }
  }

  handleStderr(chunk) {
    this.stderrBytes += chunk.length;
    if (!this.failure) {
      const remaining =
        MAX_OUTPUT_BYTES - this.stdoutBytes - this.stderrRetainedBytes;
      if (remaining > 0) {
        const retained =
          chunk.length <= remaining
            ? chunk
            : Buffer.from(chunk.subarray(0, remaining));
        this.stderrChunks.push(retained);
        this.stderrRetainedBytes += retained.length;
      }
    }
    this.checkLimit();
  }

  handleLine(line) {
    if (line.every(byte => [0x09, 0x0d, 0x20].includes(byte))) return;
    let message;
    try {
      message = parseAppServerMessage(line);
    } catch {
      this.fail(gateError("codex_event_json_invalid"));
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.fail(gateError("codex_event_shape_invalid"));
      return;
    }
    this.messages.push(message);

    if (Object.hasOwn(message, "id")) {
      if (typeof message.method === "string") {
        this.fail(gateError("codex_server_request", message.method));
        return;
      }
      let responseId;
      try {
        responseId = appServerResponseId(message.id);
      } catch (error) {
        this.fail(error);
        return;
      }
      const pending = this.pending.get(responseId);
      if (!pending) {
        this.fail(gateError("codex_response_id_unknown", String(responseId)));
        return;
      }
      this.pending.delete(responseId);
      this.cancelTimer(pending.watchdog);
      if (Object.hasOwn(message, "error")) {
        pending.reject(
          gateError("codex_response_error", JSON.stringify(message.error)),
        );
        return;
      }
      if (!Object.hasOwn(message, "result")) {
        pending.reject(gateError("codex_response_malformed"));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") {
      this.fail(gateError("codex_event_shape_invalid"));
      return;
    }
    if (message.method === "error") {
      this.fail(
        gateError("codex_error_notification", JSON.stringify(message.params)),
      );
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.#rejectPending(error);
    this.groupCleanupPromise ??= this.supervisor
      .terminateProcessGroup(this.pid, { graceful: false })
      .catch(cleanupError => {
        this.cleanupFailure = cleanupError;
      });
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      this.cancelTimer(pending.watchdog);
      pending.reject(error);
    }
    this.pending.clear();
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
  }

  request(method, params) {
    this.assertHealthy();
    const id = this.nextId;
    this.nextId += 1;
    const body = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const watchdog = this.scheduleTimer(() => {
        const error = gateError("codex_app_server_timeout", method);
        this.fail(error);
      }, this.deadline.remaining());
      this.pending.set(id, { resolve, reject, watchdog });
      this.child.stdin.write(body, error => {
        if (error) this.fail(gateError("codex_app_server_write_failed"));
      });
    });
  }

  notify(method) {
    this.assertHealthy();
    this.child.stdin.write(`${JSON.stringify({ method })}\n`, error => {
      if (error) this.fail(gateError("codex_app_server_write_failed"));
    });
  }

  async waitForNotification(method, predicate, startIndex) {
    while (true) {
      this.assertHealthy();
      for (let index = startIndex; index < this.messages.length; index += 1) {
        const message = this.messages[index];
        if (message.method === method && predicate(message.params)) {
          return { message, index };
        }
      }
      const remaining = this.deadline.remaining();
      await new Promise(resolve => {
        let timer;
        let fired = false;
        const finish = () => {
          fired = true;
          if (timer !== undefined) this.cancelTimer(timer);
          resolve();
        };
        timer = this.scheduleTimer(finish, Math.min(10, remaining));
        if (fired) this.cancelTimer(timer);
      });
    }
  }

  async stop() {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  async stopOnce() {
    if (this.pending.size > 0 && !this.failure) {
      this.fail(
        gateError(
          "codex_app_server_exited",
          `stopped with pending requests=${this.pending.size}`,
        ),
      );
    }
    if (!this.stopping) {
      this.stopping = true;
      this.cancelTimer(this.processWatchdog);
      this.child.stdin.end();
    }
    let gracefulWaitMs = 0;
    try {
      gracefulWaitMs = Math.min(1_000, this.deadline.remaining());
    } catch {
      gracefulWaitMs = 0;
    }
    if (!this.closed && gracefulWaitMs > 0) {
      await new Promise(resolve => {
        let settled = false;
        let gracefulTimer;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (gracefulTimer !== undefined) {
            this.cancelTimer(gracefulTimer);
          }
          resolve();
        };
        gracefulTimer = this.scheduleTimer(finish, gracefulWaitMs);
        if (settled) this.cancelTimer(gracefulTimer);
        this.closedPromise.then(finish);
      });
    }
    this.groupCleanupPromise ??= this.supervisor
      .terminateProcessGroup(this.pid, { graceful: this.closed })
      .catch(cleanupError => {
        this.cleanupFailure = cleanupError;
      });
    await this.groupCleanupPromise;
    if (!this.closed) {
      await this.supervisor.withDeadline(
        this.closedPromise,
        this.supervisor.now() + CLEANUP_DRAIN_GRACE_MS,
        "codex_app_server_close_timeout",
      );
    }
    try {
      this.stdoutFramer.finish();
    } catch (error) {
      this.fail(error);
    }
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.failure) throw this.failure;
  }

  async storeEvents() {
    this.checkLimit();
    await writeFile(this.eventsPath, Buffer.concat(this.stdoutLines), {
      mode: 0o600,
    });
  }

  stderr() {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }
}

export function extractTurnAgentMessageText({ turn, messages }, { threadId, turnId }) {
  if (
    turn.id !== turnId ||
    turn.status !== "completed" ||
    turn.error !== null ||
    !["notLoaded", "summary", "full"].includes(turn.itemsView)
  ) {
    throw gateError("model_protocol_error");
  }
  const agentMessages = messages.filter(
    message =>
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage",
  );
  if (agentMessages.length !== 1) {
    throw gateError("model_protocol_error");
  }
  const event = agentMessages[0];
  if (
    event.params.threadId !== threadId ||
    event.params.turnId !== turnId ||
    typeof event.params.item.id !== "string" ||
    typeof event.params.item.text !== "string"
  ) {
    throw gateError("model_protocol_error");
  }
  return event.params.item.text;
}

export function runUnloadedTurnRegression(eventSchemas) {
  const wrappedFinal = {
    decision: { version: 1, type: "final", output: "gate-complete" },
  };
  const turnCompletedParams = {
    threadId: "thread-gate-1",
    turn: {
      id: "01985f6d-9c40-7000-8000-000000000001",
      status: "completed",
      items: [],
      itemsView: "notLoaded",
      startedAt: 1750000000,
      completedAt: 1750000001,
      durationMs: 1000,
      error: null,
    },
  };
  const unloadedTurnResult = {
    turn: turnCompletedParams.turn,
    messages: [
      {
        method: "item/completed",
        params: {
          threadId: "thread-gate-1",
          turnId: "01985f6d-9c40-7000-8000-000000000001",
          completedAtMs: 1750000001000,
          item: {
            id: "agent-message-gate-1",
            type: "agentMessage",
            text: JSON.stringify(wrappedFinal),
          },
        },
      },
    ],
  };
  assertGeneratedSchemaValue(
    unloadedTurnResult.messages[0].params,
    eventSchemas.itemCompleted,
  );
  assertGeneratedSchemaValue(turnCompletedParams, eventSchemas.turnCompleted);
  assert.deepEqual(
    extractTurnAgentMessageText(unloadedTurnResult, {
      threadId: "thread-gate-1",
      turnId: "01985f6d-9c40-7000-8000-000000000001",
    }),
    JSON.stringify(wrappedFinal),
  );
  assert.equal(unloadedTurnResult.turn.durationMs, 1000);
  assert.equal(
    (unloadedTurnResult.turn.completedAt - unloadedTurnResult.turn.startedAt) *
      1000,
    unloadedTurnResult.turn.durationMs,
  );
  assert.equal(
    unloadedTurnResult.messages[0].params.completedAtMs,
    unloadedTurnResult.turn.completedAt * 1000,
  );
}

function auditTurnEvents(turn, messages, { threadId, turnId }) {
  if (
    turn.id !== turnId ||
    turn.status !== "completed" ||
    turn.error !== null ||
    !["notLoaded", "summary", "full"].includes(turn.itemsView)
  ) {
    throw gateError("model_protocol_error");
  }
  let completedAgentMessages = 0;
  for (const message of messages) {
    const method = message.method;
    if (typeof method !== "string") continue;
    if (
      (Object.hasOwn(message.params ?? {}, "threadId") &&
        message.params.threadId !== threadId) ||
      (Object.hasOwn(message.params ?? {}, "turnId") &&
        message.params.turnId !== turnId) ||
      ((method === "turn/started" || method === "turn/completed") &&
        message.params?.turn?.id !== turnId)
    ) {
      throw gateError("model_protocol_error");
    }
    if (FORBIDDEN_EVENT_PATTERN.test(method)) {
      throw gateError("codex_forbidden_event", method);
    }
    if (method !== "item/started" && method !== "item/completed") continue;
    const item = message.params?.item;
    if (
      message.params?.threadId !== threadId ||
      message.params?.turnId !== turnId ||
      typeof item?.id !== "string" ||
      !ALLOWED_ITEM_TYPES.has(item.type)
    ) {
      throw gateError("codex_forbidden_item", String(item?.type));
    }
    if (method === "item/completed" && item.type === "agentMessage") {
      completedAgentMessages += 1;
    }
  }
  if (completedAgentMessages !== 1) {
    throw gateError(
      "codex_agent_message_count",
      String(completedAgentMessages),
    );
  }
}

export function assertNoLateTurnMessages(allMessages, result, { threadId, turnId }) {
  const completedIndex = allMessages.findIndex(
    message =>
      message.method === "turn/completed" &&
      message.params?.threadId === threadId &&
      message.params?.turn === result.turn,
  );
  if (completedIndex < 0) throw gateError("model_protocol_error");
  for (const message of allMessages.slice(completedIndex + 1)) {
    if (
      message.params?.turnId === turnId ||
      message.params?.turn?.id === turnId
    ) {
      throw gateError("model_protocol_error");
    }
  }
}

export function auditAllAppServerEvents(messages, knownTurns) {
  const turns = new Map(
    knownTurns.map(turn => [`${turn.threadId}\0${turn.turnId}`, turn]),
  );
  const knownThreadIds = new Set(knownTurns.map(turn => turn.threadId));
  const turnsById = new Map();
  for (const turn of knownTurns) {
    const matches = turnsById.get(turn.turnId) ?? [];
    matches.push(turn);
    turnsById.set(turn.turnId, matches);
  }
  for (const turn of knownTurns) {
    const completed = messages[turn.completedIndex];
    if (
      completed?.method !== "turn/completed" ||
      completed.params?.threadId !== turn.threadId ||
      completed.params?.turn?.id !== turn.turnId
    ) {
      throw gateError("model_protocol_error");
    }
  }
  let tools = 0;
  let approvals = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (typeof message.method !== "string") continue;
    const params = message.params;
    const hasThreadId = Object.hasOwn(params ?? {}, "threadId");
    const hasNestedThreadId = Object.hasOwn(params?.thread ?? {}, "id");
    const hasTurnId = Object.hasOwn(params ?? {}, "turnId");
    const hasNestedTurnId = Object.hasOwn(params?.turn ?? {}, "id");
    if (
      message.method.startsWith("turn/") &&
      !hasTurnId &&
      !hasNestedTurnId
    ) {
      throw gateError("model_protocol_error");
    }
    let threadId;
    if (hasThreadId || hasNestedThreadId) {
      const directThreadId = hasThreadId ? params.threadId : undefined;
      const nestedThreadId = hasNestedThreadId ? params.thread.id : undefined;
      if (
        (hasThreadId && typeof directThreadId !== "string") ||
        (hasNestedThreadId && typeof nestedThreadId !== "string") ||
        (hasThreadId &&
          hasNestedThreadId &&
          directThreadId !== nestedThreadId)
      ) {
        throw gateError("model_protocol_error");
      }
      threadId = directThreadId ?? nestedThreadId;
      if (!knownThreadIds.has(threadId)) {
        throw gateError("model_protocol_error");
      }
    }
    if (hasTurnId || hasNestedTurnId) {
      const directTurnId = hasTurnId ? params.turnId : undefined;
      const nestedTurnId = hasNestedTurnId ? params.turn.id : undefined;
      if (
        (hasTurnId && typeof directTurnId !== "string") ||
        (hasNestedTurnId && typeof nestedTurnId !== "string") ||
        (hasTurnId && hasNestedTurnId && directTurnId !== nestedTurnId)
      ) {
        throw gateError("model_protocol_error");
      }
      const turnId = directTurnId ?? nestedTurnId;
      const matches = threadId !== undefined
        ? [turns.get(`${threadId}\0${turnId}`)].filter(Boolean)
        : (turnsById.get(turnId) ?? []);
      if (matches.length !== 1 || index > matches[0].completedIndex) {
        throw gateError("model_protocol_error");
      }
    }
    if (/approval/i.test(message.method)) {
      approvals += 1;
      throw gateError("codex_forbidden_event", message.method);
    }
    if (message.method.startsWith("item/")) {
      const key = `${message.params?.threadId}\0${message.params?.turnId}`;
      const turn = turns.get(key);
      if (!turn || index > turn.completedIndex) {
        throw gateError("model_protocol_error");
      }
      const itemType = message.params?.item?.type;
      if (
        typeof itemType === "string" &&
        /command|fileChange|mcpToolCall|dynamicToolCall|browser|computer|webSearch|image|app|plugin|shell|collab/i.test(
          itemType,
        )
      ) {
        tools += 1;
        throw gateError("codex_forbidden_event", itemType);
      }
    }
    if (FORBIDDEN_EVENT_PATTERN.test(message.method)) {
      throw gateError("codex_forbidden_event", message.method);
    }
  }
  return { tools, approvals };
}

function turnInput(text) {
  return [{ type: "text", text }];
}

export async function startTurn(
  client,
  threadId,
  prompt,
  eventSchemas,
  outputSchema,
) {
  const startIndex = client.messages.length;
  const params = {
    threadId,
    input: turnInput(prompt),
    environments: [],
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    model: MODEL,
    effort: EFFORT,
    outputSchema,
  };
  assertGeneratedSchemaValue(params, eventSchemas.turnStartParams);
  const response = await client.request("turn/start", params);
  if (!response?.turn?.id) throw gateError("codex_turn_start_malformed");
  const turnId = response.turn.id;
  const completed = await client.waitForNotification(
    "turn/completed",
    params => params?.threadId === threadId && params?.turn?.id === turnId,
    startIndex,
  );
  if (
    completed.message.params.threadId !== threadId ||
    completed.message.params.turn?.id !== turnId
  ) {
    throw gateError("codex_turn_identity_mismatch");
  }
  completed.message.params = assertGeneratedSchemaValue(
    completed.message.params,
    eventSchemas.turnCompleted,
  );
  const messages = client.messages
    .slice(startIndex, completed.index + 1)
    .filter(message => typeof message.method === "string");
  for (const message of messages) {
    if (message.method === "item/completed") {
      message.params = assertGeneratedSchemaValue(
        message.params,
        eventSchemas.itemCompleted,
      );
    }
  }
  const result = { turn: completed.message.params.turn, messages };
  auditTurnEvents(result.turn, result.messages, { threadId, turnId });
  return result;
}

export async function runProtocolHardeningSelfTest({
  silent = false,
} = {}) {
  assert.throws(
    () =>
      schemaAstToValue(
        parseLosslessJson(Buffer.from('{"maxLength":1.5}', "utf8")),
      ),
    /codex_protocol_schema_mismatch/,
  );
  assert.throws(
    () =>
      schemaAstToValue(
        parseLosslessJson(Buffer.from('{"minimum":0.1}', "utf8")),
      ),
    /codex_protocol_schema_mismatch/,
  );
  assert.throws(
    () =>
      schemaAstToValue(
        parseLosslessJson(
          Buffer.from('{"maximum":9007199254740993}', "utf8"),
        ),
      ),
    /codex_protocol_schema_mismatch/,
  );
  assert.throws(
    () =>
      assertGeneratedSchemaValue("abc", {
        schema: { type: "string", pattern: "^a" },
      }),
    /codex_protocol_schema_mismatch/,
  );
  assert.throws(
    () =>
      assertGeneratedSchemaValue({}, {
        schema: {
          type: "object",
          required: ["threadId"],
          properties: { threadId: { type: "string" } },
        },
      }),
    /codex_protocol_schema_mismatch/,
  );
  const integerFormatCases = [
    ["uint", 0, Number.MAX_SAFE_INTEGER, -1, Number.MAX_SAFE_INTEGER + 1],
    ["uint16", 0, 65_535, -1, 65_536],
    ["uint32", 0, 4_294_967_295, -1, 4_294_967_296],
    ["uint64", 0, Number.MAX_SAFE_INTEGER, -1, Number.MAX_SAFE_INTEGER + 1],
    [
      "int32",
      -2_147_483_648,
      2_147_483_647,
      -2_147_483_649,
      2_147_483_648,
    ],
    [
      "int64",
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER + 1,
    ],
  ];
  for (const [
    format,
    minimum,
    maximum,
    underflow,
    overflow,
  ] of integerFormatCases) {
    const schemaSource = { schema: { type: "integer", format } };
    assert.doesNotThrow(() =>
      assertGeneratedSchemaValue(minimum, schemaSource),
    );
    assert.doesNotThrow(() =>
      assertGeneratedSchemaValue(maximum, schemaSource),
    );
    assert.throws(
      () => assertGeneratedSchemaValue(underflow, schemaSource),
      /codex_protocol_schema_mismatch/,
    );
    assert.throws(
      () => assertGeneratedSchemaValue(overflow, schemaSource),
      /codex_protocol_schema_mismatch/,
    );
  }
  assert.throws(
    () =>
      assertGeneratedSchemaValue(Number.MAX_SAFE_INTEGER + 1, {
        schema: { type: "integer", format: "uint64" },
      }),
    /codex_protocol_schema_mismatch/,
  );
  assert.throws(
    () =>
      auditGeneratedSchemaKeywords({ type: "integer", format: "int128" }),
    /codex_protocol_schema_mismatch/,
  );
  assert.doesNotThrow(() =>
    assertGeneratedSchemaValue("😀", {
      schema: { type: "string", maxLength: 1 },
    }),
  );
  assert.throws(
    () =>
      assertGeneratedSchemaValue("😀", {
        schema: { type: "string", minLength: 2 },
      }),
    /codex_protocol_schema_mismatch/,
  );
  const selfRecursiveSchema = {
    schema: {
      $ref: "#/definitions/Node",
      definitions: { Node: { $ref: "#/definitions/Node" } },
    },
  };
  assert.throws(
    () => assertGeneratedSchemaValue({}, selfRecursiveSchema),
    error =>
      !(error instanceof RangeError) &&
      error?.code === "codex_protocol_schema_mismatch",
  );
  const mutualRecursiveSchema = {
    schema: {
      $ref: "#/definitions/Left",
      definitions: {
        Left: { $ref: "#/definitions/Right" },
        Right: { $ref: "#/definitions/Left" },
      },
    },
  };
  assert.throws(
    () => assertGeneratedSchemaValue({}, mutualRecursiveSchema),
    error =>
      !(error instanceof RangeError) &&
      error?.code === "codex_protocol_schema_mismatch",
  );
  const finiteRecursiveSchema = {
    schema: {
      $ref: "#/definitions/Node",
      definitions: {
        Node: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["next"],
              properties: { next: { $ref: "#/definitions/Node" } },
              additionalProperties: false,
            },
          ],
        },
      },
    },
  };
  const recursiveValue = depth => {
    let value = null;
    for (let index = 0; index < depth; index += 1) value = { next: value };
    return value;
  };
  assert.deepEqual(
    assertGeneratedSchemaValue(recursiveValue(32), finiteRecursiveSchema),
    recursiveValue(32),
  );
  assert.deepEqual(
    assertGeneratedSchemaValue(recursiveValue(300), finiteRecursiveSchema),
    recursiveValue(300),
  );
  const sharedRecursiveValue = recursiveValue(8);
  const siblingRecursiveSchema = {
    schema: {
      type: "object",
      required: ["left", "right"],
      properties: {
        left: { $ref: "#/definitions/Node" },
        right: { $ref: "#/definitions/Node" },
      },
      additionalProperties: false,
      definitions: finiteRecursiveSchema.schema.definitions,
    },
  };
  assert.deepEqual(
    assertGeneratedSchemaValue(
      { left: sharedRecursiveValue, right: sharedRecursiveValue },
      siblingRecursiveSchema,
    ),
    { left: sharedRecursiveValue, right: sharedRecursiveValue },
  );
  assert.throws(
    () =>
      assertGeneratedSchemaValue(
        recursiveValue(10_000),
        finiteRecursiveSchema,
      ),
    error =>
      !(error instanceof RangeError) &&
      error?.code === "codex_protocol_schema_mismatch",
  );
  const knownTurns = [
    { threadId: "thread-audit", turnId: "turn-audit", completedIndex: 1 },
  ];
  const cleanAudit = [
    {
      method: "item/completed",
      params: {
        threadId: "thread-audit",
        turnId: "turn-audit",
        item: { id: "agent-audit", type: "agentMessage", text: "{}" },
      },
    },
    {
      method: "turn/completed",
      params: { threadId: "thread-audit", turn: { id: "turn-audit" } },
    },
  ];
  assert.deepEqual(auditAllAppServerEvents(cleanAudit, knownTurns), {
    tools: 0,
    approvals: 0,
  });
  assert.throws(
    () => auditAllAppServerEvents(cleanAudit.toReversed(), knownTurns),
    /model_protocol_error/,
  );
  const crossTurn = structuredClone(cleanAudit);
  crossTurn[0].params.turnId = "turn-unknown";
  assert.throws(
    () => auditAllAppServerEvents(crossTurn, knownTurns),
    /model_protocol_error/,
  );
  const toolEvent = structuredClone(cleanAudit);
  toolEvent[0].params.item.type = "mcpToolCall";
  assert.throws(
    () => auditAllAppServerEvents(toolEvent, knownTurns),
    /codex_forbidden_event/,
  );
  const approvalEvent = structuredClone(cleanAudit);
  approvalEvent[0].method = "item/commandExecution/requestApproval";
  assert.throws(
    () => auditAllAppServerEvents(approvalEvent, knownTurns),
    /codex_forbidden_event/,
  );
  const twoKnownTurns = [
    { threadId: "thread-audit", turnId: "turn-audit", completedIndex: 1 },
    { threadId: "thread-other", turnId: "turn-other", completedIndex: 3 },
  ];
  const twoCleanTurns = [
    ...structuredClone(cleanAudit),
    {
      method: "turn/progress",
      params: { threadId: "thread-other", turnId: "turn-other" },
    },
    {
      method: "turn/completed",
      params: { threadId: "thread-other", turn: { id: "turn-other" } },
    },
    { method: "account/updated", params: {} },
    {
      method: "thread/started",
      params: { thread: { id: "thread-other" } },
    },
  ];
  assert.deepEqual(auditAllAppServerEvents(twoCleanTurns, twoKnownTurns), {
    tools: 0,
    approvals: 0,
  });
  const nonItemCrossThread = structuredClone(twoCleanTurns);
  nonItemCrossThread[2].params.threadId = "thread-unknown";
  assert.throws(
    () => auditAllAppServerEvents(nonItemCrossThread, twoKnownTurns),
    /model_protocol_error/,
  );
  const nonItemCrossTurn = structuredClone(twoCleanTurns);
  nonItemCrossTurn[2].params.threadId = "thread-audit";
  assert.throws(
    () => auditAllAppServerEvents(nonItemCrossTurn, twoKnownTurns),
    /model_protocol_error/,
  );
  const nonItemUnknownTurn = structuredClone(twoCleanTurns);
  nonItemUnknownTurn[2].params.turnId = "turn-unknown";
  assert.throws(
    () => auditAllAppServerEvents(nonItemUnknownTurn, twoKnownTurns),
    /model_protocol_error/,
  );
  const postTerminal = structuredClone(twoCleanTurns);
  postTerminal.push({
    method: "turn/progress",
    params: { threadId: "thread-other", turn: { id: "turn-other" } },
  });
  assert.throws(
    () => auditAllAppServerEvents(postTerminal, twoKnownTurns),
    /model_protocol_error/,
  );
  const preterminalMissingTurnId = [
    {
      method: "turn/progress",
      params: { threadId: "thread-audit" },
    },
    ...structuredClone(cleanAudit),
  ];
  assert.throws(
    () =>
      auditAllAppServerEvents(preterminalMissingTurnId, [
        {
          threadId: "thread-audit",
          turnId: "turn-audit",
          completedIndex: 2,
        },
      ]),
    /model_protocol_error/,
  );
  const postTerminalMissingTurnId = structuredClone(cleanAudit);
  postTerminalMissingTurnId.push({
    method: "turn/progress",
    params: { threadId: "thread-audit" },
  });
  assert.throws(
    () => auditAllAppServerEvents(postTerminalMissingTurnId, knownTurns),
    /model_protocol_error/,
  );
  const unknownNestedThread = structuredClone(twoCleanTurns);
  unknownNestedThread[5].params.thread.id = "thread-unknown";
  assert.throws(
    () => auditAllAppServerEvents(unknownNestedThread, twoKnownTurns),
    /model_protocol_error/,
  );
  const conflictingNestedThread = structuredClone(twoCleanTurns);
  conflictingNestedThread[5].params.threadId = "thread-audit";
  assert.throws(
    () => auditAllAppServerEvents(conflictingNestedThread, twoKnownTurns),
    /model_protocol_error/,
  );
  const injectedOutputSchema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const completedParams = {
    threadId: "thread-start",
    turn: {
      id: "turn-start",
      status: "completed",
      error: null,
      itemsView: "notLoaded",
    },
  };
  const completedItemParams = {
    threadId: "thread-start",
    turnId: "turn-start",
    item: { id: "agent-start", type: "agentMessage", text: "{}" },
  };
  const startEventSchemas = {
    turnStartParams: {
      schema: {
        type: "object",
        required: ["outputSchema"],
        properties: { outputSchema: { const: injectedOutputSchema } },
      },
    },
    turnCompleted: {
      schema: {
        type: "object",
        required: ["threadId", "turn"],
        properties: {
          threadId: { const: "thread-start" },
          turn: { type: "object" },
        },
      },
    },
    itemCompleted: {
      schema: {
        type: "object",
        required: ["threadId", "turnId", "item"],
        properties: {
          threadId: { const: "thread-start" },
          turnId: { const: "turn-start" },
          item: { type: "object" },
        },
      },
    },
  };
  let requestedParams;
  const startClient = {
    messages: [],
    async request(method, params) {
      assert.equal(method, "turn/start");
      requestedParams = params;
      return { turn: { id: "turn-start" } };
    },
    async waitForNotification(method, predicate, startIndex) {
      assert.equal(method, "turn/completed");
      assert.equal(startIndex, 0);
      const item = { method: "item/completed", params: completedItemParams };
      const completed = { method, params: completedParams };
      this.messages.push(item, completed);
      assert.equal(predicate(completed.params), true);
      return { message: completed, index: 1 };
    },
  };
  const startedTurn = await startTurn(
    startClient,
    "thread-start",
    "prompt",
    startEventSchemas,
    injectedOutputSchema,
  );
  assert.equal(requestedParams.outputSchema, injectedOutputSchema);
  assert.equal(startedTurn.turn.id, "turn-start");
  await assert.rejects(
    startTurn(
      { ...startClient, messages: [] },
      "thread-start",
      "prompt",
      { ...startEventSchemas, turnStartParams: { schema: false } },
      injectedOutputSchema,
    ),
    /codex_protocol_schema_mismatch/,
  );
  await assert.rejects(
    startTurn(
      {
        ...startClient,
        messages: [],
        async request() {
          return { turn: {} };
        },
      },
      "thread-start",
      "prompt",
      startEventSchemas,
      injectedOutputSchema,
    ),
    /codex_turn_start_malformed/,
  );
  await assert.rejects(
    startTurn(
      { ...startClient, messages: [] },
      "thread-start",
      "prompt",
      { ...startEventSchemas, turnCompleted: { schema: false } },
      injectedOutputSchema,
    ),
    /codex_protocol_schema_mismatch/,
  );
  await assert.rejects(
    startTurn(
      { ...startClient, messages: [] },
      "thread-start",
      "prompt",
      { ...startEventSchemas, itemCompleted: { schema: false } },
      injectedOutputSchema,
    ),
    /codex_protocol_schema_mismatch/,
  );
  if (!silent) process.stdout.write("codex_browser_format_hardening: PASS\n");
}

export async function runTransportSelfTest({ silent = false } = {}) {
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"method":"', "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}', "utf8"),
  ]);
  assert.throws(
    () => parseAppServerMessage(invalidUtf8),
    /codex_event_json_invalid/,
  );
  const fractionalValue = parseAppServerMessage(
    Buffer.from('{"method":"progress","params":{"value":0.1}}'),
  ).params.value;
  assert.equal(
    assertGeneratedSchemaValue(fractionalValue, {
      schema: { type: "number" },
    }),
    0.1,
  );
  for (const raw of [
    "9007199254740991.5",
    "9007199254740990.5",
    "0.100000000000000005",
  ]) {
    const value = parseAppServerMessage(
      Buffer.from(`{"method":"progress","params":{"value":${raw}}}`),
    ).params.value;
    assert.throws(
      () =>
        assertGeneratedSchemaValue(value, { schema: { type: "number" } }),
      /codex_protocol_schema_mismatch/,
    );
  }
  const exactIntegerValue = parseAppServerMessage(
    Buffer.from('{"method":"progress","params":{"value":1.000e0}}'),
  ).params.value;
  assert.equal(
    assertGeneratedSchemaValue(exactIntegerValue, {
      schema: { type: "integer", format: "uint16" },
    }),
    1,
  );
  for (const [raw, schema] of [
    ["1.00000000000000000001", { type: "integer" }],
    [
      "65535.00000000000000000001",
      { type: "integer", format: "uint16" },
    ],
    ["0.99999999999999999999", { type: "number", minimum: 1 }],
    ["1.00000000000000000001", { type: "number", maximum: 1 }],
    ["1.00000000000000000001", { type: "number", enum: [1] }],
    ["1.00000000000000000001", { type: "number", const: 1 }],
    ["1", { enum: [{}] }],
    ["1", { const: {} }],
  ]) {
    const value = parseAppServerMessage(
      Buffer.from(`{"method":"progress","params":{"value":${raw}}}`),
    ).params.value;
    assert.throws(
      () => assertGeneratedSchemaValue(value, { schema }),
      /codex_protocol_schema_mismatch/,
    );
  }
  assert.equal(
    parseAppServerMessage(
      Buffer.from('{"method":"replacement","params":{"value":"�"}}'),
    ).params.value,
    "�",
  );
  assert.throws(
    () =>
      parseAppServerMessage(
        Buffer.from(
          String.raw`{"method":"turn/started","\u006dethod":"turn/completed","params":{}}`,
          "utf8",
        ),
      ),
    /codex_event_json_invalid/,
  );
  assert.throws(
    () =>
      parseAppServerMessage(
        Buffer.from('{"id":1,"result":{},"result":{"duplicate":true}}'),
      ),
    /codex_event_json_invalid/,
  );
  for (const raw of ["1", "1.0", "1e0"]) {
    assert.equal(
      appServerResponseId(
        parseAppServerMessage(Buffer.from(`{"id":${raw}}`)).id,
      ),
      1,
    );
  }
  for (const raw of [
    "1.00000000000000000001",
    "9007199254740992",
    "-9007199254740992",
  ]) {
    assert.throws(
      () =>
        appServerResponseId(
          parseAppServerMessage(Buffer.from(`{"id":${raw}}`)).id,
        ),
      /codex_response_id_invalid/,
    );
  }

  const lines = [];
  const framer = new RawJsonlFramer(line => lines.push(line));
  const encoded = Buffer.from('{"method":"😀"}\n', "utf8");
  const split = encoded.indexOf(0xf0) + 2;
  framer.push(encoded.subarray(0, split));
  framer.push(encoded.subarray(split));
  framer.finish();
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], encoded.subarray(0, -1));

  const child = new EventEmitter();
  child.pid = 601;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end() {}, write() {} };
  let groupAlive = true;
  const supervisor = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -601);
      if (signal === 0) {
        if (!groupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      groupAlive = false;
    },
  });
  let spawnArguments;
  const client = new AppServerClient({
    command: "/selected/codex",
    cwd: "/gate",
    env: {},
    eventsPath: "/gate/events",
    spawnChild: (command, args) => {
      spawnArguments = [command, args];
      return child;
    },
    supervisor,
    scheduleTimer: () => 1,
    cancelTimer() {},
  });
  assert.deepEqual(spawnArguments, [
    "/selected/codex",
    ["app-server", "--strict-config", "--stdio"],
  ]);
  const rawFrame = Buffer.from(
    '{"method":"thread/started","params":{"threadId":"thread-raw"}}\n',
  );
  child.stdout.emit("data", rawFrame.subarray(0, 7));
  child.stdout.emit("data", rawFrame.subarray(7));
  assert.equal(client.messages[0].method, "thread/started");
  assert.deepEqual(Buffer.concat(client.stdoutLines), rawFrame);

  const exactIdRequest = client.request("exact-id", {});
  child.stdout.emit(
    "data",
    Buffer.from('{"id":1.00000000000000000000,"result":{"ok":true}}\n'),
  );
  assert.deepEqual(await exactIdRequest, { ok: true });

  const fractionalIdRequest = client.request("fractional-id", {});
  child.stdout.emit(
    "data",
    Buffer.from('{"id":2.00000000000000000001,"result":{"ok":true}}\n'),
  );
  await assert.rejects(
    fractionalIdRequest,
    /codex_response_id_invalid/,
  );
  assert.equal(client.pending.size, 0);
  client.stopping = true;
  child.emit("close", 0, null);
  client.stopping = false;
  await assert.rejects(client.stop(), /codex_response_id_invalid/);
  assert.equal(groupAlive, false);

  const appServerChild = pid => {
    const fake = new EventEmitter();
    fake.pid = pid;
    fake.stdout = new PassThrough();
    fake.stderr = new PassThrough();
    fake.stdin = {
      ended: false,
      end() {
        this.ended = true;
      },
      write() {},
    };
    return fake;
  };
  const sensitiveCommand =
    "/home/gate-user/.local/share/codex/0.144.6/bin/codex";
  const spawnErrorChild = appServerChild(608);
  let spawnErrorGroupAlive = true;
  const spawnErrorRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -608);
      if (signal === 0) {
        if (!spawnErrorGroupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      spawnErrorGroupAlive = false;
    },
  });
  const spawnErrorClient = new AppServerClient({
    command: sensitiveCommand,
    cwd: "/tmp/codex-browser-gate-secret/work",
    env: { CODEX_HOME: "/home/gate-user/.codex" },
    eventsPath: "/tmp/codex-browser-gate-secret/events",
    spawnChild: () => spawnErrorChild,
    supervisor: spawnErrorRegistry,
    scheduleTimer: () => 1,
    cancelTimer() {},
  });
  spawnErrorChild.emit(
    "error",
    new Error(
      `spawn ${sensitiveCommand} from ` +
        "/home/gate-user/.codex and /tmp/codex-browser-gate-secret",
    ),
  );
  spawnErrorChild.stdout.end();
  spawnErrorChild.stderr.end();
  spawnErrorChild.emit("close", null, null);
  await assert.rejects(
    spawnErrorClient.stop(),
    error =>
      error?.code === "codex_app_server_spawn_failed" &&
      error.message === "codex_app_server_spawn_failed" &&
      !error.message.includes(sensitiveCommand) &&
      !error.message.includes("/home/gate-user") &&
      !error.message.includes("/tmp/codex-browser-gate-secret"),
  );
  assert.equal(spawnErrorGroupAlive, false);
  const signalListenerCounts = ["SIGINT", "SIGTERM", "SIGHUP"].map(
    signal => process.listenerCount(signal),
  );

  const boundedChild = appServerChild(604);
  let boundedGroupAlive = true;
  const boundedRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -604);
      if (signal === 0) {
        if (!boundedGroupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      boundedGroupAlive = false;
    },
  });
  const boundedTimers = new Set();
  const boundedClient = new AppServerClient({
    command: "/selected/codex",
    cwd: "/gate",
    env: {},
    eventsPath: "/gate/events-bounded",
    spawnChild: () => boundedChild,
    supervisor: boundedRegistry,
    scheduleTimer() {
      const handle = Symbol("bounded-watchdog");
      boundedTimers.add(handle);
      return handle;
    },
    cancelTimer(handle) {
      boundedTimers.delete(handle);
    },
  });
  boundedChild.stderr.emit("data", Buffer.alloc(MAX_OUTPUT_BYTES + 1));
  boundedChild.stderr.emit("data", Buffer.alloc(4_096));
  const boundedRetainedBytes =
    Buffer.concat(boundedClient.stdoutLines).length +
    Buffer.concat(boundedClient.stderrChunks).length;
  assert.equal(boundedClient.stderrBytes, MAX_OUTPUT_BYTES + 4_097);
  assert.equal(boundedRetainedBytes <= MAX_OUTPUT_BYTES, true);
  assert.equal(boundedClient.failure?.code, "codex_output_limit");
  boundedChild.stdout.end();
  boundedChild.stderr.end();
  boundedChild.emit("close", null, "SIGKILL");
  await assert.rejects(
    boundedClient.stop(),
    /codex_output_limit/,
  );
  assert.equal(boundedGroupAlive, false);
  assert.deepEqual(boundedTimers, new Set());

  const pendingStopChild = appServerChild(605);
  let pendingStopGroupAlive = true;
  const pendingStopRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -605);
      if (signal === 0) {
        if (!pendingStopGroupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      pendingStopGroupAlive = false;
    },
  });
  const pendingStopTimers = new Set();
  const pendingStopClient = new AppServerClient({
    command: "/selected/codex",
    cwd: "/gate",
    env: {},
    eventsPath: "/gate/events-pending-stop",
    deadline: new ProcessDeadline(10, () => 0),
    spawnChild: () => pendingStopChild,
    supervisor: pendingStopRegistry,
    scheduleTimer() {
      const handle = Symbol("pending-stop-timer");
      pendingStopTimers.add(handle);
      return handle;
    },
    cancelTimer(handle) {
      pendingStopTimers.delete(handle);
    },
  });
  const pendingStopRequest = pendingStopClient.request("pending-stop", {});
  const pendingStopRejection = assert.rejects(
    pendingStopRequest,
    /codex_app_server_exited/,
  );
  const pendingStop = pendingStopClient.stop();
  queueMicrotask(() => {
    pendingStopChild.stdout.end();
    pendingStopChild.stderr.end();
    pendingStopChild.emit("close", null, "SIGKILL");
  });
  await pendingStopRejection;
  await assert.rejects(pendingStop, /codex_app_server_exited/);
  assert.equal(pendingStopClient.pending.size, 0);
  assert.equal(pendingStopGroupAlive, false);
  assert.deepEqual(pendingStopTimers, new Set());

  const closePendingChild = appServerChild(606);
  let closePendingGroupAlive = true;
  const closePendingRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -606);
      if (signal === 0) {
        if (!closePendingGroupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      closePendingGroupAlive = false;
    },
  });
  const closePendingTimers = new Set();
  const closePendingClient = new AppServerClient({
    command: "/selected/codex",
    cwd: "/gate",
    env: {},
    eventsPath: "/gate/events-close-pending",
    deadline: new ProcessDeadline(10, () => 0),
    spawnChild: () => closePendingChild,
    supervisor: closePendingRegistry,
    scheduleTimer() {
      const handle = Symbol("close-pending-timer");
      closePendingTimers.add(handle);
      return handle;
    },
    cancelTimer(handle) {
      closePendingTimers.delete(handle);
    },
  });
  const closePendingStop = closePendingClient.stop();
  const closePendingRequest = closePendingClient.request(
    "close-during-stop",
    {},
  );
  const closePendingRejection = assert.rejects(
    closePendingRequest,
    /codex_app_server_exited/,
  );
  closePendingChild.stdout.end();
  closePendingChild.stderr.end();
  closePendingChild.emit("close", 0, null);
  await closePendingRejection;
  await assert.rejects(closePendingStop, /codex_app_server_exited/);
  assert.equal(closePendingClient.pending.size, 0);
  assert.equal(closePendingGroupAlive, false);
  assert.deepEqual(closePendingTimers, new Set());

  const cleanStopChild = appServerChild(607);
  let cleanStopGroupAlive = true;
  const cleanStopRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -607);
      if (signal === 0) {
        if (!cleanStopGroupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      cleanStopGroupAlive = false;
    },
  });
  const cleanStopTimers = new Set();
  const cleanStopClient = new AppServerClient({
    command: "/selected/codex",
    cwd: "/gate",
    env: {},
    eventsPath: "/gate/events-clean-stop",
    deadline: new ProcessDeadline(10, () => 0),
    spawnChild: () => cleanStopChild,
    supervisor: cleanStopRegistry,
    scheduleTimer() {
      const handle = Symbol("clean-stop-timer");
      cleanStopTimers.add(handle);
      return handle;
    },
    cancelTimer(handle) {
      cleanStopTimers.delete(handle);
    },
  });
  const cleanStop = cleanStopClient.stop();
  queueMicrotask(() => {
    cleanStopChild.stdout.end();
    cleanStopChild.stderr.end();
    cleanStopChild.emit("close", 0, null);
  });
  await cleanStop;
  assert.equal(cleanStopChild.stdin.ended, true);
  assert.equal(cleanStopGroupAlive, false);
  assert.deepEqual(cleanStopTimers, new Set());

  let expiredNow = 0;
  const expiredDeadline = new ProcessDeadline(1, () => expiredNow);
  const expiredChild = appServerChild(602);
  let expiredGroupAlive = true;
  const expiredSignals = [];
  const expiredRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -602);
      if (signal === 0) {
        if (!expiredGroupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      expiredSignals.push(signal);
      expiredGroupAlive = false;
    },
  });
  const expiredTimers = new Set();
  const expiredClient = new AppServerClient({
    command: "/selected/codex",
    cwd: "/gate",
    env: {},
    eventsPath: "/gate/events-expired",
    deadline: expiredDeadline,
    spawnChild: () => expiredChild,
    supervisor: expiredRegistry,
    scheduleTimer() {
      const handle = Symbol("expired-watchdog");
      expiredTimers.add(handle);
      return handle;
    },
    cancelTimer(handle) {
      expiredTimers.delete(handle);
    },
  });
  expiredNow = 2;
  queueMicrotask(() => {
    expiredChild.stdout.end();
    expiredChild.stderr.end();
    expiredChild.emit("close", null, "SIGKILL");
  });
  await expiredClient.stop();
  assert.equal(expiredChild.stdin.ended, true);
  assert.equal(expiredGroupAlive, false);
  assert.deepEqual(expiredSignals, ["SIGKILL"]);
  assert.equal(expiredClient.closed, true);
  assert.deepEqual(expiredTimers, new Set());

  const retainedChild = appServerChild(603);
  let retainedGroupAlive = true;
  const retainedSignals = [];
  let retainedClock = 0;
  const retainedDeadlineTimers = new Set();
  const retainedRegistry = new LifecycleRegistry({
    killProcess(target, signal) {
      assert.equal(target, -603);
      if (signal === 0) {
        if (!retainedGroupAlive) {
          const error = new Error("missing process group");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      retainedSignals.push(signal);
      retainedGroupAlive = false;
    },
    now: () => retainedClock,
    wait: async milliseconds => {
      retainedClock += milliseconds;
    },
    scheduleTimer(callback) {
      const handle = setImmediate(() => {
        retainedDeadlineTimers.delete(handle);
        callback();
      });
      retainedDeadlineTimers.add(handle);
      return handle;
    },
    cancelTimer(handle) {
      retainedDeadlineTimers.delete(handle);
      clearImmediate(handle);
    },
  });
  const retainedWatchdogs = new Set();
  const retainedClient = new AppServerClient({
    command: "/selected/codex",
    cwd: "/gate",
    env: {},
    eventsPath: "/gate/events-retained",
    deadline: new ProcessDeadline(1, () => 2),
    spawnChild: () => retainedChild,
    supervisor: retainedRegistry,
    scheduleTimer(callback) {
      const handle = setImmediate(() => {
        retainedWatchdogs.delete(handle);
        callback();
      });
      retainedWatchdogs.add(handle);
      return handle;
    },
    cancelTimer(handle) {
      retainedWatchdogs.delete(handle);
      clearImmediate(handle);
    },
  });
  await assert.rejects(
    retainedClient.stop(),
    error =>
      error?.code === "codex_app_server_close_timeout" &&
      error.message === "codex_app_server_close_timeout",
  );
  assert.equal(retainedChild.stdin.ended, true);
  assert.equal(retainedGroupAlive, false);
  assert.deepEqual(retainedSignals, ["SIGKILL"]);
  assert.deepEqual(retainedWatchdogs, new Set());
  assert.deepEqual(retainedDeadlineTimers, new Set());
  retainedChild.stdout.end();
  retainedChild.stderr.end();
  retainedChild.emit("close", null, "SIGKILL");
  assert.equal(retainedClient.closed, true);
  assert.deepEqual(
    ["SIGINT", "SIGTERM", "SIGHUP"].map(signal =>
      process.listenerCount(signal),
    ),
    signalListenerCounts,
  );
  if (!silent) process.stdout.write("codex_browser_transport: PASS\n");
}
