import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { describe, expect, test, vi } from "vitest";

import {
  canonicalJson,
  type BrowserActionExecutionV1,
  type BrowserOperation,
} from "./contracts.js";
import { SessionActionCache } from "./action-cache.js";
import { createSessionRegistry } from "./session-registry.js";
import {
  OperationNoEffectError,
  createBrowserOperationSession,
  executeCachedAction,
  type OperationElement,
  type OperationPage,
} from "./operations.js";

const ACTION_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const RUN_ID = "bbbbbbbb-2222-4222-8222-222222222222";

function hash(operation: BrowserOperation): string {
  return createHash("sha256")
    .update(canonicalJson(operation), "utf8")
    .digest("hex");
}

function action(
  operation: BrowserOperation,
  overrides: Partial<BrowserActionExecutionV1> = {},
): BrowserActionExecutionV1 {
  return {
    version: 1,
    actionId: ACTION_ID,
    runId: RUN_ID,
    sequence: 1,
    normalizedProposalHash: hash(operation),
    effect: ["snapshot", "wait", "get_text", "get_url"].includes(
      operation.kind,
    )
      ? "read_only"
      : "side_effecting",
    expectedSessionVersion: 1,
    operation,
    ...overrides,
  };
}

function fakeElement(
  overrides: Partial<OperationElement> = {},
): OperationElement {
  return {
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => []),
    getAttribute: vi.fn(async () => null),
    textContent: vi.fn(async () => "element text"),
    evaluate: vi.fn(async () => ({
      connected: true,
      tag: "button",
      role: "button",
      name: "Submit",
      text: "Submit",
    })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function listenLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function fakePage(
  elements: OperationElement[] = [fakeElement()],
  initialUrl = "https://example.test/start",
  faithfulCdpNavigate = false,
) {
  let url = initialUrl;
  let title = "Example";
  let body = "body text";
  let redirectUrl: string | null = null;
  let failNextContinue = false;
  const downloadListeners: Array<(download: { cancel(): Promise<void> }) => void> =
    [];
  const frameListeners: Array<(frame: unknown) => void> = [];
  const routeListeners: Array<(route: {
    request(): {
      isNavigationRequest(): boolean;
      frame(): unknown;
      url(): string;
    };
    abort(): Promise<void>;
    continue(): Promise<void>;
  }) => Promise<void>> = [];
  const cdpListeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();
  const decisions = new Map<string, "continue" | "fail">();
  let requestCounter = 0;
  let loaderCounter = 0;
  let executionContextCounter = 0;
  let lastNavigation = Promise.resolve();
  let page!: OperationPage;

  const listenersFor = (event: string) => cdpListeners.get(event) ?? [];

  const cdpSession = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main" } } };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: ++executionContextCounter };
      }
      if (method === "Runtime.evaluate") {
        try {
          return {
            result: {
              value: await page.evaluate(String(params?.expression ?? "")),
            },
          };
        } catch (error) {
          return {
            result: {
              description:
                error instanceof Error ? error.message : String(error),
            },
            exceptionDetails: { text: "evaluation failed" },
          };
        }
      }
      if (method === "Page.navigate") {
        const next = String(params?.url ?? "");
        const loaderId = `loader-${++loaderCounter}`;
        lastNavigation = navigate(next, loaderId);
        if (faithfulCdpNavigate) await lastNavigation;
        return { frameId: "main", loaderId };
      }
      if (method === "Fetch.continueRequest" && params?.requestId) {
        decisions.set(String(params.requestId), "continue");
      }
      if (method === "Fetch.failRequest" && params?.requestId) {
        decisions.set(String(params.requestId), "fail");
      }
      return {};
    }),
    on: vi.fn((event: string, listener: (event: unknown) => void) => {
      const listeners = listenersFor(event);
      cdpListeners.set(event, [...listeners, listener]);
    }),
    off: vi.fn((event: string, listener: (event: unknown) => void) => {
      cdpListeners.set(
        event,
        listenersFor(event).filter((candidate) => candidate !== listener),
      );
    }),
    detach: vi.fn(async () => {
      for (const listener of [...listenersFor("close")]) listener({});
    }),
  };
  const emitRoute = async (
    next: string,
    failContinue = false,
    loaderId = `loader-${++loaderCounter}`,
    redirectedRequestId?: string,
  ) => {
    if (listenersFor("Fetch.requestPaused").length === 0) return true;
    const requestId = `request-${++requestCounter}`;
    const networkId = `network-${requestCounter}`;
    if (failContinue) {
      cdpSession.send.mockImplementationOnce(async (method, params) => {
        if (method === "Fetch.continueRequest" && params?.requestId) {
          decisions.set(String(params.requestId), "fail");
        }
        throw new Error("route continue failed");
      });
    }
    for (const listener of [...listenersFor("Network.requestWillBeSent")]) {
      listener({
        requestId: networkId,
        frameId: "main",
        loaderId,
        type: "Document",
        request: { url: next },
      });
    }
    for (const listener of [...listenersFor("Fetch.requestPaused")]) {
      listener({
        requestId,
        networkId,
        redirectedRequestId,
        frameId: "main",
        resourceType: "Document",
        request: { url: next },
      });
    }
    await vi.waitFor(() => expect(decisions.has(requestId)).toBe(true));
    return decisions.get(requestId) === "continue";
  };
  const navigate = async (next: string, loaderId: string) => {
    let aborted = false;
    let redirectedRequestId: string | undefined;
    for (const candidate of [next, redirectUrl].filter(
      (value): value is string => value !== null,
    )) {
      const requestId = `request-${requestCounter + 1}`;
      aborted = !(
        await emitRoute(
          candidate,
          failNextContinue,
          loaderId,
          redirectedRequestId,
        )
      );
      redirectedRequestId = requestId;
      failNextContinue = false;
      if (aborted) throw new Error("navigation blocked before following");
    }
    url = redirectUrl ?? next;
    redirectUrl = null;
    for (const listener of frameListeners) listener(page);
  };
  page = {
    url: vi.fn(() => url),
    title: vi.fn(async () => title),
    textContent: vi.fn(async () => body),
    goto: vi.fn(async (next: string) => {
      lastNavigation = navigate(next, `loader-${++loaderCounter}`);
      await lastNavigation;
    }),
    locator: vi.fn(() => ({
      elementHandles: vi.fn(async () => elements),
    })),
    mouse: {
      wheel: vi.fn(async () => undefined),
    },
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => {
      await lastNavigation;
    }),
    evaluate: vi.fn(async (source: string) => {
      if (source.includes("document.title")) return JSON.stringify(title);
      return "null";
    }),
    route: vi.fn(async (_url: string, listener: never) => {
      routeListeners.push(listener as (typeof routeListeners)[number]);
    }),
    unroute: vi.fn(async (_url: string, listener: never) => {
      const index = routeListeners.indexOf(
        listener as (typeof routeListeners)[number],
      );
      if (index >= 0) routeListeners.splice(index, 1);
    }),
    on: vi.fn((event: "download" | "framenavigated", listener: never) => {
      if (event === "download") {
        downloadListeners.push(
          listener as (download: { cancel(): Promise<void> }) => void,
        );
      } else {
        frameListeners.push(listener as (frame: unknown) => void);
      }
      return page;
    }),
    off: vi.fn((event: "download" | "framenavigated", listener: never) => {
      const listeners =
        event === "download" ? downloadListeners : frameListeners;
      const index = listeners.indexOf(listener as never);
      if (index >= 0) listeners.splice(index, 1);
      return page;
    }),
    mainFrame: vi.fn(() => page),
    context: vi.fn(() => ({
      newCDPSession: vi.fn(async () => cdpSession),
    })),
  };
  return {
    page,
    elements,
    setUrl: (next: string) => {
      url = next;
    },
    setBody: (next: string) => {
      body = next;
    },
    setTitle: (next: string) => {
      title = next;
    },
    setRedirect: (next: string) => {
      redirectUrl = next;
    },
    failNextContinue: () => {
      failNextContinue = true;
    },
    emitRoute,
    cdpSession,
    emitCdpClose: () => {
      for (const listener of [...listenersFor("close")]) listener({});
    },
    emitDownload: (download: { cancel(): Promise<void> }) => {
      for (const listener of downloadListeners) listener(download);
    },
  };
}

