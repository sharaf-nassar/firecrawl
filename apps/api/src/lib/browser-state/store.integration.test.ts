import { createHash, randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { runApplicationMigrations } from "../../db/migrate";
import { loadBrowserReconciliationSnapshot } from "../browser-runtime/reconciliation-snapshot";
import type { BrowserStartupGate } from "../browser-runtime/startup-gate";
import type { BrowserOperation, SubmitBrowserActionV1 } from "./types";

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
const adapterJobId = "4033373e-ae4e-4114-aa06-04c3d4214b7c";
const adapterSupervisorId = "4033373e-ae4e-4114-aa06-04c3d4214b7d";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function proposalHash(operation: BrowserOperation): string {
  return createHash("sha256").update(canonicalJson(operation)).digest("hex");
}

describeWithDatabase("durable browser state store", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const database = drizzle({ client: pool });
  type StoreModule = typeof import("./store");
  type ActionFacade = ReturnType<StoreModule["createBrowserActionStore"]>;
  type StoreUnderTest = StoreModule & {
    prepareBrowserAction: ActionFacade["prepare"];
    markBrowserActionExecuting: ActionFacade["markExecuting"];
    completeBrowserAction(
      input: import("./store").CompleteBrowserActionInput,
    ): ReturnType<ActionFacade["complete"]>;
  };
  let store: StoreUnderTest;
  let currentAdapterJobId = adapterJobId;
  const controlInstanceId = randomUUID();

  async function createFixture(options?: { state?: "ready" | "executing" }) {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const correlationId = randomUUID();
    const fixtureAdapterJobId = randomUUID();
    const fixtureAdapterSupervisorId = randomUUID();
    currentAdapterJobId = fixtureAdapterJobId;
    const now = new Date();

    await pool.query(
      `INSERT INTO requests
         (id, kind, api_version, team_id, origin, target_hint)
       VALUES ($1, 'scrape', 'v2', $2, 'test', 'browser state')`,
      [requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO scrapes
         (id, request_id, url, is_successful, time_taken, team_id,
          credits_cost)
       VALUES ($1, $2, 'https://example.com', true, 1, $3, 1)`,
      [scrapeId, requestId, ownerId],
    );
    const session = await store.createBrowserSession({
      id: sessionId,
      request_id: requestId,
      owner_id: ownerId,
      scrape_id: scrapeId,
      state: options?.state ?? "ready",
      absolute_deadline_at: new Date(now.getTime() + 300_000).toISOString(),
      idle_deadline_at: new Date(now.getTime() + 60_000).toISOString(),
      last_activity_at: now.toISOString(),
      admission_backend: "redis",
    });
    const run = await store.createInteractRun({
      id: runId,
      request_id: requestId,
      owner_id: ownerId,
      session_id: sessionId,
      scrape_id: scrapeId,
      state: "running",
      mode: "prompt",
      model: "test-model",
      reasoning_effort: "medium",
      deadline_at: new Date(now.getTime() + 120_000).toISOString(),
      correlation_id: correlationId,
      adapter_job_id: fixtureAdapterJobId,
    });
    await pool.query(
      "UPDATE browser_sessions SET current_run_id = $1 WHERE id = $2",
      [run.id, session.id],
    );
    return {
      requestId,
      scrapeId,
      session,
      run,
      adapterJobId: fixtureAdapterJobId,
      adapterSupervisorId: fixtureAdapterSupervisorId,
    };
  }

  function request(
    sequence: number,
    operation: BrowserOperation,
    overrides: Partial<SubmitBrowserActionV1> = {},
  ): SubmitBrowserActionV1 {
    return {
      version: 1,
      adapterJobId: currentAdapterJobId,
      sequence,
      actionId: randomUUID(),
      proposalHash: proposalHash(operation),
      effect: ["extract", "screenshot", "wait"].includes(operation.kind)
        ? "read_only"
        : "side_effecting",
      operation,
      ...overrides,
    };
  }

  async function interruptUnfinishedBrowserWork(now: Date) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await store.interruptUnfinishedBrowserWork(now, {
        query: client.query.bind(client),
        databaseControlEpoch: 1,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function withMutationLease<T>(
    operation: (
      lease: Parameters<typeof store.claimBrowserSessionStop>[0],
    ) => Promise<T>,
    bindingOverride?: {
      apiInstanceId: string;
      controlGenerationNonce: string;
    },
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation({
        epoch: 1,
        scope: "filesystem_and_database",
        binding: {
          apiInstanceId: bindingOverride?.apiInstanceId ?? controlInstanceId,
          databaseControlEpoch: 1,
          processNonce: "a".repeat(43),
          controlGenerationNonce:
            bindingOverride?.controlGenerationNonce ?? "b".repeat(43),
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
  }

  async function loadStoreUnderTest(): Promise<StoreUnderTest> {
    const module = await import("./store.js");
    const actions = module.createBrowserActionStore({
      gate: {
        withBrowserStateMutationLease: (_scope, operation) =>
          withMutationLease(operation),
      } as BrowserStartupGate,
    });
    return {
      ...module,
      prepareBrowserAction: actions.prepare,
      markBrowserActionExecuting: actions.markExecuting,
      completeBrowserAction: async input => {
        const version = await pool.query<{ runtime_epoch: number }>(
          `SELECT s.runtime_epoch
             FROM browser_interact_actions a
             JOIN browser_sessions s ON s.id = a.session_id
            WHERE a.run_id = $1 AND a.action_id = $2`,
          [input.runId, input.actionId],
        );
        const expectedSessionVersion = Number(
          version.rows[0]?.runtime_epoch ?? 0,
        );
        return actions.complete({
          ...input,
          expectedSessionVersion,
          sessionVersion:
            input.outcome === "succeeded"
              ? expectedSessionVersion + 1
              : expectedSessionVersion,
        });
      },
    };
  }

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
    vi.doMock("../../db/connection", () => ({ db: database }));
    store = await loadStoreUnderTest();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE browser_session_activities, browser_capabilities,
                browser_proxy_grants, browser_interact_actions,
                browser_interact_runs, browser_sessions, browser_profiles,
                scrapes, requests RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    vi.doUnmock("../../db/connection");
    await pool.end();
  });

  it("allows exactly one concurrent session compare-and-set", async () => {
    const { session } = await createFixture();
    const results = await Promise.all([
      store.compareAndSetBrowserSessionState(
        session.id,
        ["ready"],
        "executing",
      ),
      store.compareAndSetBrowserSessionState(
        session.id,
        ["ready"],
        "executing",
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("permits exactly one terminal run winner", async () => {
    const { run } = await createFixture();
    const results = await Promise.all([
      store.compareAndSetInteractRunState(run.id, ["running"], "succeeded"),
      store.compareAndSetInteractRunState(run.id, ["running"], "failed"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("persists prompt use and activities without Redis", async () => {
    const { requestId, session, run } = await createFixture();
    await store.markSessionPromptUsed(session.id);
    vi.resetModules();
    vi.doMock("../../db/connection", () => ({ db: database }));
    store = await loadStoreUnderTest();
    expect(await store.didSessionUsePrompt(session.id)).toBe(true);

    await store.appendBrowserActivity({
      request_id: requestId,
      owner_id: ownerId,
      session_id: session.id,
      run_id: run.id,
      mode: "prompt",
      timeout_ms: 1_000,
      source: "interact",
      correlation_id: run.correlation_id,
    });
    const activity = await pool.query(
      "SELECT count(*)::int AS count FROM browser_session_activities",
    );
    expect(activity.rows[0]?.count).toBe(1);
  });

  it("grants one profile writer while reads remain lease-free", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const profileId = randomUUID();
    await pool.query(
      "INSERT INTO browser_profiles (id, owner_id, name) VALUES ($1, $2, $3)",
      [profileId, ownerId, `profile-${profileId}`],
    );

    await expect(
      store.acquireProfileWriter({
        profileId,
        sessionId: first.session.id,
      }),
    ).resolves.toEqual({ profileId, sessionId: first.session.id });
    await expect(
      store.acquireProfileWriter({
        profileId,
        sessionId: second.session.id,
      }),
    ).rejects.toMatchObject({
      name: "ProfileLockedError",
      code: "profile_locked",
    });
    expect(
      await store.getReadyBrowserSessionForScrape(ownerId, first.scrapeId),
    ).toMatchObject({
      id: first.session.id,
    });
    expect(await store.releaseProfileWriter(profileId, first.session.id)).toBe(
      true,
    );
  });

  it("elects one durable stop owner and completes terminal cleanup", async () => {
    const fixture = await createFixture({ state: "executing" });
    const claims = await Promise.all([
      withMutationLease(lease =>
        store.claimBrowserSessionStop(lease, fixture.session.id, "requested"),
      ),
      withMutationLease(lease =>
        store.claimBrowserSessionStop(lease, fixture.session.id, "requested"),
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(claim).toMatchObject({
      runId: fixture.run.id,
      profileId: null,
      browserId: null,
      runtimeEpoch: 1,
      requiresPreparedProfile: false,
      stopAttemptId: expect.any(String),
    });
    await withMutationLease(lease =>
      store.finishBrowserSessionStop(
        lease,
        claim,
        fixture.session.id,
        "requested",
        "destroyed",
      ),
    );
    const session = await pool.query(
      `SELECT state, current_run_id, terminal_at, terminal_reason
         FROM browser_sessions
        WHERE id = $1`,
      [fixture.session.id],
    );
    expect(session.rows[0]).toMatchObject({
      state: "destroyed",
      current_run_id: null,
      terminal_at: expect.any(Date),
      terminal_reason: "requested",
    });
    const run = await pool.query(
      `SELECT state, cancelled_at, finished_at
         FROM browser_interact_runs
        WHERE id = $1`,
      [fixture.run.id],
    );
    expect(run.rows[0]).toMatchObject({
      state: "cancelled",
      cancelled_at: expect.any(Date),
      finished_at: expect.any(Date),
    });
  });

  it("reclaims an expired stop lease and fences the abandoned attempt", async () => {
    const fixture = await createFixture({ state: "ready" });
    const abandoned = await withMutationLease(lease =>
      store.claimBrowserSessionStop(lease, fixture.session.id, "requested"),
    );
    expect(abandoned).toMatchObject({ stopAttemptId: expect.any(String) });
    await pool.query(
      `UPDATE browser_sessions
          SET stop_lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [fixture.session.id],
    );

    const reclaimed = await withMutationLease(lease =>
      store.claimBrowserSessionStop(lease, fixture.session.id, "requested"),
    );
    expect(reclaimed).toMatchObject({
      stopAttemptId: expect.any(String),
    });
    expect(reclaimed?.stopAttemptId).not.toBe(abandoned?.stopAttemptId);
    await expect(
      withMutationLease(lease =>
        store.finishBrowserSessionStop(
          lease,
          abandoned!,
          fixture.session.id,
          "requested",
          "destroyed",
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      withMutationLease(lease =>
        store.finishBrowserSessionStop(
          lease,
          reclaimed!,
          fixture.session.id,
          "requested",
          "destroyed",
        ),
      ),
    ).resolves.toMatchObject({ sessionId: fixture.session.id });
  });

  it("claims and terminalizes a direct session with no run", async () => {
    const requestId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO requests
         (id, kind, api_version, team_id, origin, target_hint)
       VALUES ($1, 'scrape', 'v2', $2, 'test', 'direct session')`,
      [requestId, ownerId],
    );
    await pool.query(
      `INSERT INTO browser_sessions
         (id, request_id, owner_id, state, absolute_deadline_at,
          idle_deadline_at, last_activity_at, ttl_total,
          ttl_without_activity, billing_endpoint)
       VALUES ($1, $2, $3, 'ready', now() + interval '10 minutes',
               now() + interval '5 minutes', now(), 600, 300, 'browser')`,
      [sessionId, requestId, ownerId],
    );

    const claim = await withMutationLease(lease =>
      store.claimBrowserSessionStop(lease, sessionId, "requested"),
    );
    expect(claim).toMatchObject({
      runId: null,
      runtimeEpoch: 1,
      stopAttemptId: expect.any(String),
    });
    await withMutationLease(lease =>
      store.finishBrowserSessionStop(
        lease,
        claim!,
        sessionId,
        "requested",
        "destroyed",
      ),
    );
    await expect(store.getBrowserSession(sessionId)).resolves.toMatchObject({
      state: "destroyed",
      current_run_id: null,
      terminal_at: expect.any(String),
    });
  });

  it("caps requested stop billing at an already-expired idle deadline", async () => {
    const fixture = await createFixture({ state: "ready" });
    await pool.query(
      `UPDATE browser_sessions
          SET created_at = '2026-01-01T00:00:00.000Z',
              idle_deadline_at = '2026-01-02T00:00:00.000Z',
              absolute_deadline_at = '2026-03-01T00:00:00.000Z'
        WHERE id = $1`,
      [fixture.session.id],
    );

    const claim = await withMutationLease(lease =>
      store.claimBrowserSessionStop(lease, fixture.session.id, "requested"),
    );
    await withMutationLease(lease =>
      store.finishBrowserSessionStop(
        lease,
        claim!,
        fixture.session.id,
        "requested",
        "destroyed",
      ),
    );

    await expect(
      pool.query(
        `SELECT session_duration_ms
           FROM browser_billing_outbox
          WHERE session_id = $1`,
        [fixture.session.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ session_duration_ms: 86_400_000 }],
    });
  });

  it("commits one prepared profile generation with pointer CAS", async () => {
    const fixture = await createFixture({ state: "ready" });
    const profileId = randomUUID();
    const originalGenerationId = randomUUID();
    const preparedGenerationId = randomUUID();
    await pool.query(
      `INSERT INTO browser_profiles
         (id, owner_id, name, writer_session_id)
       VALUES ($1, $2, $3, $4)`,
      [profileId, ownerId, `profile-${profileId}`, fixture.session.id],
    );
    await pool.query(
      `INSERT INTO browser_profile_generations
         (id, profile_id, generation, byte_size, checksum)
       VALUES ($1, $2, 1, 128, $3)`,
      [originalGenerationId, profileId, "1".repeat(64)],
    );
    await pool.query(
      `UPDATE browser_profiles SET latest_generation_id = $2 WHERE id = $1`,
      [profileId, originalGenerationId],
    );
    await pool.query(
      `UPDATE browser_sessions
          SET profile_id = $2, profile_generation_id = $3
        WHERE id = $1`,
      [fixture.session.id, profileId, originalGenerationId],
    );
    const claim = await withMutationLease(lease =>
      store.claimBrowserSessionStop(lease, fixture.session.id, "requested"),
    );
    expect(claim).toMatchObject({ profileId });

    await withMutationLease(lease =>
      store.commitPreparedProfileGeneration(lease, claim!, {
        profileId,
        generationId: preparedGenerationId,
        checksum: "2".repeat(64),
        byteSize: 256,
        prepareToken: "p".repeat(43),
      }),
    );
    const profile = await pool.query(
      `SELECT latest_generation_id, writer_session_id
         FROM browser_profiles
        WHERE id = $1`,
      [profileId],
    );
    const generation = await pool.query(
      `SELECT generation, state_path, byte_size, checksum
         FROM browser_profile_generations
        WHERE id = $1`,
      [preparedGenerationId],
    );
    expect(profile.rows[0]).toMatchObject({
      latest_generation_id: preparedGenerationId,
      writer_session_id: fixture.session.id,
    });
    expect(generation.rows[0]).toEqual({
      generation: 2,
      state_path: `profiles/${profileId}/committed/${preparedGenerationId}`,
      byte_size: "256",
      checksum: "2".repeat(64),
    });
    await expect(
      loadBrowserReconciliationSnapshot(pool),
    ).resolves.toMatchObject({
      references: [
        {
          kind: "profile_generation",
          id: preparedGenerationId,
          path: `profiles/${profileId}/committed/${preparedGenerationId}`,
          checksum: "2".repeat(64),
        },
      ],
    });
  });

  it("validates action bodies, binding, hash, budget, and one in-flight action", async () => {
    const { run } = await createFixture({ state: "executing" });
    const first = request(1, { kind: "click", ref: "button-1" });
    await expect(
      store.prepareBrowserAction(run.id, first),
    ).resolves.toMatchObject({
      kind: "prepared",
      action: { state: "prepared", sequence: 1 },
    });
    await expect(
      store.prepareBrowserAction(run.id, request(2, { kind: "extract" })),
    ).rejects.toMatchObject({ name: "ActionInFlightError" });
    await expect(
      store.prepareBrowserAction(run.id, {
        ...request(2, { kind: "extract" }),
        proposalHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ name: "ActionIdentityMismatchError" });
    await expect(
      store.prepareBrowserAction(run.id, {
        ...request(2, { kind: "extract" }),
        adapterJobId: randomUUID(),
      }),
    ).rejects.toThrow(/adapter job/i);
    await expect(
      store.prepareBrowserAction(run.id, request(26, { kind: "extract" })),
    ).rejects.toMatchObject({ name: "ActionLimitExceededError" });
    await expect(
      store.prepareBrowserAction(run.id, {
        ...request(2, { kind: "extract" }),
        unexpected: true,
      } as SubmitBrowserActionV1),
    ).rejects.toThrow();

    const gapFixture = await createFixture({ state: "executing" });
    await expect(
      store.prepareBrowserAction(
        gapFixture.run.id,
        request(2, { kind: "extract" }),
      ),
    ).rejects.toMatchObject({ name: "ActionIdentityMismatchError" });

    const wrongJobFixture = await createFixture({ state: "executing" });
    await expect(
      store.prepareBrowserAction(
        wrongJobFixture.run.id,
        request(1, { kind: "extract" }, { adapterJobId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ name: "ActionIdentityMismatchError" });
    const actions = await pool.query(
      "SELECT count(*)::int AS count FROM browser_interact_actions WHERE run_id = $1",
      [wrongJobFixture.run.id],
    );
    expect(actions.rows).toEqual([{ count: 0 }]);
  });

  it("locks the active session and rejects stale or terminal run bindings", async () => {
    const fixture = await createFixture({ state: "executing" });
    const parallelRun = await store.createInteractRun({
      id: randomUUID(),
      request_id: fixture.requestId,
      owner_id: ownerId,
      session_id: fixture.session.id,
      scrape_id: fixture.scrapeId,
      state: "running",
      mode: "prompt",
      model: "test-model",
      reasoning_effort: "medium",
      deadline_at: new Date(Date.now() + 120_000).toISOString(),
      correlation_id: randomUUID(),
      adapter_job_id: randomUUID(),
    });
    await expect(
      store.prepareBrowserAction(
        parallelRun.id,
        request(1, { kind: "extract" }),
      ),
    ).rejects.toThrow(/current run|binding/i);

    const blocker = new Client({ connectionString: databaseUrl });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE browser_sessions
            SET state = 'interrupted', terminal_at = now()
          WHERE id = $1`,
        [fixture.session.id],
      );
      const pending = store.prepareBrowserAction(
        fixture.run.id,
        request(1, { kind: "extract" }),
      );
      await blocker.query("COMMIT");
      await expect(pending).rejects.toThrow(/active session|binding/i);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("returns the bounded per-operation completion margin", async () => {
    const fixture = await createFixture({ state: "executing" });
    const runtimeSessionId = randomUUID();
    await pool.query(
      "UPDATE browser_sessions SET browser_id = $1 WHERE id = $2",
      [runtimeSessionId, fixture.session.id],
    );

    await expect(
      store.getActiveBrowserRunAuthority(fixture.run.id),
    ).resolves.toMatchObject({
      runtimeSessionId,
      perOperationTimeoutMs: 45_000,
    });
  });

  it("returns cached definite observations and rejects changed identities", async () => {
    const { run } = await createFixture({ state: "executing" });
    const action = request(1, { kind: "extract", ref: "main" });
    await store.prepareBrowserAction(run.id, action);
    await store.markBrowserActionExecuting(run.id, action.actionId);
    const observation = await store.completeBrowserAction({
      runId: run.id,
      actionId: action.actionId,
      proposalHash: action.proposalHash,
      outcome: "succeeded",
      result: { kind: "extract", text: "hello" },
      page: {
        url: "https://example.com/result",
        title: "Result",
        snapshotExcerpt: "hello",
      },
    });
    await expect(store.prepareBrowserAction(run.id, action)).resolves.toEqual({
      kind: "cached",
      observation,
    });
    await expect(
      store.prepareBrowserAction(run.id, {
        ...action,
        proposalHash: "1".repeat(64),
      }),
    ).rejects.toMatchObject({ name: "ActionIdentityMismatchError" });
    await expect(
      store.prepareBrowserAction(run.id, {
        ...request(1, { kind: "extract" }),
        actionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: "ActionIdentityMismatchError" });
  });

  it("allows repeated reads but rejects repeated side effects after no-effect", async () => {
    const read = { kind: "extract" } as const;
    const readFixture = await createFixture({ state: "executing" });
    const firstRead = request(1, read);
    await store.prepareBrowserAction(readFixture.run.id, firstRead);
    await store.markBrowserActionExecuting(
      readFixture.run.id,
      firstRead.actionId,
    );
    await store.completeBrowserAction({
      runId: readFixture.run.id,
      actionId: firstRead.actionId,
      proposalHash: firstRead.proposalHash,
      outcome: "failed_no_effect",
      error: { category: "not_found", message: "missing" },
      page: {
        url: "https://example.com",
        title: "Example",
        snapshotExcerpt: "",
      },
    });
    await expect(
      store.prepareBrowserAction(readFixture.run.id, request(2, read)),
    ).resolves.toMatchObject({ kind: "prepared" });

    const sideEffect = { kind: "click", ref: "button-1" } as const;
    const sideFixture = await createFixture({ state: "executing" });
    const firstSide = request(1, sideEffect);
    await store.prepareBrowserAction(sideFixture.run.id, firstSide);
    await store.completeBrowserAction({
      runId: sideFixture.run.id,
      actionId: firstSide.actionId,
      proposalHash: firstSide.proposalHash,
      outcome: "rejected_no_effect",
      error: { category: "policy", message: "blocked" },
      page: {
        url: "https://example.com",
        title: "Example",
        snapshotExcerpt: "",
      },
    });
    await expect(
      store.prepareBrowserAction(sideFixture.run.id, request(2, sideEffect)),
    ).rejects.toMatchObject({ name: "DuplicateSideEffectError" });

    const failedFixture = await createFixture({ state: "executing" });
    const failedSide = request(1, sideEffect);
    await store.prepareBrowserAction(failedFixture.run.id, failedSide);
    await store.markBrowserActionExecuting(
      failedFixture.run.id,
      failedSide.actionId,
    );
    await store.completeBrowserAction({
      runId: failedFixture.run.id,
      actionId: failedSide.actionId,
      proposalHash: failedSide.proposalHash,
      outcome: "failed_no_effect",
      error: { category: "not_found", message: "target disappeared" },
      page: {
        url: "https://example.com",
        title: "Example",
        snapshotExcerpt: "",
      },
    });
    await expect(
      store.prepareBrowserAction(failedFixture.run.id, request(2, sideEffect)),
    ).rejects.toMatchObject({ name: "DuplicateSideEffectError" });
  });

  it("canonicalizes nested operation keys and validates every operation", async () => {
    const operations: BrowserOperation[] = [
      { kind: "navigate", url: "https://example.com/next" },
      { kind: "click", ref: "button" },
      { kind: "type", ref: "input", text: "value", clear: true },
      { kind: "wait", milliseconds: 10 },
      { kind: "extract", ref: "main" },
      { kind: "screenshot", fullPage: true },
    ];
    const fixture = await createFixture({ state: "executing" });
    for (const [index, operation] of operations.entries()) {
      const action = request(index + 1, operation);
      const expectedEffect = ["extract", "screenshot", "wait"].includes(
        operation.kind,
      )
        ? "read_only"
        : "side_effecting";
      expect(action.effect).toBe(expectedEffect);
      await expect(
        store.prepareBrowserAction(fixture.run.id, action),
      ).resolves.toMatchObject({ kind: "prepared" });
      await store.completeBrowserAction({
        runId: fixture.run.id,
        actionId: action.actionId,
        proposalHash: action.proposalHash,
        outcome: "rejected_no_effect",
        error: { category: "coverage", message: "not dispatched" },
        page: {
          url: "https://example.com",
          title: "Example",
          snapshotExcerpt: "",
        },
      });
      await expect(
        store.prepareBrowserAction(fixture.run.id, {
          ...request(index + 2, operation),
          operation: {
            ...operation,
            unexpected: true,
          } as unknown as BrowserOperation,
        }),
      ).rejects.toThrow();
    }
  });

  it("compare-and-sets execution and bounds completion data", async () => {
    const { run } = await createFixture({ state: "executing" });
    const action = request(1, { kind: "extract", ref: "button-1" });
    await store.prepareBrowserAction(run.id, action);
    await expect(
      store.markBrowserActionExecuting(run.id, action.actionId),
    ).resolves.toMatchObject({ state: "executing" });
    await expect(
      store.markBrowserActionExecuting(run.id, action.actionId),
    ).rejects.toMatchObject({ name: "ActionInFlightError" });
    await expect(
      store.completeBrowserAction({
        runId: run.id,
        actionId: action.actionId,
        proposalHash: action.proposalHash,
        outcome: "succeeded",
        result: { kind: "extract", text: "x".repeat(65 * 1024) },
        page: {
          url: "https://example.com",
          title: "Example",
          snapshotExcerpt: "",
        },
      }),
    ).rejects.toThrow(/64 KiB/i);

    const mixedFixture = await createFixture({ state: "executing" });
    const mixed = request(1, { kind: "extract" });
    await store.prepareBrowserAction(mixedFixture.run.id, mixed);
    await store.markBrowserActionExecuting(mixedFixture.run.id, mixed.actionId);
    await expect(
      store.completeBrowserAction({
        runId: mixedFixture.run.id,
        actionId: mixed.actionId,
        proposalHash: mixed.proposalHash,
        outcome: "succeeded",
        result: { kind: "extract", text: "Example" },
        error: { category: "unexpected", message: "must not coexist" },
        page: {
          url: "https://example.com",
          title: "Example",
          snapshotExcerpt: "",
        },
      }),
    ).rejects.toThrow();

    const failureFixture = await createFixture({ state: "executing" });
    const failure = request(1, { kind: "extract" });
    await store.prepareBrowserAction(failureFixture.run.id, failure);
    await store.markBrowserActionExecuting(
      failureFixture.run.id,
      failure.actionId,
    );
    await expect(
      store.completeBrowserAction({
        runId: failureFixture.run.id,
        actionId: failure.actionId,
        proposalHash: failure.proposalHash,
        outcome: "failed_no_effect",
        page: {
          url: "https://example.com",
          title: "Example",
          snapshotExcerpt: "",
        },
      }),
    ).rejects.toThrow();
  });

  it("interrupts unfinished work atomically and preserves terminal rows", async () => {
    const preparedFixture = await createFixture({ state: "executing" });
    const prepared = request(1, { kind: "click", ref: "one" });
    await store.prepareBrowserAction(preparedFixture.run.id, prepared);

    const executingFixture = await createFixture({ state: "executing" });
    const executing = request(1, { kind: "click", ref: "two" });
    await store.prepareBrowserAction(executingFixture.run.id, executing);
    await store.markBrowserActionExecuting(
      executingFixture.run.id,
      executing.actionId,
    );

    const profileId = randomUUID();
    await pool.query(
      "INSERT INTO browser_profiles (id, owner_id, name) VALUES ($1, $2, $3)",
      [profileId, ownerId, `profile-${profileId}`],
    );
    await store.acquireProfileWriter({
      profileId,
      sessionId: executingFixture.session.id,
    });
    await pool.query(
      `INSERT INTO browser_capabilities
         (id, token_hash, owner_id, session_id, run_id, adapter_job_id,
          adapter_supervisor_id, adapter_process_id, activated_at, operations,
          origins, navigation_policy_version, call_limit, byte_limit,
          wall_deadline_at, per_operation_timeout_ms, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 4242, now(), '[]', '[]',
               1, 1, 1, now() + interval '1 minute', 1000,
               now() + interval '1 minute')`,
      [
        randomUUID(),
        "a".repeat(64),
        ownerId,
        executingFixture.session.id,
        executingFixture.run.id,
        executingFixture.adapterJobId,
        executingFixture.adapterSupervisorId,
      ],
    );
    await pool.query(
      `INSERT INTO browser_proxy_grants
         (id, token_hash, owner_id, session_id, permission, use_limit,
          expires_at)
       VALUES ($1, $2, $3, $4, 'interactive', 1,
               now() + interval '1 minute')`,
      [randomUUID(), "b".repeat(64), ownerId, executingFixture.session.id],
    );

    const recovered = await interruptUnfinishedBrowserWork(
      new Date("2026-07-20T23:00:00.000Z"),
    );
    expect(recovered).toEqual({
      preparedActionsCancelled: 1,
      executingActionsUnknown: 1,
      runsInterrupted: 2,
      sessionsInterrupted: 2,
      capabilitiesRevoked: 1,
      grantsRevoked: 1,
      writerLeasesCleared: 1,
    });
    expect(
      await store.getBrowserActionByIdentity(
        preparedFixture.run.id,
        prepared.actionId,
        1,
      ),
    ).toMatchObject({ state: "cancelled_no_effect" });
    expect(
      await store.getBrowserActionByIdentity(
        executingFixture.run.id,
        executing.actionId,
        1,
      ),
    ).toMatchObject({ state: "outcome_unknown" });
    expect(
      await interruptUnfinishedBrowserWork(
        new Date("2026-07-20T23:01:00.000Z"),
      ),
    ).toEqual({
      preparedActionsCancelled: 0,
      executingActionsUnknown: 0,
      runsInterrupted: 0,
      sessionsInterrupted: 0,
      capabilitiesRevoked: 0,
      grantsRevoked: 0,
      writerLeasesCleared: 0,
    });
    const recoveryOutbox = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM browser_billing_outbox
        WHERE session_id IN ($1, $2)`,
      [preparedFixture.session.id, executingFixture.session.id],
    );
    expect(recoveryOutbox.rows[0]?.count).toBe(2);
    const recoveryAdmission = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM browser_admission_cleanup
        WHERE session_id IN ($1, $2)`,
      [preparedFixture.session.id, executingFixture.session.id],
    );
    expect(recoveryAdmission.rows[0]?.count).toBe(2);
  });

  it("caps startup recovery billing at the persisted lifetime deadline", async () => {
    const fixture = await createFixture({ state: "ready" });
    await pool.query(
      `UPDATE browser_sessions
          SET created_at = '2026-01-01T00:00:00.000Z',
              absolute_deadline_at = '2026-01-02T00:00:00.000Z',
              idle_deadline_at = '2026-03-01T00:00:00.000Z'
        WHERE id = $1`,
      [fixture.session.id],
    );

    await interruptUnfinishedBrowserWork(new Date("2026-07-20T23:00:00.000Z"));

    await expect(
      pool.query(
        `SELECT session_duration_ms
           FROM browser_billing_outbox
          WHERE session_id = $1`,
        [fixture.session.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ session_duration_ms: 86_400_000 }],
    });
  });

  it("rolls back every recovery mutation when a later update fails", async () => {
    const fixture = await createFixture({ state: "executing" });
    const action = request(1, { kind: "click", ref: "rollback" });
    await store.prepareBrowserAction(fixture.run.id, action);
    await pool.query(`
      CREATE OR REPLACE FUNCTION browser_recovery_test_fail()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced recovery failure';
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER browser_recovery_test_fail
      BEFORE UPDATE ON browser_interact_runs
      FOR EACH ROW EXECUTE FUNCTION browser_recovery_test_fail()
    `);
    try {
      await expect(
        interruptUnfinishedBrowserWork(new Date()),
      ).rejects.toThrow();
    } finally {
      await pool.query(
        "DROP TRIGGER browser_recovery_test_fail ON browser_interact_runs",
      );
      await pool.query("DROP FUNCTION browser_recovery_test_fail()");
    }
    expect(
      await store.getBrowserActionByIdentity(
        fixture.run.id,
        action.actionId,
        action.sequence,
      ),
    ).toMatchObject({ state: "prepared" });
    expect(await store.getBrowserSession(fixture.session.id)).toMatchObject({
      state: "executing",
    });
  });
});
