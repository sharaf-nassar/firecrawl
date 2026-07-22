import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { get, createServer as createHttpServer } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";

import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

import { chromiumNetworkLaunchPolicy } from "./chromium-launch-policy.js";
import { createEgressProxy, type EgressDial } from "./egress-proxy.js";
import type { PublicLookup } from "./network-policy.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  let failure: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
});

describe.sequential("bundled Chromium egress", () => {
  test("proxies every exact hostile target and subresource class", async () => {
    const privateHits = { http: 0, tcp: 0, websocket: 0 };
    const privateSink = createHttpServer((_request, response) => {
      privateHits.http += 1;
      response.end("private");
    });
    privateSink.on("connection", () => {
      privateHits.tcp += 1;
    });
    const privateWs = new WebSocketServer({ noServer: true });
    privateSink.on("upgrade", (request, socket, head) => {
      privateWs.handleUpgrade(request, socket, head, (client) => {
        privateHits.websocket += 1;
        client.close();
      });
    });
    const privatePort = await listen(privateSink, "::");
    cleanups.push(() => closeWebSocketServer(privateWs));

    await directHttp(`http://127.0.0.1:${privatePort}/positive-v4`);
    await directHttp(`http://[::1]:${privatePort}/positive-v6`);
    await directWebSocket(`ws://127.0.0.1:${privatePort}/positive-v4`);
    await directWebSocket(`ws://[::1]:${privatePort}/positive-v6`);
    expect(privateHits.http).toBeGreaterThanOrEqual(2);
    expect(privateHits.tcp).toBeGreaterThanOrEqual(4);
    expect(privateHits.websocket).toBeGreaterThanOrEqual(2);
    privateHits.http = 0;
    privateHits.tcp = 0;
    privateHits.websocket = 0;

    const accepted = new Set<string>();
    let publicPort = 0;
    const publicOrigin = createHttpServer((request, response) => {
      const path = request.url ?? "/";
      if (path === "/") {
        accepted.add("top-level");
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><body>
          <script src="/script.js"></script><img src="/image.png">
          <iframe src="/iframe.html"></iframe><script>
            fetch('/fetch').catch(() => {});
            new Worker('/worker.js');
            new WebSocket('ws://public.test:${publicPort}/websocket');
            window.complete = new Promise(resolve => setTimeout(resolve, 400));
          </script></body>`);
        return;
      }
      if (path === "/redirect") {
        accepted.add("redirect");
        response.writeHead(302, {
          location: `http://private.test:${privatePort}/redirected`,
        });
        response.end();
        return;
      }
      const kind = path.slice(1).split(/[.?]/u)[0] ?? "unknown";
      accepted.add(kind);
      if (path.startsWith("/script") || path.startsWith("/worker")) {
        response.setHeader("content-type", "application/javascript");
        response.end("");
      } else if (path.startsWith("/image")) {
        response.setHeader("content-type", "image/png");
        response.end(Buffer.from("iVBORw0KGgo=", "base64"));
      } else {
        response.end("ok");
      }
    });
    publicPort = await listen(publicOrigin);
    const publicWs = new WebSocketServer({ noServer: true });
    publicOrigin.on("upgrade", (request, socket, head) => {
      accepted.add("websocket");
      publicWs.handleUpgrade(request, socket, head, (client) => client.close());
    });
    cleanups.push(() => closeWebSocketServer(publicWs));

    const decisions: Array<{ outcome: string; hostname: string }> = [];
    const lookupCalls: string[] = [];
    const lookup: PublicLookup = async (hostname) => {
      lookupCalls.push(hostname);
      return [
        {
          address: hostname === "private.test" ? "10.0.0.9" : "93.184.216.34",
          family: 4,
        },
      ];
    };
    const dial: EgressDial = ({ port, signal }) =>
      connect({
        allowHalfOpen: true,
        host: "127.0.0.1",
        port: port === privatePort ? privatePort : publicPort,
        signal,
      });
    const proxy = await createEgressProxy({
      lookup,
      dial,
      onDecision: (event) => decisions.push(event),
    });
    cleanups.push(proxy.close);
    const policy = chromiumNetworkLaunchPolicy(proxy.url);

    await withBrowser(policy, async (browser) => {
      const page = await browser.newPage();
      await page.goto(`http://public.test:${publicPort}/`);
      await page.evaluate(
        () => (window as Window & { complete: Promise<void> }).complete,
      );
      const beforeRedirect = blockedCount(decisions, "private.test");
      const beforeRedirectLookups = lookupCalls.length;
      await page
        .goto(`http://public.test:${publicPort}/redirect`, { timeout: 2_000 })
        .catch(() => undefined);
      expect(blockedCount(decisions, "private.test")).toBeGreaterThan(
        beforeRedirect,
      );
      expect(lookupCalls.slice(beforeRedirectLookups)).toEqual([
        "public.test",
        "private.test",
      ]);
    });

    const destinations = [
      "localhost",
      "127.0.0.2",
      "169.254.169.254",
      "[::1]",
      "[fe80::1]",
      "private.test",
    ] as const;
    const classes = [
      "script",
      "image",
      "fetch",
      "websocket",
      "iframe",
      "worker",
      "navigation",
    ] as const;
    for (const resourceClass of classes) {
      await withBrowser(policy, async (browser) => {
        const page = await browser.newPage();
        await page.goto(`http://public.test:${publicPort}/blank`);
        for (const [index, destination] of destinations.entries()) {
          const hostname = destination.replaceAll(/[\[\]]/gu, "");
          const previous = blockedCount(decisions, hostname);
          const url = `http://${destination}:${privatePort}/${resourceClass}-${index}`;
          await issueBlockedResource(browser, page, resourceClass, url);
          await expect
            .poll(() => blockedCount(decisions, hostname), {
              message: `${resourceClass}:${destination} bypassed proxy`,
              timeout: 2_000,
            })
            .toBeGreaterThan(previous);
        }
      });
    }

    expect([...accepted]).toEqual(
      expect.arrayContaining([
        "top-level",
        "script",
        "image",
        "fetch",
        "websocket",
        "iframe",
        "worker",
      ]),
    );
    for (const destination of destinations) {
      expect(decisions).toContainEqual({
        outcome: "blocked",
        hostname: destination.replaceAll(/[\[\]]/gu, ""),
      });
    }
    expect(privateHits).toEqual({ http: 0, tcp: 0, websocket: 0 });
  }, 60_000);

  test("isolates QUIC and WebRTC flags before full production policy", async () => {
    const quic = await udpSink();
    const stun = await udpSink();
    const unusedProxy = createNetServer((socket) => socket.destroy());
    const proxyPort = await listen(unusedProxy);
    const policy = chromiumNetworkLaunchPolicy(`http://127.0.0.1:${proxyPort}`);

    quic.reset();
    expect(await exerciseQuic(quic.port, [], quic.packets)).toBeGreaterThan(0);
    quic.reset();
    expect(
      await exerciseQuic(quic.port, ["--disable-quic"], quic.packets),
    ).toBe(0);
    quic.reset();
    expect(
      await exerciseQuic(
        quic.port,
        [...policy.args],
        quic.packets,
        policy.proxy,
      ),
    ).toBe(0);

    stun.reset();
    expect(await exerciseWebRtc(stun.port, [], stun.packets)).toBeGreaterThan(
      0,
    );
    stun.reset();
    expect(
      await exerciseWebRtc(
        stun.port,
        ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
        stun.packets,
      ),
    ).toBe(0);
    stun.reset();
    expect(
      await exerciseWebRtc(
        stun.port,
        [...policy.args],
        stun.packets,
        policy.proxy,
      ),
    ).toBe(0);
  }, 45_000);
});

