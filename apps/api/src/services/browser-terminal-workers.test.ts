import { describe, expect, it, vi } from "vitest";

import type { BrowserStartupGate } from "../lib/browser-runtime/startup-gate";
import { startBrowserAdmissionCleanupWorker } from "./browser-admission-cleanup";
import { startBrowserBillingOutboxWorker } from "./browser-billing-outbox";

describe.each([
  ["billing", startBrowserBillingOutboxWorker],
  ["admission", startBrowserAdmissionCleanupWorker],
] as const)("%s terminal worker shutdown", (_name, startWorker) => {
  it("awaits the active poll and starts no next iteration", async () => {
    let finishDrain!: (value: boolean) => void;
    const drainResult = new Promise<boolean>(resolve => {
      finishDrain = resolve;
    });
    const drain = vi.fn(async () => drainResult);
    const worker = startWorker({} as BrowserStartupGate, drain);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishDrain(true);
    await stop;
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
