import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_SEARCH_WEB_ONLY_MESSAGE } from "../search/capabilities";

const mocks = vi.hoisted(() => ({
  recordEndpointFeedback: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./v2/feedback/record", () => ({
  recordEndpointFeedback: mocks.recordEndpointFeedback,
}));
vi.mock("../lib/logger", () => ({
  logger: {
    warn: mocks.warn,
    child: vi.fn(() => ({ warn: mocks.warn })),
  },
}));

import { config } from "../config";
import { feedbackController } from "./v2/feedback/controller";
import { searchFeedbackController } from "./v2/search-feedback";

const originalLocalSearchWebOnly = config.LOCAL_SEARCH_WEB_ONLY;

function response() {
  const result = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      result.statusCode = code;
      return result;
    },
    json(body: unknown) {
      result.body = body;
      return result;
    },
  };
  return result;
}

function successfulFeedback() {
  return {
    status: 200 as const,
    body: {
      success: true as const,
      feedbackId: "feedback-id",
      creditsRefunded: 0,
    },
  };
}

describe("local search feedback capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordEndpointFeedback.mockResolvedValue(successfulFeedback());
    (config as { LOCAL_SEARCH_WEB_ONLY: boolean }).LOCAL_SEARCH_WEB_ONLY = true;
  });

  afterAll(() => {
    (
      config as { LOCAL_SEARCH_WEB_ONLY: boolean | undefined }
    ).LOCAL_SEARCH_WEB_ONLY = originalLocalSearchWebOnly;
  });

  // @lat: [[http#Endpoint feedback]]
  it("rejects both local search feedback routes before parsing or storage", async () => {
    const searchResponse = response();
    await searchFeedbackController(
      {
        params: { jobId: "00000000-0000-4000-8000-000000000001" },
        body: {},
        auth: { team_id: "team-id" },
      } as never,
      searchResponse as never,
    );

    const genericResponse = response();
    await feedbackController(
      {
        body: { endpoint: "search" },
        auth: { team_id: "team-id" },
      } as never,
      genericResponse as never,
    );

    for (const result of [searchResponse, genericResponse]) {
      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({
        success: false,
        code: "BAD_REQUEST",
        error: LOCAL_SEARCH_WEB_ONLY_MESSAGE,
      });
    }
    expect(mocks.recordEndpointFeedback).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("keeps non-search feedback available in local mode", async () => {
    const res = response();
    await feedbackController(
      {
        body: {
          endpoint: "scrape",
          jobId: "00000000-0000-4000-8000-000000000001",
          rating: "bad",
          issues: ["missing_content"],
        },
        auth: { team_id: "team-id" },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(mocks.recordEndpointFeedback).toHaveBeenCalledOnce();
  });

  it("preserves search feedback outside local web-only mode", async () => {
    (config as { LOCAL_SEARCH_WEB_ONLY: boolean }).LOCAL_SEARCH_WEB_ONLY =
      false;
    const res = response();
    await searchFeedbackController(
      {
        params: { jobId: "00000000-0000-4000-8000-000000000001" },
        body: {
          rating: "good",
          valuableSources: [{ url: "https://example.test" }],
        },
        auth: { team_id: "team-id" },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(mocks.recordEndpointFeedback).toHaveBeenCalledOnce();
  });
});
