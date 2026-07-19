import { appendFile, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const tamperSchema = "migration_tamper_test";
const missingFileSchema = "migration_missing_file_test";
const nullChecksumSchema = "migration_null_checksum_test";
const baselineFilename = "0001_persistence_foundation.sql";

function databaseUrlForSchema(schema: string): string | undefined {
  if (!databaseUrl) {
    return undefined;
  }

  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

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
    for (const schema of [
      tamperSchema,
      missingFileSchema,
      nullChecksumSchema,
    ]) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.query(`CREATE SCHEMA ${schema}`);
    }
    await runApplicationMigrations(migrationConfig);
    await runApplicationMigrations(migrationConfig);
  });

  afterAll(async () => {
    await client.end();
  });

  it("applies the baseline once and seeds the configured local owner", async () => {
    const ledger = await client.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum
         FROM application_schema_migrations
        ORDER BY filename`,
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ filename: baselineFilename });
    expect(ledger.rows[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);

    const owners = await client.query<{ count: string }>(
      "SELECT count(*) FROM local_owners WHERE id = $1 AND label = 'local'",
      [ownerId],
    );
    expect(owners.rows[0]?.count).toBe("1");
  });

  it("rejects changed contents for an applied migration filename", async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), "firecrawl-migration-integrity-"),
    );
    const migrationPath = join(migrationsDirectory, baselineFilename);
    const integrityDatabaseUrl = databaseUrlForSchema(tamperSchema);
    const integrityClient = new Client({
      connectionString: integrityDatabaseUrl,
    });
    const integrityConfig = {
      ...migrationConfig,
      APPLICATION_DATABASE_URL: integrityDatabaseUrl,
    };

    try {
      await copyFile(
        join(__dirname, "migrations", baselineFilename),
        migrationPath,
      );
      await runApplicationMigrations(integrityConfig, {
        migrationsDirectory,
      });
      await integrityClient.connect();

      const schemaBefore = await integrityClient.query<{
        tablename: string;
      }>(
        `SELECT tablename
           FROM pg_tables
          WHERE schemaname = $1
          ORDER BY tablename`,
        [tamperSchema],
      );
      const ledgerBefore = await integrityClient.query<{ row: string }>(
        `SELECT row_to_json(m)::text AS row
           FROM application_schema_migrations AS m
          ORDER BY filename`,
      );

      await appendFile(
        migrationPath,
        "\nCREATE TABLE migration_checksum_tamper (id integer);\n",
      );

      await expect(
        runApplicationMigrations(integrityConfig, { migrationsDirectory }),
      ).rejects.toMatchObject({
        name: "ApplicationMigrationIntegrityError",
        filename: baselineFilename,
      });

      const schemaAfter = await integrityClient.query<{
        tablename: string;
      }>(
        `SELECT tablename
           FROM pg_tables
          WHERE schemaname = $1
          ORDER BY tablename`,
        [tamperSchema],
      );
      const ledgerAfter = await integrityClient.query<{ row: string }>(
        `SELECT row_to_json(m)::text AS row
           FROM application_schema_migrations AS m
          ORDER BY filename`,
      );
      expect(schemaAfter.rows).toEqual(schemaBefore.rows);
      expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);
      expect(
        await integrityClient.query(
          "SELECT to_regclass('migration_checksum_tamper')",
        ),
      ).toMatchObject({ rows: [{ to_regclass: null }] });
    } finally {
      await integrityClient.end().catch(() => undefined);
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an applied migration missing from the migration directory", async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), "firecrawl-migration-missing-file-"),
    );
    const migrationPath = join(migrationsDirectory, baselineFilename);
    const integrityDatabaseUrl = databaseUrlForSchema(missingFileSchema);
    const integrityClient = new Client({
      connectionString: integrityDatabaseUrl,
    });
    const integrityConfig = {
      ...migrationConfig,
      APPLICATION_DATABASE_URL: integrityDatabaseUrl,
    };

    try {
      await copyFile(
        join(__dirname, "migrations", baselineFilename),
        migrationPath,
      );
      await runApplicationMigrations(integrityConfig, {
        migrationsDirectory,
      });
      await integrityClient.connect();

      const schemaBefore = await integrityClient.query<{
        tablename: string;
      }>(
        `SELECT tablename
           FROM pg_tables
          WHERE schemaname = $1
          ORDER BY tablename`,
        [missingFileSchema],
      );
      const ledgerBefore = await integrityClient.query<{ row: string }>(
        `SELECT row_to_json(m)::text AS row
           FROM application_schema_migrations AS m
          ORDER BY filename`,
      );

      await rm(migrationPath);

      await expect(
        runApplicationMigrations(integrityConfig, { migrationsDirectory }),
      ).rejects.toMatchObject({
        name: "ApplicationMigrationIntegrityError",
        filename: baselineFilename,
        reason: "missing-file",
      });

      const schemaAfter = await integrityClient.query<{
        tablename: string;
      }>(
        `SELECT tablename
           FROM pg_tables
          WHERE schemaname = $1
          ORDER BY tablename`,
        [missingFileSchema],
      );
      const ledgerAfter = await integrityClient.query<{ row: string }>(
        `SELECT row_to_json(m)::text AS row
           FROM application_schema_migrations AS m
          ORDER BY filename`,
      );
      expect(schemaAfter.rows).toEqual(schemaBefore.rows);
      expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);
    } finally {
      await integrityClient.end().catch(() => undefined);
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an applied migration with a null checksum", async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), "firecrawl-migration-null-checksum-"),
    );
    const integrityDatabaseUrl = databaseUrlForSchema(nullChecksumSchema);
    const integrityClient = new Client({
      connectionString: integrityDatabaseUrl,
    });
    const integrityConfig = {
      ...migrationConfig,
      APPLICATION_DATABASE_URL: integrityDatabaseUrl,
    };

    try {
      await copyFile(
        join(__dirname, "migrations", baselineFilename),
        join(migrationsDirectory, baselineFilename),
      );
      await integrityClient.connect();
      await integrityClient.query(
        `CREATE TABLE application_schema_migrations (
           filename text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await integrityClient.query(
        `INSERT INTO application_schema_migrations(filename)
         VALUES ($1)`,
        [baselineFilename],
      );

      await expect(
        runApplicationMigrations(integrityConfig, { migrationsDirectory }),
      ).rejects.toMatchObject({
        name: "ApplicationMigrationIntegrityError",
        filename: baselineFilename,
        reason: "missing-checksum",
      });
    } finally {
      await integrityClient.end().catch(() => undefined);
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
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

  it("indexes webhook lookups by crawl, event, and newest delivery", async () => {
    const result = await client.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'webhook_logs_crawl_event_created_at_idx'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toContain(
      "(crawl_id, event, created_at DESC)",
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
      await copyFile(
        join(__dirname, "migrations", baselineFilename),
        join(migrationsDirectory, baselineFilename),
      );
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
