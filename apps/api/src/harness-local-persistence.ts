export const localPersistenceExternalSettings = [
  "GCS_BUCKET_NAME",
  "GCS_CREDENTIALS",
  "GCS_FIRE_ENGINE_BUCKET_NAME",
  "GCS_INDEX_BUCKET_NAME",
  "GCS_MEDIA_BUCKET_NAME",
  "ARTIFACT_MINIO_ENDPOINT",
  "ARTIFACT_MINIO_ACCESS_KEY",
  "ARTIFACT_MINIO_SECRET_KEY",
  "ARTIFACT_MINIO_BUCKET",
  "ARTIFACT_MINIO_REGION",
  "BROWSER_SERVICE_URL",
] as const;

type LocalPersistenceExternalSetting =
  (typeof localPersistenceExternalSettings)[number];

export function clearLocalPersistenceExternalSettings(
  env: NodeJS.ProcessEnv,
  mutableConfig: Partial<Record<LocalPersistenceExternalSetting, unknown>>,
): void {
  for (const setting of localPersistenceExternalSettings) {
    delete env[setting];
    delete mutableConfig[setting];
  }
}
