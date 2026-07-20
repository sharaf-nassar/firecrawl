import type {
  browser_session_activities,
  browser_sessions,
} from "../../db/schema/public";

export type LegacyBrowserSessionStatus = "active" | "destroyed" | "error";

export interface LegacyBrowserSessionRow {
  id: string;
  team_id: string;
  scrape_id?: string | null;
  browser_id: string;
  workspace_id: string;
  context_id: string;
  cdp_url: string;
  cdp_path: string;
  cdp_interactive_path: string;
  stream_web_view: boolean;
  status: LegacyBrowserSessionStatus;
  ttl_total: number;
  ttl_without_activity: number | null;
  credits_used: number | null;
  created_at: string;
  updated_at: string;
}

export interface LegacyBrowserSessionActivityEvent {
  team_id: string;
  session_id: string;
  source: "interact" | "browser";
  language: string;
  timeout: number;
  exit_code: number | null;
  killed: boolean;
  created_at: string;
}

export function toDurableBrowserSessionInsert(
  row: LegacyBrowserSessionRow,
  now = new Date(row.created_at),
): typeof browser_sessions.$inferInsert {
  const absoluteDeadline = new Date(now.getTime() + row.ttl_total * 1000);
  const idleDeadline = new Date(
    now.getTime() + (row.ttl_without_activity ?? row.ttl_total) * 1000,
  );

  // Existing controllers persist the request under the session UUID before
  // calling insertBrowserSession; team_id is that request's durable owner.
  return {
    ...row,
    request_id: row.id,
    owner_id: row.team_id,
    runtime_epoch: 1,
    replay_version: 1,
    state: row.status === "active" ? "ready" : row.status,
    absolute_deadline_at: absoluteDeadline.toISOString(),
    idle_deadline_at: idleDeadline.toISOString(),
    last_activity_at: now.toISOString(),
  };
}

export function toDurableBrowserActivityInsert(
  row: LegacyBrowserSessionActivityEvent,
): typeof browser_session_activities.$inferInsert {
  // Legacy activities belong to the session-scoped request created above.
  return {
    ...row,
    request_id: row.session_id,
    owner_id: row.team_id,
    mode: row.source === "interact" ? "code" : "browser_operation",
    timeout_ms: row.timeout,
    correlation_id: row.session_id,
  };
}
