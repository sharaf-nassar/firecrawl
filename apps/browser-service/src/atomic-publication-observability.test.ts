import { describe, expect, test, vi } from "vitest";

import {
  ATOMIC_REPEATED_CONFLICT_ALERT_THRESHOLD,
  createAtomicPublicationObservability,
  type AtomicPublicationObservabilityEvent,
} from "./atomic-publication-observability.js";

describe("atomic publication observability", () => {
  test("counts monotonically and emits severe alerts once", () => {
    const events: AtomicPublicationObservabilityEvent[] = [];
    const observer = createAtomicPublicationObservability(event => {
      events.push(event);
    });

    observer.count("unsupported");
    observer.count("unsupported");
    observer.count("success");

    expect(observer.snapshot()).toMatchObject({
      unsupported: 2,
      success: 1,
    });
    expect(
      events.filter(
        event =>
          event.event === "atomic_publish_alert" &&
          event.category === "unsupported",
      ),
    ).toHaveLength(1);
  });

  test("alerts once at the fixed repeated-conflict threshold", () => {
    const firstEvents: AtomicPublicationObservabilityEvent[] = [];
    const secondEvents: AtomicPublicationObservabilityEvent[] = [];
    const first = createAtomicPublicationObservability(event => {
      firstEvents.push(event);
    });
    const second = createAtomicPublicationObservability(event => {
      secondEvents.push(event);
    });
    for (
      let index = 0;
      index < ATOMIC_REPEATED_CONFLICT_ALERT_THRESHOLD + 2;
      index += 1
    ) {
      (index % 2 === 0 ? first : second).count("conflict");
    }
    expect(
      [...firstEvents, ...secondEvents].filter(
        event =>
          event.event === "atomic_publish_alert" &&
          event.category === "repeated_conflict",
      ),
    ).toHaveLength(1);
    expect(first.snapshot().conflict).toBe(second.snapshot().conflict);
  });

  test("keeps counters monotonic when reconciliation sinks change", () => {
    const firstEvents: AtomicPublicationObservabilityEvent[] = [];
    const secondEvents: AtomicPublicationObservabilityEvent[] = [];
    const first = createAtomicPublicationObservability(event =>
      firstEvents.push(event),
    );
    const before = first.snapshot().attempts;
    first.count("attempts");
    const second = createAtomicPublicationObservability(event =>
      secondEvents.push(event),
    );
    second.count("attempts");
    expect(
      firstEvents.find(
        event =>
          event.event === "atomic_publish_counter" &&
          event.counter === "attempts",
      ),
    ).toMatchObject({ value: before + 1 });
    expect(
      secondEvents.find(
        event =>
          event.event === "atomic_publish_counter" &&
          event.counter === "attempts",
      ),
    ).toMatchObject({ value: before + 2 });
  });

  test("emits only the allowlisted preflight shape and ignores sink failure", () => {
    const sink = vi.fn();
    const observer = createAtomicPublicationObservability(sink);
    observer.preflight({
      platform: "linux",
      architecture: "x64",
      interfaceVersion: "1.0.0",
      compiledNapiVersion: 9,
      runtimeNapiVersion: 9,
      filesystem: "overlay",
      result: "ready",
    });
    expect(sink).toHaveBeenCalledWith({
      event: "atomic_publish_preflight",
      platform: "linux",
      architecture: "x64",
      interfaceVersion: "1.0.0",
      compiledNapiVersion: 9,
      runtimeNapiVersion: 9,
      source: "bundled_package_relative",
      filesystem: "overlay",
      result: "ready",
    });
    expect(Object.keys(sink.mock.calls[0]![0]).sort()).toEqual(
      [
        "architecture",
        "compiledNapiVersion",
        "event",
        "filesystem",
        "interfaceVersion",
        "platform",
        "result",
        "runtimeNapiVersion",
        "source",
      ].sort(),
    );

    const throwing = createAtomicPublicationObservability(() => {
      throw new Error("diagnostic sink failed");
    });
    expect(() => throwing.count("io")).not.toThrow();
  });

  test("rejects values that could smuggle identifiers", () => {
    const observer = createAtomicPublicationObservability(() => undefined);
    expect(() =>
      observer.preflight({
        platform: "/tmp/state",
        architecture: "x64",
        interfaceVersion: "1.0.0",
        compiledNapiVersion: 9,
        runtimeNapiVersion: 9,
        filesystem: "overlay",
        result: "ready",
      }),
    ).toThrow(TypeError);
  });
});
