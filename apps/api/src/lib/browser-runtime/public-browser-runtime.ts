import { createHash, randomUUID } from "node:crypto";

import type { BrowserExecutionAdapter } from "./execution-adapter";
import { unavailableExecutionAdapter } from "./execution-adapter";
import {
  createBrowserSessionOrchestrator,
  type BrowserSessionLifetime,
} from "./orchestrator";
import type { CodeRunResult, PromptRunResult } from "./protocol";
import { runtimeUuidSchema } from "./protocol";
import { createBrowserProxyUrls } from "./proxy-urls";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "./startup-gate";
import { createBrowserProxyGrantStore } from "../browser-state/proxy-grant-store";
import type {
  BrowserServiceClient,
  BrowserServiceRequestContext,
} from "../scrape-interact/browser-service-client";
import type {
  ProfileInputV1,
  ReplayBrowserSettingsV1,
  ReplayCheckpointV1,
  SessionV1,
} from "../scrape-interact/browser-service-contracts";
import type { StoredReplayCheckpoint } from "../scrape-interact/replay-envelope";
import type { ReplayResolution } from "../scrape-interact/replay-envelope";
import { loadScrapeReplayState } from "../scrape-interact/replay-store";

type PublicOrigins = { publicBase: string; publicWsBase: string };

export type PublicBrowserSession = {
  id: string;
  state: string;
  status: string;
  streamWebView: boolean;
  createdAt: string;
  lastActivity: string;
  expiresAt: string;
  cdpUrl: string;
  liveViewUrl: string;
  interactiveLiveViewUrl: string;
};

type PublicProfileInput = {
  name: string;
  saveChanges?: boolean;
  generationId?: string;
};

type CreatePublicSessionInput = PublicOrigins & {
  requestId: string;
  ownerId: string;
  scrapeId?: string;
  initialUrl: string;
  allowedDomains: string[];
  ttlSeconds?: number;
  activityTtlSeconds?: number;
  streamWebView: boolean;
  profile?: PublicProfileInput;
  replay: StoredReplayCheckpoint | null;
  settings: ReplayBrowserSettingsV1;
  concurrencyLimit?: number;
  admitSession?: () => Promise<void>;
};

type ExecutePublicSessionInput = {
  requestId: string;
  ownerId: string;
  sessionId: string;
  language: "node" | "python" | "bash";
  source: string;
  timeoutSeconds: number;
  correlationId: string;
  allowedDomains: string[];
};

type InteractInput = PublicOrigins & {
  requestId: string;
  ownerId: string;
  scrapeId: string;
  mode: "prompt" | "code";
  prompt?: string;
  source?: string;
  language: "node" | "python" | "bash";
  timeoutSeconds: number;
  correlationId: string;
  existingSessionId?: string;
  allowedDomains: string[];
  initialUrl: string;
  replay: StoredReplayCheckpoint;
  settings: ReplayBrowserSettingsV1;
  profile?: PublicProfileInput;
  concurrencyLimit?: number;
  admitSession?: () => Promise<void>;
  sessionCreated?: (session: PublicBrowserSession) => Promise<void>;
};

export class PublicBrowserRuntimeError extends Error {
  constructor(
    public readonly category:
      | "browser_not_found"
      | "browser_forbidden"
      | "browser_expired"
      | "profile_locked"
      | "replay_unavailable"
      | "browser_state_unavailable",
  ) {
    super(category);
    this.name = "PublicBrowserRuntimeError";
  }
}

interface PublicBrowserRuntime {
  loadReplayState(ownerId: string, scrapeId: string): Promise<ReplayResolution>;
  createSession(input: CreatePublicSessionInput): Promise<PublicBrowserSession>;
  listSessions(
    ownerId: string,
    status: "active" | "destroyed" | undefined,
    origins: PublicOrigins,
  ): Promise<PublicBrowserSession[]>;
  executeSession(input: ExecutePublicSessionInput): Promise<CodeRunResult>;
  stopSession(
    ownerId: string,
    sessionId: string,
  ): Promise<{
    stopped: boolean;
    sessionId?: string;
    sessionDurationMs?: number;
    creditsBilled?: number;
    usedPrompt?: boolean;
    ttlTotalSeconds?: number | null;
  }>;
  interact(input: InteractInput): Promise<{
    session: PublicBrowserSession;
    result: PromptRunResult | CodeRunResult;
  }>;
  stopInteract(
    ownerId: string,
    scrapeId: string,
  ): Promise<{
    stopped: boolean;
    sessionId?: string;
    sessionDurationMs?: number;
    creditsBilled?: number;
    usedPrompt?: boolean;
    ttlTotalSeconds?: number | null;
  }>;
}

