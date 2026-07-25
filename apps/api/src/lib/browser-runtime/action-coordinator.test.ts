import { describe, expect, it, vi } from "vitest";

import type { ActiveBrowserRunAuthority } from "../browser-state/store";
import type { SubmitBrowserActionV1 } from "../browser-state/types";
import { normalizeBrowserAction } from "./action-normalization";
import { createBrowserActionCoordinator } from "./action-coordinator";

const ID = (tail: number) =>
  `10000000-0000-4000-8000-${tail.toString().padStart(12, "0")}`;

const run: ActiveBrowserRunAuthority = {
  runId: ID(1),
  ownerId: ID(2),
  sessionId: ID(3),
  runtimeSessionId: ID(4),
  expectedSessionVersion: 1,
  adapterJobId: ID(5),
  adapterSupervisorId: ID(6),
  adapterProcessId: 42,
  deadline: new Date(Date.now() + 60_000),
  perOperationTimeoutMs: 30_000,
  zeroDataRetention: false,
};

function proposal(): SubmitBrowserActionV1 {
  const operation = { kind: "get_url" } as const;
  const normalized = normalizeBrowserAction(operation);
  return {
    version: 1,
    adapterJobId: run.adapterJobId,
    sequence: 1,
    actionId: ID(7),
    proposalHash: normalized.normalizedProposalHash,
    effect: normalized.effect,
    operation,
  };
}

const context = {
  adapterSupervisorId: run.adapterSupervisorId,
  adapterProcessId: run.adapterProcessId,
  correlationId: ID(8),
  deadline: new Date(Date.now() + 60_000),
};

