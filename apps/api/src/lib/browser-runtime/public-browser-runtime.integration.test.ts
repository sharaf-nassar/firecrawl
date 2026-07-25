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

import { runApplicationMigrations } from "../../db/migrate";
import type { BrowserExecutionAdapter } from "./execution-adapter";
import { createPublicBrowserRuntime } from "./public-browser-runtime";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "./startup-gate";

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
const otherOwnerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623d";

const settings = {
  headers: {},
  cookies: [],
  viewport: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  userAgent: "Firecrawl",
  locale: "en-US",
  location: { country: "us-generic", languages: ["en-US"] },
  proxy: { kind: "auto" as const },
  skipTlsVerification: false,
  blockAds: false,
  lockdown: true,
};

describeWithDatabase("public browser runtime PostgreSQL contract", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const secondPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const binding = {
    apiInstanceId: randomUUID(),
    databaseControlEpoch: 1,
    processNonce: Buffer.alloc(32, 1).toString("base64url"),
    controlGenerationNonce: Buffer.alloc(32, 2).toString("base64url"),
    snapshotDigest: "a".repeat(64),
  };
  const gateFor = (databasePool: Pool) =>
    ({
      assertOpen: () => binding,
      withBrowserStateMutationLease: async (
        _kind: "filesystem_and_database",
        callback: (lease: BrowserStateMutationLease) => Promise<unknown>,
      ) => {
        const client = await databasePool.connect();
        try {
          await client.query("BEGIN");
          const value = await callback({
            binding,
            transaction: {
              query: client.query.bind(client),
              databaseControlEpoch: binding.databaseControlEpoch,
            },
          } as BrowserStateMutationLease);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    }) as BrowserStartupGate;
  const gate = gateFor(pool);
  const secondGate = gateFor(secondPool);
  const runtimeSessions = new Map<string, { sessionVersion: number }>();
  const closeSession = vi.fn(async (runtimeSessionId: string) => {
    const session = runtimeSessions.get(runtimeSessionId);
    if (!session) throw new Error("missing runtime");
    runtimeSessions.delete(runtimeSessionId);
    return {
      version: 1 as const,
      runtimeSessionId,
      closed: true as const,
      sessionVersion: session.sessionVersion,
      preparedProfile: null,
    };
  });
  const browserClient = {
    createSession: vi.fn(async () => {
      const runtimeSessionId = randomUUID();
      runtimeSessions.set(runtimeSessionId, { sessionVersion: 1 });
      return {
        version: 1 as const,
        runtimeSessionId,
        state: "ready" as const,
        sessionVersion: 1,
        page: {
          url: "https://fixture.example/",
          title: "Fixture",
          snapshotExcerpt: "ready",
        },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    }),
    getSession: vi.fn(async (runtimeSessionId: string) => ({
      version: 1 as const,
      runtimeSessionId,
      state: "ready" as const,
      sessionVersion:
        runtimeSessions.get(runtimeSessionId)?.sessionVersion ?? 1,
      page: {
        url: "https://fixture.example/",
        title: "Fixture",
        snapshotExcerpt: "ready",
      },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      idleExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    })),
    closeSession,
    finalizeProfile: vi.fn(),
    discardProfile: vi.fn(),
  };
  const adapter: BrowserExecutionAdapter = {
    executePromptRun: vi.fn(async input => {
      await input.onAccepted({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: 4242,
      });
      return {
        output: "done",
        turnCount: 1,
        actionCount: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
        protocol: {
          toolEventCount: 0 as const,
          approvalEventCount: 0 as const,
          decisionSchemaVersion: 1 as const,
          observationSchemaVersion: 1 as const,
        },
      };
    }),
    executeCodeRun: vi.fn(async input => {
      await input.onAccepted({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: 4242,
      });
      return {
        stdout: "ok",
        result: "fixture",
        stderr: "",
        exitCode: 0,
        killed: false,
      };
    }),
    cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
  };
  const runtime = createPublicBrowserRuntime({
    gate,
    browserClient: browserClient as never,
    adapter,
  });
  const secondRuntime = createPublicBrowserRuntime({
    gate: secondGate,
    browserClient: browserClient as never,
    adapter,
  });

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
    await pool.query(
      `INSERT INTO local_owners (id, label, created_at)
       VALUES ($1, 'task12-other-owner', now())
       ON CONFLICT (id) DO NOTHING`,
      [otherOwnerId],
    );
  });

  beforeEach(async () => {
    runtimeSessions.clear();
    vi.clearAllMocks();
    await pool.query(
      `TRUNCATE browser_session_activities, browser_capabilities,
                browser_proxy_grants, browser_interact_actions,
                browser_interact_runs, browser_sessions, browser_profiles,
                scrapes, requests RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await secondPool.end();
  });

  async function createRequest(requestId: string, requestOwnerId = ownerId) {
    await pool.query(
      `INSERT INTO requests
         (id, kind, api_version, team_id, origin, target_hint)
       VALUES ($1, 'browser', 'v2', $2, 'test', 'public browser runtime')`,
      [requestId, requestOwnerId],
    );
  }

  async function createSession(
    overrides: Partial<Parameters<typeof runtime.createSession>[0]> = {},
    targetRuntime = runtime,
  ) {
    const requestId = randomUUID();
    await createRequest(requestId);
    return targetRuntime.createSession({
      requestId,
      ownerId,
      initialUrl: "https://fixture.example/",
      allowedDomains: ["fixture.example"],
      ttlSeconds: 600,
      activityTtlSeconds: 300,
      streamWebView: true,
      replay: null,
      settings,
      publicBase: "http://api.example.test",
      publicWsBase: "ws://api.example.test",
      ...overrides,
    });
  }

  async function createScrape(): Promise<string> {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await createRequest(requestId);
    await pool.query(
      `INSERT INTO scrapes
         (id, request_id, url, is_successful, time_taken, team_id,
          credits_cost)
       VALUES ($1, $2, 'https://fixture.example/start', true, 1, $3, 1)`,
      [scrapeId, requestId, ownerId],
    );
    return scrapeId;
  }

  async function interactInput(
    scrapeId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const requestId = randomUUID();
    await createRequest(requestId);
    return {
      requestId,
      ownerId,
      scrapeId,
      mode: "code" as const,
      source: "return 1",
      language: "node" as const,
      timeoutSeconds: 30,
      correlationId: randomUUID(),
      allowedDomains: ["fixture.example"],
      initialUrl: "https://fixture.example/start",
      replay: {
        version: 1 as const,
        statePath: "replay/owner/scrape/state.json",
        storageState: { cookies: [], origins: [] },
        finalUrl: "https://fixture.example/start",
        fingerprint: {
          finalUrl: "https://fixture.example/start",
          titleSha256: "a".repeat(64),
          bodyTextSha256: "b".repeat(64),
        },
        checksum: "c".repeat(64),
        byteSize: 32,
      },
      settings,
      publicBase: "http://api.example.test",
      publicWsBase: "ws://api.example.test",
      ...overrides,
    };
  }

  it("creates, rotates grants, executes once, and stops idempotently", async () => {
    const created = await createSession();
    const forbiddenRequestId = randomUUID();
    await createRequest(forbiddenRequestId, otherOwnerId);
    expect(created.cdpUrl).toContain("/v2/browser/proxy/");
    expect(JSON.stringify(created)).not.toContain("runtimeSessionId");

    const first = await runtime.listSessions(ownerId, "active", {
      publicBase: "http://api.example.test",
      publicWsBase: "ws://api.example.test",
    });
    const second = await runtime.listSessions(ownerId, "active", {
      publicBase: "http://api.example.test",
      publicWsBase: "ws://api.example.test",
    });
    expect(first[0]?.id).toBe(created.id);
    expect(first[0]?.cdpUrl).not.toBe(second[0]?.cdpUrl);

    await expect(
      runtime.executeSession({
        requestId: forbiddenRequestId,
        ownerId: otherOwnerId,
        sessionId: created.id,
        language: "node",
        source: "return 1",
        timeoutSeconds: 30,
        correlationId: randomUUID(),
        allowedDomains: [],
      }),
    ).rejects.toMatchObject({ category: "browser_forbidden" });
    expect(adapter.executeCodeRun).not.toHaveBeenCalled();

    const executeRequestId = randomUUID();
    await createRequest(executeRequestId);
    await expect(
      runtime.executeSession({
        requestId: executeRequestId,
        ownerId,
        sessionId: created.id,
        language: "node",
        source: "return 1",
        timeoutSeconds: 30,
        correlationId: randomUUID(),
        allowedDomains: ["fixture.example"],
      }),
    ).resolves.toMatchObject({ stdout: "ok", result: "fixture" });
    expect(adapter.executeCodeRun).toHaveBeenCalledTimes(1);
    const attribution = await pool.query<{
      run_request_id: string;
      session_request_id: string;
    }>(
      `SELECT r.request_id AS run_request_id,
              s.request_id AS session_request_id
         FROM browser_interact_runs r
         JOIN browser_sessions s ON s.id = r.session_id
        WHERE r.session_id = $1`,
      [created.id],
    );
    expect(attribution.rows[0]).toEqual({
      run_request_id: executeRequestId,
      session_request_id: executeRequestId,
    });

    await runtime.stopSession(ownerId, created.id);
    await runtime.stopSession(ownerId, created.id);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(
      await runtime.listSessions(ownerId, "active", {
        publicBase: "http://api.example.test",
        publicWsBase: "ws://api.example.test",
      }),
    ).toEqual([]);
  });

  it("durably extends an about:blank session authority and rejects overflow", async () => {
    const created = await createSession({
      initialUrl: "about:blank",
      allowedDomains: [],
    });
    const requestId = randomUUID();
    await createRequest(requestId);
    await expect(
      runtime.executeSession({
        requestId,
        ownerId,
        sessionId: created.id,
        language: "node",
        source: "return 1",
        timeoutSeconds: 30,
        correlationId: randomUUID(),
        allowedDomains: ["new.example"],
      }),
    ).resolves.toMatchObject({ result: "fixture" });
    const authority = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM browser_sessions WHERE id = $1`,
      [created.id],
    );
    expect(JSON.parse(authority.rows[0]!.workspace_id)).toEqual([
      "new.example",
    ]);

    const forbiddenRequestId = randomUUID();
    await createRequest(forbiddenRequestId);
    await expect(
      runtime.executeSession({
        requestId: forbiddenRequestId,
        ownerId,
        sessionId: created.id,
        language: "node",
        source: "return 2",
        timeoutSeconds: 30,
        correlationId: randomUUID(),
        allowedDomains: Array.from(
          { length: 8 },
          (_, index) => `overflow-${index}.example`,
        ),
      }),
    ).rejects.toMatchObject({ category: "target_blocked" });
  });

  it("fails closed and rolls back when external admission mirroring fails", async () => {
    const releaseAdmission = vi.fn(async () => undefined);
    const rejectingRuntime = createPublicBrowserRuntime({
      gate,
      browserClient: browserClient as never,
      adapter,
      getActiveCount: async () => 0,
      acquireAdmission: async () => {
        throw new Error("mirror unavailable");
      },
      releaseAdmission,
    });
    await expect(
      createSession({ concurrencyLimit: 2 }, rejectingRuntime),
    ).rejects.toThrow("mirror unavailable");
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM browser_sessions`,
    );
    expect(rows.rows[0]?.count).toBe(0);
    expect(browserClient.createSession).not.toHaveBeenCalled();
    expect(releaseAdmission).not.toHaveBeenCalled();
  });

  it("atomically enforces a direct team cap across two database pools", async () => {
    const holders = new Set<string>();
    const admission = {
      getActiveCount: vi.fn(async () => holders.size),
      acquireAdmission: vi.fn(async (_owner: string, id: string) => {
        holders.add(id);
      }),
      releaseAdmission: vi.fn(async (_owner: string, id: string) => {
        holders.delete(id);
      }),
    };
    const firstRuntime = createPublicBrowserRuntime({
      gate,
      browserClient: browserClient as never,
      adapter,
      ...admission,
    });
    const otherRuntime = createPublicBrowserRuntime({
      gate: secondGate,
      browserClient: browserClient as never,
      adapter,
      ...admission,
    });
    const results = await Promise.allSettled([
      createSession({ concurrencyLimit: 1 }, firstRuntime),
      createSession({ concurrencyLimit: 1 }, otherRuntime),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      1,
    );
    expect(holders.size).toBe(1);
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM browser_sessions
        WHERE state IN ('creating', 'replaying', 'ready', 'executing')`,
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("admits one implicit session for parallel Interact requests", async () => {
    const scrapeId = await createScrape();
    const holders = new Set<string>();
    const acquireAdmission = vi.fn(async (_owner: string, id: string) => {
      holders.add(id);
    });
    const releaseAdmission = vi.fn(async (_owner: string, id: string) => {
      holders.delete(id);
    });
    const firstRuntime = createPublicBrowserRuntime({
      gate,
      browserClient: browserClient as never,
      adapter,
      getActiveCount: async () => holders.size,
      acquireAdmission,
      releaseAdmission,
    });
    const otherRuntime = createPublicBrowserRuntime({
      gate: secondGate,
      browserClient: browserClient as never,
      adapter,
      getActiveCount: async () => holders.size,
      acquireAdmission,
      releaseAdmission,
    });
    const [firstInput, secondInput] = await Promise.all([
      interactInput(scrapeId, { concurrencyLimit: 10 }),
      interactInput(scrapeId, { concurrencyLimit: 10 }),
    ]);
    const results = await Promise.allSettled([
      firstRuntime.interact(firstInput),
      otherRuntime.interact(secondInput),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM browser_sessions
        WHERE scrape_id = $1
          AND state IN ('creating', 'replaying', 'ready', 'executing')`,
      [scrapeId],
    );
    expect(rows.rows[0]?.count).toBe(1);
    expect(holders.size).toBe(1);
    expect(acquireAdmission).toHaveBeenCalledTimes(2);
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
  });

  it("elects one billable stop owner across two database pools", async () => {
    const created = await createSession();
    const [first, second] = await Promise.all([
      runtime.stopSession(ownerId, created.id),
      secondRuntime.stopSession(ownerId, created.id),
    ]);
    expect([first.stopped, second.stopped].sort()).toEqual([false, true]);
    const owner = first.stopped ? first : second;
    const follower = first.stopped ? second : first;
    expect(owner).toMatchObject({
      stopped: true,
      sessionId: created.id,
      creditsBilled: expect.any(Number),
    });
    expect(follower.creditsBilled).toBeUndefined();
    expect(closeSession).toHaveBeenCalledTimes(1);
    const row = await pool.query<{
      state: string;
      credits_used: number;
      terminal_at: string | Date | null;
    }>(
      `SELECT state, credits_used, terminal_at
         FROM browser_sessions
        WHERE id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toMatchObject({
      state: "destroyed",
      credits_used: expect.any(Number),
    });
    expect(row.rows[0]?.terminal_at).not.toBeNull();
  });

  it("returns 410-compatible expiry before adapter dispatch", async () => {
    const created = await createSession();
    const executeRequestId = randomUUID();
    await createRequest(executeRequestId);
    await pool.query(
      `UPDATE browser_sessions
          SET absolute_deadline_at = now() - interval '1 second'
        WHERE id = $1`,
      [created.id],
    );
    await expect(
      runtime.executeSession({
        requestId: executeRequestId,
        ownerId,
        sessionId: created.id,
        language: "node",
        source: "return 1",
        timeoutSeconds: 30,
        correlationId: randomUUID(),
        allowedDomains: [],
      }),
    ).rejects.toMatchObject({ category: "browser_expired" });
    expect(adapter.executeCodeRun).not.toHaveBeenCalled();
  });

  it("lists destroyed rows without minting replacement grants", async () => {
    const created = await createSession();
    await runtime.stopSession(ownerId, created.id);
    const before = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM browser_proxy_grants
        WHERE session_id = $1`,
      [created.id],
    );

    const destroyed = await runtime.listSessions(ownerId, "destroyed", {
      publicBase: "http://api.example.test",
      publicWsBase: "ws://api.example.test",
    });
    const after = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM browser_proxy_grants
        WHERE session_id = $1`,
      [created.id],
    );

    expect(destroyed).toEqual([
      expect.objectContaining({
        id: created.id,
        state: "destroyed",
        cdpUrl: "",
        liveViewUrl: "",
        interactiveLiveViewUrl: "",
      }),
    ]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("excludes idle-expired active rows and creates a fresh implicit session", async () => {
    const scrapeId = await createScrape();
    const firstInput = await interactInput(scrapeId);
    const first = await runtime.interact(firstInput);
    await pool.query(
      `UPDATE browser_sessions
          SET idle_deadline_at = now() - interval '1 second'
        WHERE id = $1`,
      [first.session.id],
    );
    expect(
      await runtime.listSessions(ownerId, "active", {
        publicBase: "http://api.example.test",
        publicWsBase: "ws://api.example.test",
      }),
    ).toEqual([]);

    const explicitInput = await interactInput(scrapeId, {
      existingSessionId: first.session.id,
    });
    await expect(runtime.interact(explicitInput)).rejects.toMatchObject({
      category: "browser_expired",
    });

    const freshInput = await interactInput(scrapeId);
    const fresh = await runtime.interact(freshInput);
    expect(fresh.session.id).not.toBe(first.session.id);
    expect(browserClient.createSession).toHaveBeenCalledTimes(2);
  });

  it("stops a read-only profile snapshot without a prepared generation", async () => {
    const created = await createSession({
      profile: { name: "snapshot-only", saveChanges: false },
    });

    await expect(
      runtime.stopSession(ownerId, created.id),
    ).resolves.toMatchObject({ stopped: true });
    const row = await pool.query<{ state: string }>(
      `SELECT state FROM browser_sessions WHERE id = $1`,
      [created.id],
    );
    expect(row.rows[0]?.state).toBe("destroyed");
    expect(browserClient.finalizeProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["domains", { allowedDomains: ["other.example"] }],
    ["settings", { settings: { ...settings, locale: "fr-FR" } }],
    ["profile", { profile: { name: "different", saveChanges: false } }],
    [
      "replay",
      {
        replay: {
          version: 1,
          statePath: "replay/owner/scrape/state.json",
          storageState: { cookies: [], origins: [] },
          finalUrl: "https://fixture.example/start",
          fingerprint: {
            finalUrl: "https://fixture.example/start",
            titleSha256: "d".repeat(64),
            bodyTextSha256: "b".repeat(64),
          },
          checksum: "e".repeat(64),
          byteSize: 32,
        },
      },
    ],
  ])("rejects implicit %s compatibility drift", async (_kind, drift) => {
    const scrapeId = await createScrape();
    await runtime.interact(await interactInput(scrapeId));
    const changed = await interactInput(scrapeId, drift);

    await expect(runtime.interact(changed)).rejects.toMatchObject({
      category: "replay_unavailable",
    });
    expect(browserClient.createSession).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized code results and persists no output", async () => {
    const created = await createSession();
    const executeRequestId = randomUUID();
    await createRequest(executeRequestId);
    vi.mocked(adapter.executeCodeRun).mockImplementationOnce(async input => {
      await input.onAccepted({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: 4242,
      });
      return {
        stdout: "x".repeat(256 * 1024 + 1),
        result: "",
        stderr: "",
        exitCode: 0,
        killed: false,
      };
    });

    await expect(
      runtime.executeSession({
        requestId: executeRequestId,
        ownerId,
        sessionId: created.id,
        language: "node",
        source: "return 1",
        timeoutSeconds: 30,
        correlationId: randomUUID(),
        allowedDomains: [],
      }),
    ).rejects.toThrow();
    const persisted = await pool.query<{
      run_state: string;
      output_reference: unknown;
      session_state: string;
    }>(
      `SELECT r.state AS run_state, r.output_reference,
              s.state AS session_state
         FROM browser_interact_runs r
         JOIN browser_sessions s ON s.id = r.session_id
        WHERE r.session_id = $1`,
      [created.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      run_state: "failed",
      output_reference: null,
      session_state: "ready",
    });
  });

  it("cancels an accepted code run and persists one terminal session", async () => {
    const created = await createSession();
    const executeRequestId = randomUUID();
    await createRequest(executeRequestId);
    let accepted!: () => void;
    const acceptedPromise = new Promise<void>(resolve => {
      accepted = resolve;
    });
    vi.mocked(adapter.executeCodeRun).mockImplementationOnce(async input => {
      await input.onAccepted({
        adapterJobId: input.adapterJobId,
        adapterSupervisorId: input.adapterSupervisorId,
        adapterProcessId: 4242,
      });
      accepted();
      return new Promise<never>(() => undefined);
    });
    const execution = runtime.executeSession({
      requestId: executeRequestId,
      ownerId,
      sessionId: created.id,
      language: "node",
      source: "await forever",
      timeoutSeconds: 30,
      correlationId: randomUUID(),
      allowedDomains: [],
    });
    void execution.catch(() => undefined);
    await acceptedPromise;

    await expect(
      runtime.stopSession(ownerId, created.id),
    ).resolves.toMatchObject({ stopped: true });
    await expect(execution).rejects.toMatchObject({ category: "cancelled" });
    const persisted = await pool.query<{
      state: string;
      terminal_at: string | Date | null;
      terminal_count: number;
    }>(
      `SELECT state, terminal_at,
              count(*) OVER ()::int AS terminal_count
         FROM browser_sessions
        WHERE id = $1`,
      [created.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      state: "destroyed",
      terminal_count: 1,
    });
    expect(persisted.rows[0]?.terminal_at).not.toBeNull();
  });
});
