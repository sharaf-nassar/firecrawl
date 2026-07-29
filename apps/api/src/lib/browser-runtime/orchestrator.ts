import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  claimBrowserSessionStop,
  commitPreparedProfileGeneration,
  countInteractActions,
  failAdapterRun,
  finishAdapterRun,
  finishBrowserSessionStop,
  getActiveBrowserRunAuthority,
  renewBrowserSessionStop,
  startAdapterRun,
} from "../browser-state/store";
import type { BrowserSessionBillingClaim } from "../browser-state/store";
import type { BrowserExecutionAdapter } from "./execution-adapter";
import type { BrowserActionCoordinator } from "./action-coordinator";
import { normalizeBrowserAction } from "./action-normalization";
import {
  normalizeModelDecisionEnvelopeV1,
  PROMPT_LOOP_POLICY_V1,
  promptRunInputSchema,
  promptRunResultSchema,
  runtimeUuidSchema,
  type DecisionHistoryEntryV1,
  type ObservationV1,
  type PromptRunResult,
} from "./protocol";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "./startup-gate";

type BrowserOrchestratorStores = {
  startAdapterRun(
    lease: BrowserStateMutationLease,
    runId: string,
  ): Promise<void>;
  countInteractActions(
    lease: BrowserStateMutationLease,
    runId: string,
  ): Promise<number>;
  finishAdapterRun(
    lease: BrowserStateMutationLease,
    runId: string,
    result: PromptRunResult,
  ): Promise<void>;
  failAdapterRun(
    lease: BrowserStateMutationLease,
    runId: string,
    error: unknown,
  ): Promise<void>;
  getActiveRun(runId: string): ReturnType<typeof getActiveBrowserRunAuthority>;
  claimStop(
    lease: BrowserStateMutationLease,
    sessionId: string,
    reason: string,
    ownerId?: string,
  ): Promise<BrowserSessionStopClaim | null>;
  renewStop?(
    lease: BrowserStateMutationLease,
    claim: BrowserSessionStopClaim,
    sessionId: string,
  ): Promise<boolean>;
  finishStop(
    lease: BrowserStateMutationLease,
    claim: BrowserSessionStopClaim,
    sessionId: string,
    reason: string,
    outcome: "destroyed" | "interrupted",
  ): Promise<BrowserSessionBillingClaim | null>;
  commitPreparedProfile?(
    lease: BrowserStateMutationLease,
    claim: BrowserSessionStopClaim,
    prepared: PreparedProfileGeneration,
  ): Promise<void>;
};

/** @public */
export type BrowserSessionStopClaim = {
  stopAttemptId: string;
  runId: string | null;
  profileId: string | null;
  requiresPreparedProfile?: boolean;
  browserId: string | null;
  runtimeEpoch: number;
};

/** @public */
export type PreparedProfileGeneration = {
  profileId: string;
  generationId: string;
  checksum: string;
  byteSize: number;
  prepareToken: string;
};

type ClosedBrowserSession = {
  preparedProfile: PreparedProfileGeneration | null;
};

/** @public */
export type BrowserSessionLifetime = {
  ttlSeconds: number;
  activityTtlSeconds: number;
  absoluteDeadline: Date;
  idleDeadline: Date;
};

type PromptExecutionInput = {
  runId: string;
  prompt: string;
  initialObservation: ObservationV1 & { type: "initial"; sequence: 0 };
  deadline: Date;
  correlationId: string;
  signal?: AbortSignal;
};

