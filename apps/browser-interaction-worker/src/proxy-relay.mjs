import { lstat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";

const MAX_CONNECTIONS = 64;

async function assertProxySocket(path) {
  const status = await lstat(path);
  if (
    !status.isSocket() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid() ||
    status.gid !== process.getgid()
  ) {
    throw new Error("model egress proxy socket identity is unsafe");
  }
}

export function createLoopbackProxyRelay(config) {
  const connections = new Set();
  const server = createServer(client => {
    if (connections.size >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ path: config.egressProxySocketPath });
    const pair = Object.freeze({ client, upstream });
    connections.add(pair);
    const close = () => {
      connections.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.once("error", close);
    upstream.once("error", close);
    client.once("close", close);
    upstream.once("close", close);
    upstream.once("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  return Object.freeze({
    async listen() {
      await assertProxySocket(config.egressProxySocketPath);
      await new Promise((resolve, reject) => {
        const onError = cause => {
          server.off("listening", onListening);
          reject(cause);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
          host: config.egressProxyHost,
          port: config.egressProxyPort,
          exclusive: true,
        });
      });
    },
    async close() {
      for (const { client, upstream } of connections) {
        client.destroy();
        upstream.destroy();
      }
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close(cause => (cause === undefined ? resolve() : reject(cause))),
      );
    },
    address() {
      return server.address();
    },
  });
}
