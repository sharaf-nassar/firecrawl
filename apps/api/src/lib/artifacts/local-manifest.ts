import { sql } from "drizzle-orm";
import { db } from "../../db/connection";
import { logger } from "../logger";
import type { BrowserStateMutationLease } from "../browser-runtime/startup-gate";
import type { ArtifactStore } from "./types";
import {
  putArtifactWithManifest,
  type ArtifactManifestRecord,
  type ManifestArtifactInput,
} from "./manifest";

/** @public Browser artifacts persist through the caller's fenced transaction. */
export async function persistBrowserArtifactManifestWithLease(
  lease: BrowserStateMutationLease,
  record: ArtifactManifestRecord,
): Promise<void> {
  if (record.checksum === null) {
    throw new Error("Browser artifact checksum is required");
  }
  const inserted = await lease.transaction.query(
    `INSERT INTO local_artifacts (
       object_key, owner_id, request_id, job_id, kind, content_type,
       byte_size, checksum, delete_after
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (object_key) DO NOTHING
     RETURNING object_key`,
    [
      record.objectKey,
      record.ownerId,
      record.requestId,
      record.jobId,
      record.kind,
      record.contentType,
      record.byteSize,
      record.checksum,
      record.deleteAfter,
    ],
  );
  if (inserted.rows.length !== 1) {
    throw new Error("Browser artifact manifest key already exists");
  }
}

export async function putLocalArtifactWithManifest(
  store: ArtifactStore,
  input: ManifestArtifactInput,
): Promise<void> {
  let callbackFailure: unknown;
  let hasCallbackFailure = false;
  let manifestExisted: boolean | undefined;
  let workCompleted = false;
  try {
    await putArtifactWithManifest(store, input, async (objectKey, work) =>
      db.transaction(async tx => {
        try {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${objectKey}, 0))`,
          );
          const existing = await tx.execute<{ existed: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1
              FROM local_artifacts
              WHERE object_key = ${objectKey}
            ) AS existed
          `);
          manifestExisted = existing.rows[0]?.existed === true;

          const result = await work({
            existed: manifestExisted,
            persist: async (record: ArtifactManifestRecord) => {
              await tx.execute(sql`
                INSERT INTO local_artifacts (
                  object_key,
                  owner_id,
                  request_id,
                  job_id,
                  kind,
                  content_type,
                  byte_size,
                  checksum,
                  delete_after
                ) VALUES (
                  ${record.objectKey},
                  ${record.ownerId}::uuid,
                  ${record.requestId}::uuid,
                  ${record.jobId}::uuid,
                  ${record.kind},
                  ${record.contentType},
                  ${record.byteSize},
                  ${record.checksum},
                  ${record.deleteAfter}
                )
                ON CONFLICT (object_key) DO UPDATE SET
                  owner_id = EXCLUDED.owner_id,
                  request_id = EXCLUDED.request_id,
                  job_id = EXCLUDED.job_id,
                  kind = EXCLUDED.kind,
                  content_type = EXCLUDED.content_type,
                  byte_size = EXCLUDED.byte_size,
                  checksum = EXCLUDED.checksum,
                  delete_after = EXCLUDED.delete_after
              `);
            },
          });
          workCompleted = true;
          return result;
        } catch (error) {
          callbackFailure = error;
          hasCallbackFailure = true;
          throw error;
        }
      }),
    );
  } catch (error) {
    const originalError = hasCallbackFailure ? callbackFailure : error;
    if (workCompleted && manifestExisted === false) {
      try {
        await db.transaction(async tx => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.key}, 0))`,
          );
          const existing = await tx.execute<{ existed: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1
              FROM local_artifacts
              WHERE object_key = ${input.key}
            ) AS existed
          `);
          if (existing.rows[0]?.existed !== true) {
            await store.delete(input.key);
          }
        });
      } catch (cleanupError) {
        logger.error("Local artifact commit recovery failed", {
          provider: store.provider,
          objectKey: input.key,
          cleanupErrorName:
            cleanupError instanceof Error ? cleanupError.name : "UnknownError",
        });
        // Recovery failures are secondary to the original transaction error.
      }
    }
    throw originalError;
  }
}