describe("browser operation session", () => {
  test(
    "live Chromium continues granted navigation and blocks new redirect origin",
    async () => {
      let redirectTarget = "";
      let blockedOriginHits = 0;
      const initialServer = createServer((_request, response) => {
        response.end("<title>initial</title>");
      });
      const targetServer = createServer((request, response) => {
        if (request.url === "/redirect") {
          response.writeHead(302, { location: redirectTarget });
          response.end();
          return;
        }
        response.end("<title>target</title>");
      });
      const blockedServer = createServer((_request, response) => {
        blockedOriginHits += 1;
        response.end("<title>blocked</title>");
      });
      const [initialOrigin, targetOrigin, blockedOrigin] = await Promise.all([
        listenLoopback(initialServer),
        listenLoopback(targetServer),
        listenLoopback(blockedServer),
      ]);
      redirectTarget = `${blockedOrigin}/landing`;
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({
          acceptDownloads: false,
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        await page.goto(`${initialOrigin}/start`);
        const session = createBrowserOperationSession({
          page,
          allowedDomains: ["127.0.0.1"],
          initialOrigin,
        });
        try {
          await expect(
            session.execute({
              kind: "navigate",
              url: `${targetOrigin}/target`,
            }),
          ).resolves.toMatchObject({
            result: { kind: "navigate", applied: true },
          });
          await expect(
            session.execute({
              kind: "navigate",
              url: `${targetOrigin}/redirect`,
            }),
          ).rejects.toThrow();
          expect(blockedOriginHits).toBe(0);
        } finally {
          await session.dispose();
          await context.close();
        }
      } finally {
        await browser.close();
        await Promise.all([
          closeServer(initialServer),
          closeServer(targetServer),
          closeServer(blockedServer),
        ]);
      }
    },
    15_000,
  );

  test("uses Playwright 1.61.1 ElementHandle.type from production declarations", () => {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("playwright/package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version: string;
    };
    const declarations = readFileSync(
      new URL("../playwright-core/types/types.d.ts", pathToFileURL(packageJsonPath)),
      "utf8",
    );
    const elementHandleStart = declarations.indexOf(
      "export interface ElementHandle",
    );
    const elementHandleEnd = declarations.indexOf(
      "\nexport interface ",
      elementHandleStart + 1,
    );
    const elementHandleDeclarations = declarations.slice(
      elementHandleStart,
      elementHandleEnd,
    );
    expect(packageJson.version).toBe("1.61.1");
    expect(elementHandleDeclarations).toContain("type(text: string, options?:");
    expect(elementHandleDeclarations).not.toContain(
      "pressSequentially(text: string",
    );
  });

  test("does not resume an operation after disposal during delayed CDP install", async () => {
    const h = fakePage();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(h.page.context).mockReturnValueOnce({
      newCDPSession: async () => {
        await delayed;
        return h.cdpSession;
      },
    } as never);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    const execution = session.execute({ kind: "get_url" });
    const disposal = session.dispose();
    release();
    await disposal;
    await expect(execution).rejects.toThrow("disposed");
    expect(h.cdpSession.detach).toHaveBeenCalled();
  });

  test("dispose unregisters Fetch interception and blocks later execution", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    await session.dispose();
    expect(h.cdpSession.off).toHaveBeenCalledWith(
      "Fetch.requestPaused",
      expect.any(Function),
    );
    expect(h.cdpSession.off).toHaveBeenCalledWith(
      "close",
      expect.any(Function),
    );
    expect(h.cdpSession.send).toHaveBeenCalledWith("Fetch.disable");
    expect(h.cdpSession.detach).toHaveBeenCalledOnce();
    expect(h.page.off).toHaveBeenCalledWith(
      "download",
      expect.any(Function),
    );
    expect(h.page.off).toHaveBeenCalledWith(
      "framenavigated",
      expect.any(Function),
    );
    await expect(session.execute({ kind: "get_url" })).rejects.toThrow(
      "disposed",
    );
  });

  test("dispatches all twelve operation discriminants", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });

    expect((await session.execute({ kind: "snapshot" })).result).toEqual({
      kind: "snapshot",
      refCount: 1,
    });
    expect(
      (await session.execute({ kind: "click", ref: "e1" })).result,
    ).toEqual({ kind: "click", applied: true });
    expect(
      (await session.execute({ kind: "fill", ref: "e1", value: "x" })).result,
    ).toEqual({ kind: "fill", applied: true });
    expect(
      (
        await session.execute({
          kind: "type",
          ref: "e1",
          value: "x",
          delayMs: 5,
        })
      ).result,
    ).toEqual({ kind: "type", applied: true });
    expect(
      (await session.execute({ kind: "press", ref: "e1", key: "Enter" }))
        .result,
    ).toEqual({ kind: "press", applied: true });
    expect(
      (
        await session.execute({
          kind: "select",
          ref: "e1",
          values: ["one"],
        })
      ).result,
    ).toEqual({ kind: "select", applied: true });
    expect(
      (await session.execute({ kind: "scroll", deltaX: 1, deltaY: 2 })).result,
    ).toEqual({ kind: "scroll", applied: true });
    expect(
      (await session.execute({ kind: "wait", milliseconds: 10 })).result,
    ).toEqual({ kind: "wait", waitedMs: 10 });
    expect(
      (await session.execute({ kind: "get_text", ref: "e1" })).result,
    ).toEqual({ kind: "get_text", text: "element text" });
    expect((await session.execute({ kind: "get_url" })).result).toEqual({
      kind: "get_url",
      url: "https://example.test/start",
    });
    expect(
      (
        await session.execute({
          kind: "navigate",
          url: "https://example.test/next",
        })
      ).result,
    ).toEqual({ kind: "navigate", applied: true });
    expect(
      (
        await session.execute({
          kind: "evaluate",
          expression: "document.title",
          args: {},
        })
      ).result,
    ).toEqual({ kind: "evaluate", value: "Example" });

    expect(element.click).toHaveBeenCalledOnce();
    expect(element.fill).toHaveBeenCalledWith("x");
    expect(element.type).toHaveBeenCalledWith("x", { delay: 5 });
    expect(element.press).toHaveBeenCalledWith("Enter");
    expect(element.selectOption).toHaveBeenCalledWith(["one"]);
    expect(h.page.mouse.wheel).toHaveBeenCalledWith(1, 2);
  });

  test("caps server-held refs at 500 and snapshot text at 40,000 chars", async () => {
    const elements = Array.from({ length: 501 }, () => fakeElement());
    const h = fakePage(elements);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    const execution = await session.execute({ kind: "snapshot" });

    expect(execution.result).toEqual({ kind: "snapshot", refCount: 500 });
    expect(Array.from(execution.page.snapshotExcerpt).length).toBeLessThanOrEqual(
      40_000,
    );
    expect(elements[500]!.dispose).toHaveBeenCalledOnce();
    await expect(
      session.execute({ kind: "click", ref: "e501" }),
    ).rejects.toBeInstanceOf(OperationNoEffectError);
  });

  test("rejects blocked direct navigation before goto", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await expect(
      session.execute({
        kind: "navigate",
        url: "https://blocked.test/",
      }),
    ).rejects.toMatchObject({ category: "target_blocked" });
    expect(h.page.goto).not.toHaveBeenCalled();
  });

  test("rejects an uncommitted cross-origin link before click", async () => {
    const element = fakeElement({
      getAttribute: vi.fn(async () => "https://other.test/path"),
    });
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "snapshot" });
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({ category: "target_blocked" });
    expect(element.click).not.toHaveBeenCalled();
  });

  test("rejects a malformed link as proven no-effect before click", async () => {
    const element = fakeElement({
      getAttribute: vi.fn(async () => "http://[invalid"),
    });
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "snapshot" });
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({ category: "target_blocked" });
    expect(element.click).not.toHaveBeenCalled();
  });

  test("permits a cross-origin link only after explicit navigate grants it", async () => {
    const element = fakeElement({
      getAttribute: vi.fn(async () => "https://other.test/path"),
    });
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({
      kind: "navigate",
      url: "https://other.test/first",
    });
    h.setUrl("https://example.test/return");
    await session.execute({ kind: "snapshot" });
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).resolves.toMatchObject({ result: { kind: "click" } });
    expect(element.click).toHaveBeenCalledOnce();
  });

  test("does not deadlock when navigation waits for Fetch continue", async () => {
    const h = fakePage(
      [fakeElement()],
      "https://example.test/start",
      true,
    );
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    const navigation = session.execute({
      kind: "navigate",
      url: "https://other.test/target",
    });
    const observed = Promise.race([
      navigation,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("navigation interception deadlocked")),
          25,
        );
      }),
    ]);
    await expect(observed).resolves.toMatchObject({
      result: { kind: "navigate", applied: true },
    });
  });

  test("commits explicit target authority before browser dispatch", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    vi.mocked(h.page.goto).mockImplementationOnce(async (next: string) => {
      await expect(
        h.emitRoute(
          "https://other.test/concurrent",
          false,
          "concurrent-loader",
        ),
      ).resolves.toBe(true);
      h.setUrl(next);
    });

    await expect(
      session.execute({
        kind: "navigate",
        url: "https://other.test/target",
      }),
    ).resolves.toMatchObject({
      result: { kind: "navigate", applied: true },
    });
  });

  test("blocks an allowed-domain redirect from adding a second origin", async () => {
    const element = fakeElement({
      getAttribute: vi.fn(async () => "https://redirect.test/landing"),
    });
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test", "redirect.test"],
      initialOrigin: "https://example.test",
    });
    h.setRedirect("https://redirect.test/landing");
    await expect(
      session.execute({
        kind: "navigate",
        url: "https://other.test/start",
      }),
    ).rejects.toThrow("navigation blocked before following");
    await session.execute({ kind: "snapshot" });
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({ category: "target_blocked" });
    expect(element.click).not.toHaveBeenCalled();
  });

  test("blocks page-script navigation without learning its origin", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    vi.mocked(element.click).mockImplementationOnce(async () => {
      expect(
        await h.emitRoute("https://other.test/script-navigation"),
      ).toBe(false);
    });
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "snapshot" });
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).resolves.toMatchObject({ result: { kind: "click" } });
    vi.mocked(element.getAttribute).mockResolvedValueOnce(
      "https://other.test/link",
    );
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({ category: "target_blocked" });
  });

  test("learns direct origins, rejects origin nine, and blocks redirects before follow", async () => {
    const h = fakePage();
    const domains = Array.from({ length: 8 }, (_, index) => `d${index}.test`);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: domains,
      initialOrigin: "https://initial.test",
    });
    for (const domain of domains.slice(0, 7)) {
      await session.execute({ kind: "navigate", url: `https://${domain}/` });
    }
    await expect(
      session.execute({ kind: "navigate", url: "https://d7.test/" }),
    ).rejects.toMatchObject({ category: "target_blocked" });

    const redirected = fakePage();
    const redirectSession = createBrowserOperationSession({
      page: redirected.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    redirected.setRedirect("https://blocked.test/");
    await expect(
      redirectSession.execute({
        kind: "navigate",
        url: "https://example.test/redirect",
      }),
    ).rejects.toThrow("navigation blocked before following");
    expect(redirected.page.url()).toBe("https://example.test/start");
  });

  test("reserves the final origin slot before any asynchronous cleanup", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    const domains = Array.from({ length: 8 }, (_, index) => `d${index}.test`);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: domains,
      initialOrigin: "https://initial.test",
    });
    for (const domain of domains.slice(0, 6)) {
      await session.execute({ kind: "navigate", url: `https://${domain}/` });
    }
    await session.execute({ kind: "snapshot" });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(element.dispose).mockImplementationOnce(async () => delayed);

    const finalSlot = session.execute({
      kind: "navigate",
      url: "https://d6.test/",
    });
    await vi.waitFor(() => expect(element.dispose).toHaveBeenCalled());
    await expect(
      session.execute({ kind: "navigate", url: "https://d7.test/" }),
    ).rejects.toMatchObject({ category: "target_blocked" });
    release();
    await expect(finalSlot).resolves.toMatchObject({
      result: { kind: "navigate", applied: true },
    });
  });

  test("background navigation and failed CDP continue create no ghost authority", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    await expect(h.emitRoute("https://other.test/background")).resolves.toBe(
      false,
    );
    h.failNextContinue();
    await expect(
      session.execute({
        kind: "navigate",
        url: "https://other.test/target",
      }),
    ).rejects.toThrow("navigation blocked before following");
    await expect(session.execute({ kind: "get_url" })).rejects.toThrow(
      "route continue failed",
    );
  });

  test("retains a Fetch settlement failure as terminal session failure", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    await h.emitRoute("https://example.test/background", true);
    await expect(session.execute({ kind: "get_url" })).rejects.toThrow(
      "route continue failed",
    );
  });

  test("propagates Fetch teardown uncertainty", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    h.cdpSession.send.mockRejectedValueOnce(new Error("disable failed"));
    await expect(session.dispose()).rejects.toThrow("disable failed");
    await expect(session.dispose()).rejects.toThrow("disable failed");
    expect(h.cdpSession.off).not.toHaveBeenCalledWith(
      "Fetch.requestPaused",
      expect.any(Function),
    );
    expect(h.cdpSession.off).not.toHaveBeenCalledWith(
      "close",
      expect.any(Function),
    );
    expect(h.cdpSession.detach).not.toHaveBeenCalled();
  });

  test("keeps interception active for a pause arriving during disable", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    let pause: Promise<boolean> | undefined;
    h.cdpSession.send.mockImplementationOnce(async (method) => {
      expect(method).toBe("Fetch.disable");
      pause = h.emitRoute("https://example.test/during-disable");
      await pause;
      return {};
    });
    await expect(session.dispose()).resolves.toBeUndefined();
    await expect(pause).resolves.toBe(false);
    const disableOrder =
      h.cdpSession.send.mock.invocationCallOrder.find(
        (_order, index) =>
          h.cdpSession.send.mock.calls[index]?.[0] === "Fetch.disable",
      )!;
    const offOrder =
      h.cdpSession.off.mock.invocationCallOrder.find(
        (_order, index) =>
          h.cdpSession.off.mock.calls[index]?.[0] ===
          "Fetch.requestPaused",
      )!;
    expect(disableOrder).toBeLessThan(offOrder);
  });

  test("retains an unexpected CDP close for current and next action", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    vi.mocked(h.page.waitForTimeout).mockImplementationOnce(async () => {
      h.emitCdpClose();
    });
    await expect(
      session.execute({ kind: "wait", milliseconds: 1 }),
    ).rejects.toThrow("CDP session closed unexpectedly");
    await expect(session.execute({ kind: "get_url" })).rejects.toThrow(
      "CDP session closed unexpectedly",
    );
  });

  test("drains a tracked paused request before disabling Fetch", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "get_url" });
    const implementation = h.cdpSession.send.getMockImplementation()!;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.cdpSession.send.mockImplementationOnce(async (method, params) => {
      expect(method).toBe("Fetch.continueRequest");
      await delayed;
      return implementation(method, params);
    });
    const route = h.emitRoute("https://example.test/pending");
    await vi.waitFor(() =>
      expect(h.cdpSession.send).toHaveBeenCalledWith(
        "Fetch.continueRequest",
        expect.any(Object),
      ),
    );
    const disposal = session.dispose();
    await vi.waitFor(() =>
      expect(h.cdpSession.send).toHaveBeenCalledWith("Fetch.disable"),
    );
    expect(h.cdpSession.off).not.toHaveBeenCalledWith(
      "Fetch.requestPaused",
      expect.any(Function),
    );
    release();
    await expect(route).resolves.toBe(true);
    await expect(disposal).resolves.toBeUndefined();
    expect(h.cdpSession.off).toHaveBeenCalledWith(
      "Fetch.requestPaused",
      expect.any(Function),
    );
    expect(h.cdpSession.send).toHaveBeenCalledWith("Fetch.disable");
  });

  test("bounds setup and detaches a CDP session that arrives late", async () => {
    const h = fakePage();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(h.page.context).mockReturnValueOnce({
      newCDPSession: async () => {
        await delayed;
        return h.cdpSession;
      },
    } as never);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
      cdpSetupTimeoutMs: 5,
    });
    await expect(session.execute({ kind: "get_url" })).rejects.toThrow(
      "CDP setup timed out",
    );
    await expect(session.dispose()).rejects.toThrow("CDP setup timed out");
    release();
    await vi.waitFor(() => expect(h.cdpSession.detach).toHaveBeenCalledOnce());
  });

  test("rejects unsafe or non-JSON evaluate results as ambiguous", async () => {
    const h = fakePage();
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await expect(
      session.execute({
        kind: "evaluate",
        expression: "fetch(args.url)",
        args: { url: "https://example.test/" },
      }),
    ).rejects.toMatchObject({ category: "model_protocol_error" });

    vi.mocked(h.page.evaluate).mockResolvedValueOnce(undefined);
    await expect(
      session.execute({
        kind: "evaluate",
        expression: "args.value",
        args: { value: "x" },
      }),
    ).rejects.toThrow(/canonicalization|JSON-safe/);
  });

  test("canonicalizes in isolated world and preserves __proto__ args as data", async () => {
    const h = fakePage();
    vi.mocked(h.page.evaluate).mockResolvedValueOnce(
      '{"__proto__":{"safe":true}}',
    );
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    const args = JSON.parse('{"__proto__":{"safe":true}}') as {
      __proto__: { safe: boolean };
    };
    const execution = await session.execute({
      kind: "evaluate",
      expression: "args",
      args,
    });
    expect(execution.result).toMatchObject({
      kind: "evaluate",
      value: { __proto__: { safe: true } },
    });
    expect(h.cdpSession.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ contextId: expect.any(Number) }),
    );
    const source = vi.mocked(h.page.evaluate).mock.calls[0]![0];
    expect(source).toEqual(expect.stringContaining("SafeJSON.parse.bind"));
    expect(source).toEqual(
      expect.stringContaining("SafeObject.getOwnPropertyDescriptors.bind"),
    );
    expect(source).toEqual(
      expect.stringContaining("SafeObject.getOwnPropertySymbols.bind"),
    );
    expect(source).not.toContain("localeCompare");
  });

  test("matches host canonical ordering for mixed-case and non-ASCII keys", async () => {
    const h = fakePage();
    vi.mocked(h.page.evaluate).mockImplementationOnce(
      async (source: unknown) => (0, eval)(String(source)),
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { body: { z: 1, A: 2, a: 3, ä: 4, Ω: 5 } },
    });
    try {
      const session = createBrowserOperationSession({
        page: h.page,
        allowedDomains: ["example.test"],
        initialOrigin: "https://example.test",
      });
      const execution = await session.execute({
        kind: "evaluate",
        expression: "document.body",
        args: {},
      });
      expect(execution.result).toMatchObject({
        kind: "evaluate",
        value: { z: 1, A: 2, a: 3, ä: 4, Ω: 5 },
      });
      if (execution.result.kind !== "evaluate") {
        throw new Error("expected evaluate result");
      }
      expect(Object.keys(execution.result.value as object)).toEqual([
        "A",
        "a",
        "z",
        "ä",
        "Ω",
      ]);
    } finally {
      Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("rejects unsafe values in isolated world before transport serialization", async () => {
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "secret",
    });
    const symbolKeyed = { value: "x", [Symbol("secret")]: true };
    const sparse = Array(2);
    sparse[1] = "x";
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const customPrototype = Object.create({ inherited: true }) as object;
    const unsafe = [
      customPrototype,
      accessor,
      symbolKeyed,
      sparse,
      cyclic,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      "x".repeat(32 * 1024 + 1),
    ];
    const priorDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    try {
      for (const value of unsafe) {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: { body: value },
        });
        const h = fakePage();
        vi.mocked(h.page.evaluate).mockImplementationOnce(
          async (source: unknown) => (0, eval)(String(source)),
        );
        const session = createBrowserOperationSession({
          page: h.page,
          allowedDomains: ["example.test"],
          initialOrigin: "https://example.test",
        });
        await expect(
          session.execute({
            kind: "evaluate",
            expression: "document.body",
            args: {},
          }),
        ).rejects.toThrow();
      }
    } finally {
      if (priorDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else {
        Object.defineProperty(globalThis, "document", priorDocument);
      }
    }
  });

  test("does not downgrade ref probe transport failure to stale_ref", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "snapshot" });
    vi.mocked(element.evaluate).mockRejectedValueOnce(
      new Error("Chromium disconnected"),
    );
    const failure = session.execute({ kind: "click", ref: "e1" });
    await expect(failure).rejects.toThrow("Chromium disconnected");
    await expect(failure).rejects.not.toBeInstanceOf(OperationNoEffectError);
  });

  test("cancels downloads and never exposes them to callers", async () => {
    const h = fakePage();
    createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    const download = { cancel: vi.fn(async () => undefined) };
    h.emitDownload(download);
    await vi.waitFor(() => expect(download.cancel).toHaveBeenCalledOnce());
  });
});

