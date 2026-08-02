import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

import {
  addressesMatch,
  EGRESS_POLICY,
  normalizeHostname,
  parseClientHelloSni,
  parseConnectAuthority,
  validateResolvedAddresses,
} from "./egress-policy.mjs";

const FIXED_SOCKET_PATH = "/run/firecrawl-model-egress/proxy.sock";
const FIXED_PROVIDER_POLICY_PATH = "/run/secrets/codex-egress-policy.json";
const MAX_CONNECTIONS = 64;
const CONNECT_TIMEOUT_MS = 5_000;
const CLIENT_HELLO_TIMEOUT_MS = 5_000;
const TUNNEL_IDLE_TIMEOUT_MS = 360_000;

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function sendStatus(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

async function resolveAllowedHost(hostname) {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return validateResolvedAddresses(answers);
}

function connectAddress(answer) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: answer.address,
      port: 443,
      family: answer.family,
    });
    const fail = cause => {
      socket.destroy();
      reject(cause);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(new Error("upstream connection timed out")),
    );
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.off("error", fail);
      socket.setTimeout(0);
      if (!addressesMatch(socket.remoteAddress, answer.address)) {
        fail(new Error("upstream peer address mismatch"));
        return;
      }
      socket.once("error", () => socket.destroy());
      resolve(socket);
    });
  });
}

async function dialValidatedAddresses(answers) {
  let lastError;
  for (const answer of answers) {
    try {
      return await connectAddress(answer);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError ?? new Error("no validated upstream address was dialed");
}

function connectPlaintextProvider(providerPolicy) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: providerPolicy.httpHost,
      port: providerPolicy.httpPort,
    });
    const fail = cause => {
      socket.destroy();
      reject(cause);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(new Error("provider connection timed out")),
    );
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.off("error", fail);
      socket.setTimeout(0);
      socket.once("error", () => socket.destroy());
      resolve(socket);
    });
  });
}

function readVerifiedClientHello(client, expectedHostname, head) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.from(head);
    const finish = (callback, value) => {
      clearTimeout(timer);
      client.off("data", onData);
      client.off("error", onError);
      client.off("close", onClose);
      callback(value);
    };
    const inspect = () => {
      let parsed;
      try {
        parsed = parseClientHelloSni(buffered);
        if (
          parsed.status === "complete" &&
          parsed.hostname !== expectedHostname
        ) {
          throw Object.assign(new Error("TLS SNI does not match CONNECT"), {
            category: "egress_denied",
          });
        }
      } catch (cause) {
        finish(reject, cause);
        return;
      }
      if (parsed.status === "complete") finish(resolve, buffered);
    };
    const onData = chunk => {
      if (
        buffered.length + chunk.length >
        EGRESS_POLICY.maxClientHelloBytes
      ) {
        finish(
          reject,
          Object.assign(new Error("TLS ClientHello exceeds its bound"), {
            category: "egress_denied",
          }),
        );
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      inspect();
    };
    const onError = cause => finish(reject, cause);
    const onClose = () =>
      finish(reject, new Error("client closed before TLS ClientHello"));
    const timer = setTimeout(
      () => finish(reject, new Error("TLS ClientHello timed out")),
      CLIENT_HELLO_TIMEOUT_MS,
    );
    timer.unref();
    client.on("data", onData);
    client.once("error", onError);
    client.once("close", onClose);
    if (buffered.length > 0) inspect();
  });
}

async function prepareSocket(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  const directoryStatus = await lstat(canonicalDirectory);
  if (
    canonicalDirectory !== directory ||
    !directoryStatus.isDirectory() ||
    directoryStatus.isSymbolicLink() ||
    directoryStatus.uid !== process.getuid() ||
    directoryStatus.gid !== process.getgid()
  ) {
    throw new Error("model egress socket directory identity is unsafe");
  }
  await chmod(directory, 0o700);
  try {
    const existing = await lstat(path);
    if (
      !existing.isSocket() ||
      existing.isSymbolicLink() ||
      existing.uid !== process.getuid() ||
      existing.gid !== process.getgid()
    ) {
      throw new Error("existing model egress socket identity is unsafe");
    }
    await unlink(path);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
}

export async function loadProviderPolicy(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.isSymbolicLink() || status.size > 4096) {
      throw new Error("provider egress policy is not a bounded regular file");
    }
    const value = JSON.parse((await handle.readFile()).toString("utf8"));
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return Object.freeze({});
    if (
      keys.join(",") === "httpsHost" &&
      normalizeHostname(value.httpsHost) === value.httpsHost
    ) {
      return Object.freeze({ httpsHost: value.httpsHost });
    }
    if (
      keys.join(",") === "httpHost,httpPort" &&
      value.httpHost === "host.docker.internal" &&
      Number.isInteger(value.httpPort) &&
      value.httpPort >= 1 &&
      value.httpPort <= 65535
    ) {
      return Object.freeze({
        httpHost: value.httpHost,
        httpPort: value.httpPort,
      });
    }
    throw new Error("provider egress policy is invalid");
  } finally {
    await handle.close();
  }
}

