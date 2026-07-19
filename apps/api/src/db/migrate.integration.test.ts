import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runApplicationMigrations } from "./migrate";

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const ownerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
const requestId = "dbe8d700-f48f-4d2e-b51b-9a27e4859a8c";
const scrapeId = "8f6bc812-3d2d-40ba-bb52-0ae0e38328a1";

const migrationConfig = {
  LOCAL_PERSISTENCE_ENABLED: true,
  APPLICATION_DATABASE_URL: databaseUrl,
  LOCAL_OWNER_ID: ownerId,
  ARTIFACT_STORE_PROVIDER: "none" as const,
  USE_DB_AUTHENTICATION: false,
};

const foundationTables = ["local_owners", "local_artifacts"];

const operationalTables = [
  "requests",
  "scrapes",
  "parses",
  "crawls",
  "batch_scrapes",
  "searches",
  "research_paper_searches",
  "research_paper_inspects",
  "research_paper_reads",
  "research_related_papers",
  "research_github_searches",
  "extracts",
  "maps",
  "llmstxts",
  "deep_researches",
];

const directConsumerTables = [
  "idempotency_keys",
  "deterministic_json_scripts",
  "deterministic_json_llm_cache",
  "webhook_logs",
];

describeWithDatabase("application migrations", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await runApplicationMigrations(migrationConfig);
    await runApplicationMigrations(migrationConfig);
  });

  afterAll(async () => {
    await client.end();
  });

  it("applies the baseline once and seeds the configured local owner", async () => {
    const ledger = await client.query<{ filename: string }>(
      "SELECT filename FROM application_schema_migrations ORDER BY filename",
    );
    expect(ledger.rows).toEqual([
      { filename: "0001_persistence_foundation.sql" },
    ]);

    const owners = await client.query<{ count: string }>(
      "SELECT count(*) FROM local_owners WHERE id = $1 AND label = 'local'",
      [ownerId],
    );
    expect(owners.rows[0]?.count).toBe("1");
  });

  it("creates every foundation, operational, and direct-consumer table", async () => {
    const requiredTables = [
      ...foundationTables,
      ...operationalTables,
      ...directConsumerTables,
    ];
    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
        ORDER BY tablename`,
      [requiredTables],
    );

    expect(tables.rows.map(row => row.tablename)).toEqual(
      requiredTables.sort(),
    );
  });

  it("accepts UUID owner and request IDs in requests and scrapes", async () => {
    await client.query(
      `INSERT INTO requests
         (id, kind, api_version, team_id, origin, target_hint)
       VALUES ($1, 'scrape', 'v2', $2, 'api', 'example.com')`,
      [requestId, ownerId],
    );
    await client.query(
      `INSERT INTO scrapes
         (id, request_id, url, is_successful, time_taken, team_id,
          credits_cost)
       VALUES ($1, $2, 'https://example.com', true, 0.5, $3, 1)`,
      [scrapeId, requestId, ownerId],
    );

    const result = await client.query<{
      request_id: string;
      owner_id: string;
    }>(
      `SELECT scrapes.request_id, scrapes.team_id AS owner_id
         FROM scrapes
         JOIN requests ON requests.id = scrapes.request_id
        WHERE scrapes.id = $1`,
      [scrapeId],
    );
    expect(result.rows).toEqual([{ request_id: requestId, owner_id: ownerId }]);
  });

  it("rolls back a failed migration without recording its filename", async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), "firecrawl-migrations-"),
    );

    try {
      await writeFile(
        join(migrationsDirectory, "0002_failure.sql"),
        `CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);
         SELECT missing_migration_function();`,
      );

      await expect(
        runApplicationMigrations(migrationConfig, { migrationsDirectory }),
      ).rejects.toThrow(/0002_failure\.sql/);

      const result = await client.query<{
        table_name: string | null;
        ledgered: boolean;
      }>(
        `SELECT to_regclass('public.migration_rollback_probe')::text
                  AS table_name,
                EXISTS (
                  SELECT 1
                    FROM application_schema_migrations
                   WHERE filename = '0002_failure.sql'
                ) AS ledgered`,
      );
      expect(result.rows).toEqual([{ table_name: null, ledgered: false }]);
    } finally {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });
});
