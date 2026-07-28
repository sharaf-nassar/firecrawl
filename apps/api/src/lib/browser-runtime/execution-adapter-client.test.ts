import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalAbsoluteUnixSocketPathSchema } from "../../config";
import type { AdapterAuthorizationBinding } from "../browser-state/types";
import { EXECUTION_ADAPTER_MAX_LINE_BYTES } from "./execution-adapter-contracts";
import { createSocketExecutionAdapter } from "./execution-adapter-client";
import { PROMPT_LOOP_POLICY_V1 } from "./protocol";

const AUTHORIZATION_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../../host/browser-runtime/protocol/execution-adapter-authorization-v1.fixture.json",
    ),
    "utf8",
  ),
) as {
  fixtureVersion: number;
  transport: {
    encoding: string;
    framing: string;
    apiAfterAuthorized: string;
    adapterAfterAuthorizationEof: string;
  };
  binding: AdapterAuthorizationBinding;
  accepted: unknown;
  authorized: unknown;
  terminal: unknown;
};

const REQUEST_ID = "0198f37a-5a9c-7b20-8000-000000000001";
const JOB_ID = "0198f37a-5a9c-7b20-8000-000000000002";
const SUPERVISOR_ID = "0198f37a-5a9c-7b20-8000-000000000003";
const RUN_ID = "0198f37a-5a9c-7b20-8000-000000000004";
const CORRELATION_ID = "0198f37a-5a9c-7b20-8000-000000000005";
const BINDING: AdapterAuthorizationBinding = {
  adapterJobId: JOB_ID,
  adapterSupervisorId: SUPERVISOR_ID,
  adapterProcessId: 4242,
};
const PROMPT_RESULT = {
  output: "done",
  turnCount: 1,
  actionCount: 0,
  usage: { inputTokens: 10, outputTokens: 2 },
  protocol: {
    toolEventCount: 0,
    approvalEventCount: 0,
    decisionSchemaVersion: 1,
    observationSchemaVersion: 1,
  },
};
const CODE_RESULT = {
  stdout: "ok\n",
  result: "ok",
  stderr: "",
  exitCode: 0,
  killed: false,
};
const SHA256 = "a".repeat(64);
const HEALTH_RESULT = {
  version: 1,
  status: "ok",
  codexCliVersion: "0.145.0",
  codexArtifactSha256: SHA256,
  codexProtocolSchemaSha256: "b".repeat(64),
  brokerProtocolSha256: "c".repeat(64),
  model: "gpt-5.6-terra",
  reasoningEffort: "medium",
};
const HOST_STATUS_RESULT = {
  version: 1,
  preparedHostJobs: 1,
  startingHostJobs: 2,
  runningHostJobs: 3,
  unsettledHostJobs: 4,
  orphanProcesses: 0,
};
const DIAGNOSE_RESULT = {
  version: 1,
  correlationId: CORRELATION_ID,
  jobId: JOB_ID,
  phase: "running",
  hostInitPid: 4242,
  pidfdLive: true,
  pidfdPidMatches: true,
  controlLeaseConnected: true,
  inertRelayFdPresent: false,
  relayListenerPresent: true,
  cdpRelayOpened: true,
  payloadStartedCount: 1,
  payloadMarkerPresent: true,
  callbackCount: 0,
  browserEffectCount: 0,
  runcState: "running",
  cgroupPresent: true,
  jobDirectoryPresent: true,
  childCount: 1,
  cleanupFailure: false,
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function frameReader(socket: Socket) {
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return async () => {
    const next = await iterator.next();
    if (next.done) return null;
    return JSON.parse(next.value) as unknown;
  };
}

async function fakeAdapter(
  handler: (socket: Socket, readFrame: () => Promise<unknown>) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "firecrawl-adapter-"));
  const socketPath = path.join(directory, "adapter.sock");
  const sockets = new Set<Socket>();
  let handlerError: unknown;
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void handler(socket, frameReader(socket)).catch(error => {
      handlerError = error;
      socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
    if (handlerError) throw handlerError;
  };
  cleanups.push(close);
  return { socketPath };
}

