import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CapabilityDeniedError,
  createCapabilityStore,
  hashCapabilityToken,
} from "./capability-store";
import {
  countInteractActions,
  failAdapterRun,
  finishAdapterRun,
} from "./store";
import { runApplicationMigrations } from "../../db/migrate";
import type { BrowserStartupGate } from "../browser-runtime/startup-gate";

describe("browser capability store", () => {
  it("hashes raw capability tokens without exposing them", () => {
    expect(hashCapabilityToken("secret")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashCapabilityToken("secret")).not.toContain("secret");
  });

  it("uses a sanitized capability denial category", () => {
    expect(new CapabilityDeniedError()).toMatchObject({
      category: "capability_denied",
      message: "Browser capability was denied",
    });
  });
});

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";

describeWithDatabase("durable browser capability bindings", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const gate = {
    async withBrowserStateMutationLease(_scope, operation) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation({
          epoch: 1,
          scope: "filesystem_and_database",
          binding: {
            apiInstanceId: "123e4567-e89b-42d3-a456-426614174000",
            databaseControlEpoch: 1,
            processNonce: "a".repeat(43),
            controlGenerationNonce: "b".repeat(43),
            snapshotDigest: "c".repeat(64),
          },
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
  const capabilities = createCapabilityStore({ gate });

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
      `TRUNCATE browser_capabilities, browser_interact_runs,
                browser_sessions, requests RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function fixture() {
    const requestId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const adapterJobId = randomUUID();
    const adapterSupervisorId = randomUUID();
    const now = new Date();
    await pool.query(
      `INSERT INTO requests
         (id, kind, api_version, team_id, origin, target_hint)
       VALUES ($1, 'scrape', 'v2', $2, 'test', 'capability')`,
      [requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO browser_sessions
         (id, request_id, owner_id, state, absolute_deadline_at,
          idle_deadline_at, last_activity_at)
       VALUES ($1, $2, $3, 'executing', $4, $5, $6)`,
      [
        sessionId,
        requestId,
        ownerId,
        new Date(now.getTime() + 300_000),
        new Date(now.getTime() + 60_000),
        now,
      ],
    );
    await pool.query(
      `INSERT INTO browser_interact_runs
         (id, request_id, owner_id, session_id, mode, state, model,
          reasoning_effort, deadline_at, correlation_id)
       VALUES ($1, $2, $3, $4, 'prompt', 'queued', 'gpt-5.6-terra',
               'medium', $5, $6)`,
      [
        runId,
        requestId,
        ownerId,
        sessionId,
        new Date(now.getTime() + 120_000),
        randomUUID(),
      ],
    );
    await pool.query(
      `UPDATE browser_sessions SET current_run_id = $2 WHERE id = $1`,
      [sessionId, runId],
    );
    const issued = await capabilities.beginAdapterRun({
      runId,
      adapterJobId,
      adapterSupervisorId,
      adapterProcessId: null,
    });
    return {
      runId,
      sessionId,
      adapterJobId,
      adapterSupervisorId,
      token: issued.token,
    };
  }

  it("allows exactly one concurrent adapter activation", async () => {
    const pending = await fixture();
    const binding = {
      adapterJobId: pending.adapterJobId,
      adapterSupervisorId: pending.adapterSupervisorId,
      adapterProcessId: 4242,
    };
    const results = await Promise.allSettled([
      capabilities.activate(pending.runId, binding),
      capabilities.activate(pending.runId, binding),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled"),
    ).toHaveLength(1);
    const run = await pool.query(
      `SELECT state, adapter_process_id
         FROM browser_interact_runs
        WHERE id = $1`,
      [pending.runId],
    );
    const capability = await pool.query(
      `SELECT adapter_process_id, activated_at, token_hash
         FROM browser_capabilities
        WHERE run_id = $1`,
      [pending.runId],
    );
    expect(run.rows).toEqual([{ state: "running", adapter_process_id: 4242 }]);
    expect(capability.rows[0]).toMatchObject({
      adapter_process_id: 4242,
      activated_at: expect.any(Date),
      token_hash: hashCapabilityToken(pending.token),
    });
    expect(JSON.stringify(capability.rows[0])).not.toContain(pending.token);
  });

  it("rolls back run activation when capability CAS fails", async () => {
    const pending = await fixture();
    await capabilities.revoke(pending.runId);
    await expect(
      capabilities.activate(pending.runId, {
        adapterJobId: pending.adapterJobId,
        adapterSupervisorId: pending.adapterSupervisorId,
        adapterProcessId: 4242,
      }),
    ).rejects.toMatchObject({ category: "capability_denied" });
    const run = await pool.query(
      `SELECT state, adapter_process_id
         FROM browser_interact_runs
        WHERE id = $1`,
      [pending.runId],
    );
    expect(run.rows).toEqual([{ state: "starting", adapter_process_id: null }]);
  });

  it("authorizes only the exact active run, session, owner, token, and binding", async () => {
    const pending = await fixture();
    const binding = {
      adapterJobId: pending.adapterJobId,
      adapterSupervisorId: pending.adapterSupervisorId,
      adapterProcessId: 4242,
    };
    await capabilities.activate(pending.runId, binding);
    const exact = {
      token: pending.token,
      ownerId,
      sessionId: pending.sessionId,
      runId: pending.runId,
      ...binding,
    };
    await expect(capabilities.authorize(exact)).resolves.toMatchObject({
      ownerId,
      sessionId: pending.sessionId,
      runId: pending.runId,
      ...binding,
    });

    for (const mismatch of [
      { ...exact, token: "x".repeat(43) },
      { ...exact, ownerId: randomUUID() },
      { ...exact, sessionId: randomUUID() },
      { ...exact, adapterJobId: randomUUID() },
      { ...exact, adapterSupervisorId: randomUUID() },
      { ...exact, adapterProcessId: 4243 },
    ]) {
      await expect(capabilities.authorize(mismatch)).rejects.toMatchObject({
        category: "capability_denied",
      });
    }
    await expect(
      capabilities.authorize({
        ...exact,
        adapterJobId: exact.adapterJobId.toUpperCase(),
      }),
    ).rejects.toMatchObject({ category: "capability_denied" });
  });

  it("persists accepted adapter action counts and terminal results", async () => {
    const successful = await fixture();
    const binding = {
      adapterJobId: successful.adapterJobId,
      adapterSupervisorId: successful.adapterSupervisorId,
      adapterProcessId: 4242,
    };
    await capabilities.activate(successful.runId, binding);
    await expect(
      capabilities.authorize({
        token: successful.token,
        ownerId,
        sessionId: successful.sessionId,
        runId: successful.runId,
        ...binding,
      }),
    ).resolves.toMatchObject(binding);
    await pool.query(
      `INSERT INTO browser_interact_actions
         (id, request_id, owner_id, run_id, session_id, adapter_job_id,
          action_id, sequence, proposal_hash, effect, operation, state,
          result, page_state, finished_at)
       SELECT $1, request_id, owner_id, id, session_id, adapter_job_id,
              $2, 1, $3, 'read_only', $4::jsonb, 'succeeded',
              $5::jsonb, $6::jsonb, now()
         FROM browser_interact_runs
        WHERE id = $7`,
      [
        randomUUID(),
        randomUUID(),
        "a".repeat(64),
        JSON.stringify({ kind: "get_url" }),
        JSON.stringify({ kind: "get_url", url: "https://example.com/" }),
        JSON.stringify({
          url: "https://example.com/",
          title: "Example",
          snapshotExcerpt: "",
        }),
        successful.runId,
      ],
    );
    await expect(
      gate.withBrowserStateMutationLease("filesystem_and_database", lease =>
        countInteractActions(lease, successful.runId),
      ),
    ).resolves.toBe(1);
    await capabilities.revoke(successful.runId);
    await gate.withBrowserStateMutationLease("filesystem_and_database", lease =>
      finishAdapterRun(lease, successful.runId, {
        output: "done",
        turnCount: 2,
        actionCount: 1,
        usage: { inputTokens: 10, outputTokens: 3 },
        protocol: {
          toolEventCount: 0,
          approvalEventCount: 0,
          decisionSchemaVersion: 1,
          observationSchemaVersion: 1,
        },
      }),
    );
    const completed = await pool.query(
      `SELECT r.state, r.output_reference, r.finished_at,
              s.state AS session_state, s.current_run_id
         FROM browser_interact_runs r
         JOIN browser_sessions s ON s.id = r.session_id
        WHERE r.id = $1`,
      [successful.runId],
    );
    expect(completed.rows[0]).toMatchObject({
      state: "succeeded",
      output_reference: {
        version: 1,
        mode: "prompt",
        output: "done",
        turnCount: 2,
        actionCount: 1,
        usage: { inputTokens: 10, outputTokens: 3 },
      },
      finished_at: expect.any(Date),
      session_state: "ready",
      current_run_id: null,
    });

    const failed = await fixture();
    await capabilities.activate(failed.runId, {
      adapterJobId: failed.adapterJobId,
      adapterSupervisorId: failed.adapterSupervisorId,
      adapterProcessId: 4343,
    });
    await capabilities.revoke(failed.runId);
    await gate.withBrowserStateMutationLease("filesystem_and_database", lease =>
      failAdapterRun(
        lease,
        failed.runId,
        Object.assign(new Error("secret detail"), {
          category: "timed_out",
        }),
      ),
    );
    const terminalFailure = await pool.query(
      `SELECT r.state, r.output_reference, r.error_category, r.error_detail,
              s.state AS session_state, s.current_run_id
         FROM browser_interact_runs r
         JOIN browser_sessions s ON s.id = r.session_id
        WHERE r.id = $1`,
      [failed.runId],
    );
    expect(terminalFailure.rows).toEqual([
      {
        state: "timed_out",
        output_reference: null,
        error_category: "timed_out",
        error_detail: "Browser adapter execution failed",
        session_state: "ready",
        current_run_id: null,
      },
    ]);
  });

  it("derives bounded authority and persists only the token digest", async () => {
    const pending = await fixture();
    const stored = await pool.query(
      `SELECT token_hash, owner_id, session_id, run_id, operations, origins,
              navigation_policy_version, call_limit, byte_limit,
              per_operation_timeout_ms, wall_deadline_at, expires_at
         FROM browser_capabilities
        WHERE run_id = $1`,
      [pending.runId],
    );
    expect(stored.rows[0]).toMatchObject({
      token_hash: hashCapabilityToken(pending.token),
      owner_id: ownerId,
      session_id: pending.sessionId,
      run_id: pending.runId,
      origins: [],
      navigation_policy_version: 1,
      call_limit: 25,
      byte_limit: String(1024 * 1024),
      per_operation_timeout_ms: 30_000,
    });
    expect(stored.rows[0].operations).toContain("snapshot");
    expect(stored.rows[0].wall_deadline_at).toEqual(stored.rows[0].expires_at);
    expect(JSON.stringify(stored.rows[0])).not.toContain(pending.token);
  });

  it("denies pending, expired, terminal, and revoked authority", async () => {
    const pending = await fixture();
    const binding = {
      adapterJobId: pending.adapterJobId,
      adapterSupervisorId: pending.adapterSupervisorId,
      adapterProcessId: 4242,
    };
    const exact = {
      token: pending.token,
      ownerId,
      sessionId: pending.sessionId,
      runId: pending.runId,
      ...binding,
    };
    await expect(capabilities.authorize(exact)).rejects.toMatchObject({
      category: "capability_denied",
    });
    await capabilities.activate(pending.runId, binding);
    await pool.query(
      `UPDATE browser_interact_runs
          SET state = 'succeeded', finished_at = now()
        WHERE id = $1`,
      [pending.runId],
    );
    await expect(capabilities.authorize(exact)).rejects.toMatchObject({
      category: "capability_denied",
    });
    await capabilities.revoke(pending.runId);
    await expect(capabilities.authorize(exact)).rejects.toMatchObject({
      category: "capability_denied",
    });

    const expired = await fixture();
    const expiredBinding = {
      adapterJobId: expired.adapterJobId,
      adapterSupervisorId: expired.adapterSupervisorId,
      adapterProcessId: 4343,
    };
    await capabilities.activate(expired.runId, expiredBinding);
    await pool.query(
      `UPDATE browser_capabilities
          SET expires_at = now() - interval '1 second',
              wall_deadline_at = now() - interval '1 second'
        WHERE run_id = $1`,
      [expired.runId],
    );
    await expect(
      capabilities.authorize({
        token: expired.token,
        ownerId,
        sessionId: expired.sessionId,
        runId: expired.runId,
        ...expiredBinding,
      }),
    ).rejects.toMatchObject({ category: "capability_denied" });
  });

  it("restart interruption revokes pending capability without clearing identity", async () => {
    const pending = await fixture();
    await expect(capabilities.interruptUnfinished()).resolves.toBe(1);
    const result = await pool.query(
      `SELECT r.state, r.adapter_job_id, r.adapter_supervisor_id,
              c.revoked_at
         FROM browser_interact_runs r
         JOIN browser_capabilities c ON c.run_id = r.id
        WHERE r.id = $1`,
      [pending.runId],
    );
    expect(result.rows[0]).toMatchObject({
      state: "interrupted",
      adapter_job_id: pending.adapterJobId,
      adapter_supervisor_id: pending.adapterSupervisorId,
      revoked_at: expect.any(Date),
    });
    await expect(
      capabilities.activate(pending.runId, {
        adapterJobId: pending.adapterJobId,
        adapterSupervisorId: pending.adapterSupervisorId,
        adapterProcessId: 4242,
      }),
    ).rejects.toMatchObject({ category: "capability_denied" });
  });
});