let registeredRuntime: PublicBrowserRuntime | undefined;

export function registerPublicBrowserRuntime(
  runtime: PublicBrowserRuntime | undefined,
): void {
  registeredRuntime = runtime;
}

export function getPublicBrowserRuntime(): PublicBrowserRuntime | undefined {
  return registeredRuntime;
}

type SessionRow = {
  id: string;
  request_id: string;
  owner_id: string;
  scrape_id: string | null;
  browser_id: string | null;
  state: string;
  status: string;
  stream_web_view: boolean;
  runtime_epoch: number;
  created_at: string | Date;
  last_activity_at: string | Date;
  absolute_deadline_at: string | Date;
  idle_deadline_at: string | Date;
  context_id: string | null;
  workspace_id: string | null;
  ttl_without_activity: number | null;
};

function serviceContext(
  lease: BrowserStateMutationLease,
  correlationId: string,
  deadline: Date,
  signal = AbortSignal.timeout(Math.max(1, deadline.getTime() - Date.now())),
): BrowserServiceRequestContext {
  return {
    correlationId: runtimeUuidSchema.parse(correlationId),
    deadline,
    signal,
    processNonce: lease.binding.processNonce,
    controlGenerationNonce: lease.binding.controlGenerationNonce,
  };
}

function runtimeError(
  category: PublicBrowserRuntimeError["category"],
): PublicBrowserRuntimeError {
  return new PublicBrowserRuntimeError(category);
}

function assertOwner(row: SessionRow | undefined, ownerId: string): SessionRow {
  if (!row) throw runtimeError("browser_not_found");
  if (row.owner_id !== ownerId) throw runtimeError("browser_forbidden");
  if (
    ["destroyed", "expired", "interrupted", "error"].includes(row.state) ||
    new Date(row.absolute_deadline_at).getTime() <= Date.now() ||
    new Date(row.idle_deadline_at).getTime() <= Date.now()
  ) {
    throw runtimeError("browser_expired");
  }
  return row;
}

function replayForService(
  checkpoint: StoredReplayCheckpoint | null,
  checkpointId: string,
): ReplayCheckpointV1 | null {
  return checkpoint === null
    ? null
    : {
        checkpointId,
        statePath: checkpoint.statePath,
        checksum: checkpoint.checksum,
        byteSize: checkpoint.byteSize,
        storageState: checkpoint.storageState,
        finalUrl: checkpoint.finalUrl,
        fingerprint: checkpoint.fingerprint,
      };
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function compatibilityDigest(input: {
  allowedDomains: string[];
  replay: StoredReplayCheckpoint | null;
  settings: ReplayBrowserSettingsV1;
  profile?: PublicProfileInput;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        allowedDomains: [...input.allowedDomains].sort(),
        replay:
          input.replay === null
            ? null
            : {
                checksum: input.replay.checksum,
                finalUrl: input.replay.finalUrl,
                fingerprint: input.replay.fingerprint,
              },
        settings: input.settings,
        profile: input.profile
          ? {
              name: input.profile.name,
              saveChanges: input.profile.saveChanges !== false,
              generationId: input.profile.generationId ?? null,
            }
          : null,
      }),
    )
    .digest("hex");
}

