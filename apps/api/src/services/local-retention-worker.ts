import { Pool, type PoolClient, type PoolConfig } from "pg";

import { config } from "../config";
import { getArtifactStore, type ArtifactStore } from "../lib/artifacts";
import { BrowserStateFilesystem } from "../lib/browser-state/filesystem-store";
import { logger as defaultLogger } from "../lib/logger";
import {
  resolveLocalRuntimeConfig,
  type LocalRuntimeConfigSource,
} from "../lib/local-runtime-config";

const RETENTION_BATCH_SIZE = 50;
const IDLE_BACKOFF_MS = 1_000;
const RETENTION_CONNECTION_TIMEOUT_MS = 5_000;
const RETENTION_LOCK_TIMEOUT_MS = 5_000;
const RETENTION_STATEMENT_TIMEOUT_MS = 30_000;
const RETENTION_STOP_TIMEOUT_MS = 5_000;

const operationalTables = [
  "scrapes",
  "parses",
  "crawls",
  "batch_scrapes",
  "searches",
  "extracts",
  "maps",
  "llmstxts",
  "deep_researches",
  "research_paper_searches",
  "research_paper_inspects",
  "research_paper_reads",
  "research_related_papers",
  "research_github_searches",
] as const;

export type ExpiredArtifactManifest = {
  objectKey: string;
  kind: string;
  requestId: string | null;
  jobId: string | null;
  deleteAfter: Date | null;
  deleteAfterToken: string | null;
};

export type ArtifactManifestClaim = {
  manifest: ExpiredArtifactManifest;
  deleteManifest(): Promise<boolean>;
  release(): Promise<void>;
};

export type ExpiredBrowserStateFile = {
  kind: "replay-checkpoint" | "profile-generation";
  id: string;
  statePath: string;
  checksum: string;
  deleteAfter: Date;
};

export type BrowserStateFileClaim = {
  file: ExpiredBrowserStateFile;
  markFileDeleted(): Promise<boolean>;
  release(): Promise<void>;
};

export type OperationalCleanupResult = {
  requestsDeleted: number;
  dependentRowsDeleted: number;
  requestIds: string[];
};

type RetentionFailureProgress = OperationalCleanupResult & {
  artifactCandidates: number;
  artifactsDeleted: number;
  artifactFailures: number;
  durationMs: number;
};

type RetentionFailurePhase = "artifact-delete" | "operational-cleanup";

abstract class LocalRetentionFailure extends Error {
  readonly artifactCandidates: number;
  readonly artifactsDeleted: number;
  readonly artifactFailures: number;
  readonly requestsDeleted: number;
  readonly dependentRowsDeleted: number;
  readonly requestIds: string[];
  readonly durationMs: number;

  protected constructor(
    name: string,
    message: string,
    readonly code: string,
    readonly phase: RetentionFailurePhase,
    progress: RetentionFailureProgress,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = name;
    this.artifactCandidates = progress.artifactCandidates;
    this.artifactsDeleted = progress.artifactsDeleted;
    this.artifactFailures = progress.artifactFailures;
    this.requestsDeleted = progress.requestsDeleted;
    this.dependentRowsDeleted = progress.dependentRowsDeleted;
    this.requestIds = [...progress.requestIds];
    this.durationMs = progress.durationMs;
  }
}

type ArtifactRetentionFailureOptions = RetentionFailureProgress & {
  objectKey: string;
  requestId: string | null;
  jobId: string | null;
  provider: ArtifactStore["provider"];
  failures?: ArtifactRetentionFailure[];
  cause: unknown;
};

export type ArtifactRetentionFailure = {
  objectKey: string;
  requestId: string | null;
  jobId: string | null;
  provider: ArtifactStore["provider"];
  errorName: string;
  errorCode?: string;
  cleanupError?: ReturnType<typeof errorMetadata>;
};

export class LocalArtifactRetentionError extends LocalRetentionFailure {
  readonly objectKey: string;
  readonly requestId: string | null;
  readonly jobId: string | null;
  readonly provider: ArtifactStore["provider"];
  readonly failures: ArtifactRetentionFailure[];

  constructor(options: ArtifactRetentionFailureOptions) {
    super(
      "LocalArtifactRetentionError",
      "Local artifact retention delete failed",
      "artifact_delete_failed",
      "artifact-delete",
      options,
      options.cause,
    );
    this.objectKey = options.objectKey;
    this.requestId = options.requestId;
    this.jobId = options.jobId;
    this.provider = options.provider;
    this.failures = options.failures
      ? options.failures.slice(0, RETENTION_BATCH_SIZE).map(item => ({
          ...item,
        }))
      : [
          {
            objectKey: options.objectKey,
            requestId: options.requestId,
            jobId: options.jobId,
            provider: options.provider,
            ...errorMetadata(options.cause),
          },
        ];
  }
}

