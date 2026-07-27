import { describe, expect, it, vi } from "vitest";

import {
  cleanupTrackedResources,
  throwTrackedCleanupFailures,
} from "./tracked-cleanup";

describe("tracked smoke resource cleanup", () => {
  it("deletes only resources released successfully", async () => {
    const tracked = new Set(["released", "retry"]);
    const release = vi.fn(async (id: string) => {
      if (id === "retry") throw new Error("release failed");
    });

    const failures = await cleanupTrackedResources(
      tracked,
      "scenario",
      release,
    );

    expect(tracked).toEqual(new Set(["retry"]));
    expect(failures).toEqual([
      {
        resource: "scenario",
        id: "retry",
        error: expect.objectContaining({ message: "release failed" }),
      },
    ]);
    expect(() => throwTrackedCleanupFailures(failures)).toThrowError(
      expect.objectContaining({
        name: "AggregateError",
        message: "scenario:retry",
      }),
    );
  });

  it("retains a failure for a successful final retry", async () => {
    const tracked = new Set(["retry"]);
    const release = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce();

    expect(
      await cleanupTrackedResources(tracked, "scrape", release),
    ).toHaveLength(1);
    expect(tracked).toEqual(new Set(["retry"]));
    expect(await cleanupTrackedResources(tracked, "scrape", release)).toEqual(
      [],
    );
    expect(tracked).toEqual(new Set());
  });
});
