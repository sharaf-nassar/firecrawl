import { describe, expect, it, vi } from "vitest";

import {
  runApiStartupLifecycle,
  type ApiStartupLifecycleEvent,
} from "./api-startup-lifecycle";

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 1_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("lifecycle condition timed out");
}

function harness(options: {
  persistenceEnabled: boolean;
  browserEnabled: boolean;
  reconciliation?: Promise<void>;
}) {
  const calls: string[] = [];
  const events: ApiStartupLifecycleEvent[] = [];
  const resources = {
    apiStartup: false,
    operationalRetentionRunning: false,
    owners: {
      migrations: [] as string[],
      recovery: [] as string[],
      operationalRetention: [] as string[],
      browserRetention: [] as string[],
    },
  };
  const dependencies = {
    persistenceEnabled: options.persistenceEnabled,
    browserEnabled: options.browserEnabled,
    acquireBrowserControl: vi.fn(async () => {
      calls.push("api:browser-control");
      resources.apiStartup = true;
      return { generation: 1 };
    }),
    runMigrations: vi.fn(async () => {
      calls.push("api:migrations");
      resources.owners.migrations.push("api");
    }),
    initializeBrowser: vi.fn(async () => {
      calls.push("api:browser-reconciliation");
      resources.owners.recovery.push("api");
      await options.reconciliation;
    }),
    startOperationalRetention: vi.fn(async () => {
      calls.push("api:operational-retention");
      resources.owners.operationalRetention.push("api");
      resources.operationalRetentionRunning = true;
    }),
    startApplication: vi.fn(async () => {
      calls.push("api:server-listen");
      return { listening: true };
    }),
    cleanupStartupResources: vi.fn(async () => {
      calls.push("api:startup-cleanup");
      resources.apiStartup = false;
      resources.operationalRetentionRunning = false;
    }),
    observe: vi.fn((event: ApiStartupLifecycleEvent) => {
      events.push(event);
      if (event.stage === "browser_retention" && event.status === "started") {
        resources.owners.browserRetention.push(event.owner);
      }
    }),
  };
  return { calls, dependencies, events, resources };
}

