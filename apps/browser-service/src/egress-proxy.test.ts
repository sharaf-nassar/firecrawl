import { createServer as createHttpServer } from "node:http";
import { getEventListeners } from "node:events";
import { createServer as createHttpsServer } from "node:https";
import {
  connect,
  createServer as createNetServer,
  type Server,
} from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_CONNECT_DIRECTION_BYTES,
  MAX_CONNECT_TUNNELS,
  MAX_HTTP_BODY_BYTES,
  MAX_REQUEST_HEADER_BYTES,
  MAX_RESPONSE_HEADER_BYTES,
  PROXY_IDLE_TIMEOUT_MS,
  PROXY_MAX_LIFETIME_MS,
  createEgressProxy,
  createRestoreGate,
  proxyConnect,
  type EgressDial,
  type EgressProxyLimits,
} from "./egress-proxy.js";
import type { PublicLookup } from "./network-policy.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  let failure: unknown;
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
});

function lookup(...addresses: string[]): PublicLookup {
  return vi.fn(async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );
}

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

function dialLocal(port: number, addresses: string[] = []): EgressDial {
  return ({ address, signal }) => {
    addresses.push(address);
    return connect({ host: "127.0.0.1", port, signal });
  };
}

describe("pinned outbound dialing", () => {
  test("dials only the answer from the single checked lookup", async () => {
    const upstream = createNetServer((socket) => socket.end());
    const port = await listen(upstream);
    const addresses: string[] = [];
    const resolver = vi
      .fn<PublicLookup>()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

    const socket = await proxyConnect("example.test:8443", {
      lookup: resolver,
      dial: dialLocal(port, addresses),
    });
    socket.destroy();

    expect(addresses).toEqual(["93.184.216.34"]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test("does not try another DNS answer after the pinned dial fails", async () => {
    const dial = vi.fn<EgressDial>(() => {
      throw new Error("dial failed");
    });
    await expect(
      proxyConnect("example.test:443", {
        lookup: lookup("93.184.216.34", "93.184.216.35"),
        dial,
      }),
    ).rejects.toThrow("dial failed");
    expect(dial).toHaveBeenCalledTimes(1);
  });

  test("unlinks the parent signal after repeated dial failures", async () => {
    const root = new AbortController();
    const baseline = getEventListeners(root.signal, "abort").length;
    const dial = vi.fn<EgressDial>(() => {
      throw new Error("dial failed");
    });

    for (let index = 0; index < 32; index += 1) {
      await expect(
        proxyConnect("example.test:443", {
          lookup: lookup("93.184.216.34"),
          dial,
          signal: root.signal,
        }),
      ).rejects.toThrow("dial failed");
      expect(getEventListeners(root.signal, "abort")).toHaveLength(baseline);
    }
  });

  test("aborts a pending proxyConnect dial and unlinks its parent", async () => {
    const root = new AbortController();
    const baseline = getEventListeners(root.signal, "abort").length;
    let dialStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dialStarted = resolve;
    });
    const pending = proxyConnect("example.test:443", {
      lookup: lookup("93.184.216.34"),
      dial: () => {
        dialStarted();
        return new Promise(() => undefined);
      },
      signal: root.signal,
    });
    await started;
    root.abort();

    await expect(withDeadline(pending, 500)).rejects.toThrow();
    expect(getEventListeners(root.signal, "abort")).toHaveLength(baseline);
  });

  test("unlinks the parent after repeated connection-wait failures", async () => {
    const closedServer = createNetServer();
    const closedPort = await listen(closedServer);
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));
    const root = new AbortController();
    const baseline = getEventListeners(root.signal, "abort").length;

    for (let index = 0; index < 16; index += 1) {
      await expect(
        proxyConnect("example.test:443", {
          lookup: lookup("93.184.216.34"),
          dial: () => connect(closedPort, "127.0.0.1"),
          signal: root.signal,
        }),
      ).rejects.toThrow();
      expect(getEventListeners(root.signal, "abort")).toHaveLength(baseline);
    }
  });
});

