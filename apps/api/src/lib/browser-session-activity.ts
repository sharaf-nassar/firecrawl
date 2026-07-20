import { logger as _logger } from "./logger";
import {
  toDurableBrowserActivityInsert,
  type LegacyBrowserSessionActivityEvent as BrowserSessionActivityEvent,
} from "./browser-state/legacy-compatibility";
import { appendBrowserActivity } from "./browser-state/store";

const logger = _logger.child({ module: "browser-sessions" });

export function enqueueBrowserSessionActivity(
  event: Omit<BrowserSessionActivityEvent, "created_at">,
) {
  const row: BrowserSessionActivityEvent = {
    ...event,
    created_at: new Date().toISOString(),
  };

  return appendBrowserActivity(toDurableBrowserActivityInsert(row)).catch(
    err => {
      logger.error("Error inserting browser session activity", { err });
      throw err;
    },
  );
}

export async function processBrowserSessionActivityJobs() {
  // Compatibility no-op: activities are inserted synchronously at enqueue.
}