describe("runApiStartupLifecycle", () => {
  it("keeps reconciliation blocked after operational retention then opens listening last", async () => {
    const reconciliation = deferred<void>();
    const test = harness({
      persistenceEnabled: true,
      browserEnabled: true,
      reconciliation: reconciliation.promise,
    });

    let settled = false;
    const startup = runApiStartupLifecycle(test.dependencies).finally(() => {
      settled = true;
    });
    await waitFor(() =>
      test.events.some(
        event =>
          event.stage === "browser_reconciliation" &&
          event.status === "started",
      ),
    );

    expect(settled).toBe(false);
    expect(test.resources.apiStartup).toBe(true);
    expect(test.resources.operationalRetentionRunning).toBe(true);
    expect(test.dependencies.startOperationalRetention).toHaveBeenCalledTimes(
      1,
    );
    expect(test.dependencies.startApplication).not.toHaveBeenCalled();
    expect(test.dependencies.cleanupStartupResources).not.toHaveBeenCalled();
    expect(test.events.some(event => event.stage === "browser_retention")).toBe(
      false,
    );
    expect(test.resources.owners).toEqual({
      migrations: ["api"],
      recovery: ["api"],
      operationalRetention: ["api"],
      browserRetention: [],
    });

    reconciliation.resolve();
    await expect(startup).resolves.toEqual({ listening: true });
    expect(test.calls).toEqual([
      "api:browser-control",
      "api:migrations",
      "api:operational-retention",
      "api:browser-reconciliation",
      "api:server-listen",
    ]);
    expect(test.dependencies.startOperationalRetention).toHaveBeenCalledTimes(
      1,
    );
    expect(test.resources.owners).toEqual({
      migrations: ["api"],
      recovery: ["api"],
      operationalRetention: ["api"],
      browserRetention: ["api"],
    });
    expect(test.events).toEqual([
      {
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence: 1,
        stage: "browser_control",
        status: "completed",
      },
      {
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence: 2,
        stage: "migrations",
        status: "completed",
      },
      {
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence: 3,
        stage: "operational_retention",
        status: "completed",
      },
      {
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence: 4,
        stage: "browser_reconciliation",
        status: "started",
      },
      {
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence: 5,
        stage: "browser_reconciliation",
        status: "completed",
      },
      {
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence: 6,
        stage: "browser_retention",
        status: "started",
      },
      {
        version: 1,
        event: "api_startup_lifecycle",
        owner: "api",
        sequence: 7,
        stage: "server_listen",
        status: "completed",
      },
    ]);
    expect(test.events.every(event => event.owner === "api")).toBe(true);
  });

  it("cleans operational retention after blocked reconciliation fails", async () => {
    const reconciliation = deferred<void>();
    const test = harness({
      persistenceEnabled: true,
      browserEnabled: true,
      reconciliation: reconciliation.promise,
    });
    const startup = runApiStartupLifecycle(test.dependencies);
    await waitFor(() =>
      test.events.some(
        event =>
          event.stage === "browser_reconciliation" &&
          event.status === "started",
      ),
    );

    expect(test.resources.apiStartup).toBe(true);
    expect(test.resources.operationalRetentionRunning).toBe(true);
    expect(test.dependencies.startOperationalRetention).toHaveBeenCalledTimes(
      1,
    );
    expect(test.events.some(event => event.stage === "browser_retention")).toBe(
      false,
    );
    expect(test.resources.owners).toEqual({
      migrations: ["api"],
      recovery: ["api"],
      operationalRetention: ["api"],
      browserRetention: [],
    });
    reconciliation.reject(new Error("reconciliation unresolved"));

    await expect(startup).rejects.toThrow("reconciliation unresolved");
    expect(test.resources.apiStartup).toBe(false);
    expect(test.resources.operationalRetentionRunning).toBe(false);
    expect(test.dependencies.cleanupStartupResources).toHaveBeenCalledTimes(1);
    expect(test.dependencies.startOperationalRetention).toHaveBeenCalledTimes(
      1,
    );
    expect(test.dependencies.startApplication).not.toHaveBeenCalled();
    expect(test.calls).toEqual([
      "api:browser-control",
      "api:migrations",
      "api:operational-retention",
      "api:browser-reconciliation",
      "api:startup-cleanup",
    ]);
    expect(test.events.slice(-2)).toEqual([
      expect.objectContaining({
        owner: "api",
        stage: "browser_reconciliation",
        status: "failed",
      }),
      expect.objectContaining({
        owner: "api",
        stage: "startup_cleanup",
        status: "completed",
      }),
    ]);
  });

  it("runs persistence without constructing browser authority when disabled", async () => {
    const test = harness({
      persistenceEnabled: true,
      browserEnabled: false,
    });
    await expect(runApiStartupLifecycle(test.dependencies)).resolves.toEqual({
      listening: true,
    });
    expect(test.calls).toEqual([
      "api:migrations",
      "api:operational-retention",
      "api:server-listen",
    ]);
    expect(test.dependencies.acquireBrowserControl).not.toHaveBeenCalled();
    expect(test.dependencies.initializeBrowser).not.toHaveBeenCalled();
    expect(test.dependencies.startOperationalRetention).toHaveBeenCalledTimes(
      1,
    );
  });

  it("cleans handoff failure without migrations, retention, or listening", async () => {
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
    expect(test.dependencies.runMigrations).not.toHaveBeenCalled();
    expect(test.dependencies.startOperationalRetention).not.toHaveBeenCalled();
    expect(test.dependencies.startApplication).not.toHaveBeenCalled();
    expect(test.dependencies.cleanupStartupResources).toHaveBeenCalledTimes(1);
  });
});
