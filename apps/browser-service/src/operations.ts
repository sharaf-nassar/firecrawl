import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  browserOperationResultSchema,
  type BrowserActionExecutionResultV1,
  type BrowserActionExecutionV1,
  type BrowserOperation,
  type BrowserOperationResultV1,
} from "./contracts.js";
import { type PendingAction, type SessionActionCache } from "./action-cache.js";
import type { CDPSession, ElementHandle, JSHandle, Page } from "playwright";

const MAX_LOCATOR_REFS = 500;
const MAX_PAGE_TEXT_CHARS = 40_000;
const MAX_PAGE_TITLE_BYTES = 4_096;
const MAX_PAGE_TEXT_BYTES = 40_000;
const MAX_PAGE_STATE_JSON_BYTES = 56 * 1024;
const MAX_ACTION_OBSERVATION_COMPONENT_JSON_BYTES = 63 * 1024;
const MAX_NAVIGATION_ORIGINS = 8;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_ELEMENT_TEXT_NODES = 128;
const MAX_ELEMENT_SOURCE_CHARACTERS = 4_096;
const MAX_INTERACTION_HINT_NAME_CHARACTERS = 64;
const MAX_INTERACTION_HINT_NAME_BYTES = 64;
const MAX_INTERACTION_HINT_VALUE_CHARACTERS = 128;
const MAX_INTERACTION_HINT_VALUE_BYTES = 128;
const MAX_INTERACTION_HINTS_BYTES = 768;
const MAX_PAGE_TEXT_NODES = 50_000;
const MAX_PAGE_SOURCE_CHARACTERS = 160_000;
const CLICK_ACTIONABILITY_TIMEOUT_MS = 10_000;
const HOVER_ACTIONABILITY_TIMEOUT_MS = 10_000;
const HOVER_BATCH_ACTIONABILITY_TIMEOUT_MS = 1_000;
const HOVER_BATCH_PHASE_TIMEOUT_MS = 8_000;
const HOVER_BATCH_SETTLE_MS = 75;
const HOVER_BATCH_TEXT_BYTES = 1_024;

type DomObservationLimits = Readonly<{
  maximumCharacters: number;
  maximumBytes: number;
  maximumNodes: number;
  maximumSourceCharacters: number;
  maximumInteractionHintNameCharacters: number;
  maximumInteractionHintNameBytes: number;
  maximumInteractionHintValueCharacters: number;
  maximumInteractionHintValueBytes: number;
  maximumInteractionHintsBytes: number;
}>;

export type OperationElementSnapshot = Readonly<{
  connected: boolean;
  tag: string;
  role: string;
  name: string;
  interactionHints: ReadonlyArray<
    Readonly<{
      name: string;
      value: string;
    }>
  >;
  text: string;
}>;

export type OperationElement = ElementHandle<Node>;
export type OperationPage = Page;

export type BoundedPageState = Readonly<{
  url: string;
  title: string;
  snapshotExcerpt: string;
}>;

export type OperationExecution = Readonly<{
  result: BrowserOperationResultV1;
  page: BoundedPageState;
  artifact?: Readonly<{
    contentType: "image/png";
    bytes: Uint8Array;
  }>;
}>;

