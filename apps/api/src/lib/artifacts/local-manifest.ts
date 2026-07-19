import { sql } from "drizzle-orm";
import { db } from "../../db/connection";
import { logger } from "../logger";
import type { ArtifactStore } from "./types";
import {
  putArtifactWithManifest,
  type ArtifactManifestRecord,
  type ManifestArtifactInput,
} from "./manifest";

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
                  delete_after
                ) VALUES (
                  ${record.objectKey},
                  ${record.ownerId}::uuid,
                  ${record.requestId}::uuid,
                  ${record.jobId}::uuid,
                  ${record.kind},
                  ${record.contentType},
                  ${record.byteSize},
                  ${record.deleteAfter}
                )
                ON CONFLICT (object_key) DO UPDATE SET
                  owner_id = EXCLUDED.owner_id,
                  request_id = EXCLUDED.request_id,
                  job_id = EXCLUDED.job_id,
                  kind = EXCLUDED.kind,
                  content_type = EXCLUDED.content_type,
                  byte_size = EXCLUDED.byte_size,
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
