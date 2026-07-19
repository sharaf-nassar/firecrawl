import { Client } from "minio";
import type {
  ArtifactOperation,
  ArtifactStore,
  PutArtifactInput,
  StoredArtifact,
} from "./types";
import { ArtifactStoreError, normalizeArtifactMetadata } from "./types";

interface MinioArtifactConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

type MinioClient = Pick<
  Client,
  "putObject" | "getObject" | "removeObject" | "bucketExists"
>;

function errorDetails(error: unknown): {
  code?: string;
  statusCode?: number;
} {
  if (!error || typeof error !== "object") return {};
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
  };
  return {
    code:
      typeof candidate.code === "string"
        ? candidate.code
        : typeof candidate.code === "number"
          ? String(candidate.code)
          : undefined,
    statusCode:
      typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : typeof candidate.status === "number"
          ? candidate.status
          : undefined,
  };
}

function isTransient(error: unknown): boolean {
  const { code, statusCode } = errorDetails(error);
  return (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ENETDOWN",
      "ENETUNREACH",
      "ETIMEDOUT",
      "InternalError",
      "InternalServerError",
      "RequestTimeout",
      "SlowDown",
      "ServiceUnavailable",
    ].includes(code ?? "") ||
    statusCode === 408 ||
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500)
  );
}

function parseEndpoint(endpoint: string): {
  endPoint: string;
  port: number;
  useSSL: boolean;
} {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ArtifactStoreError("minio", "configure", "invalid_endpoint");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    (url.port !== "" && Number(url.port) === 0)
  ) {
    throw new ArtifactStoreError("minio", "configure", "invalid_endpoint");
  }
  return {
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
  };
}

function createMinioClient(config: MinioArtifactConfig): Client {
  if (
    !config.accessKey ||
    !config.secretKey ||
    !config.bucket ||
    !config.region
  ) {
    throw new ArtifactStoreError("minio", "configure", "missing_configuration");
  }
  const endpoint = parseEndpoint(config.endpoint);
  try {
    return new Client({
      ...endpoint,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
      retryOptions: { disableRetry: true },
    });
  } catch {
    throw new ArtifactStoreError("minio", "configure", "invalid_configuration");
  }
}

export class MinioArtifactStore implements ArtifactStore {
  readonly provider = "minio" as const;
  private readonly client: MinioClient;

  constructor(
    private readonly config: MinioArtifactConfig,
    client?: MinioClient,
    private readonly options: { retryDelayMs?: number } = {},
  ) {
    this.client = client ?? createMinioClient(config);
  }

  private async run<T>(
    operation: ArtifactOperation,
    action: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (attempt === 3 || !isTransient(error)) {
          const { code, statusCode } = errorDetails(error);
          throw new ArtifactStoreError(
            "minio",
            operation,
            code ?? (statusCode === undefined ? undefined : String(statusCode)),
          );
        }
        const delay = this.options.retryDelayMs ?? 100 * 2 ** (attempt - 1);
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw new ArtifactStoreError("minio", operation, "retry_exhausted");
  }

  async put(input: PutArtifactInput): Promise<StoredArtifact> {
    if (!input.key || !input.contentType) {
      throw new ArtifactStoreError("minio", "put", "invalid_input");
    }
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : Buffer.from(input.body);
    const metadata = normalizeArtifactMetadata(input.metadata);
    await this.run("put", () =>
      this.client.putObject(
        this.config.bucket,
        input.key,
        body,
        body.byteLength,
        {
          "Content-Type": input.contentType,
          ...Object.fromEntries(
            Object.entries(metadata).map(([key, value]) => [
              `x-amz-meta-${key}`,
              value,
            ]),
          ),
        },
      ),
    );
    return {
      key: input.key,
      contentType: input.contentType,
      byteSize: body.byteLength,
      metadata,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    if (!key) throw new ArtifactStoreError("minio", "get", "invalid_input");
    try {
      return await this.run("get", async () => {
        const stream = await this.client.getObject(this.config.bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      });
    } catch (error) {
      if (
        error instanceof ArtifactStoreError &&
        isMissingCode(error.errorCode)
      ) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    if (!key) {
      throw new ArtifactStoreError("minio", "delete", "invalid_input");
    }
    try {
      await this.run("delete", () =>
        this.client.removeObject(this.config.bucket, key),
      );
    } catch (error) {
      if (
        error instanceof ArtifactStoreError &&
        isMissingCode(error.errorCode)
      ) {
        return;
      }
      throw error;
    }
  }

  async health(): Promise<void> {
    const exists = await this.run("health", () =>
      this.client.bucketExists(this.config.bucket),
    );
    if (!exists) {
      throw new ArtifactStoreError("minio", "health", "bucket_not_found");
    }
  }
}

function isMissingCode(code: string | undefined): boolean {
  return ["404", "NoSuchKey", "NoSuchObject", "NotFound"].includes(code ?? "");
}
