import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { runApplicationMigrations } from "../db/migrate";
import type { ArtifactStore } from "../lib/artifacts";
import { MinioArtifactStore } from "../lib/artifacts/minio";
import { BrowserStateFilesystem } from "../lib/browser-state/filesystem-store";
import { retentionDeadline } from "../lib/local-retention-deadline";
import {
  createLocalRetentionService,
  type BrowserStateFileClaim,
  type ExpiredBrowserStateFile,
  LocalArtifactRetentionError,
  LocalOperationalRetentionError,
  LocalRetentionShutdownTimeoutError,
  PgLocalRetentionDatabase,
  recoverBrowserCleanupIntentsBeforeSnapshot,
  runLocalRetentionIteration,
  runLocalRetentionLoop,
  type ArtifactManifestClaim,
  type ExpiredArtifactManifest,
  type LocalRetentionDatabase,
  type RetentionLogger,
} from "./local-retention-worker";

describe("recoverBrowserCleanupIntentsBeforeSnapshot", () => {
  it("recovers only an exact dead preparing writer", async () => {
    const intent = {
      id: "11111111-1111-4111-8111-111111111111",
      scrape_id: "22222222-2222-4222-8222-222222222222",
      state_path:
        "replay/33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444.json",
      checksum: "a".repeat(64),
      state: "preparing",
      created_at: new Date(),
      writer_lease: "55555555-5555-4555-8555-555555555555",
      writer_pid: 42,
      writer_boot_id: "b".repeat(32),
      writer_start_time: "1234",
    };
    const listing = {
      query: vi.fn(async () => ({ rows: [intent] })),
      release: vi.fn(),
    };
    let deleteAttempts = 0;
    const recovery = {
      query: vi.fn(async (text: string) => {
        if (text.includes("LEFT JOIN browser_replay_checkpoints")) {
          return {
            rows: [{ ...intent, current_state_path: "another/path.json" }],
          };
        }
        if (text.includes("DELETE FROM")) {
          deleteAttempts += 1;
          return { rows: [], rowCount: deleteAttempts === 1 ? 0 : 1 };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(listing)
        .mockResolvedValueOnce(recovery),
    };
    const filesystem = { delete: vi.fn(async () => undefined) };
    const inspectProcessIdentity = vi.fn(async () => "dead" as const);
    await expect(
      recoverBrowserCleanupIntentsBeforeSnapshot({
        pool: pool as never,
        filesystem: filesystem as never,
        inspectProcessIdentity,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      liveRetained: 0,
      unknownRetained: 0,
      deadRecovered: 1,
      missingConverged: 0,
    });
    expect(filesystem.delete).toHaveBeenCalledWith(intent.state_path);
    expect(inspectProcessIdentity).toHaveBeenCalledTimes(2);
    expect(deleteAttempts).toBe(2);
    expect(recovery.release).toHaveBeenCalledOnce();
  });
});

const localConfig = {
  LOCAL_PERSISTENCE_ENABLED: true,
  APPLICATION_DATABASE_URL:
    "postgresql://firecrawl:password@localhost:5432/firecrawl",
  LOCAL_OWNER_ID: "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
  LOCAL_RECORD_RETENTION_DAYS: 30,
  LOCAL_ARTIFACT_RETENTION_DAYS: 30,
  ARTIFACT_STORE_PROVIDER: "none" as const,
  USE_DB_AUTHENTICATION: false,
};

const silentLogger: RetentionLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

class FakeDatabase implements LocalRetentionDatabase {
  readonly events: string[] = [];
  manifests: ExpiredArtifactManifest[] = [];
  browserStateFiles: ExpiredBrowserStateFile[] = [];
  operationalResult = {
    requestsDeleted: 0,
    dependentRowsDeleted: 0,
    requestIds: [] as string[],
  };
  artifactLimit: number | undefined;
  operationalLimit: number | undefined;
  operationalNow: Date | undefined;
  operationalRuns = 0;
  manifestDeleteError: Error | undefined;
  browserMarkResult = true;
  browserControlTransactions: unknown[] = [];

  async listExpiredArtifactManifests(
    _now: Date,
    limit: number,
  ): Promise<ExpiredArtifactManifest[]> {
    this.artifactLimit = limit;
    return this.manifests.slice(0, limit);
  }

  async tryClaimArtifactManifest(
    candidate: ExpiredArtifactManifest,
    _now: Date,
  ): Promise<ArtifactManifestClaim | null> {
    const manifest = this.manifests.find(
      item => item.objectKey === candidate.objectKey,
    );
    if (!manifest) return null;
    return {
      manifest,
      deleteManifest: async () => {
        if (this.manifestDeleteError) throw this.manifestDeleteError;
        this.events.push(`manifest:${manifest.objectKey}`);
        this.manifests = this.manifests.filter(
          item => item.objectKey !== manifest.objectKey,
        );
        return true;
      },
      release: async () => {
        this.events.push(`release:${manifest.objectKey}`);
      },
    };
  }

  async listExpiredBrowserStateFiles(
    _now: Date,
    limit: number,
    controlTransaction?: unknown,
  ): Promise<ExpiredBrowserStateFile[]> {
    this.browserControlTransactions.push(controlTransaction);
    return this.browserStateFiles.slice(0, limit);
  }

  async tryClaimBrowserStateFile(
    candidate: ExpiredBrowserStateFile,
    _now: Date,
    controlTransaction?: unknown,
  ): Promise<BrowserStateFileClaim | null> {
    this.browserControlTransactions.push(controlTransaction);
    const file = this.browserStateFiles.find(
      item => item.kind === candidate.kind && item.id === candidate.id,
    );
    if (!file) return null;
    return {
      file,
      deleteFile: true,
      markFileDeleted: async () => {
        if (!this.browserMarkResult) return false;
        this.events.push(`metadata:${file.statePath}`);
        this.browserStateFiles = this.browserStateFiles.filter(
          item => item.kind !== file.kind || item.id !== file.id,
        );
        return true;
      },
      release: async () => {
        this.events.push(`file-release:${file.statePath}`);
      },
    };
  }

  async deleteExpiredOperationalRows(now: Date, limit: number) {
    this.operationalRuns += 1;
    this.operationalNow = now;
    this.operationalLimit = limit;
    this.events.push("operational");
    return this.operationalResult;
  }

  async close(): Promise<void> {}
}

function fakeStore(
  deleteObject: (key: string) => Promise<void>,
): ArtifactStore {
  return {
    provider: "minio",
    put: vi.fn(),
    get: vi.fn(),
    delete: deleteObject,
    health: vi.fn(),
  } as ArtifactStore;
}

function manifests(count: number): ExpiredArtifactManifest[] {
  return Array.from({ length: count }, (_, index) => ({
    objectKey: `artifact-${index}`,
    kind: "retention-test",
    requestId: `request-${index}`,
    jobId: `job-${index}`,
    deleteAfter: new Date("2026-07-17T00:00:00.000Z"),
    deleteAfterToken: "2026-07-17 00:00:00+00",
  }));
}

function browserStateFiles(count: number): ExpiredBrowserStateFile[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "replay-checkpoint" as const,
    id: `checkpoint-${index}`,
    statePath: `replay/owner/scrape/checkpoint-${index}.json`,
    checksum: `${index}`.padStart(64, "0"),
    deleteAfter: new Date("2026-07-17T00:00:00.000Z"),
  }));
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("retentionDeadline", () => {
  it("uses configured retention for normal data and caps ZDR at 24 hours", () => {
    const now = new Date("2026-07-18T00:00:00.000Z");

    expect(retentionDeadline(now, 7, false)).toEqual(
      new Date("2026-07-25T00:00:00.000Z"),
    );
    expect(retentionDeadline(now, 30, true)).toEqual(
      new Date("2026-07-19T00:00:00.000Z"),
    );
  });
});

describe("runLocalRetentionIteration", () => {
  it("deletes browser state before metadata and operational rows", async () => {
    const database = new FakeDatabase();
    database.browserStateFiles = browserStateFiles(1);
    const filesystem = {
      delete: vi.fn(async (statePath: string) => {
        database.events.push(`file:${statePath}`);
      }),
    };

    await runLocalRetentionIteration({
      database,
      artifactStore: null,
      browserStateFilesystem: filesystem,
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    });

    expect(database.events).toEqual([
      "file:replay/owner/scrape/checkpoint-0.json",
      "metadata:replay/owner/scrape/checkpoint-0.json",
      "file-release:replay/owner/scrape/checkpoint-0.json",
      "operational",
    ]);
  });

  it("leaves browser metadata and operational rows retryable on file failure", async () => {
    const database = new FakeDatabase();
    database.browserStateFiles = browserStateFiles(1);

    await expect(
      runLocalRetentionIteration({
        database,
        artifactStore: null,
        browserStateFilesystem: {
          delete: vi.fn().mockRejectedValue(new Error("filesystem offline")),
        },
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      }),
    ).rejects.toThrow("Browser state retention delete failed");

    expect(database.browserStateFiles).toHaveLength(1);
    expect(database.operationalRuns).toBe(1);
    expect(database.events).toEqual([
      "file-release:replay/owner/scrape/checkpoint-0.json",
      "operational",
    ]);
  });

  it("does not delete requests after a browser metadata CAS loses", async () => {
    const database = new FakeDatabase();
    database.browserStateFiles = browserStateFiles(1);
    database.browserMarkResult = false;

    await expect(
      runLocalRetentionIteration({
        database,
        artifactStore: null,
        browserStateFilesystem: { delete: vi.fn() },
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      }),
    ).rejects.toThrow("Browser state retention delete failed");

    expect(database.browserStateFiles).toHaveLength(1);
    expect(database.operationalRuns).toBe(1);
  });

  it("continues after a poison browser file and cleans unrelated rows", async () => {
    const database = new FakeDatabase();
    database.browserStateFiles = browserStateFiles(2);
    database.operationalResult = {
      requestsDeleted: 1,
      dependentRowsDeleted: 2,
      requestIds: ["safe-request"],
    };
    const filesystem = {
      delete: vi.fn(async (statePath: string) => {
        database.events.push(`file:${statePath}`);
        if (statePath.endsWith("checkpoint-0.json")) {
          throw Object.assign(new Error("poison secret=do-not-log"), {
            code: "EIO",
          });
        }
      }),
    };

    const failure = await runLocalRetentionIteration({
      database,
      artifactStore: null,
      browserStateFilesystem: filesystem,
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    }).catch(error => error);

    expect(failure).toMatchObject({
      name: "LocalBrowserStateRetentionError",
      browserStateCandidates: 2,
      browserStateFilesDeleted: 1,
      browserStateFailures: 1,
      requestsDeleted: 1,
      dependentRowsDeleted: 2,
      requestIds: ["safe-request"],
    });
    expect(database.browserStateFiles.map(file => file.id)).toEqual([
      "checkpoint-0",
    ]);
    expect(database.events).toEqual([
      "file:replay/owner/scrape/checkpoint-0.json",
      "file-release:replay/owner/scrape/checkpoint-0.json",
      "file:replay/owner/scrape/checkpoint-1.json",
      "metadata:replay/owner/scrape/checkpoint-1.json",
      "file-release:replay/owner/scrape/checkpoint-1.json",
      "operational",
    ]);
  });

  it("logs sanitized browser failure stages without durable paths", async () => {
    const database = new FakeDatabase();
    database.browserStateFiles = browserStateFiles(4).map((file, index) => ({
      ...file,
      statePath: `replay/owner/scrape/secret-do-not-log-${index}.json`,
    }));
    const originalClaim = database.tryClaimBrowserStateFile.bind(database);
    database.tryClaimBrowserStateFile = vi.fn(async (candidate, now) => {
      if (candidate.id === "checkpoint-0") {
        throw Object.assign(new Error("claim secret=do-not-log"), {
          code: "55P03",
        });
      }
      const claim = await originalClaim(candidate, now);
      if (!claim) return null;
      return {
        ...claim,
        markFileDeleted:
          candidate.id === "checkpoint-3"
            ? async () => false
            : claim.markFileDeleted,
        release:
          candidate.id === "checkpoint-1"
            ? async () => {
                throw Object.assign(new Error("release secret=do-not-log"), {
                  code: "ECONNRESET",
                });
              }
            : claim.release,
      };
    });

    await expect(
      runLocalRetentionIteration({
        database,
        artifactStore: null,
        browserStateFilesystem: {
          delete: vi.fn(async statePath => {
            if (statePath.endsWith("-2.json")) {
              throw Object.assign(new Error("delete secret=do-not-log"), {
                code: "EIO",
              });
            }
          }),
        },
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ browserStateFailures: 4 });

    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local browser state retention candidate failed",
      expect.objectContaining({
        fileKind: "replay-checkpoint",
        operation: "claim",
        errorCode: "55P03",
      }),
    );
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local browser state retention candidate failed",
      expect.objectContaining({
        operation: "claim-release",
        errorCode: "ECONNRESET",
      }),
    );
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local browser state retention candidate failed",
      expect.objectContaining({
        operation: "filesystem-delete",
        errorCode: "EIO",
      }),
    );
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local browser state retention candidate failed",
      expect.objectContaining({
        operation: "metadata-cas",
        errorCode: "browser_state_file_claim_lost",
      }),
    );
    expect(
      JSON.stringify(vi.mocked(silentLogger.error).mock.calls),
    ).not.toContain("secret=do-not-log");
  });

  it("deletes at most 50 objects before their manifests", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(51);
    const store = fakeStore(async key => {
      database.events.push(`object:${key}`);
    });

    const result = await runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    });

    expect(database.artifactLimit).toBe(50);
    expect(result.artifactsDeleted).toBe(50);
    expect(database.manifests).toHaveLength(1);
    expect(database.events.slice(0, 2)).toEqual([
      "object:artifact-0",
      "manifest:artifact-0",
    ]);
  });

  it("keeps a manifest and bubbles a sanitized object deletion failure", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    const store = fakeStore(async () => {
      throw new Error("storage unavailable with secret=do-not-log");
    });

    const failure = runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    });

    await expect(failure).rejects.toBeInstanceOf(LocalArtifactRetentionError);
    await expect(failure).rejects.toMatchObject({
      name: "LocalArtifactRetentionError",
      code: "artifact_delete_failed",
      phase: "artifact-delete",
      artifactCandidates: 1,
      artifactsDeleted: 0,
      artifactFailures: 1,
      requestsDeleted: 0,
      dependentRowsDeleted: 0,
      requestIds: [],
      durationMs: expect.any(Number),
      objectKey: "artifact-0",
      requestId: "request-0",
      jobId: "job-0",
      provider: "minio",
    });
    expect(database.manifests).toHaveLength(1);
    expect(database.events).toEqual(["release:artifact-0", "operational"]);
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local artifact retention delete failed",
      expect.objectContaining({
        objectKey: "artifact-0",
        requestId: "request-0",
        jobId: "job-0",
        provider: "minio",
        errorName: "LocalArtifactRetentionError",
        errorCode: "artifact_delete_failed",
        phase: "artifact-delete",
        artifactCandidates: 1,
        artifactsDeleted: 0,
        artifactFailures: 1,
        durationMs: expect.any(Number),
      }),
    );
    expect(
      JSON.stringify(vi.mocked(silentLogger.error).mock.calls),
    ).not.toContain("do-not-log");
    expect(silentLogger.info).not.toHaveBeenCalled();
    expect(silentLogger.debug).not.toHaveBeenCalled();
  });

  it("preserves completed manifests before a later object deletion fails", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(2);
    const store = fakeStore(async key => {
      if (key === "artifact-1") throw new Error("storage unavailable");
    });

    await expect(
      runLocalRetentionIteration({
        database,
        artifactStore: store,
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(LocalArtifactRetentionError);

    expect(database.manifests.map(item => item.objectKey)).toEqual([
      "artifact-1",
    ]);
    expect(database.events).toEqual([
      "manifest:artifact-0",
      "release:artifact-0",
      "release:artifact-1",
      "operational",
    ]);
  });

  it("continues later artifacts and operational cleanup before aggregating failures", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(3);
    database.operationalResult = {
      requestsDeleted: 1,
      dependentRowsDeleted: 2,
      requestIds: ["expired-request"],
    };
    let firstAttempt = true;
    const store = fakeStore(async key => {
      if (key === "artifact-0" && firstAttempt) {
        throw Object.assign(new Error("permanent secret=do-not-log"), {
          code: "AccessDenied",
        });
      }
    });

    const failure = await runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    }).catch(error => error);

    expect(failure).toBeInstanceOf(LocalArtifactRetentionError);
    expect(failure).toMatchObject({
      artifactCandidates: 3,
      artifactsDeleted: 2,
      artifactFailures: 1,
      requestsDeleted: 1,
      dependentRowsDeleted: 2,
      requestIds: ["expired-request"],
      failures: [
        {
          objectKey: "artifact-0",
          requestId: "request-0",
          jobId: "job-0",
          provider: "minio",
          errorName: "Error",
          errorCode: "AccessDenied",
        },
      ],
    });
    expect(JSON.stringify(failure)).not.toContain("do-not-log");
    expect(database.manifests.map(item => item.objectKey)).toEqual([
      "artifact-0",
    ]);
    expect(database.events).toContain("operational");

    firstAttempt = false;
    const retry = await runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date("2026-07-18T00:00:01.000Z"),
      logger: silentLogger,
    });
    expect(retry.artifactsDeleted).toBe(1);
    expect(database.manifests).toHaveLength(0);
  });

  it("keeps a failed browser artifact ahead of run and request cleanup", async () => {
    const database = new FakeDatabase();
    database.manifests = [
      {
        ...manifests(1)[0]!,
        objectKey: "browser-runs/session/run/output.json",
        kind: "browser-run",
      } as ExpiredArtifactManifest,
    ];
    let unavailable = true;
    const store = fakeStore(async key => {
      database.events.push(`object:${key}`);
      if (unavailable) throw new Error("browser artifact store offline");
    });

    await expect(
      runLocalRetentionIteration({
        database,
        artifactStore: store,
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(LocalArtifactRetentionError);
    expect(database.operationalRuns).toBe(0);
    expect(database.manifests).toHaveLength(1);

    unavailable = false;
    await runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date("2026-07-18T00:00:01.000Z"),
      logger: silentLogger,
    });
    expect(database.events.slice(-4)).toEqual([
      "object:browser-runs/session/run/output.json",
      "manifest:browser-runs/session/run/output.json",
      "release:browser-runs/session/run/output.json",
      "operational",
    ]);
  });

  it("preserves an object failure when releasing its claim also fails", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    const claimManifest = database.tryClaimArtifactManifest.bind(database);
    database.tryClaimArtifactManifest = vi.fn(async (candidate, now) => {
      const claim = await claimManifest(candidate, now);
      if (!claim) return null;
      return {
        ...claim,
        release: async () => {
          throw Object.assign(new Error("unlock secret=do-not-log"), {
            code: "ECONNRESET",
          });
        },
      };
    });
    const objectFailure = Object.assign(
      new Error("storage secret=do-not-log"),
      { code: "AccessDenied" },
    );

    const failure = await runLocalRetentionIteration({
      database,
      artifactStore: fakeStore(async () => {
        throw objectFailure;
      }),
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    }).catch(error => error);

    expect(failure).toBeInstanceOf(LocalArtifactRetentionError);
    expect(failure).toMatchObject({
      artifactFailures: 1,
      failures: [
        {
          objectKey: "artifact-0",
          errorName: "Error",
          errorCode: "AccessDenied",
          cleanupError: {
            errorName: "Error",
            errorCode: "ECONNRESET",
          },
        },
      ],
    });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([
      objectFailure,
      expect.objectContaining({ code: "ECONNRESET" }),
    ]);
    expect(database.operationalRuns).toBe(1);
    expect(JSON.stringify(failure)).not.toContain("do-not-log");
  });

  it("preserves artifact details when operational cleanup also fails", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    const rollbackMetadata = {
      errorName: "Error",
      errorCode: "ECONNRESET",
    };
    const operationalCause = new Error("database secret=do-not-log");
    database.deleteExpiredOperationalRows = vi.fn().mockRejectedValue(
      new LocalOperationalRetentionError({
        requestIds: ["request-claimed"],
        cause: operationalCause,
        cleanupError: rollbackMetadata,
      }),
    );
    const objectFailure = Object.assign(
      new Error("storage secret=do-not-log"),
      { code: "AccessDenied" },
    );

    const failure = await runLocalRetentionIteration({
      database,
      artifactStore: fakeStore(async () => {
        throw objectFailure;
      }),
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    }).catch(error => error);

    expect(failure).toBeInstanceOf(LocalOperationalRetentionError);
    expect(failure).toMatchObject({
      artifactFailures: 1,
      requestIds: ["request-claimed"],
      cleanupError: rollbackMetadata,
      failures: [
        {
          objectKey: "artifact-0",
          errorName: "Error",
          errorCode: "AccessDenied",
        },
      ],
    });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([
      objectFailure,
      operationalCause,
    ]);
    expect(JSON.stringify(failure)).not.toContain("do-not-log");
  });

  it("treats an already-missing object as successful manifest cleanup", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    const deleteMissingObject = vi.fn().mockResolvedValue(undefined);

    const result = await runLocalRetentionIteration({
      database,
      artifactStore: fakeStore(deleteMissingObject),
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    });

    expect(deleteMissingObject).toHaveBeenCalledWith("artifact-0");
    expect(result.artifactsDeleted).toBe(1);
    expect(database.manifests).toHaveLength(0);
  });

  it("leaves a manifest retryable when interrupted after object deletion", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    const controller = new AbortController();
    const store = fakeStore(async key => {
      database.events.push(`object:${key}`);
      controller.abort();
    });

    await runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date("2026-07-18T00:00:00.000Z"),
      signal: controller.signal,
      logger: silentLogger,
    });

    expect(database.manifests).toHaveLength(1);
    expect(database.events).toEqual([
      "object:artifact-0",
      "release:artifact-0",
    ]);

    await runLocalRetentionIteration({
      database,
      artifactStore: fakeStore(async () => undefined),
      now: new Date("2026-07-18T00:00:01.000Z"),
      logger: silentLogger,
    });
    expect(database.manifests).toHaveLength(0);
  });

  it("bubbles a manifest database failure for the loop to retry", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    database.manifestDeleteError = new Error("database unavailable");

    await expect(
      runLocalRetentionIteration({
        database,
        artifactStore: fakeStore(async () => undefined),
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      }),
    ).rejects.toThrow("database unavailable");
    expect(database.manifests).toHaveLength(1);
    expect(database.operationalRuns).toBe(0);
  });

  it("runs bounded operational cleanup at the supplied time", async () => {
    const database = new FakeDatabase();
    database.operationalResult = {
      requestsDeleted: 3,
      dependentRowsDeleted: 9,
      requestIds: ["request-1", "request-2", "request-3"],
    };
    const now = new Date("2026-07-18T00:00:00.000Z");

    const result = await runLocalRetentionIteration({
      database,
      artifactStore: null,
      now,
      logger: silentLogger,
    });

    expect(database.operationalNow).toEqual(now);
    expect(database.operationalLimit).toBe(50);
    expect(result).toMatchObject({
      requestsDeleted: 3,
      dependentRowsDeleted: 9,
      requestIds: ["request-1", "request-2", "request-3"],
    });
    expect(silentLogger.info).toHaveBeenCalledWith(
      "Local retention iteration completed",
      expect.objectContaining({
        requestIds: ["request-1", "request-2", "request-3"],
      }),
    );
  });

  it("bubbles a sanitized operational failure with its cause kept internal", async () => {
    const database = new FakeDatabase();
    const databaseFailure = new Error("database secret=do-not-log");
    database.deleteExpiredOperationalRows = vi
      .fn()
      .mockRejectedValue(databaseFailure);

    let failure: unknown;
    try {
      await runLocalRetentionIteration({
        database,
        artifactStore: null,
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LocalOperationalRetentionError);
    expect(failure).toMatchObject({
      name: "LocalOperationalRetentionError",
      code: "operational_cleanup_failed",
      phase: "operational-cleanup",
      artifactCandidates: 0,
      artifactsDeleted: 0,
      artifactFailures: 0,
      requestsDeleted: 0,
      dependentRowsDeleted: 0,
      requestIds: [],
      durationMs: expect.any(Number),
      cause: databaseFailure,
    });
    expect(JSON.stringify(failure)).not.toContain("do-not-log");
    expect(silentLogger.info).not.toHaveBeenCalled();
    expect(silentLogger.debug).not.toHaveBeenCalled();
  });
});

