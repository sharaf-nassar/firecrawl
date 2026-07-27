import { Pool, type PoolClient, type PoolConfig } from "pg";

import { config } from "../config";
import { getArtifactStore, type ArtifactStore } from "../lib/artifacts";
import { inspectBrowserStateProcessIdentity } from "../lib/browser-state/process-identity";
import type {
  BrowserControlFenceTransaction,
  BrowserStateMutationLease,
  BrowserStartupGate,
} from "../lib/browser-runtime/startup-gate";
import { logger as defaultLogger } from "../lib/logger";
import {
  resolveLocalRuntimeConfig,
  type LocalRuntimeConfigSource,
} from "../lib/local-runtime-config";

const RETENTION_BATCH_SIZE = 50;
const BROWSER_CLEANUP_INTENT_BATCH_DIVISOR = 5;
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
  kind: "replay-checkpoint" | "replay-cleanup-intent" | "profile-generation";
  id: string;
  statePath: string;
  checksum: string;
  deleteAfter: Date;
  scrapeId?: string;
};

export type BrowserStateFileClaim = {
  file: ExpiredBrowserStateFile;
  deleteFile: boolean;
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
  browserStateCandidates: number;
  browserStateFilesDeleted: number;
  browserStateFailures: number;
  durationMs: number;
};

type RetentionFailurePhase =
  | "artifact-delete"
  | "browser-state-delete"
  | "operational-cleanup";

abstract class LocalRetentionFailure extends Error {
  readonly artifactCandidates: number;
  readonly artifactsDeleted: number;
  readonly artifactFailures: number;
  readonly browserStateCandidates: number;
  readonly browserStateFilesDeleted: number;
  readonly browserStateFailures: number;
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
    this.browserStateCandidates = progress.browserStateCandidates;
    this.browserStateFilesDeleted = progress.browserStateFilesDeleted;
    this.browserStateFailures = progress.browserStateFailures;
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
        browserStateCandidates: options.progress?.browserStateCandidates ?? 0,
        browserStateFilesDeleted:
          options.progress?.browserStateFilesDeleted ?? 0,
        browserStateFailures: options.progress?.browserStateFailures ?? 0,
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

type BrowserStateFailureOperation =
  | "claim"
  | "filesystem-delete"
  | "metadata-cas"
  | "claim-release";

export type BrowserStateRetentionFailure = {
  fileKind: ExpiredBrowserStateFile["kind"];
  operation: BrowserStateFailureOperation;
  errorName: string;
  errorCode?: string;
  cleanupError?: ReturnType<typeof errorMetadata>;
};

type BrowserStateRetentionFailureOptions = RetentionFailureProgress & {
  failures: BrowserStateRetentionFailure[];
  cause: unknown;
};

export class LocalBrowserStateRetentionError extends LocalRetentionFailure {
  readonly failures: BrowserStateRetentionFailure[];