type OperationalRetentionFailureOptions = {
  requestIds: string[];
  cause: unknown;
  progress?: Omit<RetentionFailureProgress, "requestIds" | "durationMs">;
  durationMs?: number;
  cleanupError?: ReturnType<typeof errorMetadata>;
  failures?: ArtifactRetentionFailure[];
};

export class LocalOperationalRetentionError extends LocalRetentionFailure {
  readonly cleanupError?: ReturnType<typeof errorMetadata>;
  readonly failures: ArtifactRetentionFailure[];

  constructor(options: OperationalRetentionFailureOptions) {
    const requestIds = options.requestIds.slice(0, RETENTION_BATCH_SIZE);
    super(
      "LocalOperationalRetentionError",
      "Local operational retention cleanup failed",
      "operational_cleanup_failed",
      "operational-cleanup",
      {
        artifactCandidates: options.progress?.artifactCandidates ?? 0,
        artifactsDeleted: options.progress?.artifactsDeleted ?? 0,
        artifactFailures: options.progress?.artifactFailures ?? 0,
        requestsDeleted: options.progress?.requestsDeleted ?? 0,
        dependentRowsDeleted: options.progress?.dependentRowsDeleted ?? 0,
        requestIds,
        durationMs: options.durationMs ?? 0,
      },
      options.cause,
    );
    this.cleanupError = options.cleanupError;
    this.failures = (options.failures ?? [])
      .slice(0, RETENTION_BATCH_SIZE)
      .map(failure => ({ ...failure }));
  }
}

class LocalRetentionResourceError extends Error {
  readonly code = "retention_resource_cleanup_failed";
  readonly cleanupError: ReturnType<typeof errorMetadata>;

  constructor(cause: unknown, cleanupError: unknown) {
    super("Local retention resource cleanup failed", { cause });
    this.name = "LocalRetentionResourceError";
    this.cleanupError = errorMetadata(cleanupError);
  }
}

class BrowserStateFileClaimLostError extends Error {
  readonly code = "browser_state_file_claim_lost";

  constructor() {
    super("Browser state file metadata changed before retention CAS");
    this.name = "BrowserStateFileClaimLostError";
  }
}

export class LocalRetentionShutdownTimeoutError extends Error {
  readonly code = "retention_shutdown_timeout";

  constructor(readonly timeoutMs: number) {
    super("Local retention worker shutdown timed out");
    this.name = "LocalRetentionShutdownTimeoutError";
  }
}

export class LocalBrowserStateRetentionError extends Error {
  readonly code = "browser_state_delete_failed";

  constructor(
    readonly kind: ExpiredBrowserStateFile["kind"],
    readonly statePath: string,
    cause: unknown,
  ) {
    super("Browser state retention delete failed", { cause });
    this.name = "LocalBrowserStateRetentionError";
  }
}

export interface LocalRetentionDatabase {
  listExpiredBrowserStateFiles(
    now: Date,
    limit: number,
  ): Promise<ExpiredBrowserStateFile[]>;
  tryClaimBrowserStateFile(
    candidate: ExpiredBrowserStateFile,
    now: Date,
  ): Promise<BrowserStateFileClaim | null>;
  listExpiredArtifactManifests(
    now: Date,
    limit: number,
  ): Promise<ExpiredArtifactManifest[]>;
  tryClaimArtifactManifest(
    candidate: ExpiredArtifactManifest,
    now: Date,
  ): Promise<ArtifactManifestClaim | null>;
  deleteExpiredOperationalRows(
    now: Date,
    limit: number,
  ): Promise<OperationalCleanupResult>;
  close(): Promise<void>;
}

export type RetentionLogger = Pick<
  typeof defaultLogger,
  "debug" | "info" | "warn" | "error"
>;

type IterationOptions = {
  database: LocalRetentionDatabase;
  artifactStore: ArtifactStore | null;
  browserStateFilesystem?: Pick<BrowserStateFilesystem, "delete"> | null;
  now?: Date;
  signal?: AbortSignal;
  logger?: RetentionLogger;
};

type IterationResult = OperationalCleanupResult & {
  artifactCandidates: number;
  artifactsDeleted: number;
  artifactFailures: number;
};

