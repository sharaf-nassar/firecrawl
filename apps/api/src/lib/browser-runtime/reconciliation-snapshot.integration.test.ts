import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { runApplicationMigrations } from "../../db/migrate";
import { loadBrowserReconciliationSnapshot } from "./reconciliation-snapshot";

const checksum = "a".repeat(64);

describe("loadBrowserReconciliationSnapshot", () => {
  it("loads all authority kinds in one read-only repeatable-read transaction", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes("browser_replay_checkpoints")) {
        return {
          rows: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              state_path:
                "replay/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222.json",
              checksum,
            },
          ],
        };
      }
      if (text.includes("browser_profile_generations")) {
        return {
          rows: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              state_path:
                "profiles/55555555-5555-4555-8555-555555555555/committed/44444444-4444-4444-8444-444444444444",
              checksum,
            },
          ],
        };
      }
      if (text.includes("browser_replay_checkpoint_cleanup_intents")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    };

    const snapshot = await loadBrowserReconciliationSnapshot(pool as never);
    expect(snapshot.references.map(reference => reference.kind)).toEqual([
      "profile_generation",
      "replay_checkpoint",
    ]);
    const canonical = JSON.stringify({
      version: 1,
      references: snapshot.references,
    });
    expect(snapshot.snapshotDigest).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
    expect(queries[0]).toContain("REPEATABLE READ READ ONLY");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back malformed or conflicting authority", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("browser_replay_checkpoints")) {
        return {
          rows: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              state_path: "../escape",
              checksum,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    };
    await expect(
      loadBrowserReconciliationSnapshot(pool as never),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects conflicting path aliases without truncating", async () => {
    const path =
      "replay/owner-a/scrape-a/22222222-2222-4222-8222-222222222222.json";
    const query = vi.fn(async (text: string) => {
      if (text.includes("browser_replay_checkpoints")) {
        return {
          rows: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              state_path: path,
              checksum,
            },
          ],
        };
      }
      if (text.includes("browser_replay_checkpoint_cleanup_intents")) {
        return {
          rows: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              state_path: path,
              checksum: "b".repeat(64),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    };
    await expect(
      loadBrowserReconciliationSnapshot(pool as never),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects authority 25,001 rather than truncating", async () => {
    const rows = Array.from({ length: 25_001 }, (_, index) => {
      const suffix = index.toString(16).padStart(12, "0");
      const id = `11111111-1111-4111-8111-${suffix}`;
      return {
        id,
        state_path: `replay/owner/scrape/${id}.json`,
        checksum,
      };
    });
    const query = vi.fn(async (text: string) =>
      text.includes("browser_replay_checkpoints") ? { rows } : { rows: [] },
    );
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    };
    await expect(
      loadBrowserReconciliationSnapshot(pool as never),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase(
  "browser reconciliation snapshot database isolation",
  () => {
    it("includes latest and active generations but excludes a concurrent insert", async () => {
      const ownerId = randomUUID();
      const requestId = randomUUID();
      const scrapeId = randomUUID();
      const profileId = randomUUID();
      const generationId = randomUUID();
      const activeGenerationId = randomUUID();
      const concurrentGenerationId = randomUUID();
      const sessionId = randomUUID();
      const checkpointId = randomUUID();
      const cleanupId = randomUUID();
      const pool = new Pool({ connectionString: databaseUrl, max: 3 });
      await runApplicationMigrations({
        LOCAL_PERSISTENCE_ENABLED: true,
        APPLICATION_DATABASE_URL: databaseUrl,
        LOCAL_OWNER_ID: ownerId,
        ARTIFACT_STORE_PROVIDER: "none",
        USE_DB_AUTHENTICATION: false,
      });
      const deadline = new Date(Date.now() + 60_000).toISOString();
      const checkpointPath = `replay/${ownerId}/${scrapeId}/${checkpointId}.json`;
      const cleanupPath = `replay/${ownerId}/${scrapeId}/${cleanupId}.json`;
      const generationPath = `profiles/${profileId}/committed/${generationId}`;
      const activeGenerationPath = `profiles/${profileId}/working/${activeGenerationId}`;
      const concurrentPath = `profiles/${profileId}/committed/${concurrentGenerationId}`;
      try {
        await pool.query(
          `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint
         ) VALUES ($1, 'scrape', 'v2', $2, 'test', 'snapshot')`,
          [requestId, ownerId],
        );
        await pool.query(
          `INSERT INTO scrapes (
           id, request_id, url, is_successful, time_taken, team_id,
           credits_cost
         ) VALUES ($1, $2, 'https://example.test', true, 1, $3, 1)`,
          [scrapeId, requestId, ownerId],
        );
        await pool.query(
          `INSERT INTO browser_profiles (id, owner_id, name)
         VALUES ($1, $2, 'snapshot-profile')`,
          [profileId, ownerId],
        );
        await pool.query(
          `INSERT INTO browser_profile_generations (
           id, profile_id, generation, state_path, byte_size, checksum
         ) VALUES ($1, $2, 1, $3, 1, $4)`,
          [generationId, profileId, generationPath, checksum],
        );
        await pool.query(
          `UPDATE browser_profiles
            SET latest_generation_id = $2
          WHERE id = $1`,
          [profileId, generationId],
        );
        await pool.query(
          `INSERT INTO browser_profile_generations (
           id, profile_id, generation, state_path, byte_size, checksum
         ) VALUES ($1, $2, 2, $3, 1, $4)`,
          [activeGenerationId, profileId, activeGenerationPath, checksum],
        );
        await pool.query(
          `INSERT INTO browser_sessions (
           id, request_id, owner_id, scrape_id, profile_id,
           profile_generation_id, state, absolute_deadline_at,
           idle_deadline_at, last_activity_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $7, now())`,
          [
            sessionId,
            requestId,
            ownerId,
            scrapeId,
            profileId,
            activeGenerationId,
            deadline,
          ],
        );
        await pool.query(
          `INSERT INTO browser_replay_checkpoints (
           id, scrape_id, request_id, owner_id, envelope_version,
           state_path, final_url, fingerprint, checksum, byte_size,
           expires_at
         ) VALUES (
           $1, $2, $3, $4, 1, $5, 'https://example.test', '{}'::jsonb,
           $6, 1, $7
         )`,
          [
            checkpointId,
            scrapeId,
            requestId,
            ownerId,
            checkpointPath,
            checksum,
            deadline,
          ],
        );
        await pool.query(
          `INSERT INTO browser_replay_checkpoint_cleanup_intents (
           id, scrape_id, owner_id, state_path, checksum, state
         ) VALUES ($1, $2, $3, $4, $5, 'cleanup')`,
          [cleanupId, scrapeId, ownerId, cleanupPath, checksum],
        );

        let firstAuthorityRead!: () => void;
        const firstRead = new Promise<void>(resolve => {
          firstAuthorityRead = resolve;
        });
        let releaseLoader!: () => void;
        const loaderReleased = new Promise<void>(resolve => {
          releaseLoader = resolve;
        });
        const wrappedPool = {
          connect: async () => {
            const client = await pool.connect();
            return {
              query: async (text: string, values?: unknown[]) => {
                const result = await client.query(text, values);
                if (text.includes("FROM browser_replay_checkpoints")) {
                  firstAuthorityRead();
                  await loaderReleased;
                }
                return result;
              },
              release: () => client.release(),
            };
          },
        };
        const loading = loadBrowserReconciliationSnapshot(wrappedPool as never);
        await firstRead;
        await pool.query(
          `INSERT INTO browser_profile_generations (
           id, profile_id, generation, state_path, byte_size, checksum
         ) VALUES ($1, $2, 3, $3, 1, $4)`,
          [concurrentGenerationId, profileId, concurrentPath, checksum],
        );
        releaseLoader();
        const isolated = await loading;
        expect(isolated.references).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "profile_generation",
              id: generationId,
            }),
            expect.objectContaining({
              kind: "profile_generation",
              id: activeGenerationId,
            }),
            expect.objectContaining({
              kind: "replay_checkpoint",
              id: checkpointId,
            }),
            expect.objectContaining({
              kind: "replay_checkpoint_cleanup_intent",
              id: cleanupId,
            }),
          ]),
        );
        expect(
          isolated.references.some(
            reference => reference.id === concurrentGenerationId,
          ),
        ).toBe(false);
        const fresh = await loadBrowserReconciliationSnapshot(pool);
        expect(
          fresh.references.some(
            reference => reference.id === concurrentGenerationId,
          ),
        ).toBe(true);
      } finally {
        await pool
          .query("DELETE FROM local_owners WHERE id = $1", [ownerId])
          .catch(() => undefined);
        await pool.end();
      }
    });
  },
);
