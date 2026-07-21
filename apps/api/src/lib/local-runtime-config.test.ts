import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BrowserStateFilesystem } from "./browser-state/filesystem-store";
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

  it("defaults the browser service off without validating its state root", () => {
    expect(
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        LOCAL_BROWSER_STATE_ROOT: "relative/browser-state",
      }),
    ).toMatchObject({ enabled: true });
  });

  it("requires local persistence when the browser service is enabled", () => {
    expect(() =>
      resolveLocalRuntimeConfig({
        LOCAL_BROWSER_SERVICE_ENABLED: true,
        LOCAL_BROWSER_STATE_ROOT: "/var/lib/firecrawl-browser",
      }),
    ).toThrowError(/LOCAL_PERSISTENCE_ENABLED/);
  });

  it.each(["relative/browser-state", "/"])(
    "rejects browser state root %s when the browser service is enabled",
    browserStateRoot => {
      expect(() =>
        resolveLocalRuntimeConfig({
          ...validLocalSettings,
          LOCAL_BROWSER_SERVICE_ENABLED: true,
          LOCAL_BROWSER_STATE_ROOT: browserStateRoot,
        }),
      ).toThrowError(/LOCAL_BROWSER_STATE_ROOT/);
    },
  );

  it("accepts an absolute non-root browser state root when enabled", () => {
    expect(
      resolveLocalRuntimeConfig({
        ...validLocalSettings,
        LOCAL_BROWSER_SERVICE_ENABLED: true,
        LOCAL_BROWSER_STATE_ROOT: "/var/lib/firecrawl-browser",
      }),
    ).toMatchObject({ enabled: true });
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

describe("BrowserStateFilesystem.health", () => {
  it("creates, fsyncs, and removes a private probe below the state root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "browser-state-health-"));
    const root = path.join(parent, "state");

    try {
      await BrowserStateFilesystem.health(root);

      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reports an unavailable state root with a stable category", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "browser-state-health-"));
    const root = path.join(parent, "state");
    await writeFile(root, "not a directory", { mode: 0o600 });
    await chmod(parent, 0o700);

    try {
      await expect(BrowserStateFilesystem.health(root)).rejects.toMatchObject({
        category: "browser_state_unavailable",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
