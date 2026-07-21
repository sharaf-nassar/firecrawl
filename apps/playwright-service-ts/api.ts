import express, { Request, Response } from 'express';
import {
  chromium,
  Browser,
  BrowserContext,
  BrowserServer,
  CDPSession,
  Route,
  Request as PlaywrightRequest,
  Page,
} from 'playwright';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';
import { lookup } from 'dns/promises';
import IPAddr from 'ipaddr.js';
import { createHash } from 'node:crypto';

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(express.json());

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';
const MAX_CONCURRENT_PAGES = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_PAGES ?? '10', 10) || 10);
const ALLOW_LOCAL_WEBHOOKS = (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';
const DNS_CACHE_TTL_MS = 30_000;
const REPLAY_CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024;
const REPLAY_CHECKPOINT_MAX_ORIGINS = 128;
const RESOURCE_CLEANUP_TIMEOUT_MS = 1_000;

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;
const PROXY_COUNTRY = process.env.PROXY_COUNTRY?.toLowerCase() || undefined;
type AggregateFailure = Error & { errors: unknown[] };
const RuntimeAggregateError = (
  globalThis as unknown as {
    AggregateError: new (
      errors: Iterable<unknown>,
      message?: string,
    ) => AggregateFailure;
  }
).AggregateError;
const dnsLookupCache = new Map<string, { addresses: string[]; expiresAt: number }>();

class InsecureConnectionError extends Error {
  constructor(public readonly blockedUrl: string, reason: string) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

class CheckpointTooLargeError extends Error {
  readonly category = 'checkpoint_too_large';

  constructor() {
    super('Replay checkpoint exceeds 2 MiB');
    this.name = 'CheckpointTooLargeError';
  }
}

class CheckpointUnrepresentableError extends Error {
  readonly category = 'checkpoint_unrepresentable';

  constructor(message: string) {
    super(message);
    this.name = 'CheckpointUnrepresentableError';
  }
}

class CheckpointTimeoutError extends Error {
  readonly category = 'checkpoint_timeout';

  constructor() {
    super('Replay checkpoint capture timed out');
    this.name = 'CheckpointTimeoutError';
  }
}

class CleanupTimeoutError extends Error {
  constructor() {
    super('Browser resource cleanup timed out');
    this.name = 'CleanupTimeoutError';
  }
}

type BrowserRuntime<T> = {
  browser: T;
  terminate(): Promise<void>;
};

type BrowserGeneration<T> = {
  runtime: BrowserRuntime<T>;
  activeLeases: number;
  retired: boolean;
  terminationStarted: boolean;
};

export type BrowserLease<T> = {
  browser: T;
  retire(): void;
  release(): void;
};

type BrowserLifecycleDiagnostic = {
  category: 'browser_recycle_failed';
  errorName: string;
};

export class SharedBrowserLifecycle<T> {
  private current: BrowserGeneration<T> | undefined;
  private starting: Promise<BrowserGeneration<T>> | undefined;

  constructor(
    private readonly start: () => Promise<BrowserRuntime<T>>,
    private readonly report: (diagnostic: BrowserLifecycleDiagnostic) => void =
      diagnostic => console.error('Browser lifecycle failure', diagnostic),
  ) {}

  async acquire(): Promise<BrowserLease<T>> {
    let generation = this.current;
    if (!generation || generation.retired) {
      if (!this.starting) {
        const starting = this.start().then(runtime => {
          const created: BrowserGeneration<T> = {
            runtime,
            activeLeases: 0,
            retired: false,
            terminationStarted: false,
          };
          this.current = created;
          return created;
        });
        this.starting = starting;
        void starting
          .finally(() => {
            if (this.starting === starting) this.starting = undefined;
          })
          .catch(() => undefined);
      }
      generation = await this.starting;
    }

    generation.activeLeases += 1;
    let released = false;
    return {
      browser: generation.runtime.browser,
      retire: () => {
        if (generation.retired) return;
        generation.retired = true;
        if (this.current === generation) this.current = undefined;
        this.terminateWhenUnused(generation);
      },
      release: () => {
        if (released) return;
        released = true;
        generation.activeLeases -= 1;
        this.terminateWhenUnused(generation);
      },
    };
  }

  retireCurrent(): void {
    const generation = this.current;
    if (!generation || generation.retired) return;
    generation.retired = true;
    this.current = undefined;
    this.terminateWhenUnused(generation);
  }

  private terminateWhenUnused(generation: BrowserGeneration<T>): void {
    if (
      !generation.retired ||
      generation.activeLeases !== 0 ||
      generation.terminationStarted
    ) {
      return;
    }
    generation.terminationStarted = true;
    void Promise.resolve()
      .then(() => generation.runtime.terminate())
      .catch(error => {
        this.report({
          category: 'browser_recycle_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
  }
}

const normalizeHostname = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, '');

const isHttpProtocol = (protocol: string): boolean => protocol === 'http:' || protocol === 'https:';

const isIPPrivate = (address: string): boolean => {
  if (!IPAddr.isValid(address)) return false;
  const parsedAddress = IPAddr.parse(address);
  return parsedAddress.range() !== 'unicast';
};

const isLocalHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname.endsWith('.localhost');

const lookupWithCache = async (hostname: string): Promise<string[]> => {
  const cached = dnsLookupCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.addresses;
  }

  const resolvedAddresses = await lookup(hostname, { all: true, verbatim: true });
  const uniqueAddresses = [...new Set(resolvedAddresses.map(x => x.address))];
  dnsLookupCache.set(hostname, {
    addresses: uniqueAddresses,
    expiresAt: Date.now() + DNS_CACHE_TTL_MS,
  });
  return uniqueAddresses;
};

const assertSafeTargetUrl = async (urlString: string): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }

  if (!isHttpProtocol(parsedUrl.protocol)) {
    throw new InsecureConnectionError(urlString, `unsupported protocol "${parsedUrl.protocol}"`);
  }

  if (ALLOW_LOCAL_WEBHOOKS) {
    return;
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (!hostname) {
    throw new InsecureConnectionError(urlString, 'hostname is missing');
  }

  if (isLocalHostname(hostname)) {
    throw new InsecureConnectionError(urlString, 'localhost targets are not allowed');
  }

  if (IPAddr.isValid(hostname)) {
    if (isIPPrivate(hostname)) {
      throw new InsecureConnectionError(urlString, `private IP "${hostname}" is not allowed`);
    }
    return;
  }

  let resolvedAddresses: string[];
  try {
    resolvedAddresses = await lookupWithCache(hostname);
  } catch {
    throw new InsecureConnectionError(
      urlString,
      `DNS lookup failed for "${hostname}", cannot verify target is safe`,
    );
  }

  if (resolvedAddresses.length === 0) {
    throw new InsecureConnectionError(
      urlString,
      `hostname "${hostname}" did not resolve to any IP address`,
    );
  }

  if (resolvedAddresses.some(address => isIPPrivate(address))) {
    throw new InsecureConnectionError(urlString, `hostname "${hostname}" resolves to a private IP`);
  }
};

type ContextSecurityState = {
  blockedNavigationRequestUrl: string | null;
  storageOrigins: Set<string>;
  storageOriginsOverflow: boolean;
};
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      if (nextResolve) {
        this.permits--;
        nextResolve();
      }
    }
  }

  getAvailablePermits(): number {
    return this.permits;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}
const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com'
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
  capture_replay_checkpoint?: boolean;
  mobile?: boolean;
  location?: { country?: string; languages?: string[] };
  proxy_kind?: 'basic' | 'stealth' | 'enhanced' | 'auto';
  block_ads?: boolean;
  lockdown?: boolean;
  capture_replay_timeout_ms?: number;
}