describe("browser action coordinator", () => {
  it("persists prepared before one Browser Service dispatch", async () => {
    const events: string[] = [];
    const request = proposal();
    const observation = {
      version: 1 as const,
      type: "action_result" as const,
      sequence: 1,
      actionId: request.actionId,
      actionKind: "get_url" as const,
      outcome: "succeeded" as const,
      result: { kind: "get_url" as const, url: "https://example.com/" },
      page: {
        url: "https://example.com/",
        title: "Example",
        snapshotExcerpt: "Example",
      },
    };
    const actions = {
      getByIdentity: vi.fn().mockResolvedValue(null),
      prepareWithLease: vi.fn(async () => {
        events.push("insert:prepared");
        return { kind: "prepared", action: {} };
      }),
      markExecutingWithLease: vi.fn(async () => {
        events.push("transition:executing");
      }),
      completeWithLease: vi.fn(async () => {
        events.push("transition:succeeded");
        return observation;
      }),
      markOutcomeUnknown: vi.fn(),
      markOutcomeUnknownWithLease: vi.fn(),
      cancelPrepared: vi.fn(),
    };
    const capabilities = {
      redeemActionWithLease: vi.fn(async () => {
        events.push("authorize");
      }),
      inspectBinding: vi.fn(),
      inspectBindingWithLease: vi.fn().mockResolvedValue({
        wallDeadlineAt: new Date(Date.now() + 60_000),
        expiresAt: new Date(Date.now() + 60_000),
        perOperationTimeoutMs: 30_000,
      }),
    };
    const browserClient = {
      executeAction: vi.fn(async () => {
        events.push("service:executeAction");
        return {
          version: 1,
          actionId: request.actionId,
          sequence: 1,
          normalizedProposalHash: request.proposalHash,
          outcome: "succeeded",
          result: observation.result,
          page: observation.page,
          sessionVersion: 2,
        };
      }),
    };
    const gate = {
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
        operation({
          binding: {
            processNonce: "p",
            controlGenerationNonce: "g",
          },
        }),
      ),
    };
    const coordinator = createBrowserActionCoordinator({
      gate: gate as never,
      browserClient: browserClient as never,
      actions: actions as never,
      capabilities: capabilities as never,
    });
    await expect(
      coordinator.handleProposal(run, request, context),
    ).resolves.toEqual(observation);
    expect(events).toEqual([
      "insert:prepared",
      "authorize",
      "transition:executing",
      "service:executeAction",
      "transition:succeeded",
    ]);
    expect(browserClient.executeAction).toHaveBeenCalledTimes(1);
    expect(actions.completeWithLease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedSessionVersion: 1,
        sessionVersion: 2,
      }),
    );
  });

  it("returns known matching callback replay without redispatch", async () => {
    const request = proposal();
    const cached = {
      version: 1 as const,
      type: "action_result" as const,
      sequence: 1,
      actionId: request.actionId,
      actionKind: "get_url" as const,
      outcome: "failed_no_effect" as const,
      error: { category: "target_blocked", message: "Blocked" },
      page: { url: "https://example.com/", title: "", snapshotExcerpt: "" },
    };
    const browserClient = { executeAction: vi.fn() };
    const coordinator = createBrowserActionCoordinator({
      gate: {
        withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
          operation({}),
        ),
      } as never,
      browserClient: browserClient as never,
      actions: {
        getByIdentity: vi.fn().mockResolvedValue(null),
        prepareWithLease: vi
          .fn()
          .mockResolvedValue({ kind: "cached", observation: cached }),
      } as never,
      capabilities: {} as never,
    });
    await expect(
      coordinator.handleProposal(run, request, context),
    ).resolves.toEqual(cached);
    expect(browserClient.executeAction).not.toHaveBeenCalled();
  });

  it("marks unsafe service output outcome unknown and never caches it", async () => {
    const request = proposal();
    const actions = {
      getByIdentity: vi.fn().mockResolvedValue(null),
      prepareWithLease: vi
        .fn()
        .mockResolvedValue({ kind: "prepared", action: {} }),
      markExecutingWithLease: vi.fn(),
      completeWithLease: vi.fn(),
      markOutcomeUnknown: vi.fn(),
      markOutcomeUnknownWithLease: vi.fn(),
      cancelPrepared: vi.fn(),
    };
    const coordinator = createBrowserActionCoordinator({
      gate: {
        withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
          operation({
            binding: {
              processNonce: "p",
              controlGenerationNonce: "g",
            },
          }),
        ),
      } as never,
      browserClient: {
        executeAction: vi.fn().mockResolvedValue({ invalid: true }),
      } as never,
      actions: actions as never,
      capabilities: {
        redeemActionWithLease: vi.fn(),
        inspectBinding: vi.fn(),
        inspectBindingWithLease: vi.fn().mockResolvedValue({
          wallDeadlineAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 60_000),
          perOperationTimeoutMs: 30_000,
        }),
      } as never,
    });
    await expect(
      coordinator.handleProposal(run, request, context),
    ).rejects.toMatchObject({ category: "action_outcome_unknown" });
    expect(actions.markOutcomeUnknownWithLease).toHaveBeenCalled();
    expect(actions.completeWithLease).not.toHaveBeenCalled();
  });

  it("preserves action 26 as action_limit_exceeded before strict parsing", async () => {
    const actions = { getByIdentity: vi.fn() };
    const coordinator = createBrowserActionCoordinator({
      gate: {} as never,
      browserClient: {} as never,
      actions: actions as never,
      capabilities: {} as never,
    });
    await expect(
      coordinator.handleProposal(
        run,
        {
          version: 1,
          adapterJobId: run.adapterJobId,
          sequence: 26,
          actionId: ID(9),
          proposalHash: "not-even-a-hash",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "action_limit_exceeded" });
    expect(actions.getByIdentity).not.toHaveBeenCalled();
  });

  it("terminalizes a mismatched service session version", async () => {
    const request = proposal();
    const actions = {
      getByIdentity: vi.fn().mockResolvedValue(null),
      prepareWithLease: vi
        .fn()
        .mockResolvedValue({ kind: "prepared", action: {} }),
      markExecutingWithLease: vi.fn(),
      completeWithLease: vi.fn(),
      markOutcomeUnknown: vi.fn(),
      markOutcomeUnknownWithLease: vi.fn(),
      cancelPrepared: vi.fn(),
    };
    const coordinator = createBrowserActionCoordinator({
      gate: {
        withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
          operation({
            binding: {
              processNonce: "p",
              controlGenerationNonce: "g",
            },
          }),
        ),
      } as never,
      browserClient: {
        executeAction: vi.fn().mockResolvedValue({
          version: 1,
          actionId: request.actionId,
          sequence: request.sequence,
          normalizedProposalHash: request.proposalHash,
          outcome: "failed_no_effect",
          error: { category: "target_blocked", message: "Blocked" },
          page: { url: "https://example.com/", title: "", snapshotExcerpt: "" },
          sessionVersion: 2,
        }),
      } as never,
      actions: actions as never,
      capabilities: {
        redeemActionWithLease: vi.fn(),
        inspectBindingWithLease: vi.fn().mockResolvedValue({
          wallDeadlineAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 60_000),
          perOperationTimeoutMs: 30_000,
        }),
      } as never,
    });
    await expect(
      coordinator.handleProposal(run, request, context),
    ).rejects.toMatchObject({ category: "action_outcome_unknown" });
    expect(actions.markOutcomeUnknownWithLease).toHaveBeenCalledTimes(1);
    expect(actions.completeWithLease).not.toHaveBeenCalled();
  });

  it("enforces persisted per-operation timeout and aborts dispatch", async () => {
    const request = proposal();
    const actions = {
      getByIdentity: vi.fn().mockResolvedValue(null),
      prepareWithLease: vi
        .fn()
        .mockResolvedValue({ kind: "prepared", action: {} }),
      markExecutingWithLease: vi.fn(),
      completeWithLease: vi.fn(),
      markOutcomeUnknown: vi.fn(),
      markOutcomeUnknownWithLease: vi.fn(),
      cancelPrepared: vi.fn(),
    };
    let observedSignal: AbortSignal | undefined;
    const coordinator = createBrowserActionCoordinator({
      gate: {
        withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
          operation({
            binding: {
              processNonce: "p",
              controlGenerationNonce: "g",
            },
          }),
        ),
      } as never,
      browserClient: {
        executeAction: vi.fn(async (_session, _action, serviceContext) => {
          observedSignal = serviceContext.signal;
          return new Promise(() => undefined);
        }),
      } as never,
      actions: actions as never,
      capabilities: {
        redeemActionWithLease: vi.fn(),
        inspectBindingWithLease: vi.fn().mockResolvedValue({
          wallDeadlineAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 60_000),
          perOperationTimeoutMs: 5,
        }),
      } as never,
    });
    await expect(
      coordinator.handleProposal(run, request, context),
    ).rejects.toMatchObject({ category: "action_outcome_unknown" });
    expect(observedSignal?.aborted).toBe(true);
    expect(actions.markOutcomeUnknownWithLease).toHaveBeenCalledTimes(1);
  });

  it("durably terminalizes when the third lease cannot be acquired", async () => {
    const request = proposal();
    const actions = {
      getByIdentity: vi.fn().mockResolvedValue(null),
      prepareWithLease: vi
        .fn()
        .mockResolvedValue({ kind: "prepared", action: {} }),
      markExecutingWithLease: vi.fn(),
      completeWithLease: vi.fn(),
      markOutcomeUnknown: vi.fn(),
      markOutcomeUnknownWithLease: vi.fn(),
      cancelPrepared: vi.fn(),
    };
    let leases = 0;
    const gate = {
      withBrowserStateMutationLease: vi.fn(async (_scope, operation) => {
        leases += 1;
        if (leases === 3) throw new Error("lease unavailable");
        return operation({
          binding: {
            processNonce: "p",
            controlGenerationNonce: "g",
          },
        });
      }),
      assertOpen: vi.fn(),
      close: vi.fn(),
    };
    const browserClient = { executeAction: vi.fn() };
    const coordinator = createBrowserActionCoordinator({
      gate: gate as never,
      browserClient: browserClient as never,
      actions: actions as never,
      capabilities: {
        redeemActionWithLease: vi.fn(),
        inspectBindingWithLease: vi.fn().mockResolvedValue({}),
      } as never,
    });
    await expect(
      coordinator.handleProposal(run, request, context),
    ).rejects.toMatchObject({ category: "action_outcome_unknown" });
    expect(browserClient.executeAction).not.toHaveBeenCalled();
    expect(actions.markOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(gate.close).not.toHaveBeenCalled();
  });
});
