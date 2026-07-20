import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
      "Action identity does not match its stored proposal",
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
const operationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot") }),
  z.strictObject({ kind: z.literal("click"), ref: boundedString(1_024) }),
  z.strictObject({
    kind: z.literal("fill"),
    ref: boundedString(1_024),
    value: boundedString(40_000),
  }),
  z.strictObject({
    kind: z.literal("type"),
    ref: boundedString(1_024),
    value: boundedString(40_000),
    delayMs: z.number().int().min(0).max(60_000),
  }),
  z.strictObject({
    kind: z.literal("press"),
    ref: boundedString(1_024),
    key: boundedString(128),
  }),
  z.strictObject({
    kind: z.literal("select"),
    ref: boundedString(1_024),
    values: z.array(boundedString(4_096)).max(100),
  }),
  z.strictObject({
    kind: z.literal("scroll"),
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(60_000),
  }),
  z.strictObject({
    kind: z.literal("get_text"),
    ref: boundedString(1_024).optional(),
  }),
  z.strictObject({ kind: z.literal("get_url") }),
  z.strictObject({ kind: z.literal("navigate"), url: boundedString(8_192) }),
  z.strictObject({
    kind: z.literal("evaluate"),
    expression: boundedString(32_000),
    args: z.record(z.string(), z.json()),
  }),
]);

const submitBrowserActionSchema = z.strictObject({
  version: z.literal(1),
  adapterJobId: z.uuid(),
  sequence: z.number().int(),
  actionId: z.uuid(),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  effect: z.enum(["read_only", "side_effecting"]),
  operation: operationSchema,
});

const pageStateSchema = z.strictObject({
  url: boundedString(8_192),
  title: boundedString(4_096),
  snapshotExcerpt: boundedString(40_000),
});

const completionSchema = z
  .strictObject({
    runId: z.uuid(),
    actionId: z.uuid(),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["succeeded", "rejected_no_effect", "failed_no_effect"]),
    result: z.json().optional(),
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

const readOnlyOperations = new Set(["snapshot", "wait", "get_text", "get_url"]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function canonicalProposalHash(operation: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(operation), "utf8")
    .digest("hex");
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
  if (action.result !== null) {
    observation.result = action.result;
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
    .values({ ...input, state: input.state ?? "creating" })
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
  result?: unknown;
  error?: { category: string; message: string };
  page: BoundedPageState;
}

/** @public */
export async function prepareBrowserAction(
  runId: string,
  untrustedRequest: SubmitBrowserActionV1,
): Promise<PrepareBrowserActionResult> {
  const request = submitBrowserActionSchema.parse(untrustedRequest);
  if (request.sequence < 1 || request.sequence > ACTION_LIMIT) {
    throw new ActionLimitExceededError();
  }
  if (utf8Bytes(request.operation) > OPERATION_LIMIT_BYTES) {
    throw new Error("Browser operation exceeds 32 KiB");
  }
  const expectedEffect = readOnlyOperations.has(request.operation.kind)
    ? "read_only"
    : "side_effecting";
  if (request.effect !== expectedEffect) {
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
    const [session] = await tx
      .select()
      .from(schema.browser_sessions)
      .where(eq(schema.browser_sessions.id, run.session_id))
      .limit(1);
    if (
      !session ||
      session.owner_id !== run.owner_id ||
      session.request_id !== run.request_id ||
      session.state !== "executing"
    ) {
      throw new Error("Browser action run/session binding is invalid");
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
      return { kind: "cached", observation: observationFromAction(action) };
    }

    if (canonicalProposalHash(request.operation) !== request.proposalHash) {
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

/** @public */
export async function markBrowserActionExecuting(
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

/** @public */
export async function completeBrowserAction(
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
      return observationFromAction(action);
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
        result: input.result ?? null,
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
): Promise<BrowserRecoveryResult> {
  return db.transaction(async tx => {
    const timestamp = now.toISOString();
    const prepared = await tx
      .update(schema.browser_interact_actions)
      .set({
        state: "cancelled_no_effect",
        error_category: "process_interrupted",
        error_detail: "Action was not dispatched before process interruption",
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where(eq(schema.browser_interact_actions.state, "prepared"))
      .returning({ id: schema.browser_interact_actions.id });
    const executing = await tx
      .update(schema.browser_interact_actions)
      .set({
        state: "outcome_unknown",
        error_category: "process_interrupted",
        error_detail: "Action outcome is unknown after process interruption",
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where(eq(schema.browser_interact_actions.state, "executing"))
      .returning({ id: schema.browser_interact_actions.id });
    const runs = await tx
      .update(schema.browser_interact_runs)
      .set({
        state: "interrupted",
        error_category: "process_interrupted",
        error_detail: "Run was interrupted by process restart",
        finished_at: timestamp,
      })
      .where(
        inArray(schema.browser_interact_runs.state, [
          "queued",
          "starting",
          "running",
        ]),
      )
      .returning({ id: schema.browser_interact_runs.id });
    const sessions = await tx
      .update(schema.browser_sessions)
      .set({
        state: "interrupted",
        status: "error",
        terminal_at: timestamp,
        terminal_reason: "process_interrupted",
        updated_at: timestamp,
      })
      .where(
        inArray(schema.browser_sessions.state, [
          "creating",
          "replaying",
          "ready",
          "executing",
          "stopping",
        ]),
      )
      .returning({ id: schema.browser_sessions.id });
    const capabilities = await tx
      .update(schema.browser_capabilities)
      .set({ revoked_at: timestamp })
      .where(isNull(schema.browser_capabilities.revoked_at))
      .returning({ id: schema.browser_capabilities.id });
    const grants = await tx
      .update(schema.browser_proxy_grants)
      .set({ revoked_at: timestamp })
      .where(isNull(schema.browser_proxy_grants.revoked_at))
      .returning({ id: schema.browser_proxy_grants.id });
    const leases =
      sessions.length === 0
        ? []
        : await tx
            .update(schema.browser_profiles)
            .set({ writer_session_id: null, updated_at: timestamp })
            .where(
              inArray(
                schema.browser_profiles.writer_session_id,
                sessions.map(session => session.id),
              ),
            )
            .returning({ id: schema.browser_profiles.id });
    return {
      preparedActionsCancelled: prepared.length,
      executingActionsUnknown: executing.length,
      runsInterrupted: runs.length,
      sessionsInterrupted: sessions.length,
      capabilitiesRevoked: capabilities.length,
      grantsRevoked: grants.length,
      writerLeasesCleared: leases.length,
    };
  });
}
