import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  CapabilityDeniedError,
  createCapabilityStore,
  type AuthorizePersistedCapabilityInput,
} from "../browser-state/capability-store";
import {
  ActionIdentityMismatchError,
  ActionLimitExceededError,
  ActionOutcomeUnknownError,
  createBrowserActionStore,
  type ActiveBrowserRunAuthority,
  type CompleteBrowserActionInput,
} from "../browser-state/store";
import type {
  ObservationV1,
  SubmitBrowserActionV1,
} from "../browser-state/types";
import {
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  type BrowserActionExecutionV1,
  type BrowserActionExecutionResultV1,
} from "../scrape-interact/browser-service-contracts";
import type {
  BrowserServiceClient,
  BrowserServiceRequestContext,
} from "../scrape-interact/browser-service-client";
import {
  normalizeBrowserAction,
  parseSubmitBrowserActionV1,
} from "./action-normalization";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "./startup-gate";

const RESULT_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 128 * 1024;
const OBSERVATION_LIMIT_BYTES = 64 * 1024;

/** @public */
export class BrowserActionCoordinatorError extends Error {
  constructor(
    public readonly category:
      | "model_protocol_error"
      | "action_outcome_unknown"
      | "cancelled"
      | "capability_denied",
    message: string,
  ) {
    super(message);
    this.name = "BrowserActionCoordinatorError";
  }
}

type ActionStore = ReturnType<typeof createBrowserActionStore>;
type CapabilityStore = ReturnType<typeof createCapabilityStore>;

type CoordinatorContext = {
  adapterSupervisorId: string;
  adapterProcessId: number;
  correlationId: string;
  deadline: Date;
  signal?: AbortSignal;
};

type ActionCoordinatorDependencies = {
  gate: BrowserStartupGate;
  browserClient: Pick<BrowserServiceClient, "executeAction">;
  actions?: ActionStore;
  capabilities?: CapabilityStore;
};

function byteLength(value: unknown): number {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new BrowserActionCoordinatorError(
      "action_outcome_unknown",
      "Browser action response was not safely serializable",
    );
  }
  if (encoded === undefined) {
    throw new BrowserActionCoordinatorError(
      "action_outcome_unknown",
      "Browser action response was not safely serializable",
    );
  }
  return Buffer.byteLength(encoded, "utf8");
}

function protocol(message: string): BrowserActionCoordinatorError {
  return new BrowserActionCoordinatorError("model_protocol_error", message);
}

function unknown(): BrowserActionCoordinatorError {
  return new BrowserActionCoordinatorError(
    "action_outcome_unknown",
    "Browser action outcome could not be proven",
  );
}

function cancelled(): BrowserActionCoordinatorError {
  return new BrowserActionCoordinatorError(
    "cancelled",
    "Browser action was cancelled before dispatch",
  );
}

function bindingInput(
  run: ActiveBrowserRunAuthority,
  context: CoordinatorContext,
): AuthorizePersistedCapabilityInput {
  return {
    ownerId: run.ownerId,
    sessionId: run.sessionId,
    runId: run.runId,
    adapterJobId: run.adapterJobId,
    adapterSupervisorId: context.adapterSupervisorId,
    adapterProcessId: context.adapterProcessId,
  };
}

function assertAuthority(
  run: ActiveBrowserRunAuthority,
  proposal: SubmitBrowserActionV1,
  context: CoordinatorContext,
): void {
  if (
    proposal.adapterJobId !== run.adapterJobId ||
    context.adapterSupervisorId !== run.adapterSupervisorId ||
    context.adapterProcessId !== run.adapterProcessId
  ) {
    throw new BrowserActionCoordinatorError(
      "capability_denied",
      "Browser capability was denied",
    );
  }
}

