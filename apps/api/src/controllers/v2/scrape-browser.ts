import { createHash } from "crypto";
import { isIP } from "node:net";
import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  insertBrowserSession,
  getBrowserSession,
  updateBrowserSessionActivity,
  updateBrowserSessionCreditsUsed,
  updateBrowserSessionScrapeId,
  claimBrowserSessionDestroyed,
  invalidateActiveBrowserSessionCount,
  getBrowserSessionFromScrape,
  markBrowserSessionUsedPrompt,
  didBrowserSessionUsePrompt,
  clearBrowserSessionPromptFlag,
} from "../../lib/browser-sessions";
import {
  getCombinedTeamActiveCount,
  mirrorExternalSlotAcquire,
  mirrorExternalSlotRelease,
} from "../../services/worker/nuq-router";
import {
  browserServiceRequest,
  BrowserServiceError,
  BrowserServiceExecResponse,
  BrowserServiceCreateResponse,
  BrowserServiceDeleteResponse,
} from "../../lib/scrape-interact/legacy-browser-service-client";
import {
  ScrapeContextRow,
  buildReplayContextFromScrape,
  estimateReplayTimeoutSeconds,
  buildReplayScript,
  browserSessionIdSchema,
} from "../../lib/scrape-interact/scrape-replay";
import {
  getPublicBrowserRuntime,
  PublicBrowserRuntimeError,
} from "../../lib/browser-runtime/public-browser-runtime";
import { sanitizeUrlForTrace } from "../../lib/scrape-interact/langsmith";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { RequestWithAuth, ScrapeOptions } from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import {
  KEYLESS_CREDITS_MESSAGE,
  adjustKeylessCredits,
  logKeylessCreditUsage,
  reserveKeylessCredits,
} from "../../lib/keyless";
import { enqueueBrowserSessionActivity } from "../../lib/browser-session-activity";
import { logRequest } from "../../services/logging/log_job";
import { integrationSchema } from "../../utils/integration";
import { supabaseGetScrapeById } from "../../lib/supabase-jobs";
import {
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
  calculateBrowserSessionCredits,
} from "../../lib/browser-billing";
import { autumnService } from "../../services/autumn/autumn.service";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
import { isScrapeOwnedBy } from "../../lib/local-owner";
import { configuredPublicBrowserOrigins } from "./browser";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const browserCreateRequestSchema = z.strictObject({
  ttl: z.number().min(30).max(3600).default(600),
  activityTtl: z.number().min(10).max(3600).default(300),
  streamWebView: z.boolean().default(true),
  integration: integrationSchema.optional().transform(val => val || null),
  profile: z
    .object({
      name: z.string().min(1).max(128),
      saveChanges: z.boolean().default(true),
    })
    .optional(),
});

const interactAllowedDomainSchema = z
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

export const browserExecuteRequestSchema = z.strictObject({
  prompt: z.string().min(1).max(10_000),
  language: z.literal("node").optional(),
  timeout: z.number().int().min(1).max(300).default(30),
  origin: z.string().optional(),
  integration: integrationSchema.optional().transform(val => val || null),
  existingSessionId: browserSessionIdSchema.optional(),
  allowedDomains: z.array(interactAllowedDomainSchema).max(8).default([]),
});

type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

interface BrowserExecuteResponse {
  success: boolean;
  cdpUrl?: string;
  liveViewUrl?: string;
  interactiveLiveViewUrl?: string;
  output?: string;
  turnCount?: number;
  actionCount?: number;
  usage?: { inputTokens: number; outputTokens: number };
  stdout?: string;
  result?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
  error?: string;
}

function mapLocalInteractError(error: unknown): {
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
  if (category === "browser_not_found")
    return { status: 404, message: "Browser session not found." };
  if (category === "insufficient_credits")
    return {
      status: 402,
      message: "Insufficient credits for browser session.",
    };
  if (category === "keyless_credits")
    return { status: 429, message: KEYLESS_CREDITS_MESSAGE };
  if (category === "browser_forbidden" || category === "capability_denied")
    return { status: 403, message: "Forbidden." };
  if (category === "target_blocked")
    return { status: 403, message: "Forbidden." };
  if (category === "concurrency_exceeded")
    return { status: 429, message: "Browser concurrency limit was reached." };
  if (category === "action_limit_exceeded")
    return { status: 422, message: "Browser action limit was reached." };
  if (category === "browser_expired")
    return { status: 410, message: "Browser session has expired." };
  if (
    category === "replay_unavailable" ||
    category === "replay_unsupported" ||
    category === "zdr_replay_unavailable" ||
    category === "profile_locked"
  )
    return {
      status: 409,
      message:
        "Replay context is unavailable for this scrape job. Please rerun the scrape.",
    };
  if (category === "model_protocol_error")
    return {
      status: 422,
      message: "Browser model returned an invalid protocol result.",
    };
  if (category === "adapter_protocol_error")
    return {
      status: 502,
      message: "Browser execution returned an invalid protocol result.",
    };
  if (category === "deadline_exceeded" || category === "timed_out")
    return { status: 504, message: "Browser execution timed out." };
  return { status: 503, message: "Browser state is temporarily unavailable." };
}

