import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { TextDecoder } from "node:util";

import type { AdapterAuthorizationBinding } from "../browser-state/types";
import {
  adapterAuthorizationAckSchema,
  adapterHealthRequestSchema,
  adapterHealthResultSchema,
  adapterHostStatusResultSchema,
  adapterStatusRequestSchema,
  adapterResponseSchema,
  cancelAdapterRequestSchema,
  cancelRunResultSchema,
  codeRunRequestSchema,
  codeRunResultSchema,
  EXECUTION_ADAPTER_MAX_LINE_BYTES,
  EXECUTION_ADAPTER_MAX_RUNTIME_MS,
  executeCodeAdapterRequestSchema,
  executePromptAdapterRequestSchema,
  diagnoseHostJobAdapterRequestSchema,
  diagnoseHostJobRequestBodySchema,
  diagnoseHostJobResultSchema,
  promptRunRequestSchema,
  promptRunResultSchema,
  adapterRequestIdSchema,
  type AdapterHealthResult,
  type AdapterHostStatusResult,
  type DiagnoseHostJobResult,
} from "./execution-adapter-contracts";
import {
  createPreAdmissionExecutionAdapterError,
  ExecutionAdapterError,
  type BrowserExecutionAdapter,
  type ExecutionAdapterErrorCategory,
} from "./execution-adapter";
import {
  codeRunInputSchema,
  promptRunInputSchema,
  type CodeRunInput,
  type CodeRunResult,
  type PromptRunInput,
  type PromptRunResult,
} from "./protocol";

type AdapterMethod =
  | "execute_prompt"
  | "execute_code"
  | "cancel"
  | "health"
  | "status"
  | "diagnose_host_job";

type SocketExecutionAdapterOptions = {
  socketPath: string;
  requestIdFactory?: () => string;
};

type ExecuteRequestOptions<T> = {
  method: AdapterMethod;
  request: unknown;
  signal: AbortSignal;
  deadline: Date | undefined;
  unavailableCategory?: "codex_unavailable" | "sandbox_unavailable";
  expectedBinding?: Pick<
    AdapterAuthorizationBinding,
    "adapterJobId" | "adapterSupervisorId"
  >;
  onAccepted?: (binding: AdapterAuthorizationBinding) => Promise<void>;
  parseResult(body: unknown): T;
};

type SocketExecutionAdapter = BrowserExecutionAdapter & {
  health(signal?: AbortSignal): Promise<AdapterHealthResult>;
  status(signal?: AbortSignal): Promise<AdapterHostStatusResult>;
  diagnoseHostJob(
    correlationId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<DiagnoseHostJobResult>;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function adapterError(category: ExecutionAdapterErrorCategory): Error {
  return new ExecutionAdapterError(category);
}

function protocolError(): Error {
  return adapterError("adapter_protocol_error");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : adapterError("cancelled");
}

function sanitizeCancellationReason(reason: string): string {
  const sanitized = reason
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 256);
  return sanitized.length > 0 ? sanitized : "cancelled";
}

function serializeFrame(frame: unknown): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (encoded.byteLength - 1 > EXECUTION_ADAPTER_MAX_LINE_BYTES) {
    throw protocolError();
  }
  return encoded;
}

