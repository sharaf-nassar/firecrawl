import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  BrowserArtifactError,
  commitBrowserArtifactWithLease,
  createBrowserArtifactService,
  parseBrowserArtifactHeaders,
  readBrowserArtifactBody,
} from "./artifacts";
import { createBrowserStartupGate } from "./startup-gate";

const ID = (tail: number) =>
  `10000000-0000-4000-8000-${tail.toString().padStart(12, "0")}`;
const png = Buffer.from("png bytes");
const checksum = createHash("sha256").update(png).digest("hex");

const headers = {
  contentLength: png.byteLength,
  artifactId: ID(7),
  kind: "screenshot" as const,
  contentType: "image/png" as const,
  byteSize: png.byteLength,
  sha256: checksum,
};
const authority = {
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
  zeroDataRetention: false as const,
};
const target = {
  ownerId: ID(2),
  requestId: ID(8),
  scrapeId: ID(9),
  sessionId: ID(3),
  runId: ID(1),
  deleteAfter: null,
};

describe("browser artifact ingestion", () => {
  it("rejects bytes that differ from the declared checksum before upload", async () => {
    const store = {
      provider: "minio" as const,
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };
    const service = createBrowserArtifactService({
      gate: {} as never,
      store,
      commit: vi.fn(),
    });
    await expect(
      service.ingest(
        {
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
        },
        { ...headers, sha256: "0".repeat(64) },
        png,
      ),
    ).rejects.toMatchObject({ category: "artifact_checksum_mismatch" });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("deletes the exact upload when the gate closes before attachment", async () => {
    const unavailable = Object.assign(new Error("closed"), {
      category: "browser_state_unavailable",
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async input => ({
        key: input.key,
        contentType: input.contentType,
        byteSize: Buffer.byteLength(input.body),
        metadata: {},
      })),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };
    const service = createBrowserArtifactService({
      gate: {
        assertOpen: vi.fn(),
        withBrowserStateMutationLease: vi.fn().mockRejectedValue(unavailable),
      } as never,
      store,
      resolveTarget: vi.fn().mockResolvedValue({
        ownerId: ID(2),
        requestId: ID(8),
        scrapeId: ID(9),
        sessionId: ID(3),
        runId: ID(1),
        deleteAfter: null,
      }),
    });
    await expect(
      service.ingest(
        {
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
        },
        headers,
        png,
      ),
    ).rejects.toBe(unavailable);
    expect(store.delete).toHaveBeenCalledWith(
      expect.stringContaining(headers.artifactId),
    );
  });

  it("rejects duplicate and unknown artifact headers", () => {
    expect(() =>
      parseBrowserArtifactHeaders([
        "content-length",
        String(png.byteLength),
        "x-firecrawl-artifact-id",
        headers.artifactId,
        "x-firecrawl-artifact-id",
        headers.artifactId,
        "x-firecrawl-artifact-kind",
        headers.kind,
        "x-firecrawl-artifact-content-type",
        headers.contentType,
        "x-firecrawl-artifact-byte-size",
        String(headers.byteSize),
        "x-firecrawl-artifact-sha256",
        headers.sha256,
      ]),
    ).toThrow();
    expect(() =>
      parseBrowserArtifactHeaders([
        "content-length",
        String(png.byteLength),
        "x-firecrawl-artifact-extra",
        "no",
      ]),
    ).toThrow();
  });

  it("rejects premature EOF and trailing bytes", async () => {
    async function* bytes(value: Buffer) {
      yield value;
    }
    await expect(
      readBrowserArtifactBody(
        bytes(png.subarray(0, png.byteLength - 1)),
        headers,
      ),
    ).rejects.toMatchObject({ category: "artifact_length_mismatch" });
    await expect(
      readBrowserArtifactBody(
        bytes(Buffer.concat([png, Buffer.from("x")])),
        headers,
      ),
    ).rejects.toMatchObject({ category: "artifact_length_mismatch" });
  });

  it("interrupts a slow body while waiting for its next chunk", async () => {
    let started!: () => void;
    const iterationStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    async function* slowBytes() {
      started();
      await new Promise<void>(() => undefined);
      yield png;
    }
    const cancellation = new AbortController();
    const read = readBrowserArtifactBody(
      slowBytes(),
      headers,
      cancellation.signal,
    );
    await iterationStarted;
    cancellation.abort();
    await expect(read).rejects.toMatchObject({
      category: "artifact_upload_interrupted",
    });
  });

  it("deletes an uploaded object when cancellation arrives after body read", async () => {
    let releasePut!: () => void;
    let putStarted!: () => void;
    const putRelease = new Promise<void>(resolve => {
      releasePut = resolve;
    });
    const reachedPut = new Promise<void>(resolve => {
      putStarted = resolve;
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async input => {
        putStarted();
        await putRelease;
        return {
          key: input.key,
          contentType: input.contentType,
          byteSize: Buffer.byteLength(input.body),
          metadata: {},
        };
      }),
      get: vi.fn(),
      delete: vi.fn(),
      health: vi.fn(),
    };
    const service = createBrowserArtifactService({
      gate: {
        assertOpen: vi.fn(),
        withBrowserStateMutationLease: vi.fn(),
      } as never,
      store,
      resolveTarget: vi.fn().mockResolvedValue({
        ownerId: ID(2),
        requestId: ID(8),
        scrapeId: ID(9),
        sessionId: ID(3),
        runId: ID(1),
        deleteAfter: new Date("2026-07-26T00:00:00.000Z"),
      }),
    });
    const cancellation = new AbortController();
    const ingest = service.ingest(
      {
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
      },
      headers,
      png,
      cancellation.signal,
    );
    await reachedPut;
    cancellation.abort();
    releasePut();
    await expect(ingest).rejects.toMatchObject({
      category: "artifact_upload_interrupted",
    });
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete.mock.calls[0]?.[0]).toContain(headers.artifactId);
  });

  it("bounds a never-resolving put and deletes its exact fresh key", async () => {
    let putStarted!: () => void;
    const reachedPut = new Promise<void>(resolve => {
      putStarted = resolve;
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async () => {
        putStarted();
        return new Promise<never>(() => undefined);
      }),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      health: vi.fn(),
    };
    const service = createBrowserArtifactService({
      gate: {
        assertOpen: vi.fn(),
        withBrowserStateMutationLease: vi.fn(),
      } as never,
      store,
      resolveTarget: vi.fn().mockResolvedValue(target),
      randomUploadId: () => ID(40),
    });
    const cancellation = new AbortController();
    const ingest = service.ingest(authority, headers, png, cancellation.signal);
    await reachedPut;
    cancellation.abort();
    await expect(ingest).rejects.toMatchObject({
      category: "artifact_upload_interrupted",
    });
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith(
      expect.stringContaining(`${headers.artifactId}-${ID(40)}`),
    );
  });

  it("deletes a fresh key when put stores bytes then rejects", async () => {
    let storedKey: string | undefined;
    const lostResponse = new Error("lost response after durable store");
    const store = {
      provider: "minio" as const,
      put: vi.fn(async input => {
        storedKey = input.key;
        throw lostResponse;
      }),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      health: vi.fn(),
    };
    const service = createBrowserArtifactService({
      gate: {
        assertOpen: vi.fn(),
        withBrowserStateMutationLease: vi.fn(),
      } as never,
      store,
      resolveTarget: vi.fn().mockResolvedValue(target),
      randomUploadId: () => ID(41),
    });
    await expect(service.ingest(authority, headers, png)).rejects.toBe(
      lostResponse,
    );
    expect(storedKey).toContain(`${headers.artifactId}-${ID(41)}`);
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith(storedKey);
  });

  it("returns after a bounded rollback delete timeout", async () => {
    const putFailure = new Error("put failed after starting");
    const store = {
      provider: "minio" as const,
      put: vi.fn().mockRejectedValue(putFailure),
      get: vi.fn(),
      delete: vi.fn(() => new Promise<void>(() => undefined)),
      health: vi.fn(),
    };
    const service = createBrowserArtifactService({
      gate: {
        assertOpen: vi.fn(),
        withBrowserStateMutationLease: vi.fn(),
      } as never,
      store,
      resolveTarget: vi.fn().mockResolvedValue(target),
      randomUploadId: () => ID(42),
      rollbackTimeoutMs: 10,
    });
    const startedAt = Date.now();
    await expect(service.ingest(authority, headers, png)).rejects.toBe(
      putFailure,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it("fails closed on explicit ZDR and per-run object budgets", async () => {
    const reference = {
      artifactId: ID(7),
      objectKey: `browser/${ID(2)}/${ID(8)}/${ID(9)}/${ID(3)}/${ID(1)}/leaf`,
      kind: "screenshot" as const,
      contentType: "image/png" as const,
      byteSize: png.byteLength,
      sha256: checksum,
    };
    const target = {
      ownerId: ID(2),
      requestId: ID(8),
      scrapeId: ID(9),
      sessionId: ID(3),
      runId: ID(1),
      deleteAfter: null,
    };
    const authority = {
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
      zeroDataRetention: true,
    };
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          owner_id: ID(2),
          request_id: ID(8),
          scrape_id: ID(9),
          session_id: ID(3),
          artifact_references: [],
          dr_clean_by: new Date(),
        },
      ],
    });
    await expect(
      commitBrowserArtifactWithLease(
        { transaction: { query } } as never,
        authority as never,
        target,
        reference,
      ),
    ).rejects.toMatchObject({ category: "capability_denied" });
    expect(query).toHaveBeenCalledTimes(1);

    const existing = Array.from({ length: 8 }, (_, index) => ({
      ...reference,
      artifactId: ID(20 + index),
      objectKey: `${reference.objectKey}-${index}`,
    }));
    query.mockReset();
    query.mockResolvedValueOnce({
      rows: [
        {
          owner_id: ID(2),
          request_id: ID(8),
          scrape_id: ID(9),
          session_id: ID(3),
          artifact_references: existing,
          dr_clean_by: null,
        },
      ],
    });
    await expect(
      commitBrowserArtifactWithLease(
        { transaction: { query } } as never,
        { ...authority, zeroDataRetention: false } as never,
        target,
        reference,
      ),
    ).rejects.toMatchObject({ category: "artifact_budget_exceeded" });
    expect(query).toHaveBeenCalledTimes(1);

    query.mockReset();
    query.mockResolvedValueOnce({
      rows: [
        {
          owner_id: ID(2),
          request_id: ID(8),
          scrape_id: ID(9),
          session_id: ID(3),
          artifact_references: [
            { ...reference, artifactId: ID(30), byteSize: 16 * 1024 * 1024 },
            { ...reference, artifactId: ID(31), byteSize: 16 * 1024 * 1024 },
          ],
          dr_clean_by: null,
        },
      ],
    });
    await expect(
      commitBrowserArtifactWithLease(
        { transaction: { query } } as never,
        { ...authority, zeroDataRetention: false } as never,
        target,
        reference,
      ),
    ).rejects.toMatchObject({ category: "artifact_budget_exceeded" });
  });

  it("persists manifest and CAS attachment in one final lease transaction", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            owner_id: ID(2),
            request_id: ID(8),
            scrape_id: ID(9),
            session_id: ID(3),
            artifact_references: [],
            dr_clean_by: new Date("2026-07-26T00:00:00.000Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ object_key: "stored" }] })
      .mockResolvedValueOnce({ rows: [{ id: ID(1) }] });
    await expect(
      commitBrowserArtifactWithLease(
        { transaction: { query } } as never,
        {
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
        },
        {
          ownerId: ID(2),
          requestId: ID(8),
          scrapeId: ID(9),
          sessionId: ID(3),
          runId: ID(1),
          deleteAfter: new Date("2026-07-26T00:00:00.000Z"),
        },
        {
          artifactId: ID(7),
          objectKey: "browser/object",
          kind: "screenshot",
          contentType: "image/png",
          byteSize: png.byteLength,
          sha256: checksum,
        },
      ),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO local_artifacts");
    expect(query.mock.calls[1]?.[1]?.[8]).toEqual(
      new Date("2026-07-26T00:00:00.000Z"),
    );
    expect(query.mock.calls[2]?.[0]).toContain(
      "artifact_references = $3::jsonb",
    );
  });

  it("rejects an abort observed after the final CAS so the lease rolls back", async () => {
    const cancellation = new AbortController();
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            owner_id: ID(2),
            request_id: ID(8),
            scrape_id: ID(9),
            session_id: ID(3),
            artifact_references: [],
            dr_clean_by: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ object_key: "stored" }] })
      .mockImplementationOnce(async () => {
        cancellation.abort();
        return { rows: [{ id: ID(1) }] };
      });
    await expect(
      commitBrowserArtifactWithLease(
        { transaction: { query } } as never,
        authority,
        target,
        {
          artifactId: ID(7),
          objectKey: "browser/object",
          kind: "screenshot",
          contentType: "image/png",
          byteSize: png.byteLength,
          sha256: checksum,
        },
        cancellation.signal,
      ),
    ).rejects.toMatchObject({ category: "artifact_upload_interrupted" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("never deletes an exact object while deferred COMMIT can attach it", async () => {
    for (const expected of ["committed", "rolled_back", "unknown"] as const) {
      let releaseCommit!: () => void;
      let reachedCommit!: () => void;
      const commitRelease = new Promise<void>(resolve => {
        releaseCommit = resolve;
      });
      const commitReached = new Promise<void>(resolve => {
        reachedCommit = resolve;
      });
      let pendingReference = false;
      let durableReference = false;
      const query = vi.fn(async (text: string) => {
        if (text === "BEGIN") return { rows: [], command: "BEGIN" };
        if (text.includes("SELECT database_control_epoch")) {
          return {
            rows: [
              {
                database_control_epoch: "7",
                api_instance_id: ID(50),
                process_nonce: Buffer.alloc(32, 1).toString("base64url"),
                control_generation_nonce: Buffer.alloc(32, 2).toString(
                  "base64url",
                ),
              },
            ],
            command: "SELECT",
          };
        }
        if (text === "artifact CAS") {
          pendingReference = true;
          return { rows: [{ id: target.runId }], command: "UPDATE" };
        }
        if (text === "COMMIT") {
          reachedCommit();
          if (expected === "unknown") {
            return new Promise<never>(() => undefined);
          }
          await commitRelease;
          if (expected === "committed") {
            durableReference = pendingReference;
            pendingReference = false;
            return { rows: [], command: "COMMIT" };
          }
          pendingReference = false;
          return { rows: [], command: "ROLLBACK" };
        }
        if (text === "ROLLBACK") {
          pendingReference = false;
          return { rows: [], command: "ROLLBACK" };
        }
        throw new Error(`Unexpected query: ${text}`);
      });
      const gate = createBrowserStartupGate({
        pool: {
          connect: vi.fn(async () => ({
            query,
            release: vi.fn(),
          })),
        } as never,
      });
      const initial = gate.close("startup");
      await initial.drained;
      gate.open(initial, {
        apiInstanceId: ID(50),
        databaseControlEpoch: 7,
        processNonce: Buffer.alloc(32, 1).toString("base64url"),
        controlGenerationNonce: Buffer.alloc(32, 2).toString("base64url"),
        snapshotDigest: "c".repeat(64),
      });
      const objects = new Set<string>();
      const store = {
        provider: "minio" as const,
        put: vi.fn(async input => {
          objects.add(input.key);
          return {
            key: input.key,
            contentType: input.contentType,
            byteSize: Buffer.byteLength(input.body),
            metadata: {},
          };
        }),
        get: vi.fn(),
        delete: vi.fn(async (key: string) => {
          objects.delete(key);
        }),
        health: vi.fn(),
      };
      const service = createBrowserArtifactService({
        gate,
        store,
        resolveTarget: vi.fn().mockResolvedValue(target),
        commit: async lease => {
          await lease.transaction.query("artifact CAS");
        },
        randomUploadId: () => ID(51),
        commitOutcomeTimeoutMs: 10,
        transactionCommitTimeoutMs: 20,
      });
      const cancellation = new AbortController();
      const ingest = service.ingest(
        authority,
        headers,
        png,
        cancellation.signal,
      );
      await commitReached;
      cancellation.abort();
      if (expected !== "unknown") releaseCommit();
      await expect(ingest).rejects.toMatchObject({
        category: "artifact_upload_interrupted",
      });

      expect(durableReference).toBe(expected === "committed");
      expect(objects.size).toBe(expected === "rolled_back" ? 0 : 1);
      expect(store.delete).toHaveBeenCalledTimes(
        expected === "rolled_back" ? 1 : 0,
      );
      if (durableReference) expect(objects.size).toBe(1);
    }
  });

  it("deletes the exact object after a delayed explicit rollback", async () => {
    let releaseCommit!: () => void;
    let reachedCommit!: () => void;
    const commitRelease = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    const commitReached = new Promise<void>(resolve => {
      reachedCommit = resolve;
    });
    const query = vi.fn(async (text: string) => {
      if (text === "BEGIN") return { rows: [], command: "BEGIN" };
      if (text.includes("SELECT database_control_epoch")) {
        return {
          rows: [
            {
              database_control_epoch: "7",
              api_instance_id: ID(50),
              process_nonce: Buffer.alloc(32, 1).toString("base64url"),
              control_generation_nonce: Buffer.alloc(32, 2).toString(
                "base64url",
              ),
            },
          ],
          command: "SELECT",
        };
      }
      if (text === "artifact CAS") {
        return { rows: [{ id: target.runId }], command: "UPDATE" };
      }
      if (text === "COMMIT") {
        reachedCommit();
        await commitRelease;
        return { rows: [], command: "ROLLBACK" };
      }
      if (text === "ROLLBACK") {
        return { rows: [], command: "ROLLBACK" };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const release = vi.fn();
    const gate = createBrowserStartupGate({
      pool: {
        connect: vi.fn(async () => ({ query, release })),
      } as never,
    });
    const initial = gate.close("startup");
    await initial.drained;
    gate.open(initial, {
      apiInstanceId: ID(50),
      databaseControlEpoch: 7,
      processNonce: Buffer.alloc(32, 1).toString("base64url"),
      controlGenerationNonce: Buffer.alloc(32, 2).toString("base64url"),
      snapshotDigest: "c".repeat(64),
    });
    const store = {
      provider: "minio" as const,
      put: vi.fn(async input => ({
        key: input.key,
        contentType: input.contentType,
        byteSize: Buffer.byteLength(input.body),
        metadata: {},
      })),
      get: vi.fn(),
      delete: vi.fn(async () => undefined),
      health: vi.fn(),
    };
    const service = createBrowserArtifactService({
      gate,
      store,
      resolveTarget: vi.fn().mockResolvedValue(target),
      commit: async lease => {
        await lease.transaction.query("artifact CAS");
      },
      randomUploadId: () => ID(51),
      commitOutcomeTimeoutMs: 5,
      transactionCommitTimeoutMs: 100,
    });
    const cancellation = new AbortController();
    const ingest = service.ingest(authority, headers, png, cancellation.signal);
    await commitReached;
    cancellation.abort();
    await expect(ingest).rejects.toMatchObject({
      category: "artifact_upload_interrupted",
    });
    expect(store.delete).not.toHaveBeenCalled();

    releaseCommit();
    await vi.waitFor(() => expect(store.delete).toHaveBeenCalledTimes(1));
    expect(store.delete).toHaveBeenCalledWith(
      [
        "browser",
        target.ownerId,
        target.requestId,
        target.scrapeId,
        target.sessionId,
        target.runId,
        `${headers.artifactId}-${ID(51)}`,
      ].join("/"),
    );
    expect(release).toHaveBeenCalledWith();
  });
});