function validateServiceResult(
  value: unknown,
  proposal: SubmitBrowserActionV1,
  expectedSessionVersion: number,
): BrowserActionExecutionResultV1 {
  if (byteLength(value) > RESPONSE_LIMIT_BYTES) throw unknown();
  const parsed = actionExecutionResultSchema.safeParse(value);
  if (!parsed.success) throw unknown();
  const result = parsed.data;
  if (
    result.actionId !== proposal.actionId ||
    result.sequence !== proposal.sequence ||
    result.normalizedProposalHash !== proposal.proposalHash ||
    (result.outcome === "succeeded" &&
      result.result.kind !== proposal.operation.kind)
  ) {
    throw unknown();
  }
  const requiredSessionVersion =
    result.outcome === "succeeded"
      ? expectedSessionVersion + 1
      : expectedSessionVersion;
  if (
    !Number.isSafeInteger(requiredSessionVersion) ||
    result.sessionVersion !== requiredSessionVersion
  ) {
    throw unknown();
  }
  if (
    result.outcome === "succeeded" &&
    byteLength(result.result) > RESULT_LIMIT_BYTES
  ) {
    throw unknown();
  }
  return result;
}

function completionFrom(
  runId: string,
  proposal: SubmitBrowserActionV1,
  result: BrowserActionExecutionResultV1,
  expectedSessionVersion: number,
): CompleteBrowserActionInput & {
  expectedSessionVersion: number;
  sessionVersion: number;
} {
  return {
    runId,
    actionId: proposal.actionId,
    proposalHash: proposal.proposalHash,
    expectedSessionVersion,
    sessionVersion: result.sessionVersion,
    outcome: result.outcome,
    ...(result.outcome === "succeeded"
      ? { result: result.result }
      : { error: result.error }),
    page: result.page,
  };
}

