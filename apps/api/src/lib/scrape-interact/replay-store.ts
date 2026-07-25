import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, eq, sql } from "drizzle-orm";
import type { Application } from "express";

import { config } from "../../config";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { runWithBrowserStateFilesystemContext } from "../browser-state/filesystem-store-internal";
import {
  BrowserStateFilesystem,
  canonicalizeBrowserStateCheckpoint,
} from "../browser-state/filesystem-store";
import type { BrowserStartupGate } from "../browser-runtime/startup-gate";
import { inspectBrowserStateProcessIdentity } from "../browser-state/process-identity";
import { logger as rootLogger } from "../logger";
import {
  normalizeReplayEnvelope,
  resolveReplayEnvelope,
  type ReplayBrowserSettingsV1,
  type ReplayResolution,
  type StoredReplayCheckpoint,
} from "./replay-envelope";
import { registerReplayIngestTransportRoute } from "./replay-ingest";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ReplayCheckpointCaptureV1 {
  version: 1;
  storageState: {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
      partitionKey?: string;
      _crHasCrossSiteAncestor?: boolean;
    }>;
    origins: Array<{
      origin: string;
      localStorage: Array<{ name: string; value: string }>;
      indexedDB?: Array<{
        name: string;
        version: number;
        stores: Array<{
          name: string;
          autoIncrement: boolean;
          keyPath?: string;
          keyPathArray?: string[];
          records: Array<{
            key?: JsonValue;
            keyEncoded?: JsonValue;
            value?: JsonValue;
            valueEncoded?: JsonValue;
          }>;
          indexes: Array<{
            name: string;
            keyPath?: string;
            keyPathArray?: string[];
            multiEntry: boolean;
            unique: boolean;
          }>;
        }>;
      }>;
    }>;
  };
  finalUrl: string;
  fingerprint: {
    finalUrl: string;
    titleSha256: string;
    bodyTextSha256: string;
  };
  browserSettings: ReplayBrowserSettingsV1;
}

/** @public */
export interface PersistScrapeReplayStateInput {
  requestId: string;
  scrapeId: string;
  ownerId: string;
  url: unknown;
  options: unknown;
  callerOrigin: unknown;
  zeroDataRetention: boolean;
  replayCheckpoint?: ReplayCheckpointCaptureV1;
}

/** @public */
export type ReplayPersistenceResult = {
  persisted: boolean;
  reason?: "disabled" | "zdr" | "checkpoint_unavailable";
};

class ReplayOwnershipError extends Error {
  readonly category = "replay_ownership_mismatch";

  constructor() {
    super("Replay ownership does not match persisted scrape request");
    this.name = "ReplayOwnershipError";
  }
}

class ReplayCheckpointValidationError extends Error {
  readonly category = "replay_checkpoint_unavailable";

  constructor() {
    super("Replay checkpoint is unavailable");
    this.name = "ReplayCheckpointValidationError";
  }
}

/** @public */
export class ReplayUnavailableError extends Error {
  readonly category = "replay_unavailable";

  constructor() {
    super("Replay checkpoint is unavailable");
    this.name = "ReplayUnavailableError";
  }
}

class ReplayCheckpointPreparationError extends Error {
  readonly category = "replay_checkpoint_preparation_failed";

  constructor() {
    super("Replay checkpoint preparation did not complete");
    this.name = "ReplayCheckpointPreparationError";
  }
}

class ReplayCheckpointAlreadyPersisted extends Error {
  constructor() {
    super("Replay checkpoint is already persisted");
    this.name = "ReplayCheckpointAlreadyPersisted";
  }
}

type PreparedCheckpoint = {
  cleanupIntentId: string;
  writerLease: string;
  ownerId: string;
  statePath: string;
  checksum: string;
  validated: Extract<ReplayResolution, { kind: "checkpoint" }>;
};

function requirePreparedCheckpoint(
  prepared: PreparedCheckpoint | undefined,
): PreparedCheckpoint {
  if (!prepared) throw new ReplayCheckpointPreparationError();
  return prepared;
}

