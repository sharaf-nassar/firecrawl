#!/usr/bin/env node
import { createConnection } from "node:net";

import { chromium } from "playwright";

import { startCdpRelay } from "./cdp-relay.mjs";

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL = 32 * 1024 * 1024;
const ARTIFACT_SOCKET_PATH = "/run/firecrawl-job/artifact.sock";
const MAX_ARTIFACT_RESPONSE_BYTES = 4 * 1024;

async function readSource() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > MAX_SOURCE_BYTES) throw new Error("source_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function saveArtifact(value) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : null;
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact_size_rejected");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(buffer.byteLength);
  const socket = createConnection({ path: ARTIFACT_SOCKET_PATH });
  const response = [];
  let responseBytes = 0;
  await new Promise((resolve, reject) => {
    socket.once("connect", () => socket.end(Buffer.concat([header, buffer])));
    socket.on("data", chunk => {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_ARTIFACT_RESPONSE_BYTES) {
        socket.destroy(new Error("artifact_response_too_large"));
        return;
      }
      response.push(chunk);
    });
    socket.once("error", reject);
    socket.once("end", resolve);
  });
  const raw = Buffer.concat(response).toString("utf8");
  if (!raw.endsWith("\n") || raw.indexOf("\n") !== raw.length - 1) {
    throw new Error("artifact_response_invalid");
  }
  const parsed = JSON.parse(raw);
  if (
    parsed?.ok !== true ||
    !["screenshot", "trace", "recording"].includes(parsed.kind) ||
    parsed.byteSize !== buffer.byteLength ||
    Object.keys(parsed).sort().join(",") !== "byteSize,kind,ok"
  ) {
    throw new Error(parsed?.error || "artifact_response_invalid");
  }
  return Object.freeze({ kind: parsed.kind, byteSize: parsed.byteSize });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("invalid_runner_invocation");
  const source = await readSource();
  const relay = await startCdpRelay();
  const browser = await chromium.connectOverCDP(relay.endpoint, {
    timeout: 30_000,
  });
  try {
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw new Error("relay_context_mismatch");
    const context = contexts[0];
    const pages = context.pages();
    if (pages.length !== 1) throw new Error("relay_page_mismatch");
    const page = pages[0];
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      "page",
      "context",
      "browser",
      "saveArtifact",
      source,
    );
    const value = await fn(page, context, browser, saveArtifact);
    if (value !== undefined) process.stdout.write(`${JSON.stringify(value)}\n`);
  } finally {
    await browser.close().catch(() => {});
    await relay.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error?.message || "code_execution_failed"}\n`);
  process.exitCode = 1;
});
