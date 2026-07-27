import { randomUUID } from "node:crypto";

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import {
  assertBrowserSessionTransition,
  assertInteractRunTransition,
} from "./transitions";
import type {
  AcquireProfileWriterInput,
  BoundedPageState,
  BrowserActivityInput,
  BrowserInteractActionRow,
  BrowserInteractRunRow,
  BrowserOperationResultV1,
  BrowserProfileLease,
  BrowserRecoveryResult,
  BrowserSessionRow,
  BrowserSessionState,
  BrowserSessionTransitionPatch,
  CreateBrowserSessionInput,
  CreateInteractRunInput,
  InteractRunState,
  InteractRunTransitionPatch,
  ObservationV1,
  SubmitBrowserActionV1,
} from "./types";
import type {
  BrowserControlFenceTransaction,
  BrowserStateMutationLease,
} from "../browser-runtime/startup-gate";
import type {
  BrowserSessionStopClaim,
  PreparedProfileGeneration,
} from "../browser-runtime/orchestrator";
import {
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
  calculateBrowserSessionCredits,
} from "../browser-billing";
import {
  codeRunResultSchema,
  promptRunResultSchema,
  runtimeUuidSchema,
  type CodeRunResult,
  type PromptRunResult,
} from "../browser-runtime/protocol";
import {
  normalizeBrowserAction,
  submitBrowserActionV1Schema,
} from "../browser-runtime/action-normalization";
import {
  browserOperationResultSchema,
  httpUrlSchema,
} from "../scrape-interact/browser-service-contracts";

const ACTION_LIMIT = 25;
const OPERATION_LIMIT_BYTES = 32 * 1024;
const OBSERVATION_LIMIT_BYTES = 64 * 1024;

type ErrorCode =
  | "profile_locked"
  | "action_identity_mismatch"
  | "duplicate_side_effect"
  | "action_in_flight"
  | "action_outcome_unknown"
  | "action_limit_exceeded";

