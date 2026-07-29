import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLoopbackProxyRelay } from "./proxy-relay.mjs";

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

test("loopback relay transports bytes only through the configured UDS", async t => {
  const directory = await mkdtemp(join(tmpdir(), "firecrawl-relay-test-"));
  const proxySocketPath = join(directory, "proxy.sock");
  const upstream = createServer(socket => socket.pipe(socket));
  await listen(upstream, proxySocketPath);
  const relay = createLoopbackProxyRelay({
    egressProxySocketPath: proxySocketPath,
    egressProxyHost: "127.0.0.1",
    egressProxyPort: 0,
  });
  await relay.listen();
  t.after(async () => {
    await relay.close();
    await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const address = relay.address();
  assert.equal(address.address, "127.0.0.1");
  const response = await new Promise((resolve, reject) => {
    const socket = connect({
      host: "127.0.0.1",
      port: address.port,
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.write("relay-check"));
    socket.once("data", chunk => {
      resolve(chunk.toString("utf8"));
      socket.destroy();
    });
  });
  assert.equal(response, "relay-check");
});