describe("bounded loopback proxy", () => {
  test("enforces exact restore gate transitions and idempotent close", () => {
    const opened = createRestoreGate();
    opened.open();
    expect(opened.state).toBe("open");
    expect(() => opened.open()).toThrowError("restore_gate_invalid_state");
    opened.close();
    opened.close();
    expect(opened.state).toBe("closed");
    expect(() => opened.open()).toThrowError("restore_gate_invalid_state");
  });

  test("blocks closed ingress before DNS, policy, or dial", async () => {
    const resolver = lookup("93.184.216.34");
    const dial = vi.fn<EgressDial>();
    const decisions = vi.fn();
    const gate = createRestoreGate();
    const proxy = await createEgressProxy({
      lookup: resolver,
      dial,
      onDecision: decisions,
      restoreGate: gate,
    });
    closers.push(proxy.close);

    expect(
      await sendRaw(
        proxy.port,
        "GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\n\r\n",
      ),
    ).toContain("503 Service Unavailable");
    expect(gate.snapshot()).toEqual({
      state: "restore_closed",
      counters: {
        ingressAttempts: 1,
        ingressViolations: 1,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      },
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(decisions).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
    expect(() => gate.open()).toThrowError("restore_ingress_violation");
  });

  test("records only allowlisted ingress categories for every proxy entry", async () => {
    for (const fixture of [
      {
        request:
          "GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\n\r\n",
        category: "http",
      },
      {
        request:
          "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
        category: "connect",
      },
      {
        request:
          "GET ws://public.test/socket HTTP/1.1\r\nHost: public.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        category: "upgrade",
      },
    ] as const) {
      const gate = createRestoreGate();
      const resolver = lookup("93.184.216.34");
      const dial = vi.fn<EgressDial>();
      const proxy = await createEgressProxy({
        restoreGate: gate,
        lookup: resolver,
        dial,
      });
      closers.push(proxy.close);
      expect(await sendRaw(proxy.port, fixture.request)).toContain(
        "503 Service Unavailable",
      );
      expect(gate.recordedCategory).toBe(fixture.category);
      expect(gate.snapshot().counters).toMatchObject({
        ingressAttempts: 1,
        ingressViolations: 1,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      });
      expect(resolver).not.toHaveBeenCalled();
      expect(dial).not.toHaveBeenCalled();
    }
  });

  test("fails closed atomically on every restore counter overflow", () => {
    for (const counter of [
      "ingressAttempts",
      "ingressViolations",
      "dnsResolutions",
      "policyDecisions",
      "dials",
    ] as const) {
      const gate = createRestoreGate({ [counter]: Number.MAX_SAFE_INTEGER });
      let token: ReturnType<typeof gate.beginIngress> | undefined;
      if (!["ingressAttempts", "ingressViolations"].includes(counter)) {
        gate.open();
        token = gate.beginIngress("http", "http://requested.test/");
      }
      const before = gate.completeCounterSnapshot();
      const operation =
        counter === "ingressAttempts" || counter === "ingressViolations"
          ? () => gate.beginIngress("http")
          : counter === "dnsResolutions"
            ? () => gate.recordDnsResolution(token || undefined)
            : counter === "policyDecisions"
              ? () => gate.recordPolicyDecision(token || undefined)
              : () => gate.recordDial(token || undefined);
      expect(operation).toThrowError("restore_counter_overflow");
      expect(gate.state).toBe("closed");
      expect(gate.completeCounterSnapshot()).toEqual(before);
    }
  });

  test("isolates restore counters and records the post-open pipeline", async () => {
    const first = createRestoreGate();
    const second = createRestoreGate();
    const upstream = createHttpServer((_request, response) =>
      response.end("ok"),
    );
    const port = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(port),
      restoreGate: second,
    });
    closers.push(proxy.close);
    second.open();
    const baseline = second.markPositiveControlBaseline(
      `http://public.test:${port}/`,
    );
    expect(
      await sendRaw(
        proxy.port,
        `GET http://public.test:${port}/ HTTP/1.1\r\nHost: public.test:${port}\r\n\r\n`,
      ),
    ).toContain("200 OK");
    expect(second.snapshot().counters).toEqual({
      ingressAttempts: 1,
      ingressViolations: 0,
      dnsResolutions: 1,
      policyDecisions: 1,
      dials: 1,
    });
    expect(() =>
      second.assertPositiveControl(
        baseline,
        `http://public.test:${port}/`,
      ),
    ).not.toThrow();
    expect(() =>
      second.assertPositiveControl(baseline, `http://other.test:${port}/`),
    ).toThrowError("restore_ingress_violation");
    expect(first.snapshot().counters).toEqual({
      ingressAttempts: 0,
      ingressViolations: 0,
      dnsResolutions: 0,
      policyDecisions: 0,
      dials: 0,
    });
  });

  test("cannot combine pipeline evidence across ingress attempts", () => {
    const gate = createRestoreGate();
    gate.open();
    const baseline = gate.markPositiveControlBaseline(
      "http://requested.test/",
    );
    const requested = gate.beginIngress("http", "http://requested.test/");
    expect(requested).not.toBe(false);
    gate.recordDnsResolution(requested || undefined);
    gate.recordPolicyDecision(requested || undefined);

    const unrelated = gate.beginIngress("http", "http://unrelated.test/");
    expect(unrelated).not.toBe(false);
    gate.recordDnsResolution(unrelated || undefined);
    gate.recordPolicyDecision(unrelated || undefined);
    gate.recordDial(unrelated || undefined);

    expect(() =>
      gate.assertPositiveControl(baseline, "http://requested.test/"),
    ).toThrowError("restore_ingress_violation");
  });

  test("retains dedicated target evidence beyond the bounded attempt ring", () => {
    const gate = createRestoreGate();
    gate.open();
    const baseline = gate.markPositiveControlBaseline(
      "http://requested.test/",
    );
    const target = gate.beginIngress("http", "http://requested.test/");
    expect(target).not.toBe(false);

    for (let index = 0; index < 257; index += 1) {
      const subresource = gate.beginIngress(
        "http",
        `http://assets.test/${index}`,
      );
      expect(subresource).not.toBe(false);
      gate.recordDnsResolution(subresource || undefined);
      gate.recordPolicyDecision(subresource || undefined);
      gate.recordDial(subresource || undefined);
      gate.completeIngress(subresource || undefined!);
    }

    gate.recordDnsResolution(target || undefined);
    gate.recordPolicyDecision(target || undefined);
    gate.recordDial(target || undefined);
    gate.completeIngress(target || undefined!);

    expect(() =>
      gate.assertPositiveControl(baseline, "http://requested.test/"),
    ).not.toThrow();
  });

  test("keeps a slow active token while completed history rolls over", () => {
    const gate = createRestoreGate();
    gate.open();
    const slow = gate.beginIngress("http", "http://slow.test/");
    expect(slow).not.toBe(false);

    for (let index = 0; index < 257; index += 1) {
      const completed = gate.beginIngress(
        "http",
        `http://completed.test/${index}`,
      );
      expect(completed).not.toBe(false);
      gate.recordDnsResolution(completed || undefined);
      gate.recordPolicyDecision(completed || undefined);
      gate.recordDial(completed || undefined);
      gate.completeIngress(completed || undefined!);
    }

    expect(() => gate.recordDnsResolution(slow || undefined)).not.toThrow();
    expect(() => gate.recordPolicyDecision(slow || undefined)).not.toThrow();
    expect(() => gate.recordDial(slow || undefined)).not.toThrow();
    gate.completeIngress(slow || undefined!);
  });

  test("fails closed instead of evicting one of 256 active tokens", () => {
    const gate = createRestoreGate();
    gate.open();
    for (let index = 0; index < 256; index += 1) {
      expect(
        gate.beginIngress("http", `http://active.test/${index}`),
      ).not.toBe(false);
    }
    const before = gate.completeCounterSnapshot();

    expect(() =>
      gate.beginIngress("http", "http://active.test/overflow"),
    ).toThrowError("restore_ingress_violation");
    expect(gate.state).toBe("closed");
    expect(gate.completeCounterSnapshot()).toEqual(before);
  });

  test("authenticates a token before mutating stage counters", () => {
    const gate = createRestoreGate();
    gate.open();
    const token = gate.beginIngress("http", "http://active.test/");
    expect(token).not.toBe(false);
    const before = gate.completeCounterSnapshot();

    expect(() =>
      gate.recordDnsResolution({ sequence: token ? token.sequence : 0 }),
    ).toThrowError("restore_ingress_violation");
    expect(gate.completeCounterSnapshot()).toEqual(before);
  });

  test("latches a completed positive control before an incomplete retry", () => {
    const gate = createRestoreGate();
    gate.open();
    const url = "http://requested.test/";
    const baseline = gate.markPositiveControlBaseline(url);
    const completed = gate.beginIngress("http", url);
    expect(completed).not.toBe(false);
    gate.recordDnsResolution(completed || undefined);
    gate.recordPolicyDecision(completed || undefined);
    gate.recordDial(completed || undefined);
    gate.completeIngress(completed || undefined!);

    const incomplete = gate.beginIngress("http", url);
    expect(incomplete).not.toBe(false);
    gate.recordDnsResolution(incomplete || undefined);

    expect(() => gate.assertPositiveControl(baseline, url)).not.toThrow();
  });

  test("handles CONNECT policy-counter overflow before any dial", async () => {
    const gate = createRestoreGate({
      policyDecisions: Number.MAX_SAFE_INTEGER,
    });
    gate.open();
    const dial = vi.fn<EgressDial>();
    const proxy = await createEgressProxy({
      restoreGate: gate,
      lookup: lookup("93.184.216.34"),
      dial,
    });
    closers.push(proxy.close);
    const response = await sendRaw(
      proxy.port,
      "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
    );
    expect(response).toContain("503 Service Unavailable");
    expect(gate.state).toBe("closed");
    expect(dial).not.toHaveBeenCalled();
  });

  test("audits a domain-blocked CONNECT exactly once before dial", async () => {
    const gate = createRestoreGate();
    gate.open();
    const dial = vi.fn<EgressDial>();
    const onDecision = vi.fn();
    const proxy = await createEgressProxy({
      restoreGate: gate,
      allowedDomains: ["allowed.test"],
      lookup: lookup("93.184.216.34"),
      dial,
      onDecision,
    });
    closers.push(proxy.close);
    expect(
      await sendRaw(
        proxy.port,
        "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n",
      ),
    ).toContain("403 Forbidden");
    expect(gate.snapshot().counters).toEqual({
      ingressAttempts: 1,
      ingressViolations: 0,
      dnsResolutions: 1,
      policyDecisions: 1,
      dials: 0,
    });
    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith({
      outcome: "blocked",
      hostname: "public.test",
    });
    expect(dial).not.toHaveBeenCalled();
  });
  test("locks every production bound to its exact default", () => {
    expect(MAX_REQUEST_HEADER_BYTES).toBe(32 * 1024);
    expect(MAX_RESPONSE_HEADER_BYTES).toBe(64 * 1024);
    expect(MAX_HTTP_BODY_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_CONNECT_DIRECTION_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_CONNECT_TUNNELS).toBe(32);
    expect(PROXY_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(PROXY_MAX_LIFETIME_MS).toBe(3_600_000);
  });

  test("rejects every invalid numeric limit instead of coercing it", async () => {
    const limitCases: Array<{
      name: keyof EgressProxyLimits | "maxTunnels";
      maximum: number;
      options: (value: number) => Parameters<typeof createEgressProxy>[0];
    }> = [
      {
        name: "maxTunnels",
        maximum: MAX_CONNECT_TUNNELS,
        options: (maxTunnels) => ({ maxTunnels }),
      },
      {
        name: "tunnelDirectionBytes",
        maximum: MAX_CONNECT_DIRECTION_BYTES,
        options: (tunnelDirectionBytes) => ({
          limits: { tunnelDirectionBytes },
        }),
      },
      {
        name: "httpBodyBytes",
        maximum: MAX_HTTP_BODY_BYTES,
        options: (httpBodyBytes) => ({ limits: { httpBodyBytes } }),
      },
      {
        name: "responseHeaderBytes",
        maximum: MAX_RESPONSE_HEADER_BYTES,
        options: (responseHeaderBytes) => ({
          limits: { responseHeaderBytes },
        }),
      },
      {
        name: "idleTimeoutMs",
        maximum: PROXY_IDLE_TIMEOUT_MS,
        options: (idleTimeoutMs) => ({ limits: { idleTimeoutMs } }),
      },
      {
        name: "lifetimeMs",
        maximum: PROXY_MAX_LIFETIME_MS,
        options: (lifetimeMs) => ({ limits: { lifetimeMs } }),
      },
    ];
    const invalidBase = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5];

    for (const limitCase of limitCases) {
      for (const value of [...invalidBase, limitCase.maximum + 1]) {
        const outcome = await createEgressProxy(limitCase.options(value)).then(
          async (proxy) => {
            await proxy.close();
            return "accepted" as const;
          },
          () => "rejected" as const,
        );
        expect(outcome, `${limitCase.name} accepted ${String(value)}`).toBe(
          "rejected",
        );
      }
    }
  });

  test("rejects ws and wss schemes on the plain HTTP handler", async () => {
    const resolver = lookup("93.184.216.34");
    const dial = vi.fn<EgressDial>();
    const proxy = await createEgressProxy({ lookup: resolver, dial });
    closers.push(proxy.close);

    for (const scheme of ["ws", "wss"]) {
      const response = await sendRaw(
        proxy.port,
        `GET ${scheme}://public.test/socket HTTP/1.1\r\nHost: public.test\r\n\r\n`,
      );
      expect(response).toContain("400 Bad Request");
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });

  test("forwards absolute-form HTTP and strips proxy-only headers", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = createHttpServer((request, response) => {
      receivedHeaders = request.headers;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    const upstreamPort = await listen(upstream);
    const events: string[] = [];
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      onDecision: (event) => events.push(`${event.outcome}:${event.hostname}`),
    });
    closers.push(proxy.close);

    const raw = await sendRaw(
      proxy.port,
      `GET http://public.test:${upstreamPort}/hello HTTP/1.1\r\n` +
        `Host: public.test:${upstreamPort}\r\n` +
        "Proxy-Authorization: secret\r\nProxy-Connection: keep-alive\r\n\r\n",
    );
    expect(raw).toContain("200 OK");
    expect(raw).toContain("ok");
    expect(receivedHeaders.host).toBe(`public.test:${upstreamPort}`);
    expect(receivedHeaders["proxy-authorization"]).toBeUndefined();
    expect(receivedHeaders["proxy-connection"]).toBeUndefined();
    expect(events).toContain("allowed:public.test");
  });

  test("rejects origin-form, credentials, blocked targets, and CONNECT smuggling", async () => {
    const proxy = await createEgressProxy({
      lookup: lookup("127.0.0.1"),
      dial: vi.fn<EgressDial>(),
    });
    closers.push(proxy.close);

    expect(
      await sendRaw(proxy.port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n"),
    ).toContain("400 Bad Request");
    expect(
      await sendRaw(
        proxy.port,
        "GET http://user:secret@example.test/ HTTP/1.1\r\nHost: x\r\n\r\n",
      ),
    ).toContain("403 Forbidden");
    expect(
      await sendRaw(
        proxy.port,
        "CONNECT example.test:443/path HTTP/1.1\r\nHost: x\r\n\r\n",
      ),
    ).toContain("400 Bad Request");
    expect(
      await sendRaw(
        proxy.port,
        "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
      ),
    ).toContain("403 Forbidden");
  });

  test("rejects conflicting framing and CONNECT authority headers before resolution", async () => {
    const resolver = lookup("93.184.216.34");
    const dial = vi.fn<EgressDial>();
    const proxy = await createEgressProxy({ lookup: resolver, dial });
    closers.push(proxy.close);

    const conflict = await sendRaw(
      proxy.port,
      "POST http://public.test/ HTTP/1.1\r\nHost: public.test\r\n" +
        "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    );
    expect(conflict).toMatch(/400 Bad Request|431 Request Header/u);

    for (const request of [
      "CONNECT public.test:443 HTTP/1.1\r\nHost: other.test:443\r\n\r\n",
      "CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n" +
        "Host: public.test:443\r\n\r\n",
    ]) {
      expect(await sendRaw(proxy.port, request)).toContain("400 Bad Request");
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });

  test("rejects oversized request headers and releases CONNECT slots", async () => {
    const upstream = createNetServer(() => undefined);
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      maxTunnels: 1,
    });
    closers.push(proxy.close);

    const oversized = await sendRaw(
      proxy.port,
      `GET http://public.test:${upstreamPort}/ HTTP/1.1\r\nX: ${"a".repeat(33 * 1024)}\r\n\r\n`,
    );
    expect(oversized).toContain("431 Request Header Fields Too Large");

    const first = connect(proxy.port, "127.0.0.1");
    first.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\nHost: public.test:${upstreamPort}\r\n\r\n`,
    );
    await waitForData(first, "200 Connection Established");
    const busy = await sendRaw(
      proxy.port,
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\nHost: public.test:${upstreamPort}\r\n\r\n`,
    );
    expect(busy).toContain("503 Service Unavailable");
    first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = connect(proxy.port, "127.0.0.1");
    second.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\nHost: public.test:${upstreamPort}\r\n\r\n`,
    );
    expect(await waitForData(second, "200 Connection Established")).toContain(
      "200 Connection Established",
    );
    second.destroy();
  });

  test("rejects a declared HTTP body over 32 MiB before dialing", async () => {
    const dial = vi.fn<EgressDial>();
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial,
    });
    closers.push(proxy.close);

    const response = await sendRaw(
      proxy.port,
      "POST http://public.test/upload HTTP/1.1\r\n" +
        "Host: public.test\r\nContent-Length: 33554433\r\n\r\n",
    );
    expect(response).toContain("413 Payload Too Large");
    expect(dial).not.toHaveBeenCalled();
  });

  test("cancels open tunnels and half-closes both directions", async () => {
    let upstreamEnded = false;
    const upstream = createNetServer((socket) => {
      socket.on("end", () => {
        upstreamEnded = true;
        socket.end();
      });
    });
    const upstreamPort = await listen(upstream);
    const controller = new AbortController();
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      signal: controller.signal,
    });
    closers.push(proxy.close);

    const client = connect(proxy.port, "127.0.0.1");
    client.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\nHost: public.test:${upstreamPort}\r\n\r\n`,
    );
    await waitForData(client, "200 Connection Established");
    client.end();
    await vi.waitFor(() => expect(upstreamEnded).toBe(true));

    const cancelled = connect(proxy.port, "127.0.0.1");
    cancelled.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\nHost: public.test:${upstreamPort}\r\n\r\n`,
    );
    await waitForData(cancelled, "200 Connection Established");
    controller.abort();
    await new Promise<void>((resolve) =>
      cancelled.once("close", () => resolve()),
    );
  });

  test("bounds DNS resolution by the private deadline", async () => {
    const proxy = await createEgressProxy({
      lookup: () => new Promise(() => undefined),
      deadlineAtMs: Date.now() + 40,
    });
    closers.push(proxy.close);

    const result = await Promise.race([
      sendRaw(
        proxy.port,
        "GET http://waiting.test/ HTTP/1.1\r\nHost: waiting.test\r\n\r\n",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("deadline-not-enforced"), 300),
      ),
    ]);
    expect(result).not.toBe("deadline-not-enforced");
  });

  test("removes every root abort listener after successful requests", async () => {
    const upstream = createHttpServer((_request, response) =>
      response.end("ok"),
    );
    const upstreamPort = await listen(upstream);
    const root = new AbortController();
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      signal: root.signal,
    });
    closers.push(proxy.close);

    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      const baseline = getEventListeners(root.signal, "abort").length;
      for (let index = 0; index < 25; index += 1) {
        const response = await sendRaw(
          proxy.port,
          "GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\n\r\n",
        );
        expect(response).toContain("200 OK");
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(getEventListeners(root.signal, "abort")).toHaveLength(baseline);
    } finally {
      process.removeListener("warning", onWarning);
    }
    expect(
      warnings.filter(
        (warning) => warning.name === "MaxListenersExceededWarning",
      ),
    ).toEqual([]);
  });

  test("preserves reverse writes after client FIN and forward writes after upstream FIN", async () => {
    const upstreamSockets: import("node:net").Socket[] = [];
    const upstreamReceived: Buffer[][] = [];
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      const received: Buffer[] = [];
      upstreamSockets.push(socket);
      upstreamReceived.push(received);
      socket.on("data", (chunk) => received.push(chunk));
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: ({ signal }) =>
        connect({
          allowHalfOpen: true,
          host: "127.0.0.1",
          port: upstreamPort,
          signal,
        }),
    });
    closers.push(proxy.close);

    const clientOne = connect({
      allowHalfOpen: true,
      host: "127.0.0.1",
      port: proxy.port,
    });
    clientOne.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\nHost: public.test:${upstreamPort}\r\n\r\n`,
    );
    await waitForData(clientOne, "200 Connection Established");
    clientOne.write("before-client-fin");
    clientOne.end();
    await vi.waitFor(() =>
      expect(upstreamSockets[0]?.readableEnded).toBe(true),
    );
    const reverseData = waitForData(clientOne, "after-client-fin");
    upstreamSockets[0]?.write("after-client-fin");
    expect(await reverseData).toContain("after-client-fin");
    upstreamSockets[0]?.end();
    await new Promise<void>((resolve) => clientOne.once("close", resolve));

    const clientTwo = connect({
      allowHalfOpen: true,
      host: "127.0.0.1",
      port: proxy.port,
    });
    clientTwo.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\nHost: public.test:${upstreamPort}\r\n\r\n`,
    );
    await waitForData(clientTwo, "200 Connection Established");
    const clientEnded = new Promise<void>((resolve) =>
      clientTwo.once("end", resolve),
    );
    upstreamSockets[1]?.end();
    await clientEnded;
    clientTwo.write("after-upstream-fin");
    await vi.waitFor(() =>
      expect(Buffer.concat(upstreamReceived[1] ?? []).toString()).toContain(
        "after-upstream-fin",
      ),
    );
    clientTwo.end();
    await new Promise<void>((resolve) => clientTwo.once("close", resolve));
  });

  test("rejects upgrade heads before writing and recovers the slot", async () => {
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () =>
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n" +
            "too-large-upstream-head",
        ),
      );
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      maxTunnels: 1,
      limits: { tunnelDirectionBytes: 4 },
    });
    closers.push(proxy.close);

    const clientHead = await sendUpgrade(proxy.port, upstreamPort, "12345");
    expect(clientHead).toBe("");

    const upstreamHead = await sendUpgrade(proxy.port, upstreamPort, "");
    expect(upstreamHead).toBe("");
  });

  test("strips nominated upgrade response headers and caps them at 64 KiB", async () => {
    let oversized = false;
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () => {
        if (oversized) {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n" +
              "Upgrade: websocket\r\nX-Large: " +
              "a".repeat(MAX_RESPONSE_HEADER_BYTES) +
              "\r\n\r\n",
          );
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade, X-Hop\r\nUpgrade: websocket\r\n" +
            "X-Hop: secret\r\nProxy-Authenticate: secret\r\n" +
            "Sec-WebSocket-Accept: retained\r\n\r\n",
        );
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
    });
    closers.push(proxy.close);

    const safe = await sendUpgrade(proxy.port, upstreamPort, "");
    expect(safe).toContain("101 Switching Protocols");
    expect(safe.toLowerCase()).toContain("connection: upgrade");
    expect(safe.toLowerCase()).toContain("upgrade: websocket");
    expect(safe.toLowerCase()).toContain("sec-websocket-accept: retained");
    expect(safe.toLowerCase()).not.toContain("x-hop");
    expect(safe.toLowerCase()).not.toContain("proxy-authenticate");

    oversized = true;
    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toBe("");
  });

  test("rejects conflicting upstream response framing before forwarding", async () => {
    const upstream = createNetServer((socket) => {
      socket.once("data", () =>
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n" +
            "Transfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n",
        ),
      );
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
    });
    closers.push(proxy.close);

    const response = await sendRaw(
      proxy.port,
      `GET http://public.test:${upstreamPort}/ HTTP/1.1\r\n` +
        `Host: public.test:${upstreamPort}\r\n\r\n`,
    );
    expect(response).toContain("502 Bad Gateway");
    expect(response).not.toContain("200 OK");
  });

  test("enforces 32 shared tunnel slots and releases each exactly once", async () => {
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () =>
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
      );
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
    });
    closers.push(proxy.close);

    const clients: import("node:net").Socket[] = [];
    for (let index = 0; index < MAX_CONNECT_TUNNELS; index += 1) {
      clients.push(
        await openUpgrade(proxy.port, upstreamPort, `slot-${index}`),
      );
    }
    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toContain(
      "503 Service Unavailable",
    );

    const released = clients.pop();
    const releasedClosed = new Promise<void>((resolve) =>
      released?.once("close", resolve),
    );
    released?.resetAndDestroy();
    await releasedClosed;
    await expect
      .poll(
        async () =>
          (await sendUpgrade(proxy.port, upstreamPort, "")).includes(
            "101 Switching Protocols",
          ),
        { timeout: 2_000 },
      )
      .toBe(true);
    for (const client of clients) client.destroy();
  }, 20_000);

  test("failed upgrades and deadline aborts release their slot", async () => {
    let accept = false;
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        if (!accept) {
          socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
    });
    const upstreamPort = await listen(upstream);
    let lookupCall = 0;
    const resolver: PublicLookup = async () => {
      lookupCall += 1;
      if (lookupCall === 33) return new Promise(() => undefined);
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const proxy = await createEgressProxy({
      lookup: resolver,
      dial: dialLocal(upstreamPort),
      maxTunnels: 1,
      limits: { lifetimeMs: 30 },
    });
    closers.push(proxy.close);

    for (let index = 0; index < 32; index += 1) {
      expect(await sendUpgrade(proxy.port, upstreamPort, "")).toBe("");
    }
    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toBe("");
    accept = true;
    await expect
      .poll(
        async () =>
          (await sendUpgrade(proxy.port, upstreamPort, "")).includes(
            "101 Switching Protocols",
          ),
        { timeout: 2_000 },
      )
      .toBe(true);
  }, 20_000);

  test("cancels 32 hanging upgrade lookups before any late dial", async () => {
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () =>
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
      );
    });
    const upstreamPort = await listen(upstream);
    const pendingLookups: Array<
      (answers: Awaited<ReturnType<PublicLookup>>) => void
    > = [];
    let accept = false;
    const resolver: PublicLookup = () => {
      if (accept) {
        return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
      }
      return new Promise((resolve) => pendingLookups.push(resolve));
    };
    const dial = vi.fn(dialLocal(upstreamPort));
    const proxy = await createEgressProxy({
      lookup: resolver,
      dial,
      maxTunnels: 1,
    });
    closers.push(proxy.close);

    for (let index = 0; index < 32; index += 1) {
      const client = openUpgradeAttempt(proxy.port, upstreamPort);
      await vi.waitFor(() => expect(pendingLookups).toHaveLength(index + 1));
      const terminated = waitForTermination(client);
      client.resetAndDestroy();
      await withDeadline(terminated, 500);
    }

    accept = true;
    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toContain(
      "101 Switching Protocols",
    );
    expect(dial).toHaveBeenCalledTimes(1);
    for (const resolve of pendingLookups) {
      resolve([{ address: "93.184.216.34", family: 4 }]);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(dial).toHaveBeenCalledTimes(1);
  });

  test("cancels a delayed upgrade dial and destroys its late socket", async () => {
    let upgradeRequests = 0;
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () => {
        upgradeRequests += 1;
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
    });
    const upstreamPort = await listen(upstream);
    let resolveDial!: (socket: ReturnType<typeof connect>) => void;
    let dialCalls = 0;
    const delayedDial = new Promise<ReturnType<typeof connect>>((resolve) => {
      resolveDial = resolve;
    });
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: (options) => {
        dialCalls += 1;
        if (dialCalls === 1) return delayedDial;
        return dialLocal(upstreamPort)(options);
      },
      maxTunnels: 1,
    });
    closers.push(proxy.close);

    const cancelled = openUpgradeAttempt(proxy.port, upstreamPort);
    await vi.waitFor(() => expect(dialCalls).toBe(1));
    const cancelledDone = waitForTermination(cancelled);
    cancelled.resetAndDestroy();
    await withDeadline(cancelledDone, 500);
    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toContain(
      "101 Switching Protocols",
    );

    const lateSocket = connect(upstreamPort, "127.0.0.1");
    lateSocket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      lateSocket.once("connect", resolve);
      lateSocket.once("error", reject);
    });
    const lateClosed = waitForTermination(lateSocket);
    resolveDial(lateSocket);
    await withDeadline(lateClosed, 500);
    expect(lateSocket.destroyed).toBe(true);
    expect(upgradeRequests).toBe(1);
  });

  test("aborts 32 pre-101 requests and ignores every late response", async () => {
    const heldSockets: Array<ReturnType<typeof connect>> = [];
    let accept = false;
    const upstream = createNetServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        if (accept) {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
          return;
        }
        heldSockets.push(socket);
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      maxTunnels: 1,
    });
    closers.push(proxy.close);

    for (let index = 0; index < 32; index += 1) {
      const client = openUpgradeAttempt(proxy.port, upstreamPort);
      await vi.waitFor(() => expect(heldSockets).toHaveLength(index + 1));
      const upstreamClosed = waitForClose(heldSockets[index]!);
      client.resetAndDestroy();
      await withDeadline(upstreamClosed, 500);
      expect(heldSockets[index]!.destroyed).toBe(true);
      expect(
        heldSockets[index]!.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
      ).toBe(false);
    }

    accept = true;
    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toContain(
      "101 Switching Protocols",
    );
  });

  test("observes delayed unsafe upgrade output until terminal rejection", async () => {
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () => {
        setTimeout(
          () =>
            socket.write(
              "HTTP/1.1 101 Switching Protocols\r\n" +
                "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n" +
                "oversized",
            ),
          150,
        );
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      limits: { tunnelDirectionBytes: 4 },
    });
    closers.push(proxy.close);

    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toBe("");
  });

  test("waits for a delayed explicit upgrade response", async () => {
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.once("data", () => {
        setTimeout(
          () =>
            socket.write(
              "HTTP/1.1 101 Switching Protocols\r\n" +
                "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            ),
          150,
        );
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
    });
    closers.push(proxy.close);

    expect(await sendUpgrade(proxy.port, upstreamPort, "")).toContain(
      "101 Switching Protocols",
    );
  });

  test("caps streamed HTTP and CONNECT bodies before forwarding overflow", async () => {
    const httpBodies: Buffer[] = [];
    const httpUpstream = createHttpServer((request, response) => {
      request.on("data", (chunk) => httpBodies.push(chunk));
      if (request.url === "/response") response.end("12345");
      else response.end("ok");
    });
    const httpPort = await listen(httpUpstream);
    const httpProxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(httpPort),
      limits: { httpBodyBytes: 4 },
    });
    closers.push(httpProxy.close);

    await sendRaw(
      httpProxy.port,
      `POST http://public.test:${httpPort}/request HTTP/1.1\r\n` +
        `Host: public.test:${httpPort}\r\nTransfer-Encoding: chunked\r\n\r\n` +
        "5\r\n12345\r\n0\r\n\r\n",
    );
    expect(Buffer.concat(httpBodies).length).toBeLessThanOrEqual(4);
    const response = await sendRaw(
      httpProxy.port,
      `GET http://public.test:${httpPort}/response HTTP/1.1\r\n` +
        `Host: public.test:${httpPort}\r\n\r\n`,
    );
    expect(response).not.toContain("12345");

    const tunnelBodies: Buffer[] = [];
    let tunnelSocket: import("node:net").Socket | undefined;
    const tunnelUpstream = createNetServer(
      { allowHalfOpen: true },
      (socket) => {
        tunnelSocket = socket;
        socket.on("data", (chunk) => tunnelBodies.push(chunk));
      },
    );
    const tunnelPort = await listen(tunnelUpstream);
    const tunnelProxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(tunnelPort),
      limits: { tunnelDirectionBytes: 4 },
    });
    closers.push(tunnelProxy.close);
    const client = connect({
      allowHalfOpen: true,
      host: "127.0.0.1",
      port: tunnelProxy.port,
    });
    client.write(
      `CONNECT public.test:${tunnelPort} HTTP/1.1\r\n` +
        `Host: public.test:${tunnelPort}\r\n\r\n`,
    );
    await waitForData(client, "200 Connection Established");
    const clientClosed = waitForTermination(client);
    client.write("12345");
    await clientClosed;
    client.destroy();
    expect(Buffer.concat(tunnelBodies).length).toBeLessThanOrEqual(4);

    const reverseClient = connect({
      allowHalfOpen: true,
      host: "127.0.0.1",
      port: tunnelProxy.port,
    });
    reverseClient.write(
      `CONNECT public.test:${tunnelPort} HTTP/1.1\r\n` +
        `Host: public.test:${tunnelPort}\r\n\r\n`,
    );
    await waitForData(reverseClient, "200 Connection Established");
    let reverse = "";
    reverseClient.on("data", (chunk) => {
      reverse += chunk.toString();
    });
    const reverseClosed = waitForTermination(reverseClient);
    tunnelSocket?.write("12345");
    await reverseClosed;
    reverseClient.destroy();
    expect(reverse).not.toContain("12345");
  });

  test("enforces the exact 32 MiB default on streamed HTTP bodies", async () => {
    let requestBytes = 0;
    const overflowBytes = MAX_HTTP_BODY_BYTES + 1024 * 1024;
    const upstream = createHttpServer((request, response) => {
      request.on("data", (chunk) => {
        requestBytes += chunk.length;
      });
      if (request.url === "/response") {
        response.writeHead(200, { "content-length": String(overflowBytes) });
        for (let index = 0; index < 33; index += 1) {
          response.write(Buffer.alloc(1024 * 1024));
        }
        response.end();
      } else {
        request.once("end", () => response.end("ok"));
      }
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
    });
    closers.push(proxy.close);

    await streamChunkedOverflow(proxy.port, upstreamPort);
    expect(requestBytes).toBeLessThanOrEqual(MAX_HTTP_BODY_BYTES);
    const responseBytes = await countRawResponseBody(
      proxy.port,
      `GET http://public.test:${upstreamPort}/response HTTP/1.1\r\n` +
        `Host: public.test:${upstreamPort}\r\nConnection: close\r\n\r\n`,
    );
    expect(responseBytes).toBeLessThanOrEqual(MAX_HTTP_BODY_BYTES);
  }, 20_000);

  test("applies idle timeout and backpressure to stalled tunnels", async () => {
    let upstreamSocket: import("node:net").Socket | undefined;
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      upstreamSocket = socket;
      socket.pause();
    });
    const upstreamPort = await listen(upstream);
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      limits: { idleTimeoutMs: 100, tunnelDirectionBytes: 8 * 1024 * 1024 },
    });
    closers.push(proxy.close);
    const client = connect({
      allowHalfOpen: true,
      host: "127.0.0.1",
      port: proxy.port,
    });
    client.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\n` +
        `Host: public.test:${upstreamPort}\r\n\r\n`,
    );
    await waitForData(client, "200 Connection Established");
    const clientClosed = waitForTermination(client);
    let backpressured = false;
    for (let index = 0; index < 128; index += 1) {
      if (!client.write(Buffer.alloc(64 * 1024))) {
        backpressured = true;
        break;
      }
    }
    expect(backpressured).toBe(true);
    upstreamSocket?.resume();
    await clientClosed;
    client.destroy();
  });

  test("propagates reverse tunnel backpressure and resumes cleanly", async () => {
    let upstreamSocket: import("node:net").Socket | undefined;
    const upstream = createNetServer({ allowHalfOpen: true }, (socket) => {
      upstreamSocket = socket;
    });
    const upstreamPort = await listen(upstream);
    const root = new AbortController();
    const proxy = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      signal: root.signal,
      maxTunnels: 1,
    });
    closers.push(proxy.close);
    const baseline = getEventListeners(root.signal, "abort").length;
    const client = connect({
      allowHalfOpen: true,
      host: "127.0.0.1",
      port: proxy.port,
    });
    client.write(
      `CONNECT public.test:${upstreamPort} HTTP/1.1\r\n` +
        `Host: public.test:${upstreamPort}\r\n\r\n`,
    );
    await waitForData(client, "200 Connection Established");
    await vi.waitFor(() => expect(upstreamSocket).toBeDefined());
    client.pause();

    let blockedDrain: Promise<void> | undefined;
    for (let index = 0; index < 1024; index += 1) {
      if (!upstreamSocket!.write(Buffer.alloc(64 * 1024))) {
        const drained = new Promise<void>((resolve) =>
          upstreamSocket!.once("drain", resolve),
        );
        const remainedBlocked = await Promise.race([
          drained.then(() => false),
          new Promise<true>((resolve) => setTimeout(() => resolve(true), 25)),
        ]);
        if (remainedBlocked) {
          blockedDrain = drained;
          break;
        }
      }
    }
    expect(blockedDrain).toBeDefined();
    expect(upstreamSocket!.writableNeedDrain).toBe(true);
    client.resume();
    await withDeadline(blockedDrain!, 2_000);

    const clientClosed = waitForTermination(client);
    upstreamSocket!.end();
    client.end();
    await withDeadline(clientClosed, 2_000);
    await vi.waitFor(() =>
      expect(getEventListeners(root.signal, "abort")).toHaveLength(baseline),
    );
  });

  test("pins HTTPS and WSS dials while preserving Host, SNI, and trust", async () => {
    const hosts: string[] = [];
    const serverNames: string[] = [];
    const upstream = createHttpsServer(
      { cert: TLS_CERTIFICATE, key: TLS_PRIVATE_KEY },
      (request, response) => {
        hosts.push(request.headers.host ?? "");
        serverNames.push(
          (request.socket as import("node:tls").TLSSocket).servername,
        );
        response.end("tls-ok");
      },
    );
    upstream.on("upgrade", (request, socket) => {
      hosts.push(request.headers.host ?? "");
      serverNames.push((socket as import("node:tls").TLSSocket).servername);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    const upstreamPort = await listen(upstream);
    const dialed: string[] = [];
    const trusted = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort, dialed),
      tlsCa: TLS_CERTIFICATE,
    });
    closers.push(trusted.close);

    const httpsResponse = await sendRaw(
      trusted.port,
      `GET https://public.test:${upstreamPort}/ HTTP/1.1\r\n` +
        `Host: ignored.test:${upstreamPort}\r\n\r\n`,
    );
    expect(httpsResponse).toContain("200 OK");
    expect(httpsResponse).toContain("tls-ok");
    expect(await sendUpgrade(trusted.port, upstreamPort, "", "wss")).toContain(
      "101 Switching Protocols",
    );
    expect(dialed).toEqual(["93.184.216.34", "93.184.216.34"]);
    expect(hosts).toEqual([
      `public.test:${upstreamPort}`,
      `public.test:${upstreamPort}`,
    ]);
    expect(serverNames).toEqual(["public.test", "public.test"]);

    const wrongName = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
      tlsCa: TLS_CERTIFICATE,
    });
    closers.push(wrongName.close);
    expect(
      await sendRaw(
        wrongName.port,
        `GET https://wrong.test:${upstreamPort}/ HTTP/1.1\r\n` +
          `Host: wrong.test:${upstreamPort}\r\n\r\n`,
      ),
    ).toContain("502 Bad Gateway");

    const untrusted = await createEgressProxy({
      lookup: lookup("93.184.216.34"),
      dial: dialLocal(upstreamPort),
    });
    closers.push(untrusted.close);
    expect(
      await sendRaw(
        untrusted.port,
        `GET https://public.test:${upstreamPort}/ HTTP/1.1\r\n` +
          `Host: public.test:${upstreamPort}\r\n\r\n`,
      ),
    ).toContain("502 Bad Gateway");
  });
});

