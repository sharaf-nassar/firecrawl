import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "../browser-runtime/startup-gate";
import { runtimeUuidSchema } from "../browser-runtime/protocol";
import type {
  AdapterAuthorizationBinding,
  AdapterPendingBinding,
  BrowserOperation,
} from "./types";

const CAPABILITY_CALL_LIMIT = 25;
const CAPABILITY_BYTE_LIMIT = 1024 * 1024;
const CAPABILITY_OPERATION_TIMEOUT_MS = 30_000;
const CAPABILITY_MAX_LIFETIME_MS = 300_000;
const CAPABILITY_OPERATIONS = [
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "select",
  "scroll",
  "wait",
  "get_text",
  "get_url",
  "navigate",
  "evaluate",
] as const;

/** @public */
export class CapabilityDeniedError extends Error {
  readonly category = "capability_denied";

  constructor() {
    super("Browser capability was denied");
    this.name = "CapabilityDeniedError";
  }
}

/** @public */
export function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const pendingInputSchema = z.strictObject({
  runId: runtimeUuidSchema,
  adapterJobId: runtimeUuidSchema,
  adapterSupervisorId: runtimeUuidSchema,
  adapterProcessId: z.null(),
});

const activeBindingSchema = z.strictObject({
  adapterJobId: runtimeUuidSchema,
  adapterSupervisorId: runtimeUuidSchema,
  adapterProcessId: z.number().int().positive(),
});

const authorizationInputSchema = z.strictObject({
  token: z.string().min(32).max(512),
  ownerId: runtimeUuidSchema,
  sessionId: runtimeUuidSchema,
  runId: runtimeUuidSchema,
  adapterJobId: runtimeUuidSchema,
  adapterSupervisorId: runtimeUuidSchema,
  adapterProcessId: z.number().int().positive(),
});

const persistedBindingInputSchema = z.strictObject({
  ownerId: runtimeUuidSchema,
  sessionId: runtimeUuidSchema,
  runId: runtimeUuidSchema,
  adapterJobId: runtimeUuidSchema,
  adapterSupervisorId: runtimeUuidSchema,
  adapterProcessId: z.number().int().positive(),
  operation: z.enum(CAPABILITY_OPERATIONS).optional(),
  byteCount: z.number().int().min(0).max(CAPABILITY_BYTE_LIMIT).optional(),
});

/** @public */
export type BeginAdapterCapabilityInput = AdapterPendingBinding & {
  runId: string;
};

/** @public */
export type AuthorizeAdapterCapabilityInput = AdapterAuthorizationBinding & {
  token: string;
  ownerId: string;
  sessionId: string;
  runId: string;
};

/** @public Server-resolved callback binding; never accepts a raw grant token. */
export type AuthorizePersistedCapabilityInput = AdapterAuthorizationBinding & {
  ownerId: string;
  sessionId: string;
  runId: string;
  operation?: BrowserOperation["kind"];
  byteCount?: number;
};

/** @public */
export type AdapterCapabilityBinding = {
  id: string;
  ownerId: string;
  sessionId: string;
  runId: string;
  adapterJobId: string;
  adapterSupervisorId: string;
  adapterProcessId: number | null;
  activatedAt: Date | null;
  revokedAt: Date | null;
  wallDeadlineAt: Date;
  perOperationTimeoutMs: number;
  expiresAt: Date;
};

/** @public Raw token is returned once and never persisted. */
export type IssuedAdapterCapability = {
  capability: AdapterCapabilityBinding;
  token: string;
};

function deny(): never {
  throw new CapabilityDeniedError();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function mapBinding(row: Record<string, unknown>): AdapterCapabilityBinding {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    adapterJobId: String(row.adapter_job_id),
    adapterSupervisorId: String(row.adapter_supervisor_id),
    adapterProcessId:
      row.adapter_process_id === null ? null : Number(row.adapter_process_id),
    activatedAt:
      row.activated_at === null ? null : new Date(String(row.activated_at)),
    revokedAt:
      row.revoked_at === null ? null : new Date(String(row.revoked_at)),
    wallDeadlineAt: new Date(String(row.wall_deadline_at)),
    perOperationTimeoutMs: Number(row.per_operation_timeout_ms),
    expiresAt: new Date(String(row.expires_at)),
  };
}

