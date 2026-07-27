import { randomUUID } from "node:crypto";

import { config } from "../config";
import { logger } from "../lib/logger";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "../lib/browser-runtime/startup-gate";
import { terminalizeExpiredBrowserSessions } from "../lib/browser-state/store";
type BillingOutboxClaim = {
  sessionId: string;
  ownerId: string;
  subscriptionId: string | null;
  apiKeyId: number | null;
  endpoint: "browser" | "interact";
  credits: number;
  keylessTeamId: string | null;
  keylessReservedCredits: number;
  leaseToken: string;
};

type BrowserBillingOutboxDependencies = {
  beforeKeylessLog?: (claim: BillingOutboxClaim) => Promise<void>;
};

class BrowserBillingOutboxError extends Error {
  readonly category = "browser_billing_delivery_failed";

  constructor(cause?: unknown) {
    super("Browser billing outbox delivery failed", { cause });
    this.name = "BrowserBillingOutboxError";
  }
}

async function claimOne(
  lease: BrowserStateMutationLease,
): Promise<BillingOutboxClaim | null> {
  const leaseToken = randomUUID();
  const result = await lease.transaction.query<{
    session_id: string;
    owner_id: string;
    subscription_id: string | null;
    api_key_id: number | null;
    endpoint: "browser" | "interact";
    credits: number;
    keyless_team_id: string | null;
    keyless_reserved_credits: number;
  }>(
    `UPDATE browser_billing_outbox
        SET lease_token = $1,
            lease_expires_at = now() + interval '30 seconds',
            attempt_count = attempt_count + 1,
            updated_at = now()
      WHERE session_id = (
        SELECT session_id
          FROM browser_billing_outbox
         WHERE state = 'pending'
           AND next_attempt_at <= now()
           AND (lease_token IS NULL OR lease_expires_at <= now())
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING session_id, owner_id, subscription_id, api_key_id,
                endpoint, credits, keyless_team_id, keyless_reserved_credits`,
    [leaseToken],
  );
  const row = result.rows[0];
  return row
    ? {
        sessionId: row.session_id,
        ownerId: row.owner_id,
        subscriptionId: row.subscription_id,
        apiKeyId: row.api_key_id,
        endpoint: row.endpoint,
        credits: row.credits,
        keylessTeamId: row.keyless_team_id,
        keylessReservedCredits: row.keyless_reserved_credits,
        leaseToken,
      }
    : null;
}

async function acknowledgeNonApplicableHostedSinks(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
): Promise<void> {
  await lease.transaction.query(
    `INSERT INTO browser_billing_sink_receipts (
       session_id, legacy_acked_at, autumn_acked_at
     )
     VALUES ($1, now(), now())
     ON CONFLICT (session_id) DO UPDATE
       SET legacy_acked_at = COALESCE(
             browser_billing_sink_receipts.legacy_acked_at, now()
           ),
           autumn_acked_at = COALESCE(
             browser_billing_sink_receipts.autumn_acked_at, now()
           ),
           updated_at = now()`,
    [claim.sessionId],
  );
}

type KeylessProgress = {
  adjustmentAcked: boolean;
  loggingAcked: boolean;
  receiptGcAcked: boolean;
  complete: boolean;
};

async function loadKeylessProgress(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
): Promise<KeylessProgress> {
  const result = await lease.transaction.query<{
    adjustment_acked: boolean;
    logging_acked: boolean;
    receipt_gc_acked: boolean;
    complete: boolean;
  }>(
    `SELECT keyless_adjustment_acked_at IS NOT NULL AS adjustment_acked,
            keyless_logging_acked_at IS NOT NULL AS logging_acked,
            keyless_receipt_gc_acked_at IS NOT NULL AS receipt_gc_acked,
            keyless_acked_at IS NOT NULL AS complete
       FROM browser_billing_sink_receipts
      WHERE session_id = $1`,
    [claim.sessionId],
  );
  const row = result.rows[0];
  if (!row) throw new BrowserBillingOutboxError();
  return {
    adjustmentAcked: row.adjustment_acked,
    loggingAcked: row.logging_acked,
    receiptGcAcked: row.receipt_gc_acked,
    complete: row.complete,
  };
}

async function markKeylessStage(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
  stage: "adjustment" | "logging" | "receipt_gc",
): Promise<void> {
  const column = {
    adjustment: "keyless_adjustment_acked_at",
    logging: "keyless_logging_acked_at",
    receipt_gc: "keyless_receipt_gc_acked_at",
  }[stage];
  await lease.transaction.query(
    `UPDATE browser_billing_sink_receipts
        SET ${column} = COALESCE(${column}, now()),
            updated_at = now()
      WHERE session_id = $1`,
    [claim.sessionId],
  );
}

async function recordKeylessUsage(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
): Promise<void> {
  if (!claim.keylessTeamId) throw new BrowserBillingOutboxError();
  await lease.transaction.query(
    `INSERT INTO browser_keyless_usage_log (
       session_id, keyless_team_id, credits
     ) VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING`,
    [claim.sessionId, claim.keylessTeamId, claim.credits],
  );
  await markKeylessStage(lease, claim, "logging");
}

