import type {
  BrowserInteractActionState,
  BrowserSessionState,
  InteractRunState,
} from "./types";

export const browserSessionTransitions = {
  creating: ["replaying", "stopping", "interrupted", "error"],
  replaying: ["ready", "stopping", "interrupted", "error"],
  ready: ["executing", "stopping", "expired", "interrupted", "error"],
  executing: ["ready", "stopping", "expired", "interrupted", "error"],
  stopping: ["destroyed", "expired", "interrupted", "error"],
  destroyed: [],
  expired: [],
  interrupted: [],
  error: [],
} as const satisfies Record<
  BrowserSessionState,
  readonly BrowserSessionState[]
>;

export const interactRunTransitions = {
  queued: ["starting", "cancelled", "timed_out", "interrupted"],
  starting: ["running", "failed", "cancelled", "timed_out", "interrupted"],
  running: ["succeeded", "failed", "cancelled", "timed_out", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  interrupted: [],
} as const satisfies Record<InteractRunState, readonly InteractRunState[]>;

export const interactActionTransitions = {
  prepared: ["executing", "rejected_no_effect", "cancelled_no_effect"],
  executing: ["succeeded", "failed_no_effect", "outcome_unknown"],
  succeeded: [],
  rejected_no_effect: [],
  failed_no_effect: [],
  cancelled_no_effect: [],
  outcome_unknown: [],
} as const satisfies Record<
  BrowserInteractActionState,
  readonly BrowserInteractActionState[]
>;

function includesTransition<T extends string>(
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function isBrowserSessionTransition(
  from: BrowserSessionState,
  to: BrowserSessionState,
): boolean {
  return includesTransition(browserSessionTransitions, from, to);
}

export function assertBrowserSessionTransition(
  from: BrowserSessionState,
  to: BrowserSessionState,
): void {
  if (!isBrowserSessionTransition(from, to)) {
    throw new Error(`Invalid browser session transition: ${from} -> ${to}`);
  }
}

export function isInteractRunTransition(
  from: InteractRunState,
  to: InteractRunState,
): boolean {
  return includesTransition(interactRunTransitions, from, to);
}

export function assertInteractRunTransition(
  from: InteractRunState,
  to: InteractRunState,
): void {
  if (!isInteractRunTransition(from, to)) {
    throw new Error(`Invalid interact run transition: ${from} -> ${to}`);
  }
}

export function isInteractActionTransition(
  from: BrowserInteractActionState,
  to: BrowserInteractActionState,
): boolean {
  return includesTransition(interactActionTransitions, from, to);
}

export function assertInteractActionTransition(
  from: BrowserInteractActionState,
  to: BrowserInteractActionState,
): void {
  if (!isInteractActionTransition(from, to)) {
    throw new Error(`Invalid interact action transition: ${from} -> ${to}`);
  }
}
