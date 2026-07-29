import { createHash } from "crypto";
import { isIP } from "node:net";
import { v7 as uuidv7 } from "uuid";
import { Request, Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  insertBrowserSession,
  getBrowserSession,
  getBrowserSessionByBrowserId,
  listBrowserSessions,
  updateBrowserSessionActivity,
  updateBrowserSessionStatus,
  updateBrowserSessionCreditsUsed,
  claimBrowserSessionDestroyed,
  invalidateActiveBrowserSessionCount,
  didBrowserSessionUsePrompt,
  clearBrowserSessionPromptFlag,
} from "../../lib/browser-sessions";
import {
  getCombinedTeamActiveCount,
  mirrorExternalSlotAcquire,
  mirrorExternalSlotRelease,
} from "../../services/worker/nuq-router";
import { RequestWithAuth } from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
import { logRequest } from "../../services/logging/log_job";
import { integrationSchema } from "../../utils/integration";
import {
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
  calculateBrowserSessionCredits,
} from "../../lib/browser-billing";
import { autumnService } from "../../services/autumn/autumn.service";
import {
  getPublicBrowserRuntime,
  PublicBrowserRuntimeError,
  type PublicBrowserSession,
} from "../../lib/browser-runtime/public-browser-runtime";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const allowedDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .superRefine((value, context) => {
    if (
      value !== value.toLowerCase() ||
      value === "localhost" ||
      value.includes(":") ||
      value.includes("/") ||
      value.includes("@") ||
      value.includes("*") ||
      isIP(value) !== 0 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(
        value,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "allowedDomains must contain lowercase ASCII hostnames",
      });
    }
  });

const browserCreateRequestSchema = z
  .strictObject({
    ttl: z.number().int().min(30).max(3600).default(600),
    activityTtl: z.number().int().min(10).max(600).default(300),
    allowedDomains: z.array(allowedDomainSchema).max(8).default([]),
    streamWebView: z.boolean().default(true),
    integration: integrationSchema.optional().transform(val => val || null),
    profile: z
      .strictObject({
        name: z.string().min(1).max(128),
        saveChanges: z.boolean().default(true),
      })
      .optional(),
  })
  .transform(value => ({
    ...value,
    activityTtl: Math.min(value.ttl, value.activityTtl),
    allowedDomains: [...new Set(value.allowedDomains)],
  }));

type BrowserCreateRequest = z.infer<typeof browserCreateRequestSchema>;

interface BrowserCreateResponse {
  success: boolean;
  id?: string;
  cdpUrl?: string;
  liveViewUrl?: string;
  interactiveLiveViewUrl?: string;
  expiresAt?: string;
  error?: string;
}

interface BrowserDeleteResponse {
  success: boolean;
  sessionDurationMs?: number;
  creditsBilled?: number;
  error?: string;
}

interface BrowserListResponse {
  success: boolean;
  sessions?: Array<{
    id: string;
    status: string;
    cdpUrl: string;
    liveViewUrl: string;
    interactiveLiveViewUrl: string;
    streamWebView: boolean;
    createdAt: string;
    lastActivity: string;
  }>;
  error?: string;
}

export function configuredPublicBrowserOrigins(): {
  publicBase: string;
  publicWsBase: string;
} {
  if (!config.BROWSER_PUBLIC_API_ORIGIN) {
    throw Object.assign(new Error("Browser public API origin is unavailable"), {
      category: "browser_state_unavailable",
    });
  }
  const parsed = new URL(config.BROWSER_PUBLIC_API_ORIGIN);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== config.BROWSER_PUBLIC_API_ORIGIN
  ) {
    throw Object.assign(new Error("Browser public API origin is invalid"), {
      category: "browser_state_unavailable",
    });
  }
  const publicBase = parsed.origin;
  return {
    publicBase,
    publicWsBase: publicBase.replace(/^http/, "ws"),
  };
}

