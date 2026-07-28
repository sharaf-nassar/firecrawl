/** @public Shared API WebSocket and relay forwarding limits. */
export const BROWSER_RELAY_LIMITS = Object.freeze({
  frameBytes: 24 * 1024 * 1024,
  queueBytes: 32 * 1024 * 1024,
  pauseBytes: 16 * 1024 * 1024,
  resumeBytes: 8 * 1024 * 1024,
  outstandingIds: 1_024,
});

/** @public Global express-ws options derived from the relay frame bound. */
export const BROWSER_RELAY_WS_OPTIONS = Object.freeze({
  maxPayload: BROWSER_RELAY_LIMITS.frameBytes,
});

/** @public First application frame emitted after the CDP relay is fully open. */
export const BROWSER_RELAY_READY = Object.freeze({
  version: 1,
  type: "cdp_relay_ready",
} as const);

/** @public Canonical wire encoding of {@link BROWSER_RELAY_READY}. */
export const BROWSER_RELAY_READY_FRAME = JSON.stringify(BROWSER_RELAY_READY);
