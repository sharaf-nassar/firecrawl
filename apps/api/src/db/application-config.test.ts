import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveApplicationDatabaseConfig } from "./application-config";

const hostedWriterUrl =
  "postgresql://firecrawl:password@hosted-primary:5432/firecrawl";
const hostedReaderUrl =
  "postgresql://firecrawl:password@hosted-replica:5432/firecrawl";
const localDatabaseUrl =
  "postgresql://firecrawl:password@localhost:5432/firecrawl";
const localOwnerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";

describe("resolveApplicationDatabaseConfig", () => {
  it("selects hosted writer and reader URLs when authentication is enabled", () => {
    expect(
      resolveApplicationDatabaseConfig({
        USE_DB_AUTHENTICATION: true,
        DATABASE_URL: hostedWriterUrl,
        DATABASE_REPLICA_URL: hostedReaderUrl,
      }),
    ).toEqual({
      enabled: true,
      writerUrl: hostedWriterUrl,
      readerUrl: hostedReaderUrl,
      applicationName: "firecrawl-api",
    });
  });

  it("falls back to the hosted writer URL when no replica is configured", () => {
    expect(
      resolveApplicationDatabaseConfig({
        USE_DB_AUTHENTICATION: true,
        DATABASE_URL: hostedWriterUrl,
      }),
    ).toMatchObject({
      writerUrl: hostedWriterUrl,
      readerUrl: hostedWriterUrl,
    });
  });

  it("uses the application database for local persistence", () => {
    expect(
      resolveApplicationDatabaseConfig({
        LOCAL_PERSISTENCE_ENABLED: true,
        APPLICATION_DATABASE_URL: localDatabaseUrl,
        LOCAL_OWNER_ID: localOwnerId,
        ARTIFACT_STORE_PROVIDER: "none",
        USE_DB_AUTHENTICATION: false,
      }),
    ).toEqual({
      enabled: true,
      writerUrl: localDatabaseUrl,
      readerUrl: localDatabaseUrl,
      applicationName: "firecrawl-api-local",
    });
  });

  it("does not enable an application database in legacy auth-off mode", () => {
    expect(
      resolveApplicationDatabaseConfig({ USE_DB_AUTHENTICATION: false }),
    ).toEqual({
      enabled: false,
      applicationName: "firecrawl-api",
    });
  });

  it("names APPLICATION_DATABASE_URL when local persistence is invalid", () => {
    expect(() =>
      resolveApplicationDatabaseConfig({
        LOCAL_PERSISTENCE_ENABLED: true,
        LOCAL_OWNER_ID: localOwnerId,
        ARTIFACT_STORE_PROVIDER: "none",
        USE_DB_AUTHENTICATION: false,
      }),
    ).toThrowError(/APPLICATION_DATABASE_URL/);
  });
});

describe("application database initialization", () => {
  afterEach(() => {
    vi.doUnmock("pg");
    vi.doUnmock("drizzle-orm/node-postgres");
    vi.doUnmock("../config");
    vi.doUnmock("../lib/logger");
    vi.resetModules();
  });

  it("keeps index database selection and pool sizing unchanged", async () => {
    const poolOptions: Array<Record<string, unknown>> = [];

    vi.doMock("pg", () => ({
      Pool: class {
        public readonly options: Record<string, unknown>;
        public readonly waitingCount = 0;
        public readonly totalCount = 0;
        public readonly idleCount = 0;

        constructor(options: Record<string, unknown>) {
          this.options = options;
          poolOptions.push(options);
        }

        on() {
          return this;
        }
      },
    }));
    vi.doMock("drizzle-orm/node-postgres", () => ({
      drizzle: ({ client }: { client: unknown }) => ({ client }),
    }));
    vi.doMock("../config", () => ({
      config: {
        USE_DB_AUTHENTICATION: false,
        LOCAL_PERSISTENCE_ENABLED: true,
        APPLICATION_DATABASE_URL: localDatabaseUrl,
        LOCAL_OWNER_ID: localOwnerId,
        ARTIFACT_STORE_PROVIDER: "none",
        LOCAL_RECORD_RETENTION_DAYS: 30,
        LOCAL_ARTIFACT_RETENTION_DAYS: 30,
        INDEX_DATABASE_URL:
          "postgresql://firecrawl:password@index:5432/firecrawl",
      },
    }));
    vi.doMock("../lib/logger", () => ({
      logger: { error: vi.fn(), warn: vi.fn() },
    }));

    await import("./connection.js");

    expect(
      poolOptions.find(
        options => options.application_name === "firecrawl-index",
      ),
    ).toMatchObject({
      connectionString: "postgresql://firecrawl:password@index:5432/firecrawl",
      application_name: "firecrawl-index",
      max: 6,
      min: 0,
    });
  });

  it("names DATABASE_URL when hosted persistence cannot initialize", async () => {
    const error = vi.fn();

    vi.doMock("pg", () => ({
      Pool: class {
        public readonly options = { max: 20 };
        public readonly waitingCount = 0;
        public readonly totalCount = 0;
        public readonly idleCount = 0;

        on() {
          return this;
        }
      },
    }));
    vi.doMock("drizzle-orm/node-postgres", () => ({
      drizzle: ({ client }: { client: unknown }) => ({ client }),
    }));
    vi.doMock("../config", () => ({
      config: {
        USE_DB_AUTHENTICATION: true,
        LOCAL_PERSISTENCE_ENABLED: false,
      },
    }));
    vi.doMock("../lib/logger", () => ({
      logger: { error, warn: vi.fn() },
    }));

    await import("./connection.js");

    expect(error).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));
  });
});