class BrowserStateError extends Error {
  constructor(
    name: string,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

/** @public */
export class ProfileLockedError extends BrowserStateError {
  constructor(profileId: string) {
    super(
      "ProfileLockedError",
      "profile_locked",
      `Browser profile ${profileId} already has an active writer`,
    );
  }
}

/** @public */
export class ActionIdentityMismatchError extends BrowserStateError {
  constructor() {
    super(
      "ActionIdentityMismatchError",
      "action_identity_mismatch",
      "Action identity or adapter job binding does not match stored state",
    );
  }
}

/** @public */
export class DuplicateSideEffectError extends BrowserStateError {
  constructor() {
    super(
      "DuplicateSideEffectError",
      "duplicate_side_effect",
      "A side-effecting proposal cannot be submitted twice",
    );
  }
}

/** @public */
export class ActionInFlightError extends BrowserStateError {
  constructor() {
    super(
      "ActionInFlightError",
      "action_in_flight",
      "A browser action is already in flight",
    );
  }
}

/** @public */
export class ActionOutcomeUnknownError extends BrowserStateError {
  constructor() {
    super(
      "ActionOutcomeUnknownError",
      "action_outcome_unknown",
      "Browser action outcome is unknown and cannot be retried",
    );
  }
}

/** @public */
export class ActionLimitExceededError extends BrowserStateError {
  constructor() {
    super(
      "ActionLimitExceededError",
      "action_limit_exceeded",
      `Browser action limit of ${ACTION_LIMIT} was exceeded`,
    );
  }
}

const boundedString = (maximum: number) => z.string().max(maximum);
const pageStateSchema = z.strictObject({
  url: httpUrlSchema,
  title: boundedString(4_096),
  snapshotExcerpt: boundedString(40_000),
});

const completionSchema = z
  .strictObject({
    runId: runtimeUuidSchema,
    actionId: runtimeUuidSchema,
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["succeeded", "rejected_no_effect", "failed_no_effect"]),
    result: browserOperationResultSchema.optional(),
    error: z
      .strictObject({
        category: boundedString(128),
        message: boundedString(4_096),
      })
      .optional(),
    page: pageStateSchema,
  })
  .superRefine((input, context) => {
    if (input.outcome === "succeeded") {
      if (input.result === undefined || input.error !== undefined) {
        context.addIssue({
          code: "custom",
          message: "A successful action requires only a bounded result",
        });
      }
    } else if (input.result !== undefined || input.error === undefined) {
      context.addIssue({
        code: "custom",
        message: "A no-effect action requires only a sanitized error",
      });
    }
  });

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function asSession(row: typeof schema.browser_sessions.$inferSelect) {
  return row as BrowserSessionRow;
}

function asRun(row: typeof schema.browser_interact_runs.$inferSelect) {
  return row as BrowserInteractRunRow;
}

function asAction(row: typeof schema.browser_interact_actions.$inferSelect) {
  return row as BrowserInteractActionRow;
}

function observationFromAction(
  action: BrowserInteractActionRow,
  resultPresent = action.result !== null,
): ObservationV1 {
  if (
    (action.state !== "succeeded" &&
      action.state !== "rejected_no_effect" &&
      action.state !== "failed_no_effect") ||
    action.page_state === null
  ) {
    throw new ActionOutcomeUnknownError();
  }
  const page = pageStateSchema.parse(action.page_state);
  const observation: Extract<ObservationV1, { type: "action_result" }> = {
    version: 1,
    type: "action_result",
    sequence: action.sequence,
    actionId: action.action_id,
    actionKind: action.operation.kind,
    outcome: action.state,
    page,
  };
  if (resultPresent) {
    observation.result = browserOperationResultSchema.parse(action.result);
  }
  if (action.error_category !== null && action.error_detail !== null) {
    observation.error = {
      category: action.error_category,
      message: action.error_detail,
    };
  }
  return observation;
}

/** @public */
export async function createBrowserSession(
  input: CreateBrowserSessionInput,
): Promise<BrowserSessionRow> {
  const [row] = await db
    .insert(schema.browser_sessions)
    .values({
      ...input,
      state: input.state ?? "creating",
      billing_endpoint:
        input.billing_endpoint ?? (input.scrape_id ? "interact" : "browser"),
    })
    .returning();
  return asSession(row);
}

/** @public */
export async function getBrowserSession(
  id: string,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select()
    .from(schema.browser_sessions)
    .where(eq(schema.browser_sessions.id, id))
    .limit(1);
  return row ? asSession(row) : null;
}

/** @public */
export async function getReadyBrowserSessionForScrape(
  ownerId: string,
  scrapeId: string,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select()
    .from(schema.browser_sessions)
    .where(
      and(
        eq(schema.browser_sessions.owner_id, ownerId),
        eq(schema.browser_sessions.scrape_id, scrapeId),
        eq(schema.browser_sessions.state, "ready"),
      ),
    )
    .orderBy(sql`${schema.browser_sessions.created_at} DESC`)
    .limit(1);
  return row ? asSession(row) : null;
}

/** @public */
export async function compareAndSetBrowserSessionState(
  id: string,
  from: BrowserSessionState[],
  to: BrowserSessionState,
  patch: BrowserSessionTransitionPatch = {},
): Promise<BrowserSessionRow | null> {
  if (from.length === 0) return null;
  for (const state of from) assertBrowserSessionTransition(state, to);
  const [row] = await db
    .update(schema.browser_sessions)
    .set({ ...patch, state: to, updated_at: new Date().toISOString() })
    .where(
      and(
        eq(schema.browser_sessions.id, id),
        inArray(schema.browser_sessions.state, from),
      ),
    )
    .returning();
  return row ? asSession(row) : null;
}

/** @public */
export async function touchBrowserSession(
  id: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(schema.browser_sessions)
    .set({
      last_activity_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .where(eq(schema.browser_sessions.id, id))
    .returning({ id: schema.browser_sessions.id });
  return rows.length === 1;
}

/** @public */
export async function createInteractRun(
  input: CreateInteractRunInput,
): Promise<BrowserInteractRunRow> {
  const [row] = await db
    .insert(schema.browser_interact_runs)
    .values({ ...input, state: input.state ?? "queued" })
    .returning();
  return asRun(row);
}

/** @public */
export async function compareAndSetInteractRunState(
  id: string,
  from: InteractRunState[],
  to: InteractRunState,
  patch: InteractRunTransitionPatch = {},
): Promise<BrowserInteractRunRow | null> {
  if (from.length === 0) return null;
  for (const state of from) assertInteractRunTransition(state, to);
  const [row] = await db
    .update(schema.browser_interact_runs)
    .set({ ...patch, state: to })
    .where(
      and(
        eq(schema.browser_interact_runs.id, id),
        inArray(schema.browser_interact_runs.state, from),
      ),
    )
    .returning();
  return row ? asRun(row) : null;
}

/** @public */
export type PrepareBrowserActionResult =
  | { kind: "prepared"; action: BrowserInteractActionRow }
  | { kind: "cached"; observation: ObservationV1 };

/** @public */
export interface CompleteBrowserActionInput {
  runId: string;
  actionId: string;
  proposalHash: string;
  outcome: "succeeded" | "rejected_no_effect" | "failed_no_effect";
  result?: BrowserOperationResultV1;
  error?: { category: string; message: string };
  page: BoundedPageState;
}

async function prepareBrowserAction(
  runId: string,
  untrustedRequest: SubmitBrowserActionV1,
): Promise<PrepareBrowserActionResult> {
  if (
    Number.isInteger(untrustedRequest.sequence) &&
    (untrustedRequest.sequence < 1 || untrustedRequest.sequence > ACTION_LIMIT)
  ) {
    throw new ActionLimitExceededError();
  }
  const request = submitBrowserActionV1Schema.parse(untrustedRequest);
  if (utf8Bytes(request.operation) > OPERATION_LIMIT_BYTES) {
    throw new Error("Browser operation exceeds 32 KiB");
  }
  const normalized = normalizeBrowserAction(request.operation);
  if (request.effect !== normalized.effect) {
    throw new Error("Browser operation effect does not match its operation");
  }

  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT id FROM browser_interact_runs WHERE id = ${runId} FOR UPDATE`,
    );
    const [run] = await tx
      .select()
      .from(schema.browser_interact_runs)
      .where(eq(schema.browser_interact_runs.id, runId))
      .limit(1);
    if (!run || run.state !== "running") {
      throw new Error("Browser action is not bound to an active run");
    }
    if (run.adapter_job_id !== request.adapterJobId) {
      throw new ActionIdentityMismatchError();
    }
    await tx.execute(
      sql`SELECT id FROM browser_sessions
          WHERE id = ${run.session_id} FOR UPDATE`,
    );
    const [session] = await tx
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.id, run.session_id))
      .limit(1);
    if (
      !session ||
      session.owner_id !== run.owner_id ||
      session.request_id !== run.request_id ||
      session.state !== "executing" ||
      session.current_run_id !== run.id
    ) {
      throw new Error(
        "Browser action active session/current run binding is invalid",
      );
    }

    const identities = await tx
      .select()
      .from(schema.browser_interact_actions)
      .where(
        and(
          eq(schema.browser_interact_actions.run_id, runId),
          or(
            eq(schema.browser_interact_actions.action_id, request.actionId),
            eq(schema.browser_interact_actions.sequence, request.sequence),
          ),
        ),
      );
    if (
      identities.some(
        action =>
          action.proposal_hash !== request.proposalHash ||
          action.action_id !== request.actionId ||
          action.sequence !== request.sequence ||
          action.adapter_job_id !== request.adapterJobId ||
          action.effect !== request.effect,
      )
    ) {
      throw new ActionIdentityMismatchError();
    }
    const identical = identities[0];
    if (identical) {
      const action = asAction(identical);
      if (["prepared", "executing"].includes(action.state)) {
        throw new ActionInFlightError();
      }
      if (action.state === "outcome_unknown") {
        throw new ActionOutcomeUnknownError();
      }
      const [presence] = await tx
        .select({
          resultPresent: sql<boolean>`${schema.browser_interact_actions.result} IS NOT NULL`,
        })
        .from(schema.browser_interact_actions)
        .where(eq(schema.browser_interact_actions.id, action.id))
        .limit(1);
      return {
        kind: "cached",
        observation: observationFromAction(
          action,
          presence?.resultPresent ?? false,
        ),
      };
    }

    if (normalized.normalizedProposalHash !== request.proposalHash) {
      throw new Error("Browser action proposal hash is invalid");
    }
    const [boundAction] = await tx
      .select({ adapterJobId: schema.browser_interact_actions.adapter_job_id })
      .from(schema.browser_interact_actions)
      .where(eq(schema.browser_interact_actions.run_id, runId))
      .limit(1);
    if (boundAction && boundAction.adapterJobId !== request.adapterJobId) {
      throw new Error("Browser action adapter job binding is invalid");
    }
    const [inFlight] = await tx
      .select({ id: schema.browser_interact_actions.id })
      .from(schema.browser_interact_actions)
      .where(
        and(
          eq(schema.browser_interact_actions.run_id, runId),
          inArray(schema.browser_interact_actions.state, [
            "prepared",
            "executing",
          ]),
        ),
      )
      .limit(1);
    if (inFlight) throw new ActionInFlightError();
    const [count] = await tx
      .select({
        value: sql<number>`count(*)::int`,
        maximumSequence: sql<number>`coalesce(max(${schema.browser_interact_actions.sequence}), 0)::int`,
      })
      .from(schema.browser_interact_actions)
      .where(eq(schema.browser_interact_actions.run_id, runId));
    if ((count?.value ?? 0) >= ACTION_LIMIT) {
      throw new ActionLimitExceededError();
    }
    if (request.sequence !== (count?.maximumSequence ?? 0) + 1) {
      throw new Error("Browser action sequence is not monotonic");
    }
    if (request.effect === "side_effecting") {
      const [duplicate] = await tx
        .select({ id: schema.browser_interact_actions.id })
        .from(schema.browser_interact_actions)
        .where(
          and(
            eq(schema.browser_interact_actions.run_id, runId),
            eq(
              schema.browser_interact_actions.proposal_hash,
              request.proposalHash,
            ),
            eq(schema.browser_interact_actions.effect, "side_effecting"),
          ),
        )
        .limit(1);
      if (duplicate) throw new DuplicateSideEffectError();
    }

    const [inserted] = await tx
      .insert(schema.browser_interact_actions)
      .values({
        id: randomUUID(),
        request_id: run.request_id,
        owner_id: run.owner_id,
        run_id: run.id,
        session_id: run.session_id,
        adapter_job_id: request.adapterJobId,
        action_id: request.actionId,
        sequence: request.sequence,
        proposal_hash: request.proposalHash,
        effect: request.effect,
        operation: request.operation,
        state: "prepared",
      })
      .returning();
    return { kind: "prepared", action: asAction(inserted) };
  });
}

async function markBrowserActionExecuting(
  runId: string,
  actionId: string,
): Promise<BrowserInteractActionRow> {
  return db.transaction(async tx => {
    const now = new Date().toISOString();
    const [updated] = await tx
      .update(schema.browser_interact_actions)
      .set({ state: "executing", executing_at: now, updated_at: now })
      .where(
        and(
          eq(schema.browser_interact_actions.run_id, runId),
          eq(schema.browser_interact_actions.action_id, actionId),
          eq(schema.browser_interact_actions.state, "prepared"),
        ),
      )
      .returning();
    if (updated) return asAction(updated);
    const [existing] = await tx
      .select()
      .from(schema.browser_interact_actions)
      .where(
        and(
          eq(schema.browser_interact_actions.run_id, runId),
          eq(schema.browser_interact_actions.action_id, actionId),
        ),
      )
      .limit(1);
    if (existing?.state === "outcome_unknown") {
      throw new ActionOutcomeUnknownError();
    }
    if (existing) throw new ActionInFlightError();
    throw new Error("Browser action was not found");
  });
}

async function completeBrowserAction(
  untrustedInput: CompleteBrowserActionInput,
): Promise<ObservationV1> {
  const input = completionSchema.parse(untrustedInput);
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT id FROM browser_interact_actions
          WHERE run_id = ${input.runId} AND action_id = ${input.actionId}
          FOR UPDATE`,
    );
    const [stored] = await tx
      .select()
      .from(schema.browser_interact_actions)
      .where(
        and(
          eq(schema.browser_interact_actions.run_id, input.runId),
          eq(schema.browser_interact_actions.action_id, input.actionId),
        ),
      )
      .limit(1);
    if (!stored) throw new Error("Browser action was not found");
    const action = asAction(stored);
    if (action.proposal_hash !== input.proposalHash) {
      throw new ActionIdentityMismatchError();
    }
    if (
      ["succeeded", "rejected_no_effect", "failed_no_effect"].includes(
        action.state,
      )
    ) {
      if (action.state !== input.outcome) {
        throw new ActionIdentityMismatchError();
      }
      const [presence] = await tx
        .select({
          resultPresent: sql<boolean>`${schema.browser_interact_actions.result} IS NOT NULL`,
        })
        .from(schema.browser_interact_actions)
        .where(eq(schema.browser_interact_actions.id, action.id))
        .limit(1);
      return observationFromAction(action, presence?.resultPresent ?? false);
    }
    if (action.state === "outcome_unknown") {
      throw new ActionOutcomeUnknownError();
    }
    const validSource =
      (input.outcome === "rejected_no_effect" && action.state === "prepared") ||
      (input.outcome !== "rejected_no_effect" && action.state === "executing");
    if (!validSource) throw new ActionInFlightError();

    const observation: ObservationV1 = {
      version: 1,
      type: "action_result",
      sequence: action.sequence,
      actionId: action.action_id,
      actionKind: action.operation.kind,
      outcome: input.outcome,
      page: input.page,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error === undefined ? {} : { error: input.error }),
    };
    if (utf8Bytes(observation) > OBSERVATION_LIMIT_BYTES) {
      throw new Error("Browser action observation exceeds 64 KiB");
    }
    const now = new Date().toISOString();
    const [updated] = await tx
      .update(schema.browser_interact_actions)
      .set({
        state: input.outcome,
        result:
          input.result === undefined
            ? null
            : input.result === null
              ? sql`'null'::jsonb`
              : input.result,
        page_state: input.page,
        error_category: input.error?.category ?? null,
        error_detail: input.error?.message ?? null,
        finished_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(schema.browser_interact_actions.id, action.id),
          eq(schema.browser_interact_actions.state, action.state),
        ),
      )
      .returning();
    if (!updated) throw new ActionInFlightError();
    return observation;
  });
}

/** @public */
export async function getBrowserActionByIdentity(
  runId: string,
  actionId: string,
  sequence: number,
): Promise<BrowserInteractActionRow | null> {
  const [row] = await db
    .select()
    .from(schema.browser_interact_actions)
    .where(
      and(
        eq(schema.browser_interact_actions.run_id, runId),
        eq(schema.browser_interact_actions.action_id, actionId),
        eq(schema.browser_interact_actions.sequence, sequence),
      ),
    )
    .limit(1);
  return row ? asAction(row) : null;
}

/** @public Durable authority resolved before accepting an adapter callback. */
export type ActiveBrowserRunAuthority = {
  runId: string;
  ownerId: string;
  sessionId: string;
  runtimeSessionId: string;
  expectedSessionVersion: number;
  adapterJobId: string;
  adapterSupervisorId: string;
  adapterProcessId: number;
  deadline: Date;
  perOperationTimeoutMs: number;
  allowedDomains?: readonly string[];
  zeroDataRetention: false;
};