function executeSocketRequest<T>(
  socketPath: string,
  input: ExecuteRequestOptions<T>,
): Promise<T> {
  if (input.signal.aborted) return Promise.reject(abortError(input.signal));

  return new Promise<T>((resolve, reject) => {
    let socket: Socket;
    let settled = false;
    let connected = false;
    let receivedEnd = false;
    let processing = false;
    let accepted = false;
    let authorized = false;
    let terminalSeen = false;
    let terminalResult: T | undefined;
    let terminalError: Error | undefined;
    let buffered = Buffer.alloc(0);
    const pendingLines: Buffer[] = [];

    const remainingMs =
      Math.min(
        input.deadline?.getTime() ??
          Date.now() + EXECUTION_ADAPTER_MAX_RUNTIME_MS,
        Date.now() + EXECUTION_ADAPTER_MAX_RUNTIME_MS,
      ) - Date.now();

    const cleanup = () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      cleanup();
      reject(error);
    };

    const succeed = (result: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      cleanup();
      resolve(result);
    };

    const finishAtEof = () => {
      if (settled || processing || !receivedEnd) return;
      if (buffered.byteLength !== 0 || pendingLines.length !== 0) {
        fail(protocolError());
        return;
      }
      if (!terminalSeen) {
        fail(protocolError());
        return;
      }
      if (terminalError) {
        fail(terminalError);
        return;
      }
      succeed(terminalResult as T);
    };

    const writeAuthorization = async (
      binding: AdapterAuthorizationBinding,
    ): Promise<void> => {
      const acknowledgement = adapterAuthorizationAckSchema.parse({
        version: 1,
        requestId: (input.request as { requestId: string }).requestId,
        type: "authorized",
        binding,
      });
      await new Promise<void>((writeResolve, writeReject) => {
        const onWriteError = () => {
          socket.off("error", onWriteError);
          writeReject(protocolError());
        };
        socket.once("error", onWriteError);
        socket.end(serializeFrame(acknowledgement), () => {
          socket.off("error", onWriteError);
          writeResolve();
        });
      });
    };

    const processResponse = async (line: Buffer): Promise<void> => {
      let decoded: string;
      let untrusted: unknown;
      try {
        decoded = utf8Decoder.decode(line);
        untrusted = JSON.parse(decoded);
      } catch {
        throw protocolError();
      }
      const parsed = adapterResponseSchema.safeParse(untrusted);
      if (!parsed.success) throw protocolError();
      const response = parsed.data;
      const requestId = (input.request as { requestId: string }).requestId;
      if (response.requestId !== requestId) throw protocolError();

      const requiresAuthorization =
        input.method === "execute_prompt" || input.method === "execute_code";
      if (response.type === "accepted") {
        if (
          !requiresAuthorization ||
          accepted ||
          terminalSeen ||
          input.expectedBinding === undefined ||
          input.onAccepted === undefined ||
          response.binding.adapterJobId !==
            input.expectedBinding.adapterJobId ||
          response.binding.adapterSupervisorId !==
            input.expectedBinding.adapterSupervisorId
        ) {
          throw protocolError();
        }
        accepted = true;
        socket.pause();
        try {
          await input.onAccepted(response.binding);
        } catch (error) {
          throw error instanceof Error ? error : protocolError();
        }
        if (pendingLines.length !== 0) throw protocolError();
        await writeAuthorization(response.binding);
        authorized = true;
        socket.resume();
        return;
      }

      if (requiresAuthorization && (!accepted || !authorized)) {
        throw protocolError();
      }
      if (terminalSeen) throw protocolError();
      terminalSeen = true;
      if (response.type === "error") {
        terminalError = adapterError(response.error.category);
        return;
      }
      try {
        terminalResult = input.parseResult(response.body);
      } catch {
        throw protocolError();
      }
    };

    const drain = async () => {
      if (processing || settled) return;
      processing = true;
      try {
        while (pendingLines.length > 0) {
          await processResponse(pendingLines.shift()!);
        }
      } catch (error) {
        fail(error instanceof Error ? error : protocolError());
        return;
      } finally {
        processing = false;
      }
      finishAtEof();
    };

    const onAbort = () => fail(abortError(input.signal));
    const timer = setTimeout(
      () => fail(adapterError("timed_out")),
      Math.max(1, remainingMs),
    );
    timer.unref?.();
    input.signal.addEventListener("abort", onAbort, { once: true });

    socket = createConnection({ path: socketPath, allowHalfOpen: true });
    socket.on("connect", () => {
      connected = true;
      try {
        const frame = serializeFrame(input.request);
        if (
          input.method === "cancel" ||
          input.method === "health" ||
          input.method === "status" ||
          input.method === "diagnose_host_job"
        )
          socket.end(frame);
        else socket.write(frame);
      } catch (error) {
        fail(error instanceof Error ? error : protocolError());
      }
    });
    socket.on("data", chunk => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline === -1) break;
        if (newline > EXECUTION_ADAPTER_MAX_LINE_BYTES || newline === 0) {
          fail(protocolError());
          return;
        }
        pendingLines.push(buffered.subarray(0, newline));
        buffered = buffered.subarray(newline + 1);
        if (pendingLines.length > 2) {
          fail(protocolError());
          return;
        }
      }
      if (buffered.byteLength > EXECUTION_ADAPTER_MAX_LINE_BYTES) {
        fail(protocolError());
        return;
      }
      void drain();
    });
    socket.on("end", () => {
      receivedEnd = true;
      finishAtEof();
    });
    socket.on("error", error => {
      if (settled) return;
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (
        !connected &&
        input.unavailableCategory !== undefined &&
        (code === "ENOENT" || code === "ECONNREFUSED")
      ) {
        fail(
          createPreAdmissionExecutionAdapterError(input.unavailableCategory),
        );
        return;
      }
      fail(protocolError());
    });
    socket.on("close", () => {
      if (!settled && !receivedEnd) fail(protocolError());
    });
  });
}

