import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  API_INSTANCE_ID,
  BrowserServiceClientError,
} from "../scrape-interact/browser-service-client";
import { createBrowserReconciliationCoordinator } from "./reconciliation-coordinator";

const processNonce = Buffer.alloc(32, 1).toString("base64url");
const controlGenerationNonce = Buffer.alloc(32, 2).toString("base64url");
const snapshotDigest = "a".repeat(64);

describe("BrowserReconciliationCoordinator", () => {
  it("abandons a handoff when scoped live moves to a new process", async () => {
    const nextProcessNonce = Buffer.alloc(32, 3).toString("base64url");
    const nextControlNonce = Buffer.alloc(32, 4).toString("base64url");
    let discoveredProcess = processNonce;
    const gate = {
      close: vi.fn(() => ({ epoch: 1, drained: Promise.resolve() })),
    };
    const pool = { connect: vi.fn() };
    const interrupt = vi.fn();
    const loadSnapshot = vi.fn();
    const serviceClient = {
      discoverLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce: discoveredProcess,
      })),
      createControlGeneration: vi.fn(async request => ({
        version: 1 as const,
        processNonce: request.processNonce,
        controlGenerationNonce:
          request.processNonce === processNonce
            ? controlGenerationNonce
            : nextControlNonce,
        apiInstanceId: request.apiInstanceId,
      })),
      getLive: vi.fn(async context => {
        if (context.processNonce === processNonce) {
          discoveredProcess = nextProcessNonce;
          throw new BrowserServiceClientError(
            "control_generation_mismatch",
            "stale",
            409,
          );
        }
        return {
          version: 1 as const,
          status: "live_unreconciled" as const,
          processNonce: nextProcessNonce,
          controlGenerationNonce: nextControlNonce,
        };
      }),
      reconcile: vi.fn(),
      getReady: vi.fn(),
    };
    const sleeps: number[] = [];
    const coordinator = createBrowserReconciliationCoordinator({
      gate: gate as never,
      pool: pool as never,
      filesystem: { delete: vi.fn() } as never,
      inspectProcessIdentity: vi.fn() as never,
      serviceClient,
      loadSnapshot,
      interruptUnfinishedBrowserWork: interrupt,
      recoverBrowserCleanupIntentsBeforeSnapshot: vi.fn(),
      pauseBrowserRetention: vi.fn(async () => undefined),
      startBrowserRetention: vi.fn(async () => undefined),
      retry: {
        maxAttempts: 4,
        initialBackoffMs: 250,
        maxBackoffMs: 1_000,
        startupBudgetMs: 60_000,
        monitorIntervalMs: 60_000,
        retryCooldownMs: 30_000,
      },
      now: () => Date.now(),
      sleep: vi.fn(async milliseconds => {
        sleeps.push(milliseconds);
      }),
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });

    await expect(coordinator.acquireControlGeneration()).resolves.toMatchObject(
      {
        processNonce: nextProcessNonce,
        controlGenerationNonce: nextControlNonce,
      },
    );
    expect(serviceClient.createControlGeneration).toHaveBeenCalledTimes(2);
    expect(
      serviceClient.createControlGeneration.mock.calls[0]?.[0].idempotencyKey,
    ).not.toBe(
      serviceClient.createControlGeneration.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(sleeps).toEqual([250]);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("performs zero recovery after a newer durable activation wins", async () => {
    const newerProcessNonce = Buffer.alloc(32, 3).toString("base64url");
    const newerControlNonce = Buffer.alloc(32, 4).toString("base64url");
    const drain = { epoch: 1, drained: Promise.resolve() };
    const gate = {
      close: vi.fn(() => drain),
      open: vi.fn(),
      withDrainedBrowserStateMutation: vi.fn(async (_drain, callback) =>
        callback({
          epoch: 1,
          scope: "filesystem_and_database",
          binding: {
            apiInstanceId: "11111111-1111-4111-8111-111111111111",
            databaseControlEpoch: 2,
            processNonce: newerProcessNonce,
            controlGenerationNonce: newerControlNonce,
            snapshotDigest,
          },
          transaction: {
            query: vi.fn(async () => ({ rows: [] })),
            databaseControlEpoch: 2,
          },
        }),
      ),
    };
    const databaseClient = {
      query: vi.fn(async (text: string) =>
        text.includes("FROM browser_control_generation")
          ? { rows: [] }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => databaseClient) };
    const serviceClient = {
      discoverLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce,
      })),
      createControlGeneration: vi.fn(async request => ({
        version: 1 as const,
        processNonce,
        controlGenerationNonce,
        apiInstanceId: request.apiInstanceId,
      })),
      getLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce,
        controlGenerationNonce,
      })),
      reconcile: vi.fn(),
      getReady: vi.fn(),
    };
    const interrupt = vi.fn();
    const recover = vi.fn();
    const loadSnapshot = vi.fn();
    const coordinator = createBrowserReconciliationCoordinator({
      gate: gate as never,
      pool: pool as never,
      filesystem: { delete: vi.fn() } as never,
      inspectProcessIdentity: vi.fn() as never,
      serviceClient,
      loadSnapshot,
      interruptUnfinishedBrowserWork: interrupt,
      recoverBrowserCleanupIntentsBeforeSnapshot: recover,
      pauseBrowserRetention: vi.fn(async () => undefined),
      startBrowserRetention: vi.fn(async () => undefined),
      retry: {
        maxAttempts: 4,
        initialBackoffMs: 250,
        maxBackoffMs: 1_000,
        startupBudgetMs: 60_000,
        monitorIntervalMs: 60_000,
        retryCooldownMs: 30_000,
      },
      now: () => Date.now(),
      sleep: vi.fn(async () => undefined),
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });

    const handoff = await coordinator.acquireControlGeneration();
    await expect(
      coordinator.initializeAfterMigrations(handoff),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
    expect(interrupt).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(serviceClient.reconcile).not.toHaveBeenCalled();
    expect(gate.open).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("passes explicit fenced dependencies through recovery and snapshot", async () => {
    const transactionQuery = vi.fn(async () => ({ rows: [] }));
    const drain = { epoch: 1, drained: Promise.resolve() };
    const gate = {
      assertOpen: vi.fn(),
      close: vi.fn(() => drain),
      open: vi.fn(),
      waitUntilOpen: vi.fn(),
      withBrowserStateMutationLease: vi.fn(),
      withDrainedBrowserStateMutation: vi.fn(async (_drain, callback) =>
        callback({
          epoch: 1,
          scope: "filesystem_and_database",
          binding: {
            apiInstanceId: API_INSTANCE_ID,
            databaseControlEpoch: 1,
            processNonce,
            controlGenerationNonce,
            snapshotDigest,
          },
          transaction: {
            query: transactionQuery,
            databaseControlEpoch: 1,
          },
        }),
      ),
    };
    const databaseClient = {
      query: vi.fn(async (text: string) =>
        text.includes("FROM browser_control_generation")
          ? { rows: [] }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => databaseClient) };
    const filesystem = { delete: vi.fn() };
    const inspectProcessIdentity = vi.fn();
    const loadSnapshot = vi.fn(async receivedPool => {
      expect(receivedPool).toBe(pool);
      return { snapshotDigest, references: [] };
    });
    const recover = vi.fn(async input => {
      expect(input.filesystem).toBe(filesystem);
      expect(input.inspectProcessIdentity).toBe(inspectProcessIdentity);
      expect(input.signal).toBeInstanceOf(AbortSignal);
      const recoveryClient = await input.pool.connect();
      await recoveryClient.query("SELECT 1");
      expect(transactionQuery).toHaveBeenCalledWith(
        expect.stringContaining("statement_timeout"),
        expect.any(Array),
      );
      expect(transactionQuery).toHaveBeenLastCalledWith("SELECT 1", undefined);
      return {
        liveRetained: 0,
        unknownRetained: 0,
        deadRecovered: 0,
        missingConverged: 0,
      };
    });
    const reconcileBodies: string[] = [];
    const serviceClient = {
      discoverLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce,
      })),
      createControlGeneration: vi
        .fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockImplementation(async request => ({
          version: 1 as const,
          processNonce,
          controlGenerationNonce,
          apiInstanceId: request.apiInstanceId,
        })),
      getLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce,
        controlGenerationNonce,
      })),
      reconcile: vi
        .fn()
        .mockRejectedValueOnce(new Error("transport closed"))
        .mockImplementation(async body => {
          reconcileBodies.push(body);
          return {
            version: 1 as const,
            processNonce,
            controlGenerationNonce,
            snapshotDigest: JSON.parse(body).snapshotDigest,
            retained: 0,
            removed: 0,
            missing: 0 as const,
            corrupt: 0 as const,
            ready: true as const,
          };
        }),
      getReady: vi.fn(async () => ({
        version: 1 as const,
        status: "ready" as const,
        processNonce,
        controlGenerationNonce,
        snapshotDigest,
      })),
    };
    const sleeps: number[] = [];
    const coordinator = createBrowserReconciliationCoordinator({
      gate: gate as never,
      pool: pool as never,
      filesystem: filesystem as never,
      inspectProcessIdentity: inspectProcessIdentity as never,
      serviceClient,
      loadSnapshot,
      interruptUnfinishedBrowserWork: vi.fn(async () => ({
        preparedActionsCancelled: 0,
        executingActionsUnknown: 0,
        runsInterrupted: 0,
        sessionsInterrupted: 0,
        capabilitiesRevoked: 0,
        grantsRevoked: 0,
        writerLeasesCleared: 0,
      })),
      recoverBrowserCleanupIntentsBeforeSnapshot: recover,
      pauseBrowserRetention: vi.fn(async () => undefined),
      startBrowserRetention: vi.fn(async () => undefined),
      retry: {
        maxAttempts: 4,
        initialBackoffMs: 250,
        maxBackoffMs: 1_000,
        startupBudgetMs: 60_000,
        monitorIntervalMs: 60_000,
        retryCooldownMs: 30_000,
      },
      now: () => Date.now(),
      sleep: vi.fn(async milliseconds => {
        sleeps.push(milliseconds);
      }),
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });

    const handoff = await coordinator.acquireControlGeneration();
    const binding = await coordinator.initializeAfterMigrations(handoff);
    expect(binding).toMatchObject({
      databaseControlEpoch: 1,
      processNonce,
      controlGenerationNonce,
      snapshotDigest,
    });
    expect(recover).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledOnce();
    expect(serviceClient.reconcile).toHaveBeenCalledTimes(2);
    expect(serviceClient.reconcile.mock.calls[0]?.[0]).toBe(
      serviceClient.reconcile.mock.calls[1]?.[0],
    );
    expect(reconcileBodies).toHaveLength(1);
    expect(sleeps).toEqual([250, 250]);
    expect(serviceClient.createControlGeneration.mock.calls[0]?.[0]).toEqual(
      serviceClient.createControlGeneration.mock.calls[1]?.[0],
    );
    expect(gate.open).toHaveBeenCalledWith(drain, binding);
    serviceClient.getReady.mockResolvedValueOnce({
      version: 1 as const,
      status: "unready" as const,
      processNonce,
      controlGenerationNonce,
      category: "reconciliation_required" as const,
    } as never);
    await Promise.all([
      coordinator.checkNow(),
      coordinator.checkNow(),
      coordinator.checkNow(),
    ]);
    expect(serviceClient.createControlGeneration).toHaveBeenCalledTimes(3);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(
      serviceClient.createControlGeneration.mock.calls[1]?.[0].idempotencyKey,
    ).not.toBe(
      serviceClient.createControlGeneration.mock.calls[2]?.[0].idempotencyKey,
    );
    const openedBeforeStop = gate.open.mock.calls.length;
    let releaseHealth!: (value: {
      version: 1;
      status: "unready";
      processNonce: string;
      controlGenerationNonce: string;
      category: "reconciliation_required";
    }) => void;
    serviceClient.getReady.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseHealth = resolve as typeof releaseHealth;
        }) as never,
    );
    const checking = coordinator.checkNow();
    await vi.waitFor(() => expect(releaseHealth).toBeTypeOf("function"));
    let releaseShutdownDrain!: () => void;
    const shutdownDrained = new Promise<void>(resolve => {
      releaseShutdownDrain = resolve;
    });
    gate.close.mockImplementationOnce(() => ({
      epoch: 99,
      drained: shutdownDrained,
    }));
    const stopping = coordinator.stop();
    let stopSettled = false;
    void stopping.then(() => {
      stopSettled = true;
    });
    releaseHealth({
      version: 1,
      status: "unready",
      processNonce,
      controlGenerationNonce,
      category: "reconciliation_required",
    });
    await vi.waitFor(() =>
      expect(gate.close).toHaveBeenLastCalledWith("shutdown"),
    );
    expect(stopSettled).toBe(false);
    releaseShutdownDrain();
    await stopping;
    await expect(checking).rejects.toMatchObject({
      category: "browser_state_unavailable",
    });
    expect(gate.open).toHaveBeenCalledTimes(openedBeforeStop);
  });

  it("bounds reconciliation retries and leaves admission closed", async () => {
    const drain = { epoch: 1, drained: Promise.resolve() };
    const gate = {
      assertOpen: vi.fn(),
      close: vi.fn(() => drain),
      open: vi.fn(),
      waitUntilOpen: vi.fn(),
      withBrowserStateMutationLease: vi.fn(),
      withDrainedBrowserStateMutation: vi.fn(async (_drain, callback) =>
        callback({
          epoch: 1,
          scope: "filesystem_and_database",
          binding: {
            apiInstanceId: API_INSTANCE_ID,
            databaseControlEpoch: 1,
            processNonce,
            controlGenerationNonce,
            snapshotDigest,
          },
          transaction: {
            query: vi.fn(async () => ({ rows: [] })),
            databaseControlEpoch: 1,
          },
        }),
      ),
    };
    const client = {
      query: vi.fn(async (text: string) =>
        text.includes("FROM browser_control_generation")
          ? { rows: [] }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const serviceClient = {
      discoverLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce,
      })),
      createControlGeneration: vi.fn(async request => ({
        version: 1 as const,
        processNonce,
        controlGenerationNonce,
        apiInstanceId: request.apiInstanceId,
      })),
      getLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce,
        controlGenerationNonce,
      })),
      reconcile: vi.fn(async () => {
        throw new Error("transport closed");
      }),
      getReady: vi.fn(),
    };
    const sleeps: number[] = [];
    const startBrowserRetention = vi.fn(async () => undefined);
    const coordinator = createBrowserReconciliationCoordinator({
      gate: gate as never,
      pool: pool as never,
      filesystem: { delete: vi.fn() } as never,
      inspectProcessIdentity: vi.fn() as never,
      serviceClient,
      loadSnapshot: vi.fn(async () => ({
        snapshotDigest,
        references: [],
      })),
      interruptUnfinishedBrowserWork: vi.fn(async () => ({
        preparedActionsCancelled: 0,
        executingActionsUnknown: 0,
        runsInterrupted: 0,
        sessionsInterrupted: 0,
        capabilitiesRevoked: 0,
        grantsRevoked: 0,
        writerLeasesCleared: 0,
      })),
      recoverBrowserCleanupIntentsBeforeSnapshot: vi.fn(async () => ({
        liveRetained: 0,
        unknownRetained: 0,
        deadRecovered: 0,
        missingConverged: 0,
      })),
      pauseBrowserRetention: vi.fn(async () => undefined),
      startBrowserRetention,
      retry: {
        maxAttempts: 4,
        initialBackoffMs: 250,
        maxBackoffMs: 1_000,
        startupBudgetMs: 60_000,
        monitorIntervalMs: 60_000,
        retryCooldownMs: 30_000,
      },
      now: () => 1_000,
      sleep: vi.fn(async milliseconds => {
        sleeps.push(milliseconds);
      }),
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });
    const handoff = await coordinator.acquireControlGeneration();
    await expect(
      coordinator.initializeAfterMigrations(handoff),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
    expect(serviceClient.reconcile).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([250, 500, 1_000]);
    expect(startBrowserRetention).not.toHaveBeenCalled();
    expect(gate.open).not.toHaveBeenCalled();
    serviceClient.reconcile.mockImplementation((async () => ({
      version: 1 as const,
      processNonce,
      controlGenerationNonce,
      snapshotDigest,
      retained: 0,
      removed: 0,
      missing: 0 as const,
      corrupt: 0 as const,
      ready: true as const,
    })) as never);
    serviceClient.getReady.mockResolvedValue({
      version: 1 as const,
      status: "ready" as const,
      processNonce,
      controlGenerationNonce,
      snapshotDigest,
    });
    await expect(
      coordinator.initializeAfterMigrations(handoff),
    ).resolves.toMatchObject({ snapshotDigest });
    expect(gate.withDrainedBrowserStateMutation).toHaveBeenCalledTimes(1);
    expect(startBrowserRetention).toHaveBeenCalledOnce();
    serviceClient.getReady.mockResolvedValueOnce({
      version: 1 as const,
      status: "unready" as const,
      processNonce,
      controlGenerationNonce,
      category: "reconciliation_required" as const,
    } as never);
    serviceClient.reconcile.mockRejectedValue(new Error("runtime transport"));
    await expect(coordinator.checkNow()).rejects.toMatchObject({
      category: "browser_state_unavailable",
    });
    const attemptsAfterExhaustion = serviceClient.reconcile.mock.calls.length;
    await expect(coordinator.checkNow()).rejects.toMatchObject({
      category: "browser_state_unavailable",
    });
    expect(serviceClient.reconcile.mock.calls.length).toBe(
      attemptsAfterExhaustion + 4,
    );
    await coordinator.stop();
  });

  it("abandons frozen old-process bytes before the first post", async () => {
    const nextProcessNonce = Buffer.alloc(32, 3).toString("base64url");
    const nextControlNonce = Buffer.alloc(32, 4).toString("base64url");
    let drainEpoch = 0;
    const gate = {
      assertOpen: vi.fn(),
      close: vi.fn(() => {
        drainEpoch += 1;
        return { epoch: drainEpoch, drained: Promise.resolve() };
      }),
      open: vi.fn(),
      waitUntilOpen: vi.fn(),
      withBrowserStateMutationLease: vi.fn(),
      withDrainedBrowserStateMutation: vi.fn(async (_drain, callback) =>
        callback({
          epoch: drainEpoch,
          scope: "filesystem_and_database",
          binding: {
            apiInstanceId: API_INSTANCE_ID,
            databaseControlEpoch: 1,
            processNonce: drainEpoch === 1 ? processNonce : nextProcessNonce,
            controlGenerationNonce:
              drainEpoch === 1 ? controlGenerationNonce : nextControlNonce,
            snapshotDigest,
          },
          transaction: {
            query: vi.fn(async () => ({ rows: [] })),
            databaseControlEpoch: 1,
          },
        }),
      ),
    };
    const client = {
      query: vi.fn(async (text: string) =>
        text.includes("FROM browser_control_generation")
          ? { rows: [] }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    let discoveredProcess = processNonce;
    let oldLiveCalls = 0;
    const reconcileBodies: string[] = [];
    const serviceClient = {
      discoverLive: vi.fn(async () => ({
        version: 1 as const,
        status: "live_unreconciled" as const,
        processNonce: discoveredProcess,
      })),
      createControlGeneration: vi.fn(async request => ({
        version: 1 as const,
        processNonce: request.processNonce,
        controlGenerationNonce:
          request.processNonce === processNonce
            ? controlGenerationNonce
            : nextControlNonce,
        apiInstanceId: request.apiInstanceId,
      })),
      getLive: vi.fn(async context => {
        if (context.processNonce === processNonce) {
          oldLiveCalls += 1;
          if (oldLiveCalls === 4) {
            discoveredProcess = nextProcessNonce;
            throw new BrowserServiceClientError(
              "control_generation_mismatch",
              "stale",
              409,
            );
          }
        }
        return {
          version: 1 as const,
          status: "live_unreconciled" as const,
          processNonce: context.processNonce,
          controlGenerationNonce: context.controlGenerationNonce,
        };
      }),
      reconcile: vi.fn(async body => {
        reconcileBodies.push(body);
        const request = JSON.parse(body);
        return {
          version: 1 as const,
          processNonce: request.processNonce,
          controlGenerationNonce: request.controlGenerationNonce,
          snapshotDigest: request.snapshotDigest,
          retained: 0,
          removed: 0,
          missing: 0 as const,
          corrupt: 0 as const,
          ready: true as const,
        };
      }),
      getReady: vi.fn(async context => ({
        version: 1 as const,
        status: "ready" as const,
        processNonce: context.processNonce,
        controlGenerationNonce: context.controlGenerationNonce,
        snapshotDigest,
      })),
    };
    const interrupt = vi.fn(async () => ({
      preparedActionsCancelled: 0,
      executingActionsUnknown: 0,
      runsInterrupted: 0,
      sessionsInterrupted: 0,
      capabilitiesRevoked: 0,
      grantsRevoked: 0,
      writerLeasesCleared: 0,
    }));
    const loadSnapshot = vi.fn(async () => ({
      snapshotDigest,
      references: [],
    }));
    const coordinator = createBrowserReconciliationCoordinator({
      gate: gate as never,
      pool: pool as never,
      filesystem: { delete: vi.fn() } as never,
      inspectProcessIdentity: vi.fn() as never,
      serviceClient,
      loadSnapshot,
      interruptUnfinishedBrowserWork: interrupt,
      recoverBrowserCleanupIntentsBeforeSnapshot: vi.fn(async () => ({
        liveRetained: 0,
        unknownRetained: 0,
        deadRecovered: 0,
        missingConverged: 0,
      })),
      pauseBrowserRetention: vi.fn(async () => undefined),
      startBrowserRetention: vi.fn(async () => undefined),
      retry: {
        maxAttempts: 4,
        initialBackoffMs: 250,
        maxBackoffMs: 1_000,
        startupBudgetMs: 60_000,
        monitorIntervalMs: 60_000,
        retryCooldownMs: 30_000,
      },
      now: () => Date.now(),
      sleep: vi.fn(async () => undefined),
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });
    const handoff = await coordinator.acquireControlGeneration();
    await expect(
      coordinator.initializeAfterMigrations(handoff),
    ).resolves.toMatchObject({
      processNonce: nextProcessNonce,
      controlGenerationNonce: nextControlNonce,
    });
    expect(reconcileBodies).toHaveLength(1);
    expect(JSON.parse(reconcileBodies[0]!).processNonce).toBe(nextProcessNonce);
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    const handoffsBeforeControlLoss =
      serviceClient.createControlGeneration.mock.calls.length;
    serviceClient.getReady.mockResolvedValueOnce({
      version: 1 as const,
      status: "unready" as const,
      processNonce: nextProcessNonce,
      controlGenerationNonce,
      category: "reconciliation_required" as const,
    } as never);
    await expect(coordinator.checkNow()).rejects.toMatchObject({
      category: "browser_state_unavailable",
    });
    expect(serviceClient.createControlGeneration).toHaveBeenCalledTimes(
      handoffsBeforeControlLoss,
    );
    expect(gate.close).toHaveBeenLastCalledWith("browser_control_lost");
    await coordinator.stop();
  });
});
