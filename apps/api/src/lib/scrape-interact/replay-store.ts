import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { config } from "../../config";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { BrowserStateFilesystem } from "../browser-state/filesystem-store";
import {
  normalizeReplayEnvelope,
  resolveReplayEnvelope,
  type ReplayBrowserSettingsV1,
  type ReplayResolution,
  type StoredReplayCheckpoint,
} from "./replay-envelope";

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

interface PersistScrapeReplayStateInput {
  requestId: string;
  scrapeId: string;
  ownerId: string;
  url: unknown;
  options: unknown;
  callerOrigin: unknown;
  zeroDataRetention: boolean;
  replayCheckpoint?: ReplayCheckpointCaptureV1;
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

/** @public */
export async function persistScrapeReplayState(
  input: PersistScrapeReplayStateInput,
): Promise<{
  persisted: boolean;
  reason?: "disabled" | "zdr" | "checkpoint_unavailable";
}> {
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

  const filesystem = new BrowserStateFilesystem(runtime.root);
  const written = await filesystem.writeCheckpoint(
    input.ownerId,
    input.scrapeId,
    input.replayCheckpoint.storageState,
  );
  const checkpoint: StoredReplayCheckpoint = {
    version: 1,
    statePath: written.pathId,
    storageState: input.replayCheckpoint.storageState,
    finalUrl: input.replayCheckpoint.finalUrl,
    fingerprint: input.replayCheckpoint.fingerprint,
    checksum: written.checksum,
    byteSize: written.byteSize,
  };
  const validated = resolveReplayEnvelope({
    url: input.url,
    options: input.options,
    callerOrigin: input.callerOrigin,
    browserSettings: input.replayCheckpoint.browserSettings,
    checkpoint,
  });
  if (validated.kind !== "checkpoint") {
    await filesystem.delete(written.pathId);
    return { persisted: false, reason: "checkpoint_unavailable" };
  }

  try {
    await db.transaction(async tx => {
      const [request] = await tx
        .select({ drCleanBy: schema.requests.dr_clean_by })
        .from(schema.requests)
        .where(
          and(
            eq(schema.requests.id, input.requestId),
            eq(schema.requests.team_id, input.ownerId),
          ),
        )
        .limit(1);
      if (!request) throw new Error("Replay request row is unavailable");

      const expiresAt =
        request.drCleanBy ??
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
    });
  } catch (error) {
    await filesystem.delete(written.pathId);
    throw error;
  }

  return { persisted: true };
}

/** @public */
export async function loadScrapeReplayState(
  ownerId: string,
  scrapeId: string,
): Promise<ReplayResolution> {
  const runtime = runtimeConfig();
  if (!runtime.enabled) return unavailable(["browserService"]);

  const [row] = await db
    .select({
      envelope: schema.browser_replay_envelopes.envelope,
      statePath: schema.browser_replay_checkpoints.state_path,
      finalUrl: schema.browser_replay_checkpoints.final_url,
      fingerprint: schema.browser_replay_checkpoints.fingerprint,
      checksum: schema.browser_replay_checkpoints.checksum,
      byteSize: schema.browser_replay_checkpoints.byte_size,
      expiresAt: schema.browser_replay_checkpoints.expires_at,
      fileDeletedAt: schema.browser_replay_checkpoints.file_deleted_at,
    })
    .from(schema.browser_replay_envelopes)
    .innerJoin(
      schema.browser_replay_checkpoints,
      eq(
        schema.browser_replay_checkpoints.scrape_id,
        schema.browser_replay_envelopes.scrape_id,
      ),
    )
    .where(
      and(
        eq(schema.browser_replay_envelopes.owner_id, ownerId),
        eq(schema.browser_replay_envelopes.scrape_id, scrapeId),
      ),
    )
    .limit(1);
  if (
    !row ||
    !row.statePath ||
    row.fileDeletedAt !== null ||
    Date.parse(row.expiresAt) <= Date.now()
  ) {
    return unavailable(["checkpoint"]);
  }

  let storageState: unknown;
  try {
    storageState = await new BrowserStateFilesystem(
      runtime.root,
    ).readCheckpoint(row.statePath, row.checksum);
  } catch {
    return unavailable(["checkpoint"]);
  }

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
