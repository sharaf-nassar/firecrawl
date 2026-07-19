import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { cleanupLog } = vi.hoisted(() => ({ cleanupLog: vi.fn() }));

vi.mock("../logger", () => ({ logger: { error: cleanupLog } }));

import {
  ArtifactStoreError,
  createArtifactStore,
  isArtifactStoreConfigured,
  jobArtifactKey,
} from ".";
import {
  createMinioDeleteDeadlineTransport,
  MinioArtifactStore,
} from "./minio";
import { putArtifactWithManifest } from "./manifest";

const minioConfig = {
  ARTIFACT_STORE_PROVIDER: "minio" as const,
  ARTIFACT_MINIO_ENDPOINT: "http://minio:9000",
  ARTIFACT_MINIO_ACCESS_KEY: "firecrawl-artifacts",
  ARTIFACT_MINIO_SECRET_KEY: "secret-value-that-must-not-leak",
  ARTIFACT_MINIO_BUCKET: "firecrawl-artifacts",
  ARTIFACT_MINIO_REGION: "us-east-1",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact provider selection", () => {
  it("keeps explicit none disabled even when legacy GCS is configured", () => {
    expect(
      createArtifactStore({
        ARTIFACT_STORE_PROVIDER: "none",
        GCS_BUCKET_NAME: "legacy-bucket",
      }),
    ).toBeNull();
  });

  it("selects GCS for legacy hosted configuration when provider is unset", () => {
    const store = createArtifactStore({ GCS_BUCKET_NAME: "legacy-bucket" });
    expect(store?.provider).toBe("gcs");
  });

  it("reports configuration from the selected provider", () => {
    expect(isArtifactStoreConfigured(minioConfig)).toBe(true);
    expect(isArtifactStoreConfigured({ ARTIFACT_STORE_PROVIDER: "none" })).toBe(
      false,
    );
  });

  it("rejects invalid MinIO URLs before constructing a client", () => {
    expect(() =>
      createArtifactStore({
        ...minioConfig,
        ARTIFACT_MINIO_ENDPOINT: "http://user:password@minio:9000/path",
      }),
    ).toThrowError(ArtifactStoreError);
    expect(() =>
      createArtifactStore({
        ...minioConfig,
        ARTIFACT_MINIO_ENDPOINT: "http://minio:0",
      }),
    ).toThrowError(ArtifactStoreError);
  });

  it.each(["http://[::1]:9000", "http://-bad:9000"])(
    "normalizes SDK endpoint validation for %s",
    endpoint => {
      let failure: unknown;
      try {
        createArtifactStore({
          ...minioConfig,
          ARTIFACT_MINIO_ENDPOINT: endpoint,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ArtifactStoreError);
      expect(failure).toMatchObject({
        provider: "minio",
        operation: "configure",
      });
      expect(String(failure)).not.toContain(
        minioConfig.ARTIFACT_MINIO_SECRET_KEY,
      );
    },
  );
});

describe("GCS compatibility adapter", () => {
  function makeStorage() {
    const file = {
      save: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue([Buffer.from("stored")]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const bucket = {
      file: vi.fn(() => file),
      exists: vi.fn().mockResolvedValue([true]),
    };
    return { storage: { bucket: vi.fn(() => bucket) }, bucket, file };
  }

  it("preserves GCS upload and download metadata behavior", async () => {
    const { storage, file } = makeStorage();
    const store = createArtifactStore(
      { GCS_BUCKET_NAME: "legacy-bucket" },
      { gcsStorage: storage as any },
    )!;

    await store.put({
      key: "result.json",
      body: "stored",
      contentType: "application/json",
      metadata: { job_id: "job" },
    });
    expect(file.save).toHaveBeenCalledWith(Buffer.from("stored"), {
      resumable: false,
      metadata: {
        contentType: "application/json",
        metadata: { job_id: "job" },
      },
    });
    await expect(store.get("result.json")).resolves.toEqual(
      Buffer.from("stored"),
    );
    await expect(store.health()).resolves.toBeUndefined();
  });

  it("keeps missing reads and deletes idempotent", async () => {
    const { storage, file } = makeStorage();
    file.download.mockRejectedValue({ code: 404 });
    file.delete.mockRejectedValue({ code: 404 });
    const store = createArtifactStore(
      { ARTIFACT_STORE_PROVIDER: "gcs", GCS_BUCKET_NAME: "legacy-bucket" },
      { gcsStorage: storage as any },
    )!;

    await expect(store.get("missing")).resolves.toBeNull();
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });
});

describe("artifact keys", () => {
  it("preserves deterministic legacy and post-cutover job keys", () => {
    const legacyId = "019e6f45-7778-627d-adf0-0abe9d5062b6";
    const modernId = "019e6f45-7778-727d-adf0-0abe9d5062b6";
    expect(jobArtifactKey(legacyId)).toBe(`${legacyId}.json`);
    expect(jobArtifactKey(modernId)).toMatch(
      new RegExp(`^[0-9a-f]{64}-${modernId}\\.json$`),
    );
    expect(jobArtifactKey(modernId)).toBe(jobArtifactKey(modernId));
  });
});

describe("MinIO artifact contract", () => {
  function makeClient() {
    return {
      putObject: vi.fn().mockResolvedValue({ etag: "etag", versionId: null }),
      getObject: vi.fn(),
      removeObject: vi.fn().mockResolvedValue(undefined),
      bucketExists: vi.fn().mockResolvedValue(true),
    };
  }

  it("writes content type and normalized metadata", async () => {
    const client = makeClient();
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
    );
    const body = Buffer.from("payload");

    await expect(
      store.put({
        key: "jobs/result.json",
        body,
        contentType: "application/json",
        metadata: { job_id: "abc", nullable: null, count: 2 },
      }),
    ).resolves.toEqual({
      key: "jobs/result.json",
      contentType: "application/json",
      byteSize: body.byteLength,
      metadata: { job_id: "abc", count: "2" },
    });
    expect(client.putObject).toHaveBeenCalledWith(
      "firecrawl-artifacts",
      "jobs/result.json",
      body,
      body.byteLength,
      {
        "Content-Type": "application/json",
        "x-amz-meta-job_id": "abc",
        "x-amz-meta-count": "2",
      },
    );
  });

  it("returns null for missing objects and makes delete idempotent", async () => {
    const client = makeClient();
    client.getObject.mockRejectedValue({ code: "NoSuchKey", statusCode: 404 });
    client.removeObject.mockRejectedValue({
      code: "NoSuchKey",
      statusCode: 404,
    });
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
    );

    await expect(store.get("missing")).resolves.toBeNull();
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });

  it("reads streams into buffers", async () => {
    const client = makeClient();
    client.getObject.mockResolvedValue(Readable.from(["one", "two"]));
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
    );
    await expect(store.get("found")).resolves.toEqual(Buffer.from("onetwo"));
  });

  it("retries a transient stream failure with a fresh stream", async () => {
    const client = makeClient();
    const first = new Readable({
      read() {
        this.destroy(
          Object.assign(new Error("read interrupted"), { code: "ECONNRESET" }),
        );
      },
    });
    client.getObject
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(Readable.from(["recovered"]));
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
      { retryDelayMs: 0 },
    );

    await expect(store.get("result")).resolves.toEqual(
      Buffer.from("recovered"),
    );
    expect(client.getObject).toHaveBeenCalledTimes(2);
  });

  it("types terminal transient stream failures after three attempts", async () => {
    const client = makeClient();
    client.getObject.mockImplementation(async () =>
      Readable.from(
        (async function* () {
          throw Object.assign(new Error("secret-value-that-must-not-leak"), {
            code: "ECONNRESET",
          });
        })(),
      ),
    );
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret-value-that-must-not-leak",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
      { retryDelayMs: 0 },
    );

    const failure = await store.get("result").catch(error => error);
    expect(failure).toBeInstanceOf(ArtifactStoreError);
    expect(failure).toMatchObject({
      provider: "minio",
      operation: "get",
      errorCode: "ECONNRESET",
    });
    expect(String(failure)).not.toContain("secret-value-that-must-not-leak");
    expect(client.getObject).toHaveBeenCalledTimes(3);
  });

  it("does not retry nontransient stream validation failures", async () => {
    const client = makeClient();
    client.getObject.mockResolvedValue(
      Readable.from(
        (async function* () {
          throw Object.assign(new Error("invalid stream"), {
            code: "InvalidArgument",
          });
        })(),
      ),
    );
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
      { retryDelayMs: 0 },
    );

    await expect(store.get("result")).rejects.toMatchObject({
      provider: "minio",
      operation: "get",
      errorCode: "InvalidArgument",
    });
    expect(client.getObject).toHaveBeenCalledTimes(1);
  });

  it("retries transient infrastructure errors at most three attempts", async () => {
    const client = makeClient();
    client.bucketExists
      .mockRejectedValueOnce(
        Object.assign(new Error("down"), { code: "ECONNRESET" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("down"), { code: "ECONNRESET" }),
      )
      .mockResolvedValueOnce(true);
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
      { retryDelayMs: 0 },
    );

    await expect(store.health()).resolves.toBeUndefined();
    expect(client.bucketExists).toHaveBeenCalledTimes(3);
  });

  it("retries transient S3 server errors", async () => {
    const client = makeClient();
    client.bucketExists
      .mockRejectedValueOnce(
        Object.assign(new Error("server failure"), { code: "InternalError" }),
      )
      .mockResolvedValueOnce(true);
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
      { retryDelayMs: 0 },
    );

    await expect(store.health()).resolves.toBeUndefined();
    expect(client.bucketExists).toHaveBeenCalledTimes(2);
  });

  it("does not retry validation errors and never leaks credentials", async () => {
    const client = makeClient();
    client.putObject.mockRejectedValue(
      Object.assign(new Error("secret-value-that-must-not-leak"), {
        code: "InvalidArgument",
      }),
    );
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret-value-that-must-not-leak",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
      { retryDelayMs: 0 },
    );

    const failure = await store
      .put({
        key: "result.json",
        body: "{}",
        contentType: "application/json",
      })
      .catch(error => error);
    expect(failure).toBeInstanceOf(ArtifactStoreError);
    expect(failure).toMatchObject({ provider: "minio", operation: "put" });
    expect(String(failure)).not.toContain("secret-value-that-must-not-leak");
    expect(client.putObject).toHaveBeenCalledTimes(1);
  });

  it("destroys every hanging DELETE request and stops after three attempts", async () => {
    vi.useFakeTimers();
    const requests: Array<
      EventEmitter & { destroy: ReturnType<typeof vi.fn> }
    > = [];
    const baseTransport = {
      request: vi.fn(() => {
        const request = Object.assign(new EventEmitter(), {
          destroy: vi.fn((error: Error) => {
            request.emit("error", error);
            request.emit("close");
            return request;
          }),
        });
        requests.push(request);
        return request;
      }),
    };
    const transport = createMinioDeleteDeadlineTransport(
      baseTransport as any,
      100,
    );
    const client = makeClient();
    client.removeObject.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          const request = transport.request(
            { method: "DELETE" },
            () => undefined,
          );
          request.on("error", reject);
        }),
    );
    const store = new MinioArtifactStore(
      {
        endpoint: "http://minio:9000",
        accessKey: "app",
        secretKey: "secret-value-that-must-not-leak",
        bucket: "firecrawl-artifacts",
        region: "us-east-1",
      },
      client,
      { retryDelayMs: 0 },
    );

    const deletion = store.delete("hanging");
    const failure = deletion.catch(error => error);
    await vi.advanceTimersByTimeAsync(300);

    await expect(deletion).rejects.toMatchObject({
      name: "ArtifactStoreError",
      provider: "minio",
      operation: "delete",
      errorCode: "ETIMEDOUT",
    });
    expect(requests).toHaveLength(3);
    expect(
      requests.every(request => request.destroy.mock.calls.length === 1),
    ).toBe(true);
    expect(JSON.stringify(await failure)).not.toContain(
      "secret-value-that-must-not-leak",
    );
  });
});

