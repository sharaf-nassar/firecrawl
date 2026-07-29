import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  BrowserOperation,
  BrowserOperationEffect,
  SubmitBrowserActionV1,
} from "../browser-state/types";
import { canonicalUuidSchema } from "../scrape-interact/browser-service-contracts";
import { browserOperationSchema } from "./protocol";

const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 10_000;

/** @public Strict wire schema for the adapter action callback. */
export const submitBrowserActionV1Schema: z.ZodType<SubmitBrowserActionV1> =
  z.strictObject({
    version: z.literal(1),
    adapterJobId: canonicalUuidSchema,
    sequence: z.number().int().min(1).max(25),
    actionId: canonicalUuidSchema,
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    effect: z.enum(["read_only", "side_effecting"]),
    operation: browserOperationSchema,
  });

function canonicalJsonValue(
  value: unknown,
  state: { seen: WeakSet<object>; nodes: number },
  depth: number,
): string {
  state.nodes += 1;
  if (depth > MAX_CANONICAL_DEPTH || state.nodes > MAX_CANONICAL_NODES) {
    throw new TypeError("JSON value exceeds structural bounds");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON number must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Value is not JSON-safe");
  }
  if (state.seen.has(value)) throw new TypeError("Cyclic JSON is forbidden");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map(item => canonicalJsonValue(item, state, depth + 1))
        .join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain records");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        key =>
          `${JSON.stringify(key)}:${canonicalJsonValue(
            record[key],
            state,
            depth + 1,
          )}`,
      )
      .join(",")}}`;
  } finally {
    state.seen.delete(value);
  }
}

/** @public Canonical JSON preserving exact JSON scalar semantics. */
export function canonicalBrowserActionJson(value: unknown): string {
  return canonicalJsonValue(
    value,
    { seen: new WeakSet<object>(), nodes: 0 },
    0,
  );
}

/** @public */
export function normalizeBrowserAction(operation: BrowserOperation): {
  normalizedProposalHash: string;
  effect: BrowserOperationEffect;
} {
  const parsed = browserOperationSchema.parse(operation);
  const normalizedProposalHash = createHash("sha256")
    .update(canonicalBrowserActionJson(parsed), "utf8")
    .digest("hex");
  const effect: BrowserOperationEffect = [
    "extract",
    "hover",
    "hover_batch",
    "screenshot",
    "wait",
  ].includes(parsed.kind)
    ? "read_only"
    : "side_effecting";
  return { normalizedProposalHash, effect };
}

/** @public Parses and authenticates the adapter's derived action fields. */
export function parseSubmitBrowserActionV1(
  value: unknown,
): SubmitBrowserActionV1 {
  const proposal = submitBrowserActionV1Schema.parse(value);
  const normalized = normalizeBrowserAction(proposal.operation);
  if (
    proposal.proposalHash !== normalized.normalizedProposalHash ||
    proposal.effect !== normalized.effect
  ) {
    throw Object.assign(
      new Error("Adapter action normalization does not match host policy"),
      { category: "model_protocol_error" },
    );
  }
  return proposal;
}