export function createEgressProxy({
  socketPath = FIXED_SOCKET_PATH,
  resolveHost = resolveAllowedHost,
  dialHost = dialValidatedAddresses,
  emitLog = log,
  providerPolicy = Object.freeze({}),
} = {}) {
  const tunnels = new Set();
  const server = createServer(
    { maxHeaderSize: 16 * 1024, headersTimeout: 5_000 },
    (_request, response) => {
      response.writeHead(405, {
        connection: "close",
        "content-length": "0",
      });
      response.end();
    },
  );
  server.on("clientError", (_cause, socket) =>
    sendStatus(socket, 400, "Bad Request"),
  );
  server.on("connect", async (request, client, head) => {
    if (tunnels.size >= MAX_CONNECTIONS) {
      sendStatus(client, 503, "Service Unavailable");
      return;
    }
    let authority;
    const providerAuthority = `${providerPolicy.httpHost}:${providerPolicy.httpPort}`;
    const isPlaintextProvider =
      providerPolicy.httpHost !== undefined &&
      request.url === providerAuthority &&
      request.headers.host === providerAuthority;
    try {
      authority = isPlaintextProvider
        ? { hostname: providerPolicy.httpHost, port: providerPolicy.httpPort }
        : parseConnectAuthority(request.url, providerPolicy.httpsHost);
    } catch {
      emitLog("model_egress_denied", { category: "connect_policy" });
      sendStatus(client, 403, "Forbidden");
      return;
    }
    const tunnel = { client, upstream: undefined };
    tunnels.add(tunnel);
    const close = () => {
      tunnels.delete(tunnel);
      client.destroy();
      tunnel.upstream?.destroy();
    };
    client.once("close", close);
    client.once("error", close);
    try {
      if (isPlaintextProvider) {
        tunnel.upstream = await connectPlaintextProvider(providerPolicy);
        tunnel.upstream.once("close", close);
        tunnel.upstream.once("error", close);
        client.write(
          "HTTP/1.1 200 Connection Established\r\nProxy-Agent: firecrawl-model-egress\r\n\r\n",
        );
        if (head.length > 0) tunnel.upstream.write(head);
        client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, close);
        tunnel.upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, close);
        client.pipe(tunnel.upstream);
        tunnel.upstream.pipe(client);
        emitLog("model_egress_allowed", {
          hostname: providerPolicy.httpHost,
        });
        return;
      }
      const answers = await resolveHost(authority.hostname);
      tunnel.upstream = await dialHost(answers);
      tunnel.upstream.once("close", close);
      tunnel.upstream.once("error", close);
      client.write(
        "HTTP/1.1 200 Connection Established\r\nProxy-Agent: firecrawl-model-egress\r\n\r\n",
      );
      const hello = await readVerifiedClientHello(
        client,
        authority.hostname,
        head,
      );
      tunnel.upstream.write(hello);
      client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, close);
      tunnel.upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, close);
      client.pipe(tunnel.upstream);
      tunnel.upstream.pipe(client);
      emitLog("model_egress_allowed", { hostname: authority.hostname });
    } catch (cause) {
      emitLog("model_egress_denied", {
        category:
          cause?.category === "egress_denied"
            ? "destination_policy"
            : "upstream_unavailable",
      });
      if (tunnel.upstream === undefined) {
        sendStatus(client, 502, "Bad Gateway");
      } else {
        close();
      }
    }
  });

  return Object.freeze({
    async listen() {
      await prepareSocket(socketPath);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o660);
    },
    async close() {
      for (const tunnel of tunnels) {
        tunnel.client.destroy();
        tunnel.upstream?.destroy();
      }
      if (server.listening) {
        await new Promise((resolve, reject) =>
          server.close(cause =>
            cause === undefined ? resolve() : reject(cause),
          ),
        );
      }
      try {
        await unlink(socketPath);
      } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
      }
    },
  });
}

async function main() {
  if (process.env.MODEL_EGRESS_PROXY_SOCKET_PATH !== FIXED_SOCKET_PATH) {
    throw new Error(`proxy socket path must be ${FIXED_SOCKET_PATH}`);
  }
  if (
    process.env.MODEL_EGRESS_PROVIDER_POLICY_FILE !== FIXED_PROVIDER_POLICY_PATH
  ) {
    throw new Error(
      `provider policy path must be ${FIXED_PROVIDER_POLICY_PATH}`,
    );
  }
  const providerPolicy = await loadProviderPolicy(
    process.env.MODEL_EGRESS_PROVIDER_POLICY_FILE,
  );
  const proxy = createEgressProxy({
    socketPath: process.env.MODEL_EGRESS_PROXY_SOCKET_PATH,
    providerPolicy,
  });
  await proxy.listen();
  log("model_egress_proxy_ready", {
    allowedApexes: EGRESS_POLICY.allowedApexes,
    ...(providerPolicy.httpsHost === undefined
      ? {}
      : { providerHostname: providerPolicy.httpsHost }),
    ...(providerPolicy.httpHost === undefined
      ? {}
      : { providerHostname: providerPolicy.httpHost }),
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await proxy.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      `${JSON.stringify({
        event: "model_egress_proxy_startup_failed",
        category: "startup_failed",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