export type OperationExecutionContext = Readonly<{
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>;

export type BrowserOperationSession = Readonly<{
  observe(): Promise<BoundedPageState>;
  execute(
    operation: BrowserOperation,
    artifactId?: string,
    context?: OperationExecutionContext,
  ): Promise<OperationExecution>;
  dispose(): Promise<void>;
}>;

type VisibleTextDeltaTracker = {
  capture(): string;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason ?? new Error("browser operation authority ended");
}

export class OperationNoEffectError extends Error {
  readonly category: string;

  constructor(category: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "OperationNoEffectError";
    this.category = category;
  }
}

function boundedDomObservationsInPage(
  roots: Node | readonly Node[],
  limits: DomObservationLimits,
): OperationElementSnapshot[] {
  function observe(root: Node): OperationElementSnapshot {
    function boundedValue(
      value: string,
      maximumCharacters: number,
      maximumBytes: number,
    ): string {
      const chunks: string[] = [];
      let characters = 0;
      let bytes = 0;
      for (const character of value) {
        const codePoint = character.codePointAt(0)!;
        const width =
          codePoint <= 0x7f
            ? 1
            : codePoint <= 0x7ff
              ? 2
              : codePoint <= 0xffff
                ? 3
                : 4;
        if (
          characters + 1 > maximumCharacters ||
          bytes + width > maximumBytes
        ) {
          break;
        }
        chunks.push(character);
        characters += 1;
        bytes += width;
      }
      return chunks.join("");
    }

    const elementRoot = root instanceof Element ? root : null;
    const interactionHints: Array<{ name: string; value: string }> = [];
    let interactionHintBytes = 0;
    if (elementRoot !== null) {
      // Fixed semantic attributes can identify native or scripted tooltip
      // targets without exposing arbitrary page attributes, selectors, or code.
      const allowedInteractionHints = [
        "data-tooltip-trigger",
        "data-tooltip-id",
        "title",
        "aria-describedby",
        "aria-haspopup",
      ] as const;
      for (const attributeName of allowedInteractionHints) {
        const rawValue = elementRoot.getAttribute(attributeName);
        if (rawValue === null) continue;
        const name = boundedValue(
          attributeName,
          limits.maximumInteractionHintNameCharacters,
          limits.maximumInteractionHintNameBytes,
        );
        const value = boundedValue(
          rawValue,
          limits.maximumInteractionHintValueCharacters,
          limits.maximumInteractionHintValueBytes,
        );
        let hintBytes = 1;
        for (const character of name) hintBytes += utf8Width(character);
        for (const character of value) hintBytes += utf8Width(character);
        if (
          interactionHintBytes + hintBytes >
          limits.maximumInteractionHintsBytes
        ) {
          break;
        }
        interactionHints.push({ name, value });
        interactionHintBytes += hintBytes;
      }
    }
    const observation: OperationElementSnapshot = {
      connected: root.isConnected,
      tag:
        elementRoot === null
          ? ""
          : boundedValue(elementRoot.tagName ?? "", 64, 64),
      role:
        elementRoot === null
          ? ""
          : boundedValue(elementRoot.getAttribute("role") ?? "", 128, 128),
      name:
        elementRoot === null
          ? ""
          : boundedValue(
              elementRoot.getAttribute("aria-label") ??
                elementRoot.getAttribute("name") ??
                "",
              512,
              512,
            ),
      interactionHints,
      text: "",
    };
    if (elementRoot === null) return observation;

    const chunks: string[] = [];
    let outputCharacters = 0;
    let outputBytes = 0;
    let visitedNodes = 0;
    let sourceCharacters = 0;
    let pendingSpace = false;
    let exhausted = false;

    function isWhitespace(character: string): boolean {
      return /\s/u.test(character);
    }

    function utf8Width(character: string): number {
      const codePoint = character.codePointAt(0)!;
      if (codePoint <= 0x7f) return 1;
      if (codePoint <= 0x7ff) return 2;
      if (codePoint <= 0xffff) return 3;
      return 4;
    }

    function appendText(value: string): void {
      for (const character of value) {
        sourceCharacters += 1;
        if (sourceCharacters > limits.maximumSourceCharacters) {
          exhausted = true;
          return;
        }
        if (isWhitespace(character)) {
          pendingSpace = outputCharacters !== 0;
          continue;
        }
        const separatorCharacters =
          pendingSpace && outputCharacters !== 0 ? 1 : 0;
        const separatorBytes = separatorCharacters;
        const characterBytes = utf8Width(character);
        if (
          outputCharacters + separatorCharacters + 1 >
            limits.maximumCharacters ||
          outputBytes + separatorBytes + characterBytes > limits.maximumBytes
        ) {
          exhausted = true;
          return;
        }
        if (separatorCharacters !== 0) {
          chunks.push(" ");
          outputCharacters += 1;
          outputBytes += 1;
        }
        chunks.push(character);
        outputCharacters += 1;
        outputBytes += characterBytes;
        pendingSpace = false;
      }
    }

    function inspectElement(element: Element): {
      descend: boolean;
      separatesText: boolean;
    } {
      const tag = element.tagName;
      if (
        tag === "SCRIPT" ||
        tag === "STYLE" ||
        tag === "TEMPLATE" ||
        tag === "NOSCRIPT" ||
        element.hasAttribute("hidden") ||
        (tag === "INPUT" &&
          element.getAttribute("type")?.toLowerCase() === "hidden")
      ) {
        return { descend: false, separatesText: false };
      }
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden"
      ) {
        return { descend: false, separatesText: false };
      }
      return {
        descend: true,
        separatesText:
          tag === "BR" ||
          (style.display !== "inline" &&
            style.display !== "inline-block" &&
            style.display !== "contents"),
      };
    }

    let node: Node | null = root;
    while (node !== null && !exhausted && visitedNodes < limits.maximumNodes) {
      visitedNodes += 1;
      let descend = true;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const inspected = inspectElement(node as Element);
        descend = inspected.descend;
        if (inspected.separatesText && outputCharacters !== 0) {
          pendingSpace = true;
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.nodeValue ?? "");
      } else {
        descend = false;
      }

      if (descend && node.firstChild !== null) {
        node = node.firstChild;
        continue;
      }
      while (node !== root && node.nextSibling === null) {
        node = node.parentNode!;
      }
      node = node === root ? null : node.nextSibling;
    }

    return { ...observation, text: chunks.join("") };
  }

  return (Array.isArray(roots) ? roots : [roots]).map((root) => observe(root));
}

function visibleTextDeltaTrackerInPage(limits: {
  maximumBytes: number;
  maximumNodes: number;
  maximumSourceCharacters: number;
}): VisibleTextDeltaTracker {
  const previous = new Map<Node, string>();

  function isWhitespace(character: string): boolean {
    return /\s/u.test(character);
  }

  function utf8Width(character: string): number {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  }

  function inspectElement(element: Element): boolean {
    const tag = element.tagName;
    if (
      tag === "SCRIPT" ||
      tag === "STYLE" ||
      tag === "TEMPLATE" ||
      tag === "NOSCRIPT" ||
      element.hasAttribute("hidden") ||
      (tag === "INPUT" &&
        element.getAttribute("type")?.toLowerCase() === "hidden")
    ) {
      return false;
    }
    const style = getComputedStyle(element);
    return !(
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden"
    );
  }

  function captureCurrent(includeDelta: boolean): string {
    const current = new Map<Node, string>();
    const deltaChunks: string[] = [];
    let deltaBytes = 0;
    let visitedNodes = 0;
    let sourceCharacters = 0;
    let pendingSpace = false;
    let deltaExhausted = false;

    function appendDelta(value: string): void {
      if (deltaExhausted) return;
      for (const character of value) {
        if (isWhitespace(character)) {
          pendingSpace = deltaChunks.length !== 0;
          continue;
        }
        const characterBytes = utf8Width(character);
        const separatorBytes = pendingSpace && deltaChunks.length !== 0 ? 1 : 0;
        if (
          deltaBytes + separatorBytes + characterBytes >
          limits.maximumBytes
        ) {
          deltaExhausted = true;
          return;
        }
        if (separatorBytes !== 0) {
          deltaChunks.push(" ");
          deltaBytes += 1;
        }
        deltaChunks.push(character);
        deltaBytes += characterBytes;
        pendingSpace = false;
      }
    }

    const root = document.body;
    let node: Node | null = root;
    while (
      node !== null &&
      visitedNodes < limits.maximumNodes &&
      sourceCharacters <= limits.maximumSourceCharacters
    ) {
      visitedNodes += 1;
      let descend = true;
      if (node.nodeType === Node.ELEMENT_NODE) {
        descend = inspectElement(node as Element);
      } else if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue ?? "";
        sourceCharacters += Array.from(value).length;
        if (sourceCharacters > limits.maximumSourceCharacters) break;
        current.set(node, value);
        if (includeDelta && previous.get(node) !== value) appendDelta(value);
      } else {
        descend = false;
      }

      if (descend && node.firstChild !== null) {
        node = node.firstChild;
        continue;
      }
      while (node !== root && node.nextSibling === null) {
        node = node.parentNode!;
      }
      node = node === root ? null : node.nextSibling;
    }

    previous.clear();
    for (const [textNode, value] of current) previous.set(textNode, value);
    return deltaChunks.join("");
  }

  captureCurrent(false);
  return { capture: () => captureCurrent(true) };
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(
  value: string,
  maximumCharacters: number,
  maximumBytes = maximumCharacters,
): string {
  const characters = Array.from(value).slice(0, maximumCharacters);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join("");
}

