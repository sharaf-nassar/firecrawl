import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AdapterAuthorizationBinding } from "../browser-state/types";
import {
  createCapabilityStore,
  type AdapterCapabilityBinding,
  type IssuedAdapterCapability,
} from "../browser-state/capability-store";
import {
  claimBrowserSessionStop,
  commitPreparedProfileGeneration,
  countInteractActions,
  failAdapterRun,
  finishAdapterRun,
  finishBrowserSessionStop,
} from "../browser-state/store";
import type { BrowserSessionBillingClaim } from "../browser-state/store";
import type { BrowserExecutionAdapter } from "./execution-adapter";
import {
  codeRunInputSchema,
  codeRunResultSchema,
  PROMPT_LOOP_POLICY_V1,
  promptRunInputSchema,
  promptRunResultSchema,
  runtimeUuidSchema,
  type CodeRunResult,
  type ObservationV1,
  type PromptRunResult,
} from "./protocol";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "./startup-gate";

type PendingRun = {
  runId: string;
  adapterJobId: string;
  adapterSupervisorId: string;
  capabilityToken: string;
};

type BrowserOrchestratorStores = {
  countInteractActions(
    lease: BrowserStateMutationLease,
    runId: string,
  ): Promise<number>;
  finishAdapterRun(
    lease: BrowserStateMutationLease,
    runId: string,
    result: PromptRunResult | CodeRunResult,
  ): Promise<void>;
  failAdapterRun(
    lease: BrowserStateMutationLease,
    runId: string,
    error: unknown,
  ): Promise<void>;
  claimStop(
    lease: BrowserStateMutationLease,
    sessionId: string,
    reason: string,
    ownerId?: string,
  ): Promise<BrowserSessionStopClaim | null>;
  finishStop(
    lease: BrowserStateMutationLease,
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

type OrchestratorCapabilityStore = {
  beginAdapterRun(
    input: Omit<PendingRun, "capabilityToken"> & { adapterProcessId: null },
  ): Promise<IssuedAdapterCapability>;
  activate(
    runId: string,
    binding: AdapterAuthorizationBinding,
  ): Promise<AdapterCapabilityBinding>;
  revoke(runId: string): Promise<boolean>;
};

/** @public */
export type BrowserSessionStopClaim = {
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

type CodeExecutionInput = {
  runId: string;
  language: "node" | "python" | "bash";
  source: string;
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

const bindingSchema = z.strictObject({
  adapterJobId: runtimeUuidSchema,
  adapterSupervisorId: runtimeUuidSchema,
  adapterProcessId: z.number().int().positive(),
});

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

const publicCodeInputSchema = z.strictObject({
  runId: runtimeUuidSchema,
  language: z.enum(["node", "python", "bash"]),
  source: z.string().max(100_000),
  deadline: codeRunInputSchema.shape.deadline,
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
  capabilities: OrchestratorCapabilityStore,
) {
  const active = new Map<
    string,
    {
      controller: AbortController;
      cancel(reason: string): Promise<void>;
    }
  >();
  const stops = new Map<string, Promise<BrowserSessionBillingClaim | null>>();

  const startBinding = async (runId: string): Promise<PendingRun> => {
    const requested = {
      runId,
      adapterJobId: randomUUID(),
      adapterSupervisorId: randomUUID(),
      adapterProcessId: null,
    };
    const issued = await capabilities.beginAdapterRun(requested);
    if (
      issued.capability.runId !== requested.runId ||
      issued.capability.adapterJobId !== requested.adapterJobId ||
      issued.capability.adapterSupervisorId !== requested.adapterSupervisorId ||
      issued.capability.adapterProcessId !== null
    ) {
      throw executionError(
        "capability_denied",
        "Capability store returned a mismatched pending binding",
      );
    }
    return {
      runId,
      adapterJobId: requested.adapterJobId,
      adapterSupervisorId: requested.adapterSupervisorId,
      capabilityToken: issued.token,
    };
  };

  const accept =
    (
      pending: PendingRun,
      signal: AbortSignal,
      markAccepted: () => void,
    ): ((binding: AdapterAuthorizationBinding) => Promise<void>) =>
    async untrusted => {
      if (signal.aborted) throw signal.reason;
      const parsed = bindingSchema.safeParse(untrusted);
      if (!parsed.success) {
        throw executionError(
          "capability_denied",
          "Browser capability was denied",
        );
      }
      const binding = parsed.data;
      if (
        binding.adapterJobId !== pending.adapterJobId ||
        binding.adapterSupervisorId !== pending.adapterSupervisorId
      ) {
        throw Object.assign(new Error("Browser capability was denied"), {
          category: "capability_denied",
        });
      }
      await capabilities.activate(pending.runId, binding);
      if (signal.aborted) throw signal.reason;
      markAccepted();
    };

  const fail = async (runId: string, error: unknown): Promise<void> => {
    await capabilities.revoke(runId);
    await deps.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      lease => deps.stores.failAdapterRun(lease, runId, error),
    );
  };

  const finish = async (
    runId: string,
    result: PromptRunResult | CodeRunResult,
  ): Promise<void> => {
    await capabilities.revoke(runId);
    await deps.gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      lease => deps.stores.finishAdapterRun(lease, runId, result),
    );
  };

  const executeHost = async <T>(
    runId: string,
    deadline: Date,
    parentSignal: AbortSignal | undefined,
    invoke: (signal: AbortSignal, markAccepted: () => void) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    let accepted = false;
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
      const result = await Promise.race([
        invoke(controller.signal, () => {
          accepted = true;
        }),
        aborted,
      ]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!accepted) {
        throw executionError(
          "capability_denied",
          "Adapter returned before accepted binding activation",
        );
      }
      return result;
    } catch (error) {
      const reason =
        error &&
        typeof error === "object" &&
        "category" in error &&
        typeof error.category === "string"
          ? error.category
          : "failed";
      await cancel(reason);
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
      const parsed = publicPromptInputSchema.parse(input);
      if (parsed.signal?.aborted) {
        throw (
          parsed.signal.reason ??
          executionError("cancelled", "Browser execution cancelled")
        );
      }
      const pending = await startBinding(parsed.runId);
      try {
        const result = promptRunResultSchema.parse(
          await executeHost(
            parsed.runId,
            parsed.deadline,
            parsed.signal,
            (signal, markAccepted) =>
              deps.adapter.executePromptRun(
                promptRunInputSchema.parse({
                  runId: parsed.runId,
                  prompt: parsed.prompt,
                  initialObservation: parsed.initialObservation,
                  deadline: parsed.deadline,
                  correlationId: parsed.correlationId,
                  adapterJobId: pending.adapterJobId,
                  adapterSupervisorId: pending.adapterSupervisorId,
                  capabilityToken: pending.capabilityToken,
                  onAccepted: accept(pending, signal, markAccepted),
                  model: "gpt-5.6-terra",
                  reasoningEffort: "medium",
                  decisionSchemaVersion: 1,
                  observationSchemaVersion: 1,
                  loopPolicy: PROMPT_LOOP_POLICY_V1,
                }),
                signal,
              ),
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
        await fail(parsed.runId, error);
        throw error;
      }
    },

    async executeCode(input: CodeExecutionInput): Promise<CodeRunResult> {
      const parsed = publicCodeInputSchema.parse(input);
      if (parsed.signal?.aborted) {
        throw (
          parsed.signal.reason ??
          executionError("cancelled", "Browser execution cancelled")
        );
      }
      const pending = await startBinding(parsed.runId);
      try {
        const result = codeRunResultSchema.parse(
          await executeHost(
            parsed.runId,
            parsed.deadline,
            parsed.signal,
            (signal, markAccepted) =>
              deps.adapter.executeCodeRun(
                codeRunInputSchema.parse({
                  runId: parsed.runId,
                  language: parsed.language,
                  source: parsed.source,
                  deadline: parsed.deadline,
                  correlationId: parsed.correlationId,
                  adapterJobId: pending.adapterJobId,
                  adapterSupervisorId: pending.adapterSupervisorId,
                  capabilityToken: pending.capabilityToken,
                  onAccepted: accept(pending, signal, markAccepted),
                }),
                signal,
              ),
          ),
        );
        await finish(parsed.runId, result);
        return result;
      } catch (error) {
        await fail(parsed.runId, error);
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
        if (claim.runId !== null) {
          try {
            await capabilities.revoke(claim.runId);
          } catch (error) {
            errors.push(error);
          }
        }
        let billingClaim: BrowserSessionBillingClaim | null = null;
        try {
          billingClaim = await deps.gate.withBrowserStateMutationLease(
            "filesystem_and_database",
            lease =>
              deps.stores.finishStop(
                lease,
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

/** @public Production composition always owns its durable capability store. */
export function createBrowserSessionOrchestrator(
  deps: BrowserSessionOrchestratorDependencies,
) {
  return createBrowserSessionOrchestratorCore(
    {
      ...deps,
      stores: {
        countInteractActions,
        finishAdapterRun,
        failAdapterRun,
        claimStop: claimBrowserSessionStop,
        finishStop: finishBrowserSessionStop,
        commitPreparedProfile: commitPreparedProfileGeneration,
      },
    },
    createCapabilityStore({ gate: deps.gate }),
  );
}
