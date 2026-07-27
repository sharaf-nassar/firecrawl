import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { getTableName } from "drizzle-orm";
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

const keylessMocks = vi.hoisted(() => ({
  reconcile: vi.fn(async () => true),
  expireReceipt: vi.fn(async () => undefined),
}));

vi.mock("../lib/keyless", () => ({
  reconcileBrowserKeylessCreditsOnce: keylessMocks.reconcile,
  expireBrowserKeylessReconcileReceipt: keylessMocks.expireReceipt,
}));

import { runApplicationMigrations } from "../db/migrate";
import {
  browser_admission_cleanup,
  browser_billing_outbox,
  browser_billing_sink_receipts,
  browser_keyless_usage_log,
} from "../db/schema/public";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "../lib/browser-runtime/startup-gate";
import { drainBrowserBillingOutboxOnce } from "./browser-billing-outbox";

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";

describeWithDatabase("browser billing outbox", () => {
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
        const result = await operation({
          epoch: 1,
          scope: "filesystem_and_database",
          binding,
          transaction: {
            query: client.query.bind(client),
            databaseControlEpoch: 1,
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  } as BrowserStartupGate;

  beforeAll(async () => {
    expect(getTableName(browser_billing_outbox)).toBe("browser_billing_outbox");
    expect(getTableName(browser_billing_sink_receipts)).toBe(
      "browser_billing_sink_receipts",
    );
    expect(getTableName(browser_admission_cleanup)).toBe(
      "browser_admission_cleanup",
    );
    expect(getTableName(browser_keyless_usage_log)).toBe(
      "browser_keyless_usage_log",
    );
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
    keylessMocks.reconcile.mockClear();
    keylessMocks.expireReceipt.mockClear();
    await pool.query(
      `TRUNCATE browser_billing_sink_receipts, browser_billing_outbox,
                browser_sessions, requests RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createPendingOutbox(): Promise<string> {
    const requestId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO requests
         (id, kind, api_version, team_id, origin, target_hint)
       VALUES ($1, 'browser', 'v2', $2, 'test', 'billing outbox')`,
      [requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO browser_sessions (
         id, request_id, owner_id, state, absolute_deadline_at,
         idle_deadline_at, last_activity_at, billing_endpoint,
         terminal_at, terminal_reason
       ) VALUES (
         $1, $2, $3, 'destroyed', now(), now(), now(), 'browser',
         now(), 'requested'
       )`,
      [sessionId, requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO browser_billing_outbox (
         session_id, owner_id, endpoint, session_duration_ms, credits,
         used_prompt
       ) VALUES ($1, $2, 'browser', 30000, 2, false)`,
      [sessionId, ownerId],
    );
    return sessionId;
  }

  it("records every durable sink acknowledgement before delivery", async () => {
    const sessionId = await createPendingOutbox();

    await expect(drainBrowserBillingOutboxOnce(gate)).resolves.toBe(true);

    const result = await pool.query<{
      state: string;
      delivered_at: Date | null;
      legacy_acked_at: Date | null;
      autumn_acked_at: Date | null;
      keyless_acked_at: Date | null;
      attempt_count: number;
    }>(
      `SELECT o.state, o.delivered_at, o.attempt_count,
              r.legacy_acked_at, r.autumn_acked_at, r.keyless_acked_at
         FROM browser_billing_outbox o
         JOIN browser_billing_sink_receipts r USING (session_id)
        WHERE o.session_id = $1`,
      [sessionId],
    );
    expect(result.rows[0]).toMatchObject({
      state: "delivered",
      delivered_at: expect.any(Date),
      legacy_acked_at: expect.any(Date),
      autumn_acked_at: expect.any(Date),
      keyless_acked_at: expect.any(Date),
      attempt_count: 1,
    });
    await expect(drainBrowserBillingOutboxOnce(gate)).resolves.toBe(false);
  });

  it("reclaims an expired delivery lease", async () => {
    const sessionId = await createPendingOutbox();
    await pool.query(
      `UPDATE browser_billing_outbox
          SET lease_token = $2,
              lease_expires_at = now() - interval '1 second'
        WHERE session_id = $1`,
      [sessionId, randomUUID()],
    );

    await expect(drainBrowserBillingOutboxOnce(gate)).resolves.toBe(true);
    await expect(
      pool.query(
        `SELECT 1
           FROM browser_billing_outbox
          WHERE session_id = $1
            AND state = 'delivered'
            AND lease_token IS NULL`,
        [sessionId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("resumes after a committed legacy acknowledgement", async () => {
    const sessionId = await createPendingOutbox();
    await pool.query(
      `INSERT INTO browser_billing_sink_receipts (
         session_id, legacy_acked_at
       ) VALUES ($1, now())`,
      [sessionId],
    );

    await expect(drainBrowserBillingOutboxOnce(gate)).resolves.toBe(true);

    const receipts = await pool.query<{ receipt_count: number }>(
      `SELECT count(*)::int AS receipt_count
         FROM browser_billing_sink_receipts
        WHERE session_id = $1
          AND legacy_acked_at IS NOT NULL
          AND autumn_acked_at IS NOT NULL`,
      [sessionId],
    );
    expect(receipts.rows[0]?.receipt_count).toBe(1);
  });

  it("reconciles keyless Interact credits once before durable delivery", async () => {
    const sessionId = await createPendingOutbox();
    await pool.query(
      `UPDATE browser_billing_outbox
          SET endpoint = 'interact',
              keyless_team_id = $2,
              keyless_reserved_credits = 8,
              credits = 3
        WHERE session_id = $1`,
      [sessionId, "keyless:203.0.113.9"],
    );

    await expect(drainBrowserBillingOutboxOnce(gate)).resolves.toBe(true);
    await expect(drainBrowserBillingOutboxOnce(gate)).resolves.toBe(false);

    expect(keylessMocks.reconcile).toHaveBeenCalledTimes(1);
    expect(keylessMocks.reconcile).toHaveBeenCalledWith(
      "keyless:203.0.113.9",
      8,
      3,
      sessionId,
    );
    expect(keylessMocks.expireReceipt).toHaveBeenCalledTimes(1);
    await expect(
      pool.query(
        `SELECT 1
           FROM browser_billing_outbox outbox
           JOIN browser_billing_sink_receipts receipt USING (session_id)
           JOIN browser_keyless_usage_log usage USING (session_id)
          WHERE outbox.session_id = $1
            AND outbox.state = 'delivered'
            AND usage.credits = 3
            AND receipt.keyless_adjustment_acked_at IS NOT NULL
            AND receipt.keyless_logging_acked_at IS NOT NULL
            AND receipt.keyless_receipt_gc_acked_at IS NOT NULL
            AND receipt.keyless_acked_at IS NOT NULL`,
        [sessionId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("retries failed durable keyless logging without readjusting or duplicating", async () => {
    const sessionId = await createPendingOutbox();
    await pool.query(
      `UPDATE browser_billing_outbox
          SET endpoint = 'interact',
              keyless_team_id = $2,
              keyless_reserved_credits = 8,
              credits = 3
        WHERE session_id = $1`,
      [sessionId, "preview_keyless_203.0.113.10"],
    );
    const beforeKeylessLog = vi
      .fn()
      .mockRejectedValueOnce(new Error("usage log unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(
      drainBrowserBillingOutboxOnce(gate, { beforeKeylessLog }),
    ).rejects.toMatchObject({
      category: "browser_billing_delivery_failed",
    });
    await pool.query(
      `UPDATE browser_billing_outbox
          SET next_attempt_at = now()
        WHERE session_id = $1`,
      [sessionId],
    );
    await expect(
      drainBrowserBillingOutboxOnce(gate, { beforeKeylessLog }),
    ).resolves.toBe(true);

    expect(keylessMocks.reconcile).toHaveBeenCalledTimes(1);
    expect(beforeKeylessLog).toHaveBeenCalledTimes(2);
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
           FROM browser_keyless_usage_log
          WHERE session_id = $1`,
        [sessionId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