function promptInput(
  onAccepted: (
    binding: AdapterAuthorizationBinding,
  ) => Promise<void> = async () => undefined,
  deadline = new Date(Date.now() + 5_000),
) {
  return {
    adapterJobId: JOB_ID,
    adapterSupervisorId: SUPERVISOR_ID,
    capabilityToken: "a".repeat(43),
    runId: RUN_ID,
    prompt: "Inspect the page",
    initialObservation: {
      version: 1 as const,
      type: "initial" as const,
      sequence: 0 as const,
      page: {
        url: "https://fixture.example/",
        title: "Fixture",
        snapshotExcerpt: "heading",
      },
    },
    model: "gpt-5.6-terra" as const,
    reasoningEffort: "medium" as const,
    decisionSchemaVersion: 1 as const,
    observationSchemaVersion: 1 as const,
    loopPolicy: PROMPT_LOOP_POLICY_V1,
    deadline,
    correlationId: CORRELATION_ID,
    onAccepted,
  };
}

function codeInput(
  onAccepted: (
    binding: AdapterAuthorizationBinding,
  ) => Promise<void> = async () => undefined,
) {
  return {
    adapterJobId: JOB_ID,
    adapterSupervisorId: SUPERVISOR_ID,
    capabilityToken: "a".repeat(43),
    runId: RUN_ID,
    language: "node" as const,
    source: "return document.title",
    deadline: new Date(Date.now() + 5_000),
    correlationId: CORRELATION_ID,
    onAccepted,
  };
}

function adapter(socketPath: string) {
  return createSocketExecutionAdapter({
    socketPath,
    requestIdFactory: () => REQUEST_ID,
  });
}

async function accept(
  socket: Socket,
  readFrame: () => Promise<unknown>,
): Promise<void> {
  socket.write(
    `${JSON.stringify({
      version: 1,
      requestId: REQUEST_ID,
      type: "accepted",
      binding: BINDING,
    })}\n`,
  );
  expect(await readFrame()).toEqual({
    version: 1,
    requestId: REQUEST_ID,
    type: "authorized",
    binding: BINDING,
  });
}

