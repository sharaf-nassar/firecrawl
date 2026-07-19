import type { ArtifactStore, PutArtifactInput } from "./types";

export interface ArtifactManifestRecord {
  objectKey: string;
  ownerId: string;
  requestId: string | null;
  jobId: string | null;
  kind: string;
  contentType: string;
  byteSize: number;
  deleteAfter: Date | null;
}

type ManifestArtifactInput = PutArtifactInput & {
  ownerId: string;
  requestId: string | null;
  jobId: string | null;
  kind: string;
  deleteAfter: Date | null;
};

export async function putArtifactWithManifest(
  store: ArtifactStore,
  input: ManifestArtifactInput,
  persist: (record: ArtifactManifestRecord) => Promise<void>,
): Promise<void> {
  const stored = await store.put(input);
  try {
    await persist({
      objectKey: stored.key,
      ownerId: input.ownerId,
      requestId: input.requestId,
      jobId: input.jobId,
      kind: input.kind,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      deleteAfter: input.deleteAfter,
    });
  } catch (error) {
    try {
      await store.delete(stored.key);
    } catch {
      // Preserve the manifest failure: it is the durable consistency boundary.
    }
    throw error;
  }
}
