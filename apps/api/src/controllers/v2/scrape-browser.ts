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
  executePromptViaBrowserAgent,
  executeCodeViaBrowserSession,
  AgentResult,
  getPublicBrowserRuntime,
  PublicBrowserRuntimeError,
} from "../../lib/scrape-interact/browser-agent";
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

export const browserExecuteRequestSchema = z
  .strictObject({
    code: z.string().min(1).max(100_000).optional(),
    prompt: z.string().min(1).max(10_000).optional(),
    language: z.enum(["python", "node", "bash"]).default("node"),
    timeout: z.number().int().min(1).max(300).default(30),
    origin: z.string().optional(),
    integration: integrationSchema.optional().transform(val => val || null),
    existingSessionId: browserSessionIdSchema.optional(),
    allowedDomains: z.array(interactAllowedDomainSchema).max(8).default([]),
  })
  .superRefine((data, context) => {
    if ((data.code === undefined) === (data.prompt === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of 'code' or 'prompt' must be provided.",
      });
    }
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
  if (
    category === "concurrency_exceeded" ||
    category === "action_limit_exceeded"
  )
    return { status: 429, message: "Browser concurrency limit was reached." };
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
  if (
    category === "model_protocol_error" ||
    category === "adapter_protocol_error"
  )
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
  const { code: rawCode, prompt, language, timeout, origin } = req.body;

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
        mode: prompt === undefined ? "code" : "prompt",
        ...(prompt === undefined ? { source: rawCode! } : { prompt }),
        language,
        timeoutSeconds: timeout,
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
      if ("output" in result) {
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
      }
      const hasError = result.exitCode !== 0 || result.killed;
      return res.status(200).json({
        success: !hasError,
        cdpUrl: executed.session.cdpUrl,
        liveViewUrl: executed.session.liveViewUrl,
        interactiveLiveViewUrl: executed.session.interactiveLiveViewUrl,
        stdout: result.stdout,
        result: result.result,
        stderr: result.stderr,
        exitCode: result.exitCode,
        killed: result.killed,
        ...(hasError ? { error: result.stderr || "Execution failed" } : {}),
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

  // --- Build replay context from original scrape ---

  const replay = buildReplayContextFromScrape(scrape);
  if (!replay.context) {
    return res.status(409).json({
      success: false,
      error:
        replay.error ??
        "Replay context is unavailable for this scrape job. Please rerun the scrape.",
    });
  }
  const replayContext = replay.context;

  if (!config.BROWSER_SERVICE_URL) {
    return res.status(503).json({
      success: false,
      error:
        "Browser feature is not configured (BROWSER_SERVICE_URL is missing).",
    });
  }

  logger = logger.child({
    replayTargetUrl: replayContext.targetUrl,
    replayWaitForMs: replayContext.waitForMs,
    replayActions: replayContext.actions.length,
  });

  // --- Ensure a browser session exists (create + replay if needed) ---

  let session = await getBrowserSessionFromScrape(scrapeId);

  if (!session && req.body.existingSessionId) {
    const existing = await getBrowserSession(req.body.existingSessionId);
    if (
      existing &&
      existing.team_id === req.auth.team_id &&
      existing.status === "active"
    ) {
      await updateBrowserSessionScrapeId(existing.id, scrapeId);
      session = { ...existing, scrape_id: scrapeId };
      logger.info("Adopted pre-created browser session for scrape", {
        scrapeId,
        sessionId: session.id,
        browserId: session.browser_id,
      });
    }
  }

  if (!session) {
    const created = await createSessionForScrape(
      req,
      scrapeId,
      replayContext,
      logger,
      (scrape.options as ScrapeOptions).profile,
    );
    if ("error" in created) {
      if (
        created.status === 429 &&
        created.body.error === KEYLESS_CREDITS_MESSAGE
      ) {
        applyAgentAuthDiscoveryHeader(res);
      }
      return res.status(created.status).json(created.body);
    }
    session = created.session;

    logger = logger.child({
      sessionId: session.id,
      browserId: session.browser_id,
    });
    logger.info("Browser session created for scrape", {
      scrapeId,
      sessionId: session.id,
      browserId: session.browser_id,
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({ success: false, error: "Forbidden." });
  }
  if (session.status === "destroyed") {
    return res
      .status(410)
      .json({ success: false, error: "Browser session has been destroyed." });
  }

  updateBrowserSessionActivity(session.id).catch(() => {});

  // --- Execute: prompt-based agent loop OR direct code ---
  //
  // Skip LangSmith tracing entirely for teams with forced zero-data-retention,
  // matching how tracking.ts skips ClickHouse writes. The trace would otherwise
  // ship the full prompt, tool I/O, and page snapshots to a third party.
  const zdrForced = getScrapeZDR(req.acuc?.flags) === "forced";

  // Upstream context from the scrape job — interact extends scrape, so
  // every run carries the URL / wait / actions / origin that set the stage
  // for what the agent does on top of it. URLs are stripped of query
  // strings to avoid leaking PII into LangSmith.
  const scrapeOptions = (scrape.options ?? {}) as {
    origin?: string;
  };
  const traceScrapeContext = {
    scrapeUrl: sanitizeUrlForTrace(scrape.url),
    targetUrl: sanitizeUrlForTrace(replayContext.targetUrl),
    scrapeWaitForMs: replayContext.waitForMs,
    scrapeActions: replayContext.actions.length,
    scrapeOrigin:
      typeof scrapeOptions.origin === "string"
        ? scrapeOptions.origin
        : undefined,
  };

  // Identity fields below team_id — optional, normalized from null → undefined
  // so LangSmith metadata filters don't match empty strings.
  const traceIdentity = {
    orgId: req.auth.org_id ?? undefined,
    subUserId: req.acuc?.sub_user_id ?? undefined,
  };

  let execResult: BrowserServiceExecResponse | AgentResult;

  if (prompt && !rawCode) {
    logger.info("Starting agent loop from prompt", { prompt, timeout });

    await markBrowserSessionUsedPrompt(session.id);

    try {
      execResult = await executePromptViaBrowserAgent(
        prompt,
        session.browser_id,
        timeout,
        logger,
        {
          sessionId: session.id,
          scrapeId,
          teamId: req.auth.team_id,
          ...traceIdentity,
          zeroDataRetention: zdrForced,
          ...traceScrapeContext,
        },
      );
    } catch (err) {
      logger.error("Agent loop failed", { error: err });
      return res.status(502).json({
        success: false,
        error: "Browser agent failed to execute the task.",
      });
    }

    await enqueueBrowserSessionActivity({
      team_id: req.auth.team_id,
      session_id: session.id,
      source: "interact",
      language: "bash",
      timeout,
      exit_code: execResult.exitCode ?? null,
      killed: execResult.killed ?? false,
    });
  } else {
    logger.info("Executing code in browser session", { language, timeout });

    try {
      execResult = await executeCodeViaBrowserSession(
        session.browser_id,
        { code: rawCode!, language, timeout, origin },
        {
          sessionId: session.id,
          scrapeId,
          teamId: req.auth.team_id,
          ...traceIdentity,
          zeroDataRetention: zdrForced,
          ...traceScrapeContext,
        },
      );
    } catch (err) {
      logger.error("Failed to execute code via browser service", {
        error: err,
      });
      return res.status(502).json({
        success: false,
        error: "Failed to execute code in browser session.",
      });
    }

    await enqueueBrowserSessionActivity({
      team_id: req.auth.team_id,
      session_id: session.id,
      source: "interact",
      language,
      timeout,
      exit_code: execResult.exitCode ?? null,
      killed: execResult.killed ?? false,
    });
  }

  // --- Respond ---

  logger.debug("Execution result", {
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    stdoutLength: execResult.stdout?.length,
    stderrLength: execResult.stderr?.length,
  });

  const hasError = execResult.exitCode !== 0 || execResult.killed;
  const agentOutput = "output" in execResult ? execResult.output : undefined;

  return res.status(200).json({
    success: !hasError,
    cdpUrl: session.cdp_url,
    liveViewUrl: session.cdp_path,
    interactiveLiveViewUrl: session.cdp_interactive_path,
    ...(agentOutput ? { output: agentOutput } : {}),
    stdout: execResult.stdout,
    result: execResult.result,
    stderr: execResult.stderr,
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    ...(hasError ? { error: execResult.stderr || "Execution failed" } : {}),
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

async function createSessionForScrape(
  req: RequestWithAuth<any, any, any>,
  scrapeId: string,
  replayContext: ReturnType<typeof buildReplayContextFromScrape> extends {
    context?: infer C;
  }
    ? NonNullable<C>
    : never,
  logger: typeof _logger,
  profile: { name: string; saveChanges: boolean } | undefined,
): Promise<
  | { session: Awaited<ReturnType<typeof insertBrowserSession>> }
  | { status: number; body: { success: false; error: string }; error: true }
> {
  const sessionId = uuidv7();
  const { ttl, activityTtl, streamWebView } = browserCreateRequestSchema.parse(
    {},
  );
  const integration = req.body?.integration ?? null;

  logger.info("No browser session found for scrape. Creating one.", {
    scrapeId,
    ttl,
    activityTtl,
  });

  // Credit check (uses base rate — actual billing may be higher if prompts are used)
  const estimatedCredits = calculateBrowserSessionCredits(ttl * 1000);
  const reservation = await reserveKeylessCredits(
    req.auth.team_id,
    estimatedCredits,
  );
  if (!reservation.ok) {
    return {
      status: 429,
      body: {
        success: false,
        error: KEYLESS_CREDITS_MESSAGE,
      },
      error: true,
    };
  }
  const keylessReserved = estimatedCredits;

  const autumnResult = await autumnService.checkCredits({
    teamId: req.auth.team_id,
    value: estimatedCredits,
    properties: { source: "scrapeBrowserCreate", path: req.path },
  });

  if (autumnResult !== null && !autumnResult.allowed) {
    adjustKeylessCredits(req.auth.team_id, -keylessReserved).catch(() => {});
    return {
      status: 402,
      body: {
        success: false,
        error: `Insufficient credits for a ${ttl}s browser session (requires ~${estimatedCredits} credits). For more credits, you can upgrade your plan at https://firecrawl.dev/pricing.`,
      },
      error: true,
    };
  }

  // Active session limit — uses the same concurrency pool as scrape/crawl
  const concurrencyLimit = req.acuc?.concurrency ?? 2;
  const activeCount = await getCombinedTeamActiveCount(req.auth.team_id);
  if (activeCount >= concurrencyLimit) {
    adjustKeylessCredits(req.auth.team_id, -keylessReserved).catch(() => {});
    return {
      status: 429,
      body: {
        success: false,
        error: `You have reached the maximum number of concurrent jobs (${concurrencyLimit}). Please wait for existing jobs to complete or destroy browser sessions before creating new ones.`,
      },
      error: true,
    };
  }

  // Create the browser session (retry up to 3 times)
  const MAX_CREATE_RETRIES = 3;
  let svcResponse: BrowserServiceCreateResponse | undefined;
  let lastCreateError: unknown;

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
      if (err instanceof BrowserServiceError && err.status === 409) {
        adjustKeylessCredits(req.auth.team_id, -keylessReserved).catch(
          () => {},
        );
        return {
          status: 409,
          body: {
            success: false,
            error:
              "Another session is currently writing to this profile. Only one writer is allowed at a time. You can still access it with saveChanges: false, or try again later.",
          },
          error: true,
        };
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
    adjustKeylessCredits(req.auth.team_id, -keylessReserved).catch(() => {});
    logger.error("Failed to create browser session after all retries", {
      error: lastCreateError,
    });
    return {
      status: 502,
      body: { success: false, error: "Failed to create browser session." },
      error: true,
    };
  }

  // Replay original scrape context
  try {
    const replayResult =
      await browserServiceRequest<BrowserServiceExecResponse>(
        "POST",
        `/browsers/${svcResponse.sessionId}/exec`,
        {
          code: buildReplayScript(replayContext),
          language: "node",
          timeout: estimateReplayTimeoutSeconds(replayContext),
          origin: "scrape_replay",
        },
      );

    if (replayResult.exitCode !== 0 || replayResult.killed) {
      throw new Error(
        replayResult.stderr?.trim() ||
          replayResult.stdout?.trim() ||
          "Replay script exited with an error.",
      );
    }

    // Ensure only one tab exists with the content page in the foreground.
    // The replay may have created extra tabs. Find the one with content,
    // close everything else, update the REPL's page var, and bring to front.
    await browserServiceRequest(
      "POST",
      `/browsers/${svcResponse.sessionId}/exec`,
      {
        code: [
          `const ctx = page.context();`,
          `const pages = ctx.pages();`,
          `if (pages.length > 1) {`,
          `  const target = pages.find(p => { const u = p.url(); return u && u !== 'about:blank'; }) || pages[pages.length - 1];`,
          `  for (const p of pages) { if (p !== target) await p.close().catch(() => {}); }`,
          `  page = target;`,
          `}`,
          `await page.bringToFront();`,
        ].join("\n"),
        language: "node",
        timeout: 10,
        origin: "tab_sync",
      },
    ).catch(() => {});

    // Sync agent-browser to the correct page
    const syncResult = await browserServiceRequest<BrowserServiceExecResponse>(
      "POST",
      `/browsers/${svcResponse.sessionId}/exec`,
      {
        code: `agent-browser get url`,
        language: "bash",
        timeout: 10,
        origin: "scrape_replay_sync",
      },
    );

    const agentUrl = (syncResult.stdout || "").trim();
    if (!agentUrl || agentUrl === "about:blank") {
      logger.info("agent-browser on wrong page after replay, navigating", {
        agentUrl,
        targetUrl: replayContext.targetUrl,
      });
      await browserServiceRequest<BrowserServiceExecResponse>(
        "POST",
        `/browsers/${svcResponse.sessionId}/exec`,
        {
          code: `await page.goto(${JSON.stringify(replayContext.targetUrl)}, { waitUntil: "networkidle0" });`,
          language: "node",
          timeout: 30,
          origin: "scrape_replay_sync",
        },
      );
    }
  } catch (err) {
    adjustKeylessCredits(req.auth.team_id, -keylessReserved).catch(() => {});
    logger.error("Failed to initialize scrape browser session context", {
      error: err,
    });
    await browserServiceRequest(
      "DELETE",
      `/browsers/${svcResponse.sessionId}`,
    ).catch(() => {});
    return {
      status: 409,
      body: {
        success: false,
        error:
          "Failed to initialize browser session from the original scrape context. Please rerun the scrape and try again.",
      },
      error: true,
    };
  }

  // Persist in Supabase
  try {
    await logRequest({
      id: sessionId,
      kind: "interact",
      api_version: "v2",
      team_id: req.auth.team_id,
      target_hint: "Interact session",
      origin: req.body?.origin ?? "api",
      integration: integration ?? null,
      zeroDataRetention: false,
      api_key_id: req.acuc?.api_key_id ?? null,
    });
    const session = await insertBrowserSession({
      id: sessionId,
      team_id: req.auth.team_id,
      scrape_id: scrapeId,
      browser_id: svcResponse.sessionId,
      workspace_id: "",
      context_id: "",
      cdp_url: svcResponse.cdpUrl,
      cdp_path: svcResponse.iframeUrl,
      cdp_interactive_path: svcResponse.interactiveIframeUrl,
      stream_web_view: streamWebView,
      status: "active",
      ttl_total: ttl,
      ttl_without_activity: activityTtl ?? null,
      credits_used: null,
    });

    invalidateActiveBrowserSessionCount(req.auth.team_id).catch(() => {});

    // Register in the shared concurrency limiter so this session counts
    // against the team's concurrent job limit while it's active.
    mirrorExternalSlotAcquire(req.auth.team_id, sessionId, ttl * 1000).catch(
      () => {},
    );

    return { session };
  } catch (err) {
    adjustKeylessCredits(req.auth.team_id, -keylessReserved).catch(() => {});
    logger.error("Failed to persist browser session, cleaning up", {
      error: err,
    });
    await browserServiceRequest(
      "DELETE",
      `/browsers/${svcResponse.sessionId}`,
    ).catch(() => {});
    return {
      status: 500,
      body: { success: false, error: "Failed to persist browser session." },
      error: true,
    };
  }
}
