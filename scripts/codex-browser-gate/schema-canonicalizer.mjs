import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function invalidJson() {
  throw new Error("invalid_json");
}

function decodeJsonBytes(raw) {
  if (!(raw instanceof Uint8Array)) invalidJson();
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    invalidJson();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      raw,
    );
  } catch {
    invalidJson();
  }
}

function parseHexQuad(text, offset) {
  const raw = text.slice(offset, offset + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(raw)) invalidJson();
  return parseInt(raw, 16);
}

export function parseLosslessJson(raw) {
  const text = decodeJsonBytes(raw);
  let index = 0;

  function skipWhitespace() {
    while (
      text[index] === " " ||
      text[index] === "\t" ||
      text[index] === "\n" ||
      text[index] === "\r"
    ) {
      index += 1;
    }
  }

  function parseString() {
    if (text[index] !== '"') invalidJson();
    index += 1;
    let value = "";
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return value;
      }
      if (code < 0x20) invalidJson();
      if (code === 0x5c) {
        index += 1;
        const escape = text[index];
        index += 1;
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            value += escape;
            break;
          case "b":
            value += "\b";
            break;
          case "f":
            value += "\f";
            break;
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case "u": {
            const first = parseHexQuad(text, index);
            index += 4;
            if (first >= 0xd800 && first <= 0xdbff) {
              if (text.slice(index, index + 2) !== "\\u") invalidJson();
              const second = parseHexQuad(text, index + 2);
              if (second < 0xdc00 || second > 0xdfff) invalidJson();
              index += 6;
              value += String.fromCharCode(first, second);
            } else {
              if (first >= 0xdc00 && first <= 0xdfff) invalidJson();
              value += String.fromCharCode(first);
            }
            break;
          }
          default:
            invalidJson();
        }
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (low < 0xdc00 || low > 0xdfff) invalidJson();
        value += text[index] + text[index + 1];
        index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) invalidJson();
      value += text[index];
      index += 1;
    }
    invalidJson();
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(index),
    );
    if (!match) invalidJson();
    index += match[0].length;
    return { kind: "number", raw: match[0] };
  }

  function parseArray() {
    index += 1;
    skipWhitespace();
    const items = [];
    if (text[index] === "]") {
      index += 1;
      return { kind: "array", items };
    }
    while (true) {
      items.push(parseValue());
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return { kind: "array", items };
      }
      if (text[index] !== ",") invalidJson();
      index += 1;
      skipWhitespace();
    }
  }

  function parseObject() {
    index += 1;
    skipWhitespace();
    const members = [];
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return { kind: "object", members };
    }
    while (true) {
      const key = parseString();
      if (keys.has(key)) invalidJson();
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") invalidJson();
      index += 1;
      skipWhitespace();
      members.push({ key, value: parseValue() });
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return { kind: "object", members };
      }
      if (text[index] !== ",") invalidJson();
      index += 1;
      skipWhitespace();
    }
  }

  function parseValue() {
    skipWhitespace();
    const token = text[index];
    if (token === '"') return { kind: "string", value: parseString() };
    if (token === "{") return parseObject();
    if (token === "[") return parseArray();
    if (token === "-" || (token >= "0" && token <= "9")) {
      return parseNumber();
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return { kind: literal };
      }
    }
    invalidJson();
  }

  const node = parseValue();
  skipWhitespace();
  if (index !== text.length) invalidJson();
  return node;
}

function compareUtf16(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function serializeString(value) {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x08:
        output += "\\b";
        continue;
      case 0x09:
        output += "\\t";
        continue;
      case 0x0a:
        output += "\\n";
        continue;
      case 0x0c:
        output += "\\f";
        continue;
      case 0x0d:
        output += "\\r";
        continue;
      case 0x22:
        output += '\\"';
        continue;
      case 0x5c:
        output += "\\\\";
        continue;
      default:
        if (code < 0x20) {
          output += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          output += value[index];
        }
    }
  }
  return `${output}"`;
}

function serializeNode(node) {
  switch (node.kind) {
    case "string":
      return serializeString(node.value);
    case "number":
      return node.raw;
    case "true":
    case "false":
    case "null":
      return node.kind;
    case "array":
      return `[${node.items.map(serializeNode).join(",")}]`;
    case "object":
      return `{${[...node.members]
        .sort((left, right) => compareUtf16(left.key, right.key))
        .map(
          member =>
            `${serializeString(member.key)}:${serializeNode(member.value)}`,
        )
        .join(",")}}`;
    default:
      invalidJson();
  }
}

export function canonicalizeJsonBytes(raw) {
  return Buffer.from(serializeNode(parseLosslessJson(raw)), "utf8");
}

export async function canonicalizeJsonFile(path) {
  const canonical = canonicalizeJsonBytes(await readFile(path));
  await writeFile(path, canonical);
  return canonical;
}

function normalizeLogicalPath(path) {
  if (typeof path !== "string") throw new Error("invalid_schema_path");
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    !normalized.endsWith(".json") ||
    segments.some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("invalid_schema_path");
  }
  return normalized;
}

export function hashCanonicalSchemaBundle(entries) {
  const files = [];
  const paths = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("invalid_schema_entry");
    }
    const path = normalizeLogicalPath(entry[0]);
    if (paths.has(path)) throw new Error("duplicate_schema_path");
    paths.add(path);
    files.push({ path, canonical: canonicalizeJsonBytes(entry[1]) });
  }
  files.sort((left, right) => compareUtf16(left.path, right.path));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(file.canonical);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

async function canonicalizeTree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error("invalid_schema_tree_entry");
    }
    files.push(resolve(entry.parentPath, entry.name));
  }
  files.sort(compareUtf16);
  for (const file of files) await canonicalizeJsonFile(file);
}

async function main() {
  const [flag, path, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || typeof path !== "string") {
    throw new Error("invalid_arguments");
  }
  if (flag === "--canonicalize-file") {
    await canonicalizeJsonFile(path);
    return;
  }
  if (flag === "--canonicalize-tree") {
    await canonicalizeTree(path);
    return;
  }
  throw new Error("invalid_arguments");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch(error => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