export function createSocketExecutionAdapter(
  options: SocketExecutionAdapterOptions,
): SocketExecutionAdapter {
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  const executePromptRun = (
    input: PromptRunInput,
    signal: AbortSignal,
  ): Promise<PromptRunResult> => {
    const parsed = promptRunInputSchema.parse(input);
    const requestId = adapterRequestIdSchema.parse(requestIdFactory());
    const { deadline, onAccepted, ...serializable } = parsed;
    const body = promptRunRequestSchema.parse({
      ...serializable,
      deadline: deadline.toISOString(),
    });
    const request = executePromptAdapterRequestSchema.parse({
      version: 1,
      requestId,
      method: "execute_prompt",
      body,
    });
    return executeSocketRequest(options.socketPath, {
      method: "execute_prompt",
      request,
      signal,
      deadline,
      unavailableCategory: "codex_unavailable",
      expectedBinding: parsed,
      onAccepted,
      parseResult: body => promptRunResultSchema.parse(body),
    });
  };

  const executeCodeRun = (
    input: CodeRunInput,
    signal: AbortSignal,
  ): Promise<CodeRunResult> => {
    const parsed = codeRunInputSchema.parse(input);
    const requestId = adapterRequestIdSchema.parse(requestIdFactory());
    const { deadline, onAccepted, ...serializable } = parsed;
    const body = codeRunRequestSchema.parse({
      ...serializable,
      deadline: deadline.toISOString(),
    });
    const request = executeCodeAdapterRequestSchema.parse({
      version: 1,
      requestId,
      method: "execute_code",
      body,
    });
    return executeSocketRequest(options.socketPath, {
      method: "execute_code",
      request,
      signal,
      deadline,
      unavailableCategory: "sandbox_unavailable",
      expectedBinding: parsed,
      onAccepted,
      parseResult: body => codeRunResultSchema.parse(body),
    });
  };

  return {
    executePromptRun,
    executeCodeRun,
    async cancelExecutionRun(runId, reason) {
      const requestId = adapterRequestIdSchema.parse(requestIdFactory());
      const request = cancelAdapterRequestSchema.parse({
        version: 1,
        requestId,
        method: "cancel",
        body: {
          runId,
          reason: sanitizeCancellationReason(reason),
        },
      });
      return executeSocketRequest(options.socketPath, {
        method: "cancel",
        request,
        signal: new AbortController().signal,
        deadline: undefined,
        parseResult: body => cancelRunResultSchema.parse(body),
      });
    },
    async health(signal = new AbortController().signal) {
      const requestId = adapterRequestIdSchema.parse(requestIdFactory());
      const request = adapterHealthRequestSchema.parse({
        version: 1,
        requestId,
        method: "health",
        body: {},
      });
      return executeSocketRequest(options.socketPath, {
        method: "health",
        request,
        signal,
        deadline: new Date(Date.now() + 10_000),
        unavailableCategory: "sandbox_unavailable",
        parseResult: body => adapterHealthResultSchema.parse(body),
      });
    },
    async status(signal = new AbortController().signal) {
      const requestId = adapterRequestIdSchema.parse(requestIdFactory());
      const request = adapterStatusRequestSchema.parse({
        version: 1,
        requestId,
        method: "status",
        body: {},
      });
      return executeSocketRequest(options.socketPath, {
        method: "status",
        request,
        signal,
        deadline: new Date(Date.now() + 10_000),
        unavailableCategory: "sandbox_unavailable",
        parseResult: body => adapterHostStatusResultSchema.parse(body),
      });
    },
    async diagnoseHostJob(
      correlationId,
      jobId,
      signal = new AbortController().signal,
    ) {
      const requestId = adapterRequestIdSchema.parse(requestIdFactory());
      const body = diagnoseHostJobRequestBodySchema.parse({
        correlationId,
        jobId,
      });
      const request = diagnoseHostJobAdapterRequestSchema.parse({
        version: 1,
        requestId,
        method: "diagnose_host_job",
        body,
      });
      return executeSocketRequest(options.socketPath, {
        method: "diagnose_host_job",
        request,
        signal,
        deadline: new Date(Date.now() + 10_000),
        unavailableCategory: "sandbox_unavailable",
        parseResult: value => diagnoseHostJobResultSchema.parse(value),
      });
    },
  };
}
