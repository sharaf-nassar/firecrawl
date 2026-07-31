import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  CodexExecutionError,
  CodexProtocolError,
  createCodexTranslator,
  InvalidChatRequestError,
} from "./translate.mjs";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

class RequestBodyError extends TypeError {
  constructor(message, status = 400, code = "invalid_request") {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
    this.code = code;
  }
}

function openAIError(message, type, code, param = null) {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request) {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    throw new RequestBodyError(
      "Content-Type must be application/json.",
      400,
      "invalid_content_type",
    );
  }
  const declaredLength = request.headers["content-length"];
  if (
    declaredLength !== undefined &&
    (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_REQUEST_BYTES)
  ) {
    throw new RequestBodyError(
      "Request body is too large.",
      413,
      "request_too_large",
    );
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new RequestBodyError(
        "Request body is too large.",
        413,
        "request_too_large",
      );
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(
      "Request body must be valid JSON.",
      400,
      "invalid_json",
    );
  }
}

function parseInteger(value, fallback, name, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function readServerConfig(env = process.env) {
  const host = env.CODEX_SHIM_HOST || "0.0.0.0";
  if (typeof host !== "string" || host.length > 253) {
    throw new TypeError("CODEX_SHIM_HOST must be a valid host");
  }
  return Object.freeze({
    host,
    port: parseInteger(env.CODEX_SHIM_PORT, 3030, "CODEX_SHIM_PORT", 0, 65_535),
    maxConcurrency: parseInteger(
      env.CODEX_SHIM_MAX_CONCURRENCY,
      2,
      "CODEX_SHIM_MAX_CONCURRENCY",
      1,
      1_024,
    ),
    codexBin: env.CODEX_SHIM_CODEX_BIN || "codex",
  });
}

function sendExpectedFailure(response, cause) {
  if (cause instanceof RequestBodyError) {
    sendJson(
      response,
      cause.status,
      openAIError(cause.message, "invalid_request_error", cause.code),
    );
    return true;
  }
  if (cause instanceof InvalidChatRequestError) {
    sendJson(
      response,
      400,
      openAIError(
        cause.message,
        "invalid_request_error",
        "invalid_request",
        cause.param,
      ),
    );
    return true;
  }
  if (cause instanceof CodexProtocolError) {
    sendJson(
      response,
      502,
      openAIError(
        "Codex returned malformed output.",
        "server_error",
        "codex_protocol_error",
      ),
    );
    return true;
  }
  if (cause instanceof CodexExecutionError) {
    sendJson(
      response,
      502,
      openAIError("Codex execution failed.", "server_error", "codex_failed"),
    );
    return true;
  }
  return false;
}

// @lat: [[codex-shim#HTTP and capacity boundary]]
export function createCodexShimServer(
  config = readServerConfig(),
  translator = createCodexTranslator({
    codexBin: config.codexBin,
    maxConcurrency: config.maxConcurrency,
  }),
) {
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
    },
    async (request, response) => {
      const url = new URL(request.url ?? "/", "http://codex-shim.invalid");
      if (url.search !== "") {
        sendJson(
          response,
          404,
          openAIError("Route not found.", "invalid_request_error", "not_found"),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/embeddings") {
        sendJson(
          response,
          501,
          openAIError(
            "Embeddings are not supported by codex-shim.",
            "invalid_request_error",
            "not_implemented",
          ),
        );
        return;
      }
      if (
        request.method !== "POST" ||
        url.pathname !== "/v1/chat/completions"
      ) {
        sendJson(
          response,
          404,
          openAIError("Route not found.", "invalid_request_error", "not_found"),
        );
        return;
      }

      try {
        const result = await translator.complete(await readJson(request));
        if (!response.destroyed) sendJson(response, 200, result);
      } catch (cause) {
        if (response.destroyed) return;
        if (!sendExpectedFailure(response, cause)) {
          sendJson(
            response,
            500,
            openAIError(
              "Internal server error.",
              "server_error",
              "internal_error",
            ),
          );
        }
      }
    },
  );
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return Object.freeze({
    listen() {
      return new Promise((resolve, reject) => {
        const rejectOnce = (cause) => {
          server.off("listening", resolveOnce);
          reject(cause);
        };
        const resolveOnce = () => {
          server.off("error", rejectOnce);
          resolve(server.address());
        };
        server.once("error", rejectOnce);
        server.once("listening", resolveOnce);
        server.listen(config.port, config.host);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((cause) => {
          if (cause) reject(cause);
          else resolve();
        });
      });
    },
  });
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const config = readServerConfig();
  const shim = createCodexShimServer(config);
  await shim.listen();
  process.stdout.write(
    `${JSON.stringify({
      event: "codex_shim_listening",
      host: config.host,
      port: config.port,
      concurrency: config.maxConcurrency,
    })}\n`,
  );

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await shim.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