async function sendRaw(port: number, request: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  const wireRequest = request.startsWith("CONNECT ")
    ? request
    : request.replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n");
  socket.write(wireRequest);
  let response = "";
  for await (const chunk of socket) response += chunk.toString();
  return response;
}

async function waitForData(socket: ReturnType<typeof connect>, text: string) {
  let response = "";
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`missing ${text}`)),
      5_000,
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes(text)) {
        clearTimeout(timeout);
        resolve(response);
      }
    });
    socket.once("error", reject);
  });
}

async function sendUpgrade(
  proxyPort: number,
  targetPort: number,
  head: string,
  scheme = "ws",
): Promise<string> {
  const socket = openUpgradeAttempt(proxyPort, targetPort, head, scheme);
  let output = "";
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("upgrade did not reach a terminal protocol outcome"));
    }, 2_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      socket.removeListener("end", finish);
      socket.removeListener("close", finish);
      socket.removeListener("error", finish);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\r\n\r\n")) finish();
    };
    socket.on("data", onData);
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", finish);
  });
  socket.destroy();
  return output;
}

function openUpgradeAttempt(
  proxyPort: number,
  targetPort: number,
  head = "",
  scheme = "ws",
): ReturnType<typeof connect> {
  const socket = connect({
    allowHalfOpen: true,
    host: "127.0.0.1",
    port: proxyPort,
  });
  socket.on("error", () => undefined);
  socket.write(
    `GET ${scheme}://public.test:${targetPort}/socket HTTP/1.1\r\n` +
      `Host: public.test:${targetPort}\r\nConnection: Upgrade\r\n` +
      `Upgrade: websocket\r\n\r\n${head}`,
  );
  return socket;
}

