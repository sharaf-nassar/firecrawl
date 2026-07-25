import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { runApplicationMigrations } from "../../db/migrate";
import { createBrowserStartupGate } from "./startup-gate";

const binding = {
  apiInstanceId: "11111111-1111-4111-8111-111111111111",
  databaseControlEpoch: 7,
  processNonce: Buffer.alloc(32, 1).toString("base64url"),
  controlGenerationNonce: Buffer.alloc(32, 2).toString("base64url"),
  snapshotDigest: "c".repeat(64),
};

function pool() {
  const query = vi.fn(async (text: string) => {
    if (text.includes("SELECT database_control_epoch")) {
      return {
        rows: [
          {
            database_control_epoch: "7",
            api_instance_id: binding.apiInstanceId,
            process_nonce: binding.processNonce,
            control_generation_nonce: binding.controlGenerationNonce,
          },
        ],
      };
    }
    return { rows: [] };
  });
  return {
    query,
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  };
}

describe("BrowserStartupGate", () => {
  it("closes synchronously and waits for admitted mutations", async () => {
    const gate = createBrowserStartupGate({ pool: pool() as never });
    expect(() => gate.assertOpen()).toThrow(
      expect.objectContaining({ category: "browser_state_unavailable" }),
    );

    const initial = gate.close("startup");
    await initial.drained;
    gate.open(initial, binding);

    let release!: () => void;
    const mutation = gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      async () => new Promise<void>(resolve => (release = resolve)),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    const restart = gate.close("restart");
    expect(() => gate.assertOpen()).toThrow();
    let drained = false;
    void restart.drained.then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(
      gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async () => undefined,
      ),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });

    release();
    await mutation;
    await restart.drained;
    gate.open(restart, binding);
    expect(gate.assertOpen()).toEqual(binding);
  });

  it("rejects a stale durable control generation before side effects", async () => {
    const fakePool = pool();
    const gate = createBrowserStartupGate({ pool: fakePool as never });
    const initial = gate.close("startup");
    await initial.drained;
    gate.open(initial, { ...binding, databaseControlEpoch: 8 });
    const operation = vi.fn(async () => undefined);
    await expect(
      gate.withBrowserStateMutationLease("filesystem_and_database", operation),
    ).rejects.toMatchObject({ category: "control_generation_mismatch" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects stale drains and aborts closed waiters", async () => {
    const gate = createBrowserStartupGate({ pool: pool() as never });
    const stale = gate.close("first");
    const current = gate.close("second");
    await Promise.all([stale.drained, current.drained]);
    expect(() => gate.open(stale, binding)).toThrow(
      expect.objectContaining({ category: "browser_state_unavailable" }),
    );
    const controller = new AbortController();
    const waiting = gate.waitUntilOpen(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    gate.open(current, binding);
    expect(gate.assertOpen()).toEqual(binding);
  });

  it("allows drained recovery only after earlier leases commit", async () => {
    const gate = createBrowserStartupGate({ pool: pool() as never });
    const initial = gate.close("startup");
    await initial.drained;
    gate.open(initial, binding);
    let release!: () => void;
    const mutation = gate.withBrowserStateMutationLease(
      "filesystem_and_database",
      async () => new Promise<void>(resolve => (release = resolve)),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const drain = gate.close("restart");
    await expect(
      gate.withDrainedBrowserStateMutation(drain, async () => undefined),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
    release();
    await mutation;
    await drain.drained;
    await expect(
      gate.withDrainedBrowserStateMutation(drain, async lease => {
        expect(lease.transaction.databaseControlEpoch).toBe(7);
      }),
    ).resolves.toBeUndefined();
    await expect(
      gate.withDrainedBrowserStateMutation(drain, async () => undefined),
    ).rejects.toMatchObject({ category: "browser_state_unavailable" });
  });
});

const databaseUrl = process.env.TEST_APPLICATION_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("BrowserStartupGate durable fencing", () => {
  it("drains a paused old mutation and rejects its next side effect", async () => {
    const poolA = new Pool({ connectionString: databaseUrl, max: 2 });
    const poolB = new Pool({ connectionString: databaseUrl, max: 2 });
    const ownerId = randomUUID();
    await runApplicationMigrations({
      LOCAL_PERSISTENCE_ENABLED: true,
      APPLICATION_DATABASE_URL: databaseUrl,
      LOCAL_OWNER_ID: ownerId,
      ARTIFACT_STORE_PROVIDER: "none",
      USE_DB_AUTHENTICATION: false,
    });
    const oldBinding = {
      ...binding,
      apiInstanceId: randomUUID(),
      databaseControlEpoch: 1,
    };
    const newBinding = {
      ...binding,
      apiInstanceId: randomUUID(),
      databaseControlEpoch: 2,
      controlGenerationNonce: Buffer.alloc(32, 4).toString("base64url"),
    };
    try {
      await poolA.query("DELETE FROM browser_control_generation");
      await poolA.query(
        `INSERT INTO browser_control_generation (
           singleton_id, database_control_epoch, api_instance_id,
           process_nonce, control_generation_nonce
         ) VALUES (1, 1, $1, $2, $3)`,
        [
          oldBinding.apiInstanceId,
          oldBinding.processNonce,
          oldBinding.controlGenerationNonce,
        ],
      );
      const gate = createBrowserStartupGate({ pool: poolA });
      const initial = gate.close("startup");
      await initial.drained;
      gate.open(initial, oldBinding);

      let releaseOld!: () => void;
      let oldReached!: () => void;
      const reached = new Promise<void>(resolve => {
        oldReached = resolve;
      });
      const effects: string[] = [];
      const oldMutation = gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async () => {
          effects.push("old-file");
          oldReached();
          await new Promise<void>(resolve => {
            releaseOld = resolve;
          });
        },
      );
      await reached;

      let takeoverLocked = false;
      const takeover = (async () => {
        const client = await poolB.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT singleton_id
               FROM browser_control_generation
              WHERE singleton_id = 1
              FOR UPDATE`,
          );
          takeoverLocked = true;
          await client.query(
            `UPDATE browser_control_generation
                SET database_control_epoch = 2,
                    api_instance_id = $1,
                    process_nonce = $2,
                    control_generation_nonce = $3,
                    activated_at = now()
              WHERE singleton_id = 1`,
            [
              newBinding.apiInstanceId,
              newBinding.processNonce,
              newBinding.controlGenerationNonce,
            ],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      })();
      await new Promise(resolve => setImmediate(resolve));
      expect(takeoverLocked).toBe(false);
      releaseOld();
      await oldMutation;
      await takeover;
      expect(takeoverLocked).toBe(true);

      await expect(
        gate.withBrowserStateMutationLease(
          "filesystem_and_database",
          async () => {
            effects.push("stale-file");
          },
        ),
      ).rejects.toMatchObject({ category: "control_generation_mismatch" });
      expect(effects).toEqual(["old-file"]);
    } finally {
      await poolA
        .query("DELETE FROM local_owners WHERE id = $1", [ownerId])
        .catch(() => undefined);
      await Promise.all([poolA.end(), poolB.end()]);
    }
  });
});
