import { z } from "zod";

export type LocalRuntimeConfigSource = {
  LOCAL_PERSISTENCE_ENABLED?: boolean;
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

type LocalRuntimeConfig =
  | { enabled: false }
  | (EnabledLocalRuntimeConfig & { artifactProvider: "none" })
  | (EnabledLocalRuntimeConfig & {
      artifactProvider: "minio";
      minioEndpoint: string;
      minioAccessKey: string;
      minioSecretKey: string;
      minioBucket: string;
      minioRegion: string;
    })
  | (EnabledLocalRuntimeConfig & {
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

const databaseUrlSchema = z.string().url();
const ownerIdSchema = z.string().uuid();
const endpointUrlSchema = z.string().url();

export function resolveLocalRuntimeConfig(
  source: LocalRuntimeConfigSource,
): LocalRuntimeConfig {
  if (source.LOCAL_PERSISTENCE_ENABLED !== true) {
    return { enabled: false };
  }

  const issues: string[] = [];
  const applicationDatabaseUrl = source.APPLICATION_DATABASE_URL;
  const ownerId = source.LOCAL_OWNER_ID;
  const recordRetentionDays = source.LOCAL_RECORD_RETENTION_DAYS ?? 30;
  const artifactRetentionDays = source.LOCAL_ARTIFACT_RETENTION_DAYS ?? 30;
  const artifactProvider = source.ARTIFACT_STORE_PROVIDER ?? "none";

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

  const common = {
    enabled: true as const,
    applicationDatabaseUrl: applicationDatabaseUrl!,
    ownerId: ownerId!,
    recordRetentionDays,
    artifactRetentionDays,
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
