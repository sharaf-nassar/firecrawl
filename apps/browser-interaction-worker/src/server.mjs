import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer } from "node:http";

import { validateDecisionRequest } from "./protocol.mjs";

const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const CANCELLATION_CONFIRM_TIMEOUT_MS = 10_000;
const RUN_PATH = /^\/v1\/runs\/([0-9a-f-]{36})$/;

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

function hasBearerToken(request, expected) {
  const received = request.headers.authorization;
  if (typeof received !== "string" || !received.startsWith("Bearer ")) {
    return false;
  }
  const receivedBytes = Buffer.from(received.slice(7), "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}

async function readJson(request) {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    const error = new TypeError("content type must be application/json");
    error.category = "invalid_request";
    throw error;
  }
  const declaredLength = request.headers["content-length"];
  if (
    declaredLength !== undefined &&
    (!/^(?:0|[1-9]\d*)$/.test(declaredLength) ||
      Number(declaredLength) > MAX_REQUEST_BYTES)
  ) {
    const error = new RangeError("request body exceeds its bound");
    error.category = "request_too_large";
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      const error = new RangeError("request body exceeds its bound");
      error.category = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new TypeError("request body is not JSON");
    error.category = "invalid_request";
    throw error;
  }
}

function failureStatus(category) {
  switch (category) {
    case "invalid_request":
      return 400;
    case "request_too_large":
      return 413;
    case "run_conflict":
      return 409;
    case "worker_capacity":
      return 429;
    case "cancellation_capacity":
      return 503;
    case "codex_timeout":
    case "cancellation_timeout":
      return 504;
    case "codex_cancelled":
      return 409;
    case "codex_protocol_error":
    case "codex_failed":
      return 502;
    default:
      return 500;
  }
}

export function createWorkerServer(config, runner) {
  let ready = false;
  let readinessFailure = null;
  let socketIdentity = null;
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: config.decisionTimeoutMs + 10_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
    },
    async (request, response) => {
      const url = new URL(request.url ?? "/", "http://worker.invalid");
      if (url.search !== "") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/live") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/ready") {
        sendJson(
          response,
          ready ? 200 : 503,
          ready
            ? { status: "ready" }
            : {
                status: "not_ready",
                category: readinessFailure ?? "starting",
              },
        );
        return;
      }
      if (!hasBearerToken(request, config.token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      const runMatch = RUN_PATH.exec(url.pathname);
      if (request.method === "DELETE" && runMatch !== null) {
        let result;
        try {
          result = await runner.cancelAndWait(
            runMatch[1],
            "cancelled",
            CANCELLATION_CONFIRM_TIMEOUT_MS,
          );
        } catch {
          sendJson(response, 500, { error: "internal_error" });
          return;
        }
        if (result === "confirmed") {
          sendJson(response, 200, { status: "cancelled" });
        } else if (result === "capacity") {
          sendJson(response, 503, { error: "cancellation_capacity" });
        } else {
          sendJson(response, 504, { error: "cancellation_timeout" });
        }
        return;
      }
      if (!ready) {
        sendJson(response, 503, { error: "not_ready" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/decisions") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      try {
        const body = await readJson(request);
        let decisionRequest;
        try {
          decisionRequest = validateDecisionRequest(body);
        } catch (cause) {
          cause.category =
            cause instanceof RangeError
              ? "request_too_large"
              : "invalid_request";
          throw cause;
        }
        let completed = false;
        let cancellationRequested = false;
        const cancelFromDisconnect = () => {
          if (completed || cancellationRequested) return;
          cancellationRequested = true;
          void runner
            .cancelAndWait(
              decisionRequest.runId,
              "request_aborted",
              CANCELLATION_CONFIRM_TIMEOUT_MS,
            )
            .catch(() => {});
        };
        request.once("aborted", cancelFromDisconnect);
        response.once("close", cancelFromDisconnect);
        try {
          if (request.aborted || response.destroyed) {
            cancelFromDisconnect();
          }
          const envelope = await runner.execute(decisionRequest);
          completed = true;
          if (!response.destroyed) sendJson(response, 200, envelope);
        } finally {
          completed = true;
          request.off("aborted", cancelFromDisconnect);
          response.off("close", cancelFromDisconnect);
        }
      } catch (cause) {
        const category = cause?.category ?? "internal_error";
        if (!response.destroyed) {
          sendJson(response, failureStatus(category), { error: category });
        }
      }
    },
  );

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return Object.freeze({
    markReady() {
      readinessFailure = null;
      ready = true;
    },
    markReadinessFailure(category) {
      ready = false;
      readinessFailure = category;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.socketPath, async () => {
          try {
            await chmod(config.socketPath, 0o660);
            const socket = await lstat(config.socketPath);
            if (
              !socket.isSocket() ||
              socket.isSymbolicLink() ||
              socket.uid !== process.getuid() ||
              socket.gid !== process.getgid() ||
              (socket.mode & 0o777) !== 0o660
            ) {
              throw new Error("interaction socket ownership is unsafe");
            }
            socketIdentity = Object.freeze({
              device: socket.dev,
              inode: socket.ino,
            });
            server.off("error", reject);
            resolve();
          } catch (cause) {
            server.close(() => reject(cause));
          }
        });
      });
    },
    async close() {
      ready = false;
      runner.cancelAll("shutdown");
      await new Promise((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        server.closeIdleConnections();
      });
      if (socketIdentity !== null) {
        let socket;
        try {
          socket = await lstat(config.socketPath);
        } catch (cause) {
          if (cause?.code !== "ENOENT") throw cause;
        }
        if (
          socket !== undefined &&
          socket.isSocket() &&
          socket.uid === process.getuid() &&
          socket.gid === process.getgid() &&
          socket.dev === socketIdentity.device &&
          socket.ino === socketIdentity.inode
        ) {
          await unlink(config.socketPath);
        }
        socketIdentity = null;
      }
    },
  });
}