function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`operation exceeded ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const TLS_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDNTCCAh2gAwIBAgIUK10io99gT4rZVfghQ3Hhi/ueX54wDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLcHVibGljLnRlc3QwHhcNMjYwNzIyMDM1MTA3WhcNMzYw
NzE5MDM1MTA3WjAWMRQwEgYDVQQDDAtwdWJsaWMudGVzdDCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAKIXohXdXBUQ0fp6bQKIZfXdRhx6WfKtKWjureZo
Sblwn/G1BV0knxBxV/mwtDFT+gm59KaL9d0Iu2PdTnNytgks6brHb/Uz5Li5xxQa
ivlrC4aZ4LvWIRp+TknYm5OzeH3Q2TSqA1wHDBRoFp3yXuqrX+yTFt3PJFqVrZrv
1Tw1Ybl0v98D31dHk6KSyrZQNwY9oI9i5YDUMDqIA7C8fjR7HLUHTTYG9Xc9c7Bh
9sJt75ih9wQ/6GoZ8nyDP51I75uBxwgRaiH59yAHscF0S+63B6Q7tubB0lIJA+EE
+y1KezVSlYajn31AqNI7IZqCebeE28jBSWDP3lBqC71gELMCAwEAAaN7MHkwHQYD
VR0OBBYEFMuNJraf/of8s6BwkPA9rdy0+74LMB8GA1UdIwQYMBaAFMuNJraf/of8
s6BwkPA9rdy0+74LMBYGA1UdEQQPMA2CC3B1YmxpYy50ZXN0MA8GA1UdEwEB/wQF
MAMBAf8wDgYDVR0PAQH/BAQDAgKkMA0GCSqGSIb3DQEBCwUAA4IBAQBfZ/WqkAGR
GfO8fWYwhZVQ1kTv48A/OyNu1V7x9S0mkw0YMAMzqM3a/Ht/yVJPxBLvVyPqAZnK
vdxXEZahdEKHTBxQcVtxaWG6nnKiqbrnYrii7LIfVuz3S1mbJmNHMlRwZaJ0iaj8
C036IciwjpQg40M+2ZOeuxsFr/2dO9mjStKWJ+Jkp4eh6uELHaGaOCnZCKj0p7Wc
nlg296NhqQhwvnGoFCfj/M2zeoCL7+qSMX6y6DUoCFcAf88FwZp1QNVE1QAkA9QW
WHcAIZiYEbt2lhsmE8O4+RDMD7+bHaP1htcwGvFmEoxfjSa0/jgAEbWJClBzRffi
GZsg9jo+h5X6
-----END CERTIFICATE-----`;