/** @public */
export function createBrowserActionCoordinator(
  deps: ActionCoordinatorDependencies,
) {
  const actions = deps.actions ?? createBrowserActionStore({ gate: deps.gate });
  const capabilities =
    deps.capabilities ?? createCapabilityStore({ gate: deps.gate });

  const terminalUnknown = async (
    lease: BrowserStateMutationLease,
    runId: string,
    actionId: string,
  ): Promise<never> => {
    await actions.markOutcomeUnknownWithLease(lease, runId, actionId);
    throw unknown();
  };

  const terminalizeAfterLeaseFailure = async (
    runId: string,
    actionId: string,
  ): Promise<never> => {
    try {
      await actions.markOutcomeUnknown(runId, actionId);
    } catch {
      // If recovery has not already closed the gate, fail the whole mutation
      // authority closed. The durable executing row is then mandatory startup
      // recovery work before another control generation may open.
      try {
        deps.gate.assertOpen();
        deps.gate.close("action_terminalization_failed");
      } catch {
        // An already-closed gate is already owned by drained recovery.
      }
    }
    throw unknown();
  };

  return {
    async handleProposal(
      activeRun: ActiveBrowserRunAuthority,
      untrustedProposal: unknown,
      context: CoordinatorContext,
    ): Promise<ObservationV1> {
      if (
        typeof untrustedProposal === "object" &&
        untrustedProposal !== null &&
        Number.isInteger(
          (untrustedProposal as { sequence?: unknown }).sequence,
        ) &&
        Number((untrustedProposal as { sequence: number }).sequence) > 25
      ) {
        throw new ActionLimitExceededError();
      }
      let proposal: SubmitBrowserActionV1;
      try {
        proposal = parseSubmitBrowserActionV1(untrustedProposal);
      } catch (error) {
        if (
          error instanceof BrowserActionCoordinatorError ||
          (error instanceof Error &&
            (error as Error & { category?: string }).category ===
              "model_protocol_error")
        ) {
          throw protocol("Browser action proposal is invalid");
        }
        if (error instanceof z.ZodError) {
          throw protocol("Browser action proposal is invalid");
        }
        throw error;
      }
      assertAuthority(activeRun, proposal, context);

      let prepared: Awaited<ReturnType<ActionStore["prepare"]>>;
      try {
        prepared = await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease => {
            const staged = await actions.prepareWithLease(
              lease,
              activeRun.runId,
              proposal,
            );
            if (staged.kind === "cached") return staged;
            try {
              await capabilities.redeemActionWithLease(lease, {
                ...bindingInput(activeRun, context),
                operation: proposal.operation.kind,
                byteCount: byteLength(proposal.operation),
              });
              return staged;
            } catch (error) {
              if (!(error instanceof CapabilityDeniedError)) throw error;
              await actions.cancelPreparedWithLease(
                lease,
                activeRun.runId,
                proposal.actionId,
              );
              throw error;
            }
          },
        );
      } catch (error) {
        if (error instanceof ActionIdentityMismatchError) {
          throw protocol("Browser action identity does not match stored state");
        }
        if (error instanceof ActionOutcomeUnknownError) throw unknown();
        throw error;
      }
      if (prepared.kind === "cached") return prepared.observation;

      if (context.signal?.aborted) {
        await actions.cancelPrepared(activeRun.runId, proposal.actionId);
        throw cancelled();
      }
      try {
        await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease => {
            await capabilities.inspectBindingWithLease(
              lease,
              bindingInput(activeRun, context),
            );
            await actions.markExecutingWithLease(
              lease,
              activeRun.runId,
              proposal.actionId,
            );
          },
        );
      } catch {
        return terminalizeAfterLeaseFailure(activeRun.runId, proposal.actionId);
      }

      const normalized = normalizeBrowserAction(proposal.operation);
      const request: BrowserActionExecutionV1 =
        actionExecutionRequestSchema.parse({
          version: 1,
          actionId: proposal.actionId,
          runId: activeRun.runId,
          sequence: proposal.sequence,
          normalizedProposalHash: normalized.normalizedProposalHash,
          effect: normalized.effect,
          expectedSessionVersion: activeRun.expectedSessionVersion,
          allowedDomains: activeRun.allowedDomains ?? [],
          operation: proposal.operation,
        });

      try {
        return await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async lease => {
            try {
              const capability = await capabilities.inspectBindingWithLease(
                lease,
                bindingInput(activeRun, context),
              );
              if (context.signal?.aborted) {
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              const now = Date.now();
              const operationDeadline = Math.min(
                context.deadline.getTime(),
                activeRun.deadline.getTime(),
                capability.wallDeadlineAt.getTime(),
                capability.expiresAt.getTime(),
                now + capability.perOperationTimeoutMs,
              );
              if (operationDeadline <= now) {
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              const timeoutSignal = AbortSignal.timeout(
                Math.max(1, operationDeadline - now),
              );
              const operationSignal = context.signal
                ? AbortSignal.any([context.signal, timeoutSignal])
                : timeoutSignal;
              const serviceContext: BrowserServiceRequestContext = {
                correlationId: context.correlationId,
                deadline: new Date(operationDeadline),
                signal: operationSignal,
                processNonce: lease.binding.processNonce,
                controlGenerationNonce: lease.binding.controlGenerationNonce,
              };
              let rawResult: unknown;
              try {
                rawResult = await Promise.race([
                  deps.browserClient.executeAction(
                    activeRun.runtimeSessionId,
                    request,
                    serviceContext,
                  ),
                  new Promise<never>((_resolve, reject) => {
                    const rejectOnAbort = () =>
                      reject(operationSignal.reason ?? unknown());
                    if (operationSignal.aborted) {
                      rejectOnAbort();
                      return;
                    }
                    operationSignal.addEventListener("abort", rejectOnAbort, {
                      once: true,
                    });
                  }),
                ]);
              } catch {
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              let result: BrowserActionExecutionResultV1;
              try {
                result = validateServiceResult(
                  rawResult,
                  proposal,
                  activeRun.expectedSessionVersion,
                );
              } catch {
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              let observation: ObservationV1;
              try {
                observation = await actions.completeWithLease(
                  lease,
                  completionFrom(
                    activeRun.runId,
                    proposal,
                    result,
                    activeRun.expectedSessionVersion,
                  ),
                );
                if (byteLength(observation) > OBSERVATION_LIMIT_BYTES) {
                  return terminalUnknown(
                    lease,
                    activeRun.runId,
                    proposal.actionId,
                  );
                }
              } catch {
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              return observation;
            } catch (error) {
              if (error instanceof CapabilityDeniedError) {
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (
          error instanceof BrowserActionCoordinatorError ||
          error instanceof ActionOutcomeUnknownError
        ) {
          throw unknown();
        }
        return terminalizeAfterLeaseFailure(activeRun.runId, proposal.actionId);
      }
    },
  };
}

/** @public */
export type BrowserActionCoordinator = ReturnType<
  typeof createBrowserActionCoordinator
>;