function publicSessionResponse(session: PublicBrowserSession) {
  return {
    id: session.id,
    cdpUrl: session.cdpUrl,
    liveViewUrl: session.liveViewUrl,
    interactiveLiveViewUrl: session.interactiveLiveViewUrl,
    expiresAt: session.expiresAt,
  };
}

function mapLocalBrowserError(error: unknown): {
  status: number;
  message: string;
} {
  const category =
    error instanceof PublicBrowserRuntimeError
      ? error.category
      : error &&
          typeof error === "object" &&
          "category" in error &&
          typeof error.category === "string"
        ? error.category
        : "browser_unavailable";
  const status =
    category === "profile_locked"
      ? 409
      : category === "concurrency_exceeded" ||
          category === "action_limit_exceeded"
        ? 429
        : category === "browser_not_found"
          ? 404
          : category === "browser_expired"
            ? 410
            : category === "browser_forbidden" ||
                category === "capability_denied" ||
                category === "target_blocked"
              ? 403
              : category === "model_protocol_error" ||
                  category === "adapter_protocol_error"
                ? 502
                : category === "deadline_exceeded" || category === "timed_out"
                  ? 504
                  : 503;
  const message =
    status === 409
      ? "Another session is currently writing to this profile."
      : status === 404
        ? "Browser session not found."
        : status === 410
          ? "Browser session has expired."
          : status === 403
            ? "Forbidden."
            : status === 429
              ? "Browser concurrency limit was reached."
              : status === 502
                ? "Browser execution returned an invalid protocol result."
                : status === 504
                  ? "Browser execution timed out."
                  : "Browser state is temporarily unavailable.";
  return { status, message };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build headers for authenticating against the browser service.
 */
function browserServiceHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };
  if (config.BROWSER_SERVICE_API_KEY) {
    headers["Authorization"] = `Bearer ${config.BROWSER_SERVICE_API_KEY}`;
  }
  return headers;
}

class BrowserServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Call the browser service and return parsed JSON.
 * Throws on non-2xx responses.
 */