type DirectSessionInput = {
  sessionId: string;
  mode?: "direct" | "interact";
  ttlSeconds?: number;
  activityTtlSeconds?: number;
  reserveLifetime?(
    lease: BrowserStateMutationLease,
    lifetime: BrowserSessionLifetime,
  ): Promise<void>;
  createDurable(
    lease: BrowserStateMutationLease,
    lifetime: BrowserSessionLifetime,
  ): Promise<unknown>;
  acquireProfileWriter?(lease: BrowserStateMutationLease): Promise<unknown>;
  transitionToReplaying(lease: BrowserStateMutationLease): Promise<unknown>;
  createRuntime(
    lease: BrowserStateMutationLease,
    lifetime: BrowserSessionLifetime,
  ): Promise<unknown>;
  attachRuntime(
    lease: BrowserStateMutationLease,
    runtime: unknown,
  ): Promise<unknown>;
  materializeReplay(
    lease: BrowserStateMutationLease,
    runtime: unknown,
  ): Promise<unknown>;
  transitionToReady(
    lease: BrowserStateMutationLease,
    runtime: unknown,
  ): Promise<unknown>;
  rollbackRuntime(
    lease: BrowserStateMutationLease,
    runtime: unknown,
  ): Promise<void>;
  rollbackDurable(lease: BrowserStateMutationLease): Promise<void>;
  rollbackProfileWriter?(lease: BrowserStateMutationLease): Promise<void>;
};

const abortSignalSchema = z
  .custom<AbortSignal>(
    value => typeof AbortSignal !== "undefined" && value instanceof AbortSignal,
  )
  .optional();

const publicPromptInputSchema = z.strictObject({
  runId: runtimeUuidSchema,
  prompt: z.string().max(PROMPT_LOOP_POLICY_V1.maxPromptCharacters),
  initialObservation: promptRunInputSchema.shape.initialObservation,
  deadline: promptRunInputSchema.shape.deadline,
  correlationId: runtimeUuidSchema,
  signal: abortSignalSchema,
});

function executionError(
  category: "cancelled" | "timed_out" | "capability_denied",
  message: string,
): Error & { category: string } {
  return Object.assign(new Error(message), { category });
}

type BrowserSessionOrchestratorDependencies = {
  gate: BrowserStartupGate;
  adapter: BrowserExecutionAdapter;
  actionCoordinator: BrowserActionCoordinator;
  closeSession: (
    claim: BrowserSessionStopClaim,
    reason: string,
  ) => Promise<ClosedBrowserSession | void>;
  finalizeProfile?: (prepared: PreparedProfileGeneration) => Promise<void>;
  discardProfile?: (prepared: PreparedProfileGeneration) => Promise<void>;
};