/** @public */
export async function getActiveBrowserRunAuthority(
  runId: string,
): Promise<ActiveBrowserRunAuthority | null> {
  const parsedRunId = runtimeUuidSchema.safeParse(runId);
  if (!parsedRunId.success) return null;
  const [row] = await db
    .select({
      runId: schema.browser_interact_runs.id,
      ownerId: schema.browser_interact_runs.owner_id,
      sessionId: schema.browser_interact_runs.session_id,
      runtimeSessionId: schema.browser_sessions.browser_id,
      expectedSessionVersion: schema.browser_sessions.runtime_epoch,
      adapterJobId: schema.browser_interact_runs.adapter_job_id,
      adapterSupervisorId: schema.browser_interact_runs.adapter_supervisor_id,
      adapterProcessId: schema.browser_interact_runs.adapter_process_id,
      deadline: schema.browser_interact_runs.deadline_at,
      runState: schema.browser_interact_runs.state,
      sessionState: schema.browser_sessions.state,
      currentRunId: schema.browser_sessions.current_run_id,
      sessionOwnerId: schema.browser_sessions.owner_id,
      absoluteDeadline: schema.browser_sessions.absolute_deadline_at,
      allowedDomains: schema.browser_sessions.workspace_id,
      perOperationTimeoutMs:
        schema.browser_capabilities.per_operation_timeout_ms,
      capabilityActivatedAt: schema.browser_capabilities.activated_at,
      capabilityRevokedAt: schema.browser_capabilities.revoked_at,
      capabilityExpiresAt: schema.browser_capabilities.expires_at,
      capabilityWallDeadlineAt: schema.browser_capabilities.wall_deadline_at,
      requestTargetHint: schema.requests.target_hint,
    })
    .from(schema.browser_interact_runs)
    .innerJoin(
      schema.browser_sessions,
      eq(schema.browser_sessions.id, schema.browser_interact_runs.session_id),
    )
    .innerJoin(
      schema.browser_capabilities,
      and(
        eq(schema.browser_capabilities.run_id, schema.browser_interact_runs.id),
        eq(
          schema.browser_capabilities.owner_id,
          schema.browser_interact_runs.owner_id,
        ),
        eq(
          schema.browser_capabilities.session_id,
          schema.browser_interact_runs.session_id,
        ),
      ),
    )
    .innerJoin(
      schema.requests,
      and(
        eq(schema.requests.id, schema.browser_interact_runs.request_id),
        eq(schema.requests.team_id, schema.browser_interact_runs.owner_id),
      ),
    )
    .where(eq(schema.browser_interact_runs.id, parsedRunId.data))
    .limit(1);
  if (
    !row ||
    row.runState !== "running" ||
    row.sessionState !== "executing" ||
    row.currentRunId !== row.runId ||
    row.ownerId !== row.sessionOwnerId ||
    row.runtimeSessionId === null ||
    row.adapterJobId === null ||
    row.adapterSupervisorId === null ||
    row.adapterProcessId === null ||
    row.capabilityActivatedAt === null ||
    row.capabilityRevokedAt !== null ||
    row.requestTargetHint === "<redacted due to zero data retention>" ||
    new Date(row.deadline).getTime() <= Date.now() ||
    new Date(row.absoluteDeadline).getTime() <= Date.now() ||
    new Date(row.capabilityExpiresAt).getTime() <= Date.now() ||
    new Date(row.capabilityWallDeadlineAt).getTime() <= Date.now()
  ) {
    return null;
  }
  return {
    runId: row.runId,
    ownerId: row.ownerId,
    sessionId: row.sessionId,
    runtimeSessionId: row.runtimeSessionId,
    expectedSessionVersion: row.expectedSessionVersion,
    adapterJobId: row.adapterJobId,
    adapterSupervisorId: row.adapterSupervisorId,
    adapterProcessId: row.adapterProcessId,
    deadline: new Date(row.deadline),
    perOperationTimeoutMs: row.perOperationTimeoutMs,
    allowedDomains: Object.freeze(
      (() => {
        try {
          const parsed = JSON.parse(row.allowedDomains ?? "[]");
          return Array.isArray(parsed) &&
            parsed.length <= 8 &&
            parsed.every(value => typeof value === "string")
            ? [...parsed].sort()
            : [];
        } catch {
          return [];
        }
      })(),
    ),
    // Request logging persists this exact redaction sentinel for ZDR. Reject
    // it above before returning the narrow non-ZDR proof consumed before
    // artifact bytes are read.
    zeroDataRetention: false,
  };
}

/** @public Finds prior side effects while holding the caller's fence lease. */
export async function findSideEffectingActionByHash(
  lease: BrowserStateMutationLease,
  runId: string,
  normalizedProposalHash: string,
): Promise<BrowserInteractActionRow | null> {
  const parsedRunId = runtimeUuidSchema.parse(runId);
  const hash = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(normalizedProposalHash);
  const result = await lease.transaction.query(
    `SELECT *
       FROM browser_interact_actions
      WHERE run_id = $1
        AND proposal_hash = $2
        AND effect = 'side_effecting'
      LIMIT 1`,
    [parsedRunId, hash],
  );
  return result.rows[0] ? (result.rows[0] as BrowserInteractActionRow) : null;
}

/** @public Atomically makes an ambiguous action and its authority terminal. */
export async function markBrowserActionOutcomeUnknown(
  lease: BrowserStateMutationLease,
  runId: string,
  actionId: string,
  now = new Date(),
): Promise<void> {
  const parsedRunId = runtimeUuidSchema.parse(runId);
  const parsedActionId = runtimeUuidSchema.parse(actionId);
  const timestamp = now.toISOString();
  const action = await lease.transaction.query<{ session_id: string }>(
    `UPDATE browser_interact_actions
        SET state = 'outcome_unknown',
            result = NULL,
            page_state = NULL,
            error_category = 'action_outcome_unknown',
            error_detail = 'Browser action outcome could not be proven',
            finished_at = $3,
            updated_at = $3
      WHERE run_id = $1
        AND action_id = $2
        AND state IN ('prepared', 'executing')
      RETURNING session_id`,
    [parsedRunId, parsedActionId, timestamp],
  );
  if (action.rows.length !== 1) {
    const existing = await lease.transaction.query<{ state: string }>(
      `SELECT state
         FROM browser_interact_actions
        WHERE run_id = $1 AND action_id = $2`,
      [parsedRunId, parsedActionId],
    );
    if (existing.rows[0]?.state === "outcome_unknown") return;
    throw new ActionOutcomeUnknownError();
  }
  await lease.transaction.query(
    `UPDATE browser_interact_runs
        SET state = 'failed',
            error_category = 'action_outcome_unknown',
            error_detail = 'Browser action outcome could not be proven',
            finished_at = $2
      WHERE id = $1 AND state IN ('starting', 'running')`,
    [parsedRunId, timestamp],
  );
  await lease.transaction.query(
    `UPDATE browser_sessions
        SET state = 'error',
            status = 'error',
            terminal_at = $2,
            terminal_reason = 'action_outcome_unknown',
            updated_at = $2
      WHERE id = $1 AND state = 'executing'`,
    [action.rows[0]!.session_id, timestamp],
  );
  await lease.transaction.query(
    `UPDATE browser_capabilities
        SET revoked_at = COALESCE(revoked_at, $2)
      WHERE run_id = $1`,
    [parsedRunId, timestamp],
  );
}

/** @public Records a cancellation only while dispatch is durably impossible. */
export async function cancelPreparedBrowserAction(
  lease: BrowserStateMutationLease,
  runId: string,
  actionId: string,
  now = new Date(),
): Promise<void> {
  const result = await lease.transaction.query(
    `UPDATE browser_interact_actions
        SET state = 'cancelled_no_effect',
            result = NULL,
            error_category = 'cancelled',
            error_detail = 'Browser action was cancelled before dispatch',
            finished_at = $3,
            updated_at = $3
      WHERE run_id = $1
        AND action_id = $2
        AND state = 'prepared'
      RETURNING id`,
    [
      runtimeUuidSchema.parse(runId),
      runtimeUuidSchema.parse(actionId),
      now.toISOString(),
    ],
  );
  if (result.rows.length !== 1) throw new ActionInFlightError();
}

type CompleteBrowserActionWithLeaseInput = CompleteBrowserActionInput & {
  expectedSessionVersion: number;
  sessionVersion: number;
};

function parsePreparedActionRequest(untrustedRequest: SubmitBrowserActionV1): {
  request: SubmitBrowserActionV1;
  normalizedProposalHash: string;
} {
  if (
    Number.isInteger(untrustedRequest.sequence) &&
    (untrustedRequest.sequence < 1 || untrustedRequest.sequence > ACTION_LIMIT)
  ) {
    throw new ActionLimitExceededError();
  }
  const request = submitBrowserActionV1Schema.parse(untrustedRequest);
  if (utf8Bytes(request.operation) > OPERATION_LIMIT_BYTES) {
    throw new Error("Browser operation exceeds 32 KiB");
  }
  const normalized = normalizeBrowserAction(request.operation);
  if (
    request.effect !== normalized.effect ||
    request.proposalHash !== normalized.normalizedProposalHash
  ) {
    throw new ActionIdentityMismatchError();
  }
  return {
    request,
    normalizedProposalHash: normalized.normalizedProposalHash,
  };
}