async function markKeylessComplete(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
): Promise<void> {
  const result = await lease.transaction.query(
    `UPDATE browser_billing_sink_receipts
        SET keyless_acked_at = COALESCE(keyless_acked_at, now()),
            updated_at = now()
      WHERE session_id = $1
        AND keyless_adjustment_acked_at IS NOT NULL
        AND keyless_logging_acked_at IS NOT NULL
        AND keyless_receipt_gc_acked_at IS NOT NULL
      RETURNING session_id`,
    [claim.sessionId],
  );
  if (result.rows.length !== 1) throw new BrowserBillingOutboxError();
}

async function acknowledgeNonApplicableKeyless(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
): Promise<void> {
  await lease.transaction.query(
    `UPDATE browser_billing_sink_receipts
        SET keyless_adjustment_acked_at = COALESCE(
              keyless_adjustment_acked_at, now()
            ),
            keyless_logging_acked_at = COALESCE(
              keyless_logging_acked_at, now()
            ),
            keyless_receipt_gc_acked_at = COALESCE(
              keyless_receipt_gc_acked_at, now()
            ),
            keyless_acked_at = COALESCE(keyless_acked_at, now()),
            updated_at = now()
      WHERE session_id = $1`,
    [claim.sessionId],
  );
}

async function markDelivered(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
): Promise<void> {
  const result = await lease.transaction.query(
    `UPDATE browser_billing_outbox outbox
        SET state = 'delivered',
            delivered_at = now(),
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_category = NULL,
            updated_at = now()
       FROM browser_billing_sink_receipts receipt
      WHERE outbox.session_id = $1
        AND outbox.lease_token = $2
        AND receipt.session_id = outbox.session_id
        AND receipt.legacy_acked_at IS NOT NULL
        AND receipt.autumn_acked_at IS NOT NULL
        AND receipt.keyless_acked_at IS NOT NULL
      RETURNING outbox.session_id`,
    [claim.sessionId, claim.leaseToken],
  );
  if (result.rows.length !== 1) {
    throw new BrowserBillingOutboxError();
  }
}

async function releaseFailedClaim(
  lease: BrowserStateMutationLease,
  claim: BillingOutboxClaim,
): Promise<void> {
  await lease.transaction.query(
    `UPDATE browser_billing_outbox
        SET lease_token = NULL,
            lease_expires_at = NULL,
            next_attempt_at = now() + interval '1 second',
            last_error_category = 'browser_billing_delivery_failed',
            updated_at = now()
      WHERE session_id = $1
        AND lease_token = $2`,
    [claim.sessionId, claim.leaseToken],
  );
}

export async function drainBrowserBillingOutboxOnce(
  gate: BrowserStartupGate,
  dependencies: BrowserBillingOutboxDependencies = {},
): Promise<boolean> {
  await gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    terminalizeExpiredBrowserSessions,
  );
  const claim = await gate.withBrowserStateMutationLease(
    "filesystem_and_database",
    claimOne,
  );
  if (!claim) return false;
  try {
    await gate.withBrowserStateMutationLease("filesystem_and_database", lease =>
      acknowledgeNonApplicableHostedSinks(lease, claim),
    );
    if (!claim.keylessTeamId) {
      await gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => acknowledgeNonApplicableKeyless(lease, claim),
      );
    } else {
      let progress = await gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => loadKeylessProgress(lease, claim),
      );
      const keyless = await import("../lib/keyless.js");
      if (!progress.adjustmentAcked) {
        await keyless.reconcileBrowserKeylessCreditsOnce(
          claim.keylessTeamId,
          claim.keylessReservedCredits,
          claim.credits,
          claim.sessionId,
        );
        await gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => markKeylessStage(lease, claim, "adjustment"),
        );
      }
      if (!progress.loggingAcked) {
        await dependencies.beforeKeylessLog?.(claim);
        await gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => recordKeylessUsage(lease, claim),
        );
      }
      progress = await gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => loadKeylessProgress(lease, claim),
      );
      if (!progress.receiptGcAcked) {
        const retentionDays = Math.max(
          config.LOCAL_RECORD_RETENTION_DAYS,
          config.LOCAL_ARTIFACT_RETENTION_DAYS,
        );
        await keyless.expireBrowserKeylessReconcileReceipt(
          claim.sessionId,
          (retentionDays + 7) * 86_400,
        );
        await gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => markKeylessStage(lease, claim, "receipt_gc"),
        );
      }
      await gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => markKeylessComplete(lease, claim),
      );
    }
    await gate.withBrowserStateMutationLease("filesystem_and_database", lease =>
      markDelivered(lease, claim),
    );
    return true;
  } catch (error) {
    await gate
      .withBrowserStateMutationLease("filesystem_and_database", lease =>
        releaseFailedClaim(lease, claim),
      )
      .catch(() => undefined);
    if (error instanceof BrowserBillingOutboxError) throw error;
    throw new BrowserBillingOutboxError(error);
  }
}

export function startBrowserBillingOutboxWorker(
  gate: BrowserStartupGate,
  drain: (
    gate: BrowserStartupGate,
  ) => Promise<boolean> = drainBrowserBillingOutboxOnce,
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
        logger.error("Browser billing outbox worker failed", {
          category: "browser_billing_delivery_failed",
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
