import assert from "node:assert/strict";
import { test } from "node:test";

import { readConfig } from "./config.mjs";

const proxyEnvironment = Object.freeze({
  BROWSER_INTERACTION_WORKER_TOKEN: "T".repeat(43),
  MODEL_EGRESS_PROXY_SOCKET_PATH: "/run/firecrawl-model-egress/proxy.sock",
  HTTP_PROXY: "http://127.0.0.1:3128",
  HTTPS_PROXY: "http://127.0.0.1:3128",
  NO_PROXY: "",
  http_proxy: "http://127.0.0.1:3128",
  https_proxy: "http://127.0.0.1:3128",
  no_proxy: "",
});

test("worker accepts only its fixed loopback-to-UDS proxy configuration", () => {
  const config = readConfig(proxyEnvironment);
  assert.equal(
    config.egressProxySocketPath,
    "/run/firecrawl-model-egress/proxy.sock",
  );
  assert.equal(config.egressProxyHost, "127.0.0.1");
  assert.equal(config.egressProxyPort, 3128);
});

test("worker rejects proxy bypass environment changes", () => {
  for (const [name, value] of [
    ["HTTPS_PROXY", "http://proxy.example:3128"],
    ["NO_PROXY", "chatgpt.com"],
    ["no_proxy", "127.0.0.1"],
    ["MODEL_EGRESS_PROXY_SOCKET_PATH", "/tmp/proxy.sock"],
  ]) {
    assert.throws(() =>
      readConfig({ ...proxyEnvironment, [name]: value }),
    );
  }
});
