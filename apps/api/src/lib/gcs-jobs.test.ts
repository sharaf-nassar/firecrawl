import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { config, logger, putLocalArtifactWithManifest, store } = vi.hoisted(
  () => {
    const logger: any = {
      child: vi.fn(() => logger),
      debug: vi.fn(),
      error: vi.fn(),
    };
    return {
      config: {
        GCS_CREDENTIALS: undefined,
        LOCAL_PERSISTENCE_ENABLED: true,
        LOCAL_ARTIFACT_RETENTION_DAYS: 7,
      },
      logger,
      putLocalArtifactWithManifest: vi.fn(),
      store: {
        provider: "minio" as const,
        put: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        health: vi.fn(),
      },
    };
  },
);

vi.mock("@google-cloud/storage", () => ({
  ApiError: class ApiError extends Error {},
  Storage: class Storage {},
}));

vi.mock("../config", () => ({ config }));

vi.mock("./logger", () => ({ logger }));

vi.mock("./otel-tracer", () => ({
  setSpanAttributes: vi.fn(),
  withSpan: async (_name: string, callback: (span: object) => unknown) =>
    callback({}),
}));

vi.mock("./artifacts", () => ({
  getArtifactStore: () => store,
  jobArtifactKey: (id: string) => `${id}.json`,
}));

vi.mock("./artifacts/local-manifest", () => ({
  putLocalArtifactWithManifest,
}));

vi.mock("./local-owner", () => ({
  resolveJobPersistenceOwner: () => "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
}));

import { saveScrapeToGCS } from "./gcs-jobs";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
  config.LOCAL_PERSISTENCE_ENABLED = true;
  config.LOCAL_ARTIFACT_RETENTION_DAYS = 7;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("local job artifact retention", () => {
  it("writes a scrape manifest using LOCAL_ARTIFACT_RETENTION_DAYS", async () => {
    await saveScrapeToGCS(
      {
        id: "019e6f45-7778-727d-adf0-0abe9d5062b7",
        request_id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
        url: "https://example.com",
        is_successful: true,
        doc: { markdown: "retained" } as any,
        time_taken: 10,
        team_id: "hosted-team",
        options: { formats: [{ type: "markdown" }] } as any,
        credits_cost: 1,
        skipNuq: false,
        zeroDataRetention: false,
      },
      logger,
    );

    expect(putLocalArtifactWithManifest).toHaveBeenCalledWith(
      store,
      expect.objectContaining({
        requestId: "019e6f45-7778-727d-adf0-0abe9d5062b6",
        jobId: "019e6f45-7778-727d-adf0-0abe9d5062b7",
        deleteAfter: new Date("2026-07-25T00:00:00.000Z"),
      }),
    );
  });
});