async function browserServiceRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.BROWSER_SERVICE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: browserServiceHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new BrowserServiceError(
      res.status,
      `Browser service ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Browser service response types
// ---------------------------------------------------------------------------

interface BrowserServiceCreateResponse {
  sessionId: string;
  cdpUrl: string;
  viewUrl: string;
  iframeUrl: string;
  interactiveIframeUrl: string;
  expiresAt: string;
}

interface BrowserServiceExecResponse {
  stdout: string;
  result: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

interface BrowserServiceDeleteResponse {
  ok: boolean;
  sessionDurationMs: number;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export async function browserCreateController(
  req: RequestWithAuth<{}, BrowserCreateResponse, BrowserCreateRequest>,
  res: Response<BrowserCreateResponse>,
) {
  // if (!req.acuc?.flags?.browserBeta) {
  //   return res.status(403).json({
  //     success: false,
  //     error:
  //       "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
  //   });
  // }

  const sessionId = uuidv7();
  const logger = _logger.child({
    sessionId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserCreateController",
  });

  req.body = browserCreateRequestSchema.parse(req.body);

  const {
    ttl,
    activityTtl,
    allowedDomains,
    streamWebView,
    profile,
    integration,
  } = req.body;

  if (
    config.LOCAL_BROWSER_SERVICE_ENABLED !== true &&
    !config.BROWSER_SERVICE_URL
  ) {
    return res.status(503).json({
      success: false,
      error:
        "Browser feature is not configured (BROWSER_SERVICE_URL is missing).",
    });
  }

  logger.info("Creating browser session", { ttl, activityTtl });

  // 0a. Check if team has enough credits for the full TTL
  const estimatedCredits = calculateBrowserSessionCredits(ttl * 1000);
  const autumnResult =
    config.LOCAL_PERSISTENCE_ENABLED === true
      ? null
      : await autumnService.checkCredits({
          teamId: req.auth.team_id,
          value: estimatedCredits,
          properties: { source: "browserCreate", path: req.path },
        });

  if (autumnResult !== null && !autumnResult.allowed) {
    logger.warn("Insufficient credits for browser session TTL", {
      estimatedCredits,
      ttl,
    });
    return res.status(402).json({
      success: false,
      error: `Insufficient credits for a ${ttl}s browser session (requires ~${estimatedCredits} credits). For more credits, you can upgrade your plan at https://firecrawl.dev/pricing.`,
    });
  }

  // 0b. Enforce concurrency limit (shared pool with scrape/crawl/interact)
  const concurrencyLimit = req.acuc?.concurrency ?? 2;
  const activeCount = await getCombinedTeamActiveCount(req.auth.team_id);
  if (activeCount >= concurrencyLimit) {
    logger.warn("Concurrency limit reached for browser session", {
      activeCount,
      limit: concurrencyLimit,
    });
    return res.status(429).json({
      success: false,
      error: `You have reached the maximum number of concurrent jobs (${concurrencyLimit}). Please wait for existing jobs to complete or destroy browser sessions before creating new ones.`,
    });
  }

  if (config.LOCAL_BROWSER_SERVICE_ENABLED === true) {
    const runtime = getPublicBrowserRuntime();
    if (!runtime) {
      return res.status(503).json({
        success: false,
        error: "Browser state is temporarily unavailable.",
      });
    }
    try {
      await logRequest({
        id: sessionId,
        kind: "browser",
        api_version: "v2",
        team_id: req.auth.team_id,
        target_hint: "Browser session",
        origin: "api",
        integration: integration ?? null,
        zeroDataRetention: false,
        api_key_id: req.acuc?.api_key_id ?? null,
      });
      const session = await runtime.createSession({
        requestId: sessionId,
        ownerId: req.auth.team_id,
        initialUrl: "about:blank",
        allowedDomains,
        ttlSeconds: ttl,
        activityTtlSeconds: activityTtl,
        streamWebView,
        profile,
        replay: null,
        settings: {
          headers: {},
          cookies: [],
          viewport: {
            width: 1280,
            height: 800,
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
          },
          userAgent: "Firecrawl",
          locale: "en-US",
          location: { country: "us-generic", languages: ["en-US"] },
          proxy: { kind: "auto" },
          skipTlsVerification: false,
          blockAds: false,
          lockdown: true,
        },
        concurrencyLimit,
        billingSubscriptionId: req.acuc?.sub_id ?? null,
        billingApiKeyId: req.acuc?.api_key_id ?? null,
        ...configuredPublicBrowserOrigins(),
      });
      invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});
      return res.status(200).json({
        success: true,
        ...publicSessionResponse(session),
      });
    } catch (error) {
      const mapped = mapLocalBrowserError(error);
      logger.warn("Local browser session creation failed", {
        category:
          error && typeof error === "object" && "category" in error
            ? error.category
            : "browser_unavailable",
      });
      return res
        .status(mapped.status)
        .json({ success: false, error: mapped.message });
    }
  }

  // 1. Create a browser session via the browser service (retry up to 3 times)
  const MAX_CREATE_RETRIES = 3;
  let svcResponse: BrowserServiceCreateResponse | undefined;
  let lastCreateError: unknown;

  // Build persistentStorage from profile if provided
  let persistentStorage: { uniqueId: string; write: boolean } | undefined;
  if (profile) {
    const teamHash = createHash("sha256")
      .update(req.auth.team_id)
      .digest("hex")
      .slice(0, 16);
    persistentStorage = {
      uniqueId: `${teamHash}_${profile.name}`,
      write: profile.saveChanges !== false,
    };
  }

  for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
    try {
      svcResponse = await browserServiceRequest<BrowserServiceCreateResponse>(
        "POST",
        "/browsers",
        {
          ttl,
          ...(activityTtl !== undefined ? { activityTtl } : {}),
          ...(persistentStorage !== undefined ? { persistentStorage } : {}),
        },
      );
      break;
    } catch (err) {
      // 409 means the profile is locked by another writer — don't retry
      if (err instanceof BrowserServiceError && err.status === 409) {
        logger.warn("Profile is locked", {
          profileName: profile?.name,
          error: err,
        });
        return res.status(409).json({
          success: false,
          error:
            "Another session is currently writing to this profile. Only one writer is allowed at a time. You can still access it with saveChanges: false, or try again later.",
        });
      }

      lastCreateError = err;
      logger.warn("Browser session creation attempt failed", {
        attempt,
        maxRetries: MAX_CREATE_RETRIES,
        error: err,
      });
      if (attempt < MAX_CREATE_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  if (!svcResponse) {
    logger.error("Failed to create browser session after all retries", {
      error: lastCreateError,
      attempts: MAX_CREATE_RETRIES,
    });
    return res.status(502).json({
      success: false,
      error: "Failed to create browser session.",
    });
  }

  // 2. Persist session in Supabase
  try {
    await logRequest({
      id: sessionId,
      kind: "browser",
      api_version: "v2",
      team_id: req.auth.team_id,
      target_hint: "Browser session",
      origin: "api",
      integration: integration ?? null,
      zeroDataRetention: false,
      api_key_id: req.acuc!.api_key_id,
    });
    await insertBrowserSession({
      id: sessionId,
      team_id: req.auth.team_id,
      browser_id: svcResponse.sessionId,
      workspace_id: "",
      context_id: "",
      cdp_url: svcResponse.cdpUrl,
      cdp_path: svcResponse.iframeUrl, // repurposed: stores view URL
      cdp_interactive_path: svcResponse.interactiveIframeUrl, // repurposed: stores interactive view URL
      stream_web_view: streamWebView,
      status: "active",
      ttl_total: ttl,
      ttl_without_activity: activityTtl ?? null,
      credits_used: null,
    });
  } catch (err) {
    // If we can't persist, tear down the browser session
    logger.error("Failed to persist browser session, cleaning up", {
      error: err,
    });
    await browserServiceRequest(
      "DELETE",
      `/browsers/${svcResponse.sessionId}`,
    ).catch(() => {});
    return res.status(500).json({
      success: false,
      error: "Failed to persist browser session.",
    });
  }

  // Invalidate cached count so next check reflects the new session
  invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});

  // Register in the shared concurrency limiter so this session counts
  // against the team's concurrent job limit while it's active.
  mirrorExternalSlotAcquire(req.auth.team_id, sessionId, ttl * 1000).catch(
    () => {},
  );

  logger.info("Browser session created", {
    sessionId,
    browserId: svcResponse.sessionId,
  });

  return res.status(200).json({
    success: true,
    id: sessionId,
    cdpUrl: svcResponse.cdpUrl,
    liveViewUrl: svcResponse.iframeUrl,
    interactiveLiveViewUrl: svcResponse.interactiveIframeUrl,
    expiresAt: svcResponse.expiresAt,
  });
}