async function prepareBrowserActionWithLease(
  lease: BrowserStateMutationLease,
  runId: string,
  untrustedRequest: SubmitBrowserActionV1,
): Promise<PrepareBrowserActionResult> {
  const parsedRunId = runtimeUuidSchema.parse(runId);
  const { request, normalizedProposalHash } =
    parsePreparedActionRequest(untrustedRequest);
  const locked = await lease.transaction.query(
    `SELECT r.*, s.owner_id AS session_owner_id,
            s.request_id AS session_request_id,
            s.state AS session_state, s.current_run_id
       FROM browser_interact_runs r
       JOIN browser_sessions s ON s.id = r.session_id
      WHERE r.id = $1
      FOR UPDATE OF r, s`,
    [parsedRunId],
  );
  if (locked.rows.length !== 1) {
    throw new Error("Browser action is not bound to an active run");
  }
  const run = locked.rows[0] as Record<string, unknown>;
  if (
    run.state !== "running" ||
    run.adapter_job_id !== request.adapterJobId ||
    run.owner_id !== run.session_owner_id ||
    run.request_id !== run.session_request_id ||
    run.session_state !== "executing" ||
    run.current_run_id !== run.id
  ) {
    if (run.adapter_job_id !== request.adapterJobId) {
      throw new ActionIdentityMismatchError();
    }
    throw new Error("Browser action active run binding is invalid");
  }

  const identities = await lease.transaction.query(
    `SELECT *, result IS NOT NULL AS result_present
       FROM browser_interact_actions
      WHERE run_id = $1
        AND (action_id = $2 OR sequence = $3)
      ORDER BY id`,
    [parsedRunId, request.actionId, request.sequence],
  );
  const mismatched = identities.rows.some(row => {
    const action = row as Record<string, unknown>;
    return (
      action.proposal_hash !== request.proposalHash ||
      action.action_id !== request.actionId ||
      Number(action.sequence) !== request.sequence ||
      action.adapter_job_id !== request.adapterJobId ||
      action.effect !== request.effect
    );
  });
  if (mismatched) throw new ActionIdentityMismatchError();
  const identical = identities.rows[0] as
    | (Record<string, unknown> & { result_present?: boolean })
    | undefined;
  if (identical) {
    const action = asAction(identical as never);
    if (["prepared", "executing"].includes(action.state)) {
      throw new ActionInFlightError();
    }
    if (action.state === "outcome_unknown") {
      throw new ActionOutcomeUnknownError();
    }
    return {
      kind: "cached",
      observation: observationFromAction(
        action,
        Boolean(identical.result_present),
      ),
    };
  }

  const policy = await lease.transaction.query<{
    count: number;
    maximum_sequence: number;
    in_flight: boolean;
    duplicate_side_effect: boolean;
    bound_job_id: string | null;
  }>(
    `SELECT count(*)::int AS count,
            coalesce(max(sequence), 0)::int AS maximum_sequence,
            bool_or(state IN ('prepared', 'executing')) AS in_flight,
            bool_or(
              effect = 'side_effecting' AND proposal_hash = $2
            ) AS duplicate_side_effect,
            min(adapter_job_id::text) AS bound_job_id
       FROM browser_interact_actions
      WHERE run_id = $1`,
    [parsedRunId, normalizedProposalHash],
  );
  const state = policy.rows[0]!;
  if (
    state.bound_job_id !== null &&
    state.bound_job_id !== request.adapterJobId
  ) {
    throw new ActionIdentityMismatchError();
  }
  if (state.in_flight) throw new ActionInFlightError();
  if (Number(state.count) >= ACTION_LIMIT) throw new ActionLimitExceededError();
  if (request.sequence !== Number(state.maximum_sequence) + 1) {
    throw new ActionIdentityMismatchError();
  }
  if (request.effect === "side_effecting" && state.duplicate_side_effect) {
    throw new DuplicateSideEffectError();
  }

  const inserted = await lease.transaction.query(
    `INSERT INTO browser_interact_actions (
       id, request_id, owner_id, run_id, session_id, adapter_job_id,
       action_id, sequence, proposal_hash, effect, operation, state
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'prepared'
     )
     RETURNING *`,
    [
      randomUUID(),
      run.request_id,
      run.owner_id,
      parsedRunId,
      run.session_id,
      request.adapterJobId,
      request.actionId,
      request.sequence,
      request.proposalHash,
      request.effect,
      JSON.stringify(request.operation),
    ],
  );
  if (inserted.rows.length !== 1) {
    throw new Error("Browser action preparation failed");
  }
  return { kind: "prepared", action: asAction(inserted.rows[0] as never) };
}

async function markBrowserActionExecutingWithLease(
  lease: BrowserStateMutationLease,
  runId: string,
  actionId: string,
): Promise<BrowserInteractActionRow> {
  const result = await lease.transaction.query(
    `UPDATE browser_interact_actions
        SET state = 'executing', executing_at = now(), updated_at = now()
      WHERE run_id = $1 AND action_id = $2 AND state = 'prepared'
      RETURNING *`,
    [runtimeUuidSchema.parse(runId), runtimeUuidSchema.parse(actionId)],
  );
  if (result.rows.length === 1) return asAction(result.rows[0] as never);
  const existing = await lease.transaction.query<{ state: string }>(
    `SELECT state FROM browser_interact_actions
      WHERE run_id = $1 AND action_id = $2`,
    [runId, actionId],
  );
  if (existing.rows[0]?.state === "outcome_unknown") {
    throw new ActionOutcomeUnknownError();
  }
  if (existing.rows.length > 0) throw new ActionInFlightError();
  throw new Error("Browser action was not found");
}

async function completeBrowserActionWithLease(
  lease: BrowserStateMutationLease,
  untrustedInput: CompleteBrowserActionWithLeaseInput,
): Promise<ObservationV1> {
  const {
    expectedSessionVersion: rawExpectedSessionVersion,
    sessionVersion: rawSessionVersion,
    ...completion
  } = untrustedInput;
  const input = completionSchema.parse(completion);
  const expectedSessionVersion = z
    .number()
    .int()
    .safe()
    .min(0)
    .parse(rawExpectedSessionVersion);
  const sessionVersion = z
    .number()
    .int()
    .safe()
    .min(0)
    .parse(rawSessionVersion);
  const requiredVersion =
    input.outcome === "succeeded"
      ? expectedSessionVersion + 1
      : expectedSessionVersion;
  if (
    !Number.isSafeInteger(requiredVersion) ||
    sessionVersion !== requiredVersion
  ) {
    throw new ActionIdentityMismatchError();
  }

  const locked = await lease.transaction.query(
    `SELECT a.*, a.result IS NOT NULL AS result_present,
            s.runtime_epoch AS persisted_session_version,
            s.state AS session_state, s.current_run_id
       FROM browser_interact_actions a
       JOIN browser_sessions s ON s.id = a.session_id
      WHERE a.run_id = $1 AND a.action_id = $2
      FOR UPDATE OF a, s`,
    [input.runId, input.actionId],
  );
  if (locked.rows.length !== 1) throw new Error("Browser action was not found");
  const row = locked.rows[0] as Record<string, unknown> & {
    result_present?: boolean;
  };
  const action = asAction(row as never);
  if (
    action.proposal_hash !== input.proposalHash ||
    Number(row.persisted_session_version) !== expectedSessionVersion ||
    row.session_state !== "executing" ||
    row.current_run_id !== input.runId
  ) {
    throw new ActionIdentityMismatchError();
  }
  if (
    ["succeeded", "rejected_no_effect", "failed_no_effect"].includes(
      action.state,
    )
  ) {
    if (action.state !== input.outcome) throw new ActionIdentityMismatchError();
    return observationFromAction(action, Boolean(row.result_present));
  }
  if (action.state === "outcome_unknown") throw new ActionOutcomeUnknownError();
  const validSource =
    (input.outcome === "rejected_no_effect" && action.state === "prepared") ||
    (input.outcome !== "rejected_no_effect" && action.state === "executing");
  if (!validSource) throw new ActionInFlightError();

  const observation: ObservationV1 = {
    version: 1,
    type: "action_result",
    sequence: action.sequence,
    actionId: action.action_id,
    actionKind: action.operation.kind,
    outcome: input.outcome,
    page: input.page,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
  if (utf8Bytes(observation) > OBSERVATION_LIMIT_BYTES) {
    throw new Error("Browser action observation exceeds 64 KiB");
  }
  if (input.outcome === "succeeded") {
    const advanced = await lease.transaction.query(
      `UPDATE browser_sessions
          SET runtime_epoch = $3, updated_at = now()
        WHERE id = $1
          AND runtime_epoch = $2
          AND state = 'executing'
          AND current_run_id = $4
        RETURNING id`,
      [action.session_id, expectedSessionVersion, sessionVersion, input.runId],
    );
    if (advanced.rows.length !== 1) throw new ActionIdentityMismatchError();
  }
  const updated = await lease.transaction.query(
    `UPDATE browser_interact_actions
        SET state = $3,
            result = $4::jsonb,
            page_state = $5::jsonb,
            error_category = $6,
            error_detail = $7,
            finished_at = now(),
            updated_at = now()
      WHERE run_id = $1 AND action_id = $2 AND state = $8
      RETURNING id`,
    [
      input.runId,
      input.actionId,
      input.outcome,
      input.result === undefined ? null : JSON.stringify(input.result),
      JSON.stringify(input.page),
      input.error?.category ?? null,
      input.error?.message ?? null,
      action.state,
    ],
  );
  if (updated.rows.length !== 1) throw new ActionInFlightError();
  return observation;
}

/** @public Gate-owning action persistence facade used by the coordinator. */
export function createBrowserActionStore(deps: {
  gate: import("../browser-runtime/startup-gate").BrowserStartupGate;
}) {
  return {
    prepare(runId: string, request: SubmitBrowserActionV1) {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => prepareBrowserActionWithLease(lease, runId, request),
      );
    },
    prepareWithLease(
      lease: BrowserStateMutationLease,
      runId: string,
      request: SubmitBrowserActionV1,
    ) {
      return prepareBrowserActionWithLease(lease, runId, request);
    },
    markExecuting(runId: string, actionId: string) {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => markBrowserActionExecutingWithLease(lease, runId, actionId),
      );
    },
    markExecutingWithLease(
      lease: BrowserStateMutationLease,
      runId: string,
      actionId: string,
    ) {
      return markBrowserActionExecutingWithLease(lease, runId, actionId);
    },
    complete(input: CompleteBrowserActionWithLeaseInput) {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => completeBrowserActionWithLease(lease, input),
      );
    },
    completeWithLease(
      lease: BrowserStateMutationLease,
      input: CompleteBrowserActionWithLeaseInput,
    ) {
      return completeBrowserActionWithLease(lease, input);
    },
    getByIdentity: getBrowserActionByIdentity,
    getAuthority: getActiveBrowserRunAuthority,
    markOutcomeUnknown(runId: string, actionId: string) {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => markBrowserActionOutcomeUnknown(lease, runId, actionId),
      );
    },
    markOutcomeUnknownWithLease(
      lease: BrowserStateMutationLease,
      runId: string,
      actionId: string,
    ) {
      return markBrowserActionOutcomeUnknown(lease, runId, actionId);
    },
    cancelPrepared(runId: string, actionId: string) {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => cancelPreparedBrowserAction(lease, runId, actionId),
      );
    },
    cancelPreparedWithLease(
      lease: BrowserStateMutationLease,
      runId: string,
      actionId: string,
    ) {
      return cancelPreparedBrowserAction(lease, runId, actionId);
    },
  };
}

