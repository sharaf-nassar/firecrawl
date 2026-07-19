import { describe, expect, it } from "vitest";

import {
  LocalRuntimeConfigurationError,
  resolveLocalRuntimeConfig,
  type LocalRuntimeConfigSource,
} from "./local-runtime-config";

const validLocalSettings: LocalRuntimeConfigSource = {
  LOCAL_PERSISTENCE_ENABLED: true,
  APPLICATION_DATABASE_URL:
    "postgresql://firecrawl:password@localhost:5432/firecrawl",
  LOCAL_OWNER_ID: "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
  ARTIFACT_STORE_PROVIDER: "none",
  LOCAL_RECORD_RETENTION_DAYS: 30,
  LOCAL_ARTIFACT_RETENTION_DAYS: 30,
  USE_DB_AUTHENTICATION: false,
};

describe("resolveLocalRuntimeConfig", () => {
  it("leaves persistence disabled without local settings", () => {
    expect(resolveLocalRuntimeConfig({})).toEqual({ enabled: false });
  });

  it("requires an application database URL when enabled", () => {
    expect(() =>
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        APPLICATION_DATABASE_URL: undefined,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "LocalRuntimeConfigurationError",
        message: expect.stringContaining("APPLICATION_DATABASE_URL"),
      }),
    );
  });

  it("requires a UUID local owner when enabled", () => {
    expect(() =>
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        LOCAL_OWNER_ID: "not-a-uuid",
      }),
    ).toThrowError(LocalRuntimeConfigurationError);

    expect(() =>
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        LOCAL_OWNER_ID: "not-a-uuid",
      }),
    ).toThrowError(/LOCAL_OWNER_ID/);
  });

  it("rejects local persistence with database authentication", () => {
    expect(() =>
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        USE_DB_AUTHENTICATION: true,
      }),
    ).toThrowError(/USE_DB_AUTHENTICATION/);
  });

  it("requires every MinIO setting when provider is minio", () => {
    let error: unknown;

    try {
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        ARTIFACT_STORE_PROVIDER: "minio",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(LocalRuntimeConfigurationError);
    expect(error).toMatchObject({
      issues: [
        expect.stringContaining("ARTIFACT_MINIO_ENDPOINT"),
        expect.stringContaining("ARTIFACT_MINIO_ACCESS_KEY"),
        expect.stringContaining("ARTIFACT_MINIO_SECRET_KEY"),
        expect.stringContaining("ARTIFACT_MINIO_BUCKET"),
      ],
    });
  });

  it("accepts complete MinIO configuration", () => {
    expect(
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        ARTIFACT_STORE_PROVIDER: "minio",
        ARTIFACT_MINIO_ENDPOINT: "http://minio:9000",
        ARTIFACT_MINIO_ACCESS_KEY: "firecrawl-app",
        ARTIFACT_MINIO_SECRET_KEY: "secret",
        ARTIFACT_MINIO_BUCKET: "firecrawl-artifacts",
        ARTIFACT_MINIO_REGION: "us-east-1",
      }),
    ).toMatchObject({
      enabled: true,
      artifactProvider: "minio",
      minioEndpoint: "http://minio:9000",
      minioAccessKey: "firecrawl-app",
      minioSecretKey: "secret",
      minioBucket: "firecrawl-artifacts",
      minioRegion: "us-east-1",
    });
  });

  it("requires a GCS bucket when provider is gcs", () => {
    expect(() =>
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        ARTIFACT_STORE_PROVIDER: "gcs",
      }),
    ).toThrowError(/GCS_BUCKET_NAME/);
  });

  it("accepts GCS application default credentials", () => {
    expect(
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        ARTIFACT_STORE_PROVIDER: "gcs",
        GCS_BUCKET_NAME: "firecrawl-artifacts",
      }),
    ).toMatchObject({
      enabled: true,
      artifactProvider: "gcs",
      gcsBucketName: "firecrawl-artifacts",
      gcsCredentials: undefined,
    });
  });

  it("accepts positive record and artifact retention days", () => {
    expect(
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        LOCAL_RECORD_RETENTION_DAYS: 7,
        LOCAL_ARTIFACT_RETENTION_DAYS: 14,
      }),
    ).toEqual({
      enabled: true,
      applicationDatabaseUrl:
        "postgresql://firecrawl:password@localhost:5432/firecrawl",
      ownerId: "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
      recordRetentionDays: 7,
      artifactRetentionDays: 14,
      artifactProvider: "none",
    });
  });
});
