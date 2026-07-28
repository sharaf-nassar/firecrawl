import type {
  CodeRunInput,
  CodeRunResult,
  PromptRunInput,
  PromptRunResult,
} from "./protocol";

export type ExecutionAdapterErrorCategory =
  | "codex_unavailable"
  | "sandbox_unavailable"
  | "adapter_protocol_error"
  | "cancelled"
  | "timed_out"
  | "model_protocol_error"
  | "action_outcome_unknown"
  | "capability_denied"
  | "not_found";

const EXECUTION_ADAPTER_ERROR_MESSAGES: Record<
  ExecutionAdapterErrorCategory,
  string
> = {
  codex_unavailable: "Local Codex execution is unavailable",
  sandbox_unavailable: "Local sandbox execution is unavailable",
  adapter_protocol_error: "Browser execution adapter protocol failed",
  cancelled: "Browser execution was cancelled",
  timed_out: "Browser execution timed out",
  model_protocol_error: "Browser execution returned an invalid protocol result",
  action_outcome_unknown: "Browser action outcome is unknown",
  capability_denied: "Browser execution capability was denied",
  not_found: "Browser execution job was not found",
};

const PRE_ADMISSION_FAILURES = new WeakSet<Error>();

/** @public */
export class ExecutionAdapterError extends Error {
  constructor(public readonly category: ExecutionAdapterErrorCategory) {
    super(EXECUTION_ADAPTER_ERROR_MESSAGES[category]);
    this.name = "ExecutionAdapterError";
  }
}

export function createPreAdmissionExecutionAdapterError(
  category: "codex_unavailable" | "sandbox_unavailable",
): ExecutionAdapterError {
  const error = new ExecutionAdapterError(category);
  PRE_ADMISSION_FAILURES.add(error);
  return error;
}

export function isPreAdmissionExecutionAdapterError(error: unknown): boolean {
  return error instanceof Error && PRE_ADMISSION_FAILURES.has(error);
}

/** @public */
export interface BrowserExecutionAdapter {
  executePromptRun(
    input: PromptRunInput,
    signal: AbortSignal,
  ): Promise<PromptRunResult>;
  executeCodeRun(
    input: CodeRunInput,
    signal: AbortSignal,
  ): Promise<CodeRunResult>;
  cancelExecutionRun(runId: string, reason: string): Promise<{ killed: true }>;
}

/** @public */
export function createUnavailableExecutionAdapter(): BrowserExecutionAdapter {
  return {
    async executePromptRun() {
      throw new ExecutionAdapterError("codex_unavailable");
    },
    async executeCodeRun() {
      throw new ExecutionAdapterError("sandbox_unavailable");
    },
    async cancelExecutionRun() {
      // No host process was admitted, so cancellation is already complete.
      return { killed: true };
    },
  };
}

/** @public */
export const unavailableExecutionAdapter = createUnavailableExecutionAdapter();

export { createSocketExecutionAdapter } from "./execution-adapter-client";
