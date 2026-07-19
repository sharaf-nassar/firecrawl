import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted; anything its factories reference must be created in
// vi.hoisted() (also hoisted). Under Jest these worked because importing `jest`
// from @jest/globals disables jest.mock hoisting.
const {
  artifactStoreConfigured,
  captureException,
  changeTrackingInsertScrape,
  logger,
  saveScrapeToGCS,
  onConflictDoUpdate,
  values,
  insert,
} = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  const onConflictDoUpdate = vi.fn<(options: any) => Promise<void>>();
  const values = vi.fn<
    (data: any) => { onConflictDoUpdate: typeof onConflictDoUpdate }
  >(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return {
    artifactStoreConfigured: { value: false },
    captureException: vi.fn(),
    changeTrackingInsertScrape: vi.fn(),
    logger,
    saveScrapeToGCS: vi.fn(),
    onConflictDoUpdate,
    values,
    insert,
  };
});

vi.mock("@sentry/node", () => ({
  captureException,
}));

vi.mock("../../config", () => ({
  config: {
    GCS_BUCKET_NAME: undefined,
    USE_DB_AUTHENTICATION: true,
    LOCAL_PERSISTENCE_ENABLED: false,
    APPLICATION_DATABASE_URL: undefined,
    LOCAL_OWNER_ID: undefined,
    LOCAL_RECORD_RETENTION_DAYS: 30,
    LOCAL_ARTIFACT_RETENTION_DAYS: 30,
    ARTIFACT_STORE_PROVIDER: "none",
  },
}));

vi.mock("../../lib/logger", () => ({
  logger,
}));

vi.mock("../../db/connection", () => ({
  db: { insert },
}));

vi.mock("../../db/rpc", () => ({
  changeTrackingInsertScrape,
}));

vi.mock("../../lib/keyless", () => ({
  keylessTeamUuid: (teamId: string) =>
    teamId === "preview_keyless_127.0.0.1"
      ? "e50fa284-91f8-5d60-b54a-e0a119a66a06"
      : null,
}));

vi.mock("../../lib/gcs-jobs", () => ({
  saveDeepResearchToGCS: vi.fn(),
  saveExtractToGCS: vi.fn(),
  saveLlmsTxtToGCS: vi.fn(),
  saveMapToGCS: vi.fn(),
  saveScrapeToGCS,
  saveSearchToGCS: vi.fn(),
}));

vi.mock("../../lib/artifacts", () => ({
  isArtifactStoreConfigured: () => artifactStoreConfigured.value,
}));

vi.mock("../../lib/extract/extract-redis", () => ({
  saveExtractResult: vi.fn(),
}));

vi.mock("../posthog", () => ({
  trackFirstSurfaceUse: vi.fn(),
}));

import {
  logBatchScrape,
  logCrawl,
  logDeepResearch,
  logExtract,
  logLlmsTxt,
  logMap,
  logRequest,
  logResearchEndpoint,
  logScrape,
  logSearch,
  type LoggedSearch,
} from "./log_job";
import { config } from "../../config";
import * as schema from "../../db/schema";
import { keylessTeamUuid } from "../../lib/keyless";

const localOwnerId = "7c70fd9c-4b7f-4d5f-87a6-91af0588623c";
const applicationDatabaseUrl =
  "postgresql://firecrawl:password@localhost:5432/firecrawl";
const previewTeamId = "3adefd26-77ec-5968-8dcf-c94b5630d1de";

