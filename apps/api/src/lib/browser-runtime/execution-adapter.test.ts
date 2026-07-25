import { describe, expect, it } from "vitest";

import {
  createUnavailableExecutionAdapter,
  ExecutionAdapterError,
} from "./execution-adapter";

describe("unavailable execution adapter", () => {
  it("fails closed when host execution is absent", async () => {
    const adapter = createUnavailableExecutionAdapter();
    await expect(
      adapter.executePromptRun({} as never, new AbortController().signal),
    ).rejects.toMatchObject({ category: "codex_unavailable" });
    await expect(
      adapter.executeCodeRun({} as never, new AbortController().signal),
    ).rejects.toMatchObject({ category: "sandbox_unavailable" });
  });

  it("exposes only typed unavailable categories", () => {
    expect(new ExecutionAdapterError("codex_unavailable")).toMatchObject({
      category: "codex_unavailable",
    });
  });
});
