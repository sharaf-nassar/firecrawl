import type { Response } from "express";
import type { Mock } from "vitest";
import type { RequestWithAuth as V1RequestWithAuth } from "../v1/types";
import type { RequestWithAuth as V2RequestWithAuth } from "../v2/types";

const { config, logger } = vi.hoisted(() => {
  const logger: any = {
    warn: vi.fn(),
    child: vi.fn(() => logger),
  };

  return {
    config: {
      ARTIFACT_STORE_PROVIDER: "none" as "none" | "minio" | "gcs",
      GCS_BUCKET_NAME: undefined as string | undefined,
      USE_DB_AUTHENTICATION: false,
    },
    logger,
  };
});

vi.mock("../../config", () => ({ config }));

vi.mock("../../lib/logger", () => ({ logger }));

vi.mock("../../lib/gcs-jobs", () => ({
  getJobFromGCS: vi.fn(),
}));

vi.mock("../../lib/extract/extract-redis", () => ({
  getExtract: vi.fn(),
  getExtractExpiry: vi.fn(),
  getExtractResult: vi.fn(),
}));

vi.mock("../../lib/supabase-jobs", () => ({
  supabaseGetAgentByIdDirect: vi.fn(),
  supabaseGetExtractByIdDirect: vi.fn(),
  supabaseGetExtractRequestByIdDirect: vi.fn(),
}));

import { extractStatusController as v1ExtractStatusController } from "../v1/extract-status";
import { extractStatusController as v2ExtractStatusController } from "../v2/extract-status";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import {
  getExtract,
  getExtractExpiry,
  getExtractResult,
} from "../../lib/extract/extract-redis";

const jobId = "019e6f45-7778-727d-adf0-0abe9d5062b6";
const teamId = "team-123";

const req = {
  params: { jobId },
  auth: { team_id: teamId },
} as V1RequestWithAuth<{ jobId: string }, any, any> &
  V2RequestWithAuth<{ jobId: string }, any, any>;

function buildRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

const controllers = [
  ["v1", v1ExtractStatusController],
  ["v2", v2ExtractStatusController],
] as const;

describe.each(controllers)(
  "%s extract status artifact reads",
  (_, controller) => {
    beforeEach(() => {
      vi.clearAllMocks();
      config.ARTIFACT_STORE_PROVIDER = "none";
      config.GCS_BUCKET_NAME = undefined;
      config.USE_DB_AUTHENTICATION = false;
      (getExtract as Mock).mockResolvedValue({
        status: "completed",
        team_id: teamId,
      });
      (getExtractExpiry as Mock).mockResolvedValue(
        new Date("2026-07-19T00:00:00.000Z"),
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns the durable extract from MinIO without GCS configured", async () => {
      vi.stubEnv("ARTIFACT_STORE_PROVIDER", "minio");
      config.ARTIFACT_STORE_PROVIDER = "minio";
      (getJobFromGCS as Mock).mockResolvedValue([{ source: "minio" }]);
      (getExtractResult as Mock).mockResolvedValue([{ source: "redis" }]);

      const res = buildRes();
      await controller(req, res);

      expect(getJobFromGCS).toHaveBeenCalledWith(jobId);
      expect(getExtractResult).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { source: "minio" } }),
      );
    });

    it("falls back to Redis when no artifact store is configured", async () => {
      (getExtractResult as Mock).mockResolvedValue([{ source: "redis" }]);

      const res = buildRes();
      await controller(req, res);

      expect(getJobFromGCS).not.toHaveBeenCalled();
      expect(getExtractResult).toHaveBeenCalledWith(jobId);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { source: "redis" } }),
      );
    });
  },
);
