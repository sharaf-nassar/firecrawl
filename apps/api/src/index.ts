import "dotenv/config";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import "./services/sentry";
import { setSentryServiceTag } from "./services/sentry";
import * as Sentry from "@sentry/node";
import express, { NextFunction, Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import {
  getGenerateLlmsTxtQueue,
  getDeepResearchQueue,
  getBillingQueue,
  getPrecrawlQueue,
} from "./services/queue-service";
import { v0Router } from "./routes/v0";
import os from "os";
import { logger } from "./lib/logger";
import { adminRouter } from "./routes/admin";
import http from "node:http";
import https from "node:https";
import { v1Router } from "./routes/v1";
import expressWs from "express-ws";
import {
  ErrorResponse,
  RequestWithMaybeACUC,
  ResponseWithSentry,
} from "./controllers/v1/types";
import { ZodError } from "zod";
import { QueueFullError } from "./lib/queue-full-error";
import { v7 as uuidv7 } from "uuid";
import { attachWsProxy } from "./services/agentLivecastWS";
import { cacheableLookup } from "./scraper/scrapeURL/lib/cacheableLookup";
import { v2Router } from "./routes/v2";
import { nuqShutdown } from "./services/worker/nuq";
import { getErrorContactMessage } from "./lib/deployment";
import { initializeBlocklist } from "./scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "./scraper/WebScraper/utils/engine-forcing";
import responseTime from "response-time";
import { shutdownWebhookQueue } from "./services/webhook";
import { shutdownIndexerQueue } from "./services/indexing/indexer-queue";
import { Pool } from "pg";
import { runApplicationMigrations } from "./db/migrate";
import { resolveLocalRuntimeConfig } from "./lib/local-runtime-config";
import { inspectBrowserStateProcessIdentity } from "./lib/browser-state/process-identity";
import { interruptUnfinishedBrowserWork } from "./lib/browser-state/store";
import { BrowserServiceClient } from "./lib/scrape-interact/browser-service-client";
import {
  createBrowserStartupGate,
  type BrowserStateMutationLease,
  type BrowserStartupGate,
} from "./lib/browser-runtime/startup-gate";
import {
  BrowserReconciliationCoordinatorError,
  createBrowserReconciliationCoordinator,
  type BrowserControlGenerationHandoff,
  type BrowserReconciliationCoordinator,
} from "./lib/browser-runtime/reconciliation-coordinator";
import { loadBrowserReconciliationSnapshot } from "./lib/browser-runtime/reconciliation-snapshot";
import { runApiStartupLifecycle } from "./lib/browser-runtime/api-startup-lifecycle";
import { registerReplayPersistenceAuthorityRoute } from "./lib/scrape-interact/replay-store";
import {
  createLocalRetentionService,
  recoverBrowserCleanupIntentsBeforeSnapshot,
  runLocalRetentionLoop,
  type LocalRetentionService,
} from "./services/local-retention-worker";
import { registerInternalRoutes } from "./routes/internal";
import {
  createPublicBrowserRuntime,
  registerPublicBrowserRuntime,
} from "./lib/browser-runtime/public-browser-runtime";
import { createSocketExecutionAdapter } from "./lib/browser-runtime/execution-adapter";
import { createBrowserProxyGrantStore } from "./lib/browser-state/proxy-grant-store";
import { registerBrowserProxyRuntime } from "./controllers/v2/browser-proxy";
import {
  getCombinedTeamActiveCount,
  mirrorExternalSlotAcquire,
  releaseExternalSlotBackend,
} from "./services/worker/nuq-router";
import { startBrowserBillingOutboxWorker } from "./services/browser-billing-outbox";
import { startBrowserAdmissionCleanupWorker } from "./services/browser-admission-cleanup";

type LocalBrowserRuntime = {
  pool: Pool;
  gate: BrowserStartupGate;
  coordinator: BrowserReconciliationCoordinator;
  handoff: BrowserControlGenerationHandoff;
  browserClient: BrowserServiceClient;
};

let localBrowserRuntime: LocalBrowserRuntime | undefined;
let localRetentionService: LocalRetentionService | undefined;
let localBrowserBillingWorker: { stop(): Promise<void> } | undefined;
let localBrowserAdmissionWorker: { stop(): Promise<void> } | undefined;
let localRuntimeStop: Promise<void> | undefined;

const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");

const numCPUs = config.ENV === "local" ? 2 : os.cpus().length;
logger.info(`Number of CPUs: ${numCPUs} available`);

logger.info("Network info dump", {
  networkInterfaces: os.networkInterfaces(),
});

// Install cacheable lookup for all other requests
cacheableLookup.install(http.globalAgent);
cacheableLookup.install(https.globalAgent);

// Initialize Express with WebSocket support
const expressApp = express();
const ws = expressWs(expressApp, undefined, {
  wsOptions: { maxPayload: 256 * 1024 },
});
const app = ws.app;

global.isProduction = config.IS_PRODUCTION;

setSentryServiceTag("api");

registerReplayPersistenceAuthorityRoute(app, {
  apiKey: config.BROWSER_REPLAY_INGEST_API_KEY,
  getGate: () => localBrowserRuntime?.gate,
  getBrowserClient: () => localBrowserRuntime?.browserClient,
});
registerInternalRoutes(app, {
  adapterTokenFile: config.BROWSER_ADAPTER_TOKEN_FILE,
  getRuntime: () =>
    localBrowserRuntime
      ? {
          gate: localBrowserRuntime.gate,
          browserClient: localBrowserRuntime.browserClient,
        }
      : undefined,
});
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "10mb" }));

