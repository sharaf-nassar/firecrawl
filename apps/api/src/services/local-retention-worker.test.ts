import { randomUUID } from "node:crypto";

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
import { retentionDeadline } from "../lib/local-retention-deadline";
import {
  createLocalRetentionService,
  PgLocalRetentionDatabase,
  runLocalRetentionIteration,
  runLocalRetentionLoop,
  type ArtifactManifestClaim,
  type ExpiredArtifactManifest,
  type LocalRetentionDatabase,
  type RetentionLogger,
} from "./local-retention-worker";

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
  operationalResult = {
    requestsDeleted: 0,
    dependentRowsDeleted: 0,
  };
  artifactLimit: number | undefined;
  operationalLimit: number | undefined;
  operationalNow: Date | undefined;
  operationalRuns = 0;
  manifestDeleteError: Error | undefined;

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
    requestId: `request-${index}`,
    jobId: `job-${index}`,
    deleteAfter: new Date("2026-07-17T00:00:00.000Z"),
    deleteAfterToken: "2026-07-17 00:00:00+00",
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

  it("keeps a manifest when object deletion fails", async () => {
    const database = new FakeDatabase();
    database.manifests = manifests(1);
    const store = fakeStore(async () => {
      throw new Error("storage unavailable with secret=do-not-log");
    });

    const result = await runLocalRetentionIteration({
      database,
      artifactStore: store,
      now: new Date("2026-07-18T00:00:00.000Z"),
      logger: silentLogger,
    });

    expect(result.artifactFailures).toBe(1);
    expect(database.manifests).toHaveLength(1);
    expect(database.events).toEqual(["release:artifact-0", "operational"]);
    expect(silentLogger.error).toHaveBeenCalledWith(
      "Local artifact retention delete failed",
      expect.objectContaining({
        objectKey: "artifact-0",
        errorName: "Error",
      }),
    );
    expect(
      JSON.stringify(vi.mocked(silentLogger.error).mock.calls),
    ).not.toContain("do-not-log");
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
    });
  });
});

describe("runLocalRetentionLoop", () => {
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
    const originalCleanup =
      database.deleteExpiredOperationalRows.bind(database);
    database.deleteExpiredOperationalRows = vi
      .fn()
      .mockRejectedValueOnce(new Error("database secret=do-not-log"))
      .mockImplementation(originalCleanup);
    const controller = new AbortController();
    let sleeps = 0;

    await runLocalRetentionLoop({
      configSource: localConfig,
      database,
      artifactStore: null,
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
      { errorName: "Error" },
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
});

const integrationDatabaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = integrationDatabaseUrl ? describe : describe.skip;

describeWithDatabase("PostgreSQL local retention", () => {
  const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
  const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
  const database = new PgLocalRetentionDatabase(
    integrationDatabaseUrl ?? "postgresql://disabled",
  );
  const fixtureIds = new Set<string>();

  beforeAll(async () => {
    await runApplicationMigrations({
      ...localConfig,
      APPLICATION_DATABASE_URL: integrationDatabaseUrl,
    });
  });

  afterAll(async () => {
    const ids = [...fixtureIds];
    if (ids.length > 0) {
      await pool.query(
        "DELETE FROM webhook_logs WHERE crawl_id = ANY($1::uuid[])",
        [ids],
      );
      for (const table of ["scrapes", "crawls"]) {
        await pool.query(
          `DELETE FROM ${table} WHERE request_id = ANY($1::uuid[])`,
          [ids],
        );
      }
      await pool.query("DELETE FROM requests WHERE id = ANY($1::uuid[])", [
        ids,
      ]);
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

  it("deletes expired dependencies before requests and preserves future data", async () => {
    const expiredRequest = randomUUID();
    const futureRequest = randomUUID();
    const scrapeId = randomUUID();
    const futureScrapeId = randomUUID();
    const crawlId = randomUUID();
    fixtureIds.add(crawlId);
    await insertRequest(expiredRequest, new Date("2026-07-17T00:00:00.000Z"));
    await insertRequest(futureRequest, new Date("2026-07-19T00:00:00.000Z"));
    await pool.query(
      `INSERT INTO scrapes (
         id, request_id, url, is_successful, time_taken, team_id,
         credits_cost
       ) VALUES
         ($1, $2, 'https://example.com/expired', true, 1, $5, 1),
         ($3, $4, 'https://example.com/future', true, 1, $5, 1)`,
      [scrapeId, expiredRequest, futureScrapeId, futureRequest, ownerId],
    );
    await pool.query(
      `INSERT INTO crawls (
         id, request_id, url, team_id, num_docs, credits_cost, cancelled
       ) VALUES ($1, $2, 'https://example.com/crawl', $3, 1, 1, false)`,
      [crawlId, expiredRequest, ownerId],
    );
    await pool.query(
      `INSERT INTO webhook_logs (
         success, team_id, crawl_id, url, event
       ) VALUES (true, $1, $2, 'https://example.com/hook', 'completed')`,
      [ownerId, crawlId],
    );

    const result = await database.deleteExpiredOperationalRows(
      new Date("2026-07-18T00:00:00.000Z"),
      50,
    );

    expect(result).toEqual({ requestsDeleted: 1, dependentRowsDeleted: 3 });
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
      ).rejects.toThrow("forced retention test failure");
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
    }
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
