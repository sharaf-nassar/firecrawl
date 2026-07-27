import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const testComposition = vi.hoisted(() => ({
  capabilities: null as any,
  stores: null as any,
}));

vi.mock("../browser-state/capability-store", () => ({
  createCapabilityStore: vi.fn(() => testComposition.capabilities),
}));

vi.mock("../browser-state/store", () => ({
  countInteractActions: (...args: unknown[]) =>
    testComposition.stores.countInteractActions(...args),
  finishAdapterRun: (...args: unknown[]) =>
    testComposition.stores.finishAdapterRun(...args),
  failAdapterRun: (...args: unknown[]) =>
    testComposition.stores.failAdapterRun(...args),
  claimBrowserSessionStop: (...args: unknown[]) =>
    testComposition.stores.claimStop(...args),
  renewBrowserSessionStop: (...args: unknown[]) =>
    testComposition.stores.renewStop?.(...args) ?? true,
  finishBrowserSessionStop: (...args: unknown[]) =>
    testComposition.stores.finishStop(...args),
  commitPreparedProfileGeneration: (...args: unknown[]) => {
    if (!testComposition.stores.commitPreparedProfile) {
      throw new Error("Prepared profile store is unavailable");
    }
    return testComposition.stores.commitPreparedProfile(...args);
  },
}));

import { PROMPT_LOOP_POLICY_V1 } from "./protocol";
import { createBrowserSessionOrchestrator as createProductionBrowserSessionOrchestrator } from "./orchestrator";

const TEST_CAPABILITY_TOKEN = "t".repeat(43);

function openGate() {
  return {
    assertOpen: vi.fn(),
    close: vi.fn(),
    open: vi.fn(),
    waitUntilOpen: vi.fn(),
    withDrainedBrowserStateMutation: vi.fn(),
    withBrowserStateMutationLease: vi.fn(async (_scope, operation) =>
      operation({
        transaction: {},
        binding: {},
        epoch: 1,
        scope: "filesystem_and_database",
      }),
    ),
  };
}

function testCapabilities(
  gate: ReturnType<typeof openGate>,
  stores: {
    beginAdapterRun(lease: unknown, input: any): Promise<any>;
    activateAdapterProcess(
      lease: unknown,
      runId: string,
      binding: any,
    ): Promise<any>;
    revokeCapability(lease: unknown, runId: string): Promise<any>;
  },
) {
  return {
    async beginAdapterRun(input: {
      runId: string;
      adapterJobId: string;
      adapterSupervisorId: string;
      adapterProcessId: null;
    }) {
      const pending = await gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => stores.beginAdapterRun(lease, input),
      );
      return {
        token: TEST_CAPABILITY_TOKEN,
        capability: {
          id: randomUUID(),
          ownerId: randomUUID(),
          sessionId: randomUUID(),
          runId: pending.runId,
          adapterJobId: pending.adapterJobId,
          adapterSupervisorId: pending.adapterSupervisorId,
          adapterProcessId: null,
          activatedAt: null,
          revokedAt: null,
          wallDeadlineAt: new Date(Date.now() + 300_000),
          expiresAt: new Date(Date.now() + 300_000),
        },
      };
    },
    activateAdapterProcess(
      runId: string,
      binding: {
        adapterJobId: string;
        adapterSupervisorId: string;
        adapterProcessId: number;
      },
    ) {
      return gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          await stores.activateAdapterProcess(lease, runId, binding);
          return {
            id: randomUUID(),
            ownerId: randomUUID(),
            sessionId: randomUUID(),
            runId,
            ...binding,
            activatedAt: new Date(),
            revokedAt: null,
            wallDeadlineAt: new Date(Date.now() + 300_000),
            expiresAt: new Date(Date.now() + 300_000),
          };
        },
      );
    },
    revoke(runId: string) {
      return gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          await stores.revokeCapability(lease, runId);
          return true;
        },
      );
    },
  };
}

function createBrowserSessionOrchestratorForTest(deps: any, capabilities: any) {
  const { stores, ...productionDependencies } = deps;
  testComposition.stores = stores;
  testComposition.capabilities = capabilities;
  return createProductionBrowserSessionOrchestrator(productionDependencies);
}

