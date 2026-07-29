import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

import type { ArtifactStore } from "../artifacts";
import { persistBrowserArtifactManifestWithLease } from "../artifacts/local-manifest";
import { putArtifactWithManifest } from "../artifacts/manifest";
import {
  ActionIdentityMismatchError,
  ActionLimitExceededError,
  ActionOutcomeUnknownError,
  createBrowserActionStore,
  type ActiveBrowserRunAuthority,
  type CompleteBrowserActionInput,
} from "../browser-state/store";
import { logger as rootLogger } from "../logger";
import type {
  ObservationV1,
  SubmitBrowserActionV1,
} from "../browser-state/types";
import {
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  artifactMetadataV1Schema,
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
type CoordinatorContext = {
  correlationId: string;
  deadline: Date;
  signal?: AbortSignal;
};

type ActionCoordinatorDependencies = {
  gate: BrowserStartupGate;
  browserClient: Pick<BrowserServiceClient, "executeAction" | "fetchArtifact">;
  artifactStore: ArtifactStore | null;
  actions?: ActionStore;
};

function screenshotObjectKey(
  run: ActiveBrowserRunAuthority,
  artifactId: string,
): string {
  return `browser-interact/${run.ownerId}/${run.runId}/${artifactId}.png`;
}

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

function assertAuthority(
  run: ActiveBrowserRunAuthority,
  proposal: SubmitBrowserActionV1,
): void {
  if (proposal.adapterJobId !== run.adapterJobId) {
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
    async loadScreenshot(
      activeRun: ActiveBrowserRunAuthority,
      observation: ObservationV1,
    ): Promise<
      Readonly<{
        metadata: Readonly<{
          artifactId: string;
          contentType: "image/png";
          byteSize: number;
          checksum: string;
        }>;
        bytes: Uint8Array;
      }>
    > {
      if (
        observation.type !== "action_result" ||
        observation.outcome !== "succeeded" ||
        observation.actionKind !== "screenshot" ||
        observation.result?.kind !== "screenshot" ||
        observation.actionId !== observation.result.artifactId ||
        deps.artifactStore === null
      ) {
        throw protocol("Screenshot authority is invalid");
      }
      const metadata = observation.result;
      const bytes = await deps.artifactStore.get(
        screenshotObjectKey(activeRun, metadata.artifactId),
      );
      if (
        bytes === null ||
        bytes.byteLength !== metadata.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== metadata.checksum
      ) {
        throw unknown();
      }
      return {
        metadata: {
          artifactId: metadata.artifactId,
          contentType: metadata.contentType,
          byteSize: metadata.byteSize,
          checksum: metadata.checksum,
        },
        bytes: Uint8Array.from(bytes),
      };
    },

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
      assertAuthority(activeRun, proposal);

      let prepared: Awaited<ReturnType<ActionStore["prepare"]>>;
      try {
        prepared = await deps.gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          lease => actions.prepareWithLease(lease, activeRun.runId, proposal),
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
          lease =>
            actions.markExecutingWithLease(
              lease,
              activeRun.runId,
              proposal.actionId,
            ),
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
              if (context.signal?.aborted) {
                rootLogger.warn("Browser action phase had no dispatch budget", {
                  correlationId: context.correlationId,
                  runId: activeRun.runId,
                  actionId: proposal.actionId,
                  sequence: proposal.sequence,
                  operationKind: proposal.operation.kind,
                  deadlineSource: "request_signal",
                  phaseBudgetMs: 0,
                });
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              const now = Date.now();
              const deadlineCandidates = [
                {
                  source: "request" as const,
                  at: context.deadline.getTime(),
                },
                {
                  source: "run" as const,
                  at: activeRun.deadline.getTime(),
                },
                {
                  source: "operation" as const,
                  at: now + activeRun.perOperationTimeoutMs,
                },
              ];
              const selectedDeadline = deadlineCandidates.reduce(
                (selected, candidate) =>
                  candidate.at < selected.at ? candidate : selected,
              );
              const operationDeadline = selectedDeadline.at;
              if (operationDeadline <= now) {
                rootLogger.warn("Browser action phase had no dispatch budget", {
                  correlationId: context.correlationId,
                  runId: activeRun.runId,
                  actionId: proposal.actionId,
                  sequence: proposal.sequence,
                  operationKind: proposal.operation.kind,
                  deadlineSource: selectedDeadline.source,
                  phaseBudgetMs: 0,
                });
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
              const actionStartedAt = Date.now();
              const diagnostic = {
                correlationId: context.correlationId,
                runId: activeRun.runId,
                actionId: proposal.actionId,
                sequence: proposal.sequence,
                operationKind: proposal.operation.kind,
                deadlineSource: selectedDeadline.source,
                phaseBudgetMs: Math.max(0, operationDeadline - actionStartedAt),
              };
              rootLogger.info("Browser action phase started", {
                ...diagnostic,
                phase: "browser_service_execute",
              });
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
                rootLogger.warn("Browser action phase outcome is unknown", {
                  ...diagnostic,
                  phase: "browser_service_execute",
                  durationMs: Date.now() - actionStartedAt,
                  deadlineReached:
                    operationSignal.aborted || Date.now() >= operationDeadline,
                });
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              rootLogger.info("Browser action phase completed", {
                ...diagnostic,
                phase: "browser_service_execute",
                durationMs: Date.now() - actionStartedAt,
              });
              let result: BrowserActionExecutionResultV1;
              try {
                result = validateServiceResult(
                  rawResult,
                  proposal,
                  activeRun.expectedSessionVersion,
                );
              } catch {
                rootLogger.warn("Browser action response validation failed", {
                  ...diagnostic,
                  phase: "validate_service_result",
                  durationMs: Date.now() - actionStartedAt,
                });
                return terminalUnknown(
                  lease,
                  activeRun.runId,
                  proposal.actionId,
                );
              }
              if (
                result.outcome === "succeeded" &&
                result.result.kind === "screenshot"
              ) {
                if (
                  deps.artifactStore === null ||
                  result.result.artifactId !== proposal.actionId
                ) {
                  return terminalUnknown(
                    lease,
                    activeRun.runId,
                    proposal.actionId,
                  );
                }
                try {
                  const artifact = await deps.browserClient.fetchArtifact(
                    activeRun.runtimeSessionId,
                    {
                      version: 1,
                      artifactId: result.result.artifactId,
                      kind: "screenshot",
                      format: "png",
                      fullPage:
                        proposal.operation.kind === "screenshot"
                          ? (proposal.operation.fullPage ?? false)
                          : false,
                    },
                    serviceContext,
                  );
                  const metadata = artifactMetadataV1Schema.parse(
                    artifact.metadata,
                  );
                  if (
                    metadata.kind !== "screenshot" ||
                    metadata.contentType !== result.result.contentType ||
                    metadata.byteSize !== result.result.byteSize ||
                    metadata.checksum !== result.result.checksum
                  ) {
                    return terminalUnknown(
                      lease,
                      activeRun.runId,
                      proposal.actionId,
                    );
                  }
                  const objectKey = screenshotObjectKey(
                    activeRun,
                    metadata.artifactId,
                  );
                  await putArtifactWithManifest(
                    deps.artifactStore,
                    {
                      key: objectKey,
                      body: Buffer.from(artifact.bytes),
                      contentType: metadata.contentType,
                      metadata: {
                        artifactId: metadata.artifactId,
                        checksum: metadata.checksum,
                      },
                      ownerId: activeRun.ownerId,
                      requestId: activeRun.requestId,
                      jobId: activeRun.runId,
                      kind: "browser-screenshot",
                      checksum: metadata.checksum,
                      deleteAfter: activeRun.deleteAfter,
                    },
                    async (_key, work) =>
                      work({
                        existed: false,
                        persist: record =>
                          persistBrowserArtifactManifestWithLease(
                            lease,
                            record,
                          ),
                      }),
                  );
                } catch {
                  return terminalUnknown(
                    lease,
                    activeRun.runId,
                    proposal.actionId,
                  );
                }
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
            } catch {
              return terminalUnknown(lease, activeRun.runId, proposal.actionId);
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
