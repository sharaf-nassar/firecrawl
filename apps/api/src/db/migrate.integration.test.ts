import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
const retentionFkSchema = "migration_retention_fk_test";
const preflightUpgradeSchema = "migration_preflight_upgrade_test";
const asyncPlaceholderSchema = "migration_async_placeholder_test";
const baselineFilename = "0001_persistence_foundation.sql";
const asyncPlaceholderFilename = "0002_async_request_placeholders.sql";
const preflightFilename = "0002_preflight_orphan_webhooks.sql";
const retentionFkFilename = "0002_retention_foreign_keys.sql";

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

async function insertEveryOperationalChildBeforeParent(
  client: Client,
): Promise<string[]> {
  const inserts = [
    `INSERT INTO scrapes (
       id, request_id, url, is_successful, time_taken, team_id, credits_cost
     ) VALUES (gen_random_uuid(), $1, 'https://example.com/scrape',
               true, 1, $2, 1)`,
    `INSERT INTO parses (
       id, request_id, url, is_successful, time_taken, team_id, credits_cost
     ) VALUES (gen_random_uuid(), $1, 'https://example.com/parse',
               true, 1, $2, 1)`,
    `INSERT INTO crawls (
       id, request_id, url, team_id, num_docs, credits_cost, cancelled
     ) VALUES (gen_random_uuid(), $1, 'https://example.com/crawl',
               $2, 1, 1, false)`,
    `INSERT INTO batch_scrapes (
       id, request_id, team_id, num_docs, credits_cost, cancelled
     ) VALUES (gen_random_uuid(), $1, $2, 1, 1, false)`,
    `INSERT INTO searches (
       id, request_id, query, team_id, time_taken, credits_cost,
       is_successful, num_results
     ) VALUES (gen_random_uuid(), $1, 'query', $2, 1, 1, true, 1)`,
    `INSERT INTO extracts (
       id, request_id, urls, model_kind, team_id, is_successful, credits_cost
     ) VALUES (gen_random_uuid(), $1, ARRAY['https://example.com'],
               'fire-1', $2, true, 1)`,
    `INSERT INTO maps (
       id, request_id, url, team_id, num_results, credits_cost
     ) VALUES (gen_random_uuid(), $1, 'https://example.com/map', $2, 1, 1)`,
    `INSERT INTO llmstxts (
       id, request_id, url, team_id, num_urls, credits_cost
     ) VALUES (gen_random_uuid(), $1, 'https://example.com/llms', $2, 1, 1)`,
    `INSERT INTO deep_researches (
       id, request_id, query, team_id, time_taken, credits_cost
     ) VALUES (gen_random_uuid(), $1, 'query', $2, 1, 1)`,
    ...[
      "research_paper_searches",
      "research_paper_inspects",
      "research_paper_reads",
      "research_related_papers",
      "research_github_searches",
    ].map(
      table => `INSERT INTO ${table} (
         id, request_id, target, team_id, num_results, time_taken,
         credits_cost, is_successful
       ) VALUES (gen_random_uuid(), $1, 'target', $2, 1, 1, 1, true)`,
    ),
  ];
  const requestIds: string[] = [];
  for (const insert of inserts) {
    const requestId = randomUUID();
    await client.query(insert, [requestId, ownerId]);
    requestIds.push(requestId);
  }
  return requestIds;
}

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
      retentionFkSchema,
      preflightUpgradeSchema,
      asyncPlaceholderSchema,
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
    expect(ledger.rows.map(row => row.filename)).toEqual([
      baselineFilename,
      asyncPlaceholderFilename,
      preflightFilename,
      retentionFkFilename,
    ]);
    expect(ledger.rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(
      true,
    );

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

  it("preserves parentless async rows through immutable retention migrations", async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), "firecrawl-async-placeholder-migration-"),
    );
    const placeholderDatabaseUrl = databaseUrlForSchema(asyncPlaceholderSchema);
    const placeholderClient = new Client({
      connectionString: placeholderDatabaseUrl,
    });
    const placeholderConfig = {
      ...migrationConfig,
      APPLICATION_DATABASE_URL: placeholderDatabaseUrl,
    };
    const parentlessRequestId = "12999c77-a8db-44f7-a727-2eab71ee5177";
    const parentlessScrapeId = "f006bc79-269f-466f-bbaa-dd7869968d78";

    try {
      await copyFile(
        join(__dirname, "migrations", baselineFilename),
        join(migrationsDirectory, baselineFilename),
      );
      await runApplicationMigrations(placeholderConfig, {
        migrationsDirectory,
      });
      await placeholderClient.connect();
      await placeholderClient.query(
        `INSERT INTO scrapes (
           id, request_id, url, is_successful, time_taken, team_id,
           credits_cost, created_at
         ) VALUES ($1, $2, 'https://example.com/legacy', true, 1, $3, 1,
                   now() - interval '30 days')`,
        [parentlessScrapeId, parentlessRequestId, ownerId],
      );
      await placeholderClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, url, event
         ) VALUES (true, $1, $2, 'https://example.com/legacy', 'completed')`,
        [ownerId, parentlessScrapeId],
      );

      const migrationStartedAt = new Date();
      const migrationFilenames = [
        asyncPlaceholderFilename,
        preflightFilename,
        retentionFkFilename,
      ];
      for (const filename of migrationFilenames) {
        await copyFile(
          join(__dirname, "migrations", filename),
          join(migrationsDirectory, filename),
        );
      }
      await runApplicationMigrations(placeholderConfig, {
        migrationsDirectory,
      });

      const preserved = await placeholderClient.query(
        `SELECT
           (SELECT count(*) FROM scrapes WHERE id = $1)::text AS scrapes,
           (SELECT count(*) FROM webhook_logs WHERE crawl_id = $1)::text
             AS webhooks,
           (SELECT count(*) FROM requests WHERE id = $2)::text AS requests`,
        [parentlessScrapeId, parentlessRequestId],
      );
      expect(preserved.rows).toEqual([
        { scrapes: "1", webhooks: "1", requests: "1" },
      ]);

      const legacyPlaceholder = await placeholderClient.query<{
        kind: string;
        dr_clean_by: Date;
      }>(
        `SELECT kind, dr_clean_by
           FROM requests
          WHERE id = $1`,
        [parentlessRequestId],
      );
      expect(legacyPlaceholder.rows).toEqual([
        {
          kind: "async_placeholder",
          dr_clean_by: expect.any(Date),
        },
      ]);
      expect(
        legacyPlaceholder.rows[0]!.dr_clean_by.getTime(),
      ).toBeGreaterThanOrEqual(
        migrationStartedAt.getTime() + 24 * 60 * 60 * 1000,
      );

      const asyncRequestIds =
        await insertEveryOperationalChildBeforeParent(placeholderClient);
      const placeholders = await placeholderClient.query<{
        count: string;
        bounded: boolean;
      }>(
        `SELECT count(*)::text AS count,
                bool_and(kind = 'async_placeholder'
                  AND dr_clean_by > now()
                  AND dr_clean_by <= created_at + interval '24 hours')
                  AS bounded
           FROM requests
          WHERE id = ANY($1::uuid[])`,
        [asyncRequestIds],
      );
      expect(placeholders.rows).toEqual([{ count: "14", bounded: true }]);

      const concurrentRequestId = randomUUID();
      const firstConcurrentClient = new Client({
        connectionString: placeholderDatabaseUrl,
      });
      const secondConcurrentClient = new Client({
        connectionString: placeholderDatabaseUrl,
      });
      await Promise.all([
        firstConcurrentClient.connect(),
        secondConcurrentClient.connect(),
      ]);
      try {
        await Promise.all([
          firstConcurrentClient.query(
            `INSERT INTO scrapes (
               id, request_id, url, is_successful, time_taken, team_id,
               credits_cost
             ) VALUES (gen_random_uuid(), $1,
                       'https://example.com/concurrent-scrape',
                       true, 1, $2, 1)`,
            [concurrentRequestId, ownerId],
          ),
          secondConcurrentClient.query(
            `INSERT INTO parses (
               id, request_id, url, is_successful, time_taken, team_id,
               credits_cost
             ) VALUES (gen_random_uuid(), $1,
                       'https://example.com/concurrent-parse',
                       true, 1, $2, 1)`,
            [concurrentRequestId, ownerId],
          ),
        ]);
      } finally {
        await Promise.all([
          firstConcurrentClient.end(),
          secondConcurrentClient.end(),
        ]);
      }
      const concurrentPlaceholder = await placeholderClient.query<{
        count: string;
      }>("SELECT count(*)::text AS count FROM requests WHERE id = $1", [
        concurrentRequestId,
      ]);
      expect(concurrentPlaceholder.rows).toEqual([{ count: "1" }]);

      const replacementRequestId = asyncRequestIds[0]!;
      const replacementDeadline = new Date("2026-08-17T00:00:00.000Z");
      await placeholderClient.query(
        `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint, dr_clean_by
         ) VALUES ($1, 'scrape', 'v2', $2, 'api', 'real request', $3)
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind,
           api_version = EXCLUDED.api_version,
           team_id = EXCLUDED.team_id,
           origin = EXCLUDED.origin,
           target_hint = EXCLUDED.target_hint,
           dr_clean_by = EXCLUDED.dr_clean_by`,
        [replacementRequestId, ownerId, replacementDeadline],
      );
      const replacement = await placeholderClient.query<{
        kind: string;
        target_hint: string;
        dr_clean_by: Date;
      }>("SELECT kind, target_hint, dr_clean_by FROM requests WHERE id = $1", [
        replacementRequestId,
      ]);
      expect(replacement.rows).toEqual([
        {
          kind: "scrape",
          target_hint: "real request",
          dr_clean_by: replacementDeadline,
        },
      ]);

      await runApplicationMigrations(placeholderConfig, {
        migrationsDirectory,
      });
      const ledger = await placeholderClient.query<{
        filename: string;
        checksum: string;
      }>(
        `SELECT filename, checksum
           FROM application_schema_migrations
          ORDER BY filename`,
      );
      expect(ledger.rows.map(row => row.filename)).toEqual([
        baselineFilename,
        asyncPlaceholderFilename,
        preflightFilename,
        retentionFkFilename,
      ]);
      for (const filename of migrationFilenames) {
        const file = await readFile(join(__dirname, "migrations", filename));
        const expectedChecksum = createHash("sha256")
          .update(file)
          .digest("hex");
        expect(
          ledger.rows.find(row => row.filename === filename)?.checksum,
        ).toBe(expectedChecksum);
      }
    } finally {
      await placeholderClient.end().catch(() => undefined);
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
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
      await copyFile(
        join(__dirname, "migrations", asyncPlaceholderFilename),
        join(migrationsDirectory, asyncPlaceholderFilename),
      );
      await copyFile(
        join(__dirname, "migrations", preflightFilename),
        join(migrationsDirectory, preflightFilename),
      );
      await copyFile(
        join(__dirname, "migrations", retentionFkFilename),
        join(migrationsDirectory, retentionFkFilename),
      );
      await writeFile(
        join(migrationsDirectory, "0003_failure.sql"),
        `CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);
         SELECT missing_migration_function();`,
      );

      await expect(
        runApplicationMigrations(migrationConfig, { migrationsDirectory }),
      ).rejects.toThrow(/0003_failure\.sql/);

      const result = await client.query<{
        table_name: string | null;
        ledgered: boolean;
      }>(
        `SELECT to_regclass('public.migration_rollback_probe')::text
                  AS table_name,
                EXISTS (
                  SELECT 1
                    FROM application_schema_migrations
                   WHERE filename = '0003_failure.sql'
                ) AS ledgered`,
      );
      expect(result.rows).toEqual([{ table_name: null, ledgered: false }]);
    } finally {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("cleans legacy orphans and enforces retention parent integrity", async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), "firecrawl-retention-fk-migration-"),
    );
    const retentionDatabaseUrl = databaseUrlForSchema(retentionFkSchema);
    const retentionClient = new Client({
      connectionString: retentionDatabaseUrl,
    });
    const retentionConfig = {
      ...migrationConfig,
      APPLICATION_DATABASE_URL: retentionDatabaseUrl,
    };
    const orphanRequestId = "f737aa20-879f-48af-8137-b3b2b83ec5c5";
    const orphanScrapeId = "c18eef36-3007-4acd-8cd9-03948cbcb471";
    const orphanCrawlChildId = "f92435f9-cbb0-45c1-83cd-5a794d1de42e";
    const orphanBatchId = "b6dac5df-1fc9-40c3-8d53-b76434179b5c";
    const orphanExtractId = "7c64df38-6bb3-479c-940f-bbf8102b7165";
    const orphanScrapeFallbackId = "8d49243f-7c4d-47b0-9adc-a962f6948e4f";
    const orphanCrawlId = "7846a294-8111-482f-a268-6ba028780489";
    const validRequestId = "d34397c8-f9e4-489f-a448-bd286a5c28af";
    const validScrapeId = "578f6029-81f9-43bc-b504-b921d445dcdb";
    const validCrawlId = "3c3d83ac-640d-4781-b86a-42571eae413e";
    const validDeadline = new Date("2026-08-17T00:00:00.000Z");

    try {
      await copyFile(
        join(__dirname, "migrations", baselineFilename),
        join(migrationsDirectory, baselineFilename),
      );
      await runApplicationMigrations(retentionConfig, { migrationsDirectory });
      await retentionClient.connect();
      await retentionClient.query(
        `INSERT INTO scrapes (
           id, request_id, url, is_successful, time_taken, team_id,
           credits_cost
         ) VALUES ($1, $2, 'https://example.com/orphan', true, 1, $3, 1)`,
        [orphanScrapeId, orphanRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO crawls (
           id, request_id, url, team_id, num_docs, credits_cost, cancelled
         ) VALUES ($1, $2, 'https://example.com/orphan-crawl', $3,
                   1, 1, false)`,
        [orphanCrawlChildId, orphanRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO batch_scrapes (
           id, request_id, team_id, num_docs, credits_cost, cancelled
         ) VALUES ($1, $2, $3, 1, 1, false)`,
        [orphanBatchId, orphanRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO extracts (
           id, request_id, urls, model_kind, team_id, is_successful,
           credits_cost
         ) VALUES ($1, $2, $3, 'fire-1', $4, true, 1)`,
        [
          orphanExtractId,
          orphanRequestId,
          ["https://example.com/orphan-extract"],
          ownerId,
        ],
      );
      await retentionClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, url, event
         ) VALUES (true, $1, $2,
                   'https://example.com/orphan', 'completed')`,
        [ownerId, orphanScrapeId],
      );
      for (const crawlId of [
        orphanCrawlChildId,
        orphanBatchId,
        orphanExtractId,
      ]) {
        await retentionClient.query(
          `INSERT INTO webhook_logs (
             success, team_id, crawl_id, url, event
           ) VALUES (true, $1, $2,
                     'https://example.com/orphan', 'completed')`,
          [ownerId, crawlId],
        );
      }
      await retentionClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, scrape_id, url, event
         ) VALUES (true, $1, $2, $3,
                   'https://example.com/orphan', 'completed')`,
        [ownerId, orphanScrapeFallbackId, orphanScrapeId],
      );
      await retentionClient.query(
        `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint, dr_clean_by
         ) VALUES ($1, 'scrape', 'v2', $2, 'test', 'valid legacy', $3)`,
        [validRequestId, ownerId, validDeadline],
      );
      await retentionClient.query(
        `INSERT INTO scrapes (
           id, request_id, url, is_successful, time_taken, team_id,
           credits_cost
         ) VALUES ($1, $2, 'https://example.com/valid', true, 1, $3, 1)`,
        [validScrapeId, validRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO crawls (
           id, request_id, url, team_id, num_docs, credits_cost, cancelled
         ) VALUES ($1, $2, 'https://example.com/valid-crawl', $3,
                   1, 1, false)`,
        [validCrawlId, validRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, url, event
         ) VALUES (true, $1, $2,
                   'https://example.com/valid', 'completed')`,
        [ownerId, validScrapeId],
      );
      await retentionClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, url, event
         ) VALUES (true, $1, $2,
                   'https://example.com/unknown', 'completed')`,
        [ownerId, orphanCrawlId],
      );
      await retentionClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, scrape_id, url, event
         ) VALUES (true, $1, $2, $3,
                   'https://example.com/valid-priority', 'completed')`,
        [ownerId, validCrawlId, orphanScrapeId],
      );
      await retentionClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, scrape_id, url, event
         ) VALUES (true, $1, $2, $3,
                   'https://example.com/orphan-priority', 'completed')`,
        [ownerId, orphanCrawlChildId, validScrapeId],
      );

      await copyFile(
        join(__dirname, "migrations", preflightFilename),
        join(migrationsDirectory, preflightFilename),
      );
      await copyFile(
        join(__dirname, "migrations", retentionFkFilename),
        join(migrationsDirectory, retentionFkFilename),
      );
      await runApplicationMigrations(retentionConfig, { migrationsDirectory });

      const orphanCounts = await retentionClient.query<{
        scrapes: string;
        crawls: string;
        batches: string;
        extracts: string;
        webhooks: string;
        valid_scrapes: string;
        valid_webhooks: string;
        valid_priority_webhooks: string;
        unknown_webhooks: string;
      }>(
        `SELECT
           (SELECT count(*) FROM scrapes WHERE id = $1) AS scrapes,
           (SELECT count(*) FROM crawls WHERE id = $2) AS crawls,
           (SELECT count(*) FROM batch_scrapes WHERE id = $3) AS batches,
           (SELECT count(*) FROM extracts WHERE id = $4) AS extracts,
           (SELECT count(*) FROM webhook_logs
             WHERE crawl_id = ANY($5::uuid[])) AS webhooks,
           (SELECT count(*) FROM scrapes WHERE id = $6) AS valid_scrapes,
           (SELECT count(*) FROM webhook_logs WHERE crawl_id = $6)
             AS valid_webhooks,
           (SELECT count(*) FROM webhook_logs
             WHERE crawl_id = $7 AND scrape_id = $1)
             AS valid_priority_webhooks,
           (SELECT count(*) FROM webhook_logs WHERE crawl_id = $8)
             AS unknown_webhooks`,
        [
          orphanScrapeId,
          orphanCrawlChildId,
          orphanBatchId,
          orphanExtractId,
          [
            orphanScrapeId,
            orphanCrawlChildId,
            orphanBatchId,
            orphanExtractId,
            orphanScrapeFallbackId,
          ],
          validScrapeId,
          validCrawlId,
          orphanCrawlId,
        ],
      );
      expect(orphanCounts.rows).toEqual([
        {
          scrapes: "0",
          crawls: "0",
          batches: "0",
          extracts: "0",
          webhooks: "0",
          valid_scrapes: "1",
          valid_webhooks: "1",
          valid_priority_webhooks: "1",
          unknown_webhooks: "1",
        },
      ]);
      const legacyWebhooks = await retentionClient.query<{
        crawl_id: string;
        request_id: string | null;
        dr_clean_by: Date;
        bounded: boolean;
      }>(
        `SELECT crawl_id, request_id, dr_clean_by,
                dr_clean_by <= created_at + interval '24 hours'
                  AND dr_clean_by <= now() + interval '24 hours' AS bounded
           FROM webhook_logs
          WHERE crawl_id = ANY($1::uuid[])
          ORDER BY crawl_id`,
        [[validScrapeId, validCrawlId, orphanCrawlId]],
      );
      expect(legacyWebhooks.rows).toEqual(
        expect.arrayContaining([
          {
            crawl_id: validScrapeId,
            request_id: validRequestId,
            dr_clean_by: validDeadline,
            bounded: false,
          },
          {
            crawl_id: validCrawlId,
            request_id: validRequestId,
            dr_clean_by: validDeadline,
            bounded: false,
          },
          {
            crawl_id: orphanCrawlId,
            request_id: null,
            dr_clean_by: expect.any(Date),
            bounded: true,
          },
        ]),
      );

      const constraints = await retentionClient.query<{
        count: string;
        validated: boolean;
        cascading: boolean;
      }>(
        `SELECT count(*)::text AS count,
                bool_and(convalidated) AS validated,
                bool_and(confdeltype = 'c') AS cascading
           FROM pg_constraint
          WHERE connamespace = current_schema()::regnamespace
            AND contype = 'f'
            AND conname LIKE '%_request_id_requests_fk'
            AND conname <> 'webhook_logs_request_id_requests_fk'`,
      );
      expect(constraints.rows).toEqual([
        { count: "14", validated: true, cascading: true },
      ]);
      const webhookConstraint = await retentionClient.query<{
        validated: boolean;
        delete_action: string;
      }>(
        `SELECT convalidated AS validated, confdeltype AS delete_action
           FROM pg_constraint
          WHERE connamespace = current_schema()::regnamespace
            AND conname = 'webhook_logs_request_id_requests_fk'`,
      );
      expect(webhookConstraint.rows).toEqual([
        { validated: true, delete_action: "n" },
      ]);

      const correlatedRequestId = "ec2fef06-13ed-4908-8410-e098fa9fc27a";
      const correlatedDeadline = new Date("2026-08-17T00:00:00.000Z");
      const correlatedIds = {
        crawl: "115a83aa-f7e1-4631-bf33-5986129a9fb1",
        batch: "04eab30b-00cf-4d22-a4d1-af3dbacc425f",
        extract: "3f0853da-23e8-46fe-bf60-dabb67572811",
        scrape: "de5c36d4-0c65-47d7-a1d0-92aaacb58b10",
      };
      await retentionClient.query(
        `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint, dr_clean_by
         ) VALUES ($1, 'scrape', 'v2', $2, 'test', 'webhook retention', $3)`,
        [correlatedRequestId, ownerId, correlatedDeadline],
      );
      await retentionClient.query(
        `INSERT INTO crawls (
           id, request_id, url, team_id, num_docs, credits_cost, cancelled
         ) VALUES ($1, $2, 'https://example.com/crawl', $3, 1, 1, false)`,
        [correlatedIds.crawl, correlatedRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO batch_scrapes (
           id, request_id, team_id, num_docs, credits_cost, cancelled
         ) VALUES ($1, $2, $3, 1, 1, false)`,
        [correlatedIds.batch, correlatedRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO extracts (
           id, request_id, urls, model_kind, team_id, is_successful,
           credits_cost
         ) VALUES ($1, $2, $3, 'fire-1', $4, true, 1)`,
        [
          correlatedIds.extract,
          correlatedRequestId,
          ["https://example.com/extract"],
          ownerId,
        ],
      );
      await retentionClient.query(
        `INSERT INTO scrapes (
           id, request_id, url, is_successful, time_taken, team_id,
           credits_cost
         ) VALUES ($1, $2, 'https://example.com/scrape', true, 1, $3, 1)`,
        [correlatedIds.scrape, correlatedRequestId, ownerId],
      );
      for (const jobId of Object.values(correlatedIds)) {
        await retentionClient.query(
          `INSERT INTO webhook_logs (
             success, team_id, crawl_id, url, event
           ) VALUES (true, $1, $2, 'https://example.com/known', 'completed')`,
          [ownerId, jobId],
        );
      }
      const correlatedWebhooks = await retentionClient.query<{
        request_id: string;
        dr_clean_by: Date;
      }>(
        `SELECT request_id, dr_clean_by
           FROM webhook_logs
          WHERE crawl_id = ANY($1::uuid[])
          ORDER BY crawl_id`,
        [Object.values(correlatedIds)],
      );
      expect(correlatedWebhooks.rows).toHaveLength(4);
      expect(
        correlatedWebhooks.rows.every(
          row =>
            row.request_id === correlatedRequestId &&
            row.dr_clean_by.getTime() === correlatedDeadline.getTime(),
        ),
      ).toBe(true);

      const zdrRequestId = "37bd43b6-a44b-47a5-899e-df25940734f2";
      const zdrScrapeId = "a516ecfc-2d37-4caa-933c-f0f8808e7f08";
      const zdrDeadline = new Date("2026-07-19T00:00:00.000Z");
      await retentionClient.query(
        `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint, dr_clean_by
         ) VALUES ($1, 'scrape', 'v2', $2, 'test', 'zdr webhook', $3)`,
        [zdrRequestId, ownerId, zdrDeadline],
      );
      await retentionClient.query(
        `INSERT INTO scrapes (
           id, request_id, url, is_successful, time_taken, team_id,
           credits_cost
         ) VALUES ($1, $2, 'https://example.com/zdr', true, 1, $3, 1)`,
        [zdrScrapeId, zdrRequestId, ownerId],
      );
      await retentionClient.query(
        `INSERT INTO webhook_logs (
           success, team_id, crawl_id, scrape_id, url, event
         ) VALUES (true, $1, $2, $3,
                   'https://example.com/zdr', 'completed')`,
        [ownerId, orphanCrawlId, zdrScrapeId],
      );
      const zdrWebhook = await retentionClient.query<{
        request_id: string;
        dr_clean_by: Date;
      }>(
        `SELECT request_id, dr_clean_by
           FROM webhook_logs
          WHERE scrape_id = $1`,
        [zdrScrapeId],
      );
      expect(zdrWebhook.rows).toEqual([
        { request_id: zdrRequestId, dr_clean_by: zdrDeadline },
      ]);
      await retentionClient.query("DELETE FROM requests WHERE id = $1", [
        zdrRequestId,
      ]);
      const detachedZdrWebhook = await retentionClient.query<{
        request_id: string | null;
        dr_clean_by: Date;
        scrape_exists: boolean;
      }>(
        `SELECT webhook.request_id,
                webhook.dr_clean_by,
                EXISTS (
                  SELECT 1 FROM scrapes WHERE id = $1
                ) AS scrape_exists
           FROM webhook_logs AS webhook
          WHERE webhook.scrape_id = $1`,
        [zdrScrapeId],
      );
      expect(detachedZdrWebhook.rows).toEqual([
        {
          request_id: null,
          dr_clean_by: zdrDeadline,
          scrape_exists: false,
        },
      ]);

      await expect(
        retentionClient.query(
          `INSERT INTO scrapes (
             id, request_id, url, is_successful, time_taken, team_id,
             credits_cost
           ) VALUES (gen_random_uuid(), $1, 'https://example.com/late',
                     true, 1, $2, 1)`,
          [orphanRequestId, ownerId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      const unknownWebhook = await retentionClient.query<{
        request_id: string | null;
        bounded: boolean;
      }>(
        `SELECT request_id,
                dr_clean_by <= created_at + interval '24 hours'
                  AND dr_clean_by <= now() + interval '24 hours' AS bounded
           FROM webhook_logs
          WHERE crawl_id = $1
            AND scrape_id IS NULL`,
        [orphanCrawlId],
      );
      expect(unknownWebhook.rows).toEqual([
        { request_id: null, bounded: true },
      ]);

      const ledger = await retentionClient.query<{ filename: string }>(
        `SELECT filename FROM application_schema_migrations
         ORDER BY filename`,
      );
      expect(ledger.rows.map(row => row.filename)).toEqual([
        baselineFilename,
        preflightFilename,
        retentionFkFilename,
      ]);
    } finally {
      await retentionClient.end().catch(() => undefined);
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("applies the orphan preflight after an already-ledgered retention migration", async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), "firecrawl-preflight-upgrade-"),
    );
    const upgradeDatabaseUrl = databaseUrlForSchema(preflightUpgradeSchema);
    const upgradeClient = new Client({ connectionString: upgradeDatabaseUrl });
    const upgradeConfig = {
      ...migrationConfig,
      APPLICATION_DATABASE_URL: upgradeDatabaseUrl,
    };

    try {
      await copyFile(
        join(__dirname, "migrations", baselineFilename),
        join(migrationsDirectory, baselineFilename),
      );
      await copyFile(
        join(__dirname, "migrations", retentionFkFilename),
        join(migrationsDirectory, retentionFkFilename),
      );
      await runApplicationMigrations(upgradeConfig, { migrationsDirectory });
      await upgradeClient.connect();
      const before = await upgradeClient.query<{
        filename: string;
        checksum: string;
      }>(
        `SELECT filename, checksum
           FROM application_schema_migrations
          ORDER BY filename`,
      );

      await copyFile(
        join(__dirname, "migrations", preflightFilename),
        join(migrationsDirectory, preflightFilename),
      );
      await runApplicationMigrations(upgradeConfig, { migrationsDirectory });
      const after = await upgradeClient.query<{
        filename: string;
        checksum: string;
      }>(
        `SELECT filename, checksum
           FROM application_schema_migrations
          ORDER BY filename`,
      );

      expect(after.rows.map(row => row.filename)).toEqual([
        baselineFilename,
        preflightFilename,
        retentionFkFilename,
      ]);
      expect(
        after.rows.filter(row => row.filename !== preflightFilename),
      ).toEqual(before.rows);

      await copyFile(
        join(__dirname, "migrations", asyncPlaceholderFilename),
        join(migrationsDirectory, asyncPlaceholderFilename),
      );
      await runApplicationMigrations(upgradeConfig, { migrationsDirectory });
      const afterPlaceholder = await upgradeClient.query<{
        filename: string;
        checksum: string;
      }>(
        `SELECT filename, checksum
           FROM application_schema_migrations
          ORDER BY filename`,
      );
      expect(afterPlaceholder.rows.map(row => row.filename)).toEqual([
        baselineFilename,
        asyncPlaceholderFilename,
        preflightFilename,
        retentionFkFilename,
      ]);
      expect(
        afterPlaceholder.rows.filter(
          row => row.filename !== asyncPlaceholderFilename,
        ),
      ).toEqual(after.rows);
    } finally {
      await upgradeClient.end().catch(() => undefined);
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("prevents a child insert blocked behind parent cleanup from orphaning", async () => {
    const retentionDatabaseUrl = databaseUrlForSchema(retentionFkSchema);
    await runApplicationMigrations({
      ...migrationConfig,
      APPLICATION_DATABASE_URL: retentionDatabaseUrl,
    });
    const locker = new Client({ connectionString: retentionDatabaseUrl });
    const applicationName = "firecrawl-retention-concurrency-test";
    const inserter = new Client({
      connectionString: retentionDatabaseUrl,
      application_name: applicationName,
    });
    const concurrentRequestId = "df2e4598-c17b-4fc3-a49c-503c3fab0ba1";

    await locker.connect();
    await inserter.connect();
    try {
      await locker.query(
        `INSERT INTO requests (
           id, kind, api_version, team_id, origin, target_hint
         ) VALUES ($1, 'scrape', 'v2', $2, 'test', 'concurrent retention')`,
        [concurrentRequestId, ownerId],
      );
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM requests WHERE id = $1 FOR UPDATE", [
        concurrentRequestId,
      ]);

      const insert = inserter.query(
        `INSERT INTO scrapes (
           id, request_id, url, is_successful, time_taken, team_id,
           credits_cost
         ) VALUES (gen_random_uuid(), $1, 'https://example.com/concurrent',
                   true, 1, $2, 1)`,
        [concurrentRequestId, ownerId],
      );
      const rejectedInsert = expect(insert).rejects.toMatchObject({
        code: "23503",
      });
      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await locker.query<{ blocked: boolean }>(
          `SELECT wait_event_type = 'Lock' AS blocked
             FROM pg_stat_activity
            WHERE application_name = $1
              AND state = 'active'`,
          [applicationName],
        );
        if (activity.rows.some(row => row.blocked)) {
          observedLockWait = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true);

      await locker.query("DELETE FROM requests WHERE id = $1", [
        concurrentRequestId,
      ]);
      await locker.query("COMMIT");
      await rejectedInsert;
      const orphan = await locker.query(
        "SELECT 1 FROM scrapes WHERE request_id = $1",
        [concurrentRequestId],
      );
      expect(orphan.rows).toHaveLength(0);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      await locker.end().catch(() => undefined);
      await inserter.end().catch(() => undefined);
    }
  });
});