type LoopOptions = {
  signal: AbortSignal;
  configSource?: LocalRuntimeConfigSource;
  database?: LocalRetentionDatabase;
  artifactStore?: ArtifactStore | null;
  browserStateFilesystem?: Pick<BrowserStateFilesystem, "delete"> | null;
  logger?: RetentionLogger;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type LocalRetentionRunner = (signal: AbortSignal) => Promise<void>;

type LocalRetentionServiceOptions = {
  stopTimeoutMs?: number;
  logger?: RetentionLogger;
};

export type LocalRetentionService = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

type ArtifactManifestRow = {
  object_key: string;
  kind: string;
  request_id: string | null;
  job_id: string | null;
  delete_after: Date | null;
  delete_after_token: string | null;
};

type BrowserStateFileRow = {
  kind: ExpiredBrowserStateFile["kind"];
  id: string;
  state_path: string;
  checksum: string;
  delete_after: Date;
};

function toManifest(row: ArtifactManifestRow): ExpiredArtifactManifest {
  return {
    objectKey: row.object_key,
    kind: row.kind,
    requestId: row.request_id,
    jobId: row.job_id,
    deleteAfter: row.delete_after,
    deleteAfterToken: row.delete_after_token,
  };
}

function toBrowserStateFile(row: BrowserStateFileRow): ExpiredBrowserStateFile {
  return {
    kind: row.kind,
    id: row.id,
    statePath: row.state_path,
    checksum: row.checksum,
    deleteAfter: row.delete_after,
  };
}

function errorMetadata(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  const errorCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    ...(errorCode ? { errorCode } : {}),
  };
}

function retentionFailureMetadata(error: unknown): Record<string, unknown> {
  if (!(error instanceof LocalRetentionFailure)) return errorMetadata(error);
  const metadata: Record<string, unknown> = {
    ...errorMetadata(error),
    phase: error.phase,
    artifactCandidates: error.artifactCandidates,
    artifactsDeleted: error.artifactsDeleted,
    artifactFailures: error.artifactFailures,
    requestsDeleted: error.requestsDeleted,
    dependentRowsDeleted: error.dependentRowsDeleted,
    requestIds: error.requestIds,
    durationMs: error.durationMs,
  };
  if (error instanceof LocalArtifactRetentionError) {
    metadata.objectKey = error.objectKey;
    metadata.requestId = error.requestId;
    metadata.jobId = error.jobId;
    metadata.provider = error.provider;
    metadata.failures = error.failures;
  } else if (
    error instanceof LocalOperationalRetentionError &&
    (error.cleanupError || error.failures.length > 0)
  ) {
    if (error.cleanupError) metadata.cleanupError = error.cleanupError;
    if (error.failures.length > 0) metadata.failures = error.failures;
  }
  return metadata;
}

type PgLocalRetentionDependencies = {
  createPool?: (config: PoolConfig) => Pool;
};

export class PgLocalRetentionDatabase implements LocalRetentionDatabase {
  private readonly pool: Pool;
  private closePromise: Promise<void> | undefined;

  constructor(
    connectionString: string,
    dependencies: PgLocalRetentionDependencies = {},
  ) {
    this.pool = (dependencies.createPool ?? (config => new Pool(config)))({
      connectionString,
      application_name: "firecrawl-local-retention",
      max: 2,
      min: 0,
      keepAlive: true,
      connectionTimeoutMillis: RETENTION_CONNECTION_TIMEOUT_MS,
      statement_timeout: RETENTION_STATEMENT_TIMEOUT_MS,
      lock_timeout: RETENTION_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: RETENTION_STATEMENT_TIMEOUT_MS,
    });
    this.pool.on("error", error => {
      defaultLogger.error("Local retention PostgreSQL pool error", {
        ...errorMetadata(error),
      });
    });
  }