const cleanupLogger = rootLogger.child({ module: "scrape-replay-store" });
type ReplayTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockScrape(
  tx: ReplayTransaction,
  scrapeId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${scrapeId}, 0))`,
  );
}

async function recoverCleanupIntents(
  tx: ReplayTransaction,
  filesystem: BrowserStateFilesystem,
  scrapeId: string,
  excludedIntentId?: string,
): Promise<void> {
  const [current] = await tx
    .select({
      statePath: schema.browser_replay_checkpoints.state_path,
      checksum: schema.browser_replay_checkpoints.checksum,
    })
    .from(schema.browser_replay_checkpoints)
    .where(eq(schema.browser_replay_checkpoints.scrape_id, scrapeId))
    .limit(1);
  const intents = await tx
    .select({
      id: schema.browser_replay_checkpoint_cleanup_intents.id,
      statePath: schema.browser_replay_checkpoint_cleanup_intents.state_path,
      checksum: schema.browser_replay_checkpoint_cleanup_intents.checksum,
      state: schema.browser_replay_checkpoint_cleanup_intents.state,
      writerPid: schema.browser_replay_checkpoint_cleanup_intents.writer_pid,
      writerBootId:
        schema.browser_replay_checkpoint_cleanup_intents.writer_boot_id,
      writerStartTime:
        schema.browser_replay_checkpoint_cleanup_intents.writer_start_time,
    })
    .from(schema.browser_replay_checkpoint_cleanup_intents)
    .where(
      eq(schema.browser_replay_checkpoint_cleanup_intents.scrape_id, scrapeId),
    );

  for (const intent of intents) {
    if (intent.id === excludedIntentId) continue;
    const isCurrent = intent.statePath === current?.statePath;
    if (!isCurrent && intent.state === "preparing") {
      if (
        intent.writerPid === null ||
        intent.writerBootId === null ||
        intent.writerStartTime === null
      ) {
        continue;
      }
      const identity = await inspectBrowserStateProcessIdentity({
        pid: intent.writerPid,
        bootId: intent.writerBootId,
        startTime: intent.writerStartTime,
      });
      if (identity !== "dead") continue;
    }
    try {
      if (!isCurrent) await filesystem.delete(intent.statePath);
      await tx
        .delete(schema.browser_replay_checkpoint_cleanup_intents)
        .where(
          eq(schema.browser_replay_checkpoint_cleanup_intents.id, intent.id),
        );
    } catch {
      await tx
        .update(schema.browser_replay_checkpoint_cleanup_intents)
        .set({
          attempts: sql`${schema.browser_replay_checkpoint_cleanup_intents.attempts} + 1`,
          last_error_category: "filesystem_delete_failed",
          last_attempted_at: new Date().toISOString(),
        })
        .where(
          eq(schema.browser_replay_checkpoint_cleanup_intents.id, intent.id),
        );
      cleanupLogger.error("Replay checkpoint cleanup deferred", {
        category: "replay_checkpoint_cleanup_deferred",
        cleanupIntentId: intent.id,
        scrapeId,
      });
    }
  }
}

async function recoverScrapeCleanup(
  filesystem: BrowserStateFilesystem,
  scrapeId: string,
  excludedIntentId?: string,
): Promise<void> {
  await db.transaction(async tx => {
    await lockScrape(tx, scrapeId);
    await recoverCleanupIntents(tx, filesystem, scrapeId, excludedIntentId);
  });
}

async function recoverWithoutMaskingPrimary(
  filesystem: BrowserStateFilesystem,
  scrapeId: string,
  prepared: Pick<
    PreparedCheckpoint,
    "cleanupIntentId" | "writerLease" | "ownerId" | "statePath" | "checksum"
  >,
  primary: unknown,
): Promise<never> {
  try {
    await db.transaction(async tx => {
      await lockScrape(tx, scrapeId);
      const updated = await tx
        .update(schema.browser_replay_checkpoint_cleanup_intents)
        .set({ state: "cleanup" })
        .where(
          and(
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.id,
              prepared.cleanupIntentId,
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.writer_lease,
              prepared.writerLease,
            ),
          ),
        )
        .returning({ id: schema.browser_replay_checkpoint_cleanup_intents.id });
      if (updated.length === 0) {
        await tx
          .insert(schema.browser_replay_checkpoint_cleanup_intents)
          .values({
            id: randomUUID(),
            scrape_id: scrapeId,
            owner_id: prepared.ownerId,
            state_path: prepared.statePath,
            checksum: prepared.checksum,
            state: "cleanup",
          })
          .onConflictDoNothing();
      }
      await recoverCleanupIntents(tx, filesystem, scrapeId);
    });
  } catch {
    cleanupLogger.error("Replay checkpoint cleanup recovery failed", {
      category: "replay_checkpoint_cleanup_recovery_failed",
      scrapeId,
    });
  }
  throw primary;
}

type BrowserRuntimeConfig = typeof config & {
  LOCAL_BROWSER_SERVICE_ENABLED?: boolean;
  LOCAL_BROWSER_STATE_ROOT?: string;
};

function unavailable(fields: string[]): ReplayResolution {
  const normalizedFields = [...new Set(fields)].sort((left, right) =>
    left.localeCompare(right),
  );
  return Object.freeze({
    kind: "error",
    category: "replay_unavailable",
    fields: Object.freeze(normalizedFields),
    message: `Replay state is unavailable: ${normalizedFields.join(", ")}`,
  }) as ReplayResolution;
}

function isRedactedPersistedValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("<redacted");
}

function runtimeConfig(): {
  enabled: boolean;
  root: string;
  retentionDays: number;
} {
  const source = config as BrowserRuntimeConfig;
  return {
    enabled: source.LOCAL_BROWSER_SERVICE_ENABLED === true,
    root: source.LOCAL_BROWSER_STATE_ROOT ?? "/var/lib/firecrawl-browser",
    retentionDays: source.LOCAL_RECORD_RETENTION_DAYS,
  };
}

async function persistScrapeReplayStateUnderAuthority(
  input: PersistScrapeReplayStateInput,
): Promise<ReplayPersistenceResult> {
  const runtime = runtimeConfig();
  if (!runtime.enabled) return { persisted: false, reason: "disabled" };
  if (input.zeroDataRetention) return { persisted: false, reason: "zdr" };
  if (!input.replayCheckpoint) {
    return { persisted: false, reason: "checkpoint_unavailable" };
  }

  const normalized = normalizeReplayEnvelope({
    url: input.url,
    options: input.options,
    callerOrigin: input.callerOrigin,
    browserSettings: input.replayCheckpoint.browserSettings,
  });
  if (normalized.kind === "error") {
    return { persisted: false, reason: "checkpoint_unavailable" };
  }
  const canonicalCheckpoint = canonicalizeBrowserStateCheckpoint(
    input.replayCheckpoint.storageState,
  );

  let prepared: PreparedCheckpoint | undefined;
  const filesystem = new BrowserStateFilesystem(runtime.root);

  let written: Awaited<ReturnType<BrowserStateFilesystem["writeCheckpoint"]>>;

  try {
    written = await runWithBrowserStateFilesystemContext(
      {
        beforeCheckpointWrite: async plan => {
          const checkpoint: StoredReplayCheckpoint = {
            version: 1,
            statePath: plan.pathId,
            storageState: input.replayCheckpoint!.storageState,
            finalUrl: input.replayCheckpoint!.finalUrl,
            fingerprint: input.replayCheckpoint!.fingerprint,
            checksum: plan.checksum,
            byteSize: plan.byteSize,
          };
          const validated = resolveReplayEnvelope({
            url: input.url,
            options: input.options,
            callerOrigin: input.callerOrigin,
            browserSettings: input.replayCheckpoint!.browserSettings,
            checkpoint,
          });
          if (validated.kind !== "checkpoint") {
            throw new ReplayCheckpointValidationError();
          }

          const cleanupIntentId = randomUUID();
          await db.transaction(async tx => {
            await lockScrape(tx, input.scrapeId);
            const [existingCheckpoint] = await tx
              .select({
                requestId: schema.browser_replay_checkpoints.request_id,
                ownerId: schema.browser_replay_checkpoints.owner_id,
                envelopeVersion:
                  schema.browser_replay_checkpoints.envelope_version,
                statePath: schema.browser_replay_checkpoints.state_path,
                finalUrl: schema.browser_replay_checkpoints.final_url,
                fingerprint: schema.browser_replay_checkpoints.fingerprint,
                checksum: schema.browser_replay_checkpoints.checksum,
                byteSize: schema.browser_replay_checkpoints.byte_size,
                fileDeletedAt:
                  schema.browser_replay_checkpoints.file_deleted_at,
                envelope: schema.browser_replay_envelopes.envelope,
                envelopeRequestId: schema.browser_replay_envelopes.request_id,
                envelopeOwnerId: schema.browser_replay_envelopes.owner_id,
                envelopeVersionValue: schema.browser_replay_envelopes.version,
                navigationPolicyVersion:
                  schema.browser_replay_envelopes.navigation_policy_version,
              })
              .from(schema.browser_replay_checkpoints)
              .innerJoin(
                schema.browser_replay_envelopes,
                eq(
                  schema.browser_replay_envelopes.scrape_id,
                  schema.browser_replay_checkpoints.scrape_id,
                ),
              )
              .where(
                eq(schema.browser_replay_checkpoints.scrape_id, input.scrapeId),
              )
              .limit(1);
            if (
              existingCheckpoint &&
              existingCheckpoint.requestId === input.requestId &&
              existingCheckpoint.ownerId === input.ownerId &&
              existingCheckpoint.envelopeVersion === 1 &&
              existingCheckpoint.envelopeRequestId === input.requestId &&
              existingCheckpoint.envelopeOwnerId === input.ownerId &&
              existingCheckpoint.envelopeVersionValue === 1 &&
              existingCheckpoint.navigationPolicyVersion === 1 &&
              existingCheckpoint.fileDeletedAt === null &&
              existingCheckpoint.statePath !== null &&
              existingCheckpoint.finalUrl ===
                input.replayCheckpoint!.finalUrl &&
              isDeepStrictEqual(
                existingCheckpoint.fingerprint,
                input.replayCheckpoint!.fingerprint,
              ) &&
              existingCheckpoint.checksum === canonicalCheckpoint.checksum &&
              existingCheckpoint.byteSize === canonicalCheckpoint.byteSize &&
              isDeepStrictEqual(
                existingCheckpoint.envelope,
                normalized.envelope,
              )
            ) {
              try {
                const existingStorageState = await filesystem.readCheckpoint(
                  existingCheckpoint.statePath,
                  canonicalCheckpoint.checksum,
                );
                if (
                  isDeepStrictEqual(
                    existingStorageState,
                    input.replayCheckpoint!.storageState,
                  )
                ) {
                  throw new ReplayCheckpointAlreadyPersisted();
                }
              } catch (error) {
                if (error instanceof ReplayCheckpointAlreadyPersisted) {
                  throw error;
                }
                // Missing or corrupt files are repaired by the normal write.
              }
            }
            const [ownedScrape] = await tx
              .select({ id: schema.scrapes.id })
              .from(schema.scrapes)
              .innerJoin(
                schema.requests,
                eq(schema.requests.id, schema.scrapes.request_id),
              )
              .where(
                and(
                  eq(schema.scrapes.id, input.scrapeId),
                  eq(schema.scrapes.request_id, input.requestId),
                  eq(schema.scrapes.team_id, input.ownerId),
                  eq(schema.requests.id, input.requestId),
                  eq(schema.requests.team_id, input.ownerId),
                ),
              )
              .limit(1);
            if (!ownedScrape) throw new ReplayOwnershipError();
            await tx
              .insert(schema.browser_replay_checkpoint_cleanup_intents)
              .values({
                id: cleanupIntentId,
                scrape_id: input.scrapeId,
                owner_id: input.ownerId,
                state_path: plan.pathId,
                checksum: plan.checksum,
                state: "preparing",
                writer_lease: plan.writerLease,
                writer_pid: plan.writerPid,
                writer_boot_id: plan.writerBootId,
                writer_start_time: plan.writerStartTime,
                heartbeat_at: new Date().toISOString(),
              });
          });
          prepared = {
            cleanupIntentId,
            writerLease: plan.writerLease,
            ownerId: input.ownerId,
            statePath: plan.pathId,
            checksum: plan.checksum,
            validated,
          };
        },
      },
      () =>
        filesystem.writeCheckpoint(
          input.ownerId,
          input.scrapeId,
          input.replayCheckpoint!.storageState,
        ),
    );
  } catch (error) {
    if (error instanceof ReplayCheckpointAlreadyPersisted) {
      return { persisted: true };
    }
    if (error instanceof ReplayCheckpointValidationError) {
      return { persisted: false, reason: "checkpoint_unavailable" };
    }
    if (!prepared) throw error;
    return recoverWithoutMaskingPrimary(
      filesystem,
      input.scrapeId,
      prepared,
      error,
    );
  }
  const { cleanupIntentId, writerLease, validated } =
    requirePreparedCheckpoint(prepared);

  try {
    await db.transaction(async tx => {
      await lockScrape(tx, input.scrapeId);
      await recoverCleanupIntents(
        tx,
        filesystem,
        input.scrapeId,
        cleanupIntentId,
      );
      const [ownedScrape] = await tx
        .select({ drCleanBy: schema.requests.dr_clean_by })
        .from(schema.scrapes)
        .innerJoin(
          schema.requests,
          eq(schema.requests.id, schema.scrapes.request_id),
        )
        .where(
          and(
            eq(schema.scrapes.id, input.scrapeId),
            eq(schema.scrapes.request_id, input.requestId),
            eq(schema.scrapes.team_id, input.ownerId),
            eq(schema.requests.id, input.requestId),
            eq(schema.requests.team_id, input.ownerId),
          ),
        )
        .limit(1);
      if (!ownedScrape) throw new ReplayOwnershipError();
      const [preparingIntent] = await tx
        .select({ id: schema.browser_replay_checkpoint_cleanup_intents.id })
        .from(schema.browser_replay_checkpoint_cleanup_intents)
        .where(
          and(
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.id,
              cleanupIntentId,
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.scrape_id,
              input.scrapeId,
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.owner_id,
              input.ownerId,
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.state_path,
              written.pathId,
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.checksum,
              written.checksum,
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.state,
              "preparing",
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.writer_lease,
              writerLease,
            ),
          ),
        )
        .limit(1);
      if (!preparingIntent) throw new ReplayCheckpointPreparationError();
      const [existing] = await tx
        .select({
          statePath: schema.browser_replay_checkpoints.state_path,
          checksum: schema.browser_replay_checkpoints.checksum,
        })
        .from(schema.browser_replay_checkpoints)
        .where(eq(schema.browser_replay_checkpoints.scrape_id, input.scrapeId))
        .limit(1);
      if (
        existing?.statePath &&
        (existing.statePath !== written.pathId ||
          existing.checksum !== written.checksum)
      ) {
        await tx
          .insert(schema.browser_replay_checkpoint_cleanup_intents)
          .values({
            id: randomUUID(),
            scrape_id: input.scrapeId,
            owner_id: input.ownerId,
            state_path: existing.statePath,
            checksum: existing.checksum,
            state: "cleanup",
          })
          .onConflictDoNothing();
      }

      const expiresAt =
        ownedScrape.drCleanBy ??
        new Date(Date.now() + runtime.retentionDays * 86_400_000).toISOString();
      const now = new Date().toISOString();
      await tx
        .insert(schema.browser_replay_envelopes)
        .values({
          scrape_id: input.scrapeId,
          request_id: input.requestId,
          owner_id: input.ownerId,
          version: 1,
          navigation_policy_version: 1,
          envelope: validated.envelope,
        })
        .onConflictDoUpdate({
          target: schema.browser_replay_envelopes.scrape_id,
          set: {
            request_id: input.requestId,
            owner_id: input.ownerId,
            version: 1,
            navigation_policy_version: 1,
            envelope: validated.envelope,
            updated_at: now,
          },
        });
      await tx
        .insert(schema.browser_replay_checkpoints)
        .values({
          id: randomUUID(),
          scrape_id: input.scrapeId,
          request_id: input.requestId,
          owner_id: input.ownerId,
          envelope_version: 1,
          state_path: written.pathId,
          final_url: validated.checkpoint.finalUrl,
          fingerprint: validated.checkpoint.fingerprint,
          checksum: written.checksum,
          byte_size: written.byteSize,
          expires_at: expiresAt,
        })
        .onConflictDoUpdate({
          target: schema.browser_replay_checkpoints.scrape_id,
          set: {
            request_id: input.requestId,
            owner_id: input.ownerId,
            envelope_version: 1,
            state_path: written.pathId,
            final_url: validated.checkpoint.finalUrl,
            fingerprint: validated.checkpoint.fingerprint,
            checksum: written.checksum,
            byte_size: written.byteSize,
            expires_at: expiresAt,
            file_deleted_at: null,
          },
        });
      await tx
        .delete(schema.browser_replay_checkpoint_cleanup_intents)
        .where(
          and(
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.id,
              cleanupIntentId,
            ),
            eq(
              schema.browser_replay_checkpoint_cleanup_intents.writer_lease,
              writerLease,
            ),
          ),
        );
    });
  } catch (error) {
    return recoverWithoutMaskingPrimary(
      filesystem,
      input.scrapeId,
      requirePreparedCheckpoint(prepared),
      error,
    );
  }

  try {
    await recoverScrapeCleanup(filesystem, input.scrapeId);
  } catch {
    cleanupLogger.error("Replay checkpoint cleanup recovery failed", {
      category: "replay_checkpoint_cleanup_recovery_failed",
      scrapeId: input.scrapeId,
    });
  }

  return { persisted: true };
}

/** @public */
export function registerReplayPersistenceAuthorityRoute(
  app: Application,
  deps: {
    apiKey: string | undefined;
    getGate: () => BrowserStartupGate | undefined;
  },
): void {
  registerReplayIngestTransportRoute(app, {
    ...deps,
    persist: persistScrapeReplayStateUnderAuthority,
  });
}

/** @internal Direct persistence is available only to the test runtime. */
export function createReplayPersistenceForTesting(): (
  input: PersistScrapeReplayStateInput,
) => Promise<ReplayPersistenceResult> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Direct replay persistence is unavailable");
  }
  return persistScrapeReplayStateUnderAuthority;
}

/** @public */
export async function loadScrapeReplayState(
  ownerId: string,
  scrapeId: string,
): Promise<ReplayResolution> {
  const runtime = runtimeConfig();
  if (!runtime.enabled) return unavailable(["browserService"]);

  const loaded = await db.transaction(async tx => {
    await lockScrape(tx, scrapeId);
    const filesystem = new BrowserStateFilesystem(runtime.root);
    await recoverCleanupIntents(tx, filesystem, scrapeId);
    const [row] = await tx
      .select({
        envelope: schema.browser_replay_envelopes.envelope,
        statePath: schema.browser_replay_checkpoints.state_path,
        finalUrl: schema.browser_replay_checkpoints.final_url,
        fingerprint: schema.browser_replay_checkpoints.fingerprint,
        checksum: schema.browser_replay_checkpoints.checksum,
        byteSize: schema.browser_replay_checkpoints.byte_size,
        expiresAt: schema.browser_replay_checkpoints.expires_at,
        fileDeletedAt: schema.browser_replay_checkpoints.file_deleted_at,
        scrapeUrl: schema.scrapes.url,
        scrapeOptions: schema.scrapes.options,
      })
      .from(schema.browser_replay_envelopes)
      .innerJoin(
        schema.browser_replay_checkpoints,
        eq(
          schema.browser_replay_checkpoints.scrape_id,
          schema.browser_replay_envelopes.scrape_id,
        ),
      )
      .innerJoin(
        schema.scrapes,
        eq(schema.scrapes.id, schema.browser_replay_envelopes.scrape_id),
      )
      .innerJoin(
        schema.requests,
        eq(schema.requests.id, schema.scrapes.request_id),
      )
      .where(
        and(
          eq(schema.browser_replay_envelopes.owner_id, ownerId),
          eq(schema.browser_replay_envelopes.scrape_id, scrapeId),
          eq(schema.browser_replay_checkpoints.owner_id, ownerId),
          eq(
            schema.browser_replay_checkpoints.request_id,
            schema.browser_replay_envelopes.request_id,
          ),
          eq(schema.browser_replay_checkpoints.scrape_id, schema.scrapes.id),
          eq(
            schema.browser_replay_envelopes.request_id,
            schema.scrapes.request_id,
          ),
          eq(schema.scrapes.team_id, ownerId),
          eq(schema.requests.id, schema.scrapes.request_id),
          eq(schema.requests.team_id, ownerId),
        ),
      )
      .limit(1);
    if (
      !row ||
      !row.statePath ||
      row.fileDeletedAt !== null ||
      typeof row.scrapeUrl !== "string" ||
      isRedactedPersistedValue(row.scrapeUrl) ||
      isRedactedPersistedValue(row.scrapeOptions) ||
      row.scrapeOptions === null ||
      typeof row.scrapeOptions !== "object" ||
      Array.isArray(row.scrapeOptions) ||
      Date.parse(row.expiresAt) <= Date.now()
    ) {
      return;
    }
    const statePath = row.statePath;
    try {
      const storageState = await filesystem.readCheckpoint(
        statePath,
        row.checksum,
      );
      return { row: { ...row, statePath }, storageState };
    } catch {
      return;
    }
  });
  if (!loaded) {
    return unavailable(["checkpoint"]);
  }
  const { row, storageState } = loaded;

  if (
    row.envelope === null ||
    typeof row.envelope !== "object" ||
    Array.isArray(row.envelope)
  ) {
    return unavailable(["envelope"]);
  }
  const envelope = row.envelope as Record<string, unknown>;
  const storedProfile =
    envelope.profile !== null &&
    typeof envelope.profile === "object" &&
    !Array.isArray(envelope.profile)
      ? (envelope.profile as Record<string, unknown>)
      : undefined;
  const checkpoint: StoredReplayCheckpoint = {
    version: 1,
    statePath: row.statePath,
    storageState: storageState as StoredReplayCheckpoint["storageState"],
    finalUrl: row.finalUrl,
    fingerprint: row.fingerprint as StoredReplayCheckpoint["fingerprint"],
    checksum: row.checksum,
    byteSize: row.byteSize,
  };
  return resolveReplayEnvelope({
    url: envelope.canonicalTargetUrl,
    options: {
      waitFor: envelope.waitForMs,
      actions:
        envelope.actions instanceof Array
          ? envelope.actions.map(item =>
              item && typeof item === "object" && "action" in item
                ? item.action
                : item,
            )
          : [],
      ...(storedProfile
        ? {
            profile: {
              name: storedProfile.name,
              saveChanges: storedProfile.saveChanges,
            },
          }
        : {}),
    },
    callerOrigin: envelope.callerOrigin,
    browserSettings: envelope.browserSettings,
    profileGenerationId: storedProfile?.generationId,
    checkpoint,
  });
}

/** @public */
export async function loadReplayCheckpointForBrowserService(
  ownerId: string,
  scrapeId: string,
  gate: BrowserStartupGate,
): Promise<StoredReplayCheckpoint> {
  return gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    async lease => {
      const resolution = await loadScrapeReplayState(ownerId, scrapeId);
      const after = gate.assertOpen();
      if (
        lease.binding.databaseControlEpoch !== after.databaseControlEpoch ||
        lease.binding.processNonce !== after.processNonce ||
        lease.binding.controlGenerationNonce !== after.controlGenerationNonce ||
        resolution.kind !== "checkpoint"
      ) {
        throw new ReplayUnavailableError();
      }
      return resolution.checkpoint;
    },
  );
}