describe("cached action execution", () => {
  test("treats post-grant navigation failure as uncached ambiguity", async () => {
    const h = fakePage();
    vi.mocked(h.page.goto).mockRejectedValueOnce(
      new Error("navigation transport failed"),
    );
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    const cache = new SessionActionCache();
    const closeAmbiguous = vi.fn(() => operationSession.dispose());
    await expect(
      executeCachedAction({
        cache,
        request: action({
          kind: "navigate",
          url: "https://other.test/target",
        }),
        withWriter: async <T>(run: () => Promise<T>) => run(),
        executeOperation: (operation) => operationSession.execute(operation),
        currentSessionVersion: () => 1,
        currentPage: () => ({
          url: "https://example.test/start",
          title: "",
          snapshotExcerpt: "",
        }),
        commitSuccess: () => 2,
        closeAmbiguous,
      }),
    ).rejects.toThrow("navigation transport failed");
    expect(cache.size).toBe(0);
    expect(cache.pending).toBe(false);
    expect(closeAmbiguous).toHaveBeenCalledOnce();
  });

  test("probe transport failure abandons cache and invokes terminal close", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.execute({ kind: "snapshot" });
    vi.mocked(element.evaluate).mockRejectedValueOnce(
      new Error("Chromium disconnected during probe"),
    );
    const cache = new SessionActionCache();
    const closeAmbiguous = vi.fn(async () => undefined);
    await expect(
      executeCachedAction({
        cache,
        request: action({ kind: "click", ref: "e1" }),
        withWriter: async <T>(run: () => Promise<T>) => run(),
        executeOperation: (operation) => operationSession.execute(operation),
        currentSessionVersion: () => 1,
        currentPage: () => ({
          url: "https://example.test/start",
          title: "",
          snapshotExcerpt: "",
        }),
        commitSuccess: () => 2,
        closeAmbiguous,
      }),
    ).rejects.toThrow("Chromium disconnected during probe");
    expect(cache.size).toBe(0);
    expect(cache.pending).toBe(false);
    expect(closeAmbiguous).toHaveBeenCalledOnce();
  });

  test("caches only a fully validated response and replays without dispatch", async () => {
    const cache = new SessionActionCache();
    const operation = { kind: "get_url" } as const;
    const executeOperation = vi.fn(async () => ({
      result: {
        kind: "get_url" as const,
        url: "https://example.test/",
      },
      page: {
        url: "https://example.test/",
        title: "Example",
        snapshotExcerpt: "",
      },
    }));
    let version = 1;
    const options = {
      cache,
      request: action(operation),
      withWriter: async <T>(run: () => Promise<T>) => run(),
      executeOperation,
      currentSessionVersion: () => version,
      currentPage: () => ({
        url: "https://example.test/",
        title: "Example",
        snapshotExcerpt: "",
      }),
      commitSuccess: () => {
        version += 1;
        return version;
      },
      closeAmbiguous: vi.fn(async () => undefined),
    };

    const first = await executeCachedAction(options);
    const replay = await executeCachedAction(options);
    expect(first).toEqual(replay);
    expect(executeOperation).toHaveBeenCalledOnce();
    expect(cache.size).toBe(1);
  });

  test("abandons ambiguity, closes the session, and never retries", async () => {
    const cache = new SessionActionCache();
    const closeAmbiguous = vi.fn(async () => undefined);
    const operation = { kind: "evaluate", expression: "args.value", args: {
      value: "x",
    } } as const;
    const executeOperation = vi.fn(async () => {
      throw new Error("Chromium disconnected");
    });
    const options = {
      cache,
      request: action(operation),
      withWriter: async <T>(run: () => Promise<T>) => run(),
      executeOperation,
      currentSessionVersion: () => 1,
      currentPage: () => ({
        url: "https://example.test/",
        title: "",
        snapshotExcerpt: "",
      }),
      commitSuccess: () => 2,
      closeAmbiguous,
    };

    await expect(executeCachedAction(options)).rejects.toThrow(
      "Chromium disconnected",
    );
    expect(cache.size).toBe(0);
    expect(cache.pending).toBe(false);
    expect(closeAmbiguous).toHaveBeenCalledOnce();
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  test("preserves session-close failure with the ambiguous action error", async () => {
    const cache = new SessionActionCache();
    const operation = {
      kind: "evaluate",
      expression: "args.value",
      args: { value: "x" },
    } as const;
    await expect(
      executeCachedAction({
        cache,
        request: action(operation),
        withWriter: async <T>(run: () => Promise<T>) => run(),
        executeOperation: async () => {
          throw new Error("dispatch outcome unknown");
        },
        currentSessionVersion: () => 1,
        currentPage: () => ({
          url: "https://example.test/",
          title: "",
          snapshotExcerpt: "",
        }),
        commitSuccess: () => 2,
        closeAmbiguous: async () => {
          throw new Error("teardown unverified");
        },
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: expect.stringContaining("teardown unverified"),
      errors: [
        expect.objectContaining({ message: "dispatch outcome unknown" }),
        expect.objectContaining({ message: "teardown unverified" }),
      ],
    });
    expect(cache.size).toBe(0);
    expect(cache.pending).toBe(false);
  });

  test("caches a proven stale-ref failure without dispatch ambiguity", async () => {
    const cache = new SessionActionCache();
    const operation = { kind: "click", ref: "missing" } as const;
    const closeAmbiguous = vi.fn(async () => undefined);
    const result = await executeCachedAction({
      cache,
      request: action(operation),
      withWriter: async <T>(run: () => Promise<T>) => run(),
      executeOperation: async () => {
        throw new OperationNoEffectError("stale_ref", "Locator is stale");
      },
      currentSessionVersion: () => 1,
      currentPage: () => ({
        url: "https://example.test/",
        title: "",
        snapshotExcerpt: "",
      }),
      commitSuccess: () => 2,
      closeAmbiguous,
    });

    expect(result).toMatchObject({
      outcome: "failed_no_effect",
      error: { category: "stale_ref" },
    });
    expect(cache.size).toBe(1);
    expect(closeAmbiguous).not.toHaveBeenCalled();
  });
});

test("SessionRegistry exposes cached executeAction and closes ambiguity", async () => {
  const h = fakePage([fakeElement()], "about:blank");
  const context = {
    pages: () => [h.page],
    serviceWorkers: () => [],
    close: vi.fn(async () => undefined),
    browser: () => null,
    setStorageState: vi.fn(async () => undefined),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    tracing: {
      start: vi.fn(async () => undefined),
      startChunk: vi.fn(async () => undefined),
      stopChunk: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
  };
  const gate = {
    state: "restore_closed" as const,
    beginIngress: () => true,
    recordDnsResolution: () => undefined,
    recordPolicyDecision: () => undefined,
    recordDial: () => undefined,
    assertZeroViolations: () => undefined,
    open: () => undefined,
    close: () => undefined,
    markPositiveControlBaseline: () => ({
      counters: {
        ingressAttempts: 0,
        ingressViolations: 0,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      },
      controlId: 1,
    }),
    assertPositiveControl: () => undefined,
    completeCounterSnapshot: () => ({
      ingressAttempts: 0,
      ingressViolations: 0,
      dnsResolutions: 0,
      policyDecisions: 0,
      dials: 0,
    }),
    snapshot: () => ({
      state: "open" as const,
      counters: {
        ingressAttempts: 0,
        ingressViolations: 0,
        dnsResolutions: 0,
        policyDecisions: 0,
        dials: 0,
      },
    }),
  };
  const registry = createSessionRegistry({
    admission: {
      processNonce: "process",
      requireReady: () => ({
        processNonce: "process",
        controlGenerationNonce: "control",
        snapshotDigest: "a".repeat(64),
      }),
      beginDraining: vi.fn(),
    },
    binding: {
      processNonce: "process",
      controlGenerationNonce: "control",
    },
    profileStore: {
      workingGeneration: () => Object.freeze({}),
      readRootFile: async () => Buffer.alloc(0),
      createWorkingCopy: async () => ({
        profileId: ACTION_ID,
        generationId: RUN_ID,
        sessionId: ACTION_ID,
        mode: "snapshot" as const,
        path: "/tmp/profile",
      }),
      discardWorkingCopy: async () => undefined,
      prepareWorkingCopy: async () => {
        throw new Error("snapshot profile cannot prepare");
      },
      finalizePreparedGeneration: async () => {
        throw new Error("snapshot profile cannot finalize");
      },
    },
    createEgressProxy: async () => ({
      url: "http://127.0.0.1:1234",
      port: 1234,
      restoreGate: gate,
      close: async () => undefined,
      liveSocketCount: () => 0,
    }),
    launchPersistentChromiumForWorking: async () =>
      Object.freeze({ context }),
    releaseChromiumSessionAttachment: async () => {
      await context.close();
    },
    createRecordingProducer: async () => ({
      snapshot: async () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
      subscribe: () => () => undefined,
      close: async () => undefined,
    }),
    randomUUID: () => "cccccccc-3333-4333-8333-333333333333",
  });
  const session = await registry.create({
    version: 1,
    sessionId: ACTION_ID,
    initialUrl: "https://example.test/start",
    allowedDomains: ["example.test"],
    ttlSeconds: 60,
    activityTtlSeconds: 10,
    profile: null,
    replay: null,
    settings: {
      headers: {},
      cookies: [],
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
      userAgent: "Operation Test",
      locale: "en-US",
      location: { country: "us-generic", languages: ["en-US"] },
      proxy: { kind: "auto" },
      skipTlsVerification: false,
      blockAds: false,
      lockdown: true,
    },
  });
  const getUrl = action(
    { kind: "get_url" },
    { expectedSessionVersion: session.sessionVersion },
  );

  const first = await registry.executeAction(session.runtimeSessionId, getUrl);
  const urlCalls = vi.mocked(h.page.url).mock.calls.length;
  const replay = await registry.executeAction(session.runtimeSessionId, getUrl);
  expect(replay).toEqual(first);
  expect(vi.mocked(h.page.url).mock.calls.length).toBe(urlCalls);

  const evaluate = action(
    { kind: "evaluate", expression: "args.value", args: { value: "x" } },
    {
      actionId: "dddddddd-4444-4444-8444-444444444444",
      sequence: 2,
      expectedSessionVersion: first.sessionVersion,
    },
  );
  vi.mocked(h.page.evaluate).mockRejectedValueOnce(
    new Error("Chromium disconnected"),
  );
  await expect(
    registry.executeAction(session.runtimeSessionId, evaluate),
  ).rejects.toThrow("Chromium disconnected");
  expect(registry.get(session.runtimeSessionId)).toBeUndefined();
  expect(context.close).toHaveBeenCalledOnce();
});
