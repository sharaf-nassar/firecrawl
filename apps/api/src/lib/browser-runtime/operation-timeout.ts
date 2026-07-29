/**
 * Per-action deadline with a 15-second completion margin over the largest
 * valid 30-second browser wait. The overall run deadline still caps it.
 */
export const BROWSER_ACTION_OPERATION_TIMEOUT_MS = 45_000;
