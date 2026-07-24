import {
  MAX_EVALUATE_RESULT_BYTES,
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  browserOperationResultSchema,
  canonicalJson,
  encodedBytes,
  jsonSafeSchema,
  type BrowserActionExecutionResultV1,
  type BrowserActionExecutionV1,
  type BrowserOperation,
  type BrowserOperationResultV1,
  type JsonSafe,
} from "./contracts.js";
import {
  type PendingAction,
  type SessionActionCache,
} from "./action-cache.js";
import {
  EvaluatePolicyError,
  parseAndValidateEvaluateExpression,
} from "./evaluate-policy.js";
import type { CDPSession, ElementHandle, Page } from "playwright";

const MAX_LOCATOR_REFS = 500;
const MAX_PAGE_TEXT_CHARS = 40_000;
const MAX_NAVIGATION_ORIGINS = 8;

export type OperationElementSnapshot = Readonly<{
  connected: boolean;
  tag: string;
  role: string;
  name: string;
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
}>;

export type BrowserOperationSession = Readonly<{
  execute(operation: BrowserOperation): Promise<OperationExecution>;
  dispose(): Promise<void>;
}>;

export class OperationNoEffectError extends Error {
  readonly category: string;

  constructor(category: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "OperationNoEffectError";
    this.category = category;
  }
}

