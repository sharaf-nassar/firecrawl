import { Storage } from "@google-cloud/storage";
import type { ArtifactStore, PutArtifactInput, StoredArtifact } from "./types";
import { ArtifactStoreError, normalizeArtifactMetadata } from "./types";

interface GcsArtifactConfig {
  bucket: string;
  credentials?: string;
}

function getCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? String(code)
    : undefined;
}

function credentialsFromBase64(
  encoded: string | undefined,
): object | undefined {
  if (!encoded) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new ArtifactStoreError("gcs", "configure", "invalid_credentials");
  }
}

export class GcsArtifactStore implements ArtifactStore {
  readonly provider = "gcs" as const;
  private readonly storage: Storage;

  constructor(
    private readonly config: GcsArtifactConfig,
    storage?: Storage,
  ) {
    if (!config.bucket) {
      throw new ArtifactStoreError("gcs", "configure", "missing_bucket");
    }
    this.storage =
      storage ??
      new Storage({
        credentials: credentialsFromBase64(config.credentials),
        retryOptions: { autoRetry: true, maxRetries: 2 },
      });
  }

  async put(input: PutArtifactInput): Promise<StoredArtifact> {
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : Buffer.from(input.body);
    const metadata = normalizeArtifactMetadata(input.metadata);
    try {
      await this.storage
        .bucket(this.config.bucket)
        .file(input.key)
        .save(body, {
          resumable: body.byteLength > 3 * 1024 * 1024,
          metadata: { contentType: input.contentType, metadata },
        });
      return {
        key: input.key,
        contentType: input.contentType,
        byteSize: body.byteLength,
        metadata,
      };
    } catch (error) {
      throw new ArtifactStoreError("gcs", "put", getCode(error));
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const [contents] = await this.storage
        .bucket(this.config.bucket)
        .file(key)
        .download();
      return contents;
    } catch (error) {
      if (getCode(error) === "404") return null;
      throw new ArtifactStoreError("gcs", "get", getCode(error));
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.storage.bucket(this.config.bucket).file(key).delete({
        ignoreNotFound: true,
      });
    } catch (error) {
      if (getCode(error) === "404") return;
      throw new ArtifactStoreError("gcs", "delete", getCode(error));
    }
  }

  async health(): Promise<void> {
    try {
      const [exists] = await this.storage.bucket(this.config.bucket).exists();
      if (!exists) {
        throw new ArtifactStoreError("gcs", "health", "bucket_not_found");
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("gcs", "health", getCode(error));
    }
  }
}