  async listExpiredArtifactManifests(
    now: Date,
    limit: number,
  ): Promise<ExpiredArtifactManifest[]> {
    const client = await this.pool.connect();
    let released = false;
    try {
      const result = await client.query<ArtifactManifestRow>(
        `SELECT artifact.object_key, artifact.kind, artifact.request_id,
                artifact.job_id,
                artifact.delete_after,
                artifact.delete_after::text AS delete_after_token
           FROM local_artifacts artifact
           LEFT JOIN requests request ON request.id = artifact.request_id
          WHERE LEAST(artifact.delete_after, request.dr_clean_by) <= $1
          ORDER BY LEAST(artifact.delete_after, request.dr_clean_by),
                   artifact.object_key
          LIMIT $2`,
        [now, limit],
      );
      return result.rows.map(toManifest);
    } catch (error) {
      released = true;
      client.release(true);
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async listExpiredBrowserStateFiles(
    now: Date,
    limit: number,
  ): Promise<ExpiredBrowserStateFile[]> {
    const client = await this.pool.connect();
    let released = false;
    try {
      const result = await client.query<BrowserStateFileRow>(
        `SELECT kind, id, state_path, checksum, delete_after
           FROM (
             SELECT 'profile-generation'::text AS kind,
                    generation.id,
                    generation.state_path,
                    generation.checksum,
                    generation.expires_at AS delete_after
               FROM browser_profile_generations generation
               JOIN browser_profiles profile
                 ON profile.id = generation.profile_id
              WHERE generation.state_path IS NOT NULL
                AND generation.file_deleted_at IS NULL
                AND generation.expires_at IS NOT NULL
                AND generation.expires_at <= $1
                AND profile.latest_generation_id IS DISTINCT FROM generation.id
                AND NOT EXISTS (
                  SELECT 1
                    FROM browser_sessions session
                   WHERE session.profile_generation_id = generation.id
                     AND session.state IN (
                       'creating', 'replaying', 'ready', 'executing',
                       'stopping'
                     )
                )
             UNION ALL
             SELECT 'replay-checkpoint'::text AS kind,
                    checkpoint.id,
                    checkpoint.state_path,
                    checkpoint.checksum,
                    request.dr_clean_by AS delete_after
               FROM browser_replay_checkpoints checkpoint
               JOIN requests request ON request.id = checkpoint.request_id
              WHERE checkpoint.state_path IS NOT NULL
                AND checkpoint.file_deleted_at IS NULL
                AND request.dr_clean_by IS NOT NULL
                AND request.dr_clean_by <= $1
           ) expired
          ORDER BY delete_after, kind, id
          LIMIT $2`,
        [now, limit],
      );
      return result.rows.map(toBrowserStateFile);
    } catch (error) {
      released = true;
      client.release(true);
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async tryClaimBrowserStateFile(
    candidate: ExpiredBrowserStateFile,
    now: Date,
  ): Promise<BrowserStateFileClaim | null> {
    const client = await this.pool.connect();
    let lockAcquired = false;
    let clientReleased = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
        [candidate.statePath],
      );
      lockAcquired = lock.rows[0]?.acquired === true;
      if (!lockAcquired) {
        clientReleased = true;
        client.release();
        return null;
      }

      const current = await selectBrowserStateFile(client, candidate, now);
      if (!current) {
        clientReleased = true;
        await releaseBrowserStateLock(client, candidate.statePath);
        return null;
      }

      let claimReleased = false;
      let destroyOnRelease = false;
      return {
        file: current,
        markFileDeleted: async () => {
          try {
            const result =
              current.kind === "replay-checkpoint"
                ? await client.query(
                    `UPDATE browser_replay_checkpoints checkpoint
                        SET state_path = NULL, file_deleted_at = $5
                      WHERE checkpoint.id = $1
                        AND checkpoint.state_path = $2
                        AND checkpoint.checksum = $3
                        AND checkpoint.file_deleted_at IS NULL
                        AND EXISTS (
                          SELECT 1 FROM requests request
                           WHERE request.id = checkpoint.request_id
                             AND request.dr_clean_by IS NOT NULL
                             AND request.dr_clean_by <= $4
                        )`,
                    [current.id, current.statePath, current.checksum, now, now],
                  )
                : await client.query(
                    `UPDATE browser_profile_generations generation
                        SET state_path = NULL, file_deleted_at = $5
                      WHERE generation.id = $1
                        AND generation.state_path = $2
                        AND generation.checksum = $3
                        AND generation.file_deleted_at IS NULL
                        AND generation.expires_at IS NOT NULL
                        AND generation.expires_at <= $4
                        AND NOT EXISTS (
                          SELECT 1 FROM browser_profiles profile
                           WHERE profile.id = generation.profile_id
                             AND profile.latest_generation_id = generation.id
                        )
                        AND NOT EXISTS (
                          SELECT 1 FROM browser_sessions session
                           WHERE session.profile_generation_id = generation.id
                             AND session.state IN (
                               'creating', 'replaying', 'ready', 'executing',
                               'stopping'
                             )
                        )`,
                    [current.id, current.statePath, current.checksum, now, now],
                  );
            return result.rowCount === 1;
          } catch (error) {
            destroyOnRelease = true;
            throw error;
          }
        },
        release: async () => {
          if (claimReleased) return;
          claimReleased = true;
          if (destroyOnRelease) {
            client.release(true);
          } else {
            await releaseBrowserStateLock(client, current.statePath);
          }
        },
      };
    } catch (error) {
      if (clientReleased) {
        throw error;
      } else if (lockAcquired) {
        try {
          await releaseBrowserStateLock(client, candidate.statePath);
        } catch (cleanupError) {
          throw new LocalRetentionResourceError(error, cleanupError);
        }
      } else {
        client.release(true);
      }
      throw error;
    }
  }

  async tryClaimArtifactManifest(
    candidate: ExpiredArtifactManifest,
    now: Date,
  ): Promise<ArtifactManifestClaim | null> {
    const client = await this.pool.connect();
    let lockAcquired = false;
    let clientReleased = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
                  hashtextextended($1, 0)
                ) AS acquired`,
        [candidate.objectKey],
      );
      lockAcquired = lock.rows[0]?.acquired === true;
      if (!lockAcquired) {
        clientReleased = true;
        client.release();
        return null;
      }

      const current = await client.query<ArtifactManifestRow>(
        `SELECT object_key, kind, request_id, job_id, delete_after,
                delete_after::text AS delete_after_token
           FROM local_artifacts artifact
          WHERE object_key = $1
            AND (
              artifact.delete_after <= $2
              OR EXISTS (
                SELECT 1 FROM requests request
                 WHERE request.id = artifact.request_id
                   AND request.dr_clean_by IS NOT NULL
                   AND request.dr_clean_by <= $2
              )
            )`,
        [candidate.objectKey, now],
      );
      if (!current.rows[0]) {
        clientReleased = true;
        await releaseArtifactLock(client, candidate.objectKey);
        return null;
      }

      const manifest = toManifest(current.rows[0]);
      let released = false;
      let destroyOnRelease = false;
      return {
        manifest,
        deleteManifest: async () => {
          try {
            const result = await client.query(
              `DELETE FROM local_artifacts
                WHERE object_key = $1
                  AND delete_after IS NOT DISTINCT FROM $2::timestamptz
                  AND (
                    delete_after <= $3
                    OR EXISTS (
                      SELECT 1 FROM requests request
                       WHERE request.id = local_artifacts.request_id
                         AND request.dr_clean_by IS NOT NULL
                         AND request.dr_clean_by <= $3
                    )
                  )`,
              [manifest.objectKey, manifest.deleteAfterToken, now],
            );
            return result.rowCount === 1;
          } catch (error) {
            destroyOnRelease = true;
            throw error;
          }
        },
        release: async () => {
          if (released) return;
          released = true;
          if (destroyOnRelease) {
            client.release(true);
          } else {
            await releaseArtifactLock(client, manifest.objectKey);
          }
        },
      };
    } catch (error) {
      if (clientReleased) {
        throw error;
      } else if (lockAcquired) {
        try {
          await releaseArtifactLock(client, candidate.objectKey);
        } catch (cleanupError) {
          throw new LocalRetentionResourceError(error, cleanupError);
        }
      } else {
        client.release(true);
      }
      throw error;
    }
  }

  async deleteExpiredOperationalRows(
    now: Date,
    limit: number,
  ): Promise<OperationalCleanupResult> {
    const client = await this.pool.connect();
    const startedAt = Date.now();
    let requestIds: string[] = [];
    let released = false;
    try {
      await client.query("BEGIN");
      let dependentRowsDeleted = 0;
      const expiredWebhooks = await client.query(
        `DELETE FROM webhook_logs
          WHERE id IN (
            SELECT id
              FROM webhook_logs
             WHERE dr_clean_by <= $1
             ORDER BY dr_clean_by, id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )`,
        [now, limit],
      );
      dependentRowsDeleted += expiredWebhooks.rowCount ?? 0;

      const expired = await client.query<{ id: string }>(
        `SELECT id
           FROM requests
          WHERE dr_clean_by IS NOT NULL
            AND dr_clean_by <= $1
            AND NOT EXISTS (
              SELECT 1
                FROM browser_replay_checkpoints checkpoint
               WHERE checkpoint.request_id = requests.id
                 AND checkpoint.state_path IS NOT NULL
                 AND checkpoint.file_deleted_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
                FROM local_artifacts artifact
               WHERE artifact.request_id = requests.id
                 AND artifact.kind LIKE 'browser%'
            )
          ORDER BY dr_clean_by, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      requestIds = expired.rows.map(row => row.id);
      if (requestIds.length === 0) {
        await client.query("COMMIT");
        return {
          requestsDeleted: 0,
          dependentRowsDeleted,
          requestIds: [],
        };
      }

      const webhooks = await client.query(
        `DELETE FROM webhook_logs
          WHERE request_id = ANY($1::uuid[])
             OR crawl_id IN (
               SELECT id FROM crawls
                WHERE request_id = ANY($1::uuid[])
               UNION
               SELECT id FROM batch_scrapes
                WHERE request_id = ANY($1::uuid[])
               UNION
               SELECT id FROM extracts
                WHERE request_id = ANY($1::uuid[])
               UNION
               SELECT id FROM scrapes
                WHERE request_id = ANY($1::uuid[])
             )
             OR scrape_id IN (
               SELECT id FROM scrapes
                WHERE request_id = ANY($1::uuid[])
             )`,
        [requestIds],
      );
      dependentRowsDeleted += webhooks.rowCount ?? 0;

      for (const table of operationalTables) {
        const deleted = await client.query(
          `DELETE FROM ${table} WHERE request_id = ANY($1::uuid[])`,
          [requestIds],
        );
        dependentRowsDeleted += deleted.rowCount ?? 0;
      }

      const requests = await client.query(
        `DELETE FROM requests WHERE id = ANY($1::uuid[])`,
        [requestIds],
      );
      await client.query("COMMIT");
      return {
        requestsDeleted: requests.rowCount ?? 0,
        dependentRowsDeleted,
        requestIds,
      };
    } catch (error) {
      let cleanupError: ReturnType<typeof errorMetadata> | undefined;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        cleanupError = errorMetadata(rollbackError);
      }
      released = true;
      client.release(true);
      throw new LocalOperationalRetentionError({
        requestIds,
        cause: error,
        durationMs: Date.now() - startedAt,
        cleanupError,
      });
    } finally {
      if (!released) client.release();
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.pool.end();
    return this.closePromise;
  }
}