/** @public */
export async function markSessionPromptUsed(id: string): Promise<void> {
  await db
    .update(schema.browser_sessions)
    .set({ prompt_used: true, updated_at: new Date().toISOString() })
    .where(eq(schema.browser_sessions.id, id));
}

/** @public */
export async function didSessionUsePrompt(id: string): Promise<boolean> {
  const [row] = await db
    .select({ promptUsed: schema.browser_sessions.prompt_used })
    .from(schema.browser_sessions)
    .where(eq(schema.browser_sessions.id, id))
    .limit(1);
  return row?.promptUsed ?? false;
}

const adapterFailureCategorySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_]+$/);

function sanitizedAdapterFailure(error: unknown): {
  category: string;
  detail: string;
  state: "failed" | "cancelled" | "timed_out";
} {
  const candidate =
    error !== null && typeof error === "object" && "category" in error
      ? adapterFailureCategorySchema.safeParse(error.category)
      : null;
  const category = candidate?.success ? candidate.data : "adapter_failed";
  return {
    category,
    detail: "Browser adapter execution failed",
    state:
      category === "cancelled"
        ? "cancelled"
        : category === "timed_out"
          ? "timed_out"
          : "failed",
  };
}

async function lockAdapterRun(
  lease: BrowserStateMutationLease,
  runId: string,
): Promise<Record<string, unknown>> {
  const result = await lease.transaction.query(
    `SELECT r.id, r.mode, r.state, r.session_id, r.adapter_job_id,
            r.adapter_supervisor_id, r.adapter_process_id,
            s.state AS session_state, s.current_run_id
       FROM browser_interact_runs r
       JOIN browser_sessions s ON s.id = r.session_id
      WHERE r.id = $1
      FOR UPDATE OF r, s`,
    [runtimeUuidSchema.parse(runId)],
  );
  if (result.rows.length !== 1) {
    throw new Error("Browser adapter run does not exist");
  }
  return result.rows[0] as Record<string, unknown>;
}

/** @public Counts the exact durable action ledger under a mutation lease. */
export async function countInteractActions(
  lease: BrowserStateMutationLease,
  runId: string,
): Promise<number> {
  const result = await lease.transaction.query(
    `SELECT count(*)::int AS count
       FROM browser_interact_actions
      WHERE run_id = $1`,
    [runtimeUuidSchema.parse(runId)],
  );
  return Number((result.rows[0] as { count: number }).count);
}

/** @public Persists a validated adapter result and releases the ready session. */
export async function finishAdapterRun(
  lease: BrowserStateMutationLease,
  runId: string,
  untrustedResult: PromptRunResult | CodeRunResult,
): Promise<void> {
  const row = await lockAdapterRun(lease, runId);
  if (
    !["prompt", "code"].includes(String(row.mode)) ||
    row.state !== "running" ||
    row.adapter_job_id === null ||
    row.adapter_supervisor_id === null ||
    row.adapter_process_id === null ||
    row.session_state !== "executing" ||
    row.current_run_id !== row.id
  ) {
    throw new Error("Browser adapter run is not active");
  }

  let outputReference: Record<string, unknown>;
  if (row.mode === "prompt") {
    const result = promptRunResultSchema.parse(untrustedResult);
    const actionCount = await countInteractActions(lease, runId);
    if (result.actionCount !== actionCount) {
      throw Object.assign(new Error("Adapter action count mismatch"), {
        category: "model_protocol_error",
      });
    }
    outputReference = { version: 1, mode: "prompt", ...result };
  } else {
    const result = codeRunResultSchema.parse(untrustedResult);
    outputReference = { version: 1, mode: "code", ...result };
  }

  const run = await lease.transaction.query(
    `UPDATE browser_interact_runs
        SET state = 'succeeded',
            output_reference = $2::jsonb,
            error_category = NULL,
            error_detail = NULL,
            finished_at = now()
      WHERE id = $1
        AND state = 'running'
      RETURNING id`,
    [runtimeUuidSchema.parse(runId), JSON.stringify(outputReference)],
  );
  if (run.rows.length !== 1) {
    throw new Error("Browser adapter run completion lost ownership");
  }
  const session = await lease.transaction.query(
    `UPDATE browser_sessions
        SET state = 'ready',
            current_run_id = NULL,
            last_activity_at = now(),
            idle_deadline_at = least(
              absolute_deadline_at,
              now() + make_interval(secs => ttl_without_activity)
            ),
            updated_at = now()
      WHERE id = $1
        AND state = 'executing'
        AND current_run_id = $2
      RETURNING id`,
    [row.session_id, row.id],
  );
  if (session.rows.length !== 1) {
    throw new Error("Browser adapter session completion lost ownership");
  }
}

/** @public Persists a sanitized adapter failure and releases its session. */
export async function failAdapterRun(
  lease: BrowserStateMutationLease,
  runId: string,
  error: unknown,
): Promise<void> {
  const row = await lockAdapterRun(lease, runId);
  if (
    !["prompt", "code"].includes(String(row.mode)) ||
    !["starting", "running"].includes(String(row.state)) ||
    row.adapter_job_id === null ||
    row.adapter_supervisor_id === null
  ) {
    if (
      ["failed", "cancelled", "timed_out", "interrupted"].includes(
        String(row.state),
      )
    ) {
      return;
    }
    throw new Error("Browser adapter run is not fail-able");
  }
  const failure = sanitizedAdapterFailure(error);
  const run = await lease.transaction.query(
    `UPDATE browser_interact_runs
        SET state = $2,
            cancelled_at = CASE
              WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, now())
              ELSE cancelled_at
            END,
            error_category = $3,
            error_detail = $4,
            output_reference = NULL,
            finished_at = COALESCE(finished_at, now())
      WHERE id = $1
        AND state IN ('starting', 'running')
      RETURNING id`,
    [
      runtimeUuidSchema.parse(runId),
      failure.state,
      failure.category,
      failure.detail,
    ],
  );
  if (run.rows.length !== 1) {
    throw new Error("Browser adapter run failure lost ownership");
  }
  await lease.transaction.query(
    `UPDATE browser_sessions
        SET state = 'ready',
            current_run_id = NULL,
            last_activity_at = now(),
            idle_deadline_at = least(
              absolute_deadline_at,
              now() + make_interval(secs => ttl_without_activity)
            ),
            updated_at = now()
      WHERE id = $1
        AND state = 'executing'
        AND current_run_id = $2`,
    [row.session_id, row.id],
  );
}

/** @public Claims the sole durable cleanup ownership for one session stop. */
export async function claimBrowserSessionStop(
  lease: BrowserStateMutationLease,
  sessionId: string,
  reason: string,
  ownerId?: string,
): Promise<BrowserSessionStopClaim | null> {
  const parsedSessionId = runtimeUuidSchema.parse(sessionId);
  const terminalReason = z.string().min(1).max(128).parse(reason);
  const stopAttemptId = randomUUID();
  const stopLeaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
  const result = await lease.transaction.query(
    `UPDATE browser_sessions
        SET state = 'stopping',
            terminal_reason = $2,
            stop_attempt_id = $4,
            stop_lease_expires_at = $5,
            stop_owner_instance_id = $6,
            stop_owner_generation_nonce = $7,
            updated_at = now()
      WHERE id = $1
        AND ($3::uuid IS NULL OR owner_id = $3::uuid)
        AND (
          state IN ('creating', 'replaying', 'ready', 'executing')
          OR (
            state = 'stopping'
            AND stop_lease_expires_at <= now()
          )
        )
      RETURNING current_run_id, profile_id, browser_id, runtime_epoch,
        profile_id IS NOT NULL AND EXISTS (
          SELECT 1
            FROM browser_profiles
           WHERE id = browser_sessions.profile_id
             AND writer_session_id = browser_sessions.id
        ) AS requires_prepared_profile`,
    [
      parsedSessionId,
      terminalReason,
      ownerId ?? null,
      stopAttemptId,
      stopLeaseExpiresAt,
      lease.binding.apiInstanceId,
      lease.binding.controlGenerationNonce,
    ],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0] as {
    current_run_id: string | null;
    profile_id: string | null;
    browser_id: string | null;
    runtime_epoch: number;
    requires_prepared_profile: boolean;
  };
  return {
    stopAttemptId,
    runId: row.current_run_id,
    profileId: row.profile_id,
    requiresPreparedProfile: row.requires_prepared_profile,
    browserId: row.browser_id,
    runtimeEpoch: row.runtime_epoch,
  };
}

