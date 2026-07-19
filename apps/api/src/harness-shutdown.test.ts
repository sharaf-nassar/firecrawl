import { describe, expect, it, vi } from "vitest";

import { createSharedShutdown } from "./harness-shutdown";

describe("createSharedShutdown", () => {
  it("makes concurrent and reentrant callers await one shutdown", async () => {
    let releaseShutdown!: () => void;
    const shutdownBlocked = new Promise<void>(resolve => {
      releaseShutdown = resolve;
    });
    let shutdown!: () => Promise<void>;
    let reentrant: Promise<void> | undefined;
    const runShutdown = vi.fn(async () => {
      await Promise.resolve();
      reentrant = shutdown();
      await shutdownBlocked;
    });
    shutdown = createSharedShutdown(runShutdown);

    const first = shutdown();
    const concurrent = shutdown();

    expect(first).toBe(concurrent);
    expect(runShutdown).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(runShutdown).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(reentrant).toBe(first);

    let concurrentSettled = false;
    concurrent.then(() => {
      concurrentSettled = true;
    });
    await Promise.resolve();
    expect(concurrentSettled).toBe(false);

    releaseShutdown();
    await Promise.all([first, concurrent]);
    expect(runShutdown).toHaveBeenCalledTimes(1);
  });
});
