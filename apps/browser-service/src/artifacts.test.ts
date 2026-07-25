import { createHash } from "node:crypto";
import { once } from "node:events";

import { describe, expect, test, vi } from "vitest";

import type { FetchArtifactV1 } from "./contracts.js";
import { SessionRegistryError } from "./session-registry.js";
import {
  artifactMetadataHeaders,
  createArtifactService,
  type ArtifactSessionBinding,
} from "./artifacts.js";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
] as const;

const binding: ArtifactSessionBinding = Object.freeze({
  processNonce: "process-generation",
  controlGenerationNonce: "control-generation",
  runtimeSessionId: IDS[0],
});

function screenshot(
  artifactId: string,
  overrides: Partial<FetchArtifactV1> = {},
): FetchArtifactV1 {
  return {
    version: 1,
    artifactId,
    kind: "screenshot",
    format: "png",
    fullPage: false,
    ...overrides,
  } as FetchArtifactV1;
}

function harness(bytes: Uint8Array = Uint8Array.from([1, 2, 3])) {
  const capture = vi.fn(async () => ({
    contentType: "image/png",
    bytes,
  }));
  const sessions = new Set([binding.runtimeSessionId]);
  const registry = {
    get: vi.fn((runtimeSessionId: string) =>
      sessions.has(runtimeSessionId) ? ({ runtimeSessionId } as never) : undefined,
    ),
    withRuntime: vi.fn(
      async (
        runtimeSessionId: string,
        _mode: "passive" | "writer",
        operation: (lease: never) => Promise<unknown>,
      ) => {
        if (!sessions.has(runtimeSessionId)) {
          throw new SessionRegistryError(
            "session_not_found",
            "session is gone",
          );
        }
        return operation(Object.freeze({}) as never);
      },
    ),
    close: vi.fn(async (runtimeSessionId: string) => {
      sessions.delete(runtimeSessionId);
      return { runtimeSessionId };
    }),
  };
  const service = createArtifactService({
    registry: registry as never,
    captureSessionArtifact: capture as never,
  });
  return { capture, registry, service, sessions };
}

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("artifact service", () => {
  test("captures under a writer lease and returns exact metadata and bytes", async () => {
    const source = Uint8Array.from([1, 2, 3, 4]);
    const { capture, registry, service } = harness(source);

    const artifact = await service.capture(binding, screenshot(IDS[1]));
    source.fill(9);

    expect(registry.withRuntime).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "writer",
      expect.any(Function),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.any(Object),
      screenshot(IDS[1]),
    );
    expect(artifact.metadata).toEqual({
      version: 1,
      artifactId: IDS[1],
      kind: "screenshot",
      contentType: "image/png",
      byteSize: 4,
      checksum: createHash("sha256")
        .update(Uint8Array.from([1, 2, 3, 4]))
        .digest("hex"),
    });
    expect(artifactMetadataHeaders(artifact.metadata)).toEqual({
      "x-firecrawl-artifact-version": "1",
      "x-firecrawl-artifact-id": IDS[1],
      "x-firecrawl-artifact-kind": "screenshot",
      "x-firecrawl-artifact-byte-size": "4",
      "x-firecrawl-artifact-sha256": artifact.metadata.checksum,
      "content-type": "image/png",
      "content-length": "4",
    });
    await expect(read(artifact.stream)).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  test.each([
    {
      input: {
        version: 1,
        artifactId: IDS[1],
        kind: "trace",
        preset: "diagnostic-v1",
      } as const,
      contentType: "application/zip",
    },
    {
      input: {
        version: 1,
        artifactId: IDS[1],
        kind: "recording",
        preset: "diagnostic-v1",
      } as const,
      contentType: "video/webm",
    },
  ])("preserves bounded $input.kind capture metadata", async ({
    input,
    contentType,
  }) => {
    const h = harness();
    h.capture.mockResolvedValueOnce({
      contentType,
      bytes: Uint8Array.from([1, 2, 3]),
    });
    const artifact = await h.service.capture(binding, input);
    expect(artifact.metadata).toMatchObject({
      artifactId: input.artifactId,
      kind: input.kind,
      contentType,
      byteSize: 3,
    });
    await expect(read(artifact.stream)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  test("enforces eight objects and 32 MiB for a session lifetime", async () => {
    const { capture, service } = harness(
      new Uint8Array(4 * 1024 * 1024),
    );

    for (const artifactId of IDS.slice(1)) {
      const artifact = await service.capture(binding, screenshot(artifactId));
      await read(artifact.stream);
    }

    await expect(
      service.capture(
        binding,
        screenshot("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ),
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(capture).toHaveBeenCalledTimes(8);
  });

  test("rejects aggregate bytes before publishing another artifact", async () => {
    const outputs = [
      new Uint8Array(16 * 1024 * 1024),
      new Uint8Array(16 * 1024 * 1024),
      Uint8Array.from([1]),
    ];
    const h = harness();
    h.capture.mockImplementation(async () => ({
      contentType: "image/png",
      bytes: outputs.shift()!,
    }));

    for (const artifactId of IDS.slice(1, 3)) {
      const artifact = await h.service.capture(binding, screenshot(artifactId));
      await read(artifact.stream);
    }
    await expect(
      h.service.capture(binding, screenshot(IDS[3])),
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(h.capture).toHaveBeenCalledTimes(2);
  });

  test("fail-stops when successful production crosses the aggregate limit", async () => {
    const outputs = [
      new Uint8Array(12 * 1024 * 1024),
      new Uint8Array(8 * 1024 * 1024),
      new Uint8Array(13 * 1024 * 1024),
    ];
    const h = harness();
    h.registry.close.mockRejectedValueOnce(
      new Error("session close did not settle"),
    );
    h.capture.mockImplementation(async () => ({
      contentType: "image/png",
      bytes: outputs.shift()!,
    }));
    for (const artifactId of IDS.slice(1, 3)) {
      const artifact = await h.service.capture(binding, screenshot(artifactId));
      await read(artifact.stream);
    }

    await expect(
      h.service.capture(binding, screenshot(IDS[3])),
    ).rejects.toMatchObject({ category: "browser_unavailable" });
    expect(h.capture).toHaveBeenCalledTimes(3);
    expect(h.registry.close).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "error",
    );
    await expect(
      h.service.capture(binding, screenshot(IDS[3])),
    ).rejects.toMatchObject({ category: "session_not_found" });
    expect(h.capture).toHaveBeenCalledTimes(3);
  });

  test("rejects duplicate IDs without repeating the browser effect", async () => {
    const { capture, service } = harness();
    const artifact = await service.capture(binding, screenshot(IDS[1]));
    await read(artifact.stream);

    await expect(
      service.capture(binding, screenshot(IDS[1])),
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(capture).toHaveBeenCalledOnce();
  });

  test("serializes concurrent creation before applying duplicate limits", async () => {
    const h = harness();
    let release!: () => void;
    h.capture.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () =>
            resolve({
              contentType: "image/png",
              bytes: Uint8Array.from([1, 2, 3]),
            });
        }),
    );

    const first = h.service.capture(binding, screenshot(IDS[1]));
    const duplicate = h.service.capture(binding, screenshot(IDS[1]));
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledOnce());
    release();
    const artifact = await first;
    await read(artifact.stream);
    await expect(duplicate).rejects.toMatchObject({
      category: "invalid_request",
    });
    expect(h.capture).toHaveBeenCalledOnce();
  });

  test("binds retained state to one generation and runtime session", async () => {
    const { service } = harness();
    const artifact = await service.capture(binding, screenshot(IDS[1]));
    await read(artifact.stream);

    await expect(
      service.capture(
        { ...binding, controlGenerationNonce: "replacement-generation" },
        screenshot(IDS[2]),
      ),
    ).rejects.toMatchObject({ category: "control_generation_mismatch" });
  });

  test("fails closed and retains nothing after ambiguous producer failure", async () => {
    const h = harness();
    h.capture.mockRejectedValueOnce(new Error("screenshot transport broke"));

    await expect(
      h.service.capture(binding, screenshot(IDS[1])),
    ).rejects.toMatchObject({ category: "browser_unavailable" });
    expect(h.registry.close).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "error",
    );

    h.service.releaseSession(binding);
    h.sessions.add(binding.runtimeSessionId);
    const artifact = await h.service.capture(binding, screenshot(IDS[1]));
    await expect(read(artifact.stream)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  test("observes an already aborted request before starting the producer", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      h.service.capture(binding, screenshot(IDS[1]), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.registry.withRuntime).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.registry.close).not.toHaveBeenCalled();
  });

  test("aborts while waiting for the writer without starting an effect", async () => {
    const h = harness();
    const controller = new AbortController();
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>(resolve => {
      releaseWriter = resolve;
    });
    h.registry.withRuntime.mockImplementationOnce(
      async (
        _runtimeSessionId: string,
        _mode: "passive" | "writer",
        operation: (lease: never) => Promise<unknown>,
      ) => {
        await writerGate;
        return operation(Object.freeze({}) as never);
      },
    );

    const capture = h.service.capture(binding, screenshot(IDS[1]), {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(h.registry.withRuntime).toHaveBeenCalledOnce(),
    );
    expect(h.capture).not.toHaveBeenCalled();
    controller.abort();
    releaseWriter();

    await expect(capture).rejects.toMatchObject({ name: "AbortError" });
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.registry.close).not.toHaveBeenCalled();
    const retry = await h.service.capture(binding, screenshot(IDS[1]));
    await expect(read(retry.stream)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  test("fail-stops an abort racing an in-flight producer", async () => {
    const h = harness();
    const controller = new AbortController();
    const finalized = vi.fn();
    let release!: () => void;
    const producerGate = new Promise<void>(resolve => {
      release = resolve;
    });
    h.capture.mockImplementationOnce(async () => {
      try {
        await producerGate;
        return {
          contentType: "image/png",
          bytes: Uint8Array.from([1, 2, 3]),
        };
      } finally {
        finalized();
      }
    });

    const capture = h.service.capture(binding, screenshot(IDS[1]), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledOnce());
    controller.abort();
    release();

    await expect(capture).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(finalized).toHaveBeenCalledOnce();
    expect(h.registry.close).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "error",
    );
    await expect(
      h.service.capture(binding, screenshot(IDS[1])),
    ).rejects.toMatchObject({ category: "session_not_found" });
    expect(h.capture).toHaveBeenCalledOnce();
  });

  test("fail-stops invalid metadata produced after the browser effect", async () => {
    const h = harness();
    h.capture.mockResolvedValueOnce({
      contentType: "video/webm",
      bytes: Uint8Array.from([1, 2, 3]),
    });
    await expect(
      h.service.capture(binding, screenshot(IDS[1])),
    ).rejects.toMatchObject({ category: "browser_unavailable" });
    expect(h.registry.close).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "error",
    );
  });

  test("fail-stops stream construction after successful production", async () => {
    const h = harness();
    let hasherCount = 0;
    const service = createArtifactService({
      registry: h.registry as never,
      captureSessionArtifact: h.capture as never,
      createSha256() {
        hasherCount += 1;
        if (hasherCount === 2) throw new Error("stream hasher unavailable");
        const hash = createHash("sha256");
        return {
          update(bytes) {
            hash.update(bytes);
          },
          digest() {
            return hash.digest("hex");
          },
        };
      },
    });
    await expect(
      service.capture(binding, screenshot(IDS[1])),
    ).rejects.toMatchObject({ category: "browser_unavailable" });
    expect(h.registry.close).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "error",
    );
  });

  test("rejects oversized producer output and closes the session", async () => {
    const h = harness(new Uint8Array(16 * 1024 * 1024 + 1));
    await expect(
      h.service.capture(binding, screenshot(IDS[1])),
    ).rejects.toMatchObject({ category: "browser_unavailable" });
    expect(h.registry.close).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "error",
    );
  });

  test("revalidates integrity while streaming and fail-stops mismatch", async () => {
    const h = harness(Uint8Array.from([1, 2, 3]));
    let digestCount = 0;
    const service = createArtifactService({
      registry: h.registry as never,
      captureSessionArtifact: h.capture as never,
      createSha256() {
        const hash = createHash("sha256");
        return {
          update(bytes) {
            hash.update(bytes);
          },
          digest() {
            digestCount += 1;
            return digestCount === 2 ? "0".repeat(64) : hash.digest("hex");
          },
        };
      },
    });

    const artifact = await service.capture(binding, screenshot(IDS[1]));
    await expect(read(artifact.stream)).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    await vi.waitFor(() =>
      expect(h.registry.close).toHaveBeenCalledWith(
        binding.runtimeSessionId,
        "error",
      ),
    );
  });

  test("cancellation destroys a bounded stream without emitting more data", async () => {
    const h = harness(new Uint8Array(256 * 1024));
    const controller = new AbortController();
    const artifact = await h.service.capture(binding, screenshot(IDS[1]), {
      signal: controller.signal,
    });
    const first = artifact.stream.read(64 * 1024) as Buffer;
    expect(first.byteLength).toBe(64 * 1024);
    const closed = once(artifact.stream, "close");
    controller.abort();
    await closed;
    expect(artifact.stream.destroyed).toBe(true);
  });

  test("close and expiry cleanup destroy streams and release binding state", async () => {
    const h = harness(new Uint8Array(256 * 1024));
    const first = await h.service.capture(binding, screenshot(IDS[1]));
    first.stream.pause();
    const closed = once(first.stream, "close");
    h.service.releaseSession(binding);
    await closed;
    expect(first.stream.destroyed).toBe(true);

    h.sessions.add(binding.runtimeSessionId);
    const second = await h.service.capture(binding, screenshot(IDS[1]));
    second.stream.pause();
    const expired = once(second.stream, "close");
    h.sessions.delete(binding.runtimeSessionId);
    h.service.sweepExpired();
    await expired;
    expect(second.stream.destroyed).toBe(true);
  });

  test("close during capture fail-stops ambiguous publication", async () => {
    const h = harness();
    let release!: () => void;
    h.capture.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () =>
            resolve({
              contentType: "image/png",
              bytes: Uint8Array.from([1, 2, 3]),
            });
        }),
    );
    const capture = h.service.capture(binding, screenshot(IDS[1]));
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledOnce());
    h.service.releaseSession(binding);
    release();
    await expect(capture).rejects.toMatchObject({
      category: "browser_unavailable",
    });
    expect(h.registry.close).toHaveBeenCalledWith(
      binding.runtimeSessionId,
      "error",
    );
  });

  test("preserves session-not-found without attempting a second close", async () => {
    const h = harness();
    h.registry.withRuntime.mockRejectedValueOnce(
      new SessionRegistryError("session_not_found", "session is gone"),
    );
    await expect(
      h.service.capture(binding, screenshot(IDS[1])),
    ).rejects.toMatchObject({ category: "session_not_found" });
    expect(h.registry.close).not.toHaveBeenCalled();
  });
});