type AppliedProxyConfiguration = {
  server: string | null;
  username: string | null;
  password: string | null;
  country?: string;
};

type ReplayBrowserSettingsV1 = {
  headers: Record<string, string>;
  cookies: [];
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
  };
  deviceName?: string;
  userAgent: string;
  locale: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
  location: { country: string; languages: string[] };
  proxy: {
    kind: 'basic' | 'stealth' | 'enhanced' | 'auto';
    country?: string;
    credentialRef?: string;
  };
  skipTlsVerification: boolean;
  blockAds: boolean;
  lockdown: boolean;
};

type ReplayCheckpointCaptureV1 = {
  version: 1;
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
  finalUrl: string;
  fingerprint: {
    finalUrl: string;
    titleSha256: string;
    bodyTextSha256: string;
  };
  browserSettings: ReplayBrowserSettingsV1;
};

const startBrowserRuntime = async (): Promise<{
  browser: Browser;
  terminate(): Promise<void>;
}> => {
  const server: BrowserServer = await chromium.launchServer({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  try {
    const connectedBrowser = await chromium.connect(server.wsEndpoint(), {
      timeout: 30_000,
    });
    return {
      browser: connectedBrowser,
      terminate: () => server.kill(),
    };
  } catch (error) {
    void server.kill().catch(killError => {
      console.error('Browser lifecycle failure', {
        category: 'browser_recycle_failed',
        errorName: killError instanceof Error ? killError.name : 'UnknownError',
      });
    });
    throw error;
  }
};

const browserLifecycle = new SharedBrowserLifecycle(startBrowserRuntime);

const initializeBrowser = async () => {
  const lease = await browserLifecycle.acquire();
  lease.release();
};

export function resolveAppliedBrowserSettings(
  model: UrlModel,
  userAgent: string,
  proxyConfiguration: AppliedProxyConfiguration = {
    server: PROXY_SERVER,
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
    country: PROXY_COUNTRY,
  },
): ReplayBrowserSettingsV1 {
  const mobile = model.mobile === true;
  const viewport = mobile
    ? { width: 390, height: 844 }
    : { width: 1280, height: 800 };
  const requestedLanguages = model.location?.languages?.length
    ? [...model.location.languages]
    : ['en-US'];
  const locale = requestedLanguages[0] ?? 'en-US';
  const requestedCountry = model.location?.country?.toLowerCase();
  const appliedCountry = proxyConfiguration.country?.toLowerCase();
  if (
    model.capture_replay_checkpoint &&
    ((requestedLanguages.length > 1) ||
      (requestedCountry !== undefined &&
        requestedCountry !== 'us-generic' &&
        requestedCountry !== appliedCountry) ||
      model.lockdown === true)
  ) {
    throw new CheckpointUnrepresentableError(
      'Requested settings are not exactly represented by applied browser context',
    );
  }
  const deviceScaleFactor = mobile ? 3 : 1;
  return {
    headers: { ...(model.headers ?? {}) },
    cookies: [],
    viewport: {
      ...viewport,
      deviceScaleFactor,
      isMobile: mobile,
      hasTouch: mobile,
    },
    userAgent,
    locale,
    location: {
      country: appliedCountry ?? 'us-generic',
      languages: [locale],
    },
    proxy: {
      // This service applies one static Playwright proxy. Requested auto,
      // stealth, and enhanced modes cannot change that runtime truth.
      kind: 'basic',
      ...(appliedCountry ? { country: appliedCountry } : {}),
      ...(proxyConfiguration.server &&
      proxyConfiguration.username &&
      proxyConfiguration.password
        ? { credentialRef: 'proxy-credential:playwright-service' }
        : {}),
    },
    skipTlsVerification: model.skip_tls_verification === true,
    blockAds: model.block_ads !== false,
    lockdown: false,
  };
}

const createContext = async (
  activeBrowser: Browser,
  model: UrlModel = { url: 'about:blank' },
): Promise<{
  context: BrowserContext;
  securityState: ContextSecurityState;
  browserSettings: ReplayBrowserSettingsV1;
}> => {
  const userAgentOverride = model.headers
    ? Object.entries(model.headers).find(([key]) => key.toLowerCase() === 'user-agent')?.[1]
    : undefined;
  const userAgent = userAgentOverride || new UserAgent().toString();
  const browserSettings = resolveAppliedBrowserSettings(model, userAgent);
  const securityState: ContextSecurityState = {
    blockedNavigationRequestUrl: null,
    storageOrigins: new Set(),
    storageOriginsOverflow: false,
  };

  const contextOptions: any = {
    userAgent,
    viewport: {
      width: browserSettings.viewport.width,
      height: browserSettings.viewport.height,
    },
    deviceScaleFactor: browserSettings.viewport.deviceScaleFactor,
    isMobile: browserSettings.viewport.isMobile,
    hasTouch: browserSettings.viewport.hasTouch,
    locale: browserSettings.locale,
    ignoreHTTPSErrors: model.skip_tls_verification === true,
    serviceWorkers: 'block',
  };

  if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
  } else if (PROXY_SERVER) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
    };
  }

  const newContext = await activeBrowser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await newContext.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', async (route: Route, request: PlaywrightRequest) => {
      await route.abort();
    });
  }

  // Intercept all requests to avoid loading ads
  await newContext.route('**/*', async (route: Route, request: PlaywrightRequest) => {
    const requestUrlString = request.url();
    try {
      await assertSafeTargetUrl(requestUrlString);
    } catch (error) {
      if (error instanceof InsecureConnectionError) {
        if (request.isNavigationRequest()) {
          securityState.blockedNavigationRequestUrl = requestUrlString;
        }
        console.warn(`Blocked request: ${requestUrlString}`);
        return route.abort('blockedbyclient');
      }
      throw error;
    }

    const requestUrl = new URL(requestUrlString);
    if (securityState.storageOrigins.size >= REPLAY_CHECKPOINT_MAX_ORIGINS) {
      if (!securityState.storageOrigins.has(requestUrl.origin)) {
        securityState.storageOriginsOverflow = true;
      }
    } else {
      securityState.storageOrigins.add(requestUrl.origin);
    }
    const hostname = normalizeHostname(requestUrl.hostname);

    if (browserSettings.blockAds && AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      console.log(hostname);
      return route.abort();
    }
    return route.continue();
  });
  
  return {
    context: newContext,
    securityState,
    browserSettings,
  };
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export async function captureWithDeadline<T>(
  capture: Promise<T>,
  timeoutMs: number,
  cancelCapture: () => Promise<void> = async () => undefined,
  retireBrowser: () => Promise<void> = async () => undefined,
  cleanupTimeoutMs: number = RESOURCE_CLEANUP_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
    throw new CheckpointUnrepresentableError(
      'Replay checkpoint timeout must be between 1 and 10000 milliseconds',
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(async () => {
      if (settled) return;
      settled = true;
      const primary = new CheckpointTimeoutError();
      try {
        await withCleanupDeadline(cancelCapture, cleanupTimeoutMs);
        reject(primary);
      } catch (cleanupError) {
        if (cleanupError instanceof CleanupTimeoutError) {
          try {
            await withCleanupDeadline(retireBrowser, cleanupTimeoutMs);
          } catch (retirementError) {
            reject(
              new RuntimeAggregateError(
                [primary, cleanupError, retirementError],
                'Checkpoint timeout cleanup failed',
              ),
            );
            return;
          }
        }
        reject(
          new RuntimeAggregateError(
            [primary, cleanupError],
            'Checkpoint timeout and cancellation failed',
          ),
        );
      }
    }, timeoutMs);
    capture.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

type Closeable = { close(): Promise<unknown> };

const withCleanupDeadline = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new CleanupTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export async function settleScrapeResources(
  page: Closeable | null,
  context: Closeable | null,
  release: () => void,
  primaryError?: unknown,
  retireBrowser: () => Promise<void> = async () => undefined,
  cleanupTimeoutMs: number = RESOURCE_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  const errors: unknown[] =
    primaryError === undefined
      ? []
      : primaryError instanceof RuntimeAggregateError
        ? [...primaryError.errors]
        : [primaryError];
  let cleanupTimedOut = false;
  try {
    if (page) {
      await withCleanupDeadline(() => page.close(), cleanupTimeoutMs);
    }
  } catch (error) {
    cleanupTimedOut ||= error instanceof CleanupTimeoutError;
    errors.push(error);
  }
  try {
    if (context) {
      await withCleanupDeadline(() => context.close(), cleanupTimeoutMs);
    }
  } catch (error) {
    cleanupTimedOut ||= error instanceof CleanupTimeoutError;
    errors.push(error);
  }
  if (cleanupTimedOut) {
    try {
      await withCleanupDeadline(retireBrowser, cleanupTimeoutMs);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new RuntimeAggregateError(
      errors,
      'Scrape and resource cleanup failed',
    );
  }
}

export const captureReplayCheckpoint = async (
  context: BrowserContext,
  page: Page,
  browserSettings: ReplayBrowserSettingsV1,
  storageOrigins: ReadonlySet<string>,
  hasStorageOriginsOverflow: () => boolean = () => false,
): Promise<ReplayCheckpointCaptureV1> => {
  const runtimeViewport = page.viewportSize();
  if (
    !runtimeViewport ||
    runtimeViewport.width !== browserSettings.viewport.width ||
    runtimeViewport.height !== browserSettings.viewport.height
  ) {
    throw new Error('Replay checkpoint viewport does not match runtime context');
  }
  const assertOriginsBounded = () => {
    if (
      storageOrigins.size > REPLAY_CHECKPOINT_MAX_ORIGINS ||
      hasStorageOriginsOverflow()
    ) {
      throw new CheckpointUnrepresentableError(
        'Replay checkpoint has too many storage origins',
      );
    }
  };
  assertOriginsBounded();
  const pages = context.pages();
  if (pages.length === 0 || !pages.includes(page)) {
    throw new CheckpointUnrepresentableError(
      'Replay checkpoint page set changed before capture',
    );
  }
  const sessions: CDPSession[] = [];
  try {
    for (const contextPage of pages) {
      const session = await context.newCDPSession(contextPage);
      sessions.push(session);
      await session.send('Page.setWebLifecycleState', { state: 'frozen' });
      assertOriginsBounded();
    }
    if (
      context.pages().length !== pages.length ||
      context.pages().some(contextPage => !pages.includes(contextPage))
    ) {
      throw new CheckpointUnrepresentableError(
        'Replay checkpoint page set changed during writer freeze',
      );
    }
    const frozenOrigins = new Set(storageOrigins);
    const targetSession = sessions[0]!;
    const { targetInfo } = await targetSession.send('Target.getTargetInfo');
    if (!targetInfo.browserContextId) {
      throw new CheckpointUnrepresentableError(
        'Chromium did not identify the checkpoint browser context',
      );
    }
    const writerTargetTypes = new Set([
      'worker',
      'shared_worker',
      'service_worker',
      'background_page',
    ]);
    const getWriterTargets = async () => {
      const { targetInfos } = await targetSession.send('Target.getTargets');
      return targetInfos.filter(
        candidate =>
          candidate.browserContextId === targetInfo.browserContextId &&
          writerTargetTypes.has(candidate.type),
      );
    };
    const terminateWriterTargets = async (
      writerTargets: Awaited<ReturnType<typeof getWriterTargets>>,
    ) => {
      if (writerTargets.some(candidate => candidate.type === 'service_worker')) {
        await targetSession.send('ServiceWorker.enable');
        await targetSession.send('ServiceWorker.stopAllWorkers');
      }
      for (const writerTarget of writerTargets) {
        if (
          writerTarget.type === 'worker' ||
          writerTarget.type === 'shared_worker'
        ) {
          const { sessionId } = await targetSession.send(
            'Target.attachToTarget',
            { targetId: writerTarget.targetId, flatten: false },
          );
          await targetSession.send('Target.sendMessageToTarget', {
            sessionId,
            message: JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: 'self.close()' },
            }),
          });
        } else {
          await targetSession.send('Target.closeTarget', {
            targetId: writerTarget.targetId,
          });
        }
      }
    };
    const initialWriterTargets = await getWriterTargets();
    if (initialWriterTargets.length > 0) {
      await terminateWriterTargets(initialWriterTargets);
      await getWriterTargets();
      throw new CheckpointUnrepresentableError(
        'Replay checkpoint cannot freeze unexpected background writers',
      );
    }
    assertOriginsBounded();
    let totalUsage = 0;
    for (const origin of frozenOrigins) {
      const usage = await targetSession.send('Storage.getUsageAndQuota', {
        origin,
      });
      if (!Number.isFinite(usage.usage) || usage.usage < 0) {
        throw new CheckpointUnrepresentableError(
          'Chromium returned invalid storage usage',
        );
      }
      totalUsage += usage.usage;
      if (totalUsage > REPLAY_CHECKPOINT_MAX_BYTES) {
        throw new CheckpointTooLargeError();
      }
    }
    const finalWriterTargets = await getWriterTargets();
    if (finalWriterTargets.length > 0) {
      await terminateWriterTargets(finalWriterTargets);
      await getWriterTargets();
      throw new CheckpointUnrepresentableError(
        'Replay checkpoint cannot freeze unexpected background writers',
      );
    }
    assertOriginsBounded();
    if (
      storageOrigins.size !== frozenOrigins.size ||
      [...storageOrigins].some(origin => !frozenOrigins.has(origin))
    ) {
      throw new CheckpointUnrepresentableError(
        'Replay checkpoint storage origins changed during capture',
      );
    }
  } catch (error) {
    if (
      error instanceof CheckpointTooLargeError ||
      error instanceof CheckpointUnrepresentableError
    ) {
      throw error;
    }
    throw new CheckpointUnrepresentableError(
      'Chromium could not establish a bounded checkpoint capture',
    );
  } finally {
    await Promise.allSettled(sessions.map(session => session.detach()));
  }

  const storageState = await context.storageState({ indexedDB: true });
  const serializedBytes = Buffer.byteLength(
    JSON.stringify({ storageState, browserSettings }),
    'utf8',
  );
  if (serializedBytes > REPLAY_CHECKPOINT_MAX_BYTES) {
    throw new CheckpointTooLargeError();
  }
  const finalUrl = page.url();
  const title = await page.title();
  if (Buffer.byteLength(title, 'utf8') > 65_536) {
    throw new CheckpointTooLargeError();
  }
  const bodyText = await page.locator('body').evaluate(
    (body, maximumLength) =>
      (body as HTMLElement).innerText
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximumLength),
    65_536,
  );
  return {
    version: 1,
    storageState,
    finalUrl,
    fingerprint: {
      finalUrl,
      titleSha256: sha256(title),
      bodyTextSha256: sha256(bodyText),
    },
    browserSettings,
  };
};

