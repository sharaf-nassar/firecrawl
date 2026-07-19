import { beforeEach, describe, expect, it, vi } from "vitest";

const { cleanupLog, execute, transaction } = vi.hoisted(() => ({
  cleanupLog: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../db/connection", () => ({
  db: { transaction },
}));
vi.mock("../logger", () => ({ logger: { error: cleanupLog } }));

import { putLocalArtifactWithManifest } from "./local-manifest";

const input = {
  key: "pdf-cache-v2/result.json",
  body: '{"markdown":"exact"}',
  contentType: "application/json",
  ownerId: "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
  requestId: null,
  jobId: null,
  kind: "pdf-cache",
  deleteAfter: new Date("2026-08-17T00:00:00Z"),
};

describe("PostgreSQL local artifact coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async work => work({ execute }));
  });

  it("locks and checks the key before writing object and manifest", async () => {
    const order: string[] = [];
    execute.mockImplementationOnce(async () => {
      order.push("lock");
      return { rows: [] };
    });
    execute.mockImplementationOnce(async () => {
      order.push("check");
      return { rows: [{ existed: false }] };
    });
    execute.mockImplementationOnce(async () => {
      order.push("manifest");
      return { rows: [] };
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async artifact => {
        order.push("put");
        return {
          key: artifact.key,
          contentType: artifact.contentType,
          byteSize: Buffer.byteLength(artifact.body),
          metadata: {},
        };
      }),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };

    await putLocalArtifactWithManifest(store, input);

    expect(order).toEqual(["lock", "check", "put", "manifest"]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(store.put).toHaveBeenCalledWith(input);
  });

  it("preserves the original write failure when transaction rollback fails", async () => {
    const manifestFailure = new Error("manifest unavailable");
    const rollbackFailure = new Error("rollback unavailable");
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ existed: false }] })
      .mockRejectedValueOnce(manifestFailure);
    transaction.mockImplementation(async work => {
      try {
        return await work({ execute });
      } catch {
        throw rollbackFailure;
      }
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async artifact => ({
        key: artifact.key,
        contentType: artifact.contentType,
        byteSize: Buffer.byteLength(artifact.body),
        metadata: {},
      })),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };

    await expect(putLocalArtifactWithManifest(store, input)).rejects.toBe(
      manifestFailure,
    );
    expect(store.delete).toHaveBeenCalledWith(input.key);
  });

  it("preserves an advisory lock failure when transaction rollback fails", async () => {
    const lockFailure = new Error("lock unavailable");
    const rollbackFailure = new Error("rollback unavailable");
    execute.mockRejectedValueOnce(lockFailure);
    transaction.mockImplementation(async work => {
      try {
        return await work({ execute });
      } catch {
        throw rollbackFailure;
      }
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };

    await expect(putLocalArtifactWithManifest(store, input)).rejects.toBe(
      lockFailure,
    );
    expect(store.put).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("deletes a new unmanifested object after transaction commit fails", async () => {
    const commitFailure = new Error("commit unavailable");
    const cleanupFailure = new Error("delete unavailable");
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ existed: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ existed: false }] });
    let transactionCount = 0;
    transaction.mockImplementation(async work => {
      transactionCount += 1;
      const result = await work({ execute });
      if (transactionCount === 1) throw commitFailure;
      return result;
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async artifact => ({
        key: artifact.key,
        contentType: artifact.contentType,
        byteSize: Buffer.byteLength(artifact.body),
        metadata: {},
      })),
      get: vi.fn(),
      delete: vi.fn().mockRejectedValue(cleanupFailure),
      health: vi.fn(),
    };

    await expect(putLocalArtifactWithManifest(store, input)).rejects.toBe(
      commitFailure,
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(store.delete).toHaveBeenCalledWith(input.key);
    expect(cleanupLog).toHaveBeenCalledWith(
      "Local artifact commit recovery failed",
      {
        provider: "minio",
        objectKey: input.key,
        cleanupErrorName: cleanupFailure.name,
      },
    );
  });

  it("preserves the key when commit recovery finds a durable manifest", async () => {
    const commitFailure = new Error("commit outcome unknown");
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ existed: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ existed: true }] });
    let transactionCount = 0;
    transaction.mockImplementation(async work => {
      transactionCount += 1;
      const result = await work({ execute });
      if (transactionCount === 1) throw commitFailure;
      return result;
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async artifact => ({
        key: artifact.key,
        contentType: artifact.contentType,
        byteSize: Buffer.byteLength(artifact.body),
        metadata: {},
      })),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };

    await expect(putLocalArtifactWithManifest(store, input)).rejects.toBe(
      commitFailure,
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(store.delete).not.toHaveBeenCalled();
  });
});