async function selectBrowserStateFile(
  client: PoolClient,
  candidate: ExpiredBrowserStateFile,
  now: Date,
): Promise<ExpiredBrowserStateFile | null> {
  const result =
    candidate.kind === "replay-checkpoint"
      ? await client.query<BrowserStateFileRow>(
          `SELECT 'replay-checkpoint'::text AS kind,
                  checkpoint.id,
                  checkpoint.state_path,
                  checkpoint.checksum,
                  request.dr_clean_by AS delete_after
             FROM browser_replay_checkpoints checkpoint
             JOIN requests request ON request.id = checkpoint.request_id
            WHERE checkpoint.id = $1
              AND checkpoint.state_path = $2
              AND checkpoint.checksum = $3
              AND checkpoint.file_deleted_at IS NULL
              AND request.dr_clean_by IS NOT NULL
              AND request.dr_clean_by <= $4`,
          [candidate.id, candidate.statePath, candidate.checksum, now],
        )
      : await client.query<BrowserStateFileRow>(
          `SELECT 'profile-generation'::text AS kind,
                  generation.id,
                  generation.state_path,
                  generation.checksum,
                  generation.expires_at AS delete_after
             FROM browser_profile_generations generation
             JOIN browser_profiles profile
               ON profile.id = generation.profile_id
            WHERE generation.id = $1
              AND generation.state_path = $2
              AND generation.checksum = $3
              AND generation.file_deleted_at IS NULL
              AND generation.expires_at IS NOT NULL
              AND generation.expires_at <= $4
              AND profile.latest_generation_id IS DISTINCT FROM generation.id
              AND NOT EXISTS (
                SELECT 1 FROM browser_sessions session
                 WHERE session.profile_generation_id = generation.id
                   AND session.state IN (
                     'creating', 'replaying', 'ready', 'executing', 'stopping'
                   )
              )`,
          [candidate.id, candidate.statePath, candidate.checksum, now],
        );
  return result.rows[0] ? toBrowserStateFile(result.rows[0]) : null;
}