const shutdownBrowser = async () => {
  browserLifecycle.retireCurrent();
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (
  page: Page,
  url: string,
  waitUntil: 'load' | 'networkidle',
  waitAfterLoad: number,
  timeout: number,
  checkSelector: string | undefined,
  securityState: ContextSecurityState,
) => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
  let response;
  try {
    response = await page.goto(url, { waitUntil, timeout });
  } catch (error) {
    if (securityState.blockedNavigationRequestUrl) {
      throw new InsecureConnectionError(
        securityState.blockedNavigationRequestUrl,
        'navigation to private/internal resource is not allowed',
      );
    }
    throw error;
  }

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error('Required selector not found');
    }
  }

  let headers = null, content = await page.content();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
    if (ct && (ct.toLowerCase().includes("application/json") || ct.toLowerCase().includes("text/plain"))) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
  };
};

app.get('/health', async (req: Request, res: Response) => {
  let lease: BrowserLease<Browser> | null = null;
  let testContext: BrowserContext | null = null;
  let testPage: Page | null = null;
  let primaryError: unknown;
  try {
    lease = await browserLifecycle.acquire();
    ({ context: testContext } = await createContext(lease.browser));
    testPage = await testContext.newPage();
  } catch (error) {
    primaryError = error;
  }
  try {
    await settleScrapeResources(
      testPage,
      testContext,
      () => lease?.release(),
      primaryError,
      async () => lease?.retire(),
    );
  } catch (error) {
    primaryError = error;
  }
  if (primaryError === undefined) {
    res.status(200).json({ 
      status: 'healthy',
      maxConcurrentPages: MAX_CONCURRENT_PAGES,
      activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits()
    });
  } else {
    console.error('Health check failed', {
      category: 'browser_health_failed',
      errorName: primaryError instanceof Error ? primaryError.name : 'UnknownError',
    });
    res.status(503).json({ 
      status: 'unhealthy', 
      error: 'Browser health check failed',
    });
  }
});

