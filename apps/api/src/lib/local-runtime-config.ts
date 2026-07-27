import path from "node:path";

import { z } from "zod";

import {
  canonicalUuidSchema,
  httpUrlSchema,
} from "./scrape-interact/browser-service-contracts";

export type LocalRuntimeConfigSource = {
  LOCAL_PERSISTENCE_ENABLED?: boolean;
  LOCAL_BROWSER_SERVICE_ENABLED?: boolean;
  LOCAL_BROWSER_STATE_ROOT?: string;
  BROWSER_SERVICE_URL?: string;
  BROWSER_SERVICE_API_KEY?: string;
  BROWSER_REPLAY_INGEST_URL?: string;
  BROWSER_REPLAY_INGEST_API_KEY?: string;
  BROWSER_SERVICE_REQUEST_TIMEOUT_MS?: number | string;
  BROWSER_RECONCILIATION_TIMEOUT_MS?: number | string;
  BROWSER_RECONCILIATION_MAX_ATTEMPTS?: number | string;
  BROWSER_RECONCILIATION_INITIAL_BACKOFF_MS?: number | string;
  BROWSER_RECONCILIATION_MAX_BACKOFF_MS?: number | string;
  BROWSER_RECONCILIATION_STARTUP_BUDGET_MS?: number | string;
  BROWSER_RECONCILIATION_MONITOR_INTERVAL_MS?: number | string;
  BROWSER_RECONCILIATION_RETRY_COOLDOWN_MS?: number | string;
  BROWSER_ADAPTER_TOKEN_FILE?: string;
  APPLICATION_DATABASE_URL?: string;
  LOCAL_OWNER_ID?: string;
  ARTIFACT_STORE_PROVIDER?: "none" | "minio" | "gcs";
  ARTIFACT_MINIO_ENDPOINT?: string;
  ARTIFACT_MINIO_ACCESS_KEY?: string;
  ARTIFACT_MINIO_SECRET_KEY?: string;
  ARTIFACT_MINIO_BUCKET?: string;
  ARTIFACT_MINIO_REGION?: string;
  GCS_BUCKET_NAME?: string;
  GCS_CREDENTIALS?: string;
  LOCAL_RECORD_RETENTION_DAYS?: number;
  LOCAL_ARTIFACT_RETENTION_DAYS?: number;
  USE_DB_AUTHENTICATION?: boolean;
};

type EnabledLocalRuntimeConfig = {
  enabled: true;
  applicationDatabaseUrl: string;
  ownerId: string;
  recordRetentionDays: number;
  artifactRetentionDays: number;
};

type EnabledBrowserServiceRuntimeConfig = {
  browserServiceEnabled: true;
  browserStateRoot: string;
  browserServiceUrl: string;
  browserServiceApiKey: string;
  browserReplayIngestUrl: string;
  browserReplayIngestApiKey: string;
  browserServiceRequestTimeoutMs: number;
  browserReconciliationTimeoutMs: number;
  browserReconciliationMaxAttempts: number;
  browserReconciliationInitialBackoffMs: number;
  browserReconciliationMaxBackoffMs: number;
  browserReconciliationStartupBudgetMs: number;
  browserReconciliationMonitorIntervalMs: number;
  browserReconciliationRetryCooldownMs: number;
  browserAdapterTokenFile?: string;
};

type BrowserServiceRuntimeConfig =
  | { browserServiceEnabled?: false }
  | EnabledBrowserServiceRuntimeConfig;

type LocalRuntimeConfig =
  | { enabled: false }
  | (EnabledLocalRuntimeConfig &
      BrowserServiceRuntimeConfig & { artifactProvider: "none" })
  | (EnabledLocalRuntimeConfig &
      BrowserServiceRuntimeConfig & {
        artifactProvider: "minio";
        minioEndpoint: string;
        minioAccessKey: string;
        minioSecretKey: string;
        minioBucket: string;
        minioRegion: string;
      })
  | (EnabledLocalRuntimeConfig &
      BrowserServiceRuntimeConfig & {
        artifactProvider: "gcs";
        gcsBucketName: string;
        gcsCredentials?: string;
      });

export class LocalRuntimeConfigurationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid local runtime configuration:\n${issues
        .map(issue => `- ${issue}`)
        .join("\n")}`,
    );
    this.name = "LocalRuntimeConfigurationError";
  }
}

const databaseUrlSchema = z.string().superRefine((value, context) => {
  try {
    new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "absolute URL required" });
  }
});
const ownerIdSchema = canonicalUuidSchema;
const endpointUrlSchema = httpUrlSchema;

function boundedInteger(
  source: number | string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
  issues: string[],
): number {
  const value =
    source === undefined ||
    (typeof source === "string" && source.trim().length === 0)
      ? fallback
      : typeof source === "number"
        ? source
        : Number(source);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isPrivateBrowserServiceUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || !host.includes(".")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  const octets = host.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every(
      octet => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    ) &&
    (octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))
  );
}

export function resolveLocalRuntimeConfig(
  source: LocalRuntimeConfigSource,
): LocalRuntimeConfig {
  const browserServiceEnabled = source.LOCAL_BROWSER_SERVICE_ENABLED === true;
  const browserStateRoot =
    source.LOCAL_BROWSER_STATE_ROOT ?? "/var/lib/firecrawl-browser";

  if (browserServiceEnabled && source.LOCAL_PERSISTENCE_ENABLED !== true) {
    throw new LocalRuntimeConfigurationError([
      "LOCAL_PERSISTENCE_ENABLED must be true when LOCAL_BROWSER_SERVICE_ENABLED=true",
    ]);
  }

  if (source.LOCAL_PERSISTENCE_ENABLED !== true) {
    return { enabled: false };
  }

  const issues: string[] = [];
  const applicationDatabaseUrl = source.APPLICATION_DATABASE_URL;
  const ownerId = source.LOCAL_OWNER_ID;
  const recordRetentionDays = source.LOCAL_RECORD_RETENTION_DAYS ?? 30;
  const artifactRetentionDays = source.LOCAL_ARTIFACT_RETENTION_DAYS ?? 30;
  const artifactProvider = source.ARTIFACT_STORE_PROVIDER ?? "none";
  const browserServiceRequestTimeoutMs = boundedInteger(
    source.BROWSER_SERVICE_REQUEST_TIMEOUT_MS,
    30_000,
    100,
    60_000,
    "BROWSER_SERVICE_REQUEST_TIMEOUT_MS",
    issues,
  );
  const browserReconciliationTimeoutMs = boundedInteger(
    source.BROWSER_RECONCILIATION_TIMEOUT_MS,
    60_000,
    5_000,
    60_000,
    "BROWSER_RECONCILIATION_TIMEOUT_MS",
    issues,
  );
  const browserReconciliationMaxAttempts = boundedInteger(
    source.BROWSER_RECONCILIATION_MAX_ATTEMPTS,
    4,
    1,
    8,
    "BROWSER_RECONCILIATION_MAX_ATTEMPTS",
    issues,
  );
  const browserReconciliationInitialBackoffMs = boundedInteger(
    source.BROWSER_RECONCILIATION_INITIAL_BACKOFF_MS,
    250,
    100,
    5_000,
    "BROWSER_RECONCILIATION_INITIAL_BACKOFF_MS",
    issues,
  );
  const browserReconciliationMaxBackoffMs = boundedInteger(
    source.BROWSER_RECONCILIATION_MAX_BACKOFF_MS,
    2_000,
    100,
    10_000,
    "BROWSER_RECONCILIATION_MAX_BACKOFF_MS",
    issues,
  );
  const browserReconciliationStartupBudgetMs = boundedInteger(
    source.BROWSER_RECONCILIATION_STARTUP_BUDGET_MS,
    60_000,
    5_000,
    60_000,
    "BROWSER_RECONCILIATION_STARTUP_BUDGET_MS",
    issues,
  );
  const browserReconciliationMonitorIntervalMs = boundedInteger(
    source.BROWSER_RECONCILIATION_MONITOR_INTERVAL_MS,
    5_000,
    1_000,
    60_000,
    "BROWSER_RECONCILIATION_MONITOR_INTERVAL_MS",
    issues,
  );
  const browserReconciliationRetryCooldownMs = boundedInteger(
    source.BROWSER_RECONCILIATION_RETRY_COOLDOWN_MS,
    30_000,
    5_000,
    300_000,
    "BROWSER_RECONCILIATION_RETRY_COOLDOWN_MS",
    issues,
  );

  if (
    browserServiceEnabled &&
    (browserStateRoot === "/" ||
      !path.isAbsolute(browserStateRoot) ||
      path.normalize(browserStateRoot) !== browserStateRoot ||
      path.resolve(browserStateRoot) !== browserStateRoot)
  ) {
    issues.push(
      "LOCAL_BROWSER_STATE_ROOT must be a canonical absolute non-root path when LOCAL_BROWSER_SERVICE_ENABLED=true",
    );
  }

  if (browserServiceEnabled) {
    if (
      source.BROWSER_SERVICE_URL === undefined ||
      !isPrivateBrowserServiceUrl(source.BROWSER_SERVICE_URL)
    ) {
      issues.push(
        "BROWSER_SERVICE_URL is required and must be a private HTTP origin when LOCAL_BROWSER_SERVICE_ENABLED=true",
      );
    }
    if (
      source.BROWSER_SERVICE_API_KEY === undefined ||
      Buffer.byteLength(source.BROWSER_SERVICE_API_KEY, "utf8") < 32 ||
      Buffer.byteLength(source.BROWSER_SERVICE_API_KEY, "utf8") > 4_089
    ) {
      issues.push(
        "BROWSER_SERVICE_API_KEY is required and must contain 32..4089 UTF-8 bytes when LOCAL_BROWSER_SERVICE_ENABLED=true",
      );
    }
    if (
      source.BROWSER_REPLAY_INGEST_URL === undefined ||
      !isPrivateBrowserServiceUrl(source.BROWSER_REPLAY_INGEST_URL)
    ) {
      issues.push(
        "BROWSER_REPLAY_INGEST_URL is required and must be a private HTTP origin when LOCAL_BROWSER_SERVICE_ENABLED=true",
      );
    }
    if (
      source.BROWSER_REPLAY_INGEST_API_KEY === undefined ||
      Buffer.byteLength(source.BROWSER_REPLAY_INGEST_API_KEY, "utf8") < 32 ||
      Buffer.byteLength(source.BROWSER_REPLAY_INGEST_API_KEY, "utf8") > 4_089
    ) {
      issues.push(
        "BROWSER_REPLAY_INGEST_API_KEY is required and must contain 32..4089 UTF-8 bytes when LOCAL_BROWSER_SERVICE_ENABLED=true",
      );
    }
    if (
      source.BROWSER_REPLAY_INGEST_API_KEY !== undefined &&
      source.BROWSER_REPLAY_INGEST_API_KEY === source.BROWSER_SERVICE_API_KEY
    ) {
      issues.push(
        "BROWSER_REPLAY_INGEST_API_KEY must differ from BROWSER_SERVICE_API_KEY",
      );
    }
    if (
      source.BROWSER_ADAPTER_TOKEN_FILE !== undefined &&
      !path.isAbsolute(source.BROWSER_ADAPTER_TOKEN_FILE)
    ) {
      issues.push("BROWSER_ADAPTER_TOKEN_FILE must be absolute");
    }
    if (
      browserReconciliationMaxBackoffMs < browserReconciliationInitialBackoffMs
    ) {
      issues.push(
        "BROWSER_RECONCILIATION_MAX_BACKOFF_MS must be greater than or equal to BROWSER_RECONCILIATION_INITIAL_BACKOFF_MS",
      );
    }
  }

  if (!applicationDatabaseUrl) {
    issues.push(
      "APPLICATION_DATABASE_URL is required when LOCAL_PERSISTENCE_ENABLED=true",
    );
  } else if (!databaseUrlSchema.safeParse(applicationDatabaseUrl).success) {
    issues.push("APPLICATION_DATABASE_URL must be a valid URL");
  }

  if (!ownerId) {
    issues.push(
      "LOCAL_OWNER_ID is required when LOCAL_PERSISTENCE_ENABLED=true",
    );
  } else if (!ownerIdSchema.safeParse(ownerId).success) {
    issues.push("LOCAL_OWNER_ID must be a valid UUID");
  }

  if (source.USE_DB_AUTHENTICATION === true) {
    issues.push(
      "USE_DB_AUTHENTICATION must be false when LOCAL_PERSISTENCE_ENABLED=true",
    );
  }

  if (!Number.isInteger(recordRetentionDays) || recordRetentionDays <= 0) {
    issues.push("LOCAL_RECORD_RETENTION_DAYS must be a positive integer");
  }

  if (!Number.isInteger(artifactRetentionDays) || artifactRetentionDays <= 0) {
    issues.push("LOCAL_ARTIFACT_RETENTION_DAYS must be a positive integer");
  }

  if (artifactProvider === "minio") {
    if (!source.ARTIFACT_MINIO_ENDPOINT) {
      issues.push(
        "ARTIFACT_MINIO_ENDPOINT is required when ARTIFACT_STORE_PROVIDER=minio",
      );
    } else if (
      !endpointUrlSchema.safeParse(source.ARTIFACT_MINIO_ENDPOINT).success
    ) {
      issues.push("ARTIFACT_MINIO_ENDPOINT must be a valid URL");
    }

    if (!source.ARTIFACT_MINIO_ACCESS_KEY) {
      issues.push(
        "ARTIFACT_MINIO_ACCESS_KEY is required when ARTIFACT_STORE_PROVIDER=minio",
      );
    }
    if (!source.ARTIFACT_MINIO_SECRET_KEY) {
      issues.push(
        "ARTIFACT_MINIO_SECRET_KEY is required when ARTIFACT_STORE_PROVIDER=minio",
      );
    }
    if (!source.ARTIFACT_MINIO_BUCKET) {
      issues.push(
        "ARTIFACT_MINIO_BUCKET is required when ARTIFACT_STORE_PROVIDER=minio",
      );
    }
  } else if (artifactProvider === "gcs" && !source.GCS_BUCKET_NAME) {
    issues.push("GCS_BUCKET_NAME is required when ARTIFACT_STORE_PROVIDER=gcs");
  }

  if (issues.length > 0) {
    throw new LocalRuntimeConfigurationError(issues);
  }

  const browserServiceConfig: BrowserServiceRuntimeConfig =
    browserServiceEnabled
      ? {
          browserServiceEnabled: true,
          browserStateRoot,
          browserServiceUrl: source.BROWSER_SERVICE_URL!,
          browserServiceApiKey: source.BROWSER_SERVICE_API_KEY!,
          browserReplayIngestUrl: source.BROWSER_REPLAY_INGEST_URL!,
          browserReplayIngestApiKey: source.BROWSER_REPLAY_INGEST_API_KEY!,
          browserServiceRequestTimeoutMs,
          browserReconciliationTimeoutMs,
          browserReconciliationMaxAttempts,
          browserReconciliationInitialBackoffMs,
          browserReconciliationMaxBackoffMs,
          browserReconciliationStartupBudgetMs,
          browserReconciliationMonitorIntervalMs,
          browserReconciliationRetryCooldownMs,
          browserAdapterTokenFile: source.BROWSER_ADAPTER_TOKEN_FILE,
        }
      : {};
  const common = {
    enabled: true as const,
    applicationDatabaseUrl: applicationDatabaseUrl!,
    ownerId: ownerId!,
    recordRetentionDays,
    artifactRetentionDays,
    ...browserServiceConfig,
  };

  if (artifactProvider === "minio") {
    return {
      ...common,
      artifactProvider,
      minioEndpoint: source.ARTIFACT_MINIO_ENDPOINT!,
      minioAccessKey: source.ARTIFACT_MINIO_ACCESS_KEY!,
      minioSecretKey: source.ARTIFACT_MINIO_SECRET_KEY!,
      minioBucket: source.ARTIFACT_MINIO_BUCKET!,
      minioRegion: source.ARTIFACT_MINIO_REGION ?? "us-east-1",
    };
  }

  if (artifactProvider === "gcs") {
    return {
      ...common,
      artifactProvider,
      gcsBucketName: source.GCS_BUCKET_NAME!,
      gcsCredentials: source.GCS_CREDENTIALS,
    };
  }

  return { ...common, artifactProvider: "none" };
}
