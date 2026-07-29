import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addressIsGlobal,
  addressesMatch,
  hostnameIsAllowed,
  parseClientHelloSni,
  parseConnectAuthority,
  validateResolvedAddresses,
} from "./egress-policy.mjs";

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

test("allowlist accepts only OpenAI and ChatGPT apexes and subdomains", () => {
  for (const hostname of [
    "openai.com",
    "api.openai.com",
    "chatgpt.com",
    "sub.auth.chatgpt.com.",
  ]) {
    assert.equal(hostnameIsAllowed(hostname), true);
  }
  for (const hostname of [
    "example.com",
    "evilopenai.com",
    "openai.com.example.com",
    "127.0.0.1",
    "169.254.169.254",
  ]) {
    assert.throws(() => {
      if (!hostnameIsAllowed(hostname)) throw new Error("denied");
    });
  }
});

test("CONNECT authority is canonical hostname port 443 only", () => {
  assert.deepEqual(parseConnectAuthority("api.openai.com:443"), {
    hostname: "api.openai.com",
    port: 443,
  });
  for (const authority of [
    "api.openai.com:80",
    "api.openai.com:0443",
    "user@api.openai.com:443",
    "127.0.0.1:443",
    "[::1]:443",
    "example.com:443",
  ]) {
    assert.throws(() => parseConnectAuthority(authority));
  }
});

test("address policy rejects local, LAN, link-local, metadata, and reserved", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
  ]) {
    assert.equal(addressIsGlobal(address), false, address);
  }
  assert.equal(addressIsGlobal("1.1.1.1"), true);
  assert.equal(addressIsGlobal("2606:4700:4700::1111"), true);
});

test("DNS validation fails closed for mixed public and private answers", () => {
  assert.deepEqual(
    validateResolvedAddresses([{ address: "1.1.1.1", family: 4 }]),
    [{ address: "1.1.1.1", family: 4 }],
  );
  assert.throws(() =>
    validateResolvedAddresses([
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
  );
});

test("peer comparison canonicalizes equivalent IPv6 addresses", () => {
  assert.equal(addressesMatch("1.1.1.1", "1.1.1.1"), true);
  assert.equal(
    addressesMatch("2606:4700:4700::1111", "2606:4700:4700:0:0:0:0:1111"),
    true,
  );
  assert.equal(addressesMatch("1.1.1.1", "1.0.0.1"), false);
});

test("TLS ClientHello parser requires bounded matching-capable SNI", () => {
  const hello = clientHello("chatgpt.com");
  assert.deepEqual(parseClientHelloSni(hello), {
    status: "complete",
    hostname: "chatgpt.com",
  });
  assert.deepEqual(parseClientHelloSni(hello.subarray(0, 12)), {
    status: "need_more",
  });
  assert.throws(() => parseClientHelloSni(Buffer.from("not tls")));
});