async function releaseBrowserStateLock(
  client: PoolClient,
  statePath: string,
): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      statePath,
    ]);
  } catch (error) {
    client.release(true);
    throw error;
  }
  client.release();
}

async function releaseArtifactLock(
  client: PoolClient,
  objectKey: string,
): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      objectKey,
    ]);
  } catch (error) {
    client.release(true);
    throw error;
  }
  client.release();
}

export async function runLocalRetentionIteration(
  options: IterationOptions,
): Promise<IterationResult> {
  const now = options.now ?? new Date();
  const logger = options.logger ?? defaultLogger;
  const startedAt = Date.now();
  const result: IterationResult = {
    artifactCandidates: 0,
    artifactsDeleted: 0,
    artifactFailures: 0,
    requestsDeleted: 0,
    dependentRowsDeleted: 0,
    requestIds: [],
  };
  const artifactFailureRecords: Array<{
    failure: ArtifactRetentionFailure;
    causes: unknown[];
    blocksOperationalCleanup: boolean;
  }> = [];

  if (options.artifactStore && !options.signal?.aborted) {
    const candidates = await options.database.listExpiredArtifactManifests(
      now,
      RETENTION_BATCH_SIZE,
    );
    result.artifactCandidates = candidates.length;
    for (const candidate of candidates) {
      if (options.signal?.aborted) break;
      const claim = await options.database.tryClaimArtifactManifest(
        candidate,
        now,
      );
      if (!claim) continue;
      let failureRecord:
        | {
            failure: ArtifactRetentionFailure;
            causes: unknown[];
            blocksOperationalCleanup: boolean;
          }
        | undefined;
      let primaryError: unknown;
      let interrupted = false;
      try {
        try {
          await options.artifactStore.delete(claim.manifest.objectKey);
        } catch (error) {
          result.artifactFailures += 1;
          const failure = new LocalArtifactRetentionError({
            ...result,
            durationMs: Date.now() - startedAt,
            objectKey: claim.manifest.objectKey,
            requestId: claim.manifest.requestId,
            jobId: claim.manifest.jobId,
            provider: options.artifactStore.provider,
            cause: error,
          });
          failureRecord = {
            failure: failure.failures[0]!,
            causes: [error],
            blocksOperationalCleanup:
              claim.manifest.kind === "browser-run" ||
              claim.manifest.kind.startsWith("browser-"),
          };
        }
        if (failureRecord) {
          // Keep the manifest retryable while later candidates still progress.
        } else if (options.signal?.aborted) {
          interrupted = true;
        } else if (await claim.deleteManifest()) {
          result.artifactsDeleted += 1;
        }
      } catch (error) {
        primaryError = error;
      }
      let cleanupError: unknown;
      try {
        await claim.release();
      } catch (error) {
        cleanupError = error;
      }
      if (failureRecord) {
        if (cleanupError) {
          failureRecord.failure.cleanupError = errorMetadata(cleanupError);
          failureRecord.causes.push(cleanupError);
        }
        artifactFailureRecords.push(failureRecord);
        const failure = new LocalArtifactRetentionError({
          ...result,
          durationMs: Date.now() - startedAt,
          ...failureRecord.failure,
          failures: [failureRecord.failure],
          cause:
            failureRecord.causes.length === 1
              ? failureRecord.causes[0]
              : new AggregateError(
                  failureRecord.causes,
                  "Local artifact delete and claim cleanup failed",
                ),
        });
        logger.error(
          "Local artifact retention delete failed",
          retentionFailureMetadata(failure),
        );
        continue;
      }
      if (primaryError) {
        if (cleanupError) {
          result.artifactFailures += 1;
          throw new LocalArtifactRetentionError({
            ...result,
            durationMs: Date.now() - startedAt,
            objectKey: claim.manifest.objectKey,
            requestId: claim.manifest.requestId,
            jobId: claim.manifest.jobId,
            provider: options.artifactStore.provider,
            failures: [
              {
                objectKey: claim.manifest.objectKey,
                requestId: claim.manifest.requestId,
                jobId: claim.manifest.jobId,
                provider: options.artifactStore.provider,
                ...errorMetadata(primaryError),
                cleanupError: errorMetadata(cleanupError),
              },
            ],
            cause: new AggregateError(
              [primaryError, cleanupError],
              "Local artifact operation and claim cleanup failed",
            ),
          });
        }
        throw primaryError;
      }
      if (cleanupError) {
        result.artifactFailures += 1;
        throw new LocalArtifactRetentionError({
          ...result,
          durationMs: Date.now() - startedAt,
          objectKey: claim.manifest.objectKey,
          requestId: claim.manifest.requestId,
          jobId: claim.manifest.jobId,
          provider: options.artifactStore.provider,
          cause: cleanupError,
        });
      }
      if (interrupted) break;
    }
  }

  if (options.browserStateFilesystem && !options.signal?.aborted) {
    const candidates = await options.database.listExpiredBrowserStateFiles(
      now,
      RETENTION_BATCH_SIZE,
    );
    for (const candidate of candidates) {
      if (options.signal?.aborted) break;
      const claim = await options.database.tryClaimBrowserStateFile(
        candidate,
        now,
      );
      if (!claim) continue;
      let primaryError: unknown;
      try {
        await options.browserStateFilesystem.delete(claim.file.statePath);
        if (!options.signal?.aborted && !(await claim.markFileDeleted())) {
          throw new BrowserStateFileClaimLostError();
        }
      } catch (error) {
        primaryError = error;
      }
      let cleanupError: unknown;
      try {
        await claim.release();
      } catch (error) {
        cleanupError = error;
      }
      if (primaryError || cleanupError) {
        const cause =
          primaryError && cleanupError
            ? new AggregateError(
                [primaryError, cleanupError],
                "Browser state delete and claim cleanup failed",
              )
            : (primaryError ?? cleanupError);
        throw new LocalBrowserStateRetentionError(
          claim.file.kind,
          claim.file.statePath,
          cause,
        );
      }
    }
  }

  const blockingArtifactFailure = artifactFailureRecords.find(
    record => record.blocksOperationalCleanup,
  );
  if (blockingArtifactFailure) {
    const first = blockingArtifactFailure.failure;
    throw new LocalArtifactRetentionError({
      ...result,
      durationMs: Date.now() - startedAt,
      objectKey: first.objectKey,
      requestId: first.requestId,
      jobId: first.jobId,
      provider: first.provider,
      failures: artifactFailureRecords.map(record => record.failure),
      cause: new AggregateError(
        artifactFailureRecords.flatMap(record => record.causes),
        "Local browser artifact retention deletes failed",
      ),
    });
  }

  if (!options.signal?.aborted) {
    try {
      const operational = await options.database.deleteExpiredOperationalRows(
        now,
        RETENTION_BATCH_SIZE,
      );
      result.requestsDeleted = operational.requestsDeleted;
      result.dependentRowsDeleted = operational.dependentRowsDeleted;
      result.requestIds = operational.requestIds;
    } catch (error) {
      const requestIds =
        error instanceof LocalOperationalRetentionError ? error.requestIds : [];
      const operationalCause =
        error instanceof LocalOperationalRetentionError ? error.cause : error;
      throw new LocalOperationalRetentionError({
        requestIds,
        cause:
          artifactFailureRecords.length === 0
            ? operationalCause
            : new AggregateError(
                [
                  ...artifactFailureRecords.flatMap(record => record.causes),
                  operationalCause,
                ],
                "Local artifact and operational retention failed",
              ),
        cleanupError:
          error instanceof LocalOperationalRetentionError
            ? error.cleanupError
            : undefined,
        failures: artifactFailureRecords.map(record => record.failure),
        progress: result,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  if (artifactFailureRecords.length > 0) {
    const first = artifactFailureRecords[0]!.failure;
    throw new LocalArtifactRetentionError({
      ...result,
      durationMs: Date.now() - startedAt,
      objectKey: first.objectKey,
      requestId: first.requestId,
      jobId: first.jobId,
      provider: first.provider,
      failures: artifactFailureRecords.map(record => record.failure),
      cause: new AggregateError(
        artifactFailureRecords.flatMap(record => record.causes),
        "Local artifact retention deletes failed",
      ),
    });
  }

  const iterationMetadata = {
    ...result,
    durationMs: Date.now() - startedAt,
  };
  if (
    result.artifactsDeleted > 0 ||
    result.artifactFailures > 0 ||
    result.requestsDeleted > 0 ||
    result.dependentRowsDeleted > 0
  ) {
    logger.info("Local retention iteration completed", iterationMetadata);
  } else {
    logger.debug("Local retention iteration completed", iterationMetadata);
  }
  return result;
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runLocalRetentionLoop(
  options: LoopOptions,
): Promise<void> {
  const localConfig = resolveLocalRuntimeConfig(options.configSource ?? config);
  if (!localConfig.enabled) return;

  const logger = options.logger ?? defaultLogger;
  const ownsDatabase = options.database === undefined;
  const artifactStore =
    options.artifactStore === undefined
      ? getArtifactStore()
      : options.artifactStore;
  const runtimeSource = (options.configSource ??
    config) as LocalRuntimeConfigSource & {
    LOCAL_BROWSER_STATE_ROOT?: string;
  };
  const browserStateFilesystem =
    options.browserStateFilesystem === undefined
      ? new BrowserStateFilesystem(
          runtimeSource.LOCAL_BROWSER_STATE_ROOT ??
            "/var/lib/firecrawl-browser",
        )
      : options.browserStateFilesystem;
  const database =
    options.database ??
    new PgLocalRetentionDatabase(localConfig.applicationDatabaseUrl);
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? (() => new Date());

  logger.info("Local retention worker started", {
    artifactProvider: localConfig.artifactProvider,
  });
  try {
    while (!options.signal.aborted) {
      try {
        await runLocalRetentionIteration({
          database,
          artifactStore,
          browserStateFilesystem,
          now: now(),
          signal: options.signal,
          logger,
        });
      } catch (error) {
        logger.error(
          "Local retention iteration failed",
          retentionFailureMetadata(error),
        );
      }
      if (!options.signal.aborted) {
        await sleep(IDLE_BACKOFF_MS, options.signal);
      }
    }
  } finally {
    if (ownsDatabase) await database.close();
    logger.info("Local retention worker stopped");
  }
}

export function createLocalRetentionService(
  runner: LocalRetentionRunner,
  options: LocalRetentionServiceOptions = {},
): LocalRetentionService {
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const stopTimeoutMs = options.stopTimeoutMs ?? RETENTION_STOP_TIMEOUT_MS;
  const logger = options.logger ?? defaultLogger;

  return {
    start() {
      if (loop) return loop;
      controller = new AbortController();
      loop = runner(controller.signal);
      void loop.catch(() => undefined);
      return loop;
    },
    async stop() {
      controller?.abort();
      if (!loop) return;
      if (!stopPromise) {
        stopPromise = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new LocalRetentionShutdownTimeoutError(stopTimeoutMs);
            logger.error("Local retention worker shutdown timed out", {
              ...errorMetadata(error),
              timeoutMs: stopTimeoutMs,
            });
            reject(error);
          }, stopTimeoutMs);
          void loop!.then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            error => {
              clearTimeout(timer);
              reject(error);
            },
          );
        });
      }
      await stopPromise;
    },
  };
}