async function withBrowser(
  policy: ReturnType<typeof chromiumNetworkLaunchPolicy>,
  operation: (browser: Browser) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({ headless: true, ...policy });
  try {
    await operation(browser);
  } finally {
    await browser.close();
  }
}

async function issueBlockedResource(
  browser: Browser,
  page: Page,
  resourceClass:
    | "script"
    | "image"
    | "fetch"
    | "websocket"
    | "iframe"
    | "worker"
    | "navigation",
  url: string,
): Promise<void> {
  if (resourceClass === "navigation") {
    const probe = await browser.newPage();
    try {
      await probe.goto(url, { timeout: 1_500 }).catch(() => undefined);
    } finally {
      await probe.close();
    }
    return;
  }
  await page.evaluate(
    async ({ resourceClass, url }) => {
      if (resourceClass === "fetch") {
        await fetch(url).catch(() => undefined);
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 750);
        const done = () => {
          clearTimeout(timeout);
          resolve();
        };
        if (resourceClass === "worker") {
          const source = URL.createObjectURL(
            new Blob([`importScripts(${JSON.stringify(url)})`], {
              type: "application/javascript",
            }),
          );
          const worker = new Worker(source);
          worker.onerror = done;
          setTimeout(() => {
            worker.terminate();
            URL.revokeObjectURL(source);
            done();
          }, 100);
          return;
        }
        if (resourceClass === "websocket") {
          const socket = new WebSocket(url.replace(/^http:/u, "ws:"));
          socket.onerror = done;
          socket.onclose = done;
          return;
        }
        const tag =
          resourceClass === "image"
            ? "img"
            : resourceClass === "iframe"
              ? "iframe"
              : "script";
        const element = document.createElement(tag);
        element.addEventListener("load", done, { once: true });
        element.addEventListener("error", done, { once: true });
        (
          element as HTMLImageElement | HTMLIFrameElement | HTMLScriptElement
        ).src = url;
        document.body.append(element);
      });
    },
    { resourceClass, url },
  );
}

