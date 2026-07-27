import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { runApplicationMigrations } from "../db/migrate";
import { config } from "../config";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "../lib/browser-runtime/startup-gate";
import { drainBrowserAdmissionCleanupOnce } from "./browser-admission-cleanup";

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";

describeWithDatabase("browser admission cleanup worker", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const binding = {
    apiInstanceId: randomUUID(),
    databaseControlEpoch: 1,
    processNonce: Buffer.alloc(32, 1).toString("base64url"),
    controlGenerationNonce: Buffer.alloc(32, 2).toString("base64url"),
    snapshotDigest: "a".repeat(64),
  };
  const gate = {
    withBrowserStateMutationLease: async <T>(
      _scope: "filesystem_and_database",
      operation: (lease: BrowserStateMutationLease) => Promise<T>,
    ): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await operation({
          epoch: 1,
          scope: "filesystem_and_database",
          binding,
          transaction: {
            query: client.query.bind(client),
            databaseControlEpoch: 1,
          },
        });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  } as BrowserStartupGate;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runApplicationMigrations({
      LOCAL_PERSISTENCE_ENABLED: true,
      APPLICATION_DATABASE_URL: databaseUrl,
      LOCAL_OWNER_ID: ownerId,
      ARTIFACT_STORE_PROVIDER: "none",
      USE_DB_AUTHENTICATION: false,
    });
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE browser_admission_cleanup, browser_sessions, requests
       RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createCleanup(backend: "redis" | "fdb" | "both") {
    const requestId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO requests (
         id, kind, api_version, team_id, origin, target_hint
       ) VALUES ($1, 'browser', 'v2', $2, 'test', 'admission cleanup')`,
      [requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO browser_sessions (
         id, request_id, owner_id, state, absolute_deadline_at,
         idle_deadline_at, last_activity_at, billing_endpoint,
         admission_backend, terminal_at, terminal_reason
       ) VALUES (
         $1, $2, $3, 'destroyed', now(), now(), now(), 'browser',
         $4, now(), 'requested'
       )`,
      [sessionId, requestId, ownerId, backend],
    );
    await pool.query(
      `INSERT INTO browser_admission_cleanup (
         session_id, owner_id, backend
       ) VALUES ($1, $2, $3)`,
      [sessionId, ownerId, backend],
    );
    return sessionId;
  }

  it("releases every persisted backend and records durable acknowledgement", async () => {
    const sessionId = await createCleanup("both");
    const release = vi.fn(async () => undefined);

    await expect(
      drainBrowserAdmissionCleanupOnce(gate, release, async () => true),
    ).resolves.toBe(true);
    expect(release.mock.calls).toEqual([
      [ownerId, sessionId, "redis"],
      [ownerId, sessionId, "fdb"],
    ]);
    const row = await pool.query(
      `SELECT redis_released_at, fdb_released_at, lease_token
         FROM browser_admission_cleanup
        WHERE session_id = $1`,
      [sessionId],
    );
    expect(row.rows[0]).toMatchObject({
      redis_released_at: expect.any(Date),
      fdb_released_at: expect.any(Date),
      lease_token: null,
    });
  });

  it("releases a failed lease and retries the exact Redis backend", async () => {
    const sessionId = await createCleanup("redis");
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(
      drainBrowserAdmissionCleanupOnce(gate, release),
    ).rejects.toThrow("redis unavailable");
    const failed = await pool.query(
      `SELECT lease_token, attempt_count, last_error_category
         FROM browser_admission_cleanup
        WHERE session_id = $1`,
      [sessionId],
    );
    expect(failed.rows[0]).toMatchObject({
      lease_token: null,
      attempt_count: 1,
      last_error_category: "external_slot_release_failed",
    });
    await pool.query(
      `UPDATE browser_admission_cleanup
          SET next_attempt_at = now()
        WHERE session_id = $1`,
      [sessionId],
    );
    await expect(drainBrowserAdmissionCleanupOnce(gate, release)).resolves.toBe(
      true,
    );
    expect(release).toHaveBeenNthCalledWith(2, ownerId, sessionId, "redis");
  });

  it("treats disabled FDB as non-applicable for historical unknown backend", async () => {
    const sessionId = await createCleanup("both");
    const release = vi.fn(async () => undefined);
    const mutableConfig = config as {
      NUQ_BACKEND?: "pg" | "fdb";
      FDB_CLUSTER_FILE?: string;
    };
    const previousBackend = mutableConfig.NUQ_BACKEND;
    const previousClusterFile = mutableConfig.FDB_CLUSTER_FILE;
    mutableConfig.NUQ_BACKEND = undefined;
    mutableConfig.FDB_CLUSTER_FILE = undefined;

    try {
      await expect(
        drainBrowserAdmissionCleanupOnce(gate, release),
      ).resolves.toBe(true);
    } finally {
      mutableConfig.NUQ_BACKEND = previousBackend;
      mutableConfig.FDB_CLUSTER_FILE = previousClusterFile;
    }

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(ownerId, sessionId, "redis");
    await expect(
      pool.query(
        `SELECT 1
           FROM browser_admission_cleanup
          WHERE session_id = $1
            AND redis_released_at IS NOT NULL
            AND fdb_released_at IS NOT NULL
            AND lease_token IS NULL`,
        [sessionId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
