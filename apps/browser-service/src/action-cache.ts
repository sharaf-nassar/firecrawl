import { createHash } from "node:crypto";

import {
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  canonicalJson,
  type BrowserActionExecutionResultV1,
  type BrowserActionExecutionV1,
  type BrowserOperation,
} from "./contracts.js";

export type BrowserOperationEffect = BrowserActionExecutionV1["effect"];

const READ_ONLY_OPERATIONS = new Set<BrowserOperation["kind"]>([
  "extract",
  "hover",
  "hover_batch",
  "screenshot",
  "wait",
]);

export function trustedEffectForOperation(
  operation: BrowserOperation,
): BrowserOperationEffect {
  return READ_ONLY_OPERATIONS.has(operation.kind)
    ? "read_only"
    : "side_effecting";
}

export function normalizedProposalHashForOperation(
  operation: BrowserOperation,
): string {
  return createHash("sha256")
    .update(canonicalJson(operation), "utf8")
    .digest("hex");
}

export class ActionCacheError extends Error {
  readonly category = "model_protocol_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "ActionCacheError";
  }
}

const pendingActionBrand: unique symbol = Symbol("pendingAction");

export type PendingAction = Readonly<{
  actionId: string;
  runId: string;
  sequence: number;
  [pendingActionBrand]: true;
}>;

export type ActionCacheLookup =
  | Readonly<{
      kind: "dispatch";
      pending: PendingAction;
    }>
  | Readonly<{
      kind: "replay";
      result: BrowserActionExecutionResultV1;
    }>;

type PendingEntry = Readonly<{
  request: BrowserActionExecutionV1;
  identity: string;
  token: PendingAction;
}>;

type TerminalEntry = Readonly<{
  request: BrowserActionExecutionV1;
  identity: string;
  result: BrowserActionExecutionResultV1;
}>;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function protocolError(message: string): never {
  throw new ActionCacheError(message);
}

function assertResultIdentity(
  request: BrowserActionExecutionV1,
  result: BrowserActionExecutionResultV1,
): void {
  if (
    result.actionId !== request.actionId ||
    result.sequence !== request.sequence ||
    result.normalizedProposalHash !== request.normalizedProposalHash
  ) {
    throw new TypeError(
      "terminal action result identity does not match request",
    );
  }
}

function assertSuccessResultKind(
  request: BrowserActionExecutionV1,
  result: BrowserActionExecutionResultV1,
): void {
  if (
    result.outcome === "succeeded" &&
    result.result.kind !== request.operation.kind
  ) {
    throw new TypeError("operation result kind does not match operation");
  }
}

export class SessionActionCache {
  readonly #byRunSequence = new Map<string, TerminalEntry>();
  readonly #runSequenceByActionId = new Map<string, string>();
  #pendingEntry: PendingEntry | null = null;

  get size(): number {
    return this.#byRunSequence.size;
  }

  get pending(): boolean {
    return this.#pendingEntry !== null;
  }

  has(actionId: string): boolean {
    return this.#runSequenceByActionId.has(actionId);
  }

  begin(untrustedRequest: BrowserActionExecutionV1): ActionCacheLookup {
    const request = deepFreeze(
      actionExecutionRequestSchema.parse(untrustedRequest),
    );
    if (
      request.normalizedProposalHash !==
      normalizedProposalHashForOperation(request.operation)
    ) {
      protocolError("normalized proposal hash does not match operation");
    }
    const trustedEffect = trustedEffectForOperation(request.operation);
    if (request.effect !== trustedEffect) {
      protocolError("action effect does not match operation");
    }

    const identity = canonicalJson(request);
    const runSequence = `${request.runId}:${request.sequence}`;
    const existing = this.#byRunSequence.get(runSequence);
    if (existing !== undefined) {
      if (existing.identity !== identity) {
        protocolError("action run sequence was reused with another identity");
      }
      return Object.freeze({ kind: "replay", result: existing.result });
    }

    const actionRunSequence = this.#runSequenceByActionId.get(request.actionId);
    if (actionRunSequence !== undefined) {
      protocolError("action ID was reused with another identity");
    }

    if (this.#pendingEntry !== null) {
      protocolError("another action is pending for this session");
    }

    const token = Object.freeze({
      actionId: request.actionId,
      runId: request.runId,
      sequence: request.sequence,
      [pendingActionBrand]: true as const,
    });
    this.#pendingEntry = Object.freeze({ request, identity, token });
    return Object.freeze({ kind: "dispatch", pending: token });
  }

  succeed(
    pending: PendingAction,
    untrustedResult: BrowserActionExecutionResultV1,
  ): BrowserActionExecutionResultV1 {
    return this.#complete(pending, untrustedResult, "succeeded");
  }

  failNoEffect(
    pending: PendingAction,
    untrustedResult: BrowserActionExecutionResultV1,
  ): BrowserActionExecutionResultV1 {
    return this.#complete(pending, untrustedResult, "failed_no_effect");
  }

  abandon(pending: PendingAction): void {
    this.#takePending(pending);
  }

  #takePending(pending: PendingAction): PendingEntry {
    const entry = this.#pendingEntry;
    if (entry === null || entry.token !== pending) {
      throw new TypeError("pending action token is not active");
    }
    this.#pendingEntry = null;
    return entry;
  }

  #complete(
    pending: PendingAction,
    untrustedResult: BrowserActionExecutionResultV1,
    expectedOutcome: BrowserActionExecutionResultV1["outcome"],
  ): BrowserActionExecutionResultV1 {
    const entry = this.#takePending(pending);
    const result = deepFreeze(
      actionExecutionResultSchema.parse(untrustedResult),
    );
    if (result.outcome !== expectedOutcome) {
      throw new TypeError(`terminal action result must be ${expectedOutcome}`);
    }
    assertResultIdentity(entry.request, result);
    assertSuccessResultKind(entry.request, result);

    const terminal = Object.freeze({
      request: entry.request,
      identity: entry.identity,
      result,
    });
    const runSequence = `${entry.request.runId}:${entry.request.sequence}`;
    this.#byRunSequence.set(runSequence, terminal);
    this.#runSequenceByActionId.set(entry.request.actionId, runSequence);
    return result;
  }
}