export async function browserDeleteController(
  req: RequestWithAuth<{ sessionId: string }, BrowserDeleteResponse>,
  res: Response<BrowserDeleteResponse>,
) {
  // if (!req.acuc?.flags?.browserBeta) {
  //   return res.status(403).json({
  //     success: false,
  //     error:
  //       "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
  //   });
  // }

  const id = req.params.sessionId;

  const logger = _logger.child({
    sessionId: id,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserDeleteController",
  });

  if (config.LOCAL_BROWSER_SERVICE_ENABLED === true) {
    const runtime = getPublicBrowserRuntime();
    if (!runtime) {
      return res.status(503).json({
        success: false,
        error: "Browser state is temporarily unavailable.",
      });
    }
    try {
      const result = await runtime.stopSession(req.auth.team_id, id);
      invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});
      return res.status(200).json({
        success: true,
        ...(result.sessionDurationMs === undefined
          ? {}
          : { sessionDurationMs: result.sessionDurationMs }),
        ...(result.creditsBilled === undefined
          ? {}
          : { creditsBilled: result.creditsBilled }),
      });
    } catch (error) {
      const mapped = mapLocalBrowserError(error);
      return res
        .status(mapped.status)
        .json({ success: false, error: mapped.message });
    }
  }

  const session = await getBrowserSession(id);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  logger.info("Deleting browser session");

  // Release the browser session via the browser service
  let sessionDurationMs: number | undefined;
  try {
    const deleteResult =
      await browserServiceRequest<BrowserServiceDeleteResponse>(
        "DELETE",
        `/browsers/${session.browser_id}`,
      );
    sessionDurationMs = deleteResult?.sessionDurationMs;
  } catch (err) {
    logger.warn("Failed to delete browser session via browser service", {
      error: err,
    });
  }

  const claimed = await claimBrowserSessionDestroyed(session.id);

  // Invalidate cached count so next check reflects the destroyed session
  invalidateActiveBrowserSessionCount(session.team_id).catch(() => {});
  mirrorExternalSlotRelease(session.team_id, session.id).catch(error => {
    logger.error(
      "Failed to remove concurrency limiter entry for browser session",
      {
        error,
        sessionId: session.id,
        teamId: session.team_id,
      },
    );
  });

  if (!claimed) {
    // The webhook (or another DELETE call) already transitioned and billed.
    logger.info("Session already destroyed by another path, skipping billing", {
      sessionId: session.id,
    });
    return res.status(200).json({
      success: true,
    });
  }

  const wallClockMs = Date.now() - new Date(session.created_at).getTime();
  const durationMs =
    sessionDurationMs && sessionDurationMs > 0
      ? sessionDurationMs
      : wallClockMs;

  const usedPrompt = await didBrowserSessionUsePrompt(session.id);
  const rate = usedPrompt
    ? INTERACT_CREDITS_PER_HOUR
    : BROWSER_CREDITS_PER_HOUR;
  const creditsBilled = calculateBrowserSessionCredits(durationMs, rate);

  clearBrowserSessionPromptFlag(session.id).catch(() => {});

  updateBrowserSessionCreditsUsed(session.id, creditsBilled).catch(error => {
    logger.error("Failed to update credits_used on browser session", {
      error,
      sessionId: session.id,
      creditsBilled,
    });
  });

  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id ?? undefined,
    creditsBilled,
    req.acuc?.api_key_id ?? null,
    { endpoint: usedPrompt ? "interact" : "browser", jobId: session.id },
  ).catch(error => {
    logger.error("Failed to bill team for browser session", {
      error,
      creditsBilled,
      durationMs,
    });
  });

  logger.info("Browser session destroyed", {
    sessionDurationMs: durationMs,
    creditsBilled,
  });

  return res.status(200).json({
    success: true,
  });
}