function truncate(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function hostnameAllowed(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const lower = hostname.toLowerCase();
  return allowedDomains.some(
    (domain) =>
      lower === domain || lower.endsWith(`.${domain}`),
  );
}

function checkedHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OperationNoEffectError("target_blocked", "Target URL is invalid", {
      cause: error,
    });
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

function snapshotLine(
  ref: string,
  snapshot: OperationElementSnapshot,
): string {
  const tag = truncate(snapshot.tag.toLowerCase(), 64);
  const role =
    snapshot.role === "" ? "" : ` role=${JSON.stringify(truncate(snapshot.role, 128))}`;
  const name =
    snapshot.name === "" ? "" : ` name=${JSON.stringify(truncate(snapshot.name, 512))}`;
  const text =
    snapshot.text === "" ? "" : ` ${JSON.stringify(truncate(snapshot.text, 1_024))}`;
  return `[ref=${ref}] <${tag}>${role}${name}${text}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalEvaluateJson(value: JsonSafe): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalEvaluateJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareUtf8);
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalEvaluateJson(value[key]!)}`,
    )
    .join(",")}}`;
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
  initialOrigin: string;
  cdpSetupTimeoutMs?: number;
  cdpTeardownTimeoutMs?: number;
}): BrowserOperationSession {
  const page = options.page;
  const allowedDomains = Object.freeze(
    options.allowedDomains.map((domain) => domain.toLowerCase()),
  );
  const committedOrigins = new Set([
    checkedHttpUrl(options.initialOrigin).origin,
  ]);
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
      interceptorFailure = new Error(
        `${context}: ${cause.message}`,
        { cause },
      );
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
      cdpTeardownFailure = new Error(
        `${context}: ${cause.message}`,
        { cause },
      );
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
      retainTeardownFailure(
        error,
        "CDP close listener removal failed",
        errors,
      );
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
    return element.evaluate((node) => {
      const elementNode = node as Element;
      const html = node as HTMLElement;
      return {
        connected: node.isConnected,
        tag: elementNode.tagName ?? "",
        role: elementNode.getAttribute("role") ?? "",
        name:
          elementNode.getAttribute("aria-label") ??
          elementNode.getAttribute("name") ??
          "",
        text: html.innerText ?? node.textContent ?? "",
      };
    });
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
        ? page.textContent("body")
        : Promise.resolve(snapshotExcerpt),
    ]);
    return {
      url: page.url(),
      title: truncate(title, 4_096),
      snapshotExcerpt: truncate(body ?? "", MAX_PAGE_TEXT_CHARS),
    };
  }

  async function takeSnapshot(): Promise<OperationExecution> {
    const handles = await page.locator("body *").elementHandles();
    const retained = handles.slice(0, MAX_LOCATOR_REFS);
    const excess = handles.slice(MAX_LOCATOR_REFS);
    await clearRefs();
    await Promise.allSettled(excess.map((element) => element.dispose()));
    const lines: string[] = [];
    for (let index = 0; index < retained.length; index += 1) {
      const element = retained[index]!;
      const ref = `e${index + 1}`;
      let snapshot: OperationElementSnapshot;
      try {
        snapshot = await describeElement(element);
      } catch {
        await element.dispose().catch(() => undefined);
        continue;
      }
      if (!snapshot.connected) {
        await element.dispose().catch(() => undefined);
        continue;
      }
      refs.set(ref, element);
      lines.push(snapshotLine(ref, snapshot));
    }
    const excerpt = truncate(lines.join("\n"), MAX_PAGE_TEXT_CHARS);
    return {
      result: { kind: "snapshot", refCount: refs.size },
      page: await pageState(excerpt),
    };
  }

  async function evaluateOperation(
    expression: string,
    args: Readonly<Record<string, JsonSafe>>,
  ): Promise<JsonSafe> {
    try {
      parseAndValidateEvaluateExpression(expression);
    } catch (error) {
      if (error instanceof EvaluatePolicyError) {
        throw new OperationNoEffectError(error.category, error.message, {
          cause: error,
        });
      }
      throw error;
    }
    const argsJson = canonicalEvaluateJson(args);
    const source = `(() => {
const SafeArray=Array;const SafeObject=Object;const SafeJSON=JSON;const SafeNumber=Number;const SafeSet=Set;const SafeString=String;const SafeTextEncoder=TextEncoder;const SafeTypeError=TypeError;const SafeRangeError=RangeError;
const reflectApply=Reflect.apply.bind(Reflect);const arrayJoinMethod=SafeArray.prototype.join;const arraySortMethod=SafeArray.prototype.sort;const setAddMethod=SafeSet.prototype.add;const setDeleteMethod=SafeSet.prototype.delete;const setHasMethod=SafeSet.prototype.has;
const arrayPrototype=SafeArray.prototype;const objectPrototype=SafeObject.prototype;const objectKeys=SafeObject.keys.bind(SafeObject);
const objectGetOwnPropertyDescriptor=SafeObject.getOwnPropertyDescriptor.bind(SafeObject);
const objectGetOwnPropertyDescriptors=SafeObject.getOwnPropertyDescriptors.bind(SafeObject);
const objectGetOwnPropertyNames=SafeObject.getOwnPropertyNames.bind(SafeObject);
const objectGetOwnPropertySymbols=SafeObject.getOwnPropertySymbols.bind(SafeObject);
const objectGetPrototypeOf=SafeObject.getPrototypeOf.bind(SafeObject);
const arrayIsArray=SafeArray.isArray.bind(SafeArray);
const stringify=SafeJSON.stringify.bind(SafeJSON);const parse=SafeJSON.parse.bind(SafeJSON);
const numberIsFinite=SafeNumber.isFinite.bind(SafeNumber);const utf8=new SafeTextEncoder();const utf8Encode=utf8.encode.bind(utf8);
const args=parse(${JSON.stringify(argsJson)});
const seen=new SafeSet();const compareUtf8=(left,right)=>{const a=utf8Encode(left);const b=utf8Encode(right);const length=a.length<b.length?a.length:b.length;for(let index=0;index<length;index++){if(a[index]!==b[index])return a[index]-b[index];}return a.length-b.length;};
const value=(\n${expression}\n);
const encode=(input,depth)=>{
if(depth>16)throw new SafeTypeError("unsafe evaluate result");
if(input===null||typeof input==="boolean")return stringify(input);
if(typeof input==="number"){if(!numberIsFinite(input))throw new SafeTypeError("unsafe evaluate result");return stringify(input);}
if(typeof input==="string"){if(utf8Encode(input).length>65536)throw new SafeTypeError("unsafe evaluate result");return stringify(input);}
if(typeof input!=="object"||reflectApply(setHasMethod,seen,[input])||objectGetOwnPropertySymbols(input).length!==0)throw new SafeTypeError("unsafe evaluate result");
reflectApply(setAddMethod,seen,[input]);
try{
if(arrayIsArray(input)){if(objectGetPrototypeOf(input)!==arrayPrototype||input.length>1000||objectGetOwnPropertyNames(input).length!==input.length+1)throw new SafeTypeError("unsafe evaluate result");const values=[];for(let index=0;index<input.length;index++){const descriptor=objectGetOwnPropertyDescriptor(input,SafeString(index));if(!descriptor||!descriptor.enumerable||descriptor.get||descriptor.set)throw new SafeTypeError("unsafe evaluate result");values[index]=encode(descriptor.value,depth+1);}return "["+reflectApply(arrayJoinMethod,values,[","])+"]";}
const prototype=objectGetPrototypeOf(input);if(prototype!==objectPrototype&&prototype!==null)throw new SafeTypeError("unsafe evaluate result");
const descriptors=objectGetOwnPropertyDescriptors(input);const keys=objectKeys(descriptors);if(keys.length>256)throw new SafeTypeError("unsafe evaluate result");reflectApply(arraySortMethod,keys,[compareUtf8]);const properties=[];
for(let index=0;index<keys.length;index++){const key=keys[index];const descriptor=descriptors[key];if(!descriptor.enumerable||descriptor.get||descriptor.set||key.length>256)throw new SafeTypeError("unsafe evaluate result");properties[index]=stringify(key)+":"+encode(descriptor.value,depth+1);}return "{"+reflectApply(arrayJoinMethod,properties,[","])+"}";
}finally{reflectApply(setDeleteMethod,seen,[input]);}
};
const canonical=encode(value,0);
if(utf8Encode(canonical).length>${MAX_EVALUATE_RESULT_BYTES})throw new SafeRangeError("evaluate result exceeds 32 KiB");
return canonical;
})()`;
    const session = cdp;
    if (session === null || mainFrameId === "") {
      throw new Error("isolated evaluation context is unavailable");
    }
    const world = (await session.send("Page.createIsolatedWorld", {
      frameId: mainFrameId,
      worldName: "firecrawl-evaluate-v1",
      grantUniveralAccess: false,
    })) as { executionContextId?: number };
    const contextId = world.executionContextId;
    if (typeof contextId !== "number" || !Number.isSafeInteger(contextId)) {
      throw new Error("isolated evaluation context was not created");
    }
    const response = (await session.send("Runtime.evaluate", {
      expression: source,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string };
    };
    if (response.exceptionDetails !== undefined) {
      throw new Error(
        response.result?.description ??
          response.exceptionDetails.text ??
          "isolated evaluation failed",
      );
    }
    const canonical: unknown = response.result?.value;
    if (typeof canonical !== "string") {
      throw new TypeError("evaluate result canonicalization failed");
    }
    let value: unknown;
    try {
      value = JSON.parse(canonical);
    } catch (error) {
      throw new TypeError("evaluate result canonical bytes are invalid", {
        cause: error,
      });
    }
    const parsed = jsonSafeSchema.safeParse(value);
    if (!parsed.success) {
      throw new TypeError("evaluate result is not JSON-safe");
    }
    if (encodedBytes(parsed.data) > MAX_EVALUATE_RESULT_BYTES) {
      throw new RangeError("evaluate result exceeds 32 KiB");
    }
    if (canonicalEvaluateJson(parsed.data) !== canonical) {
      throw new TypeError("evaluate result canonical bytes differ");
    }
    return parsed.data;
  }

  async function execute(
    operation: BrowserOperation,
  ): Promise<OperationExecution> {
    assertOpen();
    await routeReady;
    assertOpen();
    assertInterceptorHealthy();
    let result: BrowserOperationResultV1;
    let snapshotExcerpt: string | undefined;

    switch (operation.kind) {
      case "snapshot":
        {
          const snapshot = await takeSnapshot();
          await drainPausedJobs();
          return snapshot;
        }
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
        await element.click();
        const finalUrl = postEffectHttpUrl(page.url());
        if (!committedOrigins.has(finalUrl.origin)) {
          throw new Error("clicked navigation escaped session authority");
        }
        result = { kind: "click", applied: true };
        break;
      }
      case "fill":
        await (await requireRef(operation.ref)).fill(operation.value);
        result = { kind: "fill", applied: true };
        break;
      case "type":
        await (await requireRef(operation.ref)).type(
          operation.value,
          { delay: operation.delayMs },
        );
        result = { kind: "type", applied: true };
        break;
      case "press":
        await (await requireRef(operation.ref)).press(operation.key);
        result = { kind: "press", applied: true };
        break;
      case "select":
        await (await requireRef(operation.ref)).selectOption(operation.values);
        result = { kind: "select", applied: true };
        break;
      case "scroll":
        await page.mouse.wheel(operation.deltaX, operation.deltaY);
        result = { kind: "scroll", applied: true };
        break;
      case "wait":
        await page.waitForTimeout(operation.milliseconds);
        result = { kind: "wait", waitedMs: operation.milliseconds };
        break;
      case "get_text": {
        const text =
          operation.ref === undefined
            ? await page.textContent("body")
            : await (await requireRef(operation.ref)).textContent();
        result = {
          kind: "get_text",
          text: truncate(text ?? "", MAX_PAGE_TEXT_CHARS),
        };
        break;
      }
      case "get_url":
        result = { kind: "get_url", url: checkedHttpUrl(page.url()).href };
        break;
      case "navigate": {
        const target = requireNavigateTarget(operation.url);
        const grantsOrigin = !committedOrigins.has(target.origin);
        if (
          grantsOrigin &&
          committedOrigins.size + reservedOrigins.size >=
            MAX_NAVIGATION_ORIGINS
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
      case "evaluate":
        result = {
          kind: "evaluate",
          value: await evaluateOperation(operation.expression, operation.args),
        };
        break;
    }

    await drainPausedJobs();
    const boundedResult = browserOperationResultSchema.parse(result);
    return {
      result: boundedResult,
      page: await pageState(snapshotExcerpt),
    };
  }

  return Object.freeze({
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
  withWriter<T>(operation: () => Promise<T>): Promise<T>;
  executeOperation(operation: BrowserOperation): Promise<OperationExecution>;
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
    candidate = await options.withWriter(async () => {
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
        execution = await options.executeOperation(request.operation);
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
