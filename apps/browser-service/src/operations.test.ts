import { Buffer } from "node:buffer";
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
    effect: ["wait", "extract", "hover", "hover_batch", "screenshot"].includes(
      operation.kind,
    )
      ? "read_only"
      : "side_effecting",
    expectedSessionVersion: 1,
    allowedDomains: ["example.test"],
    operation,
    ...overrides,
  };
}

function fakeElement(
  overrides: Partial<OperationElement> = {},
): OperationElement {
  return {
    click: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => []),
    getAttribute: vi.fn(async () => null),
    textContent: vi.fn(async () => "element text"),
    innerText: vi.fn(async () => "element text"),
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(
      async (_callback, limits?: { maximumCharacters?: number }) => [
        {
          connected: true,
          tag: "button",
          role: "button",
          name: "Submit",
          text:
            limits?.maximumCharacters === 40_000 ? "element text" : "Submit",
        },
      ],
    ),
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
  const downloadListeners: Array<
    (download: { cancel(): Promise<void> }) => void
  > = [];
  const frameListeners: Array<(frame: unknown) => void> = [];
  const routeListeners: Array<
    (route: {
      request(): {
        isNavigationRequest(): boolean;
        frame(): unknown;
        url(): string;
      };
      abort(): Promise<void>;
      continue(): Promise<void>;
    }) => Promise<void>
  > = [];
  const cdpListeners = new Map<string, Array<(event: unknown) => void>>();
  const decisions = new Map<string, "continue" | "fail">();
  let requestCounter = 0;
  let loaderCounter = 0;
  let batchedEvaluationCount = 0;
  const hoverBatchDeltas: Array<string | Error> = [];
  let lastNavigation = Promise.resolve();
  let page!: OperationPage;
  const unboundedElementHandles = vi.fn(async () => elements);
  const elementHandleAt = vi.fn(
    async (index: number) => elements[index] ?? null,
  );
  const allElementsLocator = {
    count: vi.fn(async () => elements.length),
    elementHandles: unboundedElementHandles,
    nth: vi.fn((index: number) => ({
      elementHandle: vi.fn(async () => elementHandleAt(index)),
    })),
  };
  const bodyLocator = {
    innerText: vi.fn(async () => body),
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(async () => [
      {
        connected: true,
        tag: "BODY",
        role: "",
        name: "",
        text: body,
      },
    ]),
  };

  const listenersFor = (event: string) => cdpListeners.get(event) ?? [];

  const cdpSession = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main" } } };
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
      aborted = !(await emitRoute(
        candidate,
        failNextContinue,
        loaderId,
        redirectedRequestId,
      ));
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
    locator: vi.fn((selector: string) =>
      selector === "body" ? bodyLocator : allElementsLocator,
    ),
    mouse: {
      wheel: vi.fn(async () => undefined),
    },
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => {
      await lastNavigation;
    }),
    screenshot: vi.fn(async () => Buffer.from("png")),
    evaluateHandle: vi.fn(async (_callback, input: unknown) => {
      if (typeof input !== "number") {
        return {
          evaluate: vi.fn(async () => {
            const next = hoverBatchDeltas.shift() ?? "";
            if (next instanceof Error) throw next;
            return next;
          }),
          dispose: vi.fn(async () => undefined),
        };
      }
      const maximumElements = input;
      const retained = elements.slice(0, maximumElements);
      return {
        evaluate: vi.fn(async (callback, limits) => {
          batchedEvaluationCount += 1;
          return (
            await Promise.all(
              retained.map((element) => element.evaluate(callback, limits)),
            )
          ).flat();
        }),
        getProperties: vi.fn(
          async () =>
            new Map(
              retained.map((element, index) => [
                String(index),
                {
                  asElement: () => element,
                  dispose: vi.fn(async () => undefined),
                },
              ]),
            ),
        ),
        dispose: vi.fn(async () => undefined),
      };
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
    bodyLocator,
    batchedEvaluationCount: () => batchedEvaluationCount,
    queueHoverBatchDeltas: (...values: Array<string | Error>) => {
      hoverBatchDeltas.push(...values);
    },
    elementHandleAt,
    unboundedElementHandles,
    emitCdpClose: () => {
      for (const listener of [...listenersFor("close")]) listener({});
    },
    emitDownload: (download: { cancel(): Promise<void> }) => {
      for (const listener of downloadListeners) listener(download);
    },
  };
}