describe("local artifact manifest coordination", () => {
  it("persists manifest inside coordination after object storage succeeds", async () => {
    const order: string[] = [];
    const store = {
      provider: "minio" as const,
      put: vi.fn(async input => {
        order.push("put");
        return {
          key: input.key,
          contentType: input.contentType,
          byteSize: Buffer.byteLength(input.body),
          metadata: {},
        };
      }),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };
    const persist = vi.fn(async () => {
      order.push("manifest");
    });
    const coordinate = vi.fn(
      async (
        _key: string,
        work: (session: {
          existed: boolean;
          persist: typeof persist;
        }) => Promise<void>,
      ) => {
        order.push("coordinate");
        await work({ existed: false, persist });
      },
    );

    await putArtifactWithManifest(
      store,
      {
        key: "job.json",
        body: "{}",
        contentType: "application/json",
        ownerId: "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
        requestId: "019e6f45-7778-727d-adf0-0abe9d5062b6",
        jobId: "019e6f45-7778-727d-adf0-0abe9d5062b7",
        kind: "scrape",
        deleteAfter: new Date("2026-08-17T00:00:00Z"),
      },
      coordinate as any,
    );

    expect(order).toEqual(["coordinate", "put", "manifest"]);
    expect(coordinate).toHaveBeenCalledWith("job.json", expect.any(Function));
    expect(persist).toHaveBeenCalledWith({
      objectKey: "job.json",
      ownerId: "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
      requestId: "019e6f45-7778-727d-adf0-0abe9d5062b6",
      jobId: "019e6f45-7778-727d-adf0-0abe9d5062b7",
      kind: "scrape",
      contentType: "application/json",
      byteSize: 2,
      deleteAfter: new Date("2026-08-17T00:00:00Z"),
    });
  });

  it("rolls back a new key and rethrows the original manifest failure", async () => {
    const manifestFailure = new Error("manifest unavailable");
    const store = {
      provider: "minio" as const,
      put: vi.fn().mockResolvedValue({
        key: "job.json",
        contentType: "application/json",
        byteSize: 2,
        metadata: {},
      }),
      get: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error("rollback unavailable")),
      health: vi.fn(),
    };
    const coordinate = async (
      _key: string,
      work: (session: {
        existed: boolean;
        persist: () => Promise<void>;
      }) => Promise<void>,
    ) =>
      work({
        existed: false,
        persist: vi.fn().mockRejectedValue(manifestFailure),
      });

    await expect(
      putArtifactWithManifest(
        store,
        {
          key: "job.json",
          body: "{}",
          contentType: "application/json",
          ownerId: "owner",
          requestId: null,
          jobId: null,
          kind: "scrape",
          deleteAfter: null,
        },
        coordinate as any,
      ),
    ).rejects.toBe(manifestFailure);
    expect(store.delete).toHaveBeenCalledWith("job.json");
    expect(cleanupLog).toHaveBeenCalledWith("Artifact rollback delete failed", {
      provider: "minio",
      objectKey: "job.json",
      cleanupErrorName: "Error",
    });
  });

  it("preserves an existing durable key when manifest persistence fails", async () => {
    const manifestFailure = new Error("manifest unavailable");
    const store = {
      provider: "minio" as const,
      put: vi.fn().mockResolvedValue({
        key: "job.json",
        contentType: "application/json",
        byteSize: 2,
        metadata: {},
      }),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };
    const coordinate = async (
      _key: string,
      work: (session: {
        existed: boolean;
        persist: () => Promise<void>;
      }) => Promise<void>,
    ) =>
      work({
        existed: true,
        persist: vi.fn().mockRejectedValue(manifestFailure),
      });

    await expect(
      putArtifactWithManifest(
        store,
        {
          key: "job.json",
          body: "{}",
          contentType: "application/json",
          ownerId: "owner",
          requestId: null,
          jobId: null,
          kind: "scrape",
          deleteAfter: null,
        },
        coordinate as any,
      ),
    ).rejects.toBe(manifestFailure);
    expect(store.delete).not.toHaveBeenCalled();
  });
});
