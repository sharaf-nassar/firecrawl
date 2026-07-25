import type {
  CodeRunInput,
  CodeRunResult,
  PromptRunInput,
  PromptRunResult,
} from "./protocol";

/** @public */
export class ExecutionAdapterError extends Error {
  constructor(
    public readonly category: "codex_unavailable" | "sandbox_unavailable",
  ) {
    super(
      category === "codex_unavailable"
        ? "Local Codex execution is unavailable"
        : "Local sandbox execution is unavailable",
    );
    this.name = "ExecutionAdapterError";
  }
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
