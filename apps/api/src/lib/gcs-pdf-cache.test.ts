import { beforeEach, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({
  store: {
    provider: "minio" as "minio" | "gcs",
    put: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock("./artifacts", () => ({ getArtifactStore: () => store }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { getPdfResultFromCache, savePdfResultToCache } from "./gcs-pdf-cache";

describe("PDF artifact provider failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.provider = "minio";
  });

  it("fails closed for configured local writes", async () => {
    const failure = new Error("local store unavailable");
    store.put.mockRejectedValue(failure);
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
    store.provider = "gcs";
    store.put.mockRejectedValue(new Error("hosted store unavailable"));
    await expect(
      savePdfResultToCache("pdf", { markdown: "md", html: "html" }),
    ).resolves.toBeNull();
  });
});
