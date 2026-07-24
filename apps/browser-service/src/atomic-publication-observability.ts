const COUNTER_MAX = Number.MAX_SAFE_INTEGER;
export const ATOMIC_REPEATED_CONFLICT_ALERT_THRESHOLD = 8;

export type AtomicPublicationCounter =
  | "attempts"
  | "success"
  | "conflict"
  | "unsupported"
  | "cross_device"
  | "binding_invalid"
  | "denied"
  | "io"
  | "recovered_unpublished"
  | "recovered_published"
  | "ambiguous"
  | "orphan_temp"
  | "close_unverified";

export type AtomicPublicationAlertCategory =
  | "unsupported"
  | "cross_device"
  | "binding_invalid"
  | "ambiguous"
  | "orphan_temp"
  | "close_unverified"
  | "repeated_conflict";

export type AtomicPublicationMetricEvent = Readonly<{
  event: "atomic_publish_counter";
  counter: AtomicPublicationCounter;
  value: number;
}>;

export type AtomicPublicationAlertEvent = Readonly<{
  event: "atomic_publish_alert";
  category: AtomicPublicationAlertCategory;
}>;

export type AtomicPublicationPreflightEvent = Readonly<{
  event: "atomic_publish_preflight";
  platform: NodeJS.Platform;
  architecture: string;
  interfaceVersion: "1.0.0";
  compiledNapiVersion: number;
  runtimeNapiVersion: number;
  source: "bundled_package_relative";
  filesystem: "ext" | "xfs" | "btrfs" | "tmpfs" | "overlay" | "unknown";
  result: "ready" | "unsupported" | "failed";
}>;

export type AtomicPublicationObservabilityEvent =
  | AtomicPublicationMetricEvent
  | AtomicPublicationAlertEvent
  | AtomicPublicationPreflightEvent;

export type AtomicPublicationObservabilitySink = (
  event: AtomicPublicationObservabilityEvent,
) => void;

export type AtomicPublicationObservability = Readonly<{
  count(counter: AtomicPublicationCounter): void;
  preflight(
    event: Omit<AtomicPublicationPreflightEvent, "event" | "source">,
  ): void;
  snapshot(): Readonly<Record<AtomicPublicationCounter, number>>;
}>;

const COUNTERS: readonly AtomicPublicationCounter[] = Object.freeze([
  "attempts",
  "success",
  "conflict",
  "unsupported",
  "cross_device",
  "binding_invalid",
  "denied",
  "io",
  "recovered_unpublished",
  "recovered_published",
  "ambiguous",
  "orphan_temp",
  "close_unverified",
]);

const SEVERE_ALERTS: Readonly<
  Partial<Record<AtomicPublicationCounter, AtomicPublicationAlertCategory>>
> = Object.freeze({
  unsupported: "unsupported",
  cross_device: "cross_device",
  binding_invalid: "binding_invalid",
  ambiguous: "ambiguous",
  orphan_temp: "orphan_temp",
  close_unverified: "close_unverified",
});

const processCounters = Object.fromEntries(
  COUNTERS.map(counter => [counter, 0]),
) as Record<AtomicPublicationCounter, number>;
const processEmittedAlerts = new Set<AtomicPublicationAlertCategory>();

function safeEmit(
  sink: AtomicPublicationObservabilitySink,
  event: AtomicPublicationObservabilityEvent,
): void {
  try {
    sink(Object.freeze(event));
  } catch {
    // Diagnostics must never change publication or recovery behavior.
  }
}

function validPreflight(
  event: Omit<AtomicPublicationPreflightEvent, "event" | "source">,
): boolean {
  return (
    typeof event.platform === "string" &&
    event.platform.length > 0 &&
    event.platform.length <= 32 &&
    /^[a-z0-9_]+$/u.test(event.platform) &&
    typeof event.architecture === "string" &&
    event.architecture.length > 0 &&
    event.architecture.length <= 32 &&
    /^[A-Za-z0-9_]+$/u.test(event.architecture) &&
    event.interfaceVersion === "1.0.0" &&
    Number.isSafeInteger(event.compiledNapiVersion) &&
    event.compiledNapiVersion >= 0 &&
    Number.isSafeInteger(event.runtimeNapiVersion) &&
    event.runtimeNapiVersion >= 0 &&
    ["ext", "xfs", "btrfs", "tmpfs", "overlay", "unknown"].includes(
      event.filesystem,
    ) &&
    ["ready", "unsupported", "failed"].includes(event.result)
  );
}

export function createAtomicPublicationObservability(
  sink: AtomicPublicationObservabilitySink,
): AtomicPublicationObservability {
  if (typeof sink !== "function") {
    throw new TypeError("atomic publication observability sink is invalid");
  }
  return Object.freeze({
    count(counter): void {
      if (!COUNTERS.includes(counter)) {
        throw new TypeError("atomic publication counter is invalid");
      }
      processCounters[counter] = Math.min(
        COUNTER_MAX,
        processCounters[counter] + 1,
      );
      safeEmit(sink, {
        event: "atomic_publish_counter",
        counter,
        value: processCounters[counter],
      });
      const severe = SEVERE_ALERTS[counter];
      if (severe !== undefined && !processEmittedAlerts.has(severe)) {
        processEmittedAlerts.add(severe);
        safeEmit(sink, { event: "atomic_publish_alert", category: severe });
      }
      if (
        counter === "conflict" &&
        processCounters.conflict >=
          ATOMIC_REPEATED_CONFLICT_ALERT_THRESHOLD &&
        !processEmittedAlerts.has("repeated_conflict")
      ) {
        processEmittedAlerts.add("repeated_conflict");
        safeEmit(sink, {
          event: "atomic_publish_alert",
          category: "repeated_conflict",
        });
      }
    },

    preflight(event): void {
      if (!validPreflight(event)) {
        throw new TypeError("atomic publication preflight event is invalid");
      }
      safeEmit(sink, {
        event: "atomic_publish_preflight",
        ...event,
        source: "bundled_package_relative",
      });
    },

    snapshot(): Readonly<Record<AtomicPublicationCounter, number>> {
      return Object.freeze({ ...processCounters });
    },
  });
}