describe("socket execution adapter", () => {
  it("performs strict one-frame shallow health without authorization", async () => {
    const server = await fakeAdapter(async (socket, readFrame) => {
      expect(await readFrame()).toEqual({
        version: 1,
        requestId: REQUEST_ID,
        method: "health",
        body: {},
      });
      expect(await readFrame()).toBeNull();
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: HEALTH_RESULT,
        })}\n`,
      );
    });

    await expect(adapter(server.socketPath).health()).resolves.toEqual(
      HEALTH_RESULT,
    );
  });

  it("returns authoritative aggregate host status", async () => {
    const server = await fakeAdapter(async (socket, readFrame) => {
      expect(await readFrame()).toEqual({
        version: 1,
        requestId: REQUEST_ID,
        method: "status",
        body: {},
      });
      expect(await readFrame()).toBeNull();
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: HOST_STATUS_RESULT,
        })}\n`,
      );
    });

    await expect(adapter(server.socketPath).status()).resolves.toEqual(
      HOST_STATUS_RESULT,
    );
  });

  it("returns only the exact correlation-scoped host diagnostic", async () => {
    const server = await fakeAdapter(async (socket, readFrame) => {
      expect(await readFrame()).toEqual({
        version: 1,
        requestId: REQUEST_ID,
        method: "diagnose_host_job",
        body: {
          correlationId: CORRELATION_ID,
          jobId: JOB_ID,
        },
      });
      expect(await readFrame()).toBeNull();
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: DIAGNOSE_RESULT,
        })}\n`,
      );
    });

    await expect(
      adapter(server.socketPath).diagnoseHostJob(CORRELATION_ID, JOB_ID),
    ).resolves.toEqual(DIAGNOSE_RESULT);
  });

  it("rejects extra health, status, and diagnostic fields", async () => {
    for (const testCase of [
      {
        body: { ...HEALTH_RESULT, path: "/home/private/.codex" },
        method: "health",
        invoke: (client: ReturnType<typeof adapter>) => client.health(),
      },
      {
        body: { ...HOST_STATUS_RESULT, secret: "leak" },
        method: "status",
        invoke: (client: ReturnType<typeof adapter>) => client.status(),
      },
      {
        body: { ...DIAGNOSE_RESULT, environment: { SECRET: "value" } },
        method: "diagnose_host_job",
        invoke: (client: ReturnType<typeof adapter>) =>
          client.diagnoseHostJob(CORRELATION_ID, JOB_ID),
      },
    ]) {
      const server = await fakeAdapter(async (socket, readFrame) => {
        const request = (await readFrame()) as { method: string };
        expect(await readFrame()).toBeNull();
        socket.end(
          `${JSON.stringify({
            version: 1,
            requestId: REQUEST_ID,
            type: "result",
            body: testCase.body,
          })}\n`,
        );
        expect(request.method).toBe(testCase.method);
      });
      const client = adapter(server.socketPath);
      await expect(testCase.invoke(client)).rejects.toMatchObject({
        category: "adapter_protocol_error",
      });
    }
  });

  it("sends the exact prompt body and authorizes its accepted binding", async () => {
    const accepted = vi.fn(async () => undefined);
    const server = await fakeAdapter(async (socket, readFrame) => {
      const request = await readFrame();
      expect(request).toEqual({
        version: 1,
        requestId: REQUEST_ID,
        method: "execute_prompt",
        body: {
          adapterJobId: JOB_ID,
          adapterSupervisorId: SUPERVISOR_ID,
          capabilityToken: "a".repeat(43),
          runId: RUN_ID,
          prompt: "Inspect the page",
          initialObservation: {
            version: 1,
            type: "initial",
            sequence: 0,
            page: {
              url: "https://fixture.example/",
              title: "Fixture",
              snapshotExcerpt: "heading",
            },
          },
          model: "gpt-5.6-terra",
          reasoningEffort: "medium",
          decisionSchemaVersion: 1,
          observationSchemaVersion: 1,
          loopPolicy: PROMPT_LOOP_POLICY_V1,
          deadline: expect.any(String),
          correlationId: CORRELATION_ID,
        },
      });
      expect(AUTHORIZATION_FIXTURE).toMatchObject({
        fixtureVersion: 1,
        transport: {
          encoding: "utf-8",
          framing: "newline-delimited-json",
          apiAfterAuthorized: "shutdown_write",
          adapterAfterAuthorizationEof: "continue_write_until_terminal",
        },
        binding: BINDING,
      });
      const apiWriteEnded = once(socket, "end");
      socket.write(`${JSON.stringify(AUTHORIZATION_FIXTURE.accepted)}\n`);
      expect(await readFrame()).toEqual(AUTHORIZATION_FIXTURE.authorized);
      await apiWriteEnded;
      socket.end(`${JSON.stringify(AUTHORIZATION_FIXTURE.terminal)}\n`);
    });

    await expect(
      adapter(server.socketPath).executePromptRun(
        promptInput(accepted),
        new AbortController().signal,
      ),
    ).resolves.toEqual(PROMPT_RESULT);
    expect(accepted).toHaveBeenCalledWith(BINDING);
  });

  it("sends the exact code body and returns its strict result", async () => {
    const input = codeInput();
    const server = await fakeAdapter(async (socket, readFrame) => {
      expect(await readFrame()).toEqual({
        version: 1,
        requestId: REQUEST_ID,
        method: "execute_code",
        body: {
          adapterJobId: JOB_ID,
          adapterSupervisorId: SUPERVISOR_ID,
          capabilityToken: "a".repeat(43),
          runId: RUN_ID,
          language: "node",
          source: "return document.title",
          deadline: input.deadline.toISOString(),
          correlationId: CORRELATION_ID,
        },
      });
      await accept(socket, readFrame);
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: CODE_RESULT,
        })}\n`,
      );
    });

    await expect(
      adapter(server.socketPath).executeCodeRun(
        input,
        new AbortController().signal,
      ),
    ).resolves.toEqual(CODE_RESULT);
  });

  it("awaits durable acceptance before sending authorization", async () => {
    let release!: () => void;
    const durable = new Promise<void>(resolve => {
      release = resolve;
    });
    let authorizationSeen = false;
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.write(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "accepted",
          binding: BINDING,
        })}\n`,
      );
      const authorization = readFrame().then(frame => {
        authorizationSeen = true;
        return frame;
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(authorizationSeen).toBe(false);
      release();
      expect(await authorization).toEqual({
        version: 1,
        requestId: REQUEST_ID,
        type: "authorized",
        binding: BINDING,
      });
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: PROMPT_RESULT,
        })}\n`,
      );
    });

    await expect(
      adapter(server.socketPath).executePromptRun(
        promptInput(async () => durable),
        new AbortController().signal,
      ),
    ).resolves.toEqual(PROMPT_RESULT);
  });

  it("does not consume a terminal response while acceptance is pending", async () => {
    let release!: () => void;
    const durable = new Promise<void>(resolve => {
      release = resolve;
    });
    let settled = false;
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "accepted",
          binding: BINDING,
        })}\n${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: PROMPT_RESULT,
        })}\n`,
      );
    });
    const execution = adapter(server.socketPath)
      .executePromptRun(
        promptInput(async () => durable),
        new AbortController().signal,
      )
      .finally(() => {
        settled = true;
      });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await expect(execution).rejects.toMatchObject({
      category: "adapter_protocol_error",
    });
  });

  it("rejects unknown response fields after a valid handshake", async () => {
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      await accept(socket, readFrame);
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: PROMPT_RESULT,
          surprise: true,
        })}\n`,
      );
    });

    await expect(
      adapter(server.socketPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });
  });

  it("rejects a terminal result before accepted without invoking callback", async () => {
    const accepted = vi.fn(async () => undefined);
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: PROMPT_RESULT,
        })}\n`,
      );
    });

    await expect(
      adapter(server.socketPath).executePromptRun(
        promptInput(accepted),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });
    expect(accepted).not.toHaveBeenCalled();
  });

  it("rejects a mismatched accepted binding before durable activation", async () => {
    const accepted = vi.fn(async () => undefined);
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "accepted",
          binding: { ...BINDING, adapterJobId: randomUUID() },
        })}\n`,
      );
    });

    await expect(
      adapter(server.socketPath).executePromptRun(
        promptInput(accepted),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });
    expect(accepted).not.toHaveBeenCalled();
  });

  it("ignores private host error messages", async () => {
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      await accept(socket, readFrame);
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "error",
          error: {
            category: "codex_unavailable",
            message: "/home/private/.codex stderr secret",
          },
        })}\n`,
      );
    });

    const execution = adapter(server.socketPath).executePromptRun(
      promptInput(),
      new AbortController().signal,
    );
    await expect(execution).rejects.toMatchObject({
      category: "codex_unavailable",
      message: "Local Codex execution is unavailable",
    });
    await expect(execution).rejects.not.toThrow("/home/private");
  });

  it.each([
    ["malformed JSON", "{bad json\n"],
    [
      "mismatched request ID",
      `${JSON.stringify({
        version: 1,
        requestId: randomUUID(),
        type: "accepted",
        binding: BINDING,
      })}\n`,
    ],
  ])("rejects %s", async (_label, response) => {
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.end(response);
    });
    await expect(
      adapter(server.socketPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });
  });

  it("rejects duplicate accepted and duplicate terminal responses", async () => {
    const duplicateAccepted = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      await accept(socket, readFrame);
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "accepted",
          binding: BINDING,
        })}\n`,
      );
    });
    await expect(
      adapter(duplicateAccepted.socketPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });

    const duplicateTerminal = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      await accept(socket, readFrame);
      const terminal = `${JSON.stringify({
        version: 1,
        requestId: REQUEST_ID,
        type: "result",
        body: PROMPT_RESULT,
      })}\n`;
      socket.end(terminal + terminal);
    });
    await expect(
      adapter(duplicateTerminal.socketPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });
  });

  it("rejects premature EOF and lines larger than 2 MiB", async () => {
    const premature = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      await accept(socket, readFrame);
      socket.end();
    });
    await expect(
      adapter(premature.socketPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });

    const oversized = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.end(`${"x".repeat(EXECUTION_ADAPTER_MAX_LINE_BYTES + 1)}\n`);
    });
    await expect(
      adapter(oversized.socketPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });
  });

  it("counts multibyte response framing by bytes", async () => {
    const multibyte = "é".repeat(
      Math.floor(EXECUTION_ADAPTER_MAX_LINE_BYTES / 2) + 1,
    );
    expect(multibyte.length).toBeLessThan(EXECUTION_ADAPTER_MAX_LINE_BYTES);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(
      EXECUTION_ADAPTER_MAX_LINE_BYTES,
    );
    let peerObservedEof = false;
    const oversized = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.write(multibyte);
      await once(socket, "end");
      peerObservedEof = true;
    });

    await expect(
      adapter(oversized.socketPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "adapter_protocol_error" });
    await vi.waitFor(() => expect(peerObservedEof).toBe(true));
  });

  it("destroys the connection on callback rejection without authorization", async () => {
    const rejection = Object.assign(new Error("durable activation failed"), {
      category: "capability_denied",
    });
    let receivedAfterAccepted: unknown = "pending";
    const server = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      socket.write(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "accepted",
          binding: BINDING,
        })}\n`,
      );
      receivedAfterAccepted = await readFrame();
    });

    await expect(
      adapter(server.socketPath).executePromptRun(
        promptInput(async () => {
          throw rejection;
        }),
        new AbortController().signal,
      ),
    ).rejects.toBe(rejection);
    await vi.waitFor(() => expect(receivedAfterAccepted).toBeNull());
  });

  it("sends one strict sanitized cancellation request", async () => {
    const server = await fakeAdapter(async (socket, readFrame) => {
      expect(await readFrame()).toEqual({
        version: 1,
        requestId: REQUEST_ID,
        method: "cancel",
        body: {
          runId: RUN_ID,
          reason: "unsafe reason",
        },
      });
      socket.end(
        `${JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          type: "result",
          body: { killed: true },
        })}\n`,
      );
    });

    await expect(
      adapter(server.socketPath).cancelExecutionRun(RUN_ID, " unsafe\nreason "),
    ).resolves.toEqual({ killed: true });
  });

  it("destroys the socket on abort and deadline", async () => {
    const abortController = new AbortController();
    const abortedReason = Object.assign(new Error("caller closed"), {
      category: "cancelled",
    });
    let abortPeerObservedEof = false;
    const abortServer = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      abortController.abort(abortedReason);
      await once(socket, "end");
      abortPeerObservedEof = true;
    });
    await expect(
      adapter(abortServer.socketPath).executePromptRun(
        promptInput(),
        abortController.signal,
      ),
    ).rejects.toBe(abortedReason);
    await vi.waitFor(() => expect(abortPeerObservedEof).toBe(true));

    let deadlinePeerObservedEof = false;
    const deadlineServer = await fakeAdapter(async (socket, readFrame) => {
      await readFrame();
      await once(socket, "end");
      deadlinePeerObservedEof = true;
    });
    await expect(
      adapter(deadlineServer.socketPath).executePromptRun(
        promptInput(async () => undefined, new Date(Date.now() + 30)),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "timed_out" });
    await vi.waitFor(() => expect(deadlinePeerObservedEof).toBe(true));
  });

  it("maps missing and refused sockets to mode-specific unavailable errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "firecrawl-missing-"));
    const missing = path.join(directory, "adapter.sock");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await expect(
      adapter(missing).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "codex_unavailable" });
    await expect(
      adapter(missing).executeCodeRun(
        codeInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "sandbox_unavailable" });

    const refusedDirectory = await mkdtemp(
      path.join(tmpdir(), "firecrawl-refused-"),
    );
    const refusedPath = path.join(refusedDirectory, "adapter.sock");
    await writeFile(refusedPath, "");
    cleanups.push(() => rm(refusedDirectory, { recursive: true, force: true }));
    await expect(
      adapter(refusedPath).executePromptRun(
        promptInput(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: "codex_unavailable" });
  });
});

describe("execution adapter socket configuration", () => {
  it.each([
    "/",
    "run/adapter.sock",
    "/run//adapter.sock",
    "/run/./adapter.sock",
    "/run/other/../adapter.sock",
    "/run/adapter/",
    "/run/\0adapter.sock",
  ])("rejects noncanonical socket path %j", value => {
    expect(canonicalAbsoluteUnixSocketPathSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it("accepts the fixed runtime socket path", () => {
    expect(
      canonicalAbsoluteUnixSocketPathSchema.parse(
        "/run/firecrawl-adapter/adapter.sock",
      ),
    ).toBe("/run/firecrawl-adapter/adapter.sock");
  });
});
