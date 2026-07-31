import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_MODEL_LENGTH = 128;
const MAX_MESSAGES = 1_024;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const MESSAGE_ROLES = new Set([
  "assistant",
  "developer",
  "system",
  "tool",
  "user",
]);
const REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export class InvalidChatRequestError extends TypeError {
  constructor(message, param = null) {
    super(message);
    this.name = "InvalidChatRequestError";
    this.param = param;
  }
}

export class CodexExecutionError extends Error {
  constructor(message = "Codex execution failed") {
    super(message);
    this.name = "CodexExecutionError";
  }
}

export class CodexProtocolError extends Error {
  constructor(message = "Codex returned malformed output") {
    super(message);
    this.name = "CodexProtocolError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message, param) {
  throw new InvalidChatRequestError(message, param);
}

function normalizeContent(content, messageIndex) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) {
    invalid(
      "Each message must have string or text-part content.",
      `messages.${messageIndex}.content`,
    );
  }
  const parts = content.map((part, partIndex) => {
    if (
      !isRecord(part) ||
      !["text", "input_text"].includes(part.type) ||
      typeof part.text !== "string"
    ) {
      invalid(
        "Message content arrays may contain only text parts.",
        `messages.${messageIndex}.content.${partIndex}`,
      );
    }
    return part.text;
  });
  return parts.join("\n");
}

function normalizeResponseFormat(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    invalid("response_format must be an object.", "response_format");
  }
  if (value.type === "text") return undefined;
  if (value.type !== "json_schema") {
    invalid(
      "Only text and json_schema response formats are supported.",
      "response_format.type",
    );
  }
  if (!isRecord(value.json_schema) || !isRecord(value.json_schema.schema)) {
    invalid(
      "response_format.json_schema.schema must be an object.",
      "response_format.json_schema.schema",
    );
  }
  return value.json_schema.schema;
}

export function normalizeChatRequest(value) {
  if (!isRecord(value)) invalid("Request body must be an object.", null);
  if (
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    value.model.length > MAX_MODEL_LENGTH ||
    !MODEL_PATTERN.test(value.model)
  ) {
    invalid("model must be a valid non-empty model name.", "model");
  }
  if (
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > MAX_MESSAGES
  ) {
    invalid(
      `messages must contain between 1 and ${MAX_MESSAGES} entries.`,
      "messages",
    );
  }
  if (value.stream === true) {
    invalid("Streaming chat completions are not supported.", "stream");
  }
  if (value.n !== undefined && value.n !== 1) {
    invalid("Only one completion may be requested.", "n");
  }

  const messages = value.messages.map((message, index) => {
    if (!isRecord(message) || !MESSAGE_ROLES.has(message.role)) {
      invalid(
        "Each message must have a supported role.",
        `messages.${index}.role`,
      );
    }
    return Object.freeze({
      role: message.role,
      content: normalizeContent(message.content, index),
    });
  });
  const prompt = messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    invalid("Combined message content is too large.", "messages");
  }

  const effort = value.reasoning_effort ?? "medium";
  if (typeof effort !== "string" || !REASONING_EFFORTS.has(effort)) {
    invalid(
      "reasoning_effort must be minimal, low, medium, high, or xhigh.",
      "reasoning_effort",
    );
  }

  return Object.freeze({
    model: value.model,
    effort,
    prompt,
    outputSchema: normalizeResponseFormat(value.response_format),
  });
}

function normalizeUsage(value) {
  if (!isRecord(value)) return undefined;
  const promptTokens = value.input_tokens ?? value.inputTokens;
  const completionTokens = value.output_tokens ?? value.outputTokens;
  if (
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0
  ) {
    return undefined;
  }
  return Object.freeze({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  });
}

export function parseCodexJsonEvents(stdout, expectsJson = false) {
  let finalMessage;
  let usage;
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new CodexProtocolError();

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new CodexProtocolError();
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      throw new CodexProtocolError();
    }
    if (event.type === "error") throw new CodexExecutionError();
    if (
      event.type === "item.completed" &&
      isRecord(event.item) &&
      event.item.type === "agent_message"
    ) {
      if (typeof event.item.text !== "string") {
        throw new CodexProtocolError();
      }
      finalMessage = event.item.text;
    }
    if (event.type === "turn.completed") {
      usage = normalizeUsage(event.usage) ?? usage;
    }
  }
  if (finalMessage === undefined) throw new CodexProtocolError();
  if (expectsJson) {
    try {
      JSON.parse(finalMessage);
    } catch {
      throw new CodexProtocolError(
        "Codex returned invalid schema-constrained JSON",
      );
    }
  }
  return Object.freeze({ content: finalMessage, usage });
}

export function createFifoExecutor(maxConcurrency) {
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > 1_024
  ) {
    throw new RangeError("maxConcurrency must be an integer from 1 to 1024");
  }
  let active = 0;
  const pending = [];

  const dispatch = () => {
    while (active < maxConcurrency && pending.length > 0) {
      const entry = pending.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          dispatch();
        });
    }
  };

  return Object.freeze({
    run(task) {
      if (typeof task !== "function") {
        return Promise.reject(new TypeError("task must be a function"));
      }
      return new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        dispatch();
      });
    },
  });
}

async function runCodex({ codexBin, prompt, model, effort, outputSchema }) {
  let temporaryDirectory;
  try {
    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "-m",
      model,
      "-c",
      `model_reasoning_effort=${effort}`,
    ];
    if (outputSchema !== undefined) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-shim-"));
      const schemaPath = join(temporaryDirectory, "response-schema.json");
      await writeFile(schemaPath, JSON.stringify(outputSchema), {
        flag: "wx",
        mode: 0o600,
      });
      args.push("--output-schema", schemaPath);
    }
    args.push("-");

    const child = spawn(codexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let spawnFailure;
    let streamFailure;

    child.once("error", (cause) => {
      spawnFailure = cause;
    });
    child.stdout.on("error", (cause) => {
      streamFailure ??= cause;
      child.kill();
    });
    child.stderr.on("error", (cause) => {
      streamFailure ??= cause;
      child.kill();
    });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdoutChunks.push(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES && !outputOverflow) {
        outputOverflow = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES && !outputOverflow) {
        outputOverflow = true;
        child.kill();
      }
    });
    child.stdin.on("error", (cause) => {
      if (cause?.code !== "EPIPE") {
        streamFailure ??= cause;
        child.kill();
      }
    });

    const exit = await new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.stdin.end(prompt, "utf8");
    });
    if (
      spawnFailure !== undefined ||
      streamFailure !== undefined ||
      outputOverflow ||
      exit.code !== 0
    ) {
      throw new CodexExecutionError();
    }
    return parseCodexJsonEvents(
      Buffer.concat(stdoutChunks).toString("utf8"),
      outputSchema !== undefined,
    );
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

// @lat: [[codex-shim#Completion translation]]
export function createCodexTranslator({
  codexBin = "codex",
  maxConcurrency = 2,
} = {}) {
  if (typeof codexBin !== "string" || codexBin.length === 0) {
    throw new TypeError("codexBin must be a non-empty string");
  }
  const executor = createFifoExecutor(maxConcurrency);

  return Object.freeze({
    async complete(value) {
      const request = normalizeChatRequest(value);
      const result = await executor.run(() =>
        runCodex({
          codexBin,
          prompt: request.prompt,
          model: request.model,
          effort: request.effort,
          outputSchema: request.outputSchema,
        }),
      );
      return Object.freeze({
        id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.content,
            },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
    },
  });
}
