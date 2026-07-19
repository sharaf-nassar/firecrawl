import crypto from "node:crypto";
import type { Storage } from "@google-cloud/storage";
import { config } from "../../config";
import { GcsArtifactStore } from "./gcs";
import { MinioArtifactStore } from "./minio";
import type { ArtifactStore } from "./types";

export * from "./types";

type ArtifactConfigSource = {
  ARTIFACT_STORE_PROVIDER?: "none" | "minio" | "gcs";
  ARTIFACT_MINIO_ENDPOINT?: string;
  ARTIFACT_MINIO_ACCESS_KEY?: string;
  ARTIFACT_MINIO_SECRET_KEY?: string;
  ARTIFACT_MINIO_BUCKET?: string;
  ARTIFACT_MINIO_REGION?: string;
  GCS_BUCKET_NAME?: string;
  GCS_CREDENTIALS?: string;
};

type ArtifactStoreDependencies = { gcsStorage?: Storage };

function selectedProvider(
  source: ArtifactConfigSource,
): "none" | "minio" | "gcs" {
  if (source.ARTIFACT_STORE_PROVIDER !== undefined) {
    return source.ARTIFACT_STORE_PROVIDER;
  }
  return source.GCS_BUCKET_NAME ? "gcs" : "none";
}

export function createArtifactStore(
  source: ArtifactConfigSource,
  dependencies: ArtifactStoreDependencies = {},
): ArtifactStore | null {
  const provider = selectedProvider(source);
  if (provider === "none") return null;
  if (provider === "gcs") {
    return new GcsArtifactStore(
      {
        bucket: source.GCS_BUCKET_NAME ?? "",
        credentials: source.GCS_CREDENTIALS,
      },
      dependencies.gcsStorage,
    );
  }
  return new MinioArtifactStore({
    endpoint: source.ARTIFACT_MINIO_ENDPOINT ?? "",
    accessKey: source.ARTIFACT_MINIO_ACCESS_KEY ?? "",
    secretKey: source.ARTIFACT_MINIO_SECRET_KEY ?? "",
    bucket: source.ARTIFACT_MINIO_BUCKET ?? "",
    region: source.ARTIFACT_MINIO_REGION ?? "us-east-1",
  });
}

export function isArtifactStoreConfigured(
  source: ArtifactConfigSource = runtimeArtifactConfig(),
): boolean {
  return selectedProvider(source) !== "none";
}

function runtimeArtifactConfig(): ArtifactConfigSource {
  return {
    ARTIFACT_STORE_PROVIDER: Object.prototype.hasOwnProperty.call(
      process.env,
      "ARTIFACT_STORE_PROVIDER",
    )
      ? config.ARTIFACT_STORE_PROVIDER
      : undefined,
    ARTIFACT_MINIO_ENDPOINT: config.ARTIFACT_MINIO_ENDPOINT,
    ARTIFACT_MINIO_ACCESS_KEY: config.ARTIFACT_MINIO_ACCESS_KEY,
    ARTIFACT_MINIO_SECRET_KEY: config.ARTIFACT_MINIO_SECRET_KEY,
    ARTIFACT_MINIO_BUCKET: config.ARTIFACT_MINIO_BUCKET,
    ARTIFACT_MINIO_REGION: config.ARTIFACT_MINIO_REGION,
    GCS_BUCKET_NAME: config.GCS_BUCKET_NAME,
    GCS_CREDENTIALS: config.GCS_CREDENTIALS,
  };
}

let runtimeStore: ArtifactStore | null | undefined;

export function getArtifactStore(): ArtifactStore | null {
  if (runtimeStore === undefined) {
    runtimeStore = createArtifactStore(runtimeArtifactConfig());
  }
  return runtimeStore;
}

export function jobArtifactKey(id: string): string {
  if (
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
      id,
    )
  ) {
    const timestamp = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    if (timestamp >= Date.UTC(2026, 4, 26)) {
      return `${crypto.createHash("sha256").update(id).digest("hex")}-${id}.json`;
    }
  }
  return `${id}.json`;
}
