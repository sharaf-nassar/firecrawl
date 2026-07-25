import type { ArtifactStore, PutArtifactInput } from "./types";
import { logger } from "../logger";

export interface ArtifactManifestRecord {
  objectKey: string;
  ownerId: string;
  requestId: string | null;
  jobId: string | null;
  kind: string;
  contentType: string;
  byteSize: number;
  checksum: string | null;
  deleteAfter: Date | null;
}

export type ManifestArtifactInput = PutArtifactInput & {
  ownerId: string;
  requestId: string | null;
  jobId: string | null;
  kind: string;
  checksum?: string | null;
  deleteAfter: Date | null;
};

interface ArtifactManifestSession {
  existed: boolean;
  persist(record: ArtifactManifestRecord): Promise<void>;
}

type CoordinateArtifactManifest = <T>(
  objectKey: string,
  work: (session: ArtifactManifestSession) => Promise<T>,
) => Promise<T>;

export async function putArtifactWithManifest(
  store: ArtifactStore,
  input: ManifestArtifactInput,
  coordinate: CoordinateArtifactManifest,
): Promise<void> {
  await coordinate(input.key, async session => {
    const stored = await store.put(input);
    try {
      await session.persist({
        objectKey: stored.key,
        ownerId: input.ownerId,
        requestId: input.requestId,
        jobId: input.jobId,
        kind: input.kind,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        checksum: input.checksum ?? null,
        deleteAfter: input.deleteAfter,
      });
    } catch (error) {
      if (!session.existed) {
        try {
          await store.delete(stored.key);
        } catch (cleanupError) {
          logger.error("Artifact rollback delete failed", {
            provider: store.provider,
            objectKey: stored.key,
            cleanupErrorName:
              cleanupError instanceof Error
                ? cleanupError.name
                : "UnknownError",
          });
          // Preserve the manifest failure: it is the durable consistency boundary.
        }
      }
      throw error;
    }
  });
}
