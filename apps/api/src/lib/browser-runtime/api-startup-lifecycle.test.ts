import { describe, expect, it, vi } from "vitest";

import { runApiStartupLifecycle } from "./api-startup-lifecycle";

function harness(options: {
  persistenceEnabled: boolean;
  browserEnabled: boolean;
}) {
  const events: string[] = [];
  return {
    events,
    dependencies: {
      ...options,
      acquireBrowserControl: vi.fn(async () => {
        events.push("handoff");
        return { generation: 1 };
      }),
      runMigrations: vi.fn(async () => {
        events.push("migrations");
      }),
      startOperationalRetention: vi.fn(async () => {
        events.push("operational-retention");
      }),
      initializeBrowser: vi.fn(async () => {
        events.push("browser-recovery");
      }),
      startApplication: vi.fn(async () => {
        events.push("listener-workers");
      }),
    },
  };
}

describe("runApiStartupLifecycle", () => {
  it("hands off before migrations and opens application last", async () => {
    const test = harness({
      persistenceEnabled: true,
      browserEnabled: true,
    });
    await runApiStartupLifecycle(test.dependencies);
    expect(test.events).toEqual([
      "handoff",
      "migrations",
      "operational-retention",
      "browser-recovery",
      "listener-workers",
    ]);
    expect(test.dependencies.runMigrations).toHaveBeenCalledWith({
      generation: 1,
    });
  });

  it("has no database or listener side effect after handoff failure", async () => {
    const test = harness({
      persistenceEnabled: true,
      browserEnabled: true,
    });
    test.dependencies.acquireBrowserControl.mockRejectedValueOnce(
      new Error("handoff unavailable"),
    );
    await expect(runApiStartupLifecycle(test.dependencies)).rejects.toThrow(
      "handoff unavailable",
    );
    expect(test.events).toEqual([]);
    expect(test.dependencies.runMigrations).not.toHaveBeenCalled();
    expect(test.dependencies.startApplication).not.toHaveBeenCalled();
  });

  it("runs migrations without constructing browser authority when disabled", async () => {
    const test = harness({
      persistenceEnabled: true,
      browserEnabled: false,
    });
    await runApiStartupLifecycle(test.dependencies);
    expect(test.events).toEqual([
      "migrations",
      "operational-retention",
      "listener-workers",
    ]);
    expect(test.dependencies.acquireBrowserControl).not.toHaveBeenCalled();
    expect(test.dependencies.initializeBrowser).not.toHaveBeenCalled();
  });
});