function parseOrDeny<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) deny();
  return parsed.data;
}

async function beginAdapterRun(
  lease: BrowserStateMutationLease,
  untrustedInput: BeginAdapterCapabilityInput,
  now: Date,
): Promise<IssuedAdapterCapability> {
  const input = parseOrDeny(pendingInputSchema, untrustedInput);
  const locked = await lease.transaction.query(
    `SELECT r.id, r.owner_id, r.session_id, r.request_id, r.mode, r.state,
            r.deadline_at, r.adapter_job_id, r.adapter_supervisor_id,
            r.adapter_process_id, s.owner_id AS session_owner_id,
            s.request_id AS session_request_id, s.state AS session_state,
            s.current_run_id, s.absolute_deadline_at
       FROM browser_interact_runs r
       JOIN browser_sessions s ON s.id = r.session_id
      WHERE r.id = $1
      FOR UPDATE OF r, s`,
    [input.runId],
  );
  if (locked.rows.length !== 1) deny();
  const row = asRecord(locked.rows[0]);
  if (
    row.state !== "queued" ||
    !["prompt", "code"].includes(String(row.mode)) ||
    row.adapter_job_id !== null ||
    row.adapter_supervisor_id !== null ||
    row.adapter_process_id !== null ||
    row.owner_id !== row.session_owner_id ||
    row.request_id !== row.session_request_id ||
    row.session_state !== "executing" ||
    row.current_run_id !== row.id
  ) {
    deny();
  }
  const nowMs = now.getTime();
  const deadlineMs = Math.min(
    new Date(String(row.deadline_at)).getTime(),
    new Date(String(row.absolute_deadline_at)).getTime(),
    nowMs + CAPABILITY_MAX_LIFETIME_MS,
  );
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) deny();

  const run = await lease.transaction.query(
    `UPDATE browser_interact_runs
        SET state = 'starting',
            adapter_job_id = $2,
            adapter_supervisor_id = $3
      WHERE id = $1
        AND state = 'queued'
        AND adapter_job_id IS NULL
        AND adapter_supervisor_id IS NULL
        AND adapter_process_id IS NULL
      RETURNING id`,
    [input.runId, input.adapterJobId, input.adapterSupervisorId],
  );
  if (run.rows.length !== 1) deny();

  const token = randomBytes(32).toString("base64url");
  const capability = await lease.transaction.query(
    `INSERT INTO browser_capabilities (
       id, token_hash, owner_id, session_id, run_id, adapter_job_id,
       adapter_supervisor_id, adapter_process_id, operations, origins,
       navigation_policy_version, call_limit, byte_limit, wall_deadline_at,
       per_operation_timeout_ms, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, NULL, $8::jsonb, '[]'::jsonb,
       1, $9, $10, $11, $12, $11
     )
     RETURNING id, owner_id, session_id, run_id, adapter_job_id,
               adapter_supervisor_id, adapter_process_id, activated_at,
               revoked_at, wall_deadline_at, per_operation_timeout_ms,
               expires_at`,
    [
      randomUUID(),
      hashCapabilityToken(token),
      row.owner_id,
      row.session_id,
      input.runId,
      input.adapterJobId,
      input.adapterSupervisorId,
      JSON.stringify([...CAPABILITY_OPERATIONS, "cdp"]),
      CAPABILITY_CALL_LIMIT,
      CAPABILITY_BYTE_LIMIT,
      new Date(deadlineMs).toISOString(),
      CAPABILITY_OPERATION_TIMEOUT_MS,
    ],
  );
  if (capability.rows.length !== 1) deny();
  return {
    capability: mapBinding(asRecord(capability.rows[0])),
    token,
  };
}