  constructor(options: BrowserStateRetentionFailureOptions) {
    super(
      "LocalBrowserStateRetentionError",
      "Browser state retention delete failed",
      "browser_state_delete_failed",
      "browser-state-delete",
      options,
      options.cause,
    );
    this.failures = options.failures
      .slice(0, RETENTION_BATCH_SIZE)
      .map(failure => ({ ...failure }));
  }
}

export interface LocalRetentionDatabase {
  listExpiredBrowserStateFiles(
    now: Date,
    limit: number,
    controlTransaction?: BrowserControlFenceTransaction,
  ): Promise<ExpiredBrowserStateFile[]>;
  tryClaimBrowserStateFile(
    candidate: ExpiredBrowserStateFile,
    now: Date,
    controlTransaction?: BrowserControlFenceTransaction,
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
  browserStateFilesystem?: BrowserStateFileDeleter | null;
  now?: Date;
  signal?: AbortSignal;
  logger?: RetentionLogger;
  operationalRetentionEnabled?: boolean;
  browserControlTransaction?: BrowserControlFenceTransaction;
};

type IterationResult = OperationalCleanupResult & {
  artifactCandidates: number;
  artifactsDeleted: number;
  artifactFailures: number;
  browserStateCandidates: number;
  browserStateFilesDeleted: number;
  browserStateFailures: number;
};

type LoopOptions = {
  signal: AbortSignal;
  configSource?: LocalRuntimeConfigSource;
  database?: LocalRetentionDatabase;
  artifactStore?: ArtifactStore | null;
  browserStateFilesystem?: BrowserStateFileDeleter | null;
  deleteReplayCheckpoint?: (
    statePath: string,
    checksum: string,
    lease: BrowserStateMutationLease,
  ) => Promise<void>;
  deleteProfileGeneration?: (
    generationId: string,
    statePath: string,
    checksum: string,
    lease: BrowserStateMutationLease,
  ) => Promise<void>;
  logger?: RetentionLogger;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  browserStartupGate?: BrowserStartupGate;
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

/** @public */
export type CleanupIntentStartupRecoveryResult = {
  liveRetained: number;
  unknownRetained: number;
  deadRecovered: number;
  missingConverged: number;
};

export type BrowserStateFileDeleter = {
  delete(statePath: string): Promise<void>;
  deleteWithChecksum?(statePath: string, checksum: string): Promise<void>;
  deleteCandidate?(candidate: BrowserStateDeletionAuthority): Promise<void>;
};

export type BrowserStateDeletionAuthority =
  | Readonly<{
      kind: "replay-checkpoint" | "replay-cleanup-intent";
      statePath: string;
      checksum: string;
    }>
  | Readonly<{
      kind: "profile-generation";
      generationId: string;
      statePath: string;
      checksum: string;
    }>;

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
  scrape_id: string | null;
};

type BrowserCleanupIntentRow = {
  id: string;
  scrape_id: string;
  state_path: string;
  checksum: string;
  state: "cleanup" | "preparing";
  created_at: Date;
  writer_lease: string | null;
  writer_pid: number | null;
  writer_boot_id: string | null;
  writer_start_time: string | null;
};

type SelectedBrowserStateFile = {
  file: ExpiredBrowserStateFile;
  deleteFile: boolean;
  intentState?: BrowserCleanupIntentRow["state"];
  writerLease?: string | null;
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
    ...(row.scrape_id ? { scrapeId: row.scrape_id } : {}),
  };
}

function toCleanupIntentFile(
  row: BrowserCleanupIntentRow,
): ExpiredBrowserStateFile {
  return {
    kind: "replay-cleanup-intent",
    id: row.id,
    statePath: row.state_path,
    checksum: row.checksum,
    deleteAfter: row.created_at,
    scrapeId: row.scrape_id,
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
    browserStateCandidates: error.browserStateCandidates,
    browserStateFilesDeleted: error.browserStateFilesDeleted,
    browserStateFailures: error.browserStateFailures,
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
  } else if (error instanceof LocalBrowserStateRetentionError) {
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
  inspectProcessIdentity?: typeof inspectBrowserStateProcessIdentity;
};

export class PgLocalRetentionDatabase implements LocalRetentionDatabase {
  private readonly pool: Pool;
  private readonly inspectProcessIdentity: typeof inspectBrowserStateProcessIdentity;
  private closePromise: Promise<void> | undefined;

  constructor(
    connectionString: string,
    dependencies: PgLocalRetentionDependencies = {},
  ) {
    this.inspectProcessIdentity =
      dependencies.inspectProcessIdentity ?? inspectBrowserStateProcessIdentity;
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
    controlTransaction?: BrowserControlFenceTransaction,
  ): Promise<ExpiredBrowserStateFile[]> {
    const ownsClient = controlTransaction === undefined;
    const client = controlTransaction ?? (await this.pool.connect());
    let released = false;
    try {
      const candidates: ExpiredBrowserStateFile[] = [];
      const cleanupLimit = Math.min(
        limit,
        Math.max(1, Math.ceil(limit / BROWSER_CLEANUP_INTENT_BATCH_DIVISOR)),
      );
      if (cleanupLimit > 0) {
        const cleanup = await client.query<BrowserCleanupIntentRow>(
          `SELECT id, scrape_id, state_path, checksum, state, created_at,
                  writer_lease, writer_pid, writer_boot_id, writer_start_time
             FROM browser_replay_checkpoint_cleanup_intents
            WHERE state = 'cleanup'
            ORDER BY created_at, id
            LIMIT $1`,
          [cleanupLimit],
        );
        candidates.push(...cleanup.rows.map(toCleanupIntentFile));
      }
      const remainingCleanup = Math.max(0, cleanupLimit - candidates.length);
      if (remainingCleanup > 0) {
        const preparing = await client.query<BrowserCleanupIntentRow>(
          `SELECT id, scrape_id, state_path, checksum, state, created_at,
                  writer_lease, writer_pid, writer_boot_id, writer_start_time
             FROM browser_replay_checkpoint_cleanup_intents
            WHERE state = 'preparing'
            ORDER BY created_at, id
            LIMIT $1`,
          [Math.max(remainingCleanup * 4, remainingCleanup)],
        );
        for (const intent of preparing.rows) {
          if (candidates.length >= cleanupLimit) break;
          if (
            intent.writer_pid === null ||
            intent.writer_boot_id === null ||
            intent.writer_start_time === null
          ) {
            continue;
          }
          const identity = await this.inspectProcessIdentity({
            pid: intent.writer_pid,
            bootId: intent.writer_boot_id,
            startTime: intent.writer_start_time,
          });
          if (identity === "dead") {
            candidates.push(toCleanupIntentFile(intent));
          }
        }
      }
      const remaining = Math.max(0, limit - candidates.length);
      if (remaining > 0) {
        const result = await client.query<BrowserStateFileRow>(
          `SELECT kind, id, state_path, checksum, delete_after, scrape_id
             FROM (
               SELECT 'profile-generation'::text AS kind,
                      generation.id,
                      generation.state_path,
                      generation.checksum,
                      generation.expires_at AS delete_after,
                      NULL::uuid AS scrape_id
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
                      request.dr_clean_by AS delete_after,
                      checkpoint.scrape_id
                 FROM browser_replay_checkpoints checkpoint
                 JOIN requests request ON request.id = checkpoint.request_id
                WHERE checkpoint.state_path IS NOT NULL
                  AND checkpoint.file_deleted_at IS NULL
                  AND request.dr_clean_by IS NOT NULL
                  AND request.dr_clean_by <= $1
             ) expired
            ORDER BY delete_after, kind, id
            LIMIT $2`,
          [now, remaining],
        );
        candidates.push(...result.rows.map(toBrowserStateFile));
      }
      return candidates;
    } catch (error) {
      if (ownsClient) {
        released = true;
        (client as PoolClient).release(true);
      }
      throw error;
    } finally {
      if (ownsClient && !released) (client as PoolClient).release();
    }
  }

  async tryClaimBrowserStateFile(
    candidate: ExpiredBrowserStateFile,
    now: Date,
    controlTransaction?: BrowserControlFenceTransaction,
  ): Promise<BrowserStateFileClaim | null> {
    const ownsClient = controlTransaction === undefined;
    const client = controlTransaction ?? (await this.pool.connect());
    const acquiredLocks: string[] = [];
    let clientReleased = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
        [candidate.statePath],
      );
      if (lock.rows[0]?.acquired !== true) {
        clientReleased = true;
        if (ownsClient) (client as PoolClient).release();
        return null;
      }
      acquiredLocks.push(candidate.statePath);
      if (candidate.scrapeId) {
        const scrapeLock = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
          [candidate.scrapeId],
        );
        if (scrapeLock.rows[0]?.acquired !== true) {
          clientReleased = true;
          await releaseBrowserStateLocks(client, acquiredLocks, ownsClient);
          return null;
        }
        acquiredLocks.push(candidate.scrapeId);
      }

      const selected = await selectBrowserStateFile(
        client,
        candidate,
        now,
        this.inspectProcessIdentity,
      );
      if (!selected) {
        clientReleased = true;
        await releaseBrowserStateLocks(client, acquiredLocks, ownsClient);
        return null;
      }
      const current = selected.file;

      let claimReleased = false;
      let destroyOnRelease = false;
      return {
        file: current,
        deleteFile: selected.deleteFile,
        markFileDeleted: async () => {
          try {
            const result =
              current.kind === "replay-cleanup-intent"
                ? await client.query(
                    `DELETE FROM browser_replay_checkpoint_cleanup_intents intent
                      WHERE intent.id = $1
                        AND intent.state_path = $2
                        AND intent.checksum = $3
                        AND intent.state = $4
                        AND intent.writer_lease IS NOT DISTINCT FROM $5::uuid
                        AND (
                          $6::boolean = false
                          OR NOT EXISTS (
                            SELECT 1 FROM browser_replay_checkpoints checkpoint
                             WHERE checkpoint.scrape_id = intent.scrape_id
                               AND checkpoint.state_path = intent.state_path
                               AND checkpoint.checksum = intent.checksum
                          )
                        )`,
                    [
                      current.id,
                      current.statePath,
                      current.checksum,
                      selected.intentState,
                      selected.writerLease,
                      selected.deleteFile,
                    ],
                  )
                : current.kind === "replay-checkpoint"
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
                      [
                        current.id,
                        current.statePath,
                        current.checksum,
                        now,
                        now,
                      ],
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
                      [
                        current.id,
                        current.statePath,
                        current.checksum,
                        now,
                        now,
                      ],
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
            if (ownsClient) (client as PoolClient).release(true);
          } else {
            await releaseBrowserStateLocks(client, acquiredLocks, ownsClient);
          }
        },
      };
    } catch (error) {
      if (clientReleased) {
        throw error;
      } else if (acquiredLocks.length > 0) {
        try {
          await releaseBrowserStateLocks(client, acquiredLocks, ownsClient);
        } catch (cleanupError) {
          throw new LocalRetentionResourceError(error, cleanupError);
        }
      } else if (ownsClient) {
        (client as PoolClient).release(true);
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
            AND NOT EXISTS (
              SELECT 1
                FROM browser_replay_checkpoint_cleanup_intents intent
                JOIN scrapes scrape ON scrape.id = intent.scrape_id
               WHERE scrape.request_id = requests.id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM browser_sessions session
               WHERE session.request_id = requests.id
                 AND session.state IN (
                   'creating', 'replaying', 'ready', 'executing', 'stopping'
                 )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM browser_sessions session
                JOIN browser_billing_outbox outbox
                  ON outbox.session_id = session.id
               WHERE session.request_id = requests.id
                 AND outbox.state <> 'delivered'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM browser_sessions session
                JOIN browser_admission_cleanup cleanup
                  ON cleanup.session_id = session.id
               WHERE session.request_id = requests.id
                 AND (
                   (
                     cleanup.backend IN ('redis', 'both')
                     AND cleanup.redis_released_at IS NULL
                   )
                   OR (
                     cleanup.backend IN ('fdb', 'both')
                     AND cleanup.fdb_released_at IS NULL
                   )
                 )
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
  client: Pick<PoolClient, "query">,
  candidate: ExpiredBrowserStateFile,
  now: Date,
  inspectProcessIdentity: typeof inspectBrowserStateProcessIdentity,
): Promise<SelectedBrowserStateFile | null> {
  if (candidate.kind === "replay-cleanup-intent") {
    const result = await client.query<
      BrowserCleanupIntentRow & {
        current_state_path: string | null;
        current_checksum: string | null;
      }
    >(
      `SELECT intent.id, intent.scrape_id, intent.state_path,
              intent.checksum, intent.state, intent.created_at,
              intent.writer_lease, intent.writer_pid,
              intent.writer_boot_id, intent.writer_start_time,
              checkpoint.state_path AS current_state_path,
              checkpoint.checksum AS current_checksum
         FROM browser_replay_checkpoint_cleanup_intents intent
         LEFT JOIN browser_replay_checkpoints checkpoint
           ON checkpoint.scrape_id = intent.scrape_id
        WHERE intent.id = $1
          AND intent.state_path = $2
          AND intent.checksum = $3`,
      [candidate.id, candidate.statePath, candidate.checksum],
    );
    const intent = result.rows[0];
    if (!intent) return null;
    if (intent.state === "preparing") {
      if (
        intent.writer_pid === null ||
        intent.writer_boot_id === null ||
        intent.writer_start_time === null
      ) {
        return null;
      }
      const identity = await inspectProcessIdentity({
        pid: intent.writer_pid,
        bootId: intent.writer_boot_id,
        startTime: intent.writer_start_time,
      });
      if (identity !== "dead") return null;
    }
    return {
      file: toCleanupIntentFile(intent),
      deleteFile: intent.current_state_path !== intent.state_path,
      intentState: intent.state,
      writerLease: intent.writer_lease,
    };
  }

  const result =
    candidate.kind === "replay-checkpoint"
      ? await client.query<BrowserStateFileRow>(
          `SELECT 'replay-checkpoint'::text AS kind,
                  checkpoint.id,
                  checkpoint.state_path,
                  checkpoint.checksum,
                  request.dr_clean_by AS delete_after,
                  checkpoint.scrape_id
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
                  generation.expires_at AS delete_after,
                  NULL::uuid AS scrape_id
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
  return result.rows[0]
    ? { file: toBrowserStateFile(result.rows[0]), deleteFile: true }
    : null;
}

async function releaseBrowserStateLocks(
  client: Pick<PoolClient, "query">,
  lockKeys: string[],
  releaseClient = true,
): Promise<void> {
  try {
    for (const lockKey of [...lockKeys].reverse()) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        lockKey,
      ]);
    }
  } catch (error) {
    if (releaseClient) (client as PoolClient).release(true);
    throw error;
  }
  if (releaseClient) (client as PoolClient).release();
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

/** @public */
export async function recoverBrowserCleanupIntentsBeforeSnapshot(deps: {
  pool: Pick<Pool, "connect">;
  filesystem: BrowserStateFileDeleter;
  inspectProcessIdentity: typeof inspectBrowserStateProcessIdentity;
  signal: AbortSignal;
}): Promise<CleanupIntentStartupRecoveryResult> {
  const result: CleanupIntentStartupRecoveryResult = {
    liveRetained: 0,
    unknownRetained: 0,
    deadRecovered: 0,
    missingConverged: 0,
  };
  const listing = await deps.pool.connect();
  let intents: BrowserCleanupIntentRow[];
  try {
    intents = (
      await listing.query<BrowserCleanupIntentRow>(
        `SELECT id, scrape_id, state_path, checksum, state, created_at,
                writer_lease, writer_pid, writer_boot_id, writer_start_time
           FROM browser_replay_checkpoint_cleanup_intents
          WHERE state = 'preparing'
          ORDER BY created_at, id`,
      )
    ).rows;
  } finally {
    listing.release();
  }

  for (const candidate of intents) {
    if (deps.signal.aborted) {
      throw deps.signal.reason ?? new Error("cleanup recovery aborted");
    }
    if (
      candidate.writer_lease === null ||
      candidate.writer_pid === null ||
      candidate.writer_boot_id === null ||
      candidate.writer_start_time === null
    ) {
      throw new Error(
        "preparing cleanup intent has incomplete writer identity",
      );
    }
    const classification = await deps.inspectProcessIdentity({
      pid: candidate.writer_pid,
      bootId: candidate.writer_boot_id,
      startTime: candidate.writer_start_time,
    });
    if (classification === "live") {
      result.liveRetained += 1;
      continue;
    }
    if (classification === "unknown") {
      result.unknownRetained += 1;
      continue;
    }

    const client = await deps.pool.connect();
    const locks = [candidate.state_path, candidate.scrape_id];
    try {
      for (const lock of locks) {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
          lock,
        ]);
      }
      const selectExact = () =>
        client.query<
          BrowserCleanupIntentRow & { current_state_path: string | null }
        >(
          `SELECT intent.id, intent.scrape_id, intent.state_path,
                intent.checksum, intent.state, intent.created_at,
                intent.writer_lease, intent.writer_pid,
                intent.writer_boot_id, intent.writer_start_time,
                checkpoint.state_path AS current_state_path
           FROM browser_replay_checkpoint_cleanup_intents intent
           LEFT JOIN browser_replay_checkpoints checkpoint
             ON checkpoint.scrape_id = intent.scrape_id
          WHERE intent.id = $1
            AND intent.scrape_id = $2
            AND intent.state_path = $3
            AND intent.checksum = $4
            AND intent.state = 'preparing'
            AND intent.writer_lease = $5
            AND intent.writer_pid = $6
            AND intent.writer_boot_id = $7
            AND intent.writer_start_time = $8`,
          [
            candidate.id,
            candidate.scrape_id,
            candidate.state_path,
            candidate.checksum,
            candidate.writer_lease,
            candidate.writer_pid,
            candidate.writer_boot_id,
            candidate.writer_start_time,
          ],
        );
      let selected = await selectExact();
      if (!selected.rows[0]) selected = await selectExact();
      const current = selected.rows[0];
      if (!current) continue;
      const currentClassification = await deps.inspectProcessIdentity({
        pid: current.writer_pid!,
        bootId: current.writer_boot_id!,
        startTime: current.writer_start_time!,
      });
      if (currentClassification !== "dead") {
        result[
          currentClassification === "live" ? "liveRetained" : "unknownRetained"
        ] += 1;
        continue;
      }

      let missing = false;
      if (current.current_state_path !== current.state_path) {
        try {
          if (deps.filesystem.deleteWithChecksum) {
            await deps.filesystem.deleteWithChecksum(
              current.state_path,
              current.checksum,
            );
          } else {
            await deps.filesystem.delete(current.state_path);
          }
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            missing = true;
          } else {
            throw error;
          }
        }
      }
      let deleted = await client.query(
        `DELETE FROM browser_replay_checkpoint_cleanup_intents
          WHERE id = $1
            AND scrape_id = $2
            AND state_path = $3
            AND checksum = $4
            AND state = 'preparing'
            AND writer_lease = $5
            AND writer_pid = $6
            AND writer_boot_id = $7
            AND writer_start_time = $8`,
        [
          current.id,
          current.scrape_id,
          current.state_path,
          current.checksum,
          current.writer_lease,
          current.writer_pid,
          current.writer_boot_id,
          current.writer_start_time,
        ],
      );
      if (deleted.rowCount !== 1) {
        const retry = await selectExact();
        if (!retry.rows[0]) {
          throw new Error("cleanup intent recovery compare-and-set lost");
        }
        deleted = await client.query(
          `DELETE FROM browser_replay_checkpoint_cleanup_intents
            WHERE id = $1
              AND scrape_id = $2
              AND state_path = $3
              AND checksum = $4
              AND state = 'preparing'
              AND writer_lease = $5
              AND writer_pid = $6
              AND writer_boot_id = $7
              AND writer_start_time = $8`,
          [
            current.id,
            current.scrape_id,
            current.state_path,
            current.checksum,
            current.writer_lease,
            current.writer_pid,
            current.writer_boot_id,
            current.writer_start_time,
          ],
        );
        if (deleted.rowCount !== 1) {
          throw new Error("cleanup intent recovery compare-and-set failed");
        }
      }
      result[missing ? "missingConverged" : "deadRecovered"] += 1;
    } finally {
      try {
        for (const lock of [...locks].reverse()) {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [lock],
          );
        }
      } finally {
        client.release();
      }
    }
  }
  return result;
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
    browserStateCandidates: 0,
    browserStateFilesDeleted: 0,
    browserStateFailures: 0,
    requestsDeleted: 0,
    dependentRowsDeleted: 0,
    requestIds: [],
  };
  const artifactFailureRecords: Array<{
    failure: ArtifactRetentionFailure;
    causes: unknown[];
    blocksOperationalCleanup: boolean;
  }> = [];
  const browserFailureRecords: Array<{
    failure: BrowserStateRetentionFailure;
    causes: unknown[];
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
      options.browserControlTransaction,
    );
    result.browserStateCandidates = candidates.length;
    for (const candidate of candidates) {
      if (options.signal?.aborted) break;
      let claim: BrowserStateFileClaim | null;
      try {
        claim = await options.database.tryClaimBrowserStateFile(
          candidate,
          now,
          options.browserControlTransaction,
        );
      } catch (error) {
        result.browserStateFailures += 1;
        const source =
          error instanceof LocalRetentionResourceError ? error.cause : error;
        const failure: BrowserStateRetentionFailure = {
          fileKind: candidate.kind,
          operation: "claim",
          ...errorMetadata(source),
          ...(error instanceof LocalRetentionResourceError
            ? { cleanupError: error.cleanupError }
            : {}),
        };
        browserFailureRecords.push({ failure, causes: [error] });
        logger.error("Local browser state retention candidate failed", failure);
        continue;
      }
      if (!claim) continue;
      let primaryError: unknown;
      let primaryOperation: BrowserStateFailureOperation | undefined;
      let interrupted = false;
      try {
        if (claim.deleteFile) {
          try {
            if (options.browserStateFilesystem.deleteCandidate) {
              await options.browserStateFilesystem.deleteCandidate(
                claim.file.kind === "profile-generation"
                  ? {
                      kind: "profile-generation",
                      generationId: claim.file.id,
                      statePath: claim.file.statePath,
                      checksum: claim.file.checksum,
                    }
                  : {
                      kind: claim.file.kind,
                      statePath: claim.file.statePath,
                      checksum: claim.file.checksum,
                    },
              );
            } else if (options.browserStateFilesystem.deleteWithChecksum) {
              await options.browserStateFilesystem.deleteWithChecksum(
                claim.file.statePath,
                claim.file.checksum,
              );
            } else {
              await options.browserStateFilesystem.delete(claim.file.statePath);
            }
          } catch (error) {
            primaryOperation = "filesystem-delete";
            throw error;
          }
        }
        if (options.signal?.aborted) {
          interrupted = true;
        } else {
          try {
            if (!(await claim.markFileDeleted())) {
              throw new BrowserStateFileClaimLostError();
            }
            if (claim.deleteFile) result.browserStateFilesDeleted += 1;
          } catch (error) {
            primaryOperation = "metadata-cas";
            throw error;
          }
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
        result.browserStateFailures += 1;
        const failure: BrowserStateRetentionFailure = {
          fileKind: claim.file.kind,
          operation: primaryError
            ? (primaryOperation ?? "metadata-cas")
            : "claim-release",
          ...errorMetadata(primaryError ?? cleanupError),
          ...(primaryError && cleanupError
            ? { cleanupError: errorMetadata(cleanupError) }
            : {}),
        };
        browserFailureRecords.push({
          failure,
          causes: [primaryError, cleanupError].filter(
            (error): error is NonNullable<typeof error> => error != null,
          ),
        });
        logger.error("Local browser state retention candidate failed", failure);
        continue;
      }
      if (interrupted) break;
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

  if (
    options.operationalRetentionEnabled !== false &&
    !options.signal?.aborted
  ) {
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
      const priorCauses = [
        ...artifactFailureRecords.flatMap(record => record.causes),
        ...browserFailureRecords.flatMap(record => record.causes),
      ];
      throw new LocalOperationalRetentionError({
        requestIds,
        cause:
          priorCauses.length === 0
            ? operationalCause
            : new AggregateError(
                [...priorCauses, operationalCause],
                "Local file and operational retention failed",
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

  if (browserFailureRecords.length > 0) {
    throw new LocalBrowserStateRetentionError({
      ...result,
      durationMs: Date.now() - startedAt,
      failures: browserFailureRecords.map(record => record.failure),
      cause: new AggregateError(
        browserFailureRecords.flatMap(record => record.causes),
        "Browser state retention candidates failed",
      ),
    });
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
    result.browserStateFilesDeleted > 0 ||
    result.browserStateFailures > 0 ||
    result.requestsDeleted > 0 ||
    result.dependentRowsDeleted > 0
  ) {
    logger.info("Local retention iteration completed", iterationMetadata);
  } else {
    logger.debug("Local retention iteration completed", iterationMetadata);
  }
  return result;
}

/** @public */
export function runOperationalAndArtifactRetentionIteration(
  options: Omit<IterationOptions, "browserStateFilesystem">,
): Promise<IterationResult> {
  return runLocalRetentionIteration({
    ...options,
    browserStateFilesystem: null,
  });
}

/** @public */
export function runBrowserStateRetentionIteration(
  options: Omit<IterationOptions, "artifactStore">,
): Promise<IterationResult> {
  return runLocalRetentionIteration({
    ...options,
    artifactStore: null,
    operationalRetentionEnabled: false,
  });
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
  const runtimeSource = options.configSource ?? config;
  const browserStateFilesystem =
    runtimeSource.LOCAL_BROWSER_SERVICE_ENABLED === true
      ? options.browserStateFilesystem === undefined
        ? null
        : options.browserStateFilesystem
      : null;
  if (
    runtimeSource.LOCAL_BROWSER_SERVICE_ENABLED === true &&
    browserStateFilesystem === null &&
    (options.deleteReplayCheckpoint === undefined ||
      options.deleteProfileGeneration === undefined)
  ) {
    throw new Error("Browser state deletion authority is unavailable");
  }
  const database =
    options.database ??
    new PgLocalRetentionDatabase(localConfig.applicationDatabaseUrl);
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? (() => new Date());

  logger.info("Local retention worker started", {
    artifactProvider: localConfig.artifactProvider,
  });
  try {
    if (
      options.browserStartupGate &&
      (browserStateFilesystem !== null ||
        (options.deleteReplayCheckpoint !== undefined &&
          options.deleteProfileGeneration !== undefined))
    ) {
      const operationalLoop = async () => {
        while (!options.signal.aborted) {
          try {
            await runOperationalAndArtifactRetentionIteration({
              database,
              artifactStore,
              now: now(),
              signal: options.signal,
              logger,
            });
          } catch (error) {
            logger.error(
              "Local operational retention iteration failed",
              retentionFailureMetadata(error),
            );
          }
          if (!options.signal.aborted) {
            await sleep(IDLE_BACKOFF_MS, options.signal);
          }
        }
      };
      const browserLoop = async () => {
        while (!options.signal.aborted) {
          try {
            await options.browserStartupGate!.waitUntilOpen(options.signal);
            await options.browserStartupGate!.withBrowserStateMutationLease(
              "filesystem_and_database",
              async lease =>
                runBrowserStateRetentionIteration({
                  database,
                  browserStateFilesystem:
                    options.deleteReplayCheckpoint === undefined ||
                    options.deleteProfileGeneration === undefined
                      ? browserStateFilesystem
                      : {
                          delete: async () => {
                            throw new Error(
                              "Browser state checksum is unavailable",
                            );
                          },
                          deleteWithChecksum: (statePath, checksum) => {
                            return options.deleteReplayCheckpoint!(
                              statePath,
                              checksum,
                              lease,
                            );
                          },
                          deleteCandidate: candidate => {
                            if (candidate.kind === "profile-generation") {
                              if (
                                options.deleteProfileGeneration === undefined
                              ) {
                                throw new Error(
                                  "Profile generation deletion authority is unavailable",
                                );
                              }
                              return options.deleteProfileGeneration(
                                candidate.generationId,
                                candidate.statePath,
                                candidate.checksum,
                                lease,
                              );
                            }
                            return options.deleteReplayCheckpoint!(
                              candidate.statePath,
                              candidate.checksum,
                              lease,
                            );
                          },
                        },
                  browserControlTransaction: lease.transaction,
                  now: now(),
                  signal: options.signal,
                  logger,
                }),
            );
          } catch (error) {
            if (!options.signal.aborted) {
              logger.error(
                "Local browser state retention iteration failed",
                retentionFailureMetadata(error),
              );
            }
          }
          if (!options.signal.aborted) {
            await sleep(IDLE_BACKOFF_MS, options.signal);
          }
        }
      };
      await Promise.all([operationalLoop(), browserLoop()]);
      return;
    }
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