async function exerciseQuic(
  port: number,
  args: string[],
  packets: () => number,
  proxy?: { server: string; bypass: string },
): Promise<number> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--host-resolver-rules=MAP quic.test 127.0.0.1",
      `--origin-to-force-quic-on=quic.test:${port}`,
      ...args,
    ],
    ...(proxy === undefined ? {} : { proxy }),
  });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page
      .goto(`https://quic.test:${port}/`, { timeout: 1_500 })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await browser.close();
  }
  return packets();
}

async function exerciseWebRtc(
  port: number,
  args: string[],
  packets: () => number,
  proxy?: { server: string; bypass: string },
): Promise<number> {
  const browser = await chromium.launch({
    headless: true,
    args,
    ...(proxy === undefined ? {} : { proxy }),
  });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>webrtc</title>");
    await page.evaluate(async (stunPort) => {
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: `stun:127.0.0.1:${stunPort}` }],
      });
      peer.createDataChannel("probe");
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve) => setTimeout(resolve, 800));
      peer.close();
    }, port);
  } finally {
    await browser.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return packets();
}

function blockedCount(
  decisions: Array<{ outcome: string; hostname: string }>,
  hostname: string,
): number {
  return decisions.filter(
    (decision) =>
      decision.outcome === "blocked" && decision.hostname === hostname,
  ).length;
}

async function directHttp(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = get(url, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", reject);
  });
}

async function directWebSocket(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new NodeWebSocket(url);
    socket.once("open", () => socket.close());
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

async function udpSink(): Promise<{
  port: number;
  packets: () => number;
  reset: () => void;
}> {
  const socket = createSocket("udp4");
  let count = 0;
  socket.on("message", () => {
    count += 1;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => closeUdp(socket));
  const address = socket.address();
  return {
    port: address.port,
    packets: () => count,
    reset: () => {
      count = 0;
    },
  };
}

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        server.closeAllConnections?.();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("TCP server did not bind");
  }
  return address.port;
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function closeUdp(socket: UdpSocket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}