/** @public Atomically binds one accepted adapter process to its run and capability. */
export async function activateAdapterProcess(
  lease: BrowserStateMutationLease,
  untrustedRunId: string,
  untrustedBinding: AdapterAuthorizationBinding,
  now: Date,
): Promise<AdapterCapabilityBinding> {
  const runId = parseOrDeny(runtimeUuidSchema, untrustedRunId);
  const binding = parseOrDeny(activeBindingSchema, untrustedBinding);
  const locked = await lease.transaction.query(
    `SELECT r.id, r.owner_id, r.session_id, r.request_id, r.deadline_at,
            s.owner_id AS session_owner_id,
            s.request_id AS session_request_id, s.state AS session_state,
            s.current_run_id, s.absolute_deadline_at
       FROM browser_interact_runs r
       JOIN browser_sessions s ON s.id = r.session_id
      WHERE r.id = $1
      FOR UPDATE OF r, s`,
    [runId],
  );
  if (locked.rows.length !== 1) deny();
  const lockedRow = asRecord(locked.rows[0]);
  const nowMs = now.getTime();
  if (
    lockedRow.owner_id !== lockedRow.session_owner_id ||
    lockedRow.request_id !== lockedRow.session_request_id ||
    lockedRow.session_state !== "executing" ||
    lockedRow.current_run_id !== lockedRow.id ||
    new Date(String(lockedRow.deadline_at)).getTime() <= nowMs ||
    new Date(String(lockedRow.absolute_deadline_at)).getTime() <= nowMs
  ) {
    deny();
  }
  const run = await lease.transaction.query(
    `UPDATE browser_interact_runs
        SET state = 'running',
            adapter_process_id = $4,
            started_at = COALESCE(started_at, $5)
      WHERE id = $1
        AND state = 'starting'
        AND adapter_job_id = $2
        AND adapter_supervisor_id = $3
        AND adapter_process_id IS NULL
      RETURNING id`,
    [
      runId,
      binding.adapterJobId,
      binding.adapterSupervisorId,
      binding.adapterProcessId,
      now.toISOString(),
    ],
  );
  if (run.rows.length !== 1) deny();
  const capability = await lease.transaction.query(
    `UPDATE browser_capabilities
        SET adapter_process_id = $4,
            activated_at = $5
      WHERE run_id = $1
        AND adapter_job_id = $2
        AND adapter_supervisor_id = $3
        AND adapter_process_id IS NULL
        AND activated_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > $5
        AND wall_deadline_at > $5
        AND owner_id = $6
        AND session_id = $7
      RETURNING id, owner_id, session_id, run_id, adapter_job_id,
                adapter_supervisor_id, adapter_process_id, activated_at,
                revoked_at, wall_deadline_at, per_operation_timeout_ms,
                expires_at`,
    [
      runId,
      binding.adapterJobId,
      binding.adapterSupervisorId,
      binding.adapterProcessId,
      now.toISOString(),
      lockedRow.owner_id,
      lockedRow.session_id,
    ],
  );
  if (capability.rows.length !== 1) deny();
  return mapBinding(asRecord(capability.rows[0]));
}