interface BrowserDeleteResponse {
  success: boolean;
  sessionDurationMs?: number;
  creditsBilled?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// POST /v2/scrape/:jobId/interact
// ---------------------------------------------------------------------------

export async function scrapeInteractController(
  req: RequestWithAuth<
    { jobId: string },
    BrowserExecuteResponse,
    BrowserExecuteRequest
  >,
  res: Response<BrowserExecuteResponse>,
) {
  req.body = browserExecuteRequestSchema.parse(req.body);

  const scrapeId = req.params.jobId;
  const { prompt, timeout, origin } = req.body;
  const deadline = new Date(Date.now() + timeout * 1_000);

  let logger = _logger.child({
    scrapeId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "scrapeInteractController",
  });

  // --- Validate scrape ownership ---

  const scrape = (await supabaseGetScrapeById(
    scrapeId,
  )) as ScrapeContextRow | null;
  if (!scrape) {
    return res.status(404).json({ success: false, error: "Job not found." });
  }
  // Keyless scrapes are persisted under a deterministic per-IP UUID (the
  // `scrapes.team_id` column is a UUID, so the raw `preview_keyless_<ip>` string
  // can't be stored). Compare against that derived UUID for keyless requests.
  if (!isScrapeOwnedBy(scrape.team_id, req.auth.team_id)) {
    return res.status(403).json({ success: false, error: "Forbidden." });
  }

  if (config.LOCAL_BROWSER_SERVICE_ENABLED === true) {
    const runtime = getPublicBrowserRuntime();
    if (!runtime) {
      return res.status(503).json({
        success: false,
        error: "Browser state is temporarily unavailable.",
      });
    }
    if (getScrapeZDR(req.acuc?.flags) === "forced") {
      return res.status(409).json({
        success: false,
        error: "Replay context is unavailable for zero-data-retention scrapes.",
      });
    }
    let keylessReserved = 0;
    try {
      const replay = await runtime.loadReplayState(req.auth.team_id, scrapeId);
      if (replay.kind !== "checkpoint") {
        return res.status(409).json({
          success: false,
          error:
            "Replay context is unavailable for this scrape job. Please rerun the scrape.",
        });
      }
      const navigationDomains = [
        new URL(replay.envelope.canonicalTargetUrl).hostname.toLowerCase(),
        new URL(replay.checkpoint.finalUrl).hostname.toLowerCase(),
      ];
      const allowedDomains = [
        ...new Set([...req.body.allowedDomains, ...navigationDomains]),
      ];
      if (allowedDomains.length > 8) {
        return res.status(400).json({
          success: false,
          error:
            "allowedDomains and replay origins may contain at most 8 hosts.",
        });
      }
      const requestId = uuidv7();
      const correlationId = uuidv7();
      await logRequest({
        id: requestId,
        kind: "interact",
        api_version: "v2",
        team_id: req.auth.team_id,
        target_hint: "Interact session",
        origin: origin ?? "api",
        integration: req.body.integration ?? null,
        zeroDataRetention: false,
        api_key_id: req.acuc?.api_key_id ?? null,
      });
      const publicOrigins = configuredPublicBrowserOrigins();
      const estimatedCredits = calculateBrowserSessionCredits(
        3_600_000,
        BROWSER_CREDITS_PER_HOUR,
      );
      const executed = await runtime.interact({
        requestId,
        ownerId: req.auth.team_id,
        scrapeId,
        prompt,
        deadline,
        correlationId,
        existingSessionId: req.body.existingSessionId,
        allowedDomains,
        initialUrl: replay.envelope.canonicalTargetUrl,
        replay: replay.checkpoint,
        settings: replay.envelope.browserSettings,
        profile: replay.envelope.profile,
        concurrencyLimit: req.acuc?.concurrency ?? 2,
        billingSubscriptionId: req.acuc?.sub_id ?? null,
        billingApiKeyId: req.acuc?.api_key_id ?? null,
        ...publicOrigins,
        admitSession: async () => {
          const reservation = await reserveKeylessCredits(
            req.auth.team_id,
            estimatedCredits,
          );
          if (!reservation.ok) {
            throw Object.assign(new Error(KEYLESS_CREDITS_MESSAGE), {
              category: "keyless_credits",
            });
          }
          keylessReserved = reservation.creditsUsed > 0 ? estimatedCredits : 0;
          const autumnResult =
            config.LOCAL_PERSISTENCE_ENABLED === true
              ? null
              : await autumnService.checkCredits({
                  teamId: req.auth.team_id,
                  value: estimatedCredits,
                  properties: {
                    source: "scrapeBrowserCreate",
                    path: req.path,
                  },
                });
          if (autumnResult !== null && !autumnResult.allowed) {
            throw Object.assign(new Error("Insufficient credits"), {
              category: "insufficient_credits",
            });
          }
          return keylessReserved > 0
            ? {
                keylessTeamId: req.auth.team_id,
                keylessReservedCredits: keylessReserved,
              }
            : undefined;
        },
        rollbackKeylessReservation: async () => {
          if (keylessReserved > 0) {
            await adjustKeylessCredits(req.auth.team_id, -keylessReserved);
            keylessReserved = 0;
          }
        },
        sessionCreated: async () => {
          invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});
        },
      });
      const result = executed.result;
      return res.status(200).json({
        success: true,
        cdpUrl: executed.session.cdpUrl,
        liveViewUrl: executed.session.liveViewUrl,
        interactiveLiveViewUrl: executed.session.interactiveLiveViewUrl,
        output: result.output,
        turnCount: result.turnCount,
        actionCount: result.actionCount,
        usage: result.usage,
      });
    } catch (error) {
      const mapped = mapLocalInteractError(error);
      if (
        error &&
        typeof error === "object" &&
        "category" in error &&
        error.category === "keyless_credits"
      ) {
        applyAgentAuthDiscoveryHeader(res);
      }
      logger.warn("Local interact execution failed", {
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

  return res.status(503).json({
    success: false,
    error: "Local browser interaction is not enabled.",
  });
}

// ---------------------------------------------------------------------------
// DELETE /v2/scrape/:jobId/interact
// ---------------------------------------------------------------------------

export async function scrapeStopInteractiveBrowserController(
  req: RequestWithAuth<{ jobId: string }, BrowserDeleteResponse>,
  res: Response<BrowserDeleteResponse>,
) {
  let logger = _logger.child({
    scrapeId: req.params.jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "scrapeStopInteractiveBrowserController",
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
      const result = await runtime.stopInteract(
        req.auth.team_id,
        req.params.jobId,
      );
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
      const mapped = mapLocalInteractError(error);
      return res
        .status(mapped.status)
        .json({ success: false, error: mapped.message });
    }
  }

  const session = await getBrowserSessionFromScrape(req.params.jobId);

  if (!session) {
    return res
      .status(404)
      .json({ success: false, error: "Browser session not found." });
  }
  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({ success: false, error: "Forbidden." });
  }

  logger = logger.child({
    sessionId: session.id,
    browserId: session.browser_id,
  });
  logger.info("Deleting browser session");

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
    logger.info("Session already destroyed by another path, skipping billing", {
      sessionId: session.id,
    });
    return res.status(200).json({ success: true });
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
    { endpoint: "interact", jobId: session.id },
  ).catch(error => {
    logger.error("Failed to bill team for interact session", {
      error,
      creditsBilled,
      durationMs,
    });
  });

  const reservedCredits = calculateBrowserSessionCredits(
    session.ttl_total * 1000,
    BROWSER_CREDITS_PER_HOUR,
  );
  adjustKeylessCredits(req.auth.team_id, creditsBilled - reservedCredits).catch(
    () => {},
  );
  logKeylessCreditUsage(req.auth.team_id, creditsBilled).catch(() => {});

  logger.info("Browser session destroyed", {
    sessionDurationMs: durationMs,
    creditsBilled,
    usedPrompt,
    rate,
  });

  return res.status(200).json({
    success: true,
    sessionDurationMs: durationMs,
    creditsBilled,
  });
}

// ---------------------------------------------------------------------------
// Internal: create a browser session for a scrape, replay original context
// ---------------------------------------------------------------------------
