import express, { Request, Response } from 'express';
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright';
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

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;
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
}

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

let browser: Browser;

const initializeBrowser = async () => {
  browser = await chromium.launch({
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
};

const createContext = async (model: UrlModel = { url: 'about:blank' }): Promise<{
  context: BrowserContext;
  securityState: ContextSecurityState;
  browserSettings: ReplayBrowserSettingsV1;
}> => {
  const userAgentOverride = model.headers
    ? Object.entries(model.headers).find(([key]) => key.toLowerCase() === 'user-agent')?.[1]
    : undefined;
  const userAgent = userAgentOverride || new UserAgent().toString();
  const mobile = model.mobile === true;
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const deviceScaleFactor = mobile ? 3 : 1;
  const languages = model.location?.languages?.length
    ? [...model.location.languages]
    : ['en-US'];
  const locale = languages[0] ?? 'en-US';
  const country = model.location?.country?.toLowerCase() || 'us-generic';
  const proxyKind = model.proxy_kind ?? 'basic';
  const blockAds = model.block_ads !== false;
  const securityState: ContextSecurityState = {
    blockedNavigationRequestUrl: null,
  };

  const contextOptions: any = {
    userAgent,
    viewport,
    deviceScaleFactor,
    isMobile: mobile,
    hasTouch: mobile,
    locale,
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

  const newContext = await browser.newContext(contextOptions);

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
    const hostname = normalizeHostname(requestUrl.hostname);

    if (blockAds && AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      console.log(hostname);
      return route.abort();
    }
    return route.continue();
  });
  
  return {
    context: newContext,
    securityState,
    browserSettings: {
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
      location: { country, languages },
      proxy: {
        kind: proxyKind,
        ...(model.location?.country ? { country } : {}),
        ...(PROXY_USERNAME && PROXY_PASSWORD
          ? { credentialRef: 'proxy-credential:playwright-service' }
          : {}),
      },
      skipTlsVerification: model.skip_tls_verification === true,
      blockAds,
      lockdown: model.lockdown === true,
    },
  };
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const captureReplayCheckpoint = async (
  context: BrowserContext,
  page: Page,
  browserSettings: ReplayBrowserSettingsV1,
): Promise<ReplayCheckpointCaptureV1> => {
  const runtimeViewport = page.viewportSize();
  if (
    !runtimeViewport ||
    runtimeViewport.width !== browserSettings.viewport.width ||
    runtimeViewport.height !== browserSettings.viewport.height
  ) {
    throw new Error('Replay checkpoint viewport does not match runtime context');
  }
  const storageState = await context.storageState({ indexedDB: true });
  const finalUrl = page.url();
  const title = await page.title();
  const bodyText = (await page.locator('body').innerText())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 65_536);
  const serializedBytes = Buffer.byteLength(
    JSON.stringify({ storageState, browserSettings }),
    'utf8',
  );
  if (serializedBytes > REPLAY_CHECKPOINT_MAX_BYTES) {
    throw new CheckpointTooLargeError();
  }
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
  if (browser) {
    await browser.close();
  }
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
  try {
    if (!browser) {
      await initializeBrowser();
    }
    
    const { context: testContext } = await createContext();
    const testPage = await testContext.newPage();
    await testPage.close();
    await testContext.close();
    
    res.status(200).json({ 
      status: 'healthy',
      maxConcurrentPages: MAX_CONCURRENT_PAGES,
      activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'unhealthy', 
      error: error instanceof Error ? error.message : 'Unknown error occurred'
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

  if (!browser) {
    await initializeBrowser();
  }

  await pageSemaphore.acquire();
  
  let requestContext: BrowserContext | null = null;
  let securityState: ContextSecurityState | null = null;
  let page: Page | null = null;

  try {
    // Extract user-agent from request headers (case-insensitive) so it can
    // be applied at the context level.  Playwright ignores user-agent in
    // setExtraHTTPHeaders when the context already defines one (#2802).
    const contextBundle = await createContext({
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

    const replayCheckpoint = capture_replay_checkpoint
      ? await captureReplayCheckpoint(
          requestContext,
          page,
          contextBundle.browserSettings,
        )
      : undefined;

    res.json({
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      ...(pageError && { pageError }),
      ...(replayCheckpoint ? { replayCheckpoint } : {}),
    });

  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    if (error instanceof CheckpointTooLargeError) {
      return res.status(413).json({
        errorCategory: error.category,
        error: error.message,
      });
    }
    console.error('Scrape error:', error);
    res.status(500).json({ error: 'An error occurred while fetching the page.' });
  } finally {
    if (page) await page.close();
    if (requestContext) await requestContext.close();
    pageSemaphore.release();
  }
});

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port}`);
  });
});

if (require.main === module) {
  process.on('SIGINT', () => {
    shutdownBrowser().then(() => {
      console.log('Browser closed');
      process.exit(0);
    });
  });
}