async function authorizeAdapter(
  lease: BrowserStateMutationLease,
  untrustedInput: AuthorizeAdapterCapabilityInput,
  now: Date,
): Promise<AdapterCapabilityBinding> {
  const input = parseOrDeny(authorizationInputSchema, untrustedInput);
  const result = await lease.transaction.query(
    `SELECT c.id, c.token_hash, c.owner_id, c.session_id, c.run_id,
            c.adapter_job_id, c.adapter_supervisor_id, c.adapter_process_id,
            c.activated_at, c.revoked_at, c.wall_deadline_at,
            c.per_operation_timeout_ms, c.expires_at,
            r.state AS run_state, r.owner_id AS run_owner_id,
            r.session_id AS run_session_id, r.adapter_job_id AS run_job_id,
            r.adapter_supervisor_id AS run_supervisor_id,
            r.adapter_process_id AS run_process_id,
            r.deadline_at AS run_deadline_at,
            s.state AS session_state, s.owner_id AS session_owner_id,
            s.current_run_id, s.absolute_deadline_at
       FROM browser_capabilities c
       JOIN browser_interact_runs r ON r.id = c.run_id
       JOIN browser_sessions s ON s.id = c.session_id
      WHERE c.run_id = $1
        AND c.revoked_at IS NULL
      FOR UPDATE OF c, r, s`,
    [input.runId],
  );
  if (result.rows.length !== 1) deny();
  const row = asRecord(result.rows[0]);
  const suppliedHash = Buffer.from(hashCapabilityToken(input.token), "hex");
  const storedHash = Buffer.from(String(row.token_hash), "hex");
  const tokenMatches =
    suppliedHash.length === storedHash.length &&
    timingSafeEqual(suppliedHash, storedHash);
  const nowMs = now.getTime();
  if (
    !tokenMatches ||
    row.owner_id !== input.ownerId ||
    row.session_id !== input.sessionId ||
    row.adapter_job_id !== input.adapterJobId ||
    row.adapter_supervisor_id !== input.adapterSupervisorId ||
    row.adapter_process_id !== input.adapterProcessId ||
    row.activated_at === null ||
    row.run_state !== "running" ||
    row.run_owner_id !== input.ownerId ||
    row.run_session_id !== input.sessionId ||
    row.run_job_id !== input.adapterJobId ||
    row.run_supervisor_id !== input.adapterSupervisorId ||
    row.run_process_id !== input.adapterProcessId ||
    row.session_state !== "executing" ||
    row.session_owner_id !== input.ownerId ||
    row.current_run_id !== input.runId ||
    new Date(String(row.wall_deadline_at)).getTime() <= nowMs ||
    new Date(String(row.expires_at)).getTime() <= nowMs ||
    new Date(String(row.run_deadline_at)).getTime() <= nowMs ||
    new Date(String(row.absolute_deadline_at)).getTime() <= nowMs
  ) {
    deny();
  }
  return mapBinding(row);
}

async function authorizePersistedBinding(
  lease: BrowserStateMutationLease,
  untrustedInput: AuthorizePersistedCapabilityInput,
  now: Date,
  consume: boolean,
): Promise<AdapterCapabilityBinding> {
  const input = parseOrDeny(persistedBindingInputSchema, untrustedInput);
  const result = await lease.transaction.query(
    `SELECT c.id, c.owner_id, c.session_id, c.run_id, c.adapter_job_id,
            c.adapter_supervisor_id, c.adapter_process_id, c.operations,
            c.call_limit, c.calls_used, c.byte_limit, c.bytes_used,
            c.activated_at, c.revoked_at, c.wall_deadline_at,
            c.per_operation_timeout_ms, c.expires_at,
            r.state AS run_state, r.owner_id AS run_owner_id,
            r.session_id AS run_session_id, r.adapter_job_id AS run_job_id,
            r.adapter_supervisor_id AS run_supervisor_id,
            r.adapter_process_id AS run_process_id,
            r.deadline_at AS run_deadline_at,
            s.state AS session_state, s.owner_id AS session_owner_id,
            s.current_run_id, s.absolute_deadline_at
       FROM browser_capabilities c
       JOIN browser_interact_runs r ON r.id = c.run_id
       JOIN browser_sessions s ON s.id = c.session_id
      WHERE c.run_id = $1
        AND c.revoked_at IS NULL
      FOR UPDATE OF c, r, s`,
    [input.runId],
  );
  if (result.rows.length !== 1) deny();
  const row = asRecord(result.rows[0]);
  const nowMs = now.getTime();
  const operations = Array.isArray(row.operations)
    ? row.operations.map(String)
    : [];
  const byteCount = input.byteCount ?? 0;
  if (
    row.owner_id !== input.ownerId ||
    row.session_id !== input.sessionId ||
    row.adapter_job_id !== input.adapterJobId ||
    row.adapter_supervisor_id !== input.adapterSupervisorId ||
    row.adapter_process_id !== input.adapterProcessId ||
    row.activated_at === null ||
    row.run_state !== "running" ||
    row.run_owner_id !== input.ownerId ||
    row.run_session_id !== input.sessionId ||
    row.run_job_id !== input.adapterJobId ||
    row.run_supervisor_id !== input.adapterSupervisorId ||
    row.run_process_id !== input.adapterProcessId ||
    row.session_state !== "executing" ||
    row.session_owner_id !== input.ownerId ||
    row.current_run_id !== input.runId ||
    (input.operation !== undefined && !operations.includes(input.operation)) ||
    new Date(String(row.wall_deadline_at)).getTime() <= nowMs ||
    new Date(String(row.expires_at)).getTime() <= nowMs ||
    new Date(String(row.run_deadline_at)).getTime() <= nowMs ||
    new Date(String(row.absolute_deadline_at)).getTime() <= nowMs ||
    (consume && Number(row.calls_used) + 1 > Number(row.call_limit)) ||
    (consume && Number(row.bytes_used) + byteCount > Number(row.byte_limit))
  ) {
    deny();
  }
  if (consume) {
    const consumed = await lease.transaction.query(
      `UPDATE browser_capabilities
          SET calls_used = calls_used + 1,
              bytes_used = bytes_used + $2,
              redeemed_at = COALESCE(redeemed_at, $3)
        WHERE id = $1
          AND calls_used + 1 <= call_limit
          AND bytes_used + $2 <= byte_limit
        RETURNING id`,
      [row.id, byteCount, now.toISOString()],
    );
    if (consumed.rows.length !== 1) deny();
  }
  return mapBinding(row);
}

