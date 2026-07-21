import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import { runApplicationMigrations } from "../../db/migrate";
import { BrowserStateFilesystem } from "../browser-state/filesystem-store";

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
const cleanupError = vi.fn();

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function processIdentity(pid: number): Promise<{
  bootId: string;
  startTime: string;
}> {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8"))
    .trim()
    .replaceAll("-", "");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const endOfName = stat.lastIndexOf(")");
  return {
    bootId,
    startTime: stat.slice(endOfName + 2).split(" ")[19]!,
  };
}

const storageState = {
  cookies: [
    {
      name: "session",
      value: "private-cookie",
      domain: "example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
  ],
  origins: [
    {
      origin: "https://example.com",
      localStorage: [{ name: "theme", value: "dark" }],
    },
  ],
};

const browserSettings = {
  headers: { Accept: "text/html", Authorization: "private-header" },
  cookies: [],
  viewport: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  userAgent: "replay-test-agent",
  locale: "en-US",
  location: { country: "us-generic", languages: ["en-US"] },
  proxy: { kind: "basic" as const },
  skipTlsVerification: false,
  blockAds: true,
  lockdown: false,
};

function replayCheckpoint(state = storageState) {
  return {
    version: 1 as const,
    storageState: state,
    finalUrl: "https://example.com/final",
    fingerprint: {
      finalUrl: "https://example.com/final",
      titleSha256: checksum("Example title"),
      bodyTextSha256: checksum("Example body"),
    },
    browserSettings,
  };
}

describe("BrowserStateFilesystem public interface", () => {
  it("exposes only the stable checkpoint methods and signatures", () => {
    expect(
      Object.getOwnPropertyNames(BrowserStateFilesystem.prototype).sort(),
    ).toEqual(["constructor", "delete", "readCheckpoint", "writeCheckpoint"]);
    expect(BrowserStateFilesystem.prototype.writeCheckpoint).toHaveLength(3);
    expect(BrowserStateFilesystem.prototype.readCheckpoint).toHaveLength(2);
    expect(BrowserStateFilesystem.prototype.delete).toHaveLength(1);
    expectTypeOf<keyof BrowserStateFilesystem>().toEqualTypeOf<
      "delete" | "readCheckpoint" | "writeCheckpoint"
    >();
    expectTypeOf<
      Parameters<BrowserStateFilesystem["writeCheckpoint"]>
    >().toEqualTypeOf<
      [ownerId: string, scrapeId: string, storageState: unknown]
    >();
  });

  it("runs the internal handoff before the final generation is visible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "firecrawl-handoff-"));
    const scrapeId = randomUUID();
    const marker = path.join(root, "durable-handoff.json");
    try {
      const filesystem = new BrowserStateFilesystem(root, {
        beforeCheckpointWrite: async checkpoint => {
          await expect(
            lstat(path.join(root, checkpoint.pathId)),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const handle = await open(marker, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify(checkpoint));
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      });

      const written = await filesystem.writeCheckpoint(
        ownerId,
        scrapeId,
        storageState,
      );

      expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject(written);
      await expect(
        lstat(path.join(root, written.pathId)),
      ).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describeWithDatabase("scrape replay checkpoint store", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const database = drizzle({ client: pool });
  let root: string;
  let replayStore: typeof import("./replay-store");

  async function createFixture(options?: { requestDeadline?: Date | null }) {
    const requestId = randomUUID();
    const scrapeId = randomUUID();
    await pool.query(
      `INSERT INTO requests
         (id, kind, api_version, team_id, origin, target_hint, dr_clean_by)
       VALUES ($1, 'scrape', 'v2', $2, 'api', 'checkpoint test', $3)`,
      [requestId, ownerId, options?.requestDeadline ?? null],
    );
    await pool.query(
      `INSERT INTO scrapes
         (id, request_id, url, is_successful, time_taken, team_id,
          options, credits_cost)
       VALUES ($1, $2, 'https://example.com', true, 1, $3, $4, 1)`,
      [scrapeId, requestId, ownerId, JSON.stringify({ waitFor: 100 })],
    );
    return { requestId, scrapeId };
  }

  function input(
    fixture: { requestId: string; scrapeId: string },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      requestId: fixture.requestId,
      scrapeId: fixture.scrapeId,
      ownerId,
      url: "https://example.com",
      options: { waitFor: 100 },
      callerOrigin: "api",
      zeroDataRetention: false,
      replayCheckpoint: replayCheckpoint(),
      ...overrides,
    };
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "firecrawl-replay-store-"));
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runApplicationMigrations({
      LOCAL_PERSISTENCE_ENABLED: true,
      APPLICATION_DATABASE_URL: databaseUrl,
      LOCAL_OWNER_ID: ownerId,
      ARTIFACT_STORE_PROVIDER: "none",
      USE_DB_AUTHENTICATION: false,
    });
    vi.doMock("../../config", () => ({
      config: {
        LOCAL_BROWSER_SERVICE_ENABLED: true,
        LOCAL_BROWSER_STATE_ROOT: root,
        LOCAL_RECORD_RETENTION_DAYS: 30,
      },
    }));
    vi.doMock("../../db/connection", () => ({ db: database }));
    vi.doMock("../logger", () => ({
      logger: { child: () => ({ error: cleanupError }) },
    }));
    replayStore = await import("./replay-store.js");
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE browser_replay_checkpoint_cleanup_intents,
                browser_replay_checkpoints, browser_replay_envelopes,
                scrapes, requests RESTART IDENTITY CASCADE`,
    );
    await rm(path.join(root, "replay"), { recursive: true, force: true });
    cleanupError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.doUnmock("../../config");
    vi.doUnmock("../../db/connection");
    vi.doUnmock("../logger");
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });

  it("persists and checksum-verifies a private replay checkpoint", async () => {
    const deadline = new Date(Date.now() + 60_000);
    const fixture = await createFixture({ requestDeadline: deadline });

    await expect(
      replayStore.persistScrapeReplayState(input(fixture)),
    ).resolves.toEqual({ persisted: true });

    const rows = await pool.query<{
      envelopes: number;
      checkpoints: number;
      state_path: string;
      checksum: string;
      expires_at: Date;
    }>(
      `SELECT
         (SELECT count(*)::int FROM browser_replay_envelopes) AS envelopes,
         (SELECT count(*)::int FROM browser_replay_checkpoints) AS checkpoints,
         state_path, checksum, expires_at
       FROM browser_replay_checkpoints WHERE scrape_id = $1`,
      [fixture.scrapeId],
    );
    expect(rows.rows[0]).toMatchObject({ envelopes: 1, checkpoints: 1 });
    expect(rows.rows[0]!.expires_at.getTime()).toBe(deadline.getTime());

    const fullPath = path.join(root, rows.rows[0]!.state_path);
    expect((await lstat(fullPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(fullPath))).mode & 0o777).toBe(0o700);
    expect(fullPath.startsWith(path.join(root, "replay", ownerId))).toBe(true);
    expect(JSON.parse(await readFile(fullPath, "utf8"))).toEqual(storageState);

    const loaded = await replayStore.loadScrapeReplayState(
      ownerId,
      fixture.scrapeId,
    );
    expect(loaded).toMatchObject({
      kind: "checkpoint",
      checkpoint: {
        storageState,
        checksum: rows.rows[0]!.checksum,
      },
    });
  });

  it("calls the filesystem through its three-argument write contract", async () => {
    const fixture = await createFixture();
    const originalWrite = BrowserStateFilesystem.prototype.writeCheckpoint;
    let observed = false;
    vi.spyOn(
      BrowserStateFilesystem.prototype,
      "writeCheckpoint",
    ).mockImplementation(async function (owner, scrape, state) {
      expect(arguments).toHaveLength(3);
      observed = true;
      return originalWrite.call(this, owner, scrape, state);
    });

    await expect(
      replayStore.persistScrapeReplayState(input(fixture)),
    ).resolves.toEqual({ persisted: true });
    expect(observed).toBe(true);
  });

  it("durably records cleanup intent before a final generation can exist", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(root, "replay"), { mode: 0o755 });
    vi.spyOn(BrowserStateFilesystem.prototype, "delete").mockRejectedValue(
      new Error("injected rollback delete failure"),
    );

    await expect(
      replayStore.persistScrapeReplayState(input(fixture)),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });

    const intents = await pool.query<{
      state_path: string;
      checksum: string;
      state: string;
      attempts: number;
    }>(
      `SELECT state_path, checksum, state, attempts
         FROM browser_replay_checkpoint_cleanup_intents
        WHERE scrape_id = $1`,
      [fixture.scrapeId],
    );
    expect(intents.rows).toHaveLength(1);
    expect(intents.rows[0]).toMatchObject({
      state: "cleanup",
      attempts: 1,
    });
    expect(intents.rows[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      lstat(path.join(root, intents.rows[0]!.state_path)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically replaces metadata without staging debris", async () => {
    const fixture = await createFixture();
    await replayStore.persistScrapeReplayState(input(fixture));
    const replacement = {
      cookies: [],
      origins: [{ origin: "https://example.com", localStorage: [] }],
    };
    await replayStore.persistScrapeReplayState(
      input(fixture, { replayCheckpoint: replayCheckpoint(replacement) }),
    );

    const directory = path.join(root, "replay", ownerId, fixture.scrapeId);
    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[a-f0-9-]{36}\.json$/);
    const rows = await pool.query<{ count: number; state_path: string }>(
      `SELECT count(*)::int AS count, max(state_path) AS state_path
       FROM browser_replay_checkpoints`,
    );
    expect(rows.rows[0].count).toBe(1);
    expect(
      JSON.parse(
        await readFile(path.join(root, rows.rows[0]!.state_path), "utf8"),
      ),
    ).toEqual(replacement);
    await expect(
      replayStore.loadScrapeReplayState(ownerId, fixture.scrapeId),
    ).resolves.toMatchObject({
      kind: "checkpoint",
      checkpoint: { storageState: replacement },
    });
  });

  it("keeps the committed generation when a replacement transaction fails", async () => {
    const fixture = await createFixture();
    await replayStore.persistScrapeReplayState(input(fixture));
    const before = await pool.query<{ state_path: string; checksum: string }>(
      `SELECT state_path, checksum FROM browser_replay_checkpoints
       WHERE scrape_id = $1`,
      [fixture.scrapeId],
    );
    const missingRequestId = randomUUID();
    const failedReplacement = {
      cookies: [],
      origins: [{ origin: "https://example.com", localStorage: [] }],
    };

    await expect(
      replayStore.persistScrapeReplayState(
        input(fixture, {
          requestId: missingRequestId,
          replayCheckpoint: replayCheckpoint(failedReplacement),
        }),
      ),
    ).rejects.toBeTruthy();
    const after = await pool.query<{ state_path: string; checksum: string }>(
      `SELECT state_path, checksum FROM browser_replay_checkpoints
       WHERE scrape_id = $1`,
      [fixture.scrapeId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await expect(
      replayStore.loadScrapeReplayState(ownerId, fixture.scrapeId),
    ).resolves.toMatchObject({
      kind: "checkpoint",
      checkpoint: { storageState },
    });
    expect(
      await readdir(path.join(root, "replay", ownerId, fixture.scrapeId)),
    ).toHaveLength(1);
  });

  it("serializes concurrent replacements without orphaning generations", async () => {
    const fixture = await createFixture();
    const state = (value: string) => ({
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "winner", value }],
        },
      ],
    });
    const left = state("left");
    const right = state("right");
    await Promise.all([
      replayStore.persistScrapeReplayState(
        input(fixture, { replayCheckpoint: replayCheckpoint(left) }),
      ),
      replayStore.persistScrapeReplayState(
        input(fixture, { replayCheckpoint: replayCheckpoint(right) }),
      ),
    ]);

    const loaded = await replayStore.loadScrapeReplayState(
      ownerId,
      fixture.scrapeId,
    );
    expect(loaded.kind).toBe("checkpoint");
    if (loaded.kind !== "checkpoint") throw new Error("checkpoint unavailable");
    expect([left, right]).toContainEqual(loaded.checkpoint.storageState);
    const entries = await readdir(
      path.join(root, "replay", ownerId, fixture.scrapeId),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[a-f0-9-]{36}\.json$/);
  });

  it("returns committed success and durably retries failed old-generation cleanup", async () => {
    const fixture = await createFixture();
    await replayStore.persistScrapeReplayState(input(fixture));
    const old = await pool.query<{ state_path: string }>(
      `SELECT state_path FROM browser_replay_checkpoints WHERE scrape_id = $1`,
      [fixture.scrapeId],
    );
    const originalDelete = BrowserStateFilesystem.prototype.delete;
    const deleteFailure = vi
      .spyOn(BrowserStateFilesystem.prototype, "delete")
      .mockRejectedValueOnce(new Error("injected delete failure"));
    const replacement = {
      cookies: [],
      origins: [{ origin: "https://example.com", localStorage: [] }],
    };

    await expect(
      replayStore.persistScrapeReplayState(
        input(fixture, { replayCheckpoint: replayCheckpoint(replacement) }),
      ),
    ).resolves.toEqual({ persisted: true });
    deleteFailure.mockRestore();

    const pending = await pool.query<{
      state_path: string;
      attempts: number;
      last_error_category: string | null;
    }>(
      `SELECT state_path, attempts, last_error_category
         FROM browser_replay_checkpoint_cleanup_intents
        WHERE scrape_id = $1`,
      [fixture.scrapeId],
    );
    expect(pending.rows).toEqual([
      {
        state_path: old.rows[0]!.state_path,
        attempts: 1,
        last_error_category: "filesystem_delete_failed",
      },
    ]);
    expect(cleanupError).toHaveBeenCalledWith(
      "Replay checkpoint cleanup deferred",
      expect.objectContaining({
        category: "replay_checkpoint_cleanup_deferred",
        scrapeId: fixture.scrapeId,
      }),
    );
    expect(JSON.stringify(cleanupError.mock.calls)).not.toContain(
      old.rows[0]!.state_path,
    );

    await expect(
      replayStore.loadScrapeReplayState(ownerId, fixture.scrapeId),
    ).resolves.toMatchObject({
      kind: "checkpoint",
      checkpoint: { storageState: replacement },
    });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
           FROM browser_replay_checkpoint_cleanup_intents`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      originalDelete.call(
        new BrowserStateFilesystem(root),
        old.rows[0]!.state_path,
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps the typed primary failure when rollback cleanup is deferred", async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    const originalWrite = BrowserStateFilesystem.prototype.writeCheckpoint;
    vi.spyOn(
      BrowserStateFilesystem.prototype,
      "writeCheckpoint",
    ).mockImplementation(async function (owner, scrape, state) {
      const written = await originalWrite.call(this, owner, scrape, state);
      await pool.query("UPDATE scrapes SET request_id = $2 WHERE id = $1", [
        fixture.scrapeId,
        other.requestId,
      ]);
      return written;
    });
    vi.spyOn(BrowserStateFilesystem.prototype, "delete").mockRejectedValue(
      new Error("injected rollback delete failure"),
    );

    await expect(
      replayStore.persistScrapeReplayState(input(fixture)),
    ).rejects.toMatchObject({ category: "replay_ownership_mismatch" });
    await expect(
      pool.query<{
        attempts: number;
        last_error_category: string;
      }>(
        `SELECT attempts, last_error_category
           FROM browser_replay_checkpoint_cleanup_intents
          WHERE scrape_id = $1`,
        [fixture.scrapeId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          attempts: 1,
          last_error_category: "filesystem_delete_failed",
        },
      ],
    });
    expect(cleanupError).toHaveBeenCalledWith(
      "Replay checkpoint cleanup deferred",
      expect.objectContaining({
        category: "replay_checkpoint_cleanup_deferred",
        scrapeId: fixture.scrapeId,
      }),
    );
  });

  it("recovers rollback and commit crash intents from authoritative metadata", async () => {
    const fixture = await createFixture();
    await replayStore.persistScrapeReplayState(input(fixture));
    const filesystem = new BrowserStateFilesystem(root);
    const committed = await pool.query<{
      state_path: string;
      checksum: string;
    }>(
      `SELECT state_path, checksum FROM browser_replay_checkpoints
        WHERE scrape_id = $1`,
      [fixture.scrapeId],
    );
    const rolledBackState = {
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "crash", value: "rollback" }],
        },
      ],
    };
    const rolledBack = await filesystem.writeCheckpoint(
      ownerId,
      fixture.scrapeId,
      rolledBackState,
    );
    await pool.query(
      `INSERT INTO browser_replay_checkpoint_cleanup_intents
         (id, scrape_id, owner_id, state_path, checksum, state, created_at)
       VALUES ($1, $2, $3, $4, $5, 'preparing',
               now() - interval '2 hours')`,
      [
        randomUUID(),
        fixture.scrapeId,
        ownerId,
        rolledBack.pathId,
        rolledBack.checksum,
      ],
    );

    await replayStore.loadScrapeReplayState(ownerId, fixture.scrapeId);
    await expect(
      lstat(path.join(root, rolledBack.pathId)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const replacementState = {
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "crash", value: "commit" }],
        },
      ],
    };
    const replacement = await filesystem.writeCheckpoint(
      ownerId,
      fixture.scrapeId,
      replacementState,
    );
    await pool.query("BEGIN");
    try {
      await pool.query(
        `INSERT INTO browser_replay_checkpoint_cleanup_intents
           (id, scrape_id, owner_id, state_path, checksum)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(),
          fixture.scrapeId,
          ownerId,
          committed.rows[0]!.state_path,
          committed.rows[0]!.checksum,
        ],
      );
      await pool.query(
        `UPDATE browser_replay_checkpoints
            SET state_path = $2, checksum = $3, byte_size = $4
          WHERE scrape_id = $1`,
        [
          fixture.scrapeId,
          replacement.pathId,
          replacement.checksum,
          replacement.byteSize,
        ],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    await expect(
      replayStore.loadScrapeReplayState(ownerId, fixture.scrapeId),
    ).resolves.toMatchObject({
      kind: "checkpoint",
      checkpoint: { storageState: replacementState },
    });
    await expect(
      lstat(path.join(root, committed.rows[0]!.state_path)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
           FROM browser_replay_checkpoint_cleanup_intents`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("holds the scrape lock through checkpoint reads", async () => {
    const fixture = await createFixture();
    await replayStore.persistScrapeReplayState(input(fixture));
    const originalRead = BrowserStateFilesystem.prototype.readCheckpoint;
    let entered!: () => void;
    let release!: () => void;
    const readEntered = new Promise<void>(resolve => {
      entered = resolve;
    });
    const releaseRead = new Promise<void>(resolve => {
      release = resolve;
    });
    const readSpy = vi
      .spyOn(BrowserStateFilesystem.prototype, "readCheckpoint")
      .mockImplementation(async function (pathId, expectedChecksum) {
        const state = await originalRead.call(this, pathId, expectedChecksum);
        entered();
        await releaseRead;
        return state;
      });
    const load = replayStore.loadScrapeReplayState(ownerId, fixture.scrapeId);
    await readEntered;

    let replacementSettled = false;
    const replacement = replayStore
      .persistScrapeReplayState(input(fixture))
      .finally(() => {
        replacementSettled = true;
      });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(replacementSettled).toBe(false);
    release();
    await expect(load).resolves.toMatchObject({ kind: "checkpoint" });
    await expect(replacement).resolves.toEqual({ persisted: true });
    readSpy.mockRestore();
  });

  it("rejects traversal, absolute paths, and symlinked descendants", async () => {
    const filesystem = new BrowserStateFilesystem(root);
    await expect(
      filesystem.writeCheckpoint("../owner", randomUUID(), storageState),
    ).rejects.toThrow(/browser_state_unavailable/);
    await expect(
      filesystem.readCheckpoint("/tmp/state.json", checksum(storageState)),
    ).rejects.toThrow(/browser_state_unavailable/);

    const replayRoot = path.join(root, "replay");
    await mkdir(replayRoot, { recursive: true, mode: 0o700 });
    const outside = await mkdtemp(
      path.join(tmpdir(), "firecrawl-replay-outside-"),
    );
    await symlink(outside, path.join(replayRoot, ownerId));
    await expect(
      filesystem.writeCheckpoint(ownerId, randomUUID(), storageState),
    ).rejects.toThrow(/browser_state_unavailable/);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects symlink swaps and insecure existing directories", async () => {
    const filesystem = new BrowserStateFilesystem(root);
    const scrapeId = randomUUID();
    const written = await filesystem.writeCheckpoint(
      ownerId,
      scrapeId,
      storageState,
    );
    const target = path.join(root, written.pathId);
    const outsideRoot = await mkdtemp(
      path.join(tmpdir(), "firecrawl-replay-file-outside-"),
    );
    const outside = path.join(outsideRoot, "outside-state.json");
    await writeFile(outside, JSON.stringify(storageState), { mode: 0o600 });
    await rm(target);
    await symlink(outside, target);
    await expect(
      filesystem.readCheckpoint(written.pathId, written.checksum),
    ).rejects.toThrow(/browser_state_unavailable/);
    await rm(outsideRoot, { recursive: true, force: true });

    await rm(path.join(root, "replay"), { recursive: true, force: true });
    await mkdir(path.join(root, "replay"), { mode: 0o755 });
    await expect(
      filesystem.writeCheckpoint(ownerId, randomUUID(), storageState),
    ).rejects.toThrow(/browser_state_unavailable/);
  });

  it("removes only stale owned staging files", async () => {
    const filesystem = new BrowserStateFilesystem(root);
    const scrapeId = randomUUID();
    const directory = path.join(root, "replay", ownerId, scrapeId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const identity = await processIdentity(process.pid);
    const stale = path.join(
      directory,
      `.checkpoint-${randomUUID()}-99999999-${identity.bootId}-1.staging`,
    );
    const live = path.join(
      directory,
      `.checkpoint-${randomUUID()}-${process.pid}-${identity.bootId}-${identity.startTime}.staging`,
    );
    await writeFile(stale, "stale", { mode: 0o600 });
    await writeFile(live, "live", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    await filesystem.writeCheckpoint(ownerId, scrapeId, storageState);
    const entries = await readdir(directory);
    expect(entries).not.toContain(path.basename(stale));
    expect(entries).toContain(path.basename(live));
  });

  it("does not trust a stale pid 1 staging owner from another process lifetime", async () => {
    const filesystem = new BrowserStateFilesystem(root);
    const scrapeId = randomUUID();
    const directory = path.join(root, "replay", ownerId, scrapeId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8"))
      .trim()
      .replaceAll("-", "");
    const stat = await readFile("/proc/1/stat", "utf8");
    const endOfName = stat.lastIndexOf(")");
    const startTime = BigInt(stat.slice(endOfName + 2).split(" ")[19]!);
    const stale = path.join(
      directory,
      `.checkpoint-${randomUUID()}-1-${bootId}-${startTime + 1n}.staging`,
    );
    await writeFile(stale, "stale pid one", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    await filesystem.writeCheckpoint(ownerId, scrapeId, storageState);
    expect(await readdir(directory)).not.toContain(path.basename(stale));
  });

  it("removes the renamed generation when directory fsync fails", async () => {
    const scrapeId = randomUUID();
    const scrapeDirectory = path.join(root, "replay", ownerId, scrapeId);
    let injected = false;
    const filesystem = new BrowserStateFilesystem(root, {
      syncDirectory: async directory => {
        const entries = await readdir(directory).catch(() => []);
        if (
          directory === scrapeDirectory &&
          entries.some(entry => /^[a-f0-9-]{36}\.json$/.test(entry)) &&
          !injected
        ) {
          injected = true;
          throw new Error("injected post-rename directory sync failure");
        }
        const handle = await open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    });

    await expect(
      filesystem.writeCheckpoint(ownerId, scrapeId, storageState),
    ).rejects.toThrow(/browser_state_unavailable/);
    expect(injected).toBe(true);
    await expect(readdir(scrapeDirectory)).resolves.toEqual([]);
  });

  it("retries parent durability after a delete sync failure", async () => {
    const scrapeId = randomUUID();
    const scrapeDirectory = path.join(root, "replay", ownerId, scrapeId);
    let target = "";
    let missingTargetSyncs = 0;
    const filesystem = new BrowserStateFilesystem(root, {
      syncDirectory: async directory => {
        if (directory === scrapeDirectory && target) {
          const targetMissing = await lstat(target).then(
            () => false,
            error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return true;
              }
              throw error;
            },
          );
          if (targetMissing) {
            missingTargetSyncs += 1;
            if (missingTargetSyncs === 1) {
              throw new Error("injected delete directory sync failure");
            }
          }
        }
        const handle = await open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    });
    const written = await filesystem.writeCheckpoint(
      ownerId,
      scrapeId,
      storageState,
    );
    target = path.join(root, written.pathId);

    await expect(filesystem.delete(written.pathId)).rejects.toThrow(
      /injected delete directory sync failure/,
    );
    await expect(filesystem.delete(written.pathId)).resolves.toBeUndefined();
    expect(missingTargetSyncs).toBe(2);
  });

  it("bounds oversized reads without growing opened handles", async () => {
    const filesystem = new BrowserStateFilesystem(root);
    const scrapeId = randomUUID();
    await filesystem.writeCheckpoint(ownerId, scrapeId, storageState);
    const filename = `${randomUUID()}.json`;
    const directory = path.join(root, "replay", ownerId, scrapeId);
    await writeFile(path.join(directory, filename), Buffer.alloc(2_097_153), {
      mode: 0o600,
    });
    const pathId = path.posix.join("replay", ownerId, scrapeId, filename);
    const before = (await readdir("/proc/self/fd")).length;

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await expect(
        filesystem.readCheckpoint(pathId, "0".repeat(64)),
      ).rejects.toThrow(/browser_state_unavailable/);
    }

    const after = (await readdir("/proc/self/fd")).length;
    expect(after).toBeLessThanOrEqual(before + 1);
  });

  it("rejects request, scrape, and owner mismatches", async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    await expect(
      replayStore.persistScrapeReplayState(
        input(fixture, { requestId: other.requestId }),
      ),
    ).rejects.toThrow(/ownership/i);
    await expect(
      replayStore.persistScrapeReplayState(
        input(fixture, { ownerId: randomUUID() }),
      ),
    ).rejects.toThrow(/ownership/i);
    const rows = await pool.query(
      "SELECT count(*)::int AS count FROM browser_replay_envelopes",
    );
    expect(rows.rows[0].count).toBe(0);
  });

  it("fails closed when durable ownership links disagree", async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    await replayStore.persistScrapeReplayState(input(fixture));
    await pool.query(
      "UPDATE browser_replay_envelopes SET request_id = $2 WHERE scrape_id = $1",
      [fixture.scrapeId, other.requestId],
    );
    await expect(
      replayStore.loadScrapeReplayState(ownerId, fixture.scrapeId),
    ).resolves.toMatchObject({
      kind: "error",
      category: "replay_unavailable",
    });
  });

  it("fails closed when the checkpoint checksum does not match", async () => {
    const fixture = await createFixture();
    await replayStore.persistScrapeReplayState(input(fixture));
    const row = await pool.query<{ state_path: string }>(
      "SELECT state_path FROM browser_replay_checkpoints WHERE scrape_id = $1",
      [fixture.scrapeId],
    );
    await chmod(path.join(root, row.rows[0]!.state_path), 0o600);
    await pool.query(
      "UPDATE browser_replay_checkpoints SET checksum = $2 WHERE scrape_id = $1",
      [fixture.scrapeId, "0".repeat(64)],
    );

    const resolution = await replayStore.loadScrapeReplayState(
      ownerId,
      fixture.scrapeId,
    );
    expect(resolution).toMatchObject({
      kind: "error",
      category: "replay_unavailable",
    });
    expect(resolution).not.toHaveProperty("checkpoint.storageState");
  });

  it("does no database or filesystem work for ZDR input", async () => {
    const fixture = await createFixture();
    await expect(
      replayStore.persistScrapeReplayState(
        input(fixture, {
          ownerId: "../invalid-before-zdr",
          zeroDataRetention: true,
        }),
      ),
    ).resolves.toEqual({ persisted: false, reason: "zdr" });

    const rows = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM browser_replay_envelopes) AS envelopes,
         (SELECT count(*)::int FROM browser_replay_checkpoints) AS checkpoints`,
    );
    expect(rows.rows[0]).toEqual({ envelopes: 0, checkpoints: 0 });
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("returns before normalization and filesystem work when disabled", async () => {
    const fixture = await createFixture();
    const { config: mockedConfig } = await import("../../config.js");
    const browserConfig = mockedConfig as typeof mockedConfig & {
      LOCAL_BROWSER_SERVICE_ENABLED: boolean;
    };
    browserConfig.LOCAL_BROWSER_SERVICE_ENABLED = false;
    try {
      await expect(
        replayStore.persistScrapeReplayState(
          input(fixture, { ownerId: "../invalid-before-disabled" }),
        ),
      ).resolves.toEqual({ persisted: false, reason: "disabled" });
    } finally {
      browserConfig.LOCAL_BROWSER_SERVICE_ENABLED = true;
    }
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
