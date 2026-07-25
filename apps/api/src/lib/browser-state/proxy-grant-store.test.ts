import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { runApplicationMigrations } from "../../db/migrate";
import { createBrowserStartupGate } from "../browser-runtime/startup-gate";
import {
  createBrowserProxyGrantStore,
  hashBrowserProxyGrantToken,
} from "./proxy-grant-store";

describe("browser proxy grant store", () => {
  it("stores only a SHA-256 token hash and redeems exactly once", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    let redeemed = false;
    const gate = {
      withBrowserStateMutationLease: async (_scope: string, operation: any) =>
        operation({
          transaction: {
            query: async (text: string, values?: unknown[]) => {
              queries.push({ text, values });
              if (text.includes("INSERT INTO browser_proxy_grants")) {
                return {
                  rows: [
                    {
                      id: "10000000-0000-4000-8000-000000000001",
                      owner_id: "10000000-0000-4000-8000-000000000002",
                      session_id: "10000000-0000-4000-8000-000000000003",
                      permission: "passive",
                      use_limit: 1,
                      uses: 0,
                      issued_at: "2026-07-25T00:00:00.000Z",
                      redeemed_at: null,
                      revoked_at: null,
                      expires_at: "2026-07-25T00:05:00.000Z",
                    },
                  ],
                };
              }
              if (text.includes("UPDATE browser_proxy_grants")) {
                if (redeemed) return { rows: [] };
                redeemed = true;
                return {
                  rows: [
                    {
                      id: "10000000-0000-4000-8000-000000000001",
                      owner_id: "10000000-0000-4000-8000-000000000002",
                      session_id: "10000000-0000-4000-8000-000000000003",
                      permission: "passive",
                      use_limit: 1,
                      uses: 1,
                      issued_at: "2026-07-25T00:00:00.000Z",
                      redeemed_at: "2026-07-25T00:00:01.000Z",
                      revoked_at: null,
                      expires_at: "2026-07-25T00:05:00.000Z",
                    },
                  ],
                };
              }
              return { rows: [] };
            },
          },
        }),
    };
    const token = Buffer.alloc(32, 1).toString("base64url");
    const store = createBrowserProxyGrantStore({
      gate: gate as never,
      randomToken: () => token,
      randomId: () => "10000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });

    const issued = await store.issue({
      ownerId: "10000000-0000-4000-8000-000000000002",
      sessionId: "10000000-0000-4000-8000-000000000003",
      permission: "passive",
    });
    expect(issued.token).toBe(token);
    expect(JSON.stringify(queries)).not.toContain(token);
    expect(JSON.stringify(queries)).toContain(
      hashBrowserProxyGrantToken(token),
    );
    await expect(store.redeem(token, "passive")).resolves.not.toBeNull();
    await expect(store.redeem(token, "passive")).resolves.toBeNull();
  });

  it("cannot redeem a passive grant as interactive or CDP", async () => {
    const gate = {
      withBrowserStateMutationLease: async (_scope: string, operation: any) =>
        operation({
          transaction: { query: async () => ({ rows: [] }) },
        }),
    };
    const store = createBrowserProxyGrantStore({ gate: gate as never });
    await expect(
      store.redeem("a".repeat(43), "interactive"),
    ).resolves.toBeNull();
    await expect(store.redeem("a".repeat(43), "cdp")).resolves.toBeNull();
  });

  it("issues three separated permissions inside one mutation lease", async () => {
    const leaseCalls: string[] = [];
    const tokens = [1, 2, 3].map(value =>
      Buffer.alloc(32, value).toString("base64url"),
    );
    const gate = {
      withBrowserStateMutationLease: vi.fn(
        async (_scope: string, operation: any) => {
          leaseCalls.push("lease");
          return operation({
            transaction: {
              query: async (_text: string, values: unknown[]) => ({
                rows: [
                  {
                    id: values[0],
                    owner_id: "10000000-0000-4000-8000-000000000002",
                    session_id: "10000000-0000-4000-8000-000000000003",
                    permission: values[3],
                    use_limit: 1,
                    uses: 0,
                    issued_at: values[4],
                    redeemed_at: null,
                    revoked_at: null,
                    expires_at: values[5],
                  },
                ],
              }),
            },
          });
        },
      ),
    };
    let nextId = 10;
    const store = createBrowserProxyGrantStore({
      gate: gate as never,
      randomToken: () => tokens.shift()!,
      randomId: () => {
        const id = nextId;
        nextId += 1;
        return `10000000-0000-4000-8000-${id.toString().padStart(12, "0")}`;
      },
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });
    const issued = await store.issueSet({
      ownerId: "10000000-0000-4000-8000-000000000002",
      sessionId: "10000000-0000-4000-8000-000000000003",
    });
    expect(leaseCalls).toEqual(["lease"]);
    expect([
      issued.passive.permission,
      issued.interactive.permission,
      issued.cdp.permission,
    ]).toEqual(["passive", "interactive", "cdp"]);
    expect(
      new Set([
        issued.passive.token,
        issued.interactive.token,
        issued.cdp.token,
      ]).size,
    ).toBe(3);
  });

  it("revokes every live session grant inside one lease", async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ id: "one" }, { id: "two" }] });
    const gate = {
      withBrowserStateMutationLease: vi.fn(
        async (_scope: string, operation: any) =>
          operation({ transaction: { query } }),
      ),
    };
    const store = createBrowserProxyGrantStore({ gate: gate as never });
    await expect(
      store.revokeSession("10000000-0000-4000-8000-000000000003"),
    ).resolves.toBe(2);
    expect(gate.withBrowserStateMutationLease).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FOR UPDATE"),
      ["10000000-0000-4000-8000-000000000003"],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("revoked_at IS NULL"),
      expect.arrayContaining(["10000000-0000-4000-8000-000000000003"]),
    );
  });

  it("drains an in-flight redeem and rejects issue after gate close", async () => {
    let open = true;
    let inFlight = 0;
    let releaseRedeem!: () => void;
    let redeemReached!: () => void;
    const redeemPaused = new Promise<void>(resolve => {
      redeemReached = resolve;
    });
    const redeemRelease = new Promise<void>(resolve => {
      releaseRedeem = resolve;
    });
    const gate = {
      withBrowserStateMutationLease: async (
        _scope: string,
        operation: (lease: unknown) => Promise<unknown>,
      ) => {
        if (!open) {
          throw Object.assign(new Error("closed"), {
            category: "browser_state_unavailable",
          });
        }
        inFlight += 1;
        try {
          return await operation({
            transaction: {
              query: async (text: string) => {
                if (text.includes("UPDATE browser_proxy_grants")) {
                  redeemReached();
                  await redeemRelease;
                }
                return { rows: [] };
              },
            },
          });
        } finally {
          inFlight -= 1;
        }
      },
    };
    const store = createBrowserProxyGrantStore({ gate: gate as never });
    const redeem = store.redeem(
      Buffer.alloc(32, 5).toString("base64url"),
      "passive",
    );
    await redeemPaused;
    open = false;
    await expect(
      store.issue({
        ownerId: "10000000-0000-4000-8000-000000000002",
        sessionId: "10000000-0000-4000-8000-000000000003",
        permission: "passive",
      }),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
    expect(inFlight).toBe(1);
    releaseRedeem();
    await expect(redeem).resolves.toBeNull();
    expect(inFlight).toBe(0);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("browser proxy grant PostgreSQL contract", () => {
  it("persists hash-only owner-bound grants and atomically consumes once", async () => {
    const ownerId = randomUUID();
    const requestId = randomUUID();
    const sessionId = randomUUID();
    const apiInstanceId = randomUUID();
    const processNonce = Buffer.alloc(32, 11).toString("base64url");
    const controlGenerationNonce = Buffer.alloc(32, 12).toString("base64url");
    await runApplicationMigrations({
      LOCAL_PERSISTENCE_ENABLED: true,
      APPLICATION_DATABASE_URL: databaseUrl,
      LOCAL_OWNER_ID: ownerId,
      ARTIFACT_STORE_PROVIDER: "none",
      USE_DB_AUTHENTICATION: false,
    });
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query(
        `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint
         ) VALUES ($1, 'browser', 'v2', $2, 'test', 'browser grant test')`,
        [requestId, ownerId],
      );
      await pool.query(
        `INSERT INTO browser_sessions (
           id, request_id, owner_id, state, absolute_deadline_at,
           idle_deadline_at, last_activity_at
         ) VALUES (
           $1, $2, $3, 'ready', now() + interval '10 minutes',
           now() + interval '5 minutes', now()
         )`,
        [sessionId, requestId, ownerId],
      );
      await pool.query("DELETE FROM browser_control_generation");
      await pool.query(
        `INSERT INTO browser_control_generation (
           singleton_id, database_control_epoch, api_instance_id,
           process_nonce, control_generation_nonce
         ) VALUES (1, 1, $1, $2, $3)`,
        [apiInstanceId, processNonce, controlGenerationNonce],
      );
      const gate = createBrowserStartupGate({ pool });
      const drain = gate.close("test");
      await drain.drained;
      gate.open(drain, {
        apiInstanceId,
        databaseControlEpoch: 1,
        processNonce,
        controlGenerationNonce,
        snapshotDigest: "d".repeat(64),
      });
      const store = createBrowserProxyGrantStore({ gate });
      const grants = await store.issueSet({ ownerId, sessionId });
      const persisted = await pool.query<{
        token_hash: string;
        permission: string;
        uses: number;
      }>(
        `SELECT token_hash, permission, uses
           FROM browser_proxy_grants
          WHERE session_id = $1
          ORDER BY permission`,
        [sessionId],
      );
      expect(persisted.rows).toHaveLength(3);
      expect(
        persisted.rows.every(row => /^[a-f0-9]{64}$/u.test(row.token_hash)),
      ).toBe(true);
      expect(JSON.stringify(persisted.rows)).not.toContain(
        grants.passive.token,
      );
      await expect(
        store.redeem(grants.passive.token, "interactive"),
      ).resolves.toBeNull();
      await expect(
        store.redeem(grants.passive.token, "passive"),
      ).resolves.toMatchObject({ uses: 1, ownerId, sessionId });
      await expect(
        store.redeem(grants.passive.token, "passive"),
      ).resolves.toBeNull();
      await expect(
        store.issue({
          ownerId: randomUUID(),
          sessionId,
          permission: "passive",
        }),
      ).rejects.toMatchObject({ category: "browser_state_unavailable" });
      await pool.query(
        `UPDATE browser_proxy_grants
            SET expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [grants.interactive.id],
      );
      await expect(
        store.redeem(grants.interactive.token, "interactive"),
      ).resolves.toBeNull();
      await expect(store.revokeSession(sessionId)).resolves.toBe(3);
    } finally {
      await pool.end();
    }
  });

  it("serializes issue behind a stopping session row lock", async () => {
    const ownerId = randomUUID();
    const requestId = randomUUID();
    const sessionId = randomUUID();
    const apiInstanceId = randomUUID();
    const processNonce = Buffer.alloc(32, 21).toString("base64url");
    const controlGenerationNonce = Buffer.alloc(32, 22).toString("base64url");
    await runApplicationMigrations({
      LOCAL_PERSISTENCE_ENABLED: true,
      APPLICATION_DATABASE_URL: databaseUrl,
      LOCAL_OWNER_ID: ownerId,
      ARTIFACT_STORE_PROVIDER: "none",
      USE_DB_AUTHENTICATION: false,
    });
    const issuePool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "browser-grant-issue-race",
    });
    const stopPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "browser-grant-stop-race",
    });
    const stopClient = await stopPool.connect();
    try {
      await stopPool.query(
        `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint
         ) VALUES ($1, 'browser', 'v2', $2, 'test', 'grant race')`,
        [requestId, ownerId],
      );
      await stopPool.query(
        `INSERT INTO browser_sessions (
           id, request_id, owner_id, state, absolute_deadline_at,
           idle_deadline_at, last_activity_at
         ) VALUES (
           $1, $2, $3, 'ready', now() + interval '10 minutes',
           now() + interval '5 minutes', now()
         )`,
        [sessionId, requestId, ownerId],
      );
      await stopPool.query("DELETE FROM browser_control_generation");
      await stopPool.query(
        `INSERT INTO browser_control_generation (
           singleton_id, database_control_epoch, api_instance_id,
           process_nonce, control_generation_nonce
         ) VALUES (1, 1, $1, $2, $3)`,
        [apiInstanceId, processNonce, controlGenerationNonce],
      );
      const gate = createBrowserStartupGate({ pool: issuePool });
      const drain = gate.close("test");
      await drain.drained;
      gate.open(drain, {
        apiInstanceId,
        databaseControlEpoch: 1,
        processNonce,
        controlGenerationNonce,
        snapshotDigest: "e".repeat(64),
      });
      await stopClient.query("BEGIN");
      await stopClient.query(
        `SELECT id FROM browser_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const store = createBrowserProxyGrantStore({ gate });
      const issue = store.issue({
        ownerId,
        sessionId,
        permission: "passive",
      });
      await vi.waitFor(
        async () => {
          const blocked = await stopPool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
               SELECT 1
                 FROM pg_stat_activity
                WHERE application_name = 'browser-grant-issue-race'
                  AND wait_event_type = 'Lock'
             ) AS blocked`,
          );
          expect(blocked.rows[0]?.blocked).toBe(true);
        },
        { timeout: 5_000 },
      );
      await stopClient.query(
        `UPDATE browser_sessions
            SET state = 'stopping'
          WHERE id = $1`,
        [sessionId],
      );
      await stopClient.query(
        `UPDATE browser_proxy_grants
            SET revoked_at = now()
          WHERE session_id = $1
            AND revoked_at IS NULL`,
        [sessionId],
      );
      await stopClient.query("COMMIT");
      await expect(issue).rejects.toMatchObject({
        category: "browser_state_unavailable",
      });
      const live = await stopPool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM browser_proxy_grants
          WHERE session_id = $1
            AND revoked_at IS NULL`,
        [sessionId],
      );
      expect(live.rows[0]?.count).toBe(0);
    } finally {
      await stopClient.query("ROLLBACK").catch(() => undefined);
      stopClient.release();
      await Promise.all([issuePool.end(), stopPool.end()]);
    }
  });
});