/** @public Renews stop ownership while external cleanup remains in flight. */
export async function renewBrowserSessionStop(
  lease: BrowserStateMutationLease,
  claim: BrowserSessionStopClaim,
  sessionId: string,
): Promise<boolean> {
  const result = await lease.transaction.query(
    `UPDATE browser_sessions
        SET stop_lease_expires_at = now() + interval '30 seconds',
            updated_at = now()
      WHERE id = $1
        AND state = 'stopping'
        AND stop_attempt_id = $2
        AND stop_owner_instance_id = $3
        AND stop_owner_generation_nonce = $4
      RETURNING id`,
    [
      runtimeUuidSchema.parse(sessionId),
      claim.stopAttemptId,
      lease.binding.apiInstanceId,
      lease.binding.controlGenerationNonce,
    ],
  );
  return result.rows.length === 1;
}

/** @public Immutable external billing work elected by durable stop ownership. */
export type BrowserSessionBillingClaim = Readonly<{
  sessionId: string;
  ownerId: string;
  scrapeId: string | null;
  sessionDurationMs: number;
  creditsBilled: number;
  usedPrompt: boolean;
  ttlTotalSeconds: number | null;
}>;

type ClaimlessTerminalSession = {
  id: string;
  owner_id: string;
  created_at: string | Date;
  absolute_deadline_at: string | Date;
  idle_deadline_at: string | Date;
  prompt_used: boolean;
  billing_subscription_id: string | null;
  billing_api_key_id: number | null;
  billing_endpoint: "browser" | "interact";
  admission_backend: "redis" | "fdb" | "both" | null;
  keyless_team_id: string | null;
  keyless_reserved_credits: number;
};

async function persistClaimlessTerminalWork(
  lease: BrowserStateMutationLease,
  session: ClaimlessTerminalSession,
  terminalState: "expired" | "interrupted",
  terminalReason: string,
  deferAdmissionCleanup = false,
): Promise<void> {
  const now = Date.now();
  const terminalAt =
    terminalState === "expired"
      ? Math.min(
          new Date(session.absolute_deadline_at).getTime(),
          new Date(session.idle_deadline_at).getTime(),
        )
      : Math.min(now, new Date(session.absolute_deadline_at).getTime());
  const sessionDurationMs = Math.max(
    0,
    terminalAt - new Date(session.created_at).getTime(),
  );
  const credits = calculateBrowserSessionCredits(
    sessionDurationMs,
    session.prompt_used ? INTERACT_CREDITS_PER_HOUR : BROWSER_CREDITS_PER_HOUR,
  );
  const terminalized = await lease.transaction.query(
    `UPDATE browser_sessions
        SET state = $2,
            status = 'error',
            current_run_id = NULL,
            terminal_at = COALESCE(terminal_at, $5),
            terminal_reason = $3,
            credits_used = $4,
            prompt_used = false,
            stop_attempt_id = NULL,
            stop_lease_expires_at = NULL,
            stop_owner_instance_id = NULL,
            stop_owner_generation_nonce = NULL,
            updated_at = now()
      WHERE id = $1
        AND state IN ('creating', 'replaying', 'ready', 'executing')
      RETURNING id`,
    [
      session.id,
      terminalState,
      terminalReason,
      credits,
      new Date(terminalAt).toISOString(),
    ],
  );
  if (terminalized.rows.length !== 1) return;
  await lease.transaction.query(
    `UPDATE browser_interact_runs
        SET state = 'interrupted',
            error_category = $2,
            error_detail = $3,
            finished_at = COALESCE(finished_at, now())
      WHERE session_id = $1
        AND state IN ('queued', 'starting', 'running')`,
    [
      session.id,
      terminalReason,
      terminalState === "expired"
        ? "Browser session lifetime expired"
        : "Browser session creation was rolled back",
    ],
  );
  await lease.transaction.query(
    `UPDATE browser_capabilities
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE session_id = $1
        AND revoked_at IS NULL`,
    [session.id],
  );
  await lease.transaction.query(
    `UPDATE browser_proxy_grants
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE session_id = $1
        AND revoked_at IS NULL`,
    [session.id],
  );
  await lease.transaction.query(
    `UPDATE browser_profiles
        SET writer_session_id = NULL,
            updated_at = now()
      WHERE writer_session_id = $1`,
    [session.id],
  );
  await lease.transaction.query(
    `INSERT INTO browser_billing_outbox (
       session_id, owner_id, subscription_id, api_key_id, endpoint,
       session_duration_ms, credits, used_prompt, keyless_team_id,
       keyless_reserved_credits
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (session_id) DO NOTHING`,
    [
      session.id,
      session.owner_id,
      session.billing_subscription_id,
      session.billing_api_key_id,
      session.billing_endpoint,
      sessionDurationMs,
      credits,
      session.prompt_used,
      session.keyless_team_id,
      session.keyless_reserved_credits,
    ],
  );
  if (session.admission_backend) {
    await lease.transaction.query(
      `INSERT INTO browser_admission_cleanup (
         session_id, owner_id, backend, next_attempt_at
       ) VALUES (
         $1, $2, $3,
         CASE
           WHEN $4 THEN now() + interval '30 seconds'
           ELSE now()
         END
       )
       ON CONFLICT (session_id) DO NOTHING`,
      [
        session.id,
        session.owner_id,
        session.admission_backend,
        deferAdmissionCleanup,
      ],
    );
  }
}

/** @public Atomically terminalizes every expired active Browser session. */
export async function terminalizeExpiredBrowserSessions(
  lease: BrowserStateMutationLease,
  ownerId?: string,
  scrapeId?: string,
): Promise<number> {
  const expired = await lease.transaction.query<ClaimlessTerminalSession>(
    `SELECT id, owner_id, created_at, absolute_deadline_at,
            idle_deadline_at, prompt_used,
            billing_subscription_id, billing_api_key_id, billing_endpoint,
            admission_backend, keyless_team_id, keyless_reserved_credits
       FROM browser_sessions
      WHERE state IN ('creating', 'replaying', 'ready', 'executing')
        AND (absolute_deadline_at <= now() OR idle_deadline_at <= now())
        AND ($1::uuid IS NULL OR owner_id = $1)
        AND ($2::uuid IS NULL OR scrape_id = $2)
      ORDER BY created_at, id
      FOR UPDATE`,
    [ownerId ? runtimeUuidSchema.parse(ownerId) : null, scrapeId ?? null],
  );
  for (const session of expired.rows) {
    await persistClaimlessTerminalWork(lease, session, "expired", "expired");
  }
  return expired.rows.length;
}

/** @public Converts a failed creation into durable terminal cleanup work. */
export async function terminalizeFailedBrowserSession(
  lease: BrowserStateMutationLease,
  sessionId: string,
): Promise<boolean> {
  const result = await lease.transaction.query<ClaimlessTerminalSession>(
    `SELECT id, owner_id, created_at, absolute_deadline_at,
            idle_deadline_at, prompt_used,
            billing_subscription_id, billing_api_key_id, billing_endpoint,
            admission_backend, keyless_team_id, keyless_reserved_credits
       FROM browser_sessions
      WHERE id = $1
        AND state IN ('creating', 'replaying', 'ready', 'executing')
      FOR UPDATE`,
    [runtimeUuidSchema.parse(sessionId)],
  );
  const session = result.rows[0];
  if (!session) return false;
  await persistClaimlessTerminalWork(
    lease,
    session,
    "interrupted",
    "creation_rollback",
    true,
  );
  return true;
}

export type BrowserAdmissionCleanupClaim = Readonly<{
  sessionId: string;
  ownerId: string;
  backend: "redis" | "fdb" | "both";
  redisReleased: boolean;
  fdbReleased: boolean;
  leaseToken: string;
}>;

/** @public Claims retryable ownership of terminal admission cleanup. */
export async function claimBrowserAdmissionCleanup(
  lease: BrowserStateMutationLease,
  sessionId: string,
  ownerId: string,
): Promise<BrowserAdmissionCleanupClaim | null> {
  const leaseToken = randomUUID();
  const result = await lease.transaction.query<{
    session_id: string;
    owner_id: string;
    backend: "redis" | "fdb" | "both";
    redis_released_at: string | null;
    fdb_released_at: string | null;
  }>(
    `UPDATE browser_admission_cleanup
        SET lease_token = $3,
            lease_expires_at = now() + interval '30 seconds',
            attempt_count = attempt_count + 1,
            updated_at = now()
      WHERE session_id = $1
        AND owner_id = $2
        AND (lease_token IS NULL OR lease_expires_at <= now())
        AND (
          (backend IN ('redis', 'both') AND redis_released_at IS NULL)
          OR (backend IN ('fdb', 'both') AND fdb_released_at IS NULL)
        )
      RETURNING session_id, owner_id, backend, redis_released_at,
                fdb_released_at`,
    [
      runtimeUuidSchema.parse(sessionId),
      runtimeUuidSchema.parse(ownerId),
      leaseToken,
    ],
  );
  const row = result.rows[0];
  return row
    ? Object.freeze({
        sessionId: row.session_id,
        ownerId: row.owner_id,
        backend: row.backend,
        redisReleased: row.redis_released_at !== null,
        fdbReleased: row.fdb_released_at !== null,
        leaseToken,
      })
    : null;
}