export async function browserListController(
  req: RequestWithAuth<{}, BrowserListResponse>,
  res: Response<BrowserListResponse>,
) {
  // if (!req.acuc?.flags?.browserBeta) {
  //   return res.status(403).json({
  //     success: false,
  //     error:
  //       "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
  //   });
  // }

  const logger = _logger.child({
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserListController",
  });

  logger.info("Listing browser sessions");

  const statusFilter = (req.query as Record<string, string>).status as
    | "active"
    | "destroyed"
    | undefined;

  if (config.LOCAL_BROWSER_SERVICE_ENABLED === true) {
    const runtime = getPublicBrowserRuntime();
    if (!runtime) {
      return res.status(503).json({
        success: false,
        error: "Browser state is temporarily unavailable.",
      });
    }
    try {
      const sessions = await runtime.listSessions(
        req.auth.team_id,
        statusFilter,
        configuredPublicBrowserOrigins(),
      );
      return res.status(200).json({
        success: true,
        sessions: sessions.map(session => ({
          id: session.id,
          status: session.status,
          cdpUrl: session.cdpUrl,
          liveViewUrl: session.liveViewUrl,
          interactiveLiveViewUrl: session.interactiveLiveViewUrl,
          streamWebView: session.streamWebView,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
        })),
      });
    } catch (error) {
      const mapped = mapLocalBrowserError(error);
      return res
        .status(mapped.status)
        .json({ success: false, error: mapped.message });
    }
  }

  const rows = await listBrowserSessions(req.auth.team_id, {
    status: statusFilter,
  });

  return res.status(200).json({
    success: true,
    sessions: rows.map(r => ({
      id: r.id,
      status: r.status,
      cdpUrl: r.cdp_url,
      liveViewUrl: r.cdp_path,
      interactiveLiveViewUrl: r.cdp_interactive_path,
      streamWebView: r.stream_web_view,
      createdAt: r.created_at,
      lastActivity: r.updated_at,
    })),
  });
}