function createBrowserSessionOrchestratorCore(
  deps: BrowserSessionOrchestratorDependencies & {
    stores: BrowserOrchestratorStores;
  },
) {
  const active = new Map<
    string,
    {
      controller: AbortController;
      cancel(reason: string): Promise<void>;
    }
  >();
  const stops = new Map<string, Promise<BrowserSessionBillingClaim | null>>();

  const fail = async (runId: string, error: unknown): Promise<void> => {
    await deps.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      lease => deps.stores.failAdapterRun(lease, runId, error),
    );
  };

  const finish = async (
    runId: string,
    result: PromptRunResult,
  ): Promise<void> => {
    await deps.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      lease => deps.stores.finishAdapterRun(lease, runId, result),
    );
  };

  const executeHost = async <T>(
    runId: string,
    deadline: Date,
    parentSignal: AbortSignal | undefined,
    invoke: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    let cancelPromise: Promise<void> | undefined;
    const cancel = (reason: string): Promise<void> => {
      if (!cancelPromise) {
        cancelPromise = deps.adapter
          .cancelExecutionRun(runId, reason)
          .then(result => {
            if (result.killed !== true) {
              throw executionError(
                "cancelled",
                "Adapter did not confirm process termination",
              );
            }
          });
      }
      return cancelPromise;
    };
    const abortFromParent = () =>
      controller.abort(
        parentSignal?.reason ??
          executionError("cancelled", "Browser execution cancelled"),
      );
    if (parentSignal?.aborted) abortFromParent();
    if (controller.signal.aborted) throw controller.signal.reason;
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const delay = deadline.getTime() - Date.now();
    if (delay <= 0) {
      parentSignal?.removeEventListener("abort", abortFromParent);
      throw executionError("timed_out", "Browser execution timed out");
    }
    const timer = setTimeout(
      () =>
        controller.abort(
          executionError("timed_out", "Browser execution timed out"),
        ),
      delay,
    );
    active.set(runId, { controller, cancel });
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (deadline.getTime() <= Date.now()) {
        controller.abort(
          executionError("timed_out", "Browser execution timed out"),
        );
        throw controller.signal.reason;
      }
      const result = await Promise.race([invoke(controller.signal), aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      return result;
    } catch (error) {
      const reason =
        error &&
        typeof error === "object" &&
        "category" in error &&
        typeof error.category === "string"
          ? error.category
          : "failed";
      try {
        await cancel(reason);
      } catch (cancellationError) {
        if (error instanceof Error && Object.isExtensible(error)) {
          Object.defineProperty(error, "cancellationError", {
            configurable: true,
            value: cancellationError,
          });
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
      active.delete(runId);
    }
  };

  return {
    async createDirectSession(input: DirectSessionInput): Promise<unknown> {
      runtimeUuidSchema.parse(input.sessionId);
      const mode = input.mode ?? "direct";
      const ttlSeconds =
        mode === "interact" ? 3_600 : (input.ttlSeconds ?? 600);
      const activityTtlSeconds = Math.min(
        ttlSeconds,
        mode === "interact" ? 600 : (input.activityTtlSeconds ?? 300),
      );
      if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < 30 ||
        ttlSeconds > 3_600 ||
        !Number.isInteger(activityTtlSeconds) ||
        activityTtlSeconds < 10 ||
        activityTtlSeconds > 600
      ) {
        throw new TypeError("Browser session lifetime is outside safe bounds");
      }
      const now = Date.now();
      const lifetime: BrowserSessionLifetime = {
        ttlSeconds,
        activityTtlSeconds,
        absoluteDeadline: new Date(now + ttlSeconds * 1_000),
        idleDeadline: new Date(now + activityTtlSeconds * 1_000),
      };
      let runtime: unknown;
      let durableCreated = false;
      let profileWriterAcquired = false;
      try {
        await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease => {
            await input.reserveLifetime?.(lease, lifetime);
            await input.createDurable(lease, lifetime);
            durableCreated = true;
            if (input.acquireProfileWriter) {
              await input.acquireProfileWriter(lease);
              profileWriterAcquired = true;
            }
            await input.transitionToReplaying(lease);
          },
        );
        await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease => {
            runtime = await input.createRuntime(lease, lifetime);
            return input.attachRuntime(lease, runtime);
          },
        );
        await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => input.materializeReplay(lease, runtime),
        );
        return await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => input.transitionToReady(lease, runtime),
        );
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (runtime !== undefined) {
          try {
            await deps.gate.withBrowserStateMutationLease(
              "filesystem_and_database",
              lease => input.rollbackRuntime(lease, runtime),
            );
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (profileWriterAcquired && input.rollbackProfileWriter) {
          try {
            await deps.gate.withBrowserStateMutationLease(
              "filesystem_and_database",
              lease => input.rollbackProfileWriter!(lease),
            );
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (durableCreated) {
          try {
            await deps.gate.withBrowserStateMutationLease(
              "filesystem_and_database",
              lease => input.rollbackDurable(lease),
            );
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Browser session rollback failed",
          );
        }
        throw error;
      }
    },

    async executePrompt(input: PromptExecutionInput): Promise<PromptRunResult> {
      try {
        const parsed = publicPromptInputSchema.parse(input);
        const startedAtMs = Date.now();
        if (parsed.signal?.aborted) {
          throw (
            parsed.signal.reason ??
            executionError("cancelled", "Browser execution cancelled")
          );
        }
        await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => deps.stores.startAdapterRun(lease, parsed.runId),
        );
        const validatedInput = promptRunInputSchema.parse({
          runId: parsed.runId,
          prompt: parsed.prompt,
          initialObservation: parsed.initialObservation,
          deadline: parsed.deadline,
          correlationId: parsed.correlationId,
          decisionSchemaVersion: 1,
          observationSchemaVersion: 1,
          loopPolicy: PROMPT_LOOP_POLICY_V1,
        });
        const result = promptRunResultSchema.parse(
          await executeHost(
            parsed.runId,
            parsed.deadline,
            parsed.signal,
            async signal => {
              let observation: ObservationV1 =
                validatedInput.initialObservation;
              const history: DecisionHistoryEntryV1[] = [];
              let aggregateObservationBytes = Buffer.byteLength(
                JSON.stringify(observation),
                "utf8",
              );
              for (
                let turn = 0;
                turn < PROMPT_LOOP_POLICY_V1.maxTurns;
                turn += 1
              ) {
                let screenshot:
                  | Awaited<
                      ReturnType<BrowserActionCoordinator["loadScreenshot"]>
                    >
                  | undefined;
                if (
                  observation.type === "action_result" &&
                  observation.outcome === "succeeded" &&
                  observation.actionKind === "screenshot" &&
                  observation.result?.kind === "screenshot"
                ) {
                  const activeRun = await deps.stores.getActiveRun(
                    parsed.runId,
                  );
                  if (activeRun === null) {
                    throw Object.assign(
                      new Error("Browser run authority is unavailable"),
                      { category: "capability_denied" },
                    );
                  }
                  screenshot = await deps.actionCoordinator.loadScreenshot(
                    activeRun,
                    observation,
                  );
                }
                const decision = normalizeModelDecisionEnvelopeV1(
                  await deps.adapter.requestDecision(
                    {
                      runId: parsed.runId,
                      prompt: parsed.prompt,
                      turn,
                      startedAtMs,
                      deadlineMs: parsed.deadline.getTime(),
                      history,
                      observation,
                      ...(screenshot === undefined ? {} : { screenshot }),
                    },
                    signal,
                  ),
                );
                if (decision.type === "final") {
                  return {
                    output: decision.output,
                    turnCount: turn + 1,
                    actionCount: turn,
                    usage: { inputTokens: 0, outputTokens: 0 },
                    protocol: {
                      toolEventCount: 0,
                      approvalEventCount: 0,
                      decisionSchemaVersion: 1,
                      observationSchemaVersion: 1,
                    },
                  };
                }
                if (turn >= PROMPT_LOOP_POLICY_V1.maxActions) {
                  throw Object.assign(
                    new Error("Browser action limit exceeded"),
                    { category: "model_protocol_error" },
                  );
                }
                const activeRun = await deps.stores.getActiveRun(parsed.runId);
                if (activeRun === null) {
                  throw Object.assign(
                    new Error("Browser run authority is unavailable"),
                    { category: "capability_denied" },
                  );
                }
                const normalized = normalizeBrowserAction(decision.action);
                observation = await deps.actionCoordinator.handleProposal(
                  activeRun,
                  {
                    version: 1,
                    adapterJobId: activeRun.adapterJobId,
                    sequence: turn + 1,
                    actionId: randomUUID(),
                    proposalHash: normalized.normalizedProposalHash,
                    effect: normalized.effect,
                    operation: decision.action,
                  },
                  {
                    correlationId: parsed.correlationId,
                    deadline: parsed.deadline,
                    signal,
                  },
                );
                history.push({
                  turn,
                  action: decision.action,
                  observation,
                });
                aggregateObservationBytes += Buffer.byteLength(
                  JSON.stringify(observation),
                  "utf8",
                );
                if (
                  aggregateObservationBytes >
                  PROMPT_LOOP_POLICY_V1.maxAggregateObservationBytes
                ) {
                  throw Object.assign(
                    new Error("Browser observations exceed their limit"),
                    { category: "model_protocol_error" },
                  );
                }
              }
              throw Object.assign(new Error("Browser turn limit exceeded"), {
                category: "model_protocol_error",
              });
            },
          ),
        );
        if (result.turnCount !== result.actionCount + 1) {
          throw Object.assign(new Error("Adapter turn count mismatch"), {
            category: "model_protocol_error",
          });
        }
        const durableActionCount =
          await deps.gate.withBrowserStateMutationLease(
            "filesystem_and_database",
            lease => deps.stores.countInteractActions(lease, parsed.runId),
          );
        if (result.actionCount !== durableActionCount) {
          throw Object.assign(new Error("Adapter action count mismatch"), {
            category: "model_protocol_error",
          });
        }
        await finish(parsed.runId, result);
        return result;
      } catch (error) {
        await fail(input.runId, error);
        throw error;
      }
    },

    stopSession(
      sessionId: string,
      reason: string,
      ownerId?: string,
    ): Promise<BrowserSessionBillingClaim | null> {
      const existing = stops.get(sessionId);
      if (existing) {
        return existing.then(() => null);
      }
      const stop = (async () => {
        runtimeUuidSchema.parse(sessionId);
        const claim = await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => deps.stores.claimStop(lease, sessionId, reason, ownerId),
        );
        if (claim === null) return null;
        const errors: unknown[] = [];
        let heartbeatFailure: unknown;
        let heartbeatPending = Promise.resolve();
        const heartbeat =
          deps.stores.renewStop === undefined
            ? undefined
            : setInterval(() => {
                heartbeatPending = heartbeatPending
                  .then(async () => {
                    const renewed =
                      await deps.gate.withBrowserStateMutationLease(
                        "filesystem_and_database",
                        lease =>
                          deps.stores.renewStop!(lease, claim, sessionId),
                      );
                    if (!renewed) {
                      throw new Error("Browser stop lease ownership was lost");
                    }
                  })
                  .catch(error => {
                    heartbeatFailure ??= error;
                  });
              }, 5_000);
        heartbeat?.unref();
        if (claim.runId !== null) {
          const execution = active.get(claim.runId);
          execution?.controller.abort(
            executionError("cancelled", "Browser execution cancelled"),
          );
          try {
            if (execution) await execution.cancel(reason);
            else {
              const terminal = await deps.adapter.cancelExecutionRun(
                claim.runId,
                reason,
              );
              if (terminal.killed !== true) {
                throw executionError(
                  "cancelled",
                  "Adapter did not confirm process termination",
                );
              }
            }
          } catch (error) {
            errors.push(error);
          }
        }
        let closed: ClosedBrowserSession | void = undefined;
        try {
          closed = await deps.closeSession(claim, reason);
        } catch (error) {
          errors.push(error);
        }
        const prepared = closed?.preparedProfile ?? null;
        if (claim.requiresPreparedProfile === true && prepared === null) {
          errors.push(
            new Error("Profile-bearing stop returned no prepared profile"),
          );
        }
        if (prepared !== null) {
          try {
            if (
              prepared.profileId !== claim.profileId ||
              !deps.finalizeProfile ||
              !deps.stores.commitPreparedProfile
            ) {
              throw new Error("Prepared profile binding is unavailable");
            }
            await deps.finalizeProfile(prepared);
            await deps.gate.withBrowserStateMutationLease(
              "filesystem_and_database",
              lease =>
                deps.stores.commitPreparedProfile!(lease, claim, prepared),
            );
          } catch (error) {
            errors.push(error);
            if (deps.discardProfile) {
              try {
                await deps.discardProfile(prepared);
              } catch (discardError) {
                errors.push(discardError);
              }
            }
          }
        }
        if (heartbeat) clearInterval(heartbeat);
        await heartbeatPending;
        if (heartbeatFailure !== undefined) errors.push(heartbeatFailure);
        let billingClaim: BrowserSessionBillingClaim | null = null;
        try {
          billingClaim = await deps.gate.withBrowserStateMutationLease(
            "filesystem_and_database",
            lease =>
              deps.stores.finishStop(
                lease,
                claim,
                sessionId,
                reason,
                errors.length === 0 ? "destroyed" : "interrupted",
              ),
          );
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Browser stop cleanup failed");
        }
        return billingClaim;
      })().finally(() => {
        stops.delete(sessionId);
      });
      stops.set(sessionId, stop);
      return stop;
    },
  };
}

/** @public */
export function createBrowserSessionOrchestrator(
  deps: BrowserSessionOrchestratorDependencies,
) {
  return createBrowserSessionOrchestratorCore({
    ...deps,
    stores: {
      startAdapterRun,
      countInteractActions,
      finishAdapterRun,
      failAdapterRun,
      getActiveRun: getActiveBrowserRunAuthority,
      claimStop: claimBrowserSessionStop,
      renewStop: renewBrowserSessionStop,
      finishStop: finishBrowserSessionStop,
      commitPreparedProfile: commitPreparedProfileGeneration,
    },
  });
}