describe("browser operation session", () => {
  test("live Chromium continues granted navigation and blocks new redirect origin", async () => {
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
  }, 15_000);

  test("bounds hostile multibyte DOM text before browser transfer", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent(
        `<body><main>${"😀".repeat(50_000)}</main>` +
          "<script>hidden-script</script><style>hidden-style</style>" +
          "<template>hidden-template</template><noscript>hidden-noscript</noscript></body>",
      );
      await page.evaluate(() => {
        Object.defineProperty(HTMLElement.prototype, "innerText", {
          configurable: true,
          get() {
            throw new Error("unbounded innerText access");
          },
        });
        Object.defineProperty(Node.prototype, "textContent", {
          configurable: true,
          get() {
            throw new Error("unbounded textContent access");
          },
        });
      });
      const session = createBrowserOperationSession({
        page,
        allowedDomains: [],
        initialOrigin: null,
      });
      try {
        const execution = await session.execute({ kind: "extract" });
        expect(execution.result.kind).toBe("extract");
        if (execution.result.kind !== "extract") {
          throw new Error("expected extract");
        }
        expect(Buffer.byteLength(execution.result.text, "utf8")).toBe(40_000);
        expect(execution.result.text).toBe("😀".repeat(10_000));
        expect(execution.page.snapshotExcerpt).not.toContain("hidden-");
        expect(
          Buffer.byteLength(execution.page.snapshotExcerpt, "utf8"),
        ).toBeLessThanOrEqual(40_000);
      } finally {
        await session.dispose();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 15_000);

  test("exposes only bounded tooltip hints on their stable parent ref", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent(`
        <body>
          <div id="target"><img alt="socket image">Equipment</div>
        </body>
      `);
      await page.evaluate(() => {
        const target = document.querySelector("#target")!;
        target.setAttribute("data-tooltip-trigger", "true");
        target.setAttribute("data-tooltip-id", `item"\n\\${"😀".repeat(100)}`);
        target.setAttribute("title", `Native ${"界".repeat(100)}`);
        target.setAttribute("aria-describedby", "equipment-tooltip");
        target.setAttribute("aria-haspopup", "dialog");
        target.setAttribute("data-state", "open");
        target.setAttribute("data-private", "must-not-leak");
        target.setAttribute("class", "must-not-leak-class");
        target.setAttribute("style", "--secret: must-not-leak-style");
        target.setAttribute("onclick", "mustNotLeakHandler()");

        for (let index = 0; index < 500; index += 1) {
          const filler = document.createElement("div");
          filler.setAttribute("data-tooltip-trigger", "true");
          filler.setAttribute("data-tooltip-id", "x".repeat(1_000));
          filler.textContent = `filler-${index}`;
          document.body.append(filler);
        }
      });
      const session = createBrowserOperationSession({
        page,
        allowedDomains: [],
        initialOrigin: null,
      });
      try {
        const first = await session.observe();
        const second = await session.observe();
        expect(second.snapshotExcerpt).toBe(first.snapshotExcerpt);
        expect(
          Buffer.byteLength(first.snapshotExcerpt, "utf8"),
        ).toBeLessThanOrEqual(40_000);

        const lines = first.snapshotExcerpt.split("\n");
        const parentLine = lines[0]!;
        const childLine = lines[1]!;
        expect(parentLine).toContain("[ref=e1] <div>");
        expect(parentLine).toContain(
          'interaction-hints=[data-tooltip-trigger="true"',
        );
        expect(parentLine).toContain("data-tooltip-id=");
        expect(parentLine).toContain('aria-describedby="equipment-tooltip"');
        expect(parentLine).toContain('aria-haspopup="dialog"');
        expect(childLine).toContain("[ref=e2] <img>");
        expect(childLine).not.toContain("interaction-hints=");
        expect(parentLine).not.toContain("data-state");
        expect(parentLine).not.toContain("data-private");
        expect(parentLine).not.toContain("must-not-leak");
        expect(parentLine).not.toContain("onclick");

        const encodedValues = [
          ...parentLine.matchAll(
            /(?:data-tooltip-id|title)=("(?:\\.|[^"\\])*")/gu,
          ),
        ];
        expect(encodedValues).toHaveLength(2);
        for (const match of encodedValues) {
          const value = JSON.parse(match[1]!) as string;
          expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(128);
        }
        expect(parentLine).toContain('data-tooltip-id="item\\"\\n\\\\');

        const execution = await session.execute({ kind: "extract" });
        expect(
          Buffer.byteLength(JSON.stringify(execution.page), "utf8"),
        ).toBeLessThanOrEqual(56 * 1024);
      } finally {
        await session.dispose();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 15_000);

  test("hover_batch returns ordered portal and visibility text deltas", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent(`
        <body>
          <main>
            <p>unchanged body text</p>
            <button id="portal-target">Portal item</button>
            <button id="visibility-target">Visibility item</button>
            <div id="hidden-tooltip" hidden>Hidden tooltip details</div>
          </main>
        </body>
      `);
      await page.evaluate(() => {
        document
          .querySelector("#portal-target")!
          .addEventListener("mouseover", () => {
            const tooltip = document.createElement("div");
            tooltip.setAttribute("role", "tooltip");
            tooltip.textContent = "Portal tooltip details";
            document.body.append(tooltip);
          });
        document
          .querySelector("#visibility-target")!
          .addEventListener("mouseover", () => {
            document
              .querySelector("#hidden-tooltip")!
              .removeAttribute("hidden");
          });
      });
      const session = createBrowserOperationSession({
        page,
        allowedDomains: [],
        initialOrigin: null,
      });
      try {
        const initial = await session.observe();
        const portalRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Portal item"/,
        )?.[1];
        const visibilityRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Visibility item"/,
        )?.[1];
        expect(portalRef).toBeDefined();
        expect(visibilityRef).toBeDefined();

        const execution = await session.execute({
          kind: "hover_batch",
          refs: [portalRef!, visibilityRef!],
        });

        expect(execution.result).toEqual({
          kind: "hover_batch",
          items: [
            {
              ref: portalRef,
              outcome: "succeeded",
              text: "Portal tooltip details",
            },
            {
              ref: visibilityRef,
              outcome: "succeeded",
              text: "Hidden tooltip details",
            },
          ],
        });
        expect(JSON.stringify(execution.result)).not.toContain(
          "unchanged body text",
        );
      } finally {
        await session.dispose();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 15_000);

  test("hover_batch captures open and nested open shadow tooltip text", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent(`
        <body>
          <button id="open-target">Open shadow item</button>
          <button id="nested-target">Nested shadow item</button>
          <div id="open-host"></div>
          <div id="outer-host"></div>
        </body>
      `);
      await page.evaluate(() => {
        const openRoot = document
          .querySelector("#open-host")!
          .attachShadow({ mode: "open" });
        const openTooltip = document.createElement("span");
        openTooltip.hidden = true;
        openTooltip.textContent = "Open shadow tooltip details";
        openRoot.append(openTooltip);

        const outerRoot = document
          .querySelector("#outer-host")!
          .attachShadow({ mode: "open" });
        const innerHost = document.createElement("div");
        outerRoot.append(innerHost);
        const innerRoot = innerHost.attachShadow({ mode: "open" });
        const nestedTooltip = document.createElement("span");
        nestedTooltip.hidden = true;
        nestedTooltip.textContent = "Nested shadow tooltip details";
        innerRoot.append(nestedTooltip);

        document
          .querySelector("#open-target")!
          .addEventListener("mouseover", () => {
            openTooltip.hidden = false;
          });
        document
          .querySelector("#nested-target")!
          .addEventListener("mouseover", () => {
            nestedTooltip.hidden = false;
          });
      });
      const session = createBrowserOperationSession({
        page,
        allowedDomains: [],
        initialOrigin: null,
      });
      try {
        const initial = await session.observe();
        const openRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Open shadow item"/,
        )?.[1];
        const nestedRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Nested shadow item"/,
        )?.[1];
        expect(openRef).toBeDefined();
        expect(nestedRef).toBeDefined();

        const execution = await session.execute({
          kind: "hover_batch",
          refs: [openRef!, nestedRef!],
        });

        expect(execution.result).toEqual({
          kind: "hover_batch",
          items: [
            {
              ref: openRef,
              outcome: "succeeded",
              text: "Open shadow tooltip details",
            },
            {
              ref: nestedRef,
              outcome: "succeeded",
              text: "Nested shadow tooltip details",
            },
          ],
        });
      } finally {
        await session.dispose();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 15_000);

  test("hover_batch filters hidden generated text and closed shadow content", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent(`
        <style>
          #generated.revealed::after {
            content: "Generated tooltip details";
          }
          #filtered.revealed::before {
            content: "Hidden generated details";
            display: none;
          }
          #filtered.revealed::after {
            content: "";
          }
        </style>
        <body>
          <button id="generated">Generated item</button>
          <button id="filtered">Filtered generated item</button>
          <button id="closed-target">Closed shadow item</button>
          <div id="closed-host"></div>
        </body>
      `);
      await page.evaluate(() => {
        document
          .querySelector("#generated")!
          .addEventListener("mouseover", (event) => {
            (event.currentTarget as Element).classList.add("revealed");
          });
        document
          .querySelector("#filtered")!
          .addEventListener("mouseover", (event) => {
            (event.currentTarget as Element).classList.add("revealed");
          });
        const closedRoot = document
          .querySelector("#closed-host")!
          .attachShadow({ mode: "closed" });
        const closedTooltip = document.createElement("span");
        closedTooltip.hidden = true;
        closedTooltip.textContent = "Closed shadow tooltip details";
        closedRoot.append(closedTooltip);
        document
          .querySelector("#closed-target")!
          .addEventListener("mouseover", () => {
            closedTooltip.hidden = false;
          });
      });
      const session = createBrowserOperationSession({
        page,
        allowedDomains: [],
        initialOrigin: null,
      });
      try {
        const initial = await session.observe();
        const generatedRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Generated item"/,
        )?.[1];
        const filteredRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Filtered generated item"/,
        )?.[1];
        const closedRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Closed shadow item"/,
        )?.[1];
        expect(generatedRef).toBeDefined();
        expect(filteredRef).toBeDefined();
        expect(closedRef).toBeDefined();

        const execution = await session.execute({
          kind: "hover_batch",
          refs: [generatedRef!, filteredRef!, closedRef!],
        });

        expect(execution.result).toEqual({
          kind: "hover_batch",
          items: [
            {
              ref: generatedRef,
              outcome: "succeeded",
              text: "Generated tooltip details",
            },
            { ref: filteredRef, outcome: "succeeded", text: "" },
            { ref: closedRef, outcome: "succeeded", text: "" },
          ],
        });
      } finally {
        await session.dispose();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 15_000);

  test("hover_batch bounds newly visible open shadow text by UTF-8 bytes", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent(`
        <body>
          <button id="bounded-target">Bounded shadow item</button>
          <div id="bounded-host"></div>
        </body>
      `);
      await page.evaluate(() => {
        const root = document
          .querySelector("#bounded-host")!
          .attachShadow({ mode: "open" });
        const tooltip = document.createElement("span");
        tooltip.hidden = true;
        tooltip.textContent = "😀".repeat(1_000);
        root.append(tooltip);
        document
          .querySelector("#bounded-target")!
          .addEventListener("mouseover", () => {
            tooltip.hidden = false;
          });
      });
      const session = createBrowserOperationSession({
        page,
        allowedDomains: [],
        initialOrigin: null,
      });
      try {
        const initial = await session.observe();
        const targetRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Bounded shadow item"/,
        )?.[1];
        expect(targetRef).toBeDefined();

        const execution = await session.execute({
          kind: "hover_batch",
          refs: [targetRef!],
        });

        expect(execution.result.kind).toBe("hover_batch");
        if (execution.result.kind !== "hover_batch") {
          throw new Error("expected hover_batch");
        }
        const item = execution.result.items[0];
        expect(item?.outcome).toBe("succeeded");
        if (item?.outcome !== "succeeded") {
          throw new Error("expected succeeded hover_batch item");
        }
        expect(Buffer.byteLength(item.text, "utf8")).toBe(1_024);
        expect(item.text).toBe("😀".repeat(256));
      } finally {
        await session.dispose();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 15_000);

  test("hover_batch bounds accepted generated text and rejects oversized input before scanning", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.setContent(`
        <style>
          #boundary.revealed::after {
            content: "${"😀".repeat(4_096)}";
          }
          #oversized.revealed::after {
            content: "${"x".repeat(9_000)}";
          }
        </style>
        <body>
          <button id="boundary">Boundary generated item</button>
          <button id="oversized">Oversized generated item</button>
        </body>
      `);
      await page.evaluate(() => {
        const originalTrim = String.prototype.trim;
        String.prototype.trim = function (this: string): string {
          if (this.length > 8_194) {
            throw new Error("oversized generated content was scanned");
          }
          return originalTrim.call(this);
        };
        document
          .querySelector("#boundary")!
          .addEventListener("mouseover", (event) => {
            (event.currentTarget as Element).classList.add("revealed");
          });
        document
          .querySelector("#oversized")!
          .addEventListener("mouseover", (event) => {
            (event.currentTarget as Element).classList.add("revealed");
          });
      });
      const session = createBrowserOperationSession({
        page,
        allowedDomains: [],
        initialOrigin: null,
      });
      try {
        const initial = await session.observe();
        const boundaryRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Boundary generated item"/,
        )?.[1];
        const targetRef = initial.snapshotExcerpt.match(
          /\[ref=(e\d+)\] <button> "Oversized generated item"/,
        )?.[1];
        expect(boundaryRef).toBeDefined();
        expect(targetRef).toBeDefined();

        const execution = await session.execute({
          kind: "hover_batch",
          refs: [boundaryRef!, targetRef!],
        });

        expect(execution.result).toEqual({
          kind: "hover_batch",
          items: [
            {
              ref: boundaryRef,
              outcome: "succeeded",
              text: "😀".repeat(256),
            },
            { ref: targetRef, outcome: "succeeded", text: "" },
          ],
        });
      } finally {
        await session.dispose();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 15_000);

  test("uses Playwright 1.61.1 ElementHandle.type from production declarations", () => {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("playwright/package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version: string;
    };
    const declarations = readFileSync(
      new URL(
        "../playwright-core/types/types.d.ts",
        pathToFileURL(packageJsonPath),
      ),
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
    const execution = session.execute({ kind: "extract" });
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
    await session.execute({ kind: "extract" });
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
    expect(h.page.off).toHaveBeenCalledWith("download", expect.any(Function));
    expect(h.page.off).toHaveBeenCalledWith(
      "framenavigated",
      expect.any(Function),
    );
    await expect(session.execute({ kind: "extract" })).rejects.toThrow(
      "disposed",
    );
  });

  test("dispatches every scalar operation discriminant", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });

    expect((await session.execute({ kind: "extract" })).result).toEqual({
      kind: "extract",
      text: "body text",
    });
    expect(
      (await session.execute({ kind: "click", ref: "e1" })).result,
    ).toEqual({ kind: "click", applied: true });
    expect(
      (await session.execute({ kind: "hover", ref: "e1" })).result,
    ).toEqual({ kind: "hover", applied: true });
    expect(
      (
        await session.execute({
          kind: "type",
          ref: "e1",
          text: "x",
          clear: true,
        })
      ).result,
    ).toEqual({ kind: "type", applied: true });
    expect(
      (await session.execute({ kind: "wait", milliseconds: 10 })).result,
    ).toEqual({ kind: "wait", waitedMs: 10 });
    expect(
      (await session.execute({ kind: "extract", ref: "e1" })).result,
    ).toEqual({ kind: "extract", text: "element text" });
    expect(
      (await session.execute({ kind: "screenshot", fullPage: true }, ACTION_ID))
        .result,
    ).toEqual({
      kind: "screenshot",
      artifactId: ACTION_ID,
      contentType: "image/png",
      byteSize: 3,
      checksum: createHash("sha256").update("png").digest("hex"),
    });
    expect(
      (
        await session.execute({
          kind: "navigate",
          url: "https://example.test/next",
        })
      ).result,
    ).toEqual({ kind: "navigate", applied: true });
    expect(element.click).toHaveBeenNthCalledWith(1, {
      trial: true,
      timeout: 10_000,
    });
    expect(element.click).toHaveBeenNthCalledWith(2);
    expect(element.hover).toHaveBeenNthCalledWith(1, {
      trial: true,
      timeout: 10_000,
    });
    expect(element.hover).toHaveBeenNthCalledWith(2);
    expect(element.fill).toHaveBeenCalledWith("");
    expect(element.type).toHaveBeenCalledWith("x");
    expect(h.page.screenshot).toHaveBeenCalledWith({
      type: "png",
      fullPage: true,
    });
  });

  test("caps refs and observation strings by UTF-8 bytes", async () => {
    const oversized = "😀".repeat(40_001);
    const elements = Array.from({ length: 501 }, () =>
      fakeElement({
        evaluate: vi.fn(async () => [
          {
            connected: true,
            tag: "button",
            role: "button",
            name: "Submit",
            text: oversized,
          },
        ]),
      }),
    );
    const h = fakePage(elements);
    h.setTitle(oversized);
    h.setBody(oversized);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    const execution = await session.execute({ kind: "extract" });

    expect(execution.result.kind).toBe("extract");
    if (execution.result.kind !== "extract")
      throw new Error("expected extract");
    expect(
      Buffer.byteLength(execution.result.text, "utf8"),
    ).toBeLessThanOrEqual(40_000);
    expect(Buffer.byteLength(execution.page.title, "utf8")).toBeLessThanOrEqual(
      4_096,
    );
    expect(
      Buffer.byteLength(execution.page.snapshotExcerpt, "utf8"),
    ).toBeLessThanOrEqual(40_000);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          version: 1,
          type: "action_result",
          sequence: 1,
          actionId: ACTION_ID,
          actionKind: "extract",
          outcome: "succeeded",
          result: execution.result,
          page: execution.page,
        }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(h.page.evaluateHandle).toHaveBeenCalled();
    expect(h.batchedEvaluationCount()).toBe(1);
    expect(h.unboundedElementHandles).not.toHaveBeenCalled();
    expect(elements[500]!.dispose).not.toHaveBeenCalled();
    await expect(
      session.execute({ kind: "click", ref: "e501" }),
    ).rejects.toBeInstanceOf(OperationNoEffectError);
  });

  test("extracts rendered visible text and suppresses hidden refs", async () => {
    const hiddenInnerText = vi.fn(async () => "hidden element");
    const hidden = fakeElement({
      innerText: hiddenInnerText,
      isVisible: vi.fn(async () => false),
      textContent: vi.fn(async () => "hidden element"),
    });
    const h = fakePage([hidden]);
    h.setBody("visible body");
    vi.mocked(h.page.textContent).mockResolvedValueOnce(
      "visible body hidden script style template noscript",
    );
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });

    await expect(session.execute({ kind: "extract" })).resolves.toMatchObject({
      result: { kind: "extract", text: "visible body" },
    });
    await expect(
      session.execute({ kind: "extract", ref: "e1" }),
    ).resolves.toMatchObject({
      result: { kind: "extract", text: "" },
    });
    expect(h.bodyLocator.evaluate).toHaveBeenCalledOnce();
    expect(h.bodyLocator.innerText).not.toHaveBeenCalled();
    expect(h.page.textContent).not.toHaveBeenCalled();
    expect(hiddenInnerText).not.toHaveBeenCalled();
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
    await session.execute({ kind: "extract" });
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
    await session.execute({ kind: "extract" });
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
    await session.execute({ kind: "extract" });
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).resolves.toMatchObject({ result: { kind: "click" } });
    expect(element.click).toHaveBeenNthCalledWith(1, {
      trial: true,
      timeout: 10_000,
    });
    expect(element.click).toHaveBeenNthCalledWith(2);
  });

  test("does not deadlock when navigation waits for Fetch continue", async () => {
    const h = fakePage([fakeElement()], "https://example.test/start", true);
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
    await session.execute({ kind: "extract" });
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
    await session.execute({ kind: "extract" });
    await expect(
      session.execute({ kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({ category: "target_blocked" });
    expect(element.click).not.toHaveBeenCalled();
  });

  test("blocks page-script navigation without learning its origin", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    vi.mocked(element.click).mockImplementation(async (options) => {
      if (options?.trial === true) return;
      expect(await h.emitRoute("https://other.test/script-navigation")).toBe(
        false,
      );
    });
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test", "other.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "extract" });
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
    await session.execute({ kind: "extract" });
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
    await session.execute({ kind: "extract" });
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
    await expect(session.execute({ kind: "extract" })).rejects.toThrow(
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
    await session.execute({ kind: "extract" });
    await h.emitRoute("https://example.test/background", true);
    await expect(session.execute({ kind: "extract" })).rejects.toThrow(
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
    await session.execute({ kind: "extract" });
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
    await session.execute({ kind: "extract" });
    let pause: Promise<boolean> | undefined;
    h.cdpSession.send.mockImplementationOnce(async (method) => {
      expect(method).toBe("Fetch.disable");
      pause = h.emitRoute("https://example.test/during-disable");
      await pause;
      return {};
    });
    await expect(session.dispose()).resolves.toBeUndefined();
    await expect(pause).resolves.toBe(false);
    const disableOrder = h.cdpSession.send.mock.invocationCallOrder.find(
      (_order, index) =>
        h.cdpSession.send.mock.calls[index]?.[0] === "Fetch.disable",
    )!;
    const offOrder = h.cdpSession.off.mock.invocationCallOrder.find(
      (_order, index) =>
        h.cdpSession.off.mock.calls[index]?.[0] === "Fetch.requestPaused",
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
    await session.execute({ kind: "extract" });
    vi.mocked(h.page.waitForTimeout).mockImplementationOnce(async () => {
      h.emitCdpClose();
    });
    await expect(
      session.execute({ kind: "wait", milliseconds: 1 }),
    ).rejects.toThrow("CDP session closed unexpectedly");
    await expect(session.execute({ kind: "extract" })).rejects.toThrow(
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
    await session.execute({ kind: "extract" });
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
    await expect(session.execute({ kind: "extract" })).rejects.toThrow(
      "CDP setup timed out",
    );
    await expect(session.dispose()).rejects.toThrow("CDP setup timed out");
    release();
    await vi.waitFor(() => expect(h.cdpSession.detach).toHaveBeenCalledOnce());
  });

  test("does not downgrade ref probe transport failure to stale_ref", async () => {
    const element = fakeElement();
    const h = fakePage([element]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.execute({ kind: "extract" });
    vi.mocked(element.evaluate).mockRejectedValueOnce(
      new Error("Chromium disconnected"),
    );
    const failure = session.execute({ kind: "click", ref: "e1" });
    await expect(failure).rejects.toThrow("Chromium disconnected");
    await expect(failure).rejects.not.toBeInstanceOf(OperationNoEffectError);
  });

  test("hover requires a current ref and returns a fresh tooltip observation", async () => {
    const elements: OperationElement[] = [];
    const tooltip = fakeElement({
      evaluate: vi.fn(async () => [
        {
          connected: true,
          tag: "div",
          role: "tooltip",
          name: "",
          text: "Morior Invictus Grand Regalia",
        },
      ]),
    });
    const hover = vi.fn(
      async (options?: Parameters<OperationElement["hover"]>[0]) => {
        if (options?.trial !== true) elements.push(tooltip);
      },
    );
    elements.push(fakeElement({ hover }));
    const h = fakePage(elements);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });

    await session.observe();
    const execution = await session.execute({ kind: "hover", ref: "e1" });

    expect(execution.result).toEqual({ kind: "hover", applied: true });
    expect(execution.page.snapshotExcerpt).toContain(
      '[ref=e2] <div> role="tooltip" "Morior Invictus Grand Regalia"',
    );
    expect(hover).toHaveBeenNthCalledWith(1, {
      trial: true,
      timeout: 10_000,
    });
    expect(hover).toHaveBeenNthCalledWith(2);
    await expect(
      session.execute({ kind: "hover", ref: "missing" }),
    ).rejects.toMatchObject({
      category: "stale_ref",
      message: "Locator reference is stale",
    });

    const detached = fakeElement({
      evaluate: vi
        .fn()
        .mockResolvedValueOnce([
          {
            connected: true,
            tag: "div",
            role: "",
            name: "",
            text: "gear",
          },
        ])
        .mockResolvedValueOnce([
          {
            connected: false,
            tag: "div",
            role: "",
            name: "",
            text: "gear",
          },
        ]),
    });
    const detachedPage = fakePage([detached]);
    const detachedSession = createBrowserOperationSession({
      page: detachedPage.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await detachedSession.observe();
    await expect(
      detachedSession.execute({ kind: "hover", ref: "e1" }),
    ).rejects.toMatchObject({
      category: "stale_ref",
      message: "Locator reference is detached",
    });
  });

  test("hover_batch prevalidates every ref before pointer movement", async () => {
    const hover = vi.fn(async () => undefined);
    const h = fakePage([fakeElement({ hover })]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.observe();

    await expect(
      session.execute({ kind: "hover_batch", refs: ["e1", "missing"] }),
    ).rejects.toMatchObject({
      category: "stale_ref",
      message: "Hover batch locator reference is stale",
    });
    expect(hover).not.toHaveBeenCalled();
  });

  test("hover_batch preserves order and continues bounded per-target failures", async () => {
    const successHover = vi.fn(async () => undefined);
    const detached = fakeElement({
      evaluate: vi
        .fn()
        .mockResolvedValueOnce([
          {
            connected: true,
            tag: "button",
            role: "",
            name: "",
            text: "detached",
          },
        ])
        .mockResolvedValueOnce([
          {
            connected: true,
            tag: "button",
            role: "",
            name: "",
            text: "detached",
          },
        ])
        .mockResolvedValueOnce([
          {
            connected: false,
            tag: "button",
            role: "",
            name: "",
            text: "detached",
          },
        ]),
    });
    const coveredHover = vi.fn(
      async (options?: Parameters<OperationElement["hover"]>[0]) => {
        if (options?.trial === true) throw new Error("covered");
      },
    );
    const covered = fakeElement({ hover: coveredHover });
    const h = fakePage([
      fakeElement({ hover: successHover }),
      detached,
      covered,
    ]);
    h.queueHoverBatchDeltas("tooltip details");
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.observe();

    const execution = await session.execute({
      kind: "hover_batch",
      refs: ["e1", "e2", "e3"],
    });

    expect(execution.result).toEqual({
      kind: "hover_batch",
      items: [
        {
          ref: "e1",
          outcome: "succeeded",
          text: "tooltip details",
        },
        {
          ref: "e2",
          outcome: "failed_no_effect",
          error: {
            category: "stale_ref",
            message: "Hover batch locator reference is detached",
          },
        },
        {
          ref: "e3",
          outcome: "failed_no_effect",
          error: {
            category: "target_not_actionable",
            message:
              "Hover batch target did not become actionable within 1000 ms",
          },
        },
      ],
    });
    expect(successHover).toHaveBeenCalledTimes(2);
    expect(coveredHover).toHaveBeenCalledOnce();
  });

  test("hover_batch caps each tooltip delta by UTF-8 bytes", async () => {
    const h = fakePage([fakeElement()]);
    h.queueHoverBatchDeltas("😀".repeat(1_000));
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.observe();

    const execution = await session.execute({
      kind: "hover_batch",
      refs: ["e1"],
    });
    expect(execution.result.kind).toBe("hover_batch");
    if (execution.result.kind !== "hover_batch") {
      throw new Error("expected hover_batch result");
    }
    const item = execution.result.items[0];
    expect(item?.outcome).toBe("succeeded");
    if (item?.outcome !== "succeeded") throw new Error("expected success");
    expect(Buffer.byteLength(item.text, "utf8")).toBe(1_024);
    expect(item.text).toBe("😀".repeat(256));
  });

  test("hover_batch never starts without its bounded deadline authority", async () => {
    const hover = vi.fn(async () => undefined);
    const h = fakePage([fakeElement({ hover })]);
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.observe();

    await expect(
      session.execute({ kind: "hover_batch", refs: ["e1"] }, undefined, {
        deadlineAtMs: Date.now() + 100,
      }),
    ).rejects.toMatchObject({
      category: "target_not_actionable",
      message: "Hover batch requires 8000 ms of remaining action authority",
    });
    expect(hover).not.toHaveBeenCalled();
  });

  test("hover_batch keeps combined result and page within observation budget", async () => {
    const elements = Array.from({ length: 48 }, () =>
      fakeElement({
        evaluate: vi.fn(async () => [
          {
            connected: true,
            tag: "div",
            role: "",
            name: "",
            text: "p".repeat(1_024),
          },
        ]),
      }),
    );
    const h = fakePage(elements);
    h.queueHoverBatchDeltas(
      ...Array.from({ length: 16 }, () => "t".repeat(1_024)),
    );
    const session = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await session.observe();
    const execution = await session.execute({
      kind: "hover_batch",
      refs: Array.from({ length: 16 }, (_, index) => `e${index + 1}`),
    });

    expect(
      Buffer.byteLength(
        JSON.stringify({ page: execution.page, result: execution.result }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(63 * 1_024);
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
  test("sanitizes hover actionability failure as failed_no_effect", async () => {
    const hover = vi.fn(
      async (options?: Parameters<OperationElement["hover"]>[0]) => {
        if (options?.trial === true) {
          throw new Error("chromium secret: element remained covered");
        }
      },
    );
    const h = fakePage([fakeElement({ hover })]);
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.observe();
    const closeAmbiguous = vi.fn(async () => undefined);
    const result = await executeCachedAction({
      cache: new SessionActionCache(),
      request: action({ kind: "hover", ref: "e1" }),
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
    });

    expect(result).toMatchObject({
      outcome: "failed_no_effect",
      error: {
        category: "target_not_actionable",
        message: "Hover target did not become actionable within 10000 ms",
      },
    });
    expect(JSON.stringify(result)).not.toContain("chromium secret");
    expect(hover).toHaveBeenCalledOnce();
    expect(closeAmbiguous).not.toHaveBeenCalled();
  });

  test("replays a successful hover without dispatching pointer movement twice", async () => {
    const hover = vi.fn(async () => undefined);
    const h = fakePage([fakeElement({ hover })]);
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.observe();
    const options = {
      cache: new SessionActionCache(),
      request: action({ kind: "hover", ref: "e1" }),
      withWriter: async <T>(run: () => Promise<T>) => run(),
      executeOperation: (operation: BrowserOperation) =>
        operationSession.execute(operation),
      currentSessionVersion: () => 1,
      currentPage: () => ({
        url: "https://example.test/start",
        title: "",
        snapshotExcerpt: "",
      }),
      commitSuccess: () => 2,
      closeAmbiguous: vi.fn(async () => undefined),
    };

    const first = await executeCachedAction(options);
    const replay = await executeCachedAction(options);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      outcome: "succeeded",
      result: { kind: "hover", applied: true },
    });
    expect(hover).toHaveBeenCalledTimes(2);
    expect(hover).toHaveBeenNthCalledWith(1, {
      trial: true,
      timeout: 10_000,
    });
    expect(hover).toHaveBeenNthCalledWith(2);
  });

  test("closes ambiguous session after hover_batch actual hover failure", async () => {
    const hover = vi.fn(
      async (options?: Parameters<OperationElement["hover"]>[0]) => {
        if (options?.trial !== true)
          throw new Error("pointer transport failed");
      },
    );
    const h = fakePage([fakeElement({ hover })]);
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.observe();
    const closeAmbiguous = vi.fn(async () => undefined);

    await expect(
      executeCachedAction({
        cache: new SessionActionCache(),
        request: action({ kind: "hover_batch", refs: ["e1"] }),
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
    ).rejects.toThrow("pointer transport failed");
    expect(closeAmbiguous).toHaveBeenCalledOnce();
  });

  test("closes ambiguous session after hover_batch delta observation failure", async () => {
    const hover = vi.fn(async () => undefined);
    const h = fakePage([fakeElement({ hover })]);
    h.queueHoverBatchDeltas(new Error("DOM observation transport failed"));
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.observe();
    const closeAmbiguous = vi.fn(async () => undefined);

    await expect(
      executeCachedAction({
        cache: new SessionActionCache(),
        request: action({ kind: "hover_batch", refs: ["e1"] }),
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
    ).rejects.toThrow("DOM observation transport failed");
    expect(closeAmbiguous).toHaveBeenCalledOnce();
  });

  test("replays hover_batch without additional pointer dispatch", async () => {
    const firstHover = vi.fn(async () => undefined);
    const secondHover = vi.fn(async () => undefined);
    const h = fakePage([
      fakeElement({ hover: firstHover }),
      fakeElement({ hover: secondHover }),
    ]);
    h.queueHoverBatchDeltas("first tooltip", "second tooltip");
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.observe();
    const options = {
      cache: new SessionActionCache(),
      request: action({ kind: "hover_batch", refs: ["e1", "e2"] }),
      withWriter: async <T>(run: () => Promise<T>) => run(),
      executeOperation: (operation: BrowserOperation) =>
        operationSession.execute(operation),
      currentSessionVersion: () => 1,
      currentPage: () => ({
        url: "https://example.test/start",
        title: "",
        snapshotExcerpt: "",
      }),
      commitSuccess: () => 2,
      closeAmbiguous: vi.fn(async () => undefined),
    };

    const first = await executeCachedAction(options);
    const replay = await executeCachedAction(options);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      outcome: "succeeded",
      result: {
        kind: "hover_batch",
        items: [
          { ref: "e1", outcome: "succeeded", text: "first tooltip" },
          { ref: "e2", outcome: "succeeded", text: "second tooltip" },
        ],
      },
    });
    expect(firstHover).toHaveBeenCalledTimes(2);
    expect(secondHover).toHaveBeenCalledTimes(2);
  });

  test("returns failed_no_effect when click actionability preflight fails", async () => {
    const click = vi.fn(
      async (options?: Parameters<OperationElement["click"]>[0]) => {
        if (options?.trial === true) {
          throw new Error("element remained covered");
        }
      },
    );
    const h = fakePage([fakeElement({ click })]);
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.execute({ kind: "extract" });
    const closeAmbiguous = vi.fn(async () => undefined);
    const result = await executeCachedAction({
      cache: new SessionActionCache(),
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
    });

    expect(result).toMatchObject({
      outcome: "failed_no_effect",
      error: {
        category: "target_not_actionable",
        message: "Click target did not become actionable within 10000 ms",
      },
    });
    expect(click).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledWith({
      trial: true,
      timeout: 10_000,
    });
    expect(closeAmbiguous).not.toHaveBeenCalled();
  });

  test("keeps click failure after successful preflight ambiguous", async () => {
    const click = vi.fn(
      async (options?: Parameters<OperationElement["click"]>[0]) => {
        if (options?.trial === true) return;
        throw new Error("click dispatch outcome unknown");
      },
    );
    const h = fakePage([fakeElement({ click })]);
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.execute({ kind: "extract" });
    const closeAmbiguous = vi.fn(() => operationSession.dispose());
    const cache = new SessionActionCache();

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
    ).rejects.toThrow("click dispatch outcome unknown");
    expect(click).toHaveBeenNthCalledWith(1, {
      trial: true,
      timeout: 10_000,
    });
    expect(click).toHaveBeenNthCalledWith(2);
    expect(cache.size).toBe(0);
    expect(closeAmbiguous).toHaveBeenCalledOnce();
  });

  test("executes click after successful actionability preflight", async () => {
    const click = vi.fn(
      async (_options?: Parameters<OperationElement["click"]>[0]) => undefined,
    );
    const h = fakePage([fakeElement({ click })]);
    const operationSession = createBrowserOperationSession({
      page: h.page,
      allowedDomains: ["example.test"],
      initialOrigin: "https://example.test",
    });
    await operationSession.execute({ kind: "extract" });
    const closeAmbiguous = vi.fn(async () => undefined);
    const commitSuccess = vi.fn(() => 2);

    await expect(
      executeCachedAction({
        cache: new SessionActionCache(),
        request: action({ kind: "click", ref: "e1" }),
        withWriter: async <T>(run: () => Promise<T>) => run(),
        executeOperation: (operation) => operationSession.execute(operation),
        currentSessionVersion: () => 1,
        currentPage: () => ({
          url: "https://example.test/start",
          title: "",
          snapshotExcerpt: "",
        }),
        commitSuccess,
        closeAmbiguous,
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      result: { kind: "click", applied: true },
      sessionVersion: 2,
    });
    expect(click).toHaveBeenNthCalledWith(1, {
      trial: true,
      timeout: 10_000,
    });
    expect(click).toHaveBeenNthCalledWith(2);
    expect(commitSuccess).toHaveBeenCalledOnce();
    expect(closeAmbiguous).not.toHaveBeenCalled();
  });

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
    await operationSession.execute({ kind: "extract" });
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
    const operation = { kind: "extract" } as const;
    const executeOperation = vi.fn(async () => ({
      result: {
        kind: "extract" as const,
        text: "Example",
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
    const operation = {
      kind: "navigate",
      url: "https://example.test/next",
    } as const;
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
      kind: "navigate",
      url: "https://example.test/next",
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
    launchPersistentChromiumForWorking: async () => Object.freeze({ context }),
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
  const extract = action(
    { kind: "extract" },
    { expectedSessionVersion: session.sessionVersion },
  );

  const first = await registry.executeAction(session.runtimeSessionId, extract);
  const textCalls = h.bodyLocator.innerText.mock.calls.length;
  const replay = await registry.executeAction(
    session.runtimeSessionId,
    extract,
  );
  expect(replay).toEqual(first);
  expect(h.bodyLocator.innerText.mock.calls.length).toBe(textCalls);

  const navigate = action(
    { kind: "navigate", url: "https://example.test/next" },
    {
      actionId: "dddddddd-4444-4444-8444-444444444444",
      sequence: 2,
      expectedSessionVersion: first.sessionVersion,
    },
  );
  vi.mocked(h.page.goto).mockRejectedValueOnce(
    new Error("Chromium disconnected"),
  );
  await expect(
    registry.executeAction(session.runtimeSessionId, navigate),
  ).rejects.toThrow("Chromium disconnected");
  expect(registry.get(session.runtimeSessionId)).toBeUndefined();
  expect(context.close).toHaveBeenCalledOnce();
});
