import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";

import { createEgressProxy } from "./egress-proxy.mjs";
import { parseConnectAuthority } from "./egress-policy.mjs";

function clientHello(hostname) {
  const host = Buffer.from(hostname, "ascii");
  const name = Buffer.alloc(3 + host.length);
  name[0] = 0;
  name.writeUInt16BE(host.length, 1);
  host.copy(name, 3);
  const names = Buffer.alloc(2 + name.length);
  names.writeUInt16BE(name.length, 0);
  name.copy(names, 2);
  const extension = Buffer.alloc(4 + names.length);
  extension.writeUInt16BE(0, 0);
  extension.writeUInt16BE(names.length, 2);
  names.copy(extension, 4);
  const body = Buffer.alloc(2 + 32 + 1 + 2 + 2 + 1 + 1 + 2);
  let offset = 0;
  body.writeUInt16BE(0x0303, offset);
  offset += 2 + 32;
  body[offset] = 0;
  offset += 1;
  body.writeUInt16BE(2, offset);
  offset += 2;
  body.writeUInt16BE(0x1301, offset);
  offset += 2;
  body[offset] = 1;
  body[offset + 1] = 0;
  offset += 2;
  body.writeUInt16BE(extension.length, offset);
  const helloBody = Buffer.concat([body, extension]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 1;
  handshake.writeUIntBE(helloBody.length, 1, 3);
  const payload = Buffer.concat([handshake, helloBody]);
  const record = Buffer.alloc(5);
  record[0] = 22;
  record.writeUInt16BE(0x0301, 1);
  record.writeUInt16BE(payload.length, 3);
  return Buffer.concat([record, payload]);
}

function openSocket(path) {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForStatus(socket) {
  return new Promise((resolve, reject) => {
    let response = "";
    const onData = chunk => {
      response += chunk.toString("ascii");
      const match = /^HTTP\/1\.1 (\d{3}) /u.exec(response);
      if (match !== null) {
        socket.off("error", reject);
        socket.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function fakeUpstream(received) {
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      received.push(Buffer.from(chunk));
      callback();
    },
  });
  stream.setTimeout = () => stream;
  return stream;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "firecrawl-egress-test-"));
  const socketPath = join(directory, "proxy.sock");
  const received = [];
  let resolutions = 0;
  const proxy = createEgressProxy({
    socketPath,
    resolveHost: async () => {
      resolutions += 1;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    dialHost: async () => fakeUpstream(received),
    emitLog() {},
  });
  await proxy.listen();
  t.after(async () => {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    socketPath,
    received,
    resolutions: () => resolutions,
  };
}

test("proxy rejects non-allowlisted CONNECT before DNS", async t => {
  const context = await fixture(t);
  const socket = await openSocket(context.socketPath);
  t.after(() => socket.destroy());
  socket.write(
    "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
  );
  assert.equal(await waitForStatus(socket), 403);
  assert.equal(context.resolutions(), 0);
});

test("proxy forwards only after CONNECT hostname and TLS SNI agree", async t => {
  const context = await fixture(t);
  const socket = await openSocket(context.socketPath);
  socket.write(
    "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n",
  );
  assert.equal(await waitForStatus(socket), 200);
  const hello = clientHello("chatgpt.com");
  socket.write(hello);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(Buffer.concat(context.received), hello);
  socket.destroy();
});

test("proxy closes a tunnel when TLS SNI differs from CONNECT", async t => {
  const context = await fixture(t);
  const socket = await openSocket(context.socketPath);
  socket.write(
    "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n",
  );
  assert.equal(await waitForStatus(socket), 200);
  const closed = new Promise(resolve => socket.once("close", resolve));
  socket.write(clientHello("api.openai.com"));
  await closed;
  assert.equal(context.received.length, 0);
});

test("proxy permits the selected HTTPS provider hostname only", () => {
  assert.deepEqual(
    parseConnectAuthority("proxy.example:443", "proxy.example"),
    { hostname: "proxy.example", port: 443 },
  );
  assert.throws(() =>
    parseConnectAuthority("sibling.example:443", "proxy.example"),
  );
});

// @lat: [[runtime-operations#Browser Interaction Worker suite#Loopback provider egress]]
test("proxy forwards only the rewritten loopback provider origin", async t => {
  const upstreamRequests = [];
  const upstream = createHttpServer((request, response) => {
    upstreamRequests.push({
      authorization: request.headers.authorization,
      path: request.url,
    });
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const port = upstream.address().port;

  const directory = await mkdtemp(
    join(tmpdir(), "firecrawl-egress-http-test-"),
  );
  const socketPath = join(directory, "proxy.sock");
  const proxy = createEgressProxy({
    socketPath,
    providerPolicy: { httpHost: "127.0.0.1", httpPort: port },
    emitLog() {},
  });
  await proxy.listen();
  t.after(async () => {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  });

  const tunnel = await openSocket(socketPath);
  tunnel.write(
    `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n\r\n`,
  );
  assert.equal(await waitForStatus(tunnel), 200);
  tunnel.write(
    "GET /v1/responses HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Authorization: Bearer provider-secret\r\nConnection: close\r\n\r\n",
  );
  assert.equal(await waitForStatus(tunnel), 204);
  assert.deepEqual(upstreamRequests, [
    {
      authorization: "Bearer provider-secret",
      path: "/v1/responses",
    },
  ]);
  tunnel.destroy();
});