async function redeemCdpBinding(
  lease: BrowserStateMutationLease,
  untrustedInput: AuthorizePersistedCapabilityInput,
  now: Date,
): Promise<AdapterCapabilityBinding> {
  const input = parseOrDeny(persistedBindingInputSchema, untrustedInput);
  const result = await lease.transaction.query(
    `SELECT c.id, c.owner_id, c.session_id, c.run_id, c.adapter_job_id,
            c.adapter_supervisor_id, c.adapter_process_id, c.activated_at,
            c.revoked_at, c.wall_deadline_at, c.per_operation_timeout_ms,
            c.expires_at, c.operations,
            r.state AS run_state, r.owner_id AS run_owner_id,
            r.session_id AS run_session_id, r.adapter_job_id AS run_job_id,
            r.adapter_supervisor_id AS run_supervisor_id,
            r.adapter_process_id AS run_process_id,
            r.deadline_at AS run_deadline_at,
            s.state AS session_state, s.owner_id AS session_owner_id,
            s.current_run_id, s.absolute_deadline_at
       FROM browser_capabilities c
       JOIN browser_interact_runs r ON r.id = c.run_id
       JOIN browser_sessions s ON s.id = c.session_id
      WHERE c.run_id = $1
        AND c.revoked_at IS NULL
      FOR UPDATE OF c, r, s`,
    [input.runId],
  );
  if (result.rows.length !== 1) deny();
  const row = asRecord(result.rows[0]);
  const nowMs = now.getTime();
  if (
    row.owner_id !== input.ownerId ||
    row.session_id !== input.sessionId ||
    row.adapter_job_id !== input.adapterJobId ||
    row.adapter_supervisor_id !== input.adapterSupervisorId ||
    row.adapter_process_id !== input.adapterProcessId ||
    row.activated_at === null ||
    row.run_state !== "running" ||
    row.run_owner_id !== input.ownerId ||
    row.run_session_id !== input.sessionId ||
    row.run_job_id !== input.adapterJobId ||
    row.run_supervisor_id !== input.adapterSupervisorId ||
    row.run_process_id !== input.adapterProcessId ||
    row.session_state !== "executing" ||
    row.session_owner_id !== input.ownerId ||
    row.current_run_id !== input.runId ||
    !Array.isArray(row.operations) ||
    !row.operations.includes("cdp") ||
    new Date(String(row.wall_deadline_at)).getTime() <= nowMs ||
    new Date(String(row.expires_at)).getTime() <= nowMs ||
    new Date(String(row.run_deadline_at)).getTime() <= nowMs ||
    new Date(String(row.absolute_deadline_at)).getTime() <= nowMs
  ) {
    deny();
  }
  const consumed = await lease.transaction.query(
    `UPDATE browser_capabilities
        SET operations = operations - 'cdp'
      WHERE id = $1
        AND operations ? 'cdp'
      RETURNING id`,
    [row.id],
  );
  if (consumed.rows.length !== 1) deny();
  return mapBinding(row);
}