describe("runLocalRetentionLoop", () => {
  it("runs operational work while browser work waits on the startup gate", async () => {
    const database = new FakeDatabase();
    database.browserStateFiles = browserStateFiles(1);
    const controller = new AbortController();
    const deleted: string[] = [];
    let releaseGate!: () => void;
    const gateOpened = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const controlTransaction = {
      query: vi.fn(),
      databaseControlEpoch: 1,
    };
    const gate = {
      assertOpen: vi.fn(),
      close: vi.fn(),
      open: vi.fn(),
      waitUntilOpen: vi.fn(async () => {
        await gateOpened;
        return {};
      }),
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
        operation({
          epoch: 1,
          scope: "filesystem_and_database",
          binding: {},
          transaction: controlTransaction,
        }),
      ),
      withDrainedBrowserStateMutation: vi.fn(),
    };
    let sleeps = 0;
    const loop = runLocalRetentionLoop({
      configSource: {
        ...localConfig,
        LOCAL_BROWSER_SERVICE_ENABLED: true,
        LOCAL_BROWSER_STATE_ROOT: "/tmp/firecrawl-retention-gate-test",
        BROWSER_SERVICE_URL: "http://127.0.0.1:3002",
        BROWSER_SERVICE_API_KEY: "x".repeat(32),
        BROWSER_REPLAY_INGEST_URL: "http://127.0.0.1:3002",
        BROWSER_REPLAY_INGEST_API_KEY: "r".repeat(32),
      },
      database,
      artifactStore: null,
      browserStateFilesystem: {
        delete: async statePath => {
          deleted.push(statePath);
        },
      },
      browserStartupGate: gate as never,
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 2) controller.abort();
      },
      logger: silentLogger,
    });
    await vi.waitFor(() => expect(database.operationalRuns).toBe(1));
    expect(gate.withBrowserStateMutationLease).not.toHaveBeenCalled();
    releaseGate();
    await loop;
    expect(gate.withBrowserStateMutationLease).toHaveBeenCalledWith(
      "filesystem_and_database",
      expect.any(Function),
    );
    expect(deleted).toHaveLength(1);
    expect(database.browserControlTransactions).toEqual([
      controlTransaction,
      controlTransaction,
    ]);
  });

  it("does not start in hosted mode", async () => {
    const database = new FakeDatabase();
    const sleep = vi.fn();

    await runLocalRetentionLoop({
      configSource: {
        ...localConfig,
        LOCAL_PERSISTENCE_ENABLED: false,
      },
      database,
      artifactStore: null,
      signal: new AbortController().signal,
      sleep,
      logger: silentLogger,
    });

    expect(database.operationalRuns).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not touch the browser state root while browser service is disabled", async () => {
    const database = new FakeDatabase();
    const controller = new AbortController();

    await runLocalRetentionLoop({
      configSource: {
        ...localConfig,
        LOCAL_BROWSER_SERVICE_ENABLED: false,
        LOCAL_BROWSER_STATE_ROOT: "relative/unusable-root",
      },
      database,
      artifactStore: null,
      signal: controller.signal,
      sleep: async () => controller.abort(),
      logger: silentLogger,
    });

    expect(database.operationalRuns).toBe(1);
  });

  it("uses a bounded one-second idle backoff between iterations", async () => {
    const database = new FakeDatabase();
    const controller = new AbortController();
    const sleep = vi.fn(async (milliseconds: number) => {
      expect(milliseconds).toBe(1_000);
      controller.abort();
    });

    await runLocalRetentionLoop({
      configSource: localConfig,
      database,
      artifactStore: null,
      signal: controller.signal,
      sleep,
      logger: silentLogger,
    });

    expect(database.operationalRuns).toBe(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("aborts the default idle wait promptly", async () => {
    vi.useFakeTimers();
    const database = new FakeDatabase();
    const controller = new AbortController();

    const loop = runLocalRetentionLoop({
      configSource: localConfig,
      database,
      artifactStore: null,
      signal: controller.signal,
      logger: silentLogger,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(loop).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs an iteration failure and retries on the next loop", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    const originalCleanup =
      database.deleteExpiredOperationalRows.bind(database);
    database.deleteExpiredOperationalRows = vi
      .fn()
      .mockRejectedValueOnce(
        new LocalOperationalRetentionError({
          requestIds: ["request-claimed"],
          cause: new Error("database secret=do-not-log"),
          cleanupError: { errorName: "Error", errorCode: "ECONNRESET" },
        }),
      )
      .mockImplementation(originalCleanup);
    const controller = new AbortController();
    let sleeps = 0;

    await runLocalRetentionLoop({
      configSource: localConfig,
      database,
      artifactStore: fakeStore(async () => undefined),
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) controller.abort();
      },
      logger: silentLogger,
    });

    expect(database.deleteExpiredOperationalRows).toHaveBeenCalledTimes(2);
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local retention iteration failed",
      {
        errorName: "LocalOperationalRetentionError",
        errorCode: "operational_cleanup_failed",
        phase: "operational-cleanup",
        artifactCandidates: 1,
        artifactsDeleted: 1,
        artifactFailures: 0,
        browserStateCandidates: 0,
        browserStateFilesDeleted: 0,
        browserStateFailures: 0,
        requestsDeleted: 0,
        dependentRowsDeleted: 0,
        requestIds: ["request-claimed"],
        durationMs: expect.any(Number),
        cleanupError: { errorName: "Error", errorCode: "ECONNRESET" },
      },
    );
    expect(
      JSON.stringify(vi.mocked(silentLogger.error).mock.calls),
    ).not.toContain("do-not-log");
  });

  it("logs a storage failure at loop level and retries its manifest", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(2);
    let deleteAttempts = 0;
    const store = fakeStore(async key => {
      deleteAttempts += 1;
      if (key === "artifact-1" && deleteAttempts === 2) {
        throw new Error("temporary storage failure secret=do-not-log");
      }
    });
    const controller = new AbortController();
    let sleeps = 0;

    await runLocalRetentionLoop({
      configSource: localConfig,
      database,
      artifactStore: store,
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) controller.abort();
      },
      logger: silentLogger,
    });

    expect(deleteAttempts).toBe(3);
    expect(database.manifests).toHaveLength(0);
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local retention iteration failed",
      {
        errorName: "LocalArtifactRetentionError",
        errorCode: "artifact_delete_failed",
        phase: "artifact-delete",
        artifactCandidates: 2,
        artifactsDeleted: 1,
        artifactFailures: 1,
        browserStateCandidates: 0,
        browserStateFilesDeleted: 0,
        browserStateFailures: 0,
        requestsDeleted: 0,
        dependentRowsDeleted: 0,
        requestIds: [],
        durationMs: expect.any(Number),
        objectKey: "artifact-1",
        requestId: "request-1",
        jobId: "job-1",
        provider: "minio",
        failures: [
          {
            objectKey: "artifact-1",
            requestId: "request-1",
            jobId: "job-1",
            provider: "minio",
            errorName: "Error",
          },
        ],
      },
    );
    expect(
      JSON.stringify(vi.mocked(silentLogger.error).mock.calls),
    ).not.toContain("do-not-log");
  });
});