export async function browserWebhookDestroyedController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "api/v2",
    method: "browserWebhookDestroyedController",
  });

  // Validate browser service secret
  const secret = req.headers["x-browser-service-secret"];
  if (
    !config.BROWSER_SERVICE_WEBHOOK_SECRET ||
    !secret ||
    secret !== config.BROWSER_SERVICE_WEBHOOK_SECRET
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    return res.status(400).json({ error: "Missing browserId" });
  }
  let browserId = sessionId;

  logger.info("Received destroyed webhook from browser service", { browserId });

  const session = await getBrowserSessionByBrowserId(browserId);
  if (!session) {
    logger.warn("No session found for destroyed webhook", { browserId });
    return res.status(200).json({ ok: true });
  }

  const claimed = await claimBrowserSessionDestroyed(session.id);

  invalidateActiveBrowserSessionCount(session.team_id).catch(() => {});
  mirrorExternalSlotRelease(session.team_id, session.id).catch(error => {
    logger.error(
      "Failed to remove concurrency limiter entry for browser session via webhook",
      {
        error,
        sessionId: session.id,
        teamId: session.team_id,
      },
    );
  });

  if (!claimed) {
    logger.info("Session already destroyed by another path, skipping billing", {
      sessionId: session.id,
      browserId,
    });
    return res.status(200).json({ ok: true });
  }

  const durationMs = Date.now() - new Date(session.created_at).getTime();

  const usedPrompt = await didBrowserSessionUsePrompt(session.id);
  const rate = usedPrompt
    ? INTERACT_CREDITS_PER_HOUR
    : BROWSER_CREDITS_PER_HOUR;
  const creditsBilled = calculateBrowserSessionCredits(durationMs, rate);

  clearBrowserSessionPromptFlag(session.id).catch(() => {});

  updateBrowserSessionCreditsUsed(session.id, creditsBilled).catch(error => {
    logger.error(
      "Failed to update credits_used on browser session via webhook",
      {
        error,
        sessionId: session.id,
        creditsBilled,
      },
    );
  });

  billTeam(
    session.team_id,
    undefined, // subscription_id — billTeam will look it up
    creditsBilled,
    null, // api_key_id not available in webhook context
    { endpoint: usedPrompt ? "interact" : "browser", jobId: session.id },
  ).catch(error => {
    logger.error("Failed to bill team for browser session via webhook", {
      error,
      teamId: session.team_id,
      sessionId: session.id,
      creditsBilled,
      durationMs,
    });
  });

  logger.info("Session marked as destroyed via webhook", {
    sessionId: session.id,
    browserId,
    durationMs,
    creditsBilled,
    usedPrompt,
    rate,
  });

  return res.status(200).json({ ok: true });
}
