import { config } from "../config";
import {
  resolveLocalRuntimeConfig,
  type LocalRuntimeConfigSource,
} from "../lib/local-runtime-config";

type ApplicationDatabaseConfigInput = LocalRuntimeConfigSource & {
  DATABASE_URL?: string;
  DATABASE_REPLICA_URL?: string;
};

type ApplicationDatabaseConfig = {
  enabled: boolean;
  writerUrl?: string;
  readerUrl?: string;
  applicationName: "firecrawl-api" | "firecrawl-api-local";
};

export function resolveApplicationDatabaseConfig(
  input: ApplicationDatabaseConfigInput,
): ApplicationDatabaseConfig {
  if (input.LOCAL_PERSISTENCE_ENABLED === true) {
    const localConfig = resolveLocalRuntimeConfig(input);

    if (!localConfig.enabled) {
      return {
        enabled: false,
        applicationName: "firecrawl-api",
      };
    }

    return {
      enabled: true,
      writerUrl: localConfig.applicationDatabaseUrl,
      readerUrl: localConfig.applicationDatabaseUrl,
      applicationName: "firecrawl-api-local",
    };
  }

  if (input.USE_DB_AUTHENTICATION === true) {
    return {
      enabled: true,
      writerUrl: input.DATABASE_URL,
      readerUrl: input.DATABASE_REPLICA_URL ?? input.DATABASE_URL,
      applicationName: "firecrawl-api",
    };
  }

  return {
    enabled: false,
    applicationName: "firecrawl-api",
  };
}

export function isApplicationPersistenceEnabled(): boolean {
  return (
    config.USE_DB_AUTHENTICATION === true ||
    config.LOCAL_PERSISTENCE_ENABLED === true
  );
}
