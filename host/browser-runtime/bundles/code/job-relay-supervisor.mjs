#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createServer, Socket } from "node:net";

const RELAY_PATH = "/run/firecrawl-job/relay.sock";
const ARTIFACT_SOCKET_PATH = "/run/firecrawl-job/artifact.sock";
const ARTIFACT_ROOT = "/run/firecrawl-job/artifacts";
const RUNNERS = new Set([
  "/opt/firecrawl/bin/run-node.mjs",
  "/opt/firecrawl/bin/run-python.py",
  "/opt/firecrawl/bin/run-bash.sh",
]);
const DEADLINE_MS = 300_000;
const KILL_GRACE_MS = 2_000;
const RELAY_EXIT_GRACE_MS = 250;
const MAX_STDOUT_BYTES = 262_144;
const MAX_STDERR_BYTES = 262_144;
const MAX_ARTIFACT_CONNECTIONS = 16;
const MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL = 32 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function classifyArtifact(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))) {
    return { kind: "screenshot", contentType: "image/png", extension: "png" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: "screenshot", contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    buffer.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "binary")) ||
    buffer.subarray(0, 4).equals(Buffer.from("PK\x05\x06", "binary"))
  ) {
    return { kind: "trace", contentType: "application/zip", extension: "zip" };
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { kind: "recording", contentType: "video/webm", extension: "webm" };
  }
  throw new Error("artifact_type_rejected");
}