function persistedDomains(row: SessionRow): string[] {
  if (row.workspace_id === null) return [];
  try {
    const parsed = JSON.parse(row.workspace_id);
    return Array.isArray(parsed) &&
      parsed.every(value => typeof value === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function createPublicBrowserRuntime(deps: {
  gate: BrowserStartupGate;
  browserClient: BrowserServiceClient;
  adapter?: BrowserExecutionAdapter;
  getActiveCount?: (ownerId: string) => Promise<number>;
  acquireAdmission?: (
    ownerId: string,
    sessionId: string,
    ttlMs: number,
  ) => Promise<void>;
  releaseAdmission?: (ownerId: string, sessionId: string) => Promise<void>;
}): PublicBrowserRuntime {
  const grants = createBrowserProxyGrantStore({ gate: deps.gate });
  const adapter = deps.adapter ?? unavailableExecutionAdapter;
  const closeSession = async (
    claim: {
      browserId: string | null;
      runtimeEpoch: number;
    },
    reason: string,
  ) => {
    if (claim.browserId === null) return { preparedProfile: null };
    return deps.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      async lease => {
        const deadline = new Date(Date.now() + 30_000);
        const closed = await deps.browserClient.closeSession(
          claim.browserId!,
          {
            version: 1,
            reason:
              reason === "expired" || reason === "shutdown"
                ? reason
                : reason === "error"
                  ? "error"
                  : "requested",
            expectedSessionVersion: claim.runtimeEpoch,
          },
          serviceContext(lease, randomUUID(), deadline),
        );
        return { preparedProfile: closed.preparedProfile };
      },
    );
  };
  const orchestrator = createBrowserSessionOrchestrator({
    gate: deps.gate,
    adapter,
    closeSession,
    finalizeProfile: prepared =>
      deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          await deps.browserClient.finalizeProfile(
            prepared.generationId,
            { version: 1, ...prepared },
            serviceContext(lease, randomUUID(), new Date(Date.now() + 30_000)),
          );
        },
      ),
    discardProfile: prepared =>
      deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          await deps.browserClient.discardProfile(
            prepared.generationId,
            { version: 1, ...prepared },
            serviceContext(lease, randomUUID(), new Date(Date.now() + 30_000)),
          );
        },
      ),
  });

  const loadSession = async (
    sessionId: string,
  ): Promise<SessionRow | undefined> =>
    deps.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      async lease => {
        const result = await lease.transaction.query<SessionRow>(
          `SELECT id, request_id, owner_id, scrape_id, browser_id, state,
                  status, stream_web_view, runtime_epoch, context_id,
                  workspace_id, ttl_without_activity, created_at,
                  last_activity_at, absolute_deadline_at, idle_deadline_at
             FROM browser_sessions
            WHERE id = $1`,
          [runtimeUuidSchema.parse(sessionId)],
        );
        return result.rows[0];
      },
    );

  const issuePublicSession = async (
    row: SessionRow,
    origins: PublicOrigins,
  ): Promise<PublicBrowserSession> => {
    if (["destroyed", "expired"].includes(row.state)) {
      return {
        id: row.id,
        state: row.state,
        status: row.status,
        streamWebView: row.stream_web_view,
        createdAt: iso(row.created_at),
        lastActivity: iso(row.last_activity_at),
        expiresAt: iso(row.absolute_deadline_at),
        cdpUrl: "",
        liveViewUrl: "",
        interactiveLiveViewUrl: "",
      };
    }
    const issued = await grants.issueSet({
      ownerId: row.owner_id,
      sessionId: row.id,
    });
    const urls = createBrowserProxyUrls({
      ...origins,
      passiveToken: issued.passive.token,
      interactiveToken: issued.interactive.token,
      cdpToken: issued.cdp.token,
    });
    return {
      id: row.id,
      state: row.state,
      status: row.status,
      streamWebView: row.stream_web_view,
      createdAt: iso(row.created_at),
      lastActivity: iso(row.last_activity_at),
      expiresAt: iso(row.absolute_deadline_at),
      ...urls,
    };
  };

  const createSession = async (
    input: CreatePublicSessionInput,
    mode: "direct" | "interact" = "direct",
  ): Promise<PublicBrowserSession> => {
    const sessionId = runtimeUuidSchema.parse(input.requestId);
    const ownerId = runtimeUuidSchema.parse(input.ownerId);
    const correlationId = randomUUID();
    const contextDigest = compatibilityDigest(input);
    let profileId: string | null = null;
    let runtimeSession: SessionV1 | undefined;
    let profileInput: ProfileInputV1 = null;
    let admissionAcquired = false;
    if (input.profile?.generationId && input.replay !== null) {
      throw runtimeError("replay_unavailable");
    }
    try {
      await orchestrator.createDirectSession({
        sessionId,
        mode,
        ttlSeconds: input.ttlSeconds,
        activityTtlSeconds: input.activityTtlSeconds,
        reserveLifetime: async (lease, lifetime) => {
          await lease.transaction.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
            [ownerId],
          );
          if (mode === "interact" && input.scrapeId !== undefined) {
            await lease.transaction.query(
              `UPDATE browser_sessions
                  SET state = 'expired',
                      status = 'closed',
                      terminal_at = COALESCE(terminal_at, now()),
                      terminal_reason = 'expired',
                      updated_at = now()
                WHERE owner_id = $1
                  AND scrape_id = $2
                  AND state = 'ready'
                  AND (
                    absolute_deadline_at <= now()
                    OR idle_deadline_at <= now()
                  )`,
              [ownerId, input.scrapeId],
            );
          }
          await input.admitSession?.();
          if (
            input.concurrencyLimit !== undefined &&
            deps.getActiveCount !== undefined &&
            (await deps.getActiveCount(ownerId)) >= input.concurrencyLimit
          ) {
            throw Object.assign(new Error("Concurrency limit reached"), {
              category: "concurrency_exceeded",
            });
          }
          if (deps.acquireAdmission !== undefined) {
            await deps.acquireAdmission(
              ownerId,
              sessionId,
              lifetime.ttlSeconds * 1_000,
            );
            admissionAcquired = true;
          }
        },
        createDurable: async (lease, lifetime) => {
          if (input.profile) {
            const profile = await lease.transaction.query<{
              id: string;
              latest_generation_id: string | null;
              state_path: string | null;
              checksum: string | null;
            }>(
              `WITH profile AS (
               INSERT INTO browser_profiles
                 (id, owner_id, name, created_at, updated_at)
               VALUES ($1, $2, $3, now(), now())
               ON CONFLICT (owner_id, name)
               DO UPDATE SET updated_at = browser_profiles.updated_at
               RETURNING id, latest_generation_id
             )
             SELECT p.id, p.latest_generation_id, g.state_path, g.checksum
               FROM profile p
               LEFT JOIN browser_profile_generations g
                 ON g.id = p.latest_generation_id`,
              [randomUUID(), ownerId, input.profile.name],
            );
            const found = profile.rows[0]!;
            profileId = found.id;
            const completeGeneration =
              found.latest_generation_id !== null &&
              found.state_path !== null &&
              found.checksum !== null;
            if (input.replay !== null && completeGeneration) {
              throw runtimeError("replay_unavailable");
            }
            profileInput = {
              profileId,
              mode: input.profile.saveChanges === false ? "snapshot" : "writer",
              generationId: completeGeneration
                ? found.latest_generation_id
                : null,
              statePath: completeGeneration ? found.state_path : null,
              checksum: completeGeneration ? found.checksum : null,
            };
          }
          await lease.transaction.query(
            `INSERT INTO browser_sessions (
             id, request_id, owner_id, scrape_id, runtime_epoch,
             profile_id, replay_version, state, absolute_deadline_at,
             idle_deadline_at, last_activity_at, stream_web_view,
             team_id, status, ttl_total, ttl_without_activity,
             workspace_id, context_id,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3::uuid, $4, 1, $5, 1, 'creating', $6, $7, now(), $8,
             $3::text, 'active', $9, $10, $11, $12, now(), now()
           )`,
            [
              sessionId,
              input.requestId,
              ownerId,
              input.scrapeId ?? null,
              profileId,
              lifetime.absoluteDeadline.toISOString(),
              lifetime.idleDeadline.toISOString(),
              input.streamWebView,
              lifetime.ttlSeconds,
              lifetime.activityTtlSeconds,
              JSON.stringify([...input.allowedDomains].sort()),
              contextDigest,
            ],
          );
        },
        acquireProfileWriter:
          input.profile?.saveChanges === false
            ? undefined
            : async lease => {
                if (!profileId) return;
                const result = await lease.transaction.query(
                  `UPDATE browser_profiles
                    SET writer_session_id = $2, updated_at = now()
                  WHERE id = $1
                    AND (writer_session_id IS NULL OR writer_session_id = $2)
                  RETURNING id`,
                  [profileId, sessionId],
                );
                if (result.rows.length !== 1)
                  throw runtimeError("profile_locked");
              },
        transitionToReplaying: lease =>
          lease.transaction.query(
            `UPDATE browser_sessions
              SET state = 'replaying', updated_at = now()
            WHERE id = $1 AND state = 'creating'`,
            [sessionId],
          ),
        createRuntime: async (lease, lifetime) => {
          const deadline = new Date(
            Math.min(lifetime.absoluteDeadline.getTime(), Date.now() + 60_000),
          );
          runtimeSession = await deps.browserClient.createSession(
            {
              version: 1,
              sessionId,
              initialUrl: input.initialUrl,
              allowedDomains: input.allowedDomains,
              ttlSeconds: lifetime.ttlSeconds,
              activityTtlSeconds: lifetime.activityTtlSeconds,
              profile: profileInput,
              replay: replayForService(input.replay, sessionId),
              settings: input.settings,
            },
            serviceContext(lease, correlationId, deadline),
          );
          return runtimeSession;
        },
        attachRuntime: async (lease, runtime) => {
          const attached = runtime as SessionV1;
          const result = await lease.transaction.query(
            `UPDATE browser_sessions
              SET browser_id = $2, runtime_epoch = $3, updated_at = now()
            WHERE id = $1 AND state = 'replaying'
            RETURNING id`,
            [sessionId, attached.runtimeSessionId, attached.sessionVersion],
          );
          if (result.rows.length !== 1)
            throw runtimeError("browser_state_unavailable");
        },
        materializeReplay: async () => undefined,
        transitionToReady: async lease => {
          const result = await lease.transaction.query<SessionRow>(
            `UPDATE browser_sessions
              SET state = 'ready', last_activity_at = now(), updated_at = now()
            WHERE id = $1 AND state = 'replaying'
            RETURNING id, request_id, owner_id, scrape_id, browser_id, state,
                      status, stream_web_view, runtime_epoch, context_id,
                      workspace_id, ttl_without_activity, created_at,
                      last_activity_at, absolute_deadline_at, idle_deadline_at`,
            [sessionId],
          );
          if (!result.rows[0]) throw runtimeError("browser_state_unavailable");
          return result.rows[0];
        },
        rollbackRuntime: async (lease, runtime) => {
          const attached = runtime as SessionV1;
          await deps.browserClient.closeSession(
            attached.runtimeSessionId,
            {
              version: 1,
              reason: "error",
              expectedSessionVersion: attached.sessionVersion,
            },
            serviceContext(lease, randomUUID(), new Date(Date.now() + 30_000)),
          );
        },
        rollbackProfileWriter: async lease => {
          if (profileId) {
            await lease.transaction.query(
              `UPDATE browser_profiles
                SET writer_session_id = NULL, updated_at = now()
              WHERE id = $1 AND writer_session_id = $2`,
              [profileId, sessionId],
            );
          }
        },
        rollbackDurable: async lease => {
          await lease.transaction.query(
            `DELETE FROM browser_sessions WHERE id = $1`,
            [sessionId],
          );
        },
      });
    } catch (error) {
      if (admissionAcquired && deps.releaseAdmission !== undefined) {
        try {
          await deps.releaseAdmission(ownerId, sessionId);
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            "Browser admission rollback failed",
          );
        }
      }
      throw error;
    }
    const row = await loadSession(sessionId);
    if (!row) throw runtimeError("browser_state_unavailable");
    return issuePublicSession(row, input);
  };

  const beginRun = async (
    ownerId: string,
    sessionId: string,
    mode: "prompt" | "code",
    language: string | null,
    timeoutSeconds: number,
    correlationId: string,
    requestId: string,
    allowedDomains?: string[],
  ): Promise<{
    runId: string;
    row: SessionRow;
    runtime: SessionV1;
    allowedDomains: string[];
  }> => {
    const runId = randomUUID();
    const deadline = new Date(
      Date.now() + Math.min(300, timeoutSeconds) * 1_000,
    );
    const runtime = await deps.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      async lease => {
        const locked = await lease.transaction.query<SessionRow>(
          `SELECT id, request_id, owner_id, scrape_id, browser_id, state,
                  status, stream_web_view, runtime_epoch, context_id,
                  workspace_id, ttl_without_activity, created_at,
                  last_activity_at, absolute_deadline_at, idle_deadline_at
             FROM browser_sessions
            WHERE id = $1
            FOR UPDATE`,
          [runtimeUuidSchema.parse(sessionId)],
        );
        const row = assertOwner(locked.rows[0], ownerId);
        const authorizedDomains = new Set(persistedDomains(row));
        for (const domain of allowedDomains ?? []) {
          authorizedDomains.add(domain);
        }
        if (authorizedDomains.size > 8) {
          throw Object.assign(new Error("Too many authorized domains"), {
            category: "target_blocked",
          });
        }
        const exactAllowedDomains = [...authorizedDomains].sort();
        if (row.state !== "ready" || row.browser_id === null)
          throw runtimeError("browser_state_unavailable");
        const service = await deps.browserClient.getSession(
          row.browser_id,
          serviceContext(lease, correlationId, deadline),
        );
        await lease.transaction.query(
          `UPDATE browser_sessions
              SET workspace_id = $2, updated_at = now()
            WHERE id = $1
              AND state = 'ready'`,
          [row.id, JSON.stringify(exactAllowedDomains)],
        );
        await lease.transaction.query(
          `INSERT INTO browser_interact_runs (
             id, request_id, owner_id, session_id, scrape_id, mode, state,
             language, model, reasoning_effort, deadline_at, correlation_id
           )
           SELECT $1, $2, owner_id, id, scrape_id, $3, 'queued',
                  $4, 'gpt-5.6-terra', 'medium', $5, $6
             FROM browser_sessions
            WHERE id = $7 AND owner_id = $8`,
          [
            runId,
            runtimeUuidSchema.parse(requestId),
            mode,
            language,
            deadline.toISOString(),
            correlationId,
            row.id,
            ownerId,
          ],
        );
        const transitioned = await lease.transaction.query(
          `UPDATE browser_sessions
              SET state = 'executing', current_run_id = $2,
                  request_id = $3, last_activity_at = now(),
                  prompt_used = prompt_used OR $4,
                  idle_deadline_at = least(
                    absolute_deadline_at,
                    now() + make_interval(secs => ttl_without_activity)
                  ),
                  updated_at = now()
            WHERE id = $1 AND state = 'ready'
            RETURNING id`,
          [row.id, runId, requestId, mode === "prompt"],
        );
        if (transitioned.rows.length !== 1)
          throw runtimeError("browser_state_unavailable");
        return { row, service, allowedDomains: exactAllowedDomains };
      },
    );
    return {
      runId,
      row: runtime.row,
      runtime: runtime.service,
      allowedDomains: runtime.allowedDomains,
    };
  };

  const executeSession = async (
    input: ExecutePublicSessionInput,
  ): Promise<CodeRunResult> => {
    const started = await beginRun(
      input.ownerId,
      input.sessionId,
      "code",
      input.language,
      input.timeoutSeconds,
      input.correlationId,
      input.requestId,
      input.allowedDomains,
    );
    return orchestrator.executeCode({
      runId: started.runId,
      language: input.language,
      source: input.source,
      deadline: new Date(Date.now() + input.timeoutSeconds * 1_000),
      correlationId: input.correlationId,
    });
  };

  const stopSession = async (ownerId: string, sessionId: string) => {
    runtimeUuidSchema.parse(ownerId);
    runtimeUuidSchema.parse(sessionId);
    const claim = await orchestrator.stopSession(
      sessionId,
      "requested",
      ownerId,
    );
    if (claim === null) {
      const row = await loadSession(sessionId);
      if (!row) throw runtimeError("browser_not_found");
      if (row.owner_id !== ownerId) throw runtimeError("browser_forbidden");
      return { stopped: false, sessionId };
    }
    return {
      stopped: true,
      sessionId: claim.sessionId,
      sessionDurationMs: claim.sessionDurationMs,
      creditsBilled: claim.creditsBilled,
      usedPrompt: claim.usedPrompt,
      ttlTotalSeconds: claim.ttlTotalSeconds,
    };
  };

  return {
    loadReplayState(ownerId, scrapeId) {
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        () => loadScrapeReplayState(ownerId, scrapeId),
      );
    },

    createSession: input => createSession(input),

    async listSessions(ownerId, status, origins) {
      runtimeUuidSchema.parse(ownerId);
      const rows = await deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          const statePredicate =
            status === "destroyed"
              ? `state IN ('destroyed', 'expired')`
              : `state IN ('ready', 'executing')`;
          return (
            await lease.transaction.query<SessionRow>(
              `SELECT id, request_id, owner_id, scrape_id, browser_id, state,
                      status, stream_web_view, runtime_epoch, context_id,
                      workspace_id, ttl_without_activity, created_at,
                      last_activity_at, absolute_deadline_at, idle_deadline_at
                 FROM browser_sessions
                WHERE owner_id = $1 AND ${statePredicate}
                  AND (
                    $2::boolean
                    OR (
                      absolute_deadline_at > now()
                      AND idle_deadline_at > now()
                    )
                  )
                ORDER BY created_at DESC`,
              [ownerId, status === "destroyed"],
            )
          ).rows;
        },
      );
      return Promise.all(rows.map(row => issuePublicSession(row, origins)));
    },

    executeSession,

    stopSession,

    async interact(input) {
      let session: PublicBrowserSession | undefined;
      if (input.existingSessionId) {
        const row = assertOwner(
          await loadSession(input.existingSessionId),
          input.ownerId,
        );
        if (row.state !== "ready" || row.scrape_id !== input.scrapeId) {
          throw runtimeError("replay_unavailable");
        }
        if (row.context_id !== compatibilityDigest(input)) {
          throw runtimeError("replay_unavailable");
        }
        session = await issuePublicSession(row, input);
      } else {
        const existing = await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease =>
            (
              await lease.transaction.query<SessionRow>(
                `SELECT id, request_id, owner_id, scrape_id, browser_id, state,
                        status, stream_web_view, runtime_epoch, context_id,
                        workspace_id, ttl_without_activity, created_at,
                        last_activity_at, absolute_deadline_at, idle_deadline_at
                   FROM browser_sessions
                  WHERE owner_id = $1 AND scrape_id = $2 AND state = 'ready'
                    AND absolute_deadline_at > now()
                    AND idle_deadline_at > now()
                  ORDER BY created_at DESC
                  LIMIT 1`,
                [input.ownerId, input.scrapeId],
              )
            ).rows[0],
        );
        if (existing && existing.context_id !== compatibilityDigest(input)) {
          throw runtimeError("replay_unavailable");
        }
        if (existing) {
          session = await issuePublicSession(existing, input);
        } else {
          session = await createSession(
            {
              ...input,
              ttlSeconds: 3_600,
              activityTtlSeconds: 600,
              streamWebView: true,
            },
            "interact",
          );
          await input.sessionCreated?.(session);
        }
      }
      const started = await beginRun(
        input.ownerId,
        session.id,
        input.mode,
        input.mode === "code" ? input.language : null,
        input.timeoutSeconds,
        input.correlationId,
        input.requestId,
      );
      const deadline = new Date(
        Date.now() + Math.min(300, input.timeoutSeconds) * 1_000,
      );
      const result =
        input.mode === "prompt"
          ? await orchestrator.executePrompt({
              runId: started.runId,
              prompt: input.prompt ?? "",
              initialObservation: {
                version: 1,
                type: "initial",
                sequence: 0,
                page: started.runtime.page,
              },
              deadline,
              correlationId: input.correlationId,
            })
          : await orchestrator.executeCode({
              runId: started.runId,
              language: input.language,
              source: input.source ?? "",
              deadline,
              correlationId: input.correlationId,
            });
      return { session, result };
    },

    async stopInteract(ownerId, scrapeId) {
      const row = await deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease =>
          (
            await lease.transaction.query<SessionRow>(
              `SELECT id, request_id, owner_id, scrape_id, browser_id, state,
                      status, stream_web_view, runtime_epoch, context_id,
                      workspace_id, ttl_without_activity, created_at,
                      last_activity_at, absolute_deadline_at, idle_deadline_at
                 FROM browser_sessions
                WHERE scrape_id = $1
                ORDER BY created_at DESC
                LIMIT 1`,
              [runtimeUuidSchema.parse(scrapeId)],
            )
          ).rows[0],
      );
      if (!row) throw runtimeError("browser_not_found");
      return stopSession(ownerId, row.id);
    },
  };
}
