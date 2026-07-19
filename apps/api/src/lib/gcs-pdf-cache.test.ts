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
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { getPdfResultFromCache, savePdfResultToCache } from "./gcs-pdf-cache";

describe("PDF artifact provider failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    config.LOCAL_PERSISTENCE_ENABLED = true;
    store.provider = "minio";
  });

  it("coordinates a local cache object with retention metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
    putLocalArtifactWithManifest.mockResolvedValue(undefined);

    await expect(
      savePdfResultToCache("pdf", {
        markdown: "exact markdown",
        html: "<p>exact</p>",
      }),
    ).resolves.toBe(
      "c35b21d6ca39aa7cc3b79a705d989f1a6e88b99ab43988d74048799e3db926a3",
    );

    expect(store.put).not.toHaveBeenCalled();
    expect(putLocalArtifactWithManifest).toHaveBeenCalledWith(store, {
      key: "pdf-cache-v2/c35b21d6ca39aa7cc3b79a705d989f1a6e88b99ab43988d74048799e3db926a3.json",
      body: JSON.stringify({
        markdown: "exact markdown",
        html: "<p>exact</p>",
      }),
      contentType: "application/json",
      metadata: {
        source: "runpod_pdf_conversion",
        cache_type: "pdf_markdown",
        created_at: "2026-07-18T12:00:00.000Z",
      },
      ownerId: config.LOCAL_OWNER_ID,
      requestId: null,
      jobId: null,
      kind: "pdf-cache",
      deleteAfter: new Date("2026-08-17T12:00:00.000Z"),
    });
  });

  it("fails closed for configured local writes", async () => {
    const failure = new Error("local store unavailable");
    putLocalArtifactWithManifest.mockRejectedValue(failure);
    await expect(
      savePdfResultToCache("pdf", { markdown: "md", html: "html" }),
    ).rejects.toBe(failure);
  });

  it("fails closed for configured local reads", async () => {
    const failure = new Error("local store unavailable");
    store.get.mockRejectedValue(failure);
    await expect(getPdfResultFromCache("pdf")).rejects.toBe(failure);
  });

  it("preserves hosted GCS best-effort cache behavior", async () => {
    config.LOCAL_PERSISTENCE_ENABLED = false;
    store.provider = "gcs";
    store.put.mockRejectedValue(new Error("hosted store unavailable"));
    await expect(
      savePdfResultToCache("pdf", { markdown: "md", html: "html" }),
    ).resolves.toBeNull();
  });
});
