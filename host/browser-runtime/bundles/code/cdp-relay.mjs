import { createConnection } from "node:net";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const RELAY_PATH = "/run/firecrawl-job/relay.sock";
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const PAUSE_QUEUE_BYTES = 16 * 1024 * 1024;
const RESUME_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_OUTSTANDING_IDS = 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function relayError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseFrame(frame) {
  if (
    frame.byteLength === 0 ||
    frame.byteLength > MAX_FRAME_BYTES ||
    frame.includes(0x0a)
  ) {
    throw relayError("relay_protocol_error");
  }
  let value;
  try {
    value = JSON.parse(UTF8.decode(frame));
  } catch {
    throw relayError("relay_protocol_error");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw relayError("relay_protocol_error");
  }
  return value;
}

export async function startCdpRelay() {
  const relay = createConnection({ path: RELAY_PATH });
  relay.setNoDelay(true);
  await new Promise((resolve, reject) => {
    relay.once("connect", resolve);
    relay.once("error", reject);
  });

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/devtools/browser/firecrawl",
    clientTracking: false,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1" ||
    !Number.isInteger(address.port)
  ) {
    server.close();
    relay.destroy();
    throw relayError("relay_listener_invalid");
  }

  let client;
  let buffer = Buffer.alloc(0);
  let gatewayQueueBytes = 0;
  let clientQueueBytes = 0;
  const outstandingIds = new Set();
  let closed = false;
  const close = error => {
    if (closed) return;
    closed = true;
    client?.close(1011, "relay_disconnected");
    client?.terminate();
    relay.destroy(error);
    server.close();
  };
  relay.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.byteLength > MAX_FRAME_BYTES) {
          close(relayError("relay_frame_too_large"));
        }
        return;
      }
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (!client || client.readyState !== client.OPEN) {
        close(relayError("relay_protocol_error"));
        return;
      }
      let message;
      try {
        message = parseFrame(frame);
      } catch (error) {
        close(error);
        return;
      }
      if (Object.hasOwn(message, "id")) {
        if (
          !Number.isSafeInteger(message.id) ||
          message.id <= 0 ||
          !outstandingIds.delete(message.id)
        ) {
          close(relayError("relay_protocol_error"));
          return;
        }
      }
      clientQueueBytes += frame.byteLength;
      if (clientQueueBytes > MAX_QUEUE_BYTES) {
        close(relayError("relay_queue_exceeded"));
        return;
      }
      if (clientQueueBytes >= PAUSE_QUEUE_BYTES) relay.pause();
      try {
        client.send(frame, { binary: false, compress: false }, error => {
          clientQueueBytes -= frame.byteLength;
          if (
            !closed &&
            clientQueueBytes <= RESUME_QUEUE_BYTES &&
            relay.isPaused()
          ) {
            relay.resume();
          }
          if (error) close(error);
        });
      } catch (error) {
        close(error);
        return;
      }
    }
  });
  relay.on("error", close);
  relay.on("end", () => close(relayError("relay_disconnected")));
  relay.on("close", () => close(relayError("relay_disconnected")));

  server.on("connection", socket => {
    if (client) {
      socket.close(1008, "single_client_only");
      return;
    }
    client = socket;
    socket.on("message", (data, isBinary) => {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        close(relayError("relay_protocol_error"));
        return;
      }
      let message;
      try {
        message = parseFrame(frame);
      } catch (error) {
        close(error);
        return;
      }
      if (
        !Number.isSafeInteger(message.id) ||
        message.id <= 0 ||
        typeof message.method !== "string" ||
        message.method.length === 0 ||
        outstandingIds.has(message.id) ||
        outstandingIds.size >= MAX_OUTSTANDING_IDS
      ) {
        close(relayError("relay_protocol_error"));
        return;
      }
      outstandingIds.add(message.id);
      const wire = Buffer.concat([frame, Buffer.from("\n")]);
      gatewayQueueBytes += wire.byteLength;
      if (gatewayQueueBytes > MAX_QUEUE_BYTES) {
        close(relayError("relay_queue_exceeded"));
        return;
      }
      if (!relay.write(wire, error => {
        gatewayQueueBytes -= wire.byteLength;
        if (!closed && socket.isPaused && gatewayQueueBytes <= RESUME_QUEUE_BYTES) {
          socket.resume();
        }
        if (error) close(error);
      })) {
        socket.pause();
        relay.once("drain", () => {
          if (!closed && gatewayQueueBytes <= RESUME_QUEUE_BYTES) socket.resume();
        });
      }
    });
    socket.on("error", close);
    socket.on("close", () => close(relayError("relay_disconnected")));
  });

  return Object.freeze({
    endpoint: `ws://127.0.0.1:${address.port}/devtools/browser/firecrawl`,
    close: async () => {
      if (closed) return;
      closed = true;
      client?.close(1000, "complete");
      client?.terminate();
      relay.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  });
}

async function serve() {
  const endpointFile = "/run/firecrawl-job/cdp-endpoint";
  const relay = await startCdpRelay();
  const handle = await open(
    endpointFile,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${relay.endpoint}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await new Promise(resolve => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await rm(endpointFile, { force: true });
  await relay.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--serve") {
    process.stderr.write("invalid_cdp_relay_invocation\n");
    process.exitCode = 1;
  } else {
    serve().catch(error => {
      process.stderr.write(`${error?.message || "cdp_relay_failed"}\n`);
      process.exitCode = 1;
    });
  }
}