function truncateForJsonBudget(
  value: string,
  withinBudget: (candidate: string) => boolean,
): string {
  if (withinBudget(value)) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (withinBudget(candidate)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join("");
}

function hostnameAllowed(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const lower = hostname.toLowerCase();
  return allowedDomains.some(
    (domain) => lower === domain || lower.endsWith(`.${domain}`),
  );
}

function checkedHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OperationNoEffectError(
      "target_blocked",
      "Target URL is invalid",
      {
        cause: error,
      },
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new OperationNoEffectError(
      "target_blocked",
      "Target URL is not HTTP(S)",
    );
  }
  return url;
}

function postEffectHttpUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new TypeError("non-HTTP post-effect URL");
    }
    return url;
  } catch (error) {
    throw new Error("browser returned an unsafe post-effect URL", {
      cause: error,
    });
  }
}

function snapshotLine(ref: string, snapshot: OperationElementSnapshot): string {
  const tag = truncateUtf8(snapshot.tag.toLowerCase(), 64);
  const role =
    snapshot.role === ""
      ? ""
      : ` role=${JSON.stringify(truncateUtf8(snapshot.role, 128))}`;
  const name =
    snapshot.name === ""
      ? ""
      : ` name=${JSON.stringify(truncateUtf8(snapshot.name, 512))}`;
  const interactionHints = (snapshot.interactionHints ?? [])
    .map(
      (hint) =>
        `${truncateUtf8(hint.name, MAX_INTERACTION_HINT_NAME_BYTES)}=${JSON.stringify(
          truncateUtf8(hint.value, MAX_INTERACTION_HINT_VALUE_BYTES),
        )}`,
    )
    .join(" ");
  const hints =
    interactionHints === "" ? "" : ` interaction-hints=[${interactionHints}]`;
  const text =
    snapshot.text === ""
      ? ""
      : ` ${JSON.stringify(truncateUtf8(snapshot.text, 1_024))}`;
  return `[ref=${ref}] <${tag}>${role}${name}${hints}${text}`;
}

