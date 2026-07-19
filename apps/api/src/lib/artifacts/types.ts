type ArtifactProvider = "minio" | "gcs";
export type ArtifactOperation =
  | "configure"
  | "put"
  | "get"
  | "delete"
  | "health";

type ArtifactMetadataValue = string | number | boolean | null | undefined;

export interface PutArtifactInput {
  key: string;
  body: Buffer | string;
  contentType: string;
  metadata?: Record<string, ArtifactMetadataValue>;
}

export interface StoredArtifact {
  key: string;
  contentType: string;
  byteSize: number;
  metadata: Record<string, string>;
}

export interface ArtifactStore {
  readonly provider: ArtifactProvider;
  put(input: PutArtifactInput): Promise<StoredArtifact>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  health(): Promise<void>;
}

export class ArtifactStoreError extends Error {
  constructor(
    public readonly provider: ArtifactProvider,
    public readonly operation: ArtifactOperation,
    public readonly errorCode?: string,
  ) {
    super(
      `Artifact store ${provider} ${operation} operation failed${
        errorCode ? ` (${errorCode})` : ""
      }`,
    );
    this.name = "ArtifactStoreError";
  }
}

export function normalizeArtifactMetadata(
  metadata: PutArtifactInput["metadata"],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {})
      .filter((entry): entry is [string, string | number | boolean] =>
        ["string", "number", "boolean"].includes(typeof entry[1]),
      )
      .map(([key, value]) => [key, String(value)]),
  );
}