const TLS_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCiF6IV3VwVENH6
em0CiGX13UYcelnyrSlo7q3maEm5cJ/xtQVdJJ8QcVf5sLQxU/oJufSmi/XdCLtj
3U5zcrYJLOm6x2/1M+S4uccUGor5awuGmeC71iEafk5J2JuTs3h90Nk0qgNcBwwU
aBad8l7qq1/skxbdzyRala2a79U8NWG5dL/fA99XR5Oiksq2UDcGPaCPYuWA1DA6
iAOwvH40exy1B002BvV3PXOwYfbCbe+YofcEP+hqGfJ8gz+dSO+bgccIEWoh+fcg
B7HBdEvutwekO7bmwdJSCQPhBPstSns1UpWGo599QKjSOyGagnm3hNvIwUlgz95Q
agu9YBCzAgMBAAECggEAFfNuYK35Y47uE2YomhBfrR6Z+Tmmhw3lOY/NHr1JHU2q
aLYTiQwbEG57tAA2lCbjtGp+6QkI3Ys/rqP7P6OCvGuyfA1jKjPXXx7QM3buvXKT
fSxx5JjNzdkvVU0ksH68VrQwSLNXa3Xhhb1HhtHvrFxTTBCVUaoqKaxIdjQmzpV9
kTz5IxFoz2FQzGwtH7Ll/mrCIOK3h5PcmZIqWgaCW62roHhDhY/P73y0BnBJy0+l
q2PQk6lIPKS+JCXjHCFqVsiZOSBQiugTUEMeiNnY7h9pmrxqdgtXRARoqY4cYiiH
LCv3T6scpy1LmAPCuw8LkGYOvjiCzKCbwAnUGUpXoQKBgQDQPBExK0tf6c+yDHZJ
TeUNSztOfjqjtFk1ctnqQjqpc3/NjHOytzAVyQhoSlL5xjcXtI+icBm81cANQcr5
oPpMUclIGWFaAY0CmtIz9q0gxZjJXLBXY02rOVpX5Na/gksE78JhAfFuir5dYYPN
wgosX0cOMVPbqXOAPbbYjDja0wKBgQDHRgBdXL5VKrV0TVA0AxKdRwNcywRBtp1U
DQsjvPL1NoM/3eppTmAu83fxuk3rls7knDreFgkH1C9HbwiKTuIu7GQmQMTBCwKL
0IiX8MZC8ZyDZXNoP+35NDz8TITnLevEHM/E9U/nYDTJU/74YoHP/igM29gazHVc
J8wpNByGoQKBgECeMzOP3M8BrkrxJQ+wVWDftKKx9x5vy7MTVd4k+TE2PzWY3Rpb
UFeiT7KVRdRulxALHvtoUARSTEuQ3BzEwIdIZe6yuYwFqS1iv9ISPT1LNBNgaPRl
Q2fb31YhFCbPltoMUMRrpvEHqvUtWopSKXgFhPY5hm1G0ym7fO8L7GSzAoGAS5fN
eZ0+ApbSAM13WFO2Ev2mU+QbuEXrBsBv8l2yGL1WKrsnOk1mBUmMvaE7/9vUnjp5
xle7k0G1sbZ4Ged0u/Imx7AYM1bW32z69BB9VVXMVrf8gJaH0tozLE5muD/eSSXY
11Frv0zqmVkIxvavYdR7Iu2e3AOlnZDnTNYc4CECgYEAxVnOuCOBz012ua1RGFL+
X2aAiiajfbW23QVQ9uER1YYlGU1qVtxv/y+ARGDGEFN7K1jWqIhLngDwz2mAqPzF
g8BdHHh5ITC9Es8Br0zXXX0Iu6nZPhTbHBzT45niNrK/FKnvB6OZyCzCJez9eRF6
ife7J5QdiayT/yn8I3dml/o=
-----END PRIVATE KEY-----`;

async function openUpgrade(
  proxyPort: number,
  targetPort: number,
  label = "upgrade",
): Promise<import("node:net").Socket> {
  const socket = connect({
    allowHalfOpen: true,
    host: "127.0.0.1",
    port: proxyPort,
  });
  socket.write(
    `GET ws://public.test:${targetPort}/socket HTTP/1.1\r\n` +
      `Host: public.test:${targetPort}\r\nConnection: Upgrade\r\n` +
      "Upgrade: websocket\r\n\r\n",
  );
  try {
    await waitForData(socket, "101 Switching Protocols");
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
  return socket;
}

