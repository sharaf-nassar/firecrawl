import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, type QueryResult, type QueryResultRow } from "pg";

import { config } from "../config";
import {
  LocalRuntimeConfigurationError,
  resolveLocalRuntimeConfig,
  type LocalRuntimeConfigSource,
} from "../lib/local-runtime-config";

const advisoryLockKeys: [number, number] = [1179796818, 1296650823];
const migrationFilenamePattern = /^\d{4}_.+\.sql$/;

export type ApplicationMigrationDependencies = {
  migrationsDirectory?: string;
  timeoutMs?: number;
};

export class ApplicationMigrationError extends Error {
  constructor(
    public readonly filename: string,
    message: string,
    cause: unknown,
  ) {
    super(`Application migration ${filename} ${message}`, { cause });
    this.name = "ApplicationMigrationError";
  }
}

export class ApplicationMigrationIntegrityError extends Error {
  constructor(
    public readonly filename: string,
    public readonly reason:
      | "missing-file"
      | "missing-checksum"
      | "checksum-mismatch",
  ) {
    super(
      reason === "missing-checksum"
        ? `Application migration integrity check failed for ${filename}: stored checksum is missing`
        : reason === "missing-file"
          ? `Application migration integrity check failed for ${filename}: applied migration file is missing`
          : `Application migration integrity check failed for ${filename}: file contents have changed`,
    );
    this.name = "ApplicationMigrationIntegrityError";
  }
}

function defaultMigrationsDirectory(): string {
  return join(__dirname, "migrations");
}

async function migrationFilenames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        entry => entry.isFile() && migrationFilenamePattern.test(entry.name),
      )
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw new Error(
      `Unable to read application migrations directory: ${directory}`,
      { cause: error },
    );
  }
}

export async function runApplicationMigrations(
  source: LocalRuntimeConfigSource = config,
  dependencies: ApplicationMigrationDependencies = {},
): Promise<void> {
  const localConfig = resolveLocalRuntimeConfig(source);
  if (!localConfig.enabled) {
    throw new LocalRuntimeConfigurationError([
      "LOCAL_PERSISTENCE_ENABLED must be true to run application migrations",
    ]);
  }

  const migrationsDirectory =
    dependencies.migrationsDirectory ?? defaultMigrationsDirectory();
  const timeoutMs = dependencies.timeoutMs;
  const deadlineMs =
    timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const client = new Client({
    connectionString: localConfig.applicationDatabaseUrl,
    application_name: "firecrawl-application-migrations",
    ...(timeoutMs === undefined
      ? {}
      : {
          connectionTimeoutMillis: timeoutMs,
          statement_timeout: timeoutMs,
          query_timeout: timeoutMs,
          lock_timeout: timeoutMs,
          idle_in_transaction_session_timeout: timeoutMs,
        }),
  });
  let connected = false;
  let lockAcquired = false;
  let operationError: unknown;
  const remainingMs = (): number | undefined => {
    if (deadlineMs === undefined) return undefined;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      throw new Error("Application migration deadline exceeded");
    }
    return remaining;
  };
  const query = async <Row extends QueryResultRow = never>(
    text: string,
    values?: any[],
  ): Promise<QueryResult<Row>> => {
    const remaining = remainingMs();
    if (remaining === undefined) return client.query<Row>(text, values);
    await client.query({
      text: `SELECT set_config('statement_timeout', $1, false),
                    set_config('lock_timeout', $1, false)`,
      values: [`${remaining}ms`],
      query_timeout: remaining,
    } as any);
    const afterConfiguration = remainingMs()!;
    return client.query<Row>({
      text,
      values,
      query_timeout: afterConfiguration,
    } as any);
  };

  try {
    await client.connect();
    connected = true;
    await query("SELECT pg_advisory_lock($1, $2)", advisoryLockKeys);
    lockAcquired = true;

    await query(`
      CREATE TABLE IF NOT EXISTS application_schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      ALTER TABLE application_schema_migrations
      ADD COLUMN IF NOT EXISTS checksum text
    `);

    const filenames = await migrationFilenames(migrationsDirectory);
    const appliedResult = await query<{
      filename: string;
      checksum: string | null;
    }>(
      `SELECT filename, checksum
         FROM application_schema_migrations
        ORDER BY filename`,
    );
    const applied = new Map(
      appliedResult.rows.map(row => [row.filename, row.checksum]),
    );
    const available = new Set(filenames);

    for (const filename of applied.keys()) {
      if (!available.has(filename)) {
        throw new ApplicationMigrationIntegrityError(filename, "missing-file");
      }
    }

    for (const filename of filenames) {
      let file: Buffer;
      try {
        file = await readFile(join(migrationsDirectory, filename));
      } catch (error) {
        throw new ApplicationMigrationError(
          filename,
          "could not be read",
          error,
        );
      }
      const checksum = createHash("sha256").update(file).digest("hex");

      if (applied.has(filename)) {
        const appliedChecksum = applied.get(filename);
        if (appliedChecksum === null) {
          throw new ApplicationMigrationIntegrityError(
            filename,
            "missing-checksum",
          );
        }
        if (appliedChecksum !== checksum) {
          throw new ApplicationMigrationIntegrityError(
            filename,
            "checksum-mismatch",
          );
        }
        continue;
      }

      await query("BEGIN");
      try {
        await query(file.toString("utf8"));
        await query(
          `INSERT INTO application_schema_migrations(filename, checksum)
           VALUES ($1, $2)`,
          [filename, checksum],
        );
        await query("COMMIT");
      } catch (error) {
        try {
          const rollbackQuery =
            deadlineMs === undefined
              ? "ROLLBACK"
              : {
                  text: "ROLLBACK",
                  query_timeout: Math.max(1, deadlineMs - Date.now()),
                };
          await client.query(rollbackQuery as any);
        } catch (rollbackError) {
          throw new ApplicationMigrationError(
            filename,
            "failed and its transaction could not be rolled back",
            new AggregateError([error, rollbackError]),
          );
        }
        throw new ApplicationMigrationError(filename, "failed", error);
      }
    }

    await query(
      `INSERT INTO local_owners(id, label)
       VALUES ($1, 'local')
       ON CONFLICT DO NOTHING`,
      [localConfig.ownerId],
    );
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;

    if (lockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock($1, $2)",
          advisoryLockKeys,
        );
      } catch (error) {
        cleanupError = new Error(
          "Unable to release the application migration advisory lock",
          { cause: error },
        );
      }
    }

    if (connected) {
      try {
        await client.end();
      } catch (error) {
        cleanupError ??= new Error(
          "Unable to close the application migration database connection",
          { cause: error },
        );
      }
    }

    if (!operationError && cleanupError) {
      throw cleanupError;
    }
  }
}

if (require.main === module) {
  runApplicationMigrations().catch(error => {
    console.error(
      error instanceof Error
        ? error.message
        : "Application migrations failed with an unknown error",
    );
    process.exitCode = 1;
  });
}