function createBrowserSessionOrchestrator(deps: any) {
  const { capabilities, ...productionDependencies } = deps;
  return createBrowserSessionOrchestratorForTest(
    productionDependencies,
    capabilities,
  );
}

describe("browser session orchestrator", () => {
  it("submits one outer prompt job with locked loop policy", async () => {
    const adapter = {
      executePromptRun: vi.fn(async input => {
        expect(input.capabilityToken).toBe(TEST_CAPABILITY_TOKEN);
        await input.onAccepted({
          adapterJobId: input.adapterJobId,
          adapterSupervisorId: input.adapterSupervisorId,
          adapterProcessId: 4242,
        });
        return {
          output: "done",
          turnCount: 1,
          actionCount: 0,
          usage: { inputTokens: 1, outputTokens: 1 },
          protocol: {
            toolEventCount: 0,
            approvalEventCount: 0,
            decisionSchemaVersion: 1,
            observationSchemaVersion: 1,
          },
        } as const;
      }),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const gate = openGate();
    const orchestrator = createBrowserSessionOrchestratorForTest(
      { gate: gate as never, adapter, stores, closeSession: vi.fn() },
      testCapabilities(gate, stores),
    );

    await orchestrator.executePrompt({
      runId: randomUUID(),
      prompt: "inspect",
      initialObservation: {
        version: 1,
        type: "initial",
        sequence: 0,
        page: {
          url: "https://example.com/",
          title: "Example",
          snapshotExcerpt: "",
        },
      },
      deadline: new Date(Date.now() + 30_000),
      correlationId: randomUUID(),
    });

    expect(adapter.executePromptRun).toHaveBeenCalledTimes(1);
    expect(adapter.executePromptRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        decisionSchemaVersion: 1,
        observationSchemaVersion: 1,
        loopPolicy: PROMPT_LOOP_POLICY_V1,
        capabilityToken: TEST_CAPABILITY_TOKEN,
      }),
      expect.any(AbortSignal),
    );
  });

  it("does not hold a mutation lease across host execution", async () => {
    let release!: () => void;
    const host = new Promise<never>(resolve => {
      release = resolve as never;
    });
    const gate = openGate();
    const adapter = {
      executePromptRun: vi.fn(() => host),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const orchestrator = createBrowserSessionOrchestratorForTest(
      { gate: gate as never, adapter, stores, closeSession: vi.fn() },
      testCapabilities(gate, stores),
    );
    const execution = orchestrator.executePrompt({
      runId: randomUUID(),
      prompt: "inspect",
      initialObservation: {
        version: 1,
        type: "initial",
        sequence: 0,
        page: {
          url: "https://example.com/",
          title: "Example",
          snapshotExcerpt: "",
        },
      },
      deadline: new Date(Date.now() + 30_000),
      correlationId: randomUUID(),
    });
    await vi.waitFor(() => expect(adapter.executePromptRun).toHaveBeenCalled());
    expect(gate.withBrowserStateMutationLease).toHaveBeenCalledTimes(1);
    release();
    await expect(execution).rejects.toBeDefined();
  });

  it("keeps the host capability token outside the public boundary", async () => {
    const adapter = {
      executePromptRun: vi.fn(),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const gate = openGate();
    const orchestrator = createBrowserSessionOrchestratorForTest(
      { gate: gate as never, adapter, stores, closeSession: vi.fn() },
      testCapabilities(gate, stores),
    );

    await expect(
      orchestrator.executeCode({
        runId: randomUUID(),
        language: "node",
        source: "return 1",
        deadline: new Date(Date.now() + 30_000),
        correlationId: randomUUID(),
        capabilityToken: "caller-selected",
      } as never),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(stores.beginAdapterRun).not.toHaveBeenCalled();
    expect(adapter.executeCodeRun).not.toHaveBeenCalled();
  });

  it("cancels and rejects a host result without accepted binding", async () => {
    const adapter = {
      executePromptRun: vi.fn(
        async () =>
          ({
            output: "unbound",
            turnCount: 0,
            actionCount: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            protocol: {
              toolEventCount: 0,
              approvalEventCount: 0,
              decisionSchemaVersion: 1,
              observationSchemaVersion: 1,
            },
          }) as const,
      ),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const runId = randomUUID();
    const gate = openGate();
    const orchestrator = createBrowserSessionOrchestratorForTest(
      { gate: gate as never, adapter, stores, closeSession: vi.fn() },
      testCapabilities(gate, stores),
    );

    await expect(
      orchestrator.executePrompt({
        runId,
        prompt: "inspect",
        initialObservation: {
          version: 1,
          type: "initial",
          sequence: 0,
          page: {
            url: "https://example.com/",
            title: "Example",
            snapshotExcerpt: "",
          },
        },
        deadline: new Date(Date.now() + 30_000),
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ category: "capability_denied" });
    expect(adapter.cancelExecutionRun).toHaveBeenCalledWith(
      runId,
      "capability_denied",
    );
    expect(stores.finishAdapterRun).not.toHaveBeenCalled();
    expect(stores.revokeCapability).toHaveBeenCalled();
    expect(stores.failAdapterRun).toHaveBeenCalled();
  });

  it("fences a late result after deadline and confirms cancellation", async () => {
    let release!: (value: {
      stdout: string;
      result: string;
      stderr: string;
      exitCode: number;
      killed: boolean;
    }) => void;
    const lateResult = new Promise<{
      stdout: string;
      result: string;
      stderr: string;
      exitCode: number;
      killed: boolean;
    }>(resolve => {
      release = resolve;
    });
    const adapter = {
      executePromptRun: vi.fn(),
      executeCodeRun: vi.fn(async input => {
        expect(input.capabilityToken).toBe(TEST_CAPABILITY_TOKEN);
        await input.onAccepted({
          adapterJobId: input.adapterJobId,
          adapterSupervisorId: input.adapterSupervisorId,
          adapterProcessId: 4242,
        });
        return lateResult;
      }),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const runId = randomUUID();
    const gate = openGate();
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter,
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(),
    });
    const execution = orchestrator.executeCode({
      runId,
      language: "node",
      source: "return 1",
      deadline: new Date(Date.now() + 20),
      correlationId: randomUUID(),
    });

    await expect(execution).rejects.toMatchObject({ category: "timed_out" });
    release({
      stdout: "",
      result: "late",
      stderr: "",
      exitCode: 0,
      killed: false,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(adapter.cancelExecutionRun).toHaveBeenCalledWith(runId, "timed_out");
    expect(stores.finishAdapterRun).not.toHaveBeenCalled();
  });

  it("does not dispatch when the deadline expires during binding", async () => {
    let releaseBinding!: () => void;
    const bindingBlocked = new Promise<void>(resolve => {
      releaseBinding = resolve;
    });
    const gate = openGate();
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => {
        await bindingBlocked;
        return input;
      }),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const adapter = {
      executePromptRun: vi.fn(),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter,
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(),
    });
    const deadline = new Date(Date.now() + 30_000);
    const execution = orchestrator.executeCode({
      runId: randomUUID(),
      language: "node",
      source: "",
      deadline,
      correlationId: randomUUID(),
    });
    await vi.waitFor(() => expect(stores.beginAdapterRun).toHaveBeenCalled());
    const dateNow = vi
      .spyOn(Date, "now")
      .mockReturnValue(deadline.getTime() + 1);
    releaseBinding();
    try {
      await expect(execution).rejects.toMatchObject({ category: "timed_out" });
    } finally {
      dateNow.mockRestore();
    }
    expect(adapter.executeCodeRun).not.toHaveBeenCalled();
    expect(adapter.cancelExecutionRun).not.toHaveBeenCalled();
    expect(stores.finishAdapterRun).not.toHaveBeenCalled();
    expect(stores.revokeCapability).toHaveBeenCalled();
    expect(stores.failAdapterRun).toHaveBeenCalled();
  });

  it("elects one durable stop owner and always runs terminal cleanup", async () => {
    const runId = randomUUID();
    const sessionId = randomUUID();
    const adapter = {
      executePromptRun: vi.fn(),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(async () => ({
        runId,
        profileId: null,
        browserId: "browser-1",
        runtimeEpoch: 1,
      })),
      finishStop: vi.fn(),
    };
    const closeSession = vi.fn(async () => {
      throw new Error("service close failed");
    });
    const gate = openGate();
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter,
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession,
    });

    const first = orchestrator.stopSession(sessionId, "requested");
    const second = orchestrator.stopSession(sessionId, "requested");
    await expect(first).rejects.toThrow("Browser stop cleanup failed");
    await expect(second).rejects.toThrow("Browser stop cleanup failed");
    expect(stores.claimStop).toHaveBeenCalledTimes(1);
    expect(adapter.cancelExecutionRun).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(stores.revokeCapability).toHaveBeenCalledWith(
      expect.anything(),
      runId,
    );
    expect(stores.finishStop).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      sessionId,
      "requested",
      "interrupted",
    );
  });

  it("rolls back exact runtime and durable state under leases", async () => {
    const runtime = { browserId: "runtime" };
    const createDurable = vi.fn();
    const createRuntime = vi.fn(async () => runtime);
    const transitionToReplaying = vi.fn();
    const attachRuntime = vi.fn(async () => {
      throw new Error("attach failed");
    });
    const materializeReplay = vi.fn();
    const transitionToReady = vi.fn();
    const rollbackRuntime = vi.fn();
    const rollbackDurable = vi.fn();
    const gate = openGate();
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter: {
        executePromptRun: vi.fn(),
        executeCodeRun: vi.fn(),
        cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
      },
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(),
    });

    await expect(
      orchestrator.createDirectSession({
        sessionId: randomUUID(),
        createDurable,
        transitionToReplaying,
        createRuntime,
        attachRuntime,
        materializeReplay,
        transitionToReady,
        rollbackRuntime,
        rollbackDurable,
      }),
    ).rejects.toThrow("attach failed");
    expect(rollbackRuntime).toHaveBeenCalledWith(expect.anything(), runtime);
    expect(rollbackDurable).toHaveBeenCalledWith(expect.anything());
  });

  it("does not bind or dispatch a pre-aborted execution", async () => {
    const gate = openGate();
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const adapter = {
      executePromptRun: vi.fn(),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter,
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(),
    });
    const controller = new AbortController();
    controller.abort(
      Object.assign(new Error("already cancelled"), { category: "cancelled" }),
    );

    await expect(
      orchestrator.executeCode({
        runId: randomUUID(),
        language: "node",
        source: "",
        deadline: new Date(Date.now() + 30_000),
        correlationId: randomUUID(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ category: "cancelled" });
    expect(stores.beginAdapterRun).not.toHaveBeenCalled();
    expect(adapter.executeCodeRun).not.toHaveBeenCalled();
  });

  it("sanitizes malformed accepted bindings as capability denial", async () => {
    const gate = openGate();
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const adapter = {
      executePromptRun: vi.fn(),
      executeCodeRun: vi.fn(async input => {
        await input.onAccepted({
          adapterJobId: input.adapterJobId,
          adapterSupervisorId: input.adapterSupervisorId,
          adapterProcessId: 0,
        });
        throw new Error("unreachable");
      }),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter,
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(),
    });

    await expect(
      orchestrator.executeCode({
        runId: randomUUID(),
        language: "node",
        source: "",
        deadline: new Date(Date.now() + 30_000),
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      category: "capability_denied",
      message: "Browser capability was denied",
    });
    expect(stores.activateAdapterProcess).not.toHaveBeenCalled();
  });

  it("reserves interact lifetime and advances every creation phase", async () => {
    const gate = openGate();
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(),
      finishStop: vi.fn(),
    };
    const phases: string[] = [];
    const runtime = { browserId: "browser-1" };
    const reserveLifetime = vi.fn(async (_lease, lifetime) => {
      expect(lifetime).toMatchObject({
        ttlSeconds: 3_600,
        activityTtlSeconds: 600,
      });
      phases.push("reserve");
    });
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter: {
        executePromptRun: vi.fn(),
        executeCodeRun: vi.fn(),
        cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
      },
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(),
    });

    await expect(
      orchestrator.createDirectSession({
        sessionId: randomUUID(),
        mode: "interact",
        reserveLifetime,
        createDurable: vi.fn(async () => phases.push("durable")),
        acquireProfileWriter: vi.fn(async () => phases.push("writer")),
        transitionToReplaying: vi.fn(async () => phases.push("replaying")),
        createRuntime: vi.fn(async () => {
          phases.push("runtime");
          return runtime;
        }),
        attachRuntime: vi.fn(async () => phases.push("attached")),
        materializeReplay: vi.fn(async () => phases.push("materialized")),
        transitionToReady: vi.fn(async () => {
          phases.push("ready");
          return runtime;
        }),
        rollbackRuntime: vi.fn(),
        rollbackProfileWriter: vi.fn(),
        rollbackDurable: vi.fn(),
      }),
    ).resolves.toBe(runtime);
    expect(phases).toEqual([
      "reserve",
      "durable",
      "writer",
      "replaying",
      "runtime",
      "attached",
      "materialized",
      "ready",
    ]);
  });

  it("stops direct no-run sessions without cancelling an adapter", async () => {
    const gate = openGate();
    const sessionId = randomUUID();
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(async () => ({
        runId: null,
        profileId: null,
        browserId: "browser-1",
        runtimeEpoch: 1,
      })),
      finishStop: vi.fn(),
    };
    const adapter = {
      executePromptRun: vi.fn(),
      executeCodeRun: vi.fn(),
      cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
    };
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter,
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(),
    });

    await orchestrator.stopSession(sessionId, "requested");
    expect(adapter.cancelExecutionRun).not.toHaveBeenCalled();
    expect(stores.finishStop).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      sessionId,
      "requested",
      "destroyed",
    );
  });

  it("interrupts a profile-bearing stop with no prepared profile", async () => {
    const gate = openGate();
    const sessionId = randomUUID();
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(async () => ({
        runId: null,
        profileId: randomUUID(),
        requiresPreparedProfile: true,
        browserId: "browser-1",
        runtimeEpoch: 1,
      })),
      finishStop: vi.fn(),
    };
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter: {
        executePromptRun: vi.fn(),
        executeCodeRun: vi.fn(),
        cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
      },
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(async () => ({ preparedProfile: null })),
    });

    await expect(
      orchestrator.stopSession(sessionId, "requested"),
    ).rejects.toThrow("Browser stop cleanup failed");
    expect(stores.finishStop).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      sessionId,
      "requested",
      "interrupted",
    );
    expect(stores.finishStop).not.toHaveBeenCalledWith(
      expect.anything(),
      sessionId,
      "requested",
      "destroyed",
    );
  });

  it("discards a finalized profile orphan and marks cleanup interrupted", async () => {
    const gate = openGate();
    const sessionId = randomUUID();
    const profileId = randomUUID();
    const prepared = {
      profileId,
      generationId: randomUUID(),
      checksum: "a".repeat(64),
      byteSize: 1024,
      prepareToken: "p".repeat(43),
    };
    const stores = {
      beginAdapterRun: vi.fn(async (_lease, input) => input),
      activateAdapterProcess: vi.fn(),
      countInteractActions: vi.fn(async () => 0),
      finishAdapterRun: vi.fn(),
      failAdapterRun: vi.fn(),
      revokeCapability: vi.fn(),
      claimStop: vi.fn(async () => ({
        runId: null,
        profileId,
        browserId: "browser-1",
        runtimeEpoch: 1,
      })),
      finishStop: vi.fn(),
      commitPreparedProfile: vi.fn(async () => {
        throw new Error("pointer CAS failed");
      }),
    };
    const discardProfile = vi.fn();
    const orchestrator = createBrowserSessionOrchestrator({
      gate: gate as never,
      adapter: {
        executePromptRun: vi.fn(),
        executeCodeRun: vi.fn(),
        cancelExecutionRun: vi.fn(async () => ({ killed: true as const })),
      },
      stores,
      capabilities: testCapabilities(gate, stores),
      closeSession: vi.fn(async () => ({ preparedProfile: prepared })),
      finalizeProfile: vi.fn(),
      discardProfile,
    });

    await expect(
      orchestrator.stopSession(sessionId, "requested"),
    ).rejects.toThrow("Browser stop cleanup failed");
    expect(discardProfile).toHaveBeenCalledWith(prepared);
    expect(stores.finishStop).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      sessionId,
      "requested",
      "interrupted",
    );
  });
});