function makeSearch(overrides: Partial<LoggedSearch> = {}): LoggedSearch {
  return {
    id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    request_id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
    query: "hello",
    team_id: "team-id",
    options: {
      query: "hello",
      sources: [{ type: "web", location: "Boston" }],
    },
    time_taken: 100,
    credits_cost: 1,
    is_successful: true,
    num_results: 0,
    results: null,
    zeroDataRetention: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  values.mockReturnValue({ onConflictDoUpdate });
  onConflictDoUpdate.mockResolvedValue(undefined);
  config.USE_DB_AUTHENTICATION = true;
  config.LOCAL_PERSISTENCE_ENABLED = false;
  config.APPLICATION_DATABASE_URL = undefined;
  config.LOCAL_OWNER_ID = undefined;
  config.LOCAL_RECORD_RETENTION_DAYS = 30;
  config.LOCAL_ARTIFACT_RETENTION_DAYS = 30;
  config.ARTIFACT_STORE_PROVIDER = "none";
  artifactStoreConfigured.value = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("application persistence", () => {
  const requestId = "019e6f45-7778-727d-adf0-0abe9d5062b6";
  const scrapeId = "019e6f45-7778-727d-adf0-0abe9d5062b7";
  const keylessTeam = "preview_keyless_127.0.0.1";

  function enableLocalPersistence() {
    config.USE_DB_AUTHENTICATION = false;
    config.LOCAL_PERSISTENCE_ENABLED = true;
    config.APPLICATION_DATABASE_URL = applicationDatabaseUrl;
    config.LOCAL_OWNER_ID = localOwnerId;
  }

  it("sets configured expiry for local requests and caps ZDR at 24 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    enableLocalPersistence();
    config.LOCAL_RECORD_RETENTION_DAYS = 7;

    await logRequest({
      id: requestId,
      kind: "scrape",
      api_version: "v2",
      team_id: localOwnerId,
      target_hint: "https://example.com/retained",
      zeroDataRetention: false,
    });
    await logRequest({
      id: scrapeId,
      kind: "scrape",
      api_version: "v2",
      team_id: localOwnerId,
      target_hint: "https://example.com/private",
      zeroDataRetention: true,
    });

    expect(values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        dr_clean_by: new Date("2026-07-25T00:00:00.000Z"),
        target_hint: "https://example.com/retained",
      }),
    );
    expect(values).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        dr_clean_by: new Date("2026-07-19T00:00:00.000Z"),
        target_hint: "<redacted due to zero data retention>",
      }),
    );
  });

  it("atomically replaces local async request placeholders", async () => {
    enableLocalPersistence();

    await logRequest({
      id: requestId,
      kind: "scrape",
      api_version: "v2",
      team_id: localOwnerId,
      target_hint: "https://example.com/real-request",
      zeroDataRetention: false,
    });

    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    const conflictUpdate = onConflictDoUpdate.mock.calls[0]![0];
    expect(conflictUpdate.setWhere).toEqual(
      eq(schema.requests.kind, "async_placeholder"),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: schema.requests.id,
        setWhere: expect.anything(),
        set: expect.objectContaining({
          kind: "scrape",
          api_version: "v2",
          target_hint: "https://example.com/real-request",
        }),
      }),
    );
  });

  it("keeps hosted request inserts on their existing conflict behavior", async () => {
    await logRequest({
      id: requestId,
      kind: "scrape",
      api_version: "v2",
      team_id: "hosted-team",
      target_hint: "https://example.com/hosted",
      zeroDataRetention: false,
    });

    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("keeps synchronous ZDR data redacted and out of artifact storage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    enableLocalPersistence();
    artifactStoreConfigured.value = true;

    await logRequest({
      id: requestId,
      kind: "scrape",
      api_version: "v2",
      team_id: localOwnerId,
      target_hint: "https://private.example/secret",
      zeroDataRetention: true,
    });
    await logScrape({
      id: scrapeId,
      request_id: requestId,
      url: "https://private.example/secret",
      is_successful: true,
      doc: { markdown: "private content" } as any,
      time_taken: 10,
      team_id: localOwnerId,
      options: { formats: [{ type: "markdown" }] } as any,
      cost_tracking: { private: true } as any,
      credits_cost: 1,
      skipNuq: true,
      zeroDataRetention: true,
    });

    expect(values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target_hint: "<redacted due to zero data retention>",
        dr_clean_by: new Date("2026-07-19T00:00:00.000Z"),
      }),
    );
    expect(values).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "<redacted due to zero data retention>",
        options: null,
        cost_tracking: null,
      }),
    );
    expect(saveScrapeToGCS).not.toHaveBeenCalled();
  });

  const localLogCases: Array<{
    name: string;
    table: unknown;
    run: (teamId: string) => Promise<void>;
  }> = [
    {
      name: "request",
      table: schema.requests,
      run: teamId =>
        logRequest({
          id: requestId,
          kind: "scrape",
          api_version: "v2",
          team_id: teamId,
          target_hint: "http://localhost:3000",
          zeroDataRetention: false,
        }),
    },
    {
      name: "scrape",
      table: schema.scrapes,
      run: teamId =>
        logScrape({
          id: scrapeId,
          request_id: requestId,
          url: "http://localhost:3000",
          is_successful: true,
          time_taken: 10,
          team_id: teamId,
          options: { formats: [{ type: "html" }] } as any,
          credits_cost: 1,
          skipNuq: false,
          zeroDataRetention: false,
        }),
    },
    {
      name: "parse",
      table: schema.parses,
      run: teamId =>
        logScrape({
          id: scrapeId,
          request_id: requestId,
          url: "http://localhost:3000/document.pdf",
          is_successful: true,
          time_taken: 10,
          team_id: teamId,
          options: { formats: [{ type: "markdown" }] } as any,
          credits_cost: 1,
          skipNuq: false,
          zeroDataRetention: false,
          is_parse: true,
        }),
    },
    {
      name: "crawl",
      table: schema.crawls,
      run: teamId =>
        logCrawl({
          id: scrapeId,
          request_id: requestId,
          url: "http://localhost:3000",
          team_id: teamId,
          options: {},
          num_docs: 1,
          credits_cost: 1,
          zeroDataRetention: false,
          cancelled: false,
        }),
    },
    {
      name: "batch scrape",
      table: schema.batch_scrapes,
      run: teamId =>
        logBatchScrape({
          id: scrapeId,
          request_id: requestId,
          team_id: teamId,
          num_docs: 1,
          credits_cost: 1,
          zeroDataRetention: false,
          cancelled: false,
        }),
    },
    {
      name: "search",
      table: schema.searches,
      run: teamId => logSearch(makeSearch({ team_id: teamId })),
    },
    {
      name: "research endpoint",
      table: schema.research_paper_searches,
      run: teamId =>
        logResearchEndpoint({
          table: "research_paper_searches",
          id: scrapeId,
          request_id: requestId,
          target: "firecrawl",
          team_id: teamId,
          options: {},
          response: [],
          num_results: 0,
          time_taken: 10,
          credits_cost: 1,
          is_successful: true,
          zeroDataRetention: false,
        }),
    },
    {
      name: "extract",
      table: schema.extracts,
      run: teamId =>
        logExtract({
          id: scrapeId,
          request_id: requestId,
          urls: ["http://localhost:3000"],
          team_id: teamId,
          options: {},
          model_kind: "fire-1",
          credits_cost: 1,
          is_successful: true,
        }),
    },
    {
      name: "map",
      table: schema.maps,
      run: teamId =>
        logMap({
          id: scrapeId,
          request_id: requestId,
          url: "http://localhost:3000",
          team_id: teamId,
          options: {},
          results: [],
          credits_cost: 1,
          zeroDataRetention: false,
        }),
    },
    {
      name: "llms.txt",
      table: schema.llmstxts,
      run: teamId =>
        logLlmsTxt({
          id: scrapeId,
          request_id: requestId,
          url: "http://localhost:3000",
          team_id: teamId,
          options: {},
          num_urls: 1,
          credits_cost: 1,
          result: null as any,
        }),
    },
    {
      name: "deep research",
      table: schema.deep_researches,
      run: teamId =>
        logDeepResearch({
          id: scrapeId,
          request_id: requestId,
          query: "firecrawl",
          team_id: teamId,
          options: {},
          time_taken: 10,
          credits_cost: 1,
          result: null as any,
        }),
    },
  ];

  it.each(localLogCases)(
    "persists $name under the stable local owner",
    async ({ table, run }) => {
      enableLocalPersistence();

      await run(keylessTeam);

      expect(insert).toHaveBeenCalledWith(table);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: localOwnerId }),
      );
    },
  );

  it.each(["bypass", keylessTeam, keylessTeamUuid(keylessTeam)!])(
    "never persists local operational rows under %s",
    async teamId => {
      enableLocalPersistence();

      await logScrape({
        id: scrapeId,
        request_id: requestId,
        url: "http://localhost:3000",
        is_successful: true,
        time_taken: 10,
        team_id: teamId,
        options: {} as any,
        credits_cost: 1,
        skipNuq: false,
        zeroDataRetention: false,
      });

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: localOwnerId }),
      );
    },
  );

  it("still skips inserts when authentication and local persistence are off", async () => {
    config.USE_DB_AUTHENTICATION = false;

    await logSearch(makeSearch());

    expect(insert).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Skipping database insertion because application persistence is disabled",
    );
  });

  it("preserves hosted preview, keyless, and raw team mappings", async () => {
    await logRequest({
      id: requestId,
      kind: "scrape",
      api_version: "v2",
      team_id: "preview_abc",
      target_hint: "https://example.com",
      zeroDataRetention: false,
    });
    await logScrape({
      id: scrapeId,
      request_id: requestId,
      url: "https://example.com",
      is_successful: true,
      time_taken: 10,
      team_id: keylessTeam,
      options: {} as any,
      credits_cost: 1,
      skipNuq: false,
      zeroDataRetention: false,
    });
    await logSearch(makeSearch({ team_id: "hosted-team" }));

    expect(values.mock.calls[0][0].team_id).toBe(previewTeamId);
    expect(values.mock.calls[1][0].team_id).toBe(keylessTeamUuid(keylessTeam));
    expect(values.mock.calls[2][0].team_id).toBe("hosted-team");
  });

  it("keeps hosted change tracking enabled but disables it locally", async () => {
    const scrape = {
      id: scrapeId,
      request_id: requestId,
      url: "https://example.com",
      is_successful: true,
      doc: {} as any,
      time_taken: 10,
      team_id: "hosted-team",
      options: { formats: [{ type: "markdown" as const }] } as any,
      credits_cost: 1,
      skipNuq: false,
      zeroDataRetention: false,
    };

    await logScrape(scrape);
    expect(changeTrackingInsertScrape).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    values.mockReturnValue({ onConflictDoUpdate });
    onConflictDoUpdate.mockResolvedValue(undefined);
    enableLocalPersistence();
    await logScrape({ ...scrape, team_id: "bypass" });
    expect(changeTrackingInsertScrape).not.toHaveBeenCalled();
  });

  it("captures a non-force insert failure without reporting success", async () => {
    const error = new Error("database unavailable");
    values.mockRejectedValueOnce(error);

    await expect(logSearch(makeSearch())).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to insert into database",
      expect.any(Object),
    );
    expect(logger.debug).not.toHaveBeenCalledWith(
      "Inserted into database successfully",
      expect.any(Object),
    );
  });

  it("rejects a local force insert failure with the original error", async () => {
    enableLocalPersistence();
    vi.useFakeTimers();
    const error = new Error("database unavailable");
    onConflictDoUpdate.mockRejectedValue(error);

    const logging = logRequest({
      id: requestId,
      kind: "scrape",
      api_version: "v2",
      team_id: "bypass",
      target_hint: "https://example.com",
      zeroDataRetention: false,
    });
    await Promise.all([
      vi.runAllTimersAsync(),
      expect(logging).rejects.toBe(error),
    ]);

    expect(values).toHaveBeenCalledTimes(10);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(10);
    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to insert into database",
      expect.any(Object),
    );
    expect(logger.debug).not.toHaveBeenCalledWith(
      "Inserted into database successfully",
      expect.any(Object),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Inserted into database successfully with retries",
      expect.any(Object),
    );
  });

  it("preserves hosted force insert failure handling", async () => {
    vi.useFakeTimers();
    const error = new Error("database unavailable");
    values.mockRejectedValue(error);

    const logging = logRequest({
      id: requestId,
      kind: "scrape",
      api_version: "v2",
      team_id: "hosted-team",
      target_hint: "https://example.com",
      zeroDataRetention: false,
    });
    await Promise.all([
      vi.runAllTimersAsync(),
      expect(logging).resolves.toBeUndefined(),
    ]);

    expect(values).toHaveBeenCalledTimes(10);
    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
  });
});

describe("logSearch", () => {
  it("removes null bytes from search query log fields", async () => {
    const search = makeSearch({
      query: "hello\u0000world",
      options: {
        query: "nested\u0000query",
        sources: [{ type: "web", location: "New\u0000York" }],
      },
    });

    await logSearch(search);

    expect(insert).toHaveBeenCalledWith(schema.searches);
    const inserted = values.mock.calls[0][0];
    expect(inserted.query).toBe("helloworld");
    expect(inserted.options.query).toBe("nestedquery");
    expect(inserted.options.sources[0].location).toBe("New\u0000York");
    expect(search.options.query).toBe("nested\u0000query");
  });

  it("uses sanitized data in Sentry insert failure context", async () => {
    values.mockRejectedValueOnce(
      Object.assign(new Error("unsupported Unicode escape sequence"), {
        code: "22P05",
      }),
    );

    await logSearch(
      makeSearch({
        query: "bad\u0000query",
        options: { query: "bad\u0000query" },
      }),
    );

    expect(captureException).toHaveBeenCalled();
    const context = captureException.mock.calls[0][1] as {
      extra: { data: string };
    };
    expect(context.extra.data).not.toContain("\\u0000");
    expect(context.extra.data).toContain("badquery");
  });
});