/** @public */
export function createCapabilityStore(deps: { gate: BrowserStartupGate }) {
  return {
    beginAdapterRun(
      input: BeginAdapterCapabilityInput,
      now = new Date(),
    ): Promise<IssuedAdapterCapability> {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => beginAdapterRun(lease, input, now),
      );
    },

    activateAdapterProcess(
      runId: string,
      binding: AdapterAuthorizationBinding,
      now = new Date(),
    ): Promise<AdapterCapabilityBinding> {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => activateAdapterProcess(lease, runId, binding, now),
      );
    },

    authorize(
      input: AuthorizeAdapterCapabilityInput,
      now = new Date(),
    ): Promise<AdapterCapabilityBinding> {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => authorizeAdapter(lease, input, now),
      );
    },

    inspectBinding(
      input: AuthorizePersistedCapabilityInput,
      now = new Date(),
    ): Promise<AdapterCapabilityBinding> {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => authorizePersistedBinding(lease, input, now, false),
      );
    },

    inspectBindingWithLease(
      lease: BrowserStateMutationLease,
      input: AuthorizePersistedCapabilityInput,
      now = new Date(),
    ): Promise<AdapterCapabilityBinding> {
      return authorizePersistedBinding(lease, input, now, false);
    },

    redeemAction(
      input: AuthorizePersistedCapabilityInput & {
        operation: BrowserOperation["kind"];
        byteCount: number;
      },
      now = new Date(),
    ): Promise<AdapterCapabilityBinding> {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => authorizePersistedBinding(lease, input, now, true),
      );
    },

    redeemActionWithLease(
      lease: BrowserStateMutationLease,
      input: AuthorizePersistedCapabilityInput & {
        operation: BrowserOperation["kind"];
        byteCount: number;
      },
      now = new Date(),
    ): Promise<AdapterCapabilityBinding> {
      return authorizePersistedBinding(lease, input, now, true);
    },

    redeemCdpWithLease(
      lease: BrowserStateMutationLease,
      input: AuthorizePersistedCapabilityInput,
      now = new Date(),
    ): Promise<AdapterCapabilityBinding> {
      return redeemCdpBinding(lease, input, now);
    },

    revoke(runId: string, now = new Date()): Promise<boolean> {
      const parsedRunId = parseOrDeny(runtimeUuidSchema, runId);
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          const result = await lease.transaction.query(
            `UPDATE browser_capabilities
                SET revoked_at = COALESCE(revoked_at, $2)
              WHERE run_id = $1
              RETURNING id`,
            [parsedRunId, now.toISOString()],
          );
          return result.rows.length > 0;
        },
      );
    },

    expire(now = new Date()): Promise<number> {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          const result = await lease.transaction.query(
            `UPDATE browser_capabilities
                SET revoked_at = $1
              WHERE revoked_at IS NULL
                AND (
                  expires_at <= $1
                  OR wall_deadline_at <= $1
                )
              RETURNING id`,
            [now.toISOString()],
          );
          return result.rows.length;
        },
      );
    },

    interruptUnfinished(now = new Date()): Promise<number> {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          const interrupted = await lease.transaction.query(
            `UPDATE browser_interact_runs
                SET state = 'interrupted',
                    finished_at = COALESCE(finished_at, $1),
                    error_category = COALESCE(
                      error_category,
                      'adapter_restart'
                    )
              WHERE state IN ('queued', 'starting', 'running')
                AND mode IN ('prompt', 'code')
              RETURNING id`,
            [now.toISOString()],
          );
          await lease.transaction.query(
            `UPDATE browser_capabilities
                SET revoked_at = COALESCE(revoked_at, $1)
              WHERE revoked_at IS NULL
                AND run_id = ANY($2::uuid[])`,
            [now.toISOString(), interrupted.rows.map(row => asRecord(row).id)],
          );
          return interrupted.rows.length;
        },
      );
    },
  };
}