async function observedWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createBrowserOperationSession(options: {
  page: OperationPage;
  allowedDomains: readonly string[];
  initialOrigin: string | null;
  cdpSetupTimeoutMs?: number;
  cdpTeardownTimeoutMs?: number;
}): BrowserOperationSession {
  const page = options.page;
  const allowedDomains = Object.freeze(
    options.allowedDomains.map((domain) => domain.toLowerCase()),
  );
  const committedOrigins = new Set(
    options.initialOrigin === null
      ? []
      : [checkedHttpUrl(options.initialOrigin).origin],
  );
  const reservedOrigins = new Set<string>();
  const refs = new Map<string, OperationElement>();
  const pausedJobs = new Set<Promise<void>>();
  const cdpSetupTimeoutMs = options.cdpSetupTimeoutMs ?? 5_000;
  const cdpTeardownTimeoutMs = options.cdpTeardownTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(cdpSetupTimeoutMs) || cdpSetupTimeoutMs <= 0) {
    throw new RangeError("cdpSetupTimeoutMs must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(cdpTeardownTimeoutMs) ||
    cdpTeardownTimeoutMs <= 0
  ) {
    throw new RangeError(
      "cdpTeardownTimeoutMs must be a positive safe integer",
    );
  }

  let disposed = false;
  let closing = false;
  let disposePromise: Promise<void> | null = null;
  let setupAbandoned = false;
  let setupFailure: Error | null = null;
  let interceptorFailure: Error | null = null;
  let cdpTeardownFailure: Error | null = null;
  let expectedCdpClose = false;
  let cdp: CDPSession | null = null;
  let fetchEnabled = false;
  let mainFrameId = "";

  async function clearRefs(): Promise<void> {
    const retained = [...refs.values()];
    refs.clear();
    await Promise.allSettled(retained.map((element) => element.dispose()));
  }

  function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  function recordInterceptorFailure(error: unknown, context: string): void {
    const cause = toError(error);
    if (interceptorFailure === null) {
      interceptorFailure = new Error(`${context}: ${cause.message}`, { cause });
    }
  }

  function assertInterceptorHealthy(): void {
    if (setupFailure !== null) throw setupFailure;
    if (interceptorFailure !== null) throw interceptorFailure;
  }

  const downloadHandler = (download: { cancel(): Promise<void> }): void => {
    void download.cancel().catch((error: unknown) => {
      recordInterceptorFailure(error, "download cancellation failed");
    });
  };
  const frameNavigatedHandler = (frame: unknown): void => {
    if (frame === page.mainFrame()) void clearRefs();
  };

  page.on("download", downloadHandler);
  page.on("framenavigated", frameNavigatedHandler);

  type PausedEvent = {
    requestId: string;
    networkId?: string;
    redirectedRequestId?: string;
    frameId?: string;
    resourceType?: string;
    request: { url: string };
  };

  async function failPaused(
    session: CDPSession,
    requestId: string,
  ): Promise<void> {
    await session.send("Fetch.failRequest", {
      requestId,
      errorReason: "BlockedByClient",
    });
  }

  async function handlePaused(event: PausedEvent): Promise<void> {
    const session = cdp;
    if (session === null) return;
    let continued = false;
    try {
      if (closing) {
        await failPaused(session, event.requestId);
        return;
      }

      const mainDocument =
        event.resourceType === "Document" && event.frameId === mainFrameId;
      if (!mainDocument) {
        await session.send("Fetch.continueRequest", {
          requestId: event.requestId,
        });
        continued = true;
        return;
      }

      let target: URL;
      try {
        target = checkedHttpUrl(event.request.url);
      } catch {
        await failPaused(session, event.requestId);
        return;
      }

      if (!committedOrigins.has(target.origin)) {
        await failPaused(session, event.requestId);
        return;
      }

      await session.send("Fetch.continueRequest", {
        requestId: event.requestId,
      });
      continued = true;
    } catch (error) {
      let terminal: unknown = error;
      recordInterceptorFailure(error, "request interception failed");
      if (!continued) {
        try {
          await failPaused(session, event.requestId);
        } catch (settlementError) {
          terminal = new AggregateError(
            [error, settlementError],
            "paused request settlement failed",
          );
          interceptorFailure = new Error(
            `request interception failed: ${toError(terminal).message}`,
            { cause: terminal },
          );
        }
      }
    }
  }

  const pausedHandler = (event: {
    requestId: string;
    networkId?: string;
    redirectedRequestId?: string;
    frameId?: string;
    resourceType?: string;
    request: { url: string };
  }): void => {
    const job = handlePaused(event);
    pausedJobs.add(job);
    void job.then(
      () => {
        pausedJobs.delete(job);
      },
      (error: unknown) => {
        pausedJobs.delete(job);
        recordInterceptorFailure(error, "paused request job failed");
      },
    );
  };

  async function waitForPausedJobs(): Promise<void> {
    await observedWithin(
      (async () => {
        while (pausedJobs.size !== 0) {
          await Promise.all([...pausedJobs]);
        }
      })(),
      cdpTeardownTimeoutMs,
      "paused request drain",
    );
  }

  async function drainPausedJobs(): Promise<void> {
    await waitForPausedJobs();
    assertInterceptorHealthy();
  }

  const cdpCloseHandler = (): void => {
    if (expectedCdpClose) return;
    cdp = null;
    fetchEnabled = false;
    recordInterceptorFailure(
      new Error("CDP session closed unexpectedly"),
      "request interception failed",
    );
  };

  function retainTeardownFailure(
    error: unknown,
    context: string,
    errors: unknown[],
  ): void {
    if (cdpTeardownFailure === null) {
      const cause = toError(error);
      cdpTeardownFailure = new Error(`${context}: ${cause.message}`, { cause });
    }
    errors.push(cdpTeardownFailure);
  }

  async function cleanupCdp(
    session: CDPSession,
    errors: unknown[],
  ): Promise<boolean> {
    if (cdpTeardownFailure !== null) {
      errors.push(cdpTeardownFailure);
      return false;
    }
    if (fetchEnabled) {
      try {
        await observedWithin(
          session.send("Fetch.disable"),
          cdpTeardownTimeoutMs,
          "Fetch.disable",
        );
      } catch (error) {
        retainTeardownFailure(error, "Fetch disable failed", errors);
        return false;
      }
      fetchEnabled = false;
    }
    try {
      await waitForPausedJobs();
    } catch (error) {
      retainTeardownFailure(error, "paused request drain failed", errors);
      return false;
    }
    try {
      session.off("Fetch.requestPaused", pausedHandler);
    } catch (error) {
      retainTeardownFailure(error, "Fetch listener removal failed", errors);
      return false;
    }
    expectedCdpClose = true;
    try {
      await observedWithin(
        session.detach(),
        cdpTeardownTimeoutMs,
        "CDP detach",
      );
    } catch (error) {
      expectedCdpClose = false;
      retainTeardownFailure(error, "CDP detach failed", errors);
      return false;
    }
    try {
      session.off("close", cdpCloseHandler);
    } catch (error) {
      expectedCdpClose = false;
      retainTeardownFailure(error, "CDP close listener removal failed", errors);
      return false;
    }
    expectedCdpClose = false;
    return true;
  }

  const rawRouteReady = (async () => {
    const session = await page.context().newCDPSession(page);
    cdp = session;
    session.on("close", cdpCloseHandler);
    if (disposed || setupAbandoned) {
      closing = true;
      const errors: unknown[] = [];
      const verified = await cleanupCdp(session, errors);
      if (verified && cdp === session) cdp = null;
      if (errors.length !== 0) {
        throw new AggregateError(errors, "late CDP setup cleanup failed");
      }
      return;
    }
    try {
      const tree = (await session.send("Page.getFrameTree")) as {
        frameTree: { frame: { id: string } };
      };
      mainFrameId = tree.frameTree.frame.id;
      if (disposed || setupAbandoned) {
        closing = true;
        const errors: unknown[] = [];
        const verified = await cleanupCdp(session, errors);
        if (verified && cdp === session) cdp = null;
        if (errors.length !== 0) {
          throw new AggregateError(errors, "late CDP setup cleanup failed");
        }
        return;
      }
      session.on("Fetch.requestPaused", pausedHandler);
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      fetchEnabled = true;
      if (disposed || setupAbandoned) {
        closing = true;
        const errors: unknown[] = [];
        const verified = await cleanupCdp(session, errors);
        if (verified && cdp === session) cdp = null;
        if (errors.length !== 0) {
          throw new AggregateError(errors, "late CDP setup cleanup failed");
        }
      }
    } catch (error) {
      if (cdp === session) {
        closing = true;
        const errors: unknown[] = [error];
        const verified = await cleanupCdp(session, errors);
        if (verified && cdp === session) cdp = null;
        throw new AggregateError(errors, "CDP setup failed");
      }
      throw error;
    }
  })();

  const routeReady = observedWithin(
    rawRouteReady,
    cdpSetupTimeoutMs,
    "CDP setup",
  ).catch((error: unknown) => {
    setupAbandoned = true;
    closing = true;
    setupFailure = toError(error);
    throw error;
  });

  function assertOpen(): void {
    if (disposed) throw new Error("operation session is disposed");
  }

  function requireNavigateTarget(value: string): URL {
    const url = checkedHttpUrl(value);
    if (
      !committedOrigins.has(url.origin) &&
      !hostnameAllowed(url.hostname, allowedDomains)
    ) {
      throw new OperationNoEffectError(
        "target_blocked",
        "Navigation target is outside session authority",
      );
    }
    return url;
  }

  function requireCommittedClickTarget(value: string): URL {
    const url = checkedHttpUrl(value);
    if (!committedOrigins.has(url.origin)) {
      throw new OperationNoEffectError(
        "target_blocked",
        "Click target origin has not been authorized by explicit navigation",
      );
    }
    return url;
  }

  async function describeElement(
    element: OperationElement,
  ): Promise<OperationElementSnapshot> {
    const [snapshot] = await element.evaluate(boundedDomObservationsInPage, {
      maximumCharacters: 1_024,
      maximumBytes: 1_024,
      maximumNodes: MAX_ELEMENT_TEXT_NODES,
      maximumSourceCharacters: MAX_ELEMENT_SOURCE_CHARACTERS,
      maximumInteractionHintNameCharacters:
        MAX_INTERACTION_HINT_NAME_CHARACTERS,
      maximumInteractionHintNameBytes: MAX_INTERACTION_HINT_NAME_BYTES,
      maximumInteractionHintValueCharacters:
        MAX_INTERACTION_HINT_VALUE_CHARACTERS,
      maximumInteractionHintValueBytes: MAX_INTERACTION_HINT_VALUE_BYTES,
      maximumInteractionHintsBytes: MAX_INTERACTION_HINTS_BYTES,
    });
    if (snapshot === undefined) {
      throw new Error("browser returned an empty element observation");
    }
    return snapshot;
  }

  async function requireRef(ref: string): Promise<OperationElement> {
    const element = refs.get(ref);
    if (element === undefined) {
      throw new OperationNoEffectError(
        "stale_ref",
        "Locator reference is stale",
      );
    }
    const snapshot = await describeElement(element);
    if (!snapshot.connected) {
      throw new OperationNoEffectError(
        "stale_ref",
        "Locator reference is detached",
      );
    }
    return element;
  }

  async function pageState(
    snapshotExcerpt?: string,
  ): Promise<BoundedPageState> {
    const [title, body] = await Promise.all([
      page.title(),
      snapshotExcerpt === undefined
        ? extractVisibleText(undefined)
        : Promise.resolve(snapshotExcerpt),
    ]);
    const url = page.url();
    const boundedTitle = truncateUtf8(title, 4_096, MAX_PAGE_TITLE_BYTES);
    const boundedExcerpt = truncateUtf8(
      body ?? "",
      MAX_PAGE_TEXT_CHARS,
      MAX_PAGE_TEXT_BYTES,
    );
    return {
      url,
      title: boundedTitle,
      snapshotExcerpt: truncateForJsonBudget(
        boundedExcerpt,
        (candidate) =>
          encodedBytes({
            url,
            title: boundedTitle,
            snapshotExcerpt: candidate,
          }) <= MAX_PAGE_STATE_JSON_BYTES,
      ),
    };
  }

  async function boundedElements(): Promise<
    ReadonlyArray<
      Readonly<{
        element: OperationElement;
        snapshot: OperationElementSnapshot;
      }>
    >
  > {
    const collection = await page.evaluateHandle((maximumElements) => {
      const retained: Element[] = [];
      const root = document.body;
      let element = root?.firstElementChild ?? null;
      while (element !== null && retained.length < maximumElements) {
        retained.push(element);
        if (element.firstElementChild !== null) {
          element = element.firstElementChild;
          continue;
        }
        let ancestor: Element | null = element;
        while (
          ancestor !== null &&
          ancestor !== root &&
          ancestor.nextElementSibling === null
        ) {
          ancestor = ancestor.parentElement;
        }
        element =
          ancestor === null || ancestor === root
            ? null
            : ancestor.nextElementSibling;
      }
      return retained;
    }, MAX_LOCATOR_REFS);
    const handles: OperationElement[] = [];
    try {
      const snapshots = await collection.evaluate(
        boundedDomObservationsInPage,
        {
          maximumCharacters: 1_024,
          maximumBytes: 1_024,
          maximumNodes: MAX_ELEMENT_TEXT_NODES,
          maximumSourceCharacters: MAX_ELEMENT_SOURCE_CHARACTERS,
          maximumInteractionHintNameCharacters:
            MAX_INTERACTION_HINT_NAME_CHARACTERS,
          maximumInteractionHintNameBytes: MAX_INTERACTION_HINT_NAME_BYTES,
          maximumInteractionHintValueCharacters:
            MAX_INTERACTION_HINT_VALUE_CHARACTERS,
          maximumInteractionHintValueBytes: MAX_INTERACTION_HINT_VALUE_BYTES,
          maximumInteractionHintsBytes: MAX_INTERACTION_HINTS_BYTES,
        },
      );
      const properties = await collection.getProperties();
      const retained: Array<{
        element: OperationElement;
        snapshot: OperationElementSnapshot;
      }> = [];
      for (let index = 0; index < MAX_LOCATOR_REFS; index += 1) {
        const property = properties.get(String(index));
        if (property === undefined) break;
        const element = property.asElement();
        if (element === null) {
          await property.dispose();
          continue;
        }
        handles.push(element);
        const snapshot = snapshots[index];
        if (snapshot === undefined) {
          await element.dispose().catch(() => undefined);
          handles.pop();
          continue;
        }
        retained.push({ element, snapshot });
      }
      return retained;
    } catch (error) {
      await Promise.all(
        handles.map((handle) => handle.dispose().catch(() => undefined)),
      );
      throw error;
    } finally {
      await collection.dispose();
    }
  }

  async function extractVisibleText(ref: string | undefined): Promise<string> {
    if (ref === undefined) {
      const body = page.locator("body");
      if (!(await body.isVisible())) return "";
      const [observation] = await body.evaluate(boundedDomObservationsInPage, {
        maximumCharacters: MAX_PAGE_TEXT_CHARS,
        maximumBytes: MAX_PAGE_TEXT_BYTES,
        maximumNodes: MAX_PAGE_TEXT_NODES,
        maximumSourceCharacters: MAX_PAGE_SOURCE_CHARACTERS,
        maximumInteractionHintNameCharacters:
          MAX_INTERACTION_HINT_NAME_CHARACTERS,
        maximumInteractionHintNameBytes: MAX_INTERACTION_HINT_NAME_BYTES,
        maximumInteractionHintValueCharacters:
          MAX_INTERACTION_HINT_VALUE_CHARACTERS,
        maximumInteractionHintValueBytes: MAX_INTERACTION_HINT_VALUE_BYTES,
        maximumInteractionHintsBytes: MAX_INTERACTION_HINTS_BYTES,
      });
      if (observation === undefined) return "";
      return observation.text;
    }
    const element = await requireRef(ref);
    if (!(await element.isVisible())) return "";
    const [observation] = await element.evaluate(boundedDomObservationsInPage, {
      maximumCharacters: MAX_PAGE_TEXT_CHARS,
      maximumBytes: MAX_PAGE_TEXT_BYTES,
      maximumNodes: MAX_PAGE_TEXT_NODES,
      maximumSourceCharacters: MAX_PAGE_SOURCE_CHARACTERS,
      maximumInteractionHintNameCharacters:
        MAX_INTERACTION_HINT_NAME_CHARACTERS,
      maximumInteractionHintNameBytes: MAX_INTERACTION_HINT_NAME_BYTES,
      maximumInteractionHintValueCharacters:
        MAX_INTERACTION_HINT_VALUE_CHARACTERS,
      maximumInteractionHintValueBytes: MAX_INTERACTION_HINT_VALUE_BYTES,
      maximumInteractionHintsBytes: MAX_INTERACTION_HINTS_BYTES,
    });
    if (observation === undefined) return "";
    return observation.text;
  }

  async function createVisibleTextDeltaTracker(): Promise<
    JSHandle<VisibleTextDeltaTracker>
  > {
    return page.evaluateHandle(visibleTextDeltaTrackerInPage, {
      maximumBytes: HOVER_BATCH_TEXT_BYTES,
      maximumNodes: MAX_PAGE_TEXT_NODES,
      maximumSourceCharacters: MAX_PAGE_SOURCE_CHARACTERS,
    });
  }

  async function prevalidateHoverBatch(
    batchRefs: readonly string[],
  ): Promise<ReadonlyArray<{ ref: string; element: OperationElement }>> {
    const retained = batchRefs.map((ref) => {
      const element = refs.get(ref);
      if (element === undefined) {
        throw new OperationNoEffectError(
          "stale_ref",
          "Hover batch locator reference is stale",
        );
      }
      return { ref, element };
    });
    const snapshots = await Promise.all(
      retained.map(({ element }) => describeElement(element)),
    );
    if (snapshots.some((snapshot) => !snapshot.connected)) {
      throw new OperationNoEffectError(
        "stale_ref",
        "Hover batch locator reference is detached",
      );
    }
    return retained;
  }

  async function observePage(): Promise<BoundedPageState> {
    const retained = await boundedElements();
    await clearRefs();
    const lines: string[] = [];
    for (let index = 0; index < retained.length; index += 1) {
      const { element, snapshot } = retained[index]!;
      const ref = `e${index + 1}`;
      if (!snapshot.connected) {
        await element.dispose().catch(() => undefined);
        continue;
      }
      refs.set(ref, element);
      lines.push(snapshotLine(ref, snapshot));
    }
    const excerpt = truncateUtf8(
      lines.join("\n"),
      MAX_PAGE_TEXT_CHARS,
      MAX_PAGE_TEXT_BYTES,
    );
    return pageState(excerpt);
  }

  async function execute(
    operation: BrowserOperation,
    artifactId = randomUUID(),
    context: OperationExecutionContext = {},
  ): Promise<OperationExecution> {
    assertOpen();
    await routeReady;
    assertOpen();
    assertInterceptorHealthy();
    let result: BrowserOperationResultV1;
    let artifact: OperationExecution["artifact"];

    switch (operation.kind) {
      case "click": {
        const element = await requireRef(operation.ref);
        const href = await element.getAttribute("href");
        if (href !== null) {
          let resolvedHref: string;
          try {
            resolvedHref = new URL(href, page.url()).href;
          } catch (error) {
            throw new OperationNoEffectError(
              "target_blocked",
              "Click target URL is invalid",
              { cause: error },
            );
          }
          requireCommittedClickTarget(resolvedHref);
        }
        try {
          await element.click({
            trial: true,
            timeout: CLICK_ACTIONABILITY_TIMEOUT_MS,
          });
        } catch (error) {
          throw new OperationNoEffectError(
            "target_not_actionable",
            "Click target did not become actionable within 10000 ms",
            { cause: error },
          );
        }
        await element.click();
        const finalUrl = postEffectHttpUrl(page.url());
        if (!committedOrigins.has(finalUrl.origin)) {
          throw new Error("clicked navigation escaped session authority");
        }
        result = { kind: "click", applied: true };
        break;
      }
      case "hover": {
        const element = await requireRef(operation.ref);
        try {
          await element.hover({
            trial: true,
            timeout: HOVER_ACTIONABILITY_TIMEOUT_MS,
          });
        } catch (error) {
          throw new OperationNoEffectError(
            "target_not_actionable",
            "Hover target did not become actionable within 10000 ms",
            { cause: error },
          );
        }
        await element.hover();
        result = { kind: "hover", applied: true };
        break;
      }
      case "hover_batch": {
        const startedAtMs = Date.now();
        throwIfAborted(context.signal);
        if (
          context.deadlineAtMs !== undefined &&
          context.deadlineAtMs - startedAtMs < HOVER_BATCH_PHASE_TIMEOUT_MS
        ) {
          throw new OperationNoEffectError(
            "target_not_actionable",
            "Hover batch requires 8000 ms of remaining action authority",
          );
        }
        const retained = await prevalidateHoverBatch(operation.refs);
        const phaseDeadlineAtMs = Math.min(
          startedAtMs + HOVER_BATCH_PHASE_TIMEOUT_MS,
          context.deadlineAtMs ?? Number.POSITIVE_INFINITY,
        );
        const tracker = await createVisibleTextDeltaTracker();
        const items: Array<
          | {
              ref: string;
              outcome: "succeeded";
              text: string;
            }
          | {
              ref: string;
              outcome: "failed_no_effect";
              error: {
                category: "stale_ref" | "target_not_actionable";
                message: string;
              };
            }
        > = [];
        try {
          for (const { ref, element } of retained) {
            throwIfAborted(context.signal);
            const remainingBeforeProbe = phaseDeadlineAtMs - Date.now();
            if (remainingBeforeProbe <= HOVER_BATCH_SETTLE_MS + 1) {
              items.push({
                ref,
                outcome: "failed_no_effect",
                error: {
                  category: "target_not_actionable",
                  message: "Hover batch phase deadline was exhausted",
                },
              });
              continue;
            }

            const snapshot = await describeElement(element);
            if (!snapshot.connected) {
              items.push({
                ref,
                outcome: "failed_no_effect",
                error: {
                  category: "stale_ref",
                  message: "Hover batch locator reference is detached",
                },
              });
              continue;
            }

            try {
              await element.hover({
                trial: true,
                timeout: Math.min(
                  HOVER_BATCH_ACTIONABILITY_TIMEOUT_MS,
                  Math.max(1, remainingBeforeProbe - HOVER_BATCH_SETTLE_MS),
                ),
              });
            } catch (error) {
              throwIfAborted(context.signal);
              const afterProbe = await describeElement(element);
              items.push(
                afterProbe.connected
                  ? {
                      ref,
                      outcome: "failed_no_effect",
                      error: {
                        category: "target_not_actionable",
                        message:
                          "Hover batch target did not become actionable within 1000 ms",
                      },
                    }
                  : {
                      ref,
                      outcome: "failed_no_effect",
                      error: {
                        category: "stale_ref",
                        message: "Hover batch locator reference is detached",
                      },
                    },
              );
              continue;
            }

            const remainingBeforeHover = phaseDeadlineAtMs - Date.now();
            if (remainingBeforeHover <= HOVER_BATCH_SETTLE_MS + 1) {
              items.push({
                ref,
                outcome: "failed_no_effect",
                error: {
                  category: "target_not_actionable",
                  message: "Hover batch phase deadline was exhausted",
                },
              });
              continue;
            }
            await element.hover({
              timeout: Math.max(
                1,
                remainingBeforeHover - HOVER_BATCH_SETTLE_MS,
              ),
            });
            throwIfAborted(context.signal);
            const settleMs = Math.min(
              HOVER_BATCH_SETTLE_MS,
              Math.max(0, phaseDeadlineAtMs - Date.now()),
            );
            if (settleMs > 0) await page.waitForTimeout(settleMs);
            const text = await tracker.evaluate((value) => value.capture());
            items.push({
              ref,
              outcome: "succeeded",
              text: truncateUtf8(
                text,
                HOVER_BATCH_TEXT_BYTES,
                HOVER_BATCH_TEXT_BYTES,
              ),
            });
          }
        } finally {
          await tracker.dispose();
        }
        result = { kind: "hover_batch", items };
        break;
      }
      case "type": {
        const element = await requireRef(operation.ref);
        if (operation.clear === true) await element.fill("");
        await element.type(operation.text);
        result = { kind: "type", applied: true };
        break;
      }
      case "wait":
        await page.waitForTimeout(operation.milliseconds);
        result = { kind: "wait", waitedMs: operation.milliseconds };
        break;
      case "extract": {
        const text = await extractVisibleText(operation.ref);
        result = {
          kind: "extract",
          text: truncateUtf8(text, MAX_PAGE_TEXT_CHARS, MAX_PAGE_TEXT_BYTES),
        };
        break;
      }
      case "screenshot": {
        const bytes = await page.screenshot({
          type: "png",
          fullPage: operation.fullPage ?? false,
        });
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
          throw new OperationNoEffectError(
            "artifact_too_large",
            "Screenshot exceeds its byte limit",
          );
        }
        result = {
          kind: "screenshot",
          artifactId,
          contentType: "image/png",
          byteSize: bytes.byteLength,
          checksum: createHash("sha256").update(bytes).digest("hex"),
        };
        artifact = {
          contentType: "image/png",
          bytes: Uint8Array.from(bytes),
        };
        break;
      }
      case "navigate": {
        const target = requireNavigateTarget(operation.url);
        const grantsOrigin = !committedOrigins.has(target.origin);
        if (
          grantsOrigin &&
          committedOrigins.size + reservedOrigins.size >= MAX_NAVIGATION_ORIGINS
        ) {
          throw new OperationNoEffectError(
            "target_blocked",
            "Navigation origin capacity is exhausted",
          );
        }
        if (grantsOrigin) reservedOrigins.add(target.origin);
        try {
          await clearRefs();
        } catch (error) {
          if (grantsOrigin) reservedOrigins.delete(target.origin);
          throw error;
        }
        if (grantsOrigin) {
          try {
            committedOrigins.add(target.origin);
          } finally {
            reservedOrigins.delete(target.origin);
          }
        }
        await page.goto(target.href);
        await drainPausedJobs();
        const finalUrl = postEffectHttpUrl(page.url());
        if (!committedOrigins.has(finalUrl.origin)) {
          throw new Error("navigation redirect escaped session authority");
        }
        result = { kind: "navigate", applied: true };
        break;
      }
    }

    await drainPausedJobs();
    let boundedPage = await observePage();
    if (result.kind === "extract") {
      result = {
        ...result,
        text: truncateForJsonBudget(
          result.text,
          (candidate) =>
            encodedBytes({
              page: boundedPage,
              result: { kind: "extract", text: candidate },
            }) <= MAX_ACTION_OBSERVATION_COMPONENT_JSON_BYTES,
        ),
      };
    }
    if (result.kind === "hover_batch") {
      boundedPage = {
        ...boundedPage,
        snapshotExcerpt: truncateForJsonBudget(
          boundedPage.snapshotExcerpt,
          (candidate) =>
            encodedBytes({
              page: { ...boundedPage, snapshotExcerpt: candidate },
              result,
            }) <= MAX_ACTION_OBSERVATION_COMPONENT_JSON_BYTES,
        ),
      };
    }
    const boundedResult = browserOperationResultSchema.parse(result);
    return {
      result: boundedResult,
      page: boundedPage,
      ...(artifact === undefined ? {} : { artifact }),
    };
  }

  return Object.freeze({
    async observe() {
      assertOpen();
      await routeReady;
      assertOpen();
      assertInterceptorHealthy();
      return observePage();
    },
    execute,
    dispose() {
      if (disposePromise !== null) return disposePromise;
      disposed = true;
      closing = true;
      disposePromise = (async () => {
        const errors: unknown[] = [];
        try {
          page.off("download", downloadHandler);
        } catch (error) {
          errors.push(error);
        }
        try {
          page.off("framenavigated", frameNavigatedHandler);
        } catch (error) {
          errors.push(error);
        }
        try {
          await routeReady;
        } catch (error) {
          errors.push(error);
        }
        if (cdp !== null) {
          const session = cdp;
          const verified = await cleanupCdp(session, errors);
          if (verified && cdp === session) cdp = null;
        }
        try {
          await observedWithin(
            clearRefs(),
            cdpTeardownTimeoutMs,
            "element ref cleanup",
          );
        } catch (error) {
          errors.push(error);
        }
        if (
          interceptorFailure !== null &&
          !errors.includes(interceptorFailure)
        ) {
          errors.push(interceptorFailure);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "operation session disposal failed");
        }
      })();
      return disposePromise;
    },
  });
}