async function createArtifactCollector() {
  await rm(ARTIFACT_SOCKET_PATH, { force: true });
  const artifacts = [];
  const connections = new Set();
  let allocatedCount = 0;
  let allocatedBytes = 0;
  let activeConnections = 0;
  const server = createServer(socket => {
    if (activeConnections >= MAX_ARTIFACT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    activeConnections += 1;
    connections.add(socket);
    let header = Buffer.alloc(0);
    let expected;
    let chunks = [];
    let received = 0;
    let allocated = false;
    let committed = false;
    let settled = false;

    const release = () => {
      if (allocated && !committed) {
        allocatedCount -= 1;
        allocatedBytes -= expected;
        allocated = false;
      }
    };
    const reject = code => {
      if (settled) return;
      settled = true;
      release();
      socket.end(`${JSON.stringify({ ok: false, error: code })}\n`);
    };
    socket.on("data", chunk => {
      if (settled) return;
      let remainder = chunk;
      if (expected === undefined) {
        const needed = 4 - header.byteLength;
        header = Buffer.concat([header, remainder.subarray(0, needed)]);
        remainder = remainder.subarray(Math.min(needed, remainder.byteLength));
        if (header.byteLength < 4) return;
        expected = header.readUInt32BE(0);
        if (
          expected === 0 ||
          expected > MAX_ARTIFACT_BYTES ||
          allocatedCount >= MAX_ARTIFACTS ||
          allocatedBytes + expected > MAX_ARTIFACT_TOTAL
        ) {
          reject("artifact_limit_exceeded");
          return;
        }
        allocated = true;
        allocatedCount += 1;
        allocatedBytes += expected;
      }
      received += remainder.byteLength;
      if (received > expected) {
        reject("artifact_request_invalid");
        return;
      }
      if (remainder.byteLength) chunks.push(remainder);
    });
    socket.on("end", () => {
      if (settled) return;
      if (expected === undefined || received !== expected) {
        reject("artifact_request_invalid");
        return;
      }
      let type;
      const content = Buffer.concat(chunks, received);
      chunks = [];
      try {
        type = classifyArtifact(content);
      } catch {
        reject("artifact_type_rejected");
        return;
      }
      committed = true;
      artifacts.push({ content, type });
      settled = true;
      socket.end(
        `${JSON.stringify({
          ok: true,
          kind: type.kind,
          byteSize: content.byteLength,
        })}\n`,
      );
    });
    socket.on("error", release);
    socket.on("close", () => {
      release();
      connections.delete(socket);
      activeConnections -= 1;
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ARTIFACT_SOCKET_PATH, resolve);
  });
  await chmod(ARTIFACT_SOCKET_PATH, 0o600);
  const metadata = await lstat(ARTIFACT_SOCKET_PATH);
  if (!metadata.isSocket() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("artifact_socket_invalid");
  }
  return {
    artifacts,
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(ARTIFACT_SOCKET_PATH, { force: true });
    },
  };
}

async function resetArtifactRoot() {
  const metadata = await lstat(ARTIFACT_ROOT);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("artifact_root_invalid");
  }
  await chmod(ARTIFACT_ROOT, 0o700);
  for (const entry of await readdir(ARTIFACT_ROOT)) {
    await rm(`${ARTIFACT_ROOT}/${entry}`, { force: true, recursive: true });
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishArtifacts(artifacts) {
  const files = `${ARTIFACT_ROOT}/files`;
  await mkdir(files, { mode: 0o700 });
  const records = [];
  for (const artifact of artifacts) {
    const artifactId = randomUUID();
    const name = `${artifactId}.${artifact.type.extension}`;
    const path = `${files}/${name}`;
    const handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(artifact.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    records.push({
      artifactId,
      name,
      kind: artifact.type.kind,
      contentType: artifact.type.contentType,
      byteSize: artifact.content.byteLength,
      checksum: createHash("sha256").update(artifact.content).digest("hex"),
    });
  }
  await syncDirectory(files);
  const temporary = `${ARTIFACT_ROOT}/.manifest-${randomUUID()}`;
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(records)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, `${ARTIFACT_ROOT}/manifest.json`);
  await syncDirectory(ARTIFACT_ROOT);
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

async function terminateProcessGroup(pid) {
  if (!groupAlive(pid)) return;
  signalGroup(pid, "SIGTERM");
  if (await waitForGroupExit(pid, KILL_GRACE_MS)) return;
  signalGroup(pid, "SIGKILL");
  if (!(await waitForGroupExit(pid, KILL_GRACE_MS))) {
    throw new Error("runner_process_group_survived");
  }
}

async function payloadPids() {
  return (await readdir("/proc", { withFileTypes: true }))
    .filter(
      entry =>
        entry.isDirectory() &&
        /^(?:[1-9][0-9]*)$/.test(entry.name) &&
        Number(entry.name) !== 1 &&
        Number(entry.name) !== process.pid,
    )
    .map(entry => Number(entry.name))
    .sort((left, right) => left - right);
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function drainPayloadPids(signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = await payloadPids();
    if (pids.length === 0) return true;
    signalPids(pids, signal);
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function terminateAllPayloads() {
  if (await drainPayloadPids("SIGTERM", KILL_GRACE_MS)) return;
  if (!(await drainPayloadPids("SIGKILL", KILL_GRACE_MS))) {
    throw new Error("runner_namespace_process_survived");
  }
}

async function main() {
  const runner = process.argv[2];
  if (process.argv.length !== 3 || !RUNNERS.has(runner)) {
    throw new Error("invalid_runner");
  }
  const inheritedStat = await stat("/proc/self/fd/3");
  if (!inheritedStat.isSocket()) throw new Error("relay_descriptor_invalid");
  const inherited = new Socket({ fd: 3, readable: true, writable: true });
  let accepted = false;
  let peer;
  const server = createServer(socket => {
    if (accepted) {
      socket.destroy();
      return;
    }
    accepted = true;
    peer = socket;
    socket.setNoDelay(true);
    inherited.pipe(socket);
    socket.pipe(inherited, { end: false });
    socket.on("error", () => socket.destroy());
  });
  server.on("error", error => {
    inherited.destroy(error);
  });
  await rm(RELAY_PATH, { force: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(RELAY_PATH, resolve);
  });
  await chmod(RELAY_PATH, 0o600);
  const relayStat = await lstat(RELAY_PATH);
  if (!relayStat.isSocket() || (relayStat.mode & 0o777) !== 0o600) {
    throw new Error("relay_socket_invalid");
  }
  const artifactCollector = await createArtifactCollector();

  const child = spawn(runner, [], {
    detached: true,
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      HOME: "/run/firecrawl-home",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/opt/firecrawl/bin:/usr/bin:/bin",
      TMPDIR: "/run/firecrawl-work",
    },
  });
  let terminalError;
  let escalation;
  let relayExitGrace;
  const requestTermination = code => {
    terminalError ??= new Error(code);
    if (!child.pid) return;
    signalGroup(child.pid, "SIGTERM");
    escalation ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    escalation.unref();
  };
  const forwardBounded = (source, destination, maximum) => {
    let bytes = 0;
    source.on("data", chunk => {
      bytes += chunk.byteLength;
      if (bytes > maximum) {
        source.destroy();
        requestTermination("runner_output_exceeded");
        return;
      }
      if (!destination.write(chunk)) {
        source.pause();
        destination.once("drain", () => source.resume());
      }
    });
  };
  forwardBounded(child.stdout, process.stdout, MAX_STDOUT_BYTES);
  forwardBounded(child.stderr, process.stderr, MAX_STDERR_BYTES);
  const deadline = setTimeout(
    () => requestTermination("runner_timeout"),
    DEADLINE_MS,
  );
  deadline.unref();
  const relayDisconnected = () => {
    relayExitGrace ??= setTimeout(
      () => requestTermination("relay_disconnected"),
      RELAY_EXIT_GRACE_MS,
    );
    relayExitGrace.unref();
  };
  inherited.on("error", relayDisconnected);
  inherited.on("end", relayDisconnected);
  inherited.on("close", relayDisconnected);

  const result = await new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline);
  if (relayExitGrace) clearTimeout(relayExitGrace);
  if (escalation) clearTimeout(escalation);
  let cleanupError;
  try {
    if (child.pid) await terminateProcessGroup(child.pid);
    await terminateAllPayloads();
  } catch (error) {
    cleanupError = error;
  }
  peer?.destroy();
  inherited.destroy();
  server.close();
  await rm(RELAY_PATH, { force: true });
  await artifactCollector.close();
  await resetArtifactRoot();

  const failure =
    terminalError ??
    result.error ??
    cleanupError ??
    (result.signal ? new Error("runner_terminated") : undefined) ??
    (result.code === 0 ? undefined : new Error("runner_failed"));
  if (failure) throw failure;
  await publishArtifacts(artifactCollector.artifacts);
  process.exitCode = 0;
}

main().catch(error => fail(error?.message || "runner_failed"));