function waitForTermination(socket: import("node:net").Socket): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    socket.once("end", done);
    socket.once("close", done);
  });
}

function waitForClose(socket: import("node:net").Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}

async function streamChunkedOverflow(
  proxyPort: number,
  targetPort: number,
): Promise<void> {
  const socket = connect(proxyPort, "127.0.0.1");
  const terminated = waitForTermination(socket);
  socket.on("error", () => undefined);
  socket.write(
    `POST http://public.test:${targetPort}/request HTTP/1.1\r\n` +
      `Host: public.test:${targetPort}\r\nTransfer-Encoding: chunked\r\n` +
      "Connection: close\r\n\r\n",
  );
  const chunk = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < 33 && !socket.destroyed; index += 1) {
    socket.write("100000\r\n");
    if (!socket.write(chunk)) {
      await Promise.race([
        new Promise<void>((resolve) => socket.once("drain", resolve)),
        terminated,
      ]);
    }
    if (!socket.destroyed) socket.write("\r\n");
  }
  if (!socket.destroyed) socket.end("0\r\n\r\n");
  await terminated;
  socket.destroy();
}

async function countRawResponseBody(
  proxyPort: number,
  request: string,
): Promise<number> {
  const socket = connect(proxyPort, "127.0.0.1");
  const terminated = waitForTermination(socket);
  let header = Buffer.alloc(0);
  let bodyBytes = 0;
  let headersDone = false;
  socket.on("data", (chunk: Buffer) => {
    if (headersDone) {
      bodyBytes += chunk.length;
      return;
    }
    header = Buffer.concat([header, chunk]);
    const boundary = header.indexOf("\r\n\r\n");
    if (boundary !== -1) {
      headersDone = true;
      bodyBytes += header.length - boundary - 4;
      header = Buffer.alloc(0);
    }
  });
  socket.end(request);
  await terminated;
  socket.destroy();
  return bodyBytes;
}
