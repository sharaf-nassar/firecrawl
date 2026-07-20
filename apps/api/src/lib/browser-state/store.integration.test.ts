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
import type { BrowserOperation, SubmitBrowserActionV1 } from "./types";

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
const adapterJobId = "4033373e-ae4e-4114-aa06-04c3d4214b7c";

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
  let store: typeof import("./store");

  async function createFixture(options?: { state?: "ready" | "executing" }) {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const correlationId = randomUUID();
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
    });
    const run = await store.createInteractRun({
      id: runId,
      request_id: requestId,
      owner_id: ownerId,
      session_id: sessionId,
      scrape_id: scrapeId,
      state: "running",
      mode: "prompt",
      model: "gpt-5.6-terra",
      reasoning_effort: "medium",
      deadline_at: new Date(now.getTime() + 120_000).toISOString(),
      correlation_id: correlationId,
    });
    await pool.query(
      "UPDATE browser_sessions SET current_run_id = $1 WHERE id = $2",
      [run.id, session.id],
    );
    return { requestId, scrapeId, session, run };
  }

  function request(
    sequence: number,
    operation: BrowserOperation,
    overrides: Partial<SubmitBrowserActionV1> = {},
  ): SubmitBrowserActionV1 {
    return {
      version: 1,
      adapterJobId,
      sequence,
      actionId: randomUUID(),
      proposalHash: proposalHash(operation),
      effect: ["snapshot", "wait", "get_text", "get_url"].includes(
        operation.kind,
      )
        ? "read_only"
        : "side_effecting",
      operation,
      ...overrides,
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
    store = await import("./store.js");
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
    store = await import("./store.js");
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
      store.prepareBrowserAction(run.id, request(2, { kind: "get_url" })),
    ).rejects.toMatchObject({ name: "ActionInFlightError" });
    await expect(
      store.prepareBrowserAction(run.id, {
        ...request(2, { kind: "get_url" }),
        proposalHash: "0".repeat(64),
      }),
    ).rejects.toThrow(/proposal hash/i);
    await expect(
      store.prepareBrowserAction(run.id, {
        ...request(2, { kind: "get_url" }),
        adapterJobId: randomUUID(),
      }),
    ).rejects.toThrow(/adapter job/i);
    await expect(
      store.prepareBrowserAction(run.id, request(26, { kind: "get_url" })),
    ).rejects.toMatchObject({ name: "ActionLimitExceededError" });
    await expect(
      store.prepareBrowserAction(run.id, {
        ...request(2, { kind: "get_url" }),
        unexpected: true,
      } as SubmitBrowserActionV1),
    ).rejects.toThrow();

    const gapFixture = await createFixture({ state: "executing" });
    await expect(
      store.prepareBrowserAction(
        gapFixture.run.id,
        request(2, { kind: "get_url" }),
      ),
    ).rejects.toThrow(/sequence/i);
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
      model: "gpt-5.6-terra",
      reasoning_effort: "medium",
      deadline_at: new Date(Date.now() + 120_000).toISOString(),
      correlation_id: randomUUID(),
    });
    await expect(
      store.prepareBrowserAction(
        parallelRun.id,
        request(1, { kind: "get_url" }),
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
        request(1, { kind: "get_url" }),
      );
      await blocker.query("COMMIT");
      await expect(pending).rejects.toThrow(/active session|binding/i);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("returns cached definite observations and rejects changed identities", async () => {
    const { run } = await createFixture({ state: "executing" });
    const action = request(1, { kind: "get_text", ref: "main" });
    await store.prepareBrowserAction(run.id, action);
    await store.markBrowserActionExecuting(run.id, action.actionId);
    const observation = await store.completeBrowserAction({
      runId: run.id,
      actionId: action.actionId,
      proposalHash: action.proposalHash,
      outcome: "succeeded",
      result: { text: "hello" },
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
        ...request(1, { kind: "get_url" }),
        actionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: "ActionIdentityMismatchError" });
  });

  it("preserves a successful JSON null result across callback replay", async () => {
    const { run } = await createFixture({ state: "executing" });
    const action = request(1, { kind: "get_text", ref: "empty" });
    await store.prepareBrowserAction(run.id, action);
    await store.markBrowserActionExecuting(run.id, action.actionId);
    const original = await store.completeBrowserAction({
      runId: run.id,
      actionId: action.actionId,
      proposalHash: action.proposalHash,
      outcome: "succeeded",
      result: null,
      page: {
        url: "https://example.com/empty",
        title: "Empty",
        snapshotExcerpt: "",
      },
    });
    const replay = await store.prepareBrowserAction(run.id, action);
    expect(replay).toEqual({ kind: "cached", observation: original });
    expect(original).toHaveProperty("result", null);
  });

  it("allows repeated reads but rejects repeated side effects after no-effect", async () => {
    const read = { kind: "get_url" } as const;
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
      { kind: "snapshot" },
      { kind: "click", ref: "button" },
      { kind: "fill", ref: "input", value: "value" },
      { kind: "type", ref: "input", value: "value", delayMs: 10 },
      { kind: "press", ref: "input", key: "Enter" },
      { kind: "select", ref: "select", values: ["one"] },
      { kind: "scroll", deltaX: 0, deltaY: 100 },
      { kind: "wait", milliseconds: 10 },
      { kind: "get_text", ref: "main" },
      { kind: "get_url" },
      { kind: "navigate", url: "https://example.com/next" },
      {
        kind: "evaluate",
        expression: "args",
        args: { z: 1, a: { y: 2, b: 3 } },
      },
    ];
    const fixture = await createFixture({ state: "executing" });
    for (const [index, operation] of operations.entries()) {
      const action = request(index + 1, operation);
      const expectedEffect = [
        "snapshot",
        "wait",
        "get_text",
        "get_url",
      ].includes(operation.kind)
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
    const action = request(1, { kind: "click", ref: "button-1" });
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
        result: "x".repeat(65 * 1024),
        page: {
          url: "https://example.com",
          title: "Example",
          snapshotExcerpt: "",
        },
      }),
    ).rejects.toThrow(/64 KiB/i);

    const mixedFixture = await createFixture({ state: "executing" });
    const mixed = request(1, { kind: "get_url" });
    await store.prepareBrowserAction(mixedFixture.run.id, mixed);
    await store.markBrowserActionExecuting(mixedFixture.run.id, mixed.actionId);
    await expect(
      store.completeBrowserAction({
        runId: mixedFixture.run.id,
        actionId: mixed.actionId,
        proposalHash: mixed.proposalHash,
        outcome: "succeeded",
        result: { url: "https://example.com" },
        error: { category: "unexpected", message: "must not coexist" },
        page: {
          url: "https://example.com",
          title: "Example",
          snapshotExcerpt: "",
        },
      }),
    ).rejects.toThrow();

    const failureFixture = await createFixture({ state: "executing" });
    const failure = request(1, { kind: "get_url" });
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
         (id, token_hash, owner_id, session_id, run_id, adapter_process_id,
          operations, origins, navigation_policy_version, call_limit,
          byte_limit, wall_deadline_at, per_operation_timeout_ms, expires_at)
       VALUES ($1, $2, $3, $4, $5, 1, '[]', '[]', 1, 1, 1,
               now() + interval '1 minute', 1000, now() + interval '1 minute')`,
      [
        randomUUID(),
        "a".repeat(64),
        ownerId,
        executingFixture.session.id,
        executingFixture.run.id,
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

    const recovered = await store.interruptUnfinishedBrowserWork(
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
      await store.interruptUnfinishedBrowserWork(
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
        store.interruptUnfinishedBrowserWork(new Date()),
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