app.use(cors()); // Add this line to enable CORS

app.use(responseTime());

app.disable("x-powered-by");

if (config.EXPRESS_TRUST_PROXY) {
  app.set("trust proxy", config.EXPRESS_TRUST_PROXY);
}

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(`/admin/${config.BULL_AUTH_KEY}/queues`);

const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
  queues: [
    new BullMQAdapter(getGenerateLlmsTxtQueue()),
    new BullMQAdapter(getDeepResearchQueue()),
    new BullMQAdapter(getBillingQueue()),
    new BullMQAdapter(getPrecrawlQueue()),
  ],
  serverAdapter: serverAdapter,
});

app.use(`/admin/${config.BULL_AUTH_KEY}/queues`, serverAdapter.getRouter());

app.get("/", (_, res) => {
  res.json({
    message: "Firecrawl API",
    documentation_url: "https://docs.firecrawl.dev",
  });
});

app.get("/e2e-test", (_, res) => {
  res.status(200).send("OK");
});

// register router
app.use(v0Router);
app.use("/v1", v1Router);
app.use("/v2", v2Router);
app.use(adminRouter);

const DEFAULT_PORT = config.PORT;
const HOST = config.HOST;

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function prepareLocalRuntimeBeforeMigrations(): Promise<BrowserControlGenerationHandoff> {
  const local = resolveLocalRuntimeConfig(config);
  if (!local.enabled || !local.browserServiceEnabled) {
    throw new Error("Browser runtime preparation requires enabled local mode");
  }
  const pool = new Pool({
    connectionString: local.applicationDatabaseUrl,
    application_name: "firecrawl-browser-reconciliation",
    max: 4,
    connectionTimeoutMillis: local.browserReconciliationStartupBudgetMs,
    statement_timeout: local.browserReconciliationStartupBudgetMs,
    query_timeout: local.browserReconciliationStartupBudgetMs,
    lock_timeout: local.browserReconciliationStartupBudgetMs,
    idle_in_transaction_session_timeout:
      local.browserReconciliationStartupBudgetMs,
  });
  pool.on("error", error => {
    logger.error("Browser reconciliation PostgreSQL pool error", {
      errorName: error.name,
    });
  });
  const gate = createBrowserStartupGate({ pool });
  const serviceClient = new BrowserServiceClient({
    baseUrl: local.browserServiceUrl,
    apiKey: local.browserServiceApiKey,
    requestTimeoutMs: local.browserServiceRequestTimeoutMs,
    reconciliationTimeoutMs: local.browserReconciliationTimeoutMs,
    onControlGenerationMismatch: () => {
      gate.close("control_generation_mismatch");
    },
  });
  const coordinator = createBrowserReconciliationCoordinator({
    gate,
    pool,
    deleteReplayCheckpoint: async (statePath, checksum, lease) => {
      await serviceClient.deleteReplayCheckpoint(
        { version: 1, statePath, checksum },
        browserServiceRequestContext(lease),
      );
    },
    inspectProcessIdentity: inspectBrowserStateProcessIdentity,
    serviceClient,
    loadSnapshot: loadBrowserReconciliationSnapshot,
    interruptUnfinishedBrowserWork,
    recoverBrowserCleanupIntentsBeforeSnapshot,
    pauseBrowserRetention: async () => undefined,
    startBrowserRetention: async () => undefined,
    retry: {
      maxAttempts: local.browserReconciliationMaxAttempts,
      initialBackoffMs: local.browserReconciliationInitialBackoffMs,
      maxBackoffMs: local.browserReconciliationMaxBackoffMs,
      startupBudgetMs: local.browserReconciliationStartupBudgetMs,
      monitorIntervalMs: local.browserReconciliationMonitorIntervalMs,
      retryCooldownMs: local.browserReconciliationRetryCooldownMs,
    },
    now: Date.now,
    sleep,
    logger,
  });
  try {
    const handoff = await coordinator.acquireControlGeneration();
    localBrowserRuntime = {
      pool,
      gate,
      coordinator,
      handoff,
      browserClient: serviceClient,
    };
    registerPublicBrowserRuntime(
      createPublicBrowserRuntime({
        gate,
        browserClient: serviceClient,
        adapter: config.BROWSER_EXECUTION_ADAPTER_SOCKET
          ? createSocketExecutionAdapter({
              socketPath: config.BROWSER_EXECUTION_ADAPTER_SOCKET,
            })
          : undefined,
        getActiveCount: getCombinedTeamActiveCount,
        acquireAdmission: mirrorExternalSlotAcquire,
        releaseAdmissionBackend: releaseExternalSlotBackend,
      }),
    );
    registerBrowserProxyRuntime(
      config.BROWSER_PUBLIC_API_ORIGIN
        ? {
            gate,
            grantStore: createBrowserProxyGrantStore({ gate }),
            browserClient: serviceClient,
            publicApiOrigin: config.BROWSER_PUBLIC_API_ORIGIN,
          }
        : undefined,
    );
    return handoff;
  } catch (error) {
    await coordinator.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function browserServiceRequestContext(lease: BrowserStateMutationLease) {
  return {
    correlationId: randomUUID(),
    deadline: new Date(Date.now() + 30_000),
    signal: AbortSignal.timeout(30_000),
    processNonce: lease.binding.processNonce,
    controlGenerationNonce: lease.binding.controlGenerationNonce,
  };
}

async function startLocalRetentionAfterMigrations(): Promise<void> {
  const local = resolveLocalRuntimeConfig(config);
  if (!local.enabled) return;
  localRetentionService = createLocalRetentionService(signal =>
    runLocalRetentionLoop({
      signal,
      configSource: config,
      browserStartupGate: localBrowserRuntime?.gate,
      deleteReplayCheckpoint:
        localBrowserRuntime === undefined
          ? undefined
          : async (statePath, checksum, lease) => {
              await localBrowserRuntime!.browserClient.deleteReplayCheckpoint(
                { version: 1, statePath, checksum },
                browserServiceRequestContext(lease),
              );
            },
      deleteProfileGeneration:
        localBrowserRuntime === undefined
          ? undefined
          : async (generationId, statePath, checksum, lease) => {
              await localBrowserRuntime!.browserClient.deleteRetainedProfileGeneration(
                { version: 1, generationId, statePath, checksum },
                browserServiceRequestContext(lease),
              );
            },
    }),
  );
  // Operational/artifact retention starts after migrations. Its Browser loop
  // remains gate-blocked until Browser reconciliation is ready.
  void localRetentionService.start();
}

async function initializeLocalBrowserAfterMigrations(
  handoff: BrowserControlGenerationHandoff,
): Promise<void> {
  if (!localBrowserRuntime) {
    throw new Error("Browser runtime handoff is unavailable");
  }
  await localBrowserRuntime.coordinator.initializeAfterMigrations(handoff);
  localBrowserBillingWorker = startBrowserBillingOutboxWorker(
    localBrowserRuntime.gate,
  );
  localBrowserAdmissionWorker = startBrowserAdmissionCleanupWorker(
    localBrowserRuntime.gate,
  );
}

async function stopLocalRuntime(): Promise<void> {
  localRuntimeStop ??= (async () => {
    registerPublicBrowserRuntime(undefined);
    registerBrowserProxyRuntime(undefined);
    await Promise.all([
      localBrowserBillingWorker?.stop(),
      localBrowserAdmissionWorker?.stop(),
    ]);
    await localBrowserRuntime?.coordinator.stop();
    await localRetentionService?.stop();
    await localBrowserRuntime?.pool.end();
    localBrowserRuntime = undefined;
    localRetentionService = undefined;
    localBrowserBillingWorker = undefined;
    localBrowserAdmissionWorker = undefined;
  })();
  return localRuntimeStop;
}

async function startApplicationListener(port: number) {
  await initializeBlocklist();
  initializeEngineForcing();
  attachWsProxy(app);
  return new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(Number(port), HOST);
    const failed = (error: Error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      logger.info(`Worker ${process.pid} listening on port ${port}`);
      resolve(server);
    };
    server.once("error", failed);
    server.once("listening", listening);
  });
}