/** @public Claims the next due admission cleanup for background recovery. */
export async function claimNextBrowserAdmissionCleanup(
  lease: BrowserStateMutationLease,
): Promise<BrowserAdmissionCleanupClaim | null> {
  const leaseToken = randomUUID();
  const result = await lease.transaction.query<{
    session_id: string;
    owner_id: string;
    backend: "redis" | "fdb" | "both";
    redis_released_at: string | null;
    fdb_released_at: string | null;
  }>(
    `UPDATE browser_admission_cleanup
        SET lease_token = $1,
            lease_expires_at = now() + interval '30 seconds',
            attempt_count = attempt_count + 1,
            updated_at = now()
      WHERE session_id = (
        SELECT session_id
          FROM browser_admission_cleanup
         WHERE next_attempt_at <= now()
           AND (lease_token IS NULL OR lease_expires_at <= now())
           AND (
             (backend IN ('redis', 'both') AND redis_released_at IS NULL)
             OR (backend IN ('fdb', 'both') AND fdb_released_at IS NULL)
           )
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING session_id, owner_id, backend, redis_released_at,
                fdb_released_at`,
    [leaseToken],
  );
  const row = result.rows[0];
  return row
    ? Object.freeze({
        sessionId: row.session_id,
        ownerId: row.owner_id,
        backend: row.backend,
        redisReleased: row.redis_released_at !== null,
        fdbReleased: row.fdb_released_at !== null,
        leaseToken,
      })
    : null;
}

/** @public Renews admission cleanup ownership during external release. */
export async function renewBrowserAdmissionCleanup(
  lease: BrowserStateMutationLease,
  claim: BrowserAdmissionCleanupClaim,
): Promise<boolean> {
  const result = await lease.transaction.query(
    `UPDATE browser_admission_cleanup
        SET lease_expires_at = now() + interval '30 seconds',
            updated_at = now()
      WHERE session_id = $1
        AND lease_token = $2
      RETURNING session_id`,
    [claim.sessionId, claim.leaseToken],
  );
  return result.rows.length === 1;
}

/** @public Records one confirmed idempotent admission backend release. */
export async function markBrowserAdmissionBackendReleased(
  lease: BrowserStateMutationLease,
  claim: BrowserAdmissionCleanupClaim,
  backend: "redis" | "fdb",
): Promise<void> {
  const column = backend === "redis" ? "redis_released_at" : "fdb_released_at";
  const result = await lease.transaction.query(
    `UPDATE browser_admission_cleanup
        SET ${column} = COALESCE(${column}, now()),
            lease_token = CASE
              WHEN (
                (backend = 'redis' AND $3 = 'redis')
                OR (backend = 'fdb' AND $3 = 'fdb')
                OR (
                  backend = 'both'
                  AND (
                    ($3 = 'redis' AND fdb_released_at IS NOT NULL)
                    OR ($3 = 'fdb' AND redis_released_at IS NOT NULL)
                  )
                )
              ) THEN NULL
              ELSE lease_token
            END,
            lease_expires_at = CASE
              WHEN (
                (backend = 'redis' AND $3 = 'redis')
                OR (backend = 'fdb' AND $3 = 'fdb')
                OR (
                  backend = 'both'
                  AND (
                    ($3 = 'redis' AND fdb_released_at IS NOT NULL)
                    OR ($3 = 'fdb' AND redis_released_at IS NOT NULL)
                  )
                )
              ) THEN NULL
              ELSE lease_expires_at
            END,
            last_error_category = NULL,
            updated_at = now()
      WHERE session_id = $1
        AND lease_token = $2
      RETURNING session_id`,
    [claim.sessionId, claim.leaseToken, backend],
  );
  if (result.rows.length !== 1) {
    throw new Error("Browser admission cleanup lease was lost");
  }
}

/** @public Releases a failed admission cleanup lease for bounded retry. */
export async function failBrowserAdmissionCleanup(
  lease: BrowserStateMutationLease,
  claim: BrowserAdmissionCleanupClaim,
  category: string,
): Promise<void> {
  await lease.transaction.query(
    `UPDATE browser_admission_cleanup
        SET lease_token = NULL,
            lease_expires_at = NULL,
            next_attempt_at = now() + interval '1 second',
            last_error_category = $3,
            updated_at = now()
      WHERE session_id = $1
        AND lease_token = $2`,
    [
      claim.sessionId,
      claim.leaseToken,
      z.string().min(1).max(128).parse(category),
    ],
  );
}

/** @public Commits one finalized generation with an exact profile pointer CAS. */
export async function commitPreparedProfileGeneration(
  lease: BrowserStateMutationLease,
  claim: BrowserSessionStopClaim,
  untrustedPrepared: PreparedProfileGeneration,
): Promise<void> {
  const prepared = z
    .strictObject({
      profileId: runtimeUuidSchema,
      generationId: runtimeUuidSchema,
      checksum: z.string().regex(/^[a-f0-9]{64}$/),
      byteSize: z.number().int().safe().min(1).max(268_435_456),
      prepareToken: z.string().min(32).max(512),
    })
    .parse(untrustedPrepared);
  if (claim.profileId !== prepared.profileId) {
    throw new Error("Prepared profile does not match stop ownership");
  }
  const session = await lease.transaction.query(
    `SELECT id, profile_id, profile_generation_id
       FROM browser_sessions
      WHERE id = (
        SELECT writer_session_id
          FROM browser_profiles
         WHERE id = $1
         FOR UPDATE
        )
        AND state = 'stopping'
        AND stop_attempt_id = $2
      FOR UPDATE`,
    [prepared.profileId, claim.stopAttemptId],
  );
  if (session.rows.length !== 1) {
    throw new Error("Profile writer stop ownership is not active");
  }
  const sessionRow = session.rows[0] as {
    id: string;
    profile_id: string;
    profile_generation_id: string | null;
  };
  if (sessionRow.profile_id !== prepared.profileId) {
    throw new Error("Profile writer binding changed");
  }
  const next = await lease.transaction.query(
    `SELECT COALESCE(max(generation), 0)::int + 1 AS generation
       FROM browser_profile_generations
      WHERE profile_id = $1`,
    [prepared.profileId],
  );
  const generation = Number(
    (next.rows[0] as { generation: number }).generation,
  );
  await lease.transaction.query(
    `INSERT INTO browser_profile_generations
       (id, profile_id, generation, state_path, byte_size, checksum)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      prepared.generationId,
      prepared.profileId,
      generation,
      `profiles/${prepared.profileId}/committed/${prepared.generationId}`,
      prepared.byteSize,
      prepared.checksum,
    ],
  );
  const pointer = await lease.transaction.query(
    `UPDATE browser_profiles
        SET latest_generation_id = $2,
            updated_at = now()
      WHERE id = $1
        AND writer_session_id = $3
        AND latest_generation_id IS NOT DISTINCT FROM $4::uuid
      RETURNING id`,
    [
      prepared.profileId,
      prepared.generationId,
      sessionRow.id,
      sessionRow.profile_generation_id,
    ],
  );
  if (pointer.rows.length !== 1) {
    throw new Error("Profile generation pointer CAS failed");
  }
  await lease.transaction.query(
    `UPDATE browser_sessions
        SET profile_generation_id = $2,
            updated_at = now()
      WHERE id = $1
        AND state = 'stopping'
        AND stop_attempt_id = $3`,
    [sessionRow.id, prepared.generationId, claim.stopAttemptId],
  );
}

/** @public Completes stop as destroyed only after confirmed cleanup. */
export async function finishBrowserSessionStop(
  lease: BrowserStateMutationLease,
  claim: BrowserSessionStopClaim,
  sessionId: string,
  reason: string,
  outcome: "destroyed" | "interrupted",
): Promise<BrowserSessionBillingClaim | null> {
  const parsedSessionId = runtimeUuidSchema.parse(sessionId);
  const terminalReason = z.string().min(1).max(128).parse(reason);
  const terminalState = z.enum(["destroyed", "interrupted"]).parse(outcome);
  const locked = await lease.transaction.query<{
    id: string;
    owner_id: string;
    scrape_id: string | null;
    created_at: string | Date;
    absolute_deadline_at: string | Date;
    idle_deadline_at: string | Date;
    prompt_used: boolean;
    ttl_total: number | null;
    billing_subscription_id: string | null;
    billing_api_key_id: number | null;
    billing_endpoint: "browser" | "interact";
    admission_backend: "redis" | "fdb" | "both" | null;
    keyless_team_id: string | null;
    keyless_reserved_credits: number;
  }>(
    `SELECT id, owner_id, scrape_id, created_at, absolute_deadline_at,
            idle_deadline_at, prompt_used, ttl_total,
            billing_subscription_id, billing_api_key_id, billing_endpoint,
            admission_backend, keyless_team_id, keyless_reserved_credits
       FROM browser_sessions
      WHERE id = $1
        AND state = 'stopping'
        AND stop_attempt_id = $2
      FOR UPDATE`,
    [parsedSessionId, claim.stopAttemptId],
  );
  const billing = locked.rows[0];
  if (!billing) return null;
  await lease.transaction.query(
    `UPDATE browser_interact_runs
        SET state = CASE
              WHEN $2 = 'destroyed' THEN 'cancelled'
              ELSE 'interrupted'
            END,
            cancelled_at = CASE
              WHEN $2 = 'destroyed' THEN COALESCE(cancelled_at, now())
              ELSE cancelled_at
            END,
            finished_at = COALESCE(finished_at, now()),
            error_category = CASE
              WHEN $2 = 'interrupted'
                THEN COALESCE(error_category, 'cleanup_interrupted')
              ELSE error_category
            END
      WHERE session_id = $1
        AND state IN ('queued', 'starting', 'running')`,
    [parsedSessionId, terminalState],
  );
  await lease.transaction.query(
    `UPDATE browser_capabilities
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE session_id = $1
        AND revoked_at IS NULL`,
    [parsedSessionId],
  );
  await lease.transaction.query(
    `UPDATE browser_proxy_grants
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE session_id = $1
        AND revoked_at IS NULL`,
    [parsedSessionId],
  );
  const sessionDurationMs = Math.max(
    0,
    Math.min(
      Date.now(),
      new Date(billing.absolute_deadline_at).getTime(),
      new Date(billing.idle_deadline_at).getTime(),
    ) - new Date(billing.created_at).getTime(),
  );
  const creditsBilled = calculateBrowserSessionCredits(
    sessionDurationMs,
    billing.prompt_used ? INTERACT_CREDITS_PER_HOUR : BROWSER_CREDITS_PER_HOUR,
  );
  const result = await lease.transaction.query(
    `UPDATE browser_sessions
        SET state = $3,
            current_run_id = NULL,
            terminal_at = COALESCE(terminal_at, now()),
            terminal_reason = $2,
            status = CASE WHEN $3 = 'destroyed' THEN 'closed' ELSE 'error' END,
            credits_used = $4,
            stop_attempt_id = NULL,
            stop_lease_expires_at = NULL,
            stop_owner_instance_id = NULL,
            stop_owner_generation_nonce = NULL,
            prompt_used = false,
            updated_at = now()
      WHERE id = $1
        AND state = 'stopping'
        AND stop_attempt_id = $5
      RETURNING id`,
    [
      parsedSessionId,
      terminalReason,
      terminalState,
      creditsBilled,
      claim.stopAttemptId,
    ],
  );
  if (result.rows.length !== 1) {
    throw new Error("Browser stop ownership is not active");
  }
  await lease.transaction.query(
    `UPDATE browser_profiles
        SET writer_session_id = NULL,
            updated_at = now()
      WHERE writer_session_id = $1`,
    [parsedSessionId],
  );
  if (!billing.billing_endpoint) {
    throw new Error("Browser terminal attribution is unavailable");
  }
  await lease.transaction.query(
    `INSERT INTO browser_billing_outbox (
       session_id, owner_id, subscription_id, api_key_id, endpoint,
       session_duration_ms, credits, used_prompt, keyless_team_id,
       keyless_reserved_credits
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (session_id) DO NOTHING`,
    [
      parsedSessionId,
      billing.owner_id,
      billing.billing_subscription_id,
      billing.billing_api_key_id,
      billing.billing_endpoint,
      sessionDurationMs,
      creditsBilled,
      billing.prompt_used,
      billing.keyless_team_id,
      billing.keyless_reserved_credits,
    ],
  );
  if (billing.admission_backend) {
    await lease.transaction.query(
      `INSERT INTO browser_admission_cleanup (
         session_id, owner_id, backend, next_attempt_at
       )
       VALUES ($1, $2, $3, now() + interval '30 seconds')
       ON CONFLICT (session_id) DO NOTHING`,
      [parsedSessionId, billing.owner_id, billing.admission_backend],
    );
  }
  return Object.freeze({
    sessionId: billing.id,
    ownerId: billing.owner_id,
    scrapeId: billing.scrape_id,
    sessionDurationMs,
    creditsBilled,
    usedPrompt: billing.prompt_used,
    ttlTotalSeconds: billing.ttl_total,
  });
}

/** @public */
export async function appendBrowserActivity(
  input: BrowserActivityInput,
): Promise<void> {
  await db.insert(schema.browser_session_activities).values(input);
}

/** @public */
export async function acquireProfileWriter(
  input: AcquireProfileWriterInput,
): Promise<BrowserProfileLease> {
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT id FROM browser_profiles WHERE id = ${input.profileId} FOR UPDATE`,
    );
    const [profile] = await tx
      .select()
      .from(schema.browser_profiles)
      .where(eq(schema.browser_profiles.id, input.profileId))
      .limit(1);
    if (!profile) throw new Error("Browser profile was not found");
    const [session] = await tx
      .select({
        id: schema.browser_sessions.id,
        ownerId: schema.browser_sessions.owner_id,
      })
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.id, input.sessionId))
      .limit(1);
    if (!session || session.ownerId !== profile.owner_id) {
      throw new Error("Browser profile/session binding is invalid");
    }
    if (
      profile.writer_session_id !== null &&
      profile.writer_session_id !== input.sessionId
    ) {
      throw new ProfileLockedError(input.profileId);
    }
    if (profile.writer_session_id === null) {
      await tx
        .update(schema.browser_profiles)
        .set({
          writer_session_id: input.sessionId,
          updated_at: new Date().toISOString(),
        })
        .where(eq(schema.browser_profiles.id, input.profileId));
    }
    return { profileId: input.profileId, sessionId: input.sessionId };
  });
}

