import { logger } from "../lib/logger";
import {
  claimNextBrowserAdmissionCleanup,
  failBrowserAdmissionCleanup,
  markBrowserAdmissionBackendReleased,
  renewBrowserAdmissionCleanup,
  type BrowserAdmissionCleanupClaim,
} from "../lib/browser-state/store";
import type { BrowserStartupGate } from "../lib/browser-runtime/startup-gate";

type ReleaseExternalSlotBackend = (
  teamId: string,
  holderId: string,
  backend: "redis" | "fdb",
) => Promise<void>;

const releaseExternalSlotBackend: ReleaseExternalSlotBackend = async (
  teamId,
  holderId,
  backend,
) => {
  const router = await import("./worker/nuq-router.js");
  await router.releaseExternalSlotBackend(teamId, holderId, backend);
};

type BrowserAdmissionBackendAvailable = (
  backend: "redis" | "fdb",
) => Promise<boolean>;

const backendAvailable: BrowserAdmissionBackendAvailable = async backend => {
  if (backend === "redis") return true;
  const router = await import("./worker/nuq-router.js");
  return router.fdbQueueEnabled();
};

export async function executeBrowserAdmissionCleanupClaim(
  gate: BrowserStartupGate,
  claim: BrowserAdmissionCleanupClaim,
  release: ReleaseExternalSlotBackend,
  isBackendAvailable: BrowserAdmissionBackendAvailable = backendAvailable,
): Promise<void> {
  const releaseWithHeartbeat = async (
    backend: "redis" | "fdb",
  ): Promise<void> => {
    let heartbeatError: unknown;
    let pendingHeartbeat = Promise.resolve();
    const interval = setInterval(() => {
      pendingHeartbeat = pendingHeartbeat
        .then(async () => {
          const renewed = await gate.withBrowserStateMutationLease(
            "filesystem_and_database",
            lease => renewBrowserAdmissionCleanup(lease, claim),
          );
          if (!renewed) {
            throw new Error("Browser admission cleanup lease was lost");
          }
        })
        .catch(error => {
          heartbeatError = error;
        });
    }, 5_000);
    interval.unref();
    try {
      await release(claim.ownerId, claim.sessionId, backend);
      await pendingHeartbeat;
      if (heartbeatError) throw heartbeatError;
    } finally {
      clearInterval(interval);
      await pendingHeartbeat;
    }
  };
  try {
    for (const backend of ["redis", "fdb"] as const) {
      const required = claim.backend === backend || claim.backend === "both";
      const released =
        backend === "redis" ? claim.redisReleased : claim.fdbReleased;
      if (!required || released) continue;
      if (claim.backend === "both" && !(await isBackendAvailable(backend))) {
        await gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => markBrowserAdmissionBackendReleased(lease, claim, backend),
        );
        continue;
      }
      await releaseWithHeartbeat(backend);
      await gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => markBrowserAdmissionBackendReleased(lease, claim, backend),
      );
    }
  } catch (error) {
    await gate
      .withBrowserStateMutationLease("filesystem_and_database", lease =>
        failBrowserAdmissionCleanup(
          lease,
          claim,
          "external_slot_release_failed",
        ),
      )
      .catch(() => undefined);
    throw error;
  }
}

export async function drainBrowserAdmissionCleanupOnce(
  gate: BrowserStartupGate,
  release: ReleaseExternalSlotBackend = releaseExternalSlotBackend,
  isBackendAvailable: BrowserAdmissionBackendAvailable = backendAvailable,
): Promise<boolean> {
  const claim = await gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    claimNextBrowserAdmissionCleanup,
  );
  if (!claim) return false;
  await executeBrowserAdmissionCleanupClaim(
    gate,
    claim,
    release,
    isBackendAvailable,
  );
  return true;
}

export function startBrowserAdmissionCleanupWorker(
  gate: BrowserStartupGate,
  drain: (
    gate: BrowserStartupGate,
  ) => Promise<boolean> = drainBrowserAdmissionCleanupOnce,
): {
  stop(): Promise<void>;
} {
  let stopped = false;
  let activePoll: Promise<void> | undefined;
  const poll = () => {
    if (stopped || activePoll) return;
    activePoll = (async () => {
      try {
        for (let count = 0; count < 25 && !stopped; count++) {
          if (!(await drain(gate))) break;
        }
      } catch (error) {
        logger.error("Browser admission cleanup worker failed", {
          category: "external_slot_release_failed",
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    })().finally(() => {
      activePoll = undefined;
    });
  };
  const interval = setInterval(poll, 1_000);
  interval.unref();
  poll();
  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await activePoll;
    },
  };
}