async function startServer(port = DEFAULT_PORT) {
  let server: Awaited<ReturnType<typeof startApplicationListener>>;
  try {
    const local = resolveLocalRuntimeConfig(config);
    server = await runApiStartupLifecycle({
      persistenceEnabled: local.enabled,
      browserEnabled: local.enabled && local.browserServiceEnabled === true,
      acquireBrowserControl: prepareLocalRuntimeBeforeMigrations,
      runMigrations: async handoff =>
        runApplicationMigrations(config, {
          ...(handoff === undefined
            ? {}
            : { timeoutMs: Math.max(1, handoff.deadlineMs - Date.now()) }),
        }),
      initializeBrowser: initializeLocalBrowserAfterMigrations,
      startOperationalRetention: startLocalRetentionAfterMigrations,
      startApplication: () => startApplicationListener(port),
      cleanupStartupResources: stopLocalRuntime,
      observe: event => {
        logger.info(JSON.stringify(event));
      },
    });
  } catch (error) {
    logger.error("Failed to start API", {
      category:
        error instanceof BrowserReconciliationCoordinatorError
          ? "browser_state_unavailable"
          : "api_startup_failed",
    });
    throw error;
  }

  const exitHandler = async () => {
    logger.info("SIGTERM signal received: closing HTTP server");
    const localStop = stopLocalRuntime();
    if (config.IS_KUBERNETES) {
      // Account for GCE load balancer drain timeout
      logger.info("Waiting 60s for GCE load balancer drain timeout");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
    server.close(() => {
      logger.info("Server closed.");
      localStop.finally(() => {
        nuqShutdown().finally(() => {
          shutdownWebhookQueue().finally(() => {
            shutdownIndexerQueue().finally(() => {
              logger.info("NUQ shutdown complete");
              process.exit(0);
            });
          });
        });
      });
    });
  };

  if (require.main === module) {
    process.on("SIGTERM", exitHandler);
    process.on("SIGINT", exitHandler);
  }
  return server;
}

if (require.main === module) {
  startServer().catch(error => {
    logger.error("Failed to start server", {
      category:
        error instanceof BrowserReconciliationCoordinatorError
          ? "browser_state_unavailable"
          : "api_startup_failed",
    });
    process.exit(1);
  });
}

app.get("/is-production", (req, res) => {
  res.send({ isProduction: global.isProduction });
});

app.use(
  (
    err: unknown,
    req: Request<{}, ErrorResponse, undefined>,
    res: Response<ErrorResponse>,
    next: NextFunction,
  ) => {
    if (err instanceof QueueFullError) {
      res.status(429).json({
        success: false,
        error: err.message,
      });
    } else if (err instanceof ZodError) {
      // In zod v4, ZodError uses 'issues' instead of 'errors'
      const issues = err.issues;

      if (
        Array.isArray(issues) &&
        issues.find(x => x.message === "URL uses unsupported protocol")
      ) {
        logger.warn("Unsupported protocol error: " + JSON.stringify(req.body));
      }

      // Check for unrecognized_keys errors and replace with custom message
      const hasUnrecognizedKeys = issues.some(
        e => e.code === "unrecognized_keys",
      );
      const strictMessage =
        "Unrecognized key in body -- please review the v2 API documentation for request body changes";

      const customErrorMessage = hasUnrecognizedKeys
        ? strictMessage
        : issues.length > 0 && issues[0].code === "custom"
          ? issues[0].message
          : "Bad Request";

      res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error: customErrorMessage,
        details: issues,
      });
    } else {
      next(err);
    }
  },
);

Sentry.setupExpressErrorHandler(app);

app.use(
  (
    err: unknown,
    req: RequestWithMaybeACUC<{}, ErrorResponse, undefined>,
    res: ResponseWithSentry<ErrorResponse>,
    next: NextFunction,
  ) => {
    if (
      err instanceof SyntaxError &&
      "status" in err &&
      err.status === 400 &&
      "body" in err
    ) {
      return res.status(400).json({
        success: false,
        code: "BAD_REQUEST_INVALID_JSON",
        error: "Bad request, malformed JSON",
      });
    }

    const id = res.sentry ?? uuidv7();

    logger.error(
      "Error occurred in request! (" + req.path + ") -- ID " + id + " -- ",
      {
        error: err,
        errorId: id,
        path: req.path,
        teamId: req.acuc?.team_id,
        team_id: req.acuc?.team_id,
      },
    );
    res.status(500).json({
      success: false,
      code: "UNKNOWN_ERROR",
      error: getErrorContactMessage(id),
    });
  },
);

logger.info(`Worker ${process.pid} started`);
