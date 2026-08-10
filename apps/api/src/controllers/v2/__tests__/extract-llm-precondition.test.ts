import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  logRequest: vi.fn(),
  precondition: vi.fn(),
  saveExtract: vi.fn(),
}));

vi.mock("../../../services/queue-service", () => ({
  addExtractJobToQueue: mocks.enqueue,
}));
vi.mock("../../../lib/extract/extract-redis", () => ({
  saveExtract: mocks.saveExtract,
}));
vi.mock("../../../scraper/WebScraper/utils/blocklist", () => ({
  isUrlBlocked: vi.fn(() => false),
}));
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn() },
}));
vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
}));
vi.mock("../../../config", () => ({ config: {} }));
vi.mock("../../../lib/extract/llm-precondition", () => ({
  getExtractLlmPreconditionError: mocks.precondition,
}));

import { extractController } from "../extract";

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

const request = () =>
  ({
    body: { prompt: "Extract the title" },
    auth: { team_id: "team-1" },
    acuc: undefined,
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.precondition.mockResolvedValue(undefined);
});

describe("v2 extract LLM precondition", () => {
  it("returns an actionable 400 before persistence and queueing", async () => {
    mocks.precondition.mockResolvedValue(
      "Extract OpenAI-compatible LLM backend at http://shim.test/v1/models is unreachable.",
    );
    const res = response();

    await extractController(request(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error:
        "Extract OpenAI-compatible LLM backend at http://shim.test/v1/models is unreachable.",
    });
    expect(mocks.logRequest).not.toHaveBeenCalled();
    expect(mocks.saveExtract).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("returns an id when the configured backend responds", async () => {
    const res = response();

    await extractController(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, id: expect.any(String) }),
    );
    expect(mocks.saveExtract).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