app.post('/scrape', async (req: Request, res: Response) => {
  const model: UrlModel = req.body;
  const { url, wait_after_load = 0, timeout = 15000, headers, check_selector, skip_tls_verification = false, capture_replay_checkpoint = false } = model;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? 'Provided' : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`Skip TLS Verification: ${skip_tls_verification}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    await assertSafeTargetUrl(url);
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    throw error;
  }

  if (!PROXY_SERVER) {
    console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.');
  }

  await pageSemaphore.acquire();
  
  let browserLease: BrowserLease<Browser> | null = null;
  let requestContext: BrowserContext | null = null;
  let securityState: ContextSecurityState | null = null;
  let page: Page | null = null;
  let responsePayload: Record<string, unknown> | undefined;
  let primaryError: unknown;
  try {
    browserLease = await browserLifecycle.acquire();
    // Extract user-agent from request headers (case-insensitive) so it can
    // be applied at the context level.  Playwright ignores user-agent in
    // setExtraHTTPHeaders when the context already defines one (#2802).
    const contextBundle = await createContext(browserLease.browser, {
      ...model,
      skip_tls_verification,
    });
    requestContext = contextBundle.context;
    securityState = contextBundle.securityState;
    page = await requestContext.newPage();

    if (headers) {
      // Remove the user-agent key before calling setExtraHTTPHeaders since
      // we already forwarded it to the context-level userAgent option.
      const filteredHeaders = Object.fromEntries(
        Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'user-agent')
      );
      if (Object.keys(filteredHeaders).length > 0) {
        await page.setExtraHTTPHeaders(filteredHeaders);
      }
    }

    const result = await scrapePage(
      page,
      url,
      'load',
      wait_after_load,
      timeout,
      check_selector,
      securityState,
    );
    const pageError = result.status !== 200 ? getError(result.status) : undefined;

    if (!pageError) {
      console.log(`✅ Scrape successful!`);
    } else {
      console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`);
    }

    if (capture_replay_checkpoint && securityState.storageOriginsOverflow) {
      throw new CheckpointUnrepresentableError(
        'Replay checkpoint has too many storage origins',
      );
    }
    const replayCheckpoint = capture_replay_checkpoint
      ? await captureWithDeadline(
          captureReplayCheckpoint(
            requestContext,
            page,
            contextBundle.browserSettings,
            securityState.storageOrigins,
            () => securityState?.storageOriginsOverflow === true,
          ),
          model.capture_replay_timeout_ms ?? 5_000,
          async () => requestContext?.close(),
          async () => browserLease?.retire(),
        )
      : undefined;

    responsePayload = {
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      ...(pageError && { pageError }),
      ...(replayCheckpoint ? { replayCheckpoint } : {}),
    };
  } catch (error) {
    primaryError = error;
  }
  try {
    await settleScrapeResources(
      page,
      requestContext,
      () => {
        try {
          browserLease?.release();
        } finally {
          pageSemaphore.release();
        }
      },
      primaryError,
      async () => browserLease?.retire(),
    );
  } catch (error) {
    primaryError = error;
  }

  if (primaryError !== undefined) {
    const orderedErrors =
      primaryError instanceof RuntimeAggregateError
        ? primaryError.errors
        : [primaryError];
    const primary = orderedErrors[0];
    if (orderedErrors.length > 1) {
      console.error('Scrape cleanup deferred errors', {
        category: 'scrape_cleanup_failed',
        errorNames: orderedErrors.slice(1).map(error =>
          error instanceof Error ? error.name : 'UnknownError',
        ),
      });
    }
    if (primary instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: primary.message,
      });
    }
    if (
      primary instanceof CheckpointTooLargeError ||
      primary instanceof CheckpointUnrepresentableError ||
      primary instanceof CheckpointTimeoutError
    ) {
      return res.status(primary instanceof CheckpointTooLargeError ? 413 : 422).json({
        errorCategory: primary.category,
        error: primary.message,
      });
    }
    console.error('Scrape failed', {
      categories: orderedErrors.map(error =>
        error instanceof Error ? error.name : 'UnknownError',
      ),
    });
    return res.status(500).json({
      error: 'An error occurred while fetching the page.',
    });
  }

  return res.json(responsePayload);
});

if (require.main === module) {
  app.listen(port, () => {
    initializeBrowser().then(() => {
      console.log(`Server is running on port ${port}`);
    });
  });
  process.on('SIGINT', () => {
    shutdownBrowser().then(() => {
      console.log('Browser closed');
      process.exit(0);
    });
  });
}