describe("createLocalRetentionService", () => {
  it("starts once and waits for the aborted loop during shutdown", async () => {
    let releaseLoop: (() => void) | undefined;
    const loopExited = new Promise<void>(resolve => {
      releaseLoop = resolve;
    });
    const runner = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>(resolve =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await loopExited;
    });
    const service = createLocalRetentionService(runner);

    const first = service.start();
    const second = service.start();
    expect(first).toBe(second);
    expect(runner).toHaveBeenCalledOnce();

    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(runner.mock.calls[0]?.[0].aborted).toBe(true);

    releaseLoop?.();
    await stop;
    expect(stopped).toBe(true);
    expect(service.start()).toBe(first);
  });

  it("aborts and rejects within a bounded deadline when the runner hangs", async () => {
    vi.useFakeTimers();
    const runner = vi.fn(
      async (_signal: AbortSignal) =>
        await new Promise<void>(() => {
          // Intentionally never settles.
        }),
    );
    const service = createLocalRetentionService(runner, {
      stopTimeoutMs: 5_000,
      logger: silentLogger,
    });
    service.start();

    const stop = service.stop();
    const stopped = expect(stop).rejects.toBeInstanceOf(
      LocalRetentionShutdownTimeoutError,
    );
    expect(runner.mock.calls[0]?.[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    await stopped;
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local retention worker shutdown timed out",
      {
        errorName: "LocalRetentionShutdownTimeoutError",
        errorCode: "retention_shutdown_timeout",
        timeoutMs: 5_000,
      },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("PgLocalRetentionDatabase resource safety", () => {
  function fakePool(client: any) {
    return {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
  }

  it("configures finite PostgreSQL connection and statement deadlines", async () => {
    let poolConfig: Record<string, unknown> | undefined;
    const pool = fakePool({});
    const database = new PgLocalRetentionDatabase("postgresql://test", {
      createPool: config => {
        poolConfig = config as Record<string, unknown>;
        return pool as any;
      },
    });

    expect(poolConfig).toMatchObject({
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    await database.close();
    await database.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("destroys a claimed client exactly once when advisory unlock fails", async () => {
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes("FROM local_artifacts")) {
          return {
            rows: [
              {
                object_key: "artifact-0",
                request_id: "request-0",
                job_id: "job-0",
                delete_after: new Date("2026-07-17T00:00:00.000Z"),
                delete_after_token: "2026-07-17 00:00:00+00",
              },
            ],
          };
        }
        if (sql.includes("pg_advisory_unlock")) {
          throw new Error("unlock secret=do-not-log");
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const pool = fakePool(client);
    const database = new PgLocalRetentionDatabase("postgresql://test", {
      createPool: () => pool as any,
    });
    const candidate = manifests(1)[0]!;
    const claim = await database.tryClaimArtifactManifest(
      candidate,
      new Date("2026-07-18T00:00:00.000Z"),
    );

    await expect(claim?.release()).rejects.toThrow("unlock secret");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys once when a manifest query times out", async () => {
    const timeout = Object.assign(new Error("statement timed out"), {
      code: "57014",
    });
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn().mockRejectedValue(timeout),
    };
    const pool = fakePool(client);
    const database = new PgLocalRetentionDatabase("postgresql://test", {
      createPool: () => pool as any,
    });

    await expect(
      database.listExpiredArtifactManifests(
        new Date("2026-07-18T00:00:00.000Z"),
        50,
      ),
    ).rejects.toBe(timeout);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys once when releasing a no-row claim fails", async () => {
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes("FROM local_artifacts")) {
          return { rows: [] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          throw new Error("unlock failed");
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const pool = fakePool(client);
    const database = new PgLocalRetentionDatabase("postgresql://test", {
      createPool: () => pool as any,
    });

    await expect(
      database.tryClaimArtifactManifest(
        manifests(1)[0]!,
        new Date("2026-07-18T00:00:00.000Z"),
      ),
    ).rejects.toThrow("unlock failed");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });

  it("preserves a claim query failure when advisory unlock also fails", async () => {
    const queryFailure = new Error("query secret=do-not-log");
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes("FROM local_artifacts")) {
          throw queryFailure;
        }
        if (sql.includes("pg_advisory_unlock")) {
          throw Object.assign(new Error("unlock secret=do-not-log"), {
            code: "ECONNRESET",
          });
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const pool = fakePool(client);
    const database = new PgLocalRetentionDatabase("postgresql://test", {
      createPool: () => pool as any,
    });

    const failure = await database
      .tryClaimArtifactManifest(
        manifests(1)[0]!,
        new Date("2026-07-18T00:00:00.000Z"),
      )
      .catch(error => error);
    expect(failure).toMatchObject({
      name: "LocalRetentionResourceError",
      code: "retention_resource_cleanup_failed",
      cause: queryFailure,
      cleanupError: { errorName: "Error", errorCode: "ECONNRESET" },
    });
    expect(JSON.stringify(failure)).not.toContain("do-not-log");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys once on rollback failure and preserves both error contexts", async () => {
    const transactionFailure = new Error("transaction secret=do-not-log");
    const rollbackFailure = Object.assign(
      new Error("rollback secret=do-not-log"),
      { code: "ECONNRESET" },
    );
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN") return { rows: [] };
        if (sql.includes("FROM requests")) {
          return { rows: [{ id: "request-claimed" }] };
        }
        if (
          sql.startsWith("DELETE FROM webhook_logs") &&
          sql.includes("dr_clean_by")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("DELETE FROM webhook_logs")) {
          throw transactionFailure;
        }
        if (sql === "ROLLBACK") throw rollbackFailure;
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const pool = fakePool(client);
    const database = new PgLocalRetentionDatabase("postgresql://test", {
      createPool: () => pool as any,
    });

    const failure = await database
      .deleteExpiredOperationalRows(new Date("2026-07-18T00:00:00.000Z"), 50)
      .catch(error => error);
    expect(failure).toMatchObject({
      name: "LocalOperationalRetentionError",
      requestIds: ["request-claimed"],
      cause: transactionFailure,
      cleanupError: { errorName: "Error", errorCode: "ECONNRESET" },
    });
    expect(JSON.stringify(failure)).not.toContain("do-not-log");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });
});

const integrationDatabaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = integrationDatabaseUrl ? describe : describe.skip;
const operationalTableNames = [
  "scrapes",
  "parses",
  "crawls",
  "batch_scrapes",
  "searches",
  "extracts",
  "maps",
  "llmstxts",
  "deep_researches",
  "research_paper_searches",
  "research_paper_inspects",
  "research_paper_reads",
  "research_related_papers",
  "research_github_searches",
] as const;

describeWithDatabase("PostgreSQL local retention", () => {
  const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
  const database = new PgLocalRetentionDatabase(
    integrationDatabaseUrl ?? "postgresql://disabled",
  );
  const fixtureIds = new Set<string>();
  const profileIds = new Set<string>();

  beforeAll(async () => {
    await runApplicationMigrations({
      ...localConfig,
      APPLICATION_DATABASE_URL: integrationDatabaseUrl,
    });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TRIGGER IF EXISTS retention_test_require_webhook_delete ON crawls",
    );
    await pool.query(
      "DROP FUNCTION IF EXISTS retention_test_require_webhook_delete()",
    );
    await pool.query(
      "DROP TRIGGER IF EXISTS retention_test_reject_delete ON scrapes",
    );
    await pool.query("DROP FUNCTION IF EXISTS retention_test_reject_delete()");
    const ids = [...fixtureIds];
    if (ids.length > 0) {
      await pool.query(
        "DELETE FROM webhook_logs WHERE crawl_id = ANY($1::uuid[])",
        [ids],
      );
      for (const table of operationalTableNames) {
        await pool.query(
          `DELETE FROM ${table} WHERE request_id = ANY($1::uuid[])`,
          [ids],
        );
      }
      await pool.query("DELETE FROM requests WHERE id = ANY($1::uuid[])", [
        ids,
      ]);
    }
    if (profileIds.size > 0) {
      await pool.query(
        "DELETE FROM browser_profiles WHERE id = ANY($1::uuid[])",
        [[...profileIds]],
      );
    }
    await pool.query(
      "DELETE FROM local_artifacts WHERE object_key LIKE 'retention-test/%'",
    );
    await database.close();
    await pool.end();
  });

  async function insertRequest(id: string, cleanBy: Date): Promise<void> {
    fixtureIds.add(id);
    await pool.query(
      `INSERT INTO requests (
         id, kind, api_version, team_id, origin, target_hint, dr_clean_by
       ) VALUES ($1, 'scrape', 'v2', $2, 'test', 'retention test', $3)`,
      [id, ownerId, cleanBy],
    );
  }

  async function insertEveryOperationalDependent(
    requestId: string,
  ): Promise<string> {
    const ids = Object.fromEntries(
      operationalTableNames.map(table => [table, randomUUID()]),
    ) as Record<(typeof operationalTableNames)[number], string>;

    await pool.query(
      `INSERT INTO scrapes (
         id, request_id, url, is_successful, time_taken, team_id,
         credits_cost
       ) VALUES ($1, $2, 'https://example.com/scrape', true, 1, $3, 1)`,
      [ids.scrapes, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO parses (
         id, request_id, url, is_successful, time_taken, team_id,
         credits_cost
       ) VALUES ($1, $2, 'https://example.com/parse', true, 1, $3, 1)`,
      [ids.parses, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO crawls (
         id, request_id, url, team_id, num_docs, credits_cost, cancelled
       ) VALUES ($1, $2, 'https://example.com/crawl', $3, 1, 1, false)`,
      [ids.crawls, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO batch_scrapes (
         id, request_id, team_id, num_docs, credits_cost, cancelled
       ) VALUES ($1, $2, $3, 1, 1, false)`,
      [ids.batch_scrapes, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO searches (
         id, request_id, query, team_id, time_taken, credits_cost,
         is_successful, num_results
       ) VALUES ($1, $2, 'retention', $3, 1, 1, true, 1)`,
      [ids.searches, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO extracts (
         id, request_id, urls, model_kind, team_id, is_successful,
         credits_cost
       ) VALUES ($1, $2, $3, 'fire-1', $4, true, 1)`,
      [ids.extracts, requestId, ["https://example.com/extract"], ownerId],
    );
    await pool.query(
      `INSERT INTO maps (
         id, request_id, url, team_id, num_results, credits_cost
       ) VALUES ($1, $2, 'https://example.com/map', $3, 1, 1)`,
      [ids.maps, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO llmstxts (
         id, request_id, url, team_id, num_urls, credits_cost
       ) VALUES ($1, $2, 'https://example.com/llms', $3, 1, 1)`,
      [ids.llmstxts, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO deep_researches (
         id, request_id, query, team_id, time_taken, credits_cost
       ) VALUES ($1, $2, 'retention', $3, 1, 1)`,
      [ids.deep_researches, requestId, ownerId],
    );

    for (const table of [
      "research_paper_searches",
      "research_paper_inspects",
      "research_paper_reads",
      "research_related_papers",
      "research_github_searches",
    ] as const) {
      await pool.query(
        `INSERT INTO ${table} (
           id, request_id, target, team_id, num_results, time_taken,
           credits_cost, is_successful
         ) VALUES ($1, $2, 'retention', $3, 1, 1, 1, true)`,
        [ids[table], requestId, ownerId],
      );
    }

    return ids.crawls;
  }

  async function insertReplayCheckpoint(
    requestId: string,
    scrapeId: string,
    statePath: string,
    expiresAt = new Date("2026-07-19T00:00:00.000Z"),
  ): Promise<string> {
    const checkpointId = randomUUID();
    await pool.query(
      `INSERT INTO browser_replay_envelopes (
         scrape_id, request_id, owner_id, version,
         navigation_policy_version, envelope
       ) VALUES ($1, $2, $3, 1, 1, '{}')`,
      [scrapeId, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO browser_replay_checkpoints (
         id, scrape_id, request_id, owner_id, envelope_version, state_path,
         final_url, fingerprint, checksum, byte_size, expires_at
       ) VALUES ($1, $2, $3, $4, 1, $5, 'https://example.com', '{}',
                 $6, 2, $7)`,
      [
        checkpointId,
        scrapeId,
        requestId,
        ownerId,
        statePath,
        "a".repeat(64),
        expiresAt,
      ],
    );
    return checkpointId;
  }

  async function insertScrape(
    requestId: string,
    scrapeId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO scrapes (
         id, request_id, url, is_successful, time_taken, team_id,
         credits_cost
       ) VALUES ($1, $2, 'https://example.com/browser', true, 1, $3, 1)`,
      [scrapeId, requestId, ownerId],
    );
  }

  async function insertCleanupIntent(
    scrapeId: string,
    file: { pathId: string; checksum: string },
    state: "cleanup" | "preparing",
    writerPid?: number,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO browser_replay_checkpoint_cleanup_intents (
         id, scrape_id, owner_id, state_path, checksum, state,
         writer_lease, writer_pid, writer_boot_id, writer_start_time,
         heartbeat_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         CASE WHEN $6 = 'preparing' THEN $7::uuid ELSE NULL END,
         CASE WHEN $6 = 'preparing' THEN $8::integer ELSE NULL END,
         CASE WHEN $6 = 'preparing' THEN $9 ELSE NULL END,
         CASE WHEN $6 = 'preparing' THEN $10 ELSE NULL END,
         CASE WHEN $6 = 'preparing' THEN now() ELSE NULL END
       )`,
      [
        id,
        scrapeId,
        ownerId,
        file.pathId,
        file.checksum,
        state,
        randomUUID(),
        writerPid ?? 101,
        "a".repeat(32),
        "1",
      ],
    );
    return id;
  }

  it("retains a failed cleanup intent and clears it after a missing-file retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retention-intent-"));
    const filesystem = new BrowserStateFilesystem(root);
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    await insertScrape(requestId, scrapeId);
    const old = await filesystem.writeCheckpoint(ownerId, scrapeId, {
      cookies: [],
      origins: [],
    });
    const intentId = await insertCleanupIntent(scrapeId, old, "cleanup");
    const fullPath = path.join(root, old.pathId);
    try {
      await expect(
        runLocalRetentionIteration({
          database,
          artifactStore: null,
          browserStateFilesystem: {
            delete: vi.fn().mockRejectedValue(
              Object.assign(new Error("filesystem secret=do-not-log"), {
                code: "EIO",
              }),
            ),
          },
          now: new Date("2026-07-18T00:00:00.000Z"),
          logger: silentLogger,
        }),
      ).rejects.toMatchObject({ browserStateFailures: 1 });
      const retained = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM requests WHERE id = $1) AS requests,
           (SELECT count(*)::int
              FROM browser_replay_checkpoint_cleanup_intents
             WHERE id = $2) AS intents`,
        [requestId, intentId],
      );
      expect(retained.rows[0]).toEqual({ requests: 1, intents: 1 });
      await expect(access(fullPath)).resolves.toBeUndefined();

      await rm(fullPath);
      await runLocalRetentionIteration({
        database,
        artifactStore: null,
        browserStateFilesystem: filesystem,
        now: new Date("2026-07-18T00:00:01.000Z"),
        logger: silentLogger,
      });
      const cleared = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM requests WHERE id = $1) AS requests,
           (SELECT count(*)::int
              FROM browser_replay_checkpoint_cleanup_intents
             WHERE id = $2) AS intents`,
        [requestId, intentId],
      );
      expect(cleared.rows[0]).toEqual({ requests: 0, intents: 0 });
      await expect(access(fullPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an authoritative checkpoint when a stale intent reuses its path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retention-intent-"));
    const filesystem = new BrowserStateFilesystem(root);
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-19T00:00:00.000Z"));
    await insertScrape(requestId, scrapeId);
    const current = await filesystem.writeCheckpoint(ownerId, scrapeId, {
      current: true,
    });
    const checkpointId = await insertReplayCheckpoint(
      requestId,
      scrapeId,
      current.pathId,
    );
    const intentId = await insertCleanupIntent(
      scrapeId,
      { pathId: current.pathId, checksum: "b".repeat(64) },
      "cleanup",
    );
    const fullPath = path.join(root, current.pathId);
    try {
      const result = await runLocalRetentionIteration({
        database,
        artifactStore: null,
        browserStateFilesystem: filesystem,
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      });

      expect(result).toMatchObject({
        browserStateCandidates: 1,
        browserStateFilesDeleted: 0,
        browserStateFailures: 0,
      });
      await expect(access(fullPath)).resolves.toBeUndefined();
      const retained = await pool.query(
        `SELECT
           (SELECT state_path FROM browser_replay_checkpoints
             WHERE id = $1) AS state_path,
           (SELECT count(*)::int
              FROM browser_replay_checkpoint_cleanup_intents
             WHERE id = $2) AS intents`,
        [checkpointId, intentId],
      );
      expect(retained.rows[0]).toEqual({
        state_path: current.pathId,
        intents: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves batch capacity for cleanup intents behind poison checkpoints", async () => {
    const requestId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    for (let index = 0; index < 50; index += 1) {
      const scrapeId = randomUUID();
      await insertScrape(requestId, scrapeId);
      await insertReplayCheckpoint(
        requestId,
        scrapeId,
        `replay/${ownerId}/${scrapeId}/poison-${index}.json`,
      );
    }
    const cleanupScrapeId = randomUUID();
    await insertScrape(requestId, cleanupScrapeId);
    const cleanupPath = `replay/${ownerId}/${cleanupScrapeId}/cleanup-intent.json`;
    const intentId = await insertCleanupIntent(
      cleanupScrapeId,
      { pathId: cleanupPath, checksum: "b".repeat(64) },
      "cleanup",
    );

    try {
      const failure = await runLocalRetentionIteration({
        database,
        artifactStore: null,
        browserStateFilesystem: {
          delete: vi.fn(async statePath => {
            if (statePath !== cleanupPath) {
              throw Object.assign(new Error("persistent poison"), {
                code: "EIO",
              });
            }
          }),
        },
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      }).catch(error => error);

      expect(failure).toMatchObject({
        browserStateCandidates: 50,
        browserStateFilesDeleted: 1,
        browserStateFailures: 49,
      });
      const retained = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM browser_replay_checkpoints
             WHERE request_id = $1 AND state_path IS NOT NULL) AS checkpoints,
           (SELECT count(*)::int
              FROM browser_replay_checkpoint_cleanup_intents
             WHERE id = $2) AS intents`,
        [requestId, intentId],
      );
      expect(retained.rows[0]).toEqual({ checkpoints: 50, intents: 0 });
    } finally {
      await pool.query("DELETE FROM requests WHERE id = $1", [requestId]);
      fixtureIds.delete(requestId);
    }
  });

  it("retains live and unknown preparing writers but recovers a dead writer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retention-intent-"));
    const filesystem = new BrowserStateFilesystem(root);
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    await insertScrape(requestId, scrapeId);
    const live = await filesystem.writeCheckpoint(ownerId, scrapeId, {
      writer: "live",
    });
    const unknown = await filesystem.writeCheckpoint(ownerId, scrapeId, {
      writer: "unknown",
    });
    const dead = await filesystem.writeCheckpoint(ownerId, scrapeId, {
      writer: "dead",
    });
    const liveId = await insertCleanupIntent(scrapeId, live, "preparing", 101);
    const unknownId = await insertCleanupIntent(
      scrapeId,
      unknown,
      "preparing",
      102,
    );
    const deadId = await insertCleanupIntent(scrapeId, dead, "preparing", 103);
    const identityDatabase = new PgLocalRetentionDatabase(
      integrationDatabaseUrl ?? "postgresql://disabled",
      {
        inspectProcessIdentity: async identity =>
          identity.pid === 101
            ? "live"
            : identity.pid === 102
              ? "unknown"
              : "dead",
      },
    );
    try {
      await runLocalRetentionIteration({
        database: identityDatabase,
        artifactStore: null,
        browserStateFilesystem: filesystem,
        now: new Date("2026-07-18T00:00:00.000Z"),
        logger: silentLogger,
      });

      const retained = await pool.query<{ id: string }>(
        `SELECT id FROM browser_replay_checkpoint_cleanup_intents
          WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[liveId, unknownId, deadId]],
      );
      expect(retained.rows.map(row => row.id).sort()).toEqual(
        [liveId, unknownId].sort(),
      );
      await expect(
        access(path.join(root, live.pathId)),
      ).resolves.toBeUndefined();
      await expect(
        access(path.join(root, unknown.pathId)),
      ).resolves.toBeUndefined();
      await expect(access(path.join(root, dead.pathId))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const request = await pool.query("SELECT 1 FROM requests WHERE id = $1", [
        requestId,
      ]);
      expect(request.rows).toHaveLength(1);
    } finally {
      await identityDatabase.close();
      await pool.query(
        `DELETE FROM browser_replay_checkpoint_cleanup_intents
          WHERE id = ANY($1::uuid[])`,
        [[liveId, unknownId, deadId]],
      );
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists only expired unprotected browser state files", async () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    const replayRequestId = randomUUID();
    const replayScrapeId = randomUUID();
    await insertRequest(replayRequestId, new Date("2026-07-17T00:00:00.000Z"));
    await insertScrape(replayRequestId, replayScrapeId);
    const replayPath = `replay/${ownerId}/${replayScrapeId}/${randomUUID()}.json`;
    const replayId = await insertReplayCheckpoint(
      replayRequestId,
      replayScrapeId,
      replayPath,
    );

    const profileId = randomUUID();
    profileIds.add(profileId);
    await pool.query(
      "INSERT INTO browser_profiles (id, owner_id, name) VALUES ($1, $2, $3)",
      [profileId, ownerId, `retention-${profileId}`],
    );
    const expiredId = randomUUID();
    const futureId = randomUUID();
    const latestId = randomUUID();
    const activeId = randomUUID();
    const generations = [
      [expiredId, 1, new Date("2026-07-17T00:00:00.000Z")],
      [futureId, 2, new Date("2026-07-19T00:00:00.000Z")],
      [latestId, 3, new Date("2026-07-17T00:00:00.000Z")],
      [activeId, 4, new Date("2026-07-17T00:00:00.000Z")],
    ] as const;
    for (const [id, generation, expiresAt] of generations) {
      await pool.query(
        `INSERT INTO browser_profile_generations (
           id, profile_id, generation, state_path, byte_size, checksum,
           expires_at
         ) VALUES ($1, $2, $3, $4, 2, $5, $6)`,
        [
          id,
          profileId,
          generation,
          `profiles/${ownerId}/${profileId}/${randomUUID()}.json`,
          "b".repeat(64),
          expiresAt,
        ],
      );
    }
    await pool.query(
      "UPDATE browser_profiles SET latest_generation_id = $2 WHERE id = $1",
      [profileId, latestId],
    );

    const activeRequestId = randomUUID();
    await insertRequest(activeRequestId, new Date("2026-07-19T00:00:00.000Z"));
    await pool.query(
      `INSERT INTO browser_sessions (
         id, request_id, owner_id, profile_id, profile_generation_id, state,
         absolute_deadline_at, idle_deadline_at, last_activity_at
       ) VALUES ($1, $2, $3, $4, $5, 'ready', $6, $6, $7)`,
      [
        randomUUID(),
        activeRequestId,
        ownerId,
        profileId,
        activeId,
        new Date("2026-07-19T00:00:00.000Z"),
        now,
      ],
    );

    const candidates = await database.listExpiredBrowserStateFiles(now, 50);

    expect(candidates.map(candidate => [candidate.kind, candidate.id])).toEqual(
      [
        ["profile-generation", expiredId],
        ["replay-checkpoint", replayId],
      ],
    );
  });

  it("marks an already-missing checkpoint file deleted with path checksum CAS", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retention-browser-"));
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    await insertScrape(requestId, scrapeId);
    const statePath = `replay/${ownerId}/${scrapeId}/${randomUUID()}.json`;
    const checkpointId = await insertReplayCheckpoint(
      requestId,
      scrapeId,
      statePath,
    );
    try {
      const candidate = (
        await database.listExpiredBrowserStateFiles(
          new Date("2026-07-18T00:00:00.000Z"),
          50,
        )
      ).find(item => item.id === checkpointId)!;
      const claim = await database.tryClaimBrowserStateFile(
        candidate,
        new Date("2026-07-18T00:00:00.000Z"),
      );
      expect(claim).not.toBeNull();
      await new BrowserStateFilesystem(root).delete(claim!.file.statePath);
      await expect(claim!.markFileDeleted()).resolves.toBe(true);
      await claim!.release();

      const retained = await pool.query(
        `SELECT state_path, file_deleted_at
           FROM browser_replay_checkpoints WHERE id = $1`,
        [checkpointId],
      );
      expect(retained.rows[0]).toMatchObject({ state_path: null });
      expect(retained.rows[0]!.file_deleted_at).toBeInstanceOf(Date);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes browser file claims and rejects a stale path CAS", async () => {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    await insertScrape(requestId, scrapeId);
    const statePath = `replay/${ownerId}/${scrapeId}/${randomUUID()}.json`;
    const checkpointId = await insertReplayCheckpoint(
      requestId,
      scrapeId,
      statePath,
    );
    const now = new Date("2026-07-18T00:00:00.000Z");
    const candidate = (
      await database.listExpiredBrowserStateFiles(now, 50)
    ).find(item => item.id === checkpointId)!;
    const claim = await database.tryClaimBrowserStateFile(candidate, now);
    expect(claim).not.toBeNull();

    await expect(
      database.tryClaimBrowserStateFile(candidate, now),
    ).resolves.toBeNull();
    const replacementPath = `replay/${ownerId}/${scrapeId}/${randomUUID()}.json`;
    await pool.query(
      "UPDATE browser_replay_checkpoints SET state_path = $2 WHERE id = $1",
      [checkpointId, replacementPath],
    );
    await expect(claim!.markFileDeleted()).resolves.toBe(false);
    await claim!.release();
    await expect(
      database.tryClaimBrowserStateFile(candidate, now),
    ).resolves.toBeNull();

    const retained = await pool.query(
      `SELECT state_path, file_deleted_at
         FROM browser_replay_checkpoints WHERE id = $1`,
      [checkpointId],
    );
    expect(retained.rows[0]).toEqual({
      state_path: replacementPath,
      file_deleted_at: null,
    });
  });

  it("keeps checkpoint metadata and request rows retryable after file failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retention-browser-"));
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    await insertScrape(requestId, scrapeId);
    const statePath = `replay/${ownerId}/${scrapeId}/${randomUUID()}.json`;
    const fullPath = path.join(root, statePath);
    await mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 });
    await writeFile(fullPath, "{}", { mode: 0o600 });
    const checkpointId = await insertReplayCheckpoint(
      requestId,
      scrapeId,
      statePath,
    );
    try {
      await expect(
        runLocalRetentionIteration({
          database,
          artifactStore: null,
          browserStateFilesystem: {
            delete: vi.fn().mockRejectedValue(new Error("filesystem offline")),
          },
          now: new Date("2026-07-18T00:00:00.000Z"),
          logger: silentLogger,
        }),
      ).rejects.toBeInstanceOf(Error);
      const retained = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM requests WHERE id = $1) AS requests,
           (SELECT count(*)::int FROM scrapes WHERE id = $2) AS scrapes,
           (SELECT count(*)::int FROM browser_replay_checkpoints
             WHERE id = $3 AND state_path = $4) AS checkpoints`,
        [requestId, scrapeId, checkpointId, statePath],
      );
      expect(retained.rows[0]).toEqual({
        requests: 1,
        scrapes: 1,
        checkpoints: 1,
      });

      await runLocalRetentionIteration({
        database,
        artifactStore: null,
        browserStateFilesystem: new BrowserStateFilesystem(root),
        now: new Date("2026-07-18T00:00:01.000Z"),
        logger: silentLogger,
      });
      await expect(access(fullPath)).rejects.toMatchObject({ code: "ENOENT" });
      const deleted = await pool.query("SELECT 1 FROM requests WHERE id = $1", [
        requestId,
      ]);
      expect(deleted.rows).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not cascade a request while its checkpoint path is pending", async () => {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    await insertScrape(requestId, scrapeId);
    const statePath = `replay/${ownerId}/${scrapeId}/${randomUUID()}.json`;
    await insertReplayCheckpoint(requestId, scrapeId, statePath);

    const result = await database.deleteExpiredOperationalRows(
      new Date("2026-07-18T00:00:00.000Z"),
      50,
    );

    expect(result.requestIds).not.toContain(requestId);
    const retained = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM requests WHERE id = $1) AS requests,
         (SELECT count(*)::int FROM browser_replay_checkpoints
           WHERE request_id = $1 AND state_path = $2) AS checkpoints`,
      [requestId, statePath],
    );
    expect(retained.rows[0]).toEqual({ requests: 1, checkpoints: 1 });
  });

  it("does not cascade a request while its browser artifact is pending", async () => {
    const requestId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    const objectKey = `browser-runs/${randomUUID()}.json`;
    await pool.query(
      `INSERT INTO local_artifacts (
         object_key, owner_id, request_id, kind, content_type, byte_size,
         delete_after
       ) VALUES ($1, $2, $3, 'browser-run', 'application/json', 2, NULL)`,
      [objectKey, ownerId, requestId],
    );

    const result = await database.deleteExpiredOperationalRows(
      new Date("2026-07-18T00:00:00.000Z"),
      50,
    );

    expect(result.requestIds).not.toContain(requestId);
    const retained = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM requests WHERE id = $1) AS requests,
         (SELECT count(*)::int FROM local_artifacts
           WHERE object_key = $2) AS artifacts`,
      [requestId, objectKey],
    );
    expect(retained.rows[0]).toEqual({ requests: 1, artifacts: 1 });
  });

  it("expires browser artifacts on their parent request deadline", async () => {
    const requestId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    const objectKey = `browser-runs/${randomUUID()}.json`;
    await pool.query(
      `INSERT INTO local_artifacts (
         object_key, owner_id, request_id, kind, content_type, byte_size,
         delete_after
       ) VALUES ($1, $2, $3, 'browser-run', 'application/json', 2, NULL)`,
      [objectKey, ownerId, requestId],
    );
    const events: string[] = [];

    await runLocalRetentionIteration({
      database,
      artifactStore: fakeStore(async key => {
        events.push(`object:${key}`);
      }),
      browserStateFilesystem: null,
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    });

    expect(events).toContain(`object:${objectKey}`);
    const retained = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM local_artifacts
           WHERE object_key = $1) AS artifacts,
         (SELECT count(*)::int FROM requests WHERE id = $2) AS requests`,
      [objectKey, requestId],
    );
    expect(retained.rows[0]).toEqual({ artifacts: 0, requests: 0 });
  });

  it("deletes every expired dependency before requests and preserves future data", async () => {
    const expiredRequest = randomUUID();
    const futureRequest = randomUUID();
    const futureScrapeId = randomUUID();
    await insertRequest(expiredRequest, new Date("2026-07-17T00:00:00.000Z"));
    await insertRequest(futureRequest, new Date("2026-07-19T00:00:00.000Z"));
    const crawlId = await insertEveryOperationalDependent(expiredRequest);
    fixtureIds.add(crawlId);
    await pool.query(
      `INSERT INTO scrapes (
         id, request_id, url, is_successful, time_taken, team_id,
         credits_cost
       ) VALUES ($1, $2, 'https://example.com/future', true, 1, $3, 1)`,
      [futureScrapeId, futureRequest, ownerId],
    );
    await pool.query(
      `INSERT INTO webhook_logs (
         success, team_id, crawl_id, url, event
       ) VALUES (true, $1, $2, 'https://example.com/hook', 'completed')`,
      [ownerId, crawlId],
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION retention_test_require_webhook_delete()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM webhook_logs WHERE crawl_id = OLD.id
        ) THEN
          RAISE EXCEPTION 'webhook must be deleted before crawl';
        END IF;
        RETURN OLD;
      END
      $$
    `);
    await pool.query(`
      CREATE TRIGGER retention_test_require_webhook_delete
      BEFORE DELETE ON crawls
      FOR EACH ROW WHEN (OLD.id = '${crawlId}'::uuid)
      EXECUTE FUNCTION retention_test_require_webhook_delete()
    `);

    let result;
    try {
      result = await database.deleteExpiredOperationalRows(
        new Date("2026-07-18T00:00:00.000Z"),
        50,
      );
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS retention_test_require_webhook_delete ON crawls",
      );
      await pool.query(
        "DROP FUNCTION IF EXISTS retention_test_require_webhook_delete()",
      );
    }

    expect(result).toEqual({
      requestsDeleted: 1,
      dependentRowsDeleted: 15,
      requestIds: [expiredRequest],
    });
    for (const table of operationalTableNames) {
      const deleted = await pool.query(
        `SELECT 1 FROM ${table} WHERE request_id = $1`,
        [expiredRequest],
      );
      expect(deleted.rows, `${table} rows`).toHaveLength(0);
    }
    const deletedWebhook = await pool.query(
      "SELECT 1 FROM webhook_logs WHERE crawl_id = $1",
      [crawlId],
    );
    expect(deletedWebhook.rows).toHaveLength(0);
    const deletedRequest = await pool.query(
      "SELECT 1 FROM requests WHERE id = $1",
      [expiredRequest],
    );
    expect(deletedRequest.rows).toHaveLength(0);
    const retained = await pool.query<{ id: string }>(
      `SELECT id FROM requests WHERE id = $1
       UNION ALL
       SELECT request_id AS id FROM scrapes WHERE id = $2`,
      [futureRequest, futureScrapeId],
    );
    expect(retained.rows).toHaveLength(2);
    const owner = await pool.query("SELECT 1 FROM local_owners WHERE id = $1", [
      ownerId,
    ]);
    expect(owner.rows).toHaveLength(1);
  });

  it("cleans an abandoned async placeholder after its fallback deadline", async () => {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    fixtureIds.add(requestId);
    await pool.query(
      `INSERT INTO scrapes (
         id, request_id, url, is_successful, time_taken, team_id, credits_cost
       ) VALUES ($1, $2, 'https://example.com/abandoned', true, 1, $3, 1)`,
      [scrapeId, requestId, ownerId],
    );

    const placeholder = await pool.query<{
      kind: string;
      created_at: Date;
      dr_clean_by: Date;
    }>(
      `SELECT kind, created_at, dr_clean_by
         FROM requests
        WHERE id = $1`,
      [requestId],
    );
    expect(placeholder.rows).toHaveLength(1);
    expect(placeholder.rows[0]?.kind).toBe("async_placeholder");
    expect(placeholder.rows[0]!.dr_clean_by.getTime()).toBeLessThanOrEqual(
      placeholder.rows[0]!.created_at.getTime() + 24 * 60 * 60 * 1000,
    );

    const result = await database.deleteExpiredOperationalRows(
      new Date(placeholder.rows[0]!.dr_clean_by.getTime() + 1),
      50,
    );

    expect(result.requestsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.dependentRowsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.requestIds).toContain(requestId);
    const retained = await pool.query(
      `SELECT id FROM requests WHERE id = $1
       UNION ALL
       SELECT request_id AS id FROM scrapes WHERE id = $2`,
      [requestId, scrapeId],
    );
    expect(retained.rows).toHaveLength(0);
  });

  it("rolls back request cleanup when a dependent delete fails", async () => {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await insertRequest(requestId, new Date("2026-07-17T00:00:00.000Z"));
    await pool.query(
      `INSERT INTO scrapes (
         id, request_id, url, is_successful, time_taken, team_id,
         credits_cost
       ) VALUES ($1, $2, 'https://example.com/rollback', true, 1, $3, 1)`,
      [scrapeId, requestId, ownerId],
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION retention_test_reject_delete()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced retention test failure';
      END
      $$
    `);
    await pool.query(`
      CREATE TRIGGER retention_test_reject_delete
      BEFORE DELETE ON scrapes
      FOR EACH ROW WHEN (OLD.id = '${scrapeId}'::uuid)
      EXECUTE FUNCTION retention_test_reject_delete()
    `);

    try {
      await expect(
        database.deleteExpiredOperationalRows(
          new Date("2026-07-18T00:00:00.000Z"),
          50,
        ),
      ).rejects.toMatchObject({
        name: "LocalOperationalRetentionError",
        code: "operational_cleanup_failed",
        phase: "operational-cleanup",
        requestIds: [requestId],
      });
      const retained = await pool.query(
        `SELECT id FROM requests WHERE id = $1
         UNION ALL
         SELECT request_id AS id FROM scrapes WHERE id = $2`,
        [requestId, scrapeId],
      );
      expect(retained.rows).toHaveLength(2);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS retention_test_reject_delete ON scrapes",
      );
      await pool.query(
        "DROP FUNCTION IF EXISTS retention_test_reject_delete()",
      );
      await pool.query("DELETE FROM requests WHERE id = $1", [requestId]);
    }
  });

  it("cleans an expired uncorrelated webhook on its independent deadline", async () => {
    const unknownJobId = randomUUID();
    fixtureIds.add(unknownJobId);
    await pool.query(
      `INSERT INTO webhook_logs (
         success, team_id, crawl_id, url, event, dr_clean_by
       ) VALUES (
         true, $1, $2, 'https://example.com/unknown', 'completed',
         '2026-07-17T00:00:00.000Z'
       )`,
      [ownerId, unknownJobId],
    );

    const result = await database.deleteExpiredOperationalRows(
      new Date("2026-07-18T00:00:00.000Z"),
      50,
    );

    expect(result).toEqual({
      requestsDeleted: 0,
      dependentRowsDeleted: 1,
      requestIds: [],
    });
    const retained = await pool.query(
      "SELECT 1 FROM webhook_logs WHERE crawl_id = $1",
      [unknownJobId],
    );
    expect(retained.rows).toHaveLength(0);
  });
});

const minioEndpoint =
  process.env.TEST_MINIO_ENDPOINT ?? process.env.ARTIFACT_MINIO_ENDPOINT;
const minioAccessKey =
  process.env.TEST_MINIO_ACCESS_KEY ?? process.env.ARTIFACT_MINIO_ACCESS_KEY;
const minioSecretKey =
  process.env.TEST_MINIO_SECRET_KEY ?? process.env.ARTIFACT_MINIO_SECRET_KEY;
const minioBucket =
  process.env.TEST_MINIO_BUCKET ??
  process.env.ARTIFACT_MINIO_BUCKET ??
  "firecrawl-artifacts";
const minioRegion =
  process.env.TEST_MINIO_REGION ??
  process.env.ARTIFACT_MINIO_REGION ??
  "us-east-1";
const describeWithDatabaseAndMinio =
  integrationDatabaseUrl && minioEndpoint && minioAccessKey && minioSecretKey
    ? describe
    : describe.skip;

describeWithDatabaseAndMinio("MinIO local retention", () => {
  const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 1 });
  const database = new PgLocalRetentionDatabase(
    integrationDatabaseUrl ?? "postgresql://disabled",
  );
  const store = new MinioArtifactStore({
    endpoint: minioEndpoint ?? "http://disabled",
    accessKey: minioAccessKey ?? "disabled",
    secretKey: minioSecretKey ?? "disabled",
    bucket: minioBucket,
    region: minioRegion,
  });
  const keys = new Set<string>();

  beforeAll(async () => {
    await runApplicationMigrations({
      ...localConfig,
      APPLICATION_DATABASE_URL: integrationDatabaseUrl,
    });
  });

  afterAll(async () => {
    for (const key of keys) {
      await store.delete(key).catch(() => undefined);
    }
    if (keys.size > 0) {
      await pool.query(
        "DELETE FROM local_artifacts WHERE object_key = ANY($1::text[])",
        [[...keys]],
      );
    }
    await database.close();
    await pool.end();
  });

  it("deletes an expired object before removing its manifest", async () => {
    const key = `retention-test/${randomUUID()}.json`;
    keys.add(key);
    const body = Buffer.from('{"expired":true}');
    await store.put({
      key,
      body,
      contentType: "application/json",
    });
    await pool.query(
      `INSERT INTO local_artifacts (
         object_key, owner_id, kind, content_type, byte_size, delete_after
       ) VALUES (
         $1, $2, 'retention-test', 'application/json', $3,
         now() + interval '1 hour'
       )`,
      [key, ownerId, body.byteLength],
    );

    const result = await runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date(Date.now() + 2 * 60 * 60 * 1_000),
      logger: silentLogger,
    });

    expect(result.artifactsDeleted).toBe(1);
    await expect(store.get(key)).resolves.toBeNull();
    const manifest = await pool.query(
      "SELECT 1 FROM local_artifacts WHERE object_key = $1",
      [key],
    );
    expect(manifest.rows).toHaveLength(0);
  });
});