/** @public */
export async function releaseProfileWriter(
  profileId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.browser_profiles)
    .set({ writer_session_id: null, updated_at: new Date().toISOString() })
    .where(
      and(
        eq(schema.browser_profiles.id, profileId),
        eq(schema.browser_profiles.writer_session_id, sessionId),
      ),
    )
    .returning({ id: schema.browser_profiles.id });
  return rows.length === 1;
}

/** @public */
export async function interruptUnfinishedBrowserWork(
  now: Date,
  controlTransaction: BrowserControlFenceTransaction,
): Promise<BrowserRecoveryResult> {
  const timestamp = now.toISOString();
  const prepared = await controlTransaction.query(
    `UPDATE browser_interact_actions
          SET state = 'cancelled_no_effect',
              error_category = 'process_interrupted',
              error_detail =
                'Action was not dispatched before process interruption',
              finished_at = $1,
              updated_at = $1
        WHERE state = 'prepared'
        RETURNING id`,
    [timestamp],
  );
  const executing = await controlTransaction.query(
    `UPDATE browser_interact_actions
          SET state = 'outcome_unknown',
              error_category = 'process_interrupted',
              error_detail =
                'Action outcome is unknown after process interruption',
              finished_at = $1,
              updated_at = $1
        WHERE state = 'executing'
        RETURNING id`,
    [timestamp],
  );
  const runs = await controlTransaction.query(
    `UPDATE browser_interact_runs
          SET state = 'interrupted',
              error_category = 'process_interrupted',
              error_detail = 'Run was interrupted by process restart',
              finished_at = $1
        WHERE state IN ('queued', 'starting', 'running')
        RETURNING id`,
    [timestamp],
  );
  const sessions = await controlTransaction.query<{
    id: string;
    owner_id: string;
    billing_subscription_id: string | null;
    billing_api_key_id: number | null;
    billing_endpoint: "browser" | "interact";
    admission_backend: "redis" | "fdb" | "both" | null;
    keyless_team_id: string | null;
    keyless_reserved_credits: number;
    created_at: string | Date;
    terminal_at: string | Date;
    prompt_used: boolean;
  }>(
    `UPDATE browser_sessions
          SET state = 'interrupted',
              status = 'error',
              terminal_at = least(
                $1::timestamptz, absolute_deadline_at, idle_deadline_at
              ),
              terminal_reason = 'process_interrupted',
              stop_attempt_id = NULL,
              stop_lease_expires_at = NULL,
              stop_owner_instance_id = NULL,
              stop_owner_generation_nonce = NULL,
              updated_at = $1
        WHERE state IN (
          'creating', 'replaying', 'ready', 'executing', 'stopping'
        )
        RETURNING id, owner_id, billing_subscription_id, billing_api_key_id,
                  billing_endpoint, admission_backend, keyless_team_id,
                  keyless_reserved_credits, created_at, terminal_at,
                  prompt_used`,
    [timestamp],
  );
  for (const session of sessions.rows) {
    if (!session.billing_endpoint) {
      throw new Error("Recovered browser session attribution is unavailable");
    }
    const sessionDurationMs = Math.max(
      0,
      new Date(session.terminal_at).getTime() -
        new Date(session.created_at).getTime(),
    );
    const creditsBilled = calculateBrowserSessionCredits(
      sessionDurationMs,
      session.prompt_used
        ? INTERACT_CREDITS_PER_HOUR
        : BROWSER_CREDITS_PER_HOUR,
    );
    await controlTransaction.query(
      `UPDATE browser_sessions
          SET credits_used = $2, prompt_used = false
        WHERE id = $1`,
      [session.id, creditsBilled],
    );
    await controlTransaction.query(
      `INSERT INTO browser_billing_outbox (
         session_id, owner_id, subscription_id, api_key_id, endpoint,
         session_duration_ms, credits, used_prompt, keyless_team_id,
         keyless_reserved_credits
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (session_id) DO NOTHING`,
      [
        session.id,
        session.owner_id,
        session.billing_subscription_id,
        session.billing_api_key_id,
        session.billing_endpoint,
        sessionDurationMs,
        creditsBilled,
        session.prompt_used,
        session.keyless_team_id,
        session.keyless_reserved_credits,
      ],
    );
    if (session.admission_backend) {
      await controlTransaction.query(
        `INSERT INTO browser_admission_cleanup (session_id, owner_id, backend)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO NOTHING`,
        [session.id, session.owner_id, session.admission_backend],
      );
    }
  }
  const capabilities = await controlTransaction.query(
    `UPDATE browser_capabilities
          SET revoked_at = $1
        WHERE revoked_at IS NULL
        RETURNING id`,
    [timestamp],
  );
  const grants = await controlTransaction.query(
    `UPDATE browser_proxy_grants
          SET revoked_at = $1
        WHERE revoked_at IS NULL
        RETURNING id`,
    [timestamp],
  );
  const leases =
    sessions.rows.length === 0
      ? { rows: [] }
      : await controlTransaction.query(
          `UPDATE browser_profiles
                SET writer_session_id = NULL,
                    updated_at = $1
              WHERE writer_session_id = ANY($2::uuid[])
              RETURNING id`,
          [timestamp, sessions.rows.map(session => session.id)],
        );
  return {
    preparedActionsCancelled: prepared.rows.length,
    executingActionsUnknown: executing.rows.length,
    runsInterrupted: runs.rows.length,
    sessionsInterrupted: sessions.rows.length,
    capabilitiesRevoked: capabilities.rows.length,
    grantsRevoked: grants.rows.length,
    writerLeasesCleared: leases.rows.length,
  };
}