type CachedActionOptions = {
  cache: SessionActionCache;
  request: unknown;
  withWriter<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  executeOperation(
    operation: BrowserOperation,
    signal: AbortSignal,
    actionId: string,
  ): Promise<OperationExecution>;
  currentSessionVersion(): number;
  currentPage(): BoundedPageState;
  commitSuccess(execution: OperationExecution): number;
  closeAmbiguous(): Promise<void>;
};

export async function executeCachedAction(
  options: CachedActionOptions,
): Promise<BrowserActionExecutionResultV1> {
  const request = actionExecutionRequestSchema.parse(
    options.request,
  ) as BrowserActionExecutionV1;
  const lookup = options.cache.begin(request);
  if (lookup.kind === "replay") return lookup.result;

  const pending: PendingAction = lookup.pending;
  let pendingActive = true;
  let enteredWriter = false;
  let candidate: BrowserActionExecutionResultV1;

  async function closeAfterAmbiguous(primary: unknown): Promise<never> {
    try {
      await options.closeAmbiguous();
    } catch (closeError) {
      throw new AggregateError(
        [primary, closeError],
        `ambiguous action failed and session close failed: ${
          closeError instanceof Error ? closeError.message : String(closeError)
        }`,
      );
    }
    throw primary;
  }

  try {
    candidate = await options.withWriter(async (signal) => {
      enteredWriter = true;
      const currentVersion = options.currentSessionVersion();
      if (request.expectedSessionVersion !== currentVersion) {
        return actionExecutionResultSchema.parse({
          version: 1,
          actionId: request.actionId,
          sequence: request.sequence,
          normalizedProposalHash: request.normalizedProposalHash,
          outcome: "failed_no_effect",
          error: {
            category: "session_version_mismatch",
            message: "Expected session version does not match",
          },
          page: options.currentPage(),
          sessionVersion: currentVersion,
        });
      }

      let execution: OperationExecution;
      try {
        execution = await options.executeOperation(
          request.operation,
          signal,
          request.actionId,
        );
      } catch (error) {
        if (error instanceof OperationNoEffectError) {
          return actionExecutionResultSchema.parse({
            version: 1,
            actionId: request.actionId,
            sequence: request.sequence,
            normalizedProposalHash: request.normalizedProposalHash,
            outcome: "failed_no_effect",
            error: {
              category: error.category,
              message: error.message,
            },
            page: options.currentPage(),
            sessionVersion: currentVersion,
          });
        }
        throw error;
      }

      const nextVersion = options.commitSuccess(execution);
      return actionExecutionResultSchema.parse({
        version: 1,
        actionId: request.actionId,
        sequence: request.sequence,
        normalizedProposalHash: request.normalizedProposalHash,
        outcome: "succeeded",
        result: execution.result,
        page: execution.page,
        sessionVersion: nextVersion,
      });
    });
  } catch (error) {
    if (pendingActive) {
      options.cache.abandon(pending);
      pendingActive = false;
    }
    if (enteredWriter) await closeAfterAmbiguous(error);
    throw error;
  }

  try {
    const terminal =
      candidate.outcome === "succeeded"
        ? options.cache.succeed(pending, candidate)
        : options.cache.failNoEffect(pending, candidate);
    pendingActive = false;
    return terminal;
  } catch (error) {
    if (pendingActive) {
      try {
        options.cache.abandon(pending);
      } catch {
        // Completion consumed the opaque pending token before rejecting.
      }
      pendingActive = false;
    }
    if (enteredWriter) await closeAfterAmbiguous(error);
    throw error;
  }
}
