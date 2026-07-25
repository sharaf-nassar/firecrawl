import type {
  browser_interact_actions,
  browser_interact_runs,
  browser_session_activities,
  browser_sessions,
} from "../../db/schema/public";
import type { BrowserOperationResultV1 } from "../scrape-interact/browser-service-contracts";

/** @public */
export type { BrowserOperationResultV1 };

export type BrowserSessionState =
  | "creating"
  | "replaying"
  | "ready"
  | "executing"
  | "stopping"
  | "destroyed"
  | "expired"
  | "interrupted"
  | "error";

export type InteractRunState =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type BrowserInteractActionState =
  | "prepared"
  | "executing"
  | "succeeded"
  | "rejected_no_effect"
  | "failed_no_effect"
  | "cancelled_no_effect"
  | "outcome_unknown";

/** @public */
export type BrowserOperationEffect = "read_only" | "side_effecting";

export type BrowserOperation =
  | { kind: "snapshot" }
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string }
  | { kind: "type"; ref: string; value: string; delayMs: number }
  | { kind: "press"; ref: string; key: string }
  | { kind: "select"; ref: string; values: string[] }
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "wait"; milliseconds: number }
  | { kind: "get_text"; ref?: string }
  | { kind: "get_url" }
  | { kind: "navigate"; url: string }
  | { kind: "evaluate"; expression: string; args: Record<string, unknown> };

export interface BoundedPageState {
  url: string;
  title: string;
  snapshotExcerpt: string;
}

export type AdapterAuthorizationBinding = {
  adapterJobId: string;
  adapterSupervisorId: string;
  adapterProcessId: number;
};

export type AdapterPendingBinding = Omit<
  AdapterAuthorizationBinding,
  "adapterProcessId"
> & { adapterProcessId: null };

export type AdapterPendingAuthorizationInput = {
  adapterJobId: string;
  adapterSupervisorId: string;
  capabilityToken: string;
  onAccepted(binding: AdapterAuthorizationBinding): Promise<void>;
};

export type ObservationV1 =
  | {
      version: 1;
      type: "initial";
      sequence: 0;
      page: BoundedPageState;
    }
  | {
      version: 1;
      type: "action_result";
      sequence: number;
      actionId: string;
      actionKind: BrowserOperation["kind"];
      outcome: "succeeded" | "rejected_no_effect" | "failed_no_effect";
      result?: BrowserOperationResultV1;
      error?: { category: string; message: string };
      page: BoundedPageState;
    };

export interface SubmitBrowserActionV1 {
  version: 1;
  adapterJobId: string;
  sequence: number;
  actionId: string;
  proposalHash: string;
  effect: BrowserOperationEffect;
  operation: BrowserOperation;
}

type BrowserSessionSelect = typeof browser_sessions.$inferSelect;
type BrowserInteractRunSelect = typeof browser_interact_runs.$inferSelect;
type BrowserInteractActionSelect = typeof browser_interact_actions.$inferSelect;

export type BrowserSessionRow = Omit<BrowserSessionSelect, "state"> & {
  state: BrowserSessionState;
};

export type BrowserInteractRunRow = Omit<BrowserInteractRunSelect, "state"> & {
  state: InteractRunState;
};

export type BrowserInteractActionRow = Omit<
  BrowserInteractActionSelect,
  "state" | "effect" | "operation" | "result"
> & {
  state: BrowserInteractActionState;
  effect: BrowserOperationEffect;
  operation: BrowserOperation;
  result: BrowserOperationResultV1 | null;
};

export type CreateBrowserSessionInput = Omit<
  typeof browser_sessions.$inferInsert,
  | "state"
  | "created_at"
  | "updated_at"
  | "terminal_at"
  | "terminal_reason"
  | "prompt_used"
  | "credits_used"
  | "prompt_credits_used"
> & {
  state?: BrowserSessionState;
};

export type BrowserSessionTransitionPatch = Partial<
  Pick<
    BrowserSessionRow,
    | "browser_id"
    | "current_run_id"
    | "last_activity_at"
    | "idle_deadline_at"
    | "terminal_at"
    | "terminal_reason"
    | "status"
    | "deleted_at"
  >
>;

export type CreateInteractRunInput = Omit<
  typeof browser_interact_runs.$inferInsert,
  | "state"
  | "queued_at"
  | "started_at"
  | "finished_at"
  | "cancelled_at"
  | "error_category"
  | "error_detail"
> & {
  state?: InteractRunState;
};

export type InteractRunTransitionPatch = Partial<
  Pick<
    BrowserInteractRunRow,
    | "adapter_process_id"
    | "adapter_job_id"
    | "adapter_supervisor_id"
    | "started_at"
    | "finished_at"
    | "cancelled_at"
    | "output_reference"
    | "artifact_references"
    | "error_category"
    | "error_detail"
  >
>;

export type BrowserActivityInput = Omit<
  typeof browser_session_activities.$inferInsert,
  "id"
>;

export interface AcquireProfileWriterInput {
  profileId: string;
  sessionId: string;
}

export interface BrowserProfileLease {
  profileId: string;
  sessionId: string;
}

export interface BrowserRecoveryResult {
  preparedActionsCancelled: number;
  executingActionsUnknown: number;
  runsInterrupted: number;
  sessionsInterrupted: number;
  capabilitiesRevoked: number;
  grantsRevoked: number;
  writerLeasesCleared: number;
}
