import { beforeEach, describe, expect, it, vi } from "vitest";

const { config, putLocalArtifactWithManifest, store } = vi.hoisted(() => ({
  config: {
    LOCAL_PERSISTENCE_ENABLED: true,
    LOCAL_OWNER_ID: "7c70fd9c-4b7f-4d5f-87a6-91af0588623c",
    LOCAL_ARTIFACT_RETENTION_DAYS: 30,
  },
  putLocalArtifactWithManifest: vi.fn(),
  store: {
    provider: "minio" as "minio" | "gcs",
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    health: vi.fn(),
  },
}));

vi.mock("./artifacts", () => ({ getArtifactStore: () => store }));
vi.mock("./artifacts/local-manifest", () => ({ putLocalArtifactWithManifest }));
vi.mock("../config", () => ({ config }));

import {
  saveMonitorDiffArtifact,
  type MonitorDiffArtifact,
} from "./gcs-monitoring";

const key = "monitors/owner/monitor/check/page.diff.json";
const artifact: MonitorDiffArtifact = {
  kind: "markdown",
  url: "https://example.com",
  previousScrapeId: null,
  currentScrapeId: null,
  generatedAt: "2026-07-18T12:00:00.000Z",
  text: "exact diff",
  json: { changed: true },
};

describe("monitor diff artifact persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    config.LOCAL_PERSISTENCE_ENABLED = true;
    store.provider = "minio";
  });

  it("coordinates a local diff object with retention metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
    putLocalArtifactWithManifest.mockResolvedValue(undefined);

    await expect(saveMonitorDiffArtifact(key, artifact)).resolves.toEqual({
      textBytes: 10,
      jsonBytes: 16,
    });

    expect(store.put).not.toHaveBeenCalled();
    expect(putLocalArtifactWithManifest).toHaveBeenCalledWith(store, {
      key,
      body: JSON.stringify(artifact),
      contentType: "application/json",
      ownerId: config.LOCAL_OWNER_ID,
      requestId: null,
      jobId: null,
      kind: "monitor-diff",
      deleteAfter: new Date("2026-08-17T12:00:00.000Z"),
    });
  });

  it("keeps hosted GCS independent of the local manifest database", async () => {
    config.LOCAL_PERSISTENCE_ENABLED = false;
    store.provider = "gcs";
    store.put.mockResolvedValue({
      key,
      contentType: "application/json",
      byteSize: Buffer.byteLength(JSON.stringify(artifact)),
      metadata: {},
    });

    await saveMonitorDiffArtifact(key, artifact);

    expect(putLocalArtifactWithManifest).not.toHaveBeenCalled();
    expect(store.put).toHaveBeenCalledWith({
      key,
      body: JSON.stringify(artifact),
      contentType: "application/json",
    });
  });
});
