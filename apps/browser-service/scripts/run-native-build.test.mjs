import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runNativeBuildOrphanFixtureForTest,
} from "./run-native-build.mjs";

const thisFile = fileURLToPath(import.meta.url);
const direct = resolve(process.argv[1] ?? "") === thisFile;
const runnerFile = new URL("./run-native-build.mjs", import.meta.url);
const buildRoot = new URL("../build/", import.meta.url);
const stageRoot = new URL(
  "../build/.atomic-directory-publication-stage/",
  import.meta.url,
);
const forbiddenEnvironmentKeys = Object.freeze([
  "NODE_OPTIONS",
  "node_path",
  "NoDe_Custom_Option",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CC",
  "CFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "NPM_CONFIG_CC",
  "NPM_CONFIG_CFLAGS",
  "NPM_CONFIG_CPPFLAGS",
  "NPM_CONFIG_LDFLAGS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "GCC_EXEC_PREFIX",
  "COMPILER_PATH",
  "LIBRARY_PATH",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "OBJC_INCLUDE_PATH",
  "DEPENDENCIES_OUTPUT",
  "SUNPRO_DEPENDENCIES",
  "GCC_SPECS",
  "GCC_PLUGIN_PATH",
  "PLUGIN_PATH",
  "COLLECT_GCC_OPTIONS",
  "SOME_PLUGIN_PATH",
  "USE_GKE_GCLOUD_AUTH_PLUGIN",
  "ATOMIC_BUILD_LOCK_TEST_ROLE",
  "ATOMIC_BUILD_LOCK_FIXTURE_ROLE",
]);

function productionEnvironment(extra = {}) {
  return {
    PATH: "/home/mamba/.nvm/versions/node/v22.22.1/bin:/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    ...extra,
  };
}

if (direct) {
  const warmStdio = spawnSync("/usr/bin/true", [], { stdio: "ignore" });
  if (
    warmStdio.error !== undefined ||
    warmStdio.status !== 0 ||
    warmStdio.signal !== null
  ) {
    throw new Error("native orphan stdio warmup failed");
  }
  const descriptorCount = () =>
    readdirSync("/proc/self/fd").filter((leaf) => /^[0-9]+$/.test(leaf))
      .length;
  const descriptorCountBefore = descriptorCount();
  const result = await runNativeBuildOrphanFixtureForTest();
  const descriptorDeadline = performance.now() + 2000;
  let descriptorCountAfter;
  do {
    globalThis.gc();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    descriptorCountAfter = descriptorCount();
  } while (
    descriptorCountAfter !== descriptorCountBefore &&
    performance.now() < descriptorDeadline
  );
  if (descriptorCountAfter !== descriptorCountBefore) {
    throw new Error(
      `native orphan descriptor leak: ${descriptorCountBefore} -> ${descriptorCountAfter}`,
    );
  }
  process.stdout.write(JSON.stringify(result));
} else {
  const { describe, expect, it } = await import("vitest");

  describe("retained native build lock", () => {
    it("exposes only the closed zero-argument orphan fixture seam", async () => {
      const module = await import("./run-native-build.mjs");
      expect(Object.keys(module)).toEqual([
        "runNativeBuildOrphanFixtureForTest",
      ]);
      expect(runNativeBuildOrphanFixtureForTest.length).toBe(0);
    });

    it("rejects injection before lock or staging activity", () => {
      const lock = new URL(
        ".atomic-directory-publication-build.lock",
        buildRoot,
      );
      const before = lstatSync(lock);
      expect(() => lstatSync(stageRoot)).toThrow(/ENOENT/);
      for (const key of forbiddenEnvironmentKeys) {
        const result = spawnSync(
          process.execPath,
          [runnerFile.pathname, "production"],
          {
            env: productionEnvironment({ [key]: "injected" }),
            encoding: "utf8",
          },
        );
        expect(result.status, key).not.toBe(0);
        expect(result.stderr, key).toMatch(/forbidden/);
        expect(() => lstatSync(stageRoot), key).toThrow(/ENOENT/);
      }
      const after = lstatSync(lock);
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeNs).toBe(before.mtimeNs);
    }, 10_000);

    it("rejects a malformed lock mode before staging activity", () => {
      const lock = new URL(
        ".atomic-directory-publication-build.lock",
        buildRoot,
      );
      const original = lstatSync(lock);
      const originalMode = original.mode & 0o7777;
      expect(originalMode).toBe(0o600);
      expect(() => lstatSync(stageRoot)).toThrow(/ENOENT/);
      chmodSync(lock, 0o640);
      try {
        const malformed = lstatSync(lock);
        const result = spawnSync(
          process.execPath,
          [runnerFile.pathname, "production"],
          { env: productionEnvironment(), encoding: "utf8" },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/private owned regular file/);
        expect(() => lstatSync(stageRoot)).toThrow(/ENOENT/);
        const after = lstatSync(lock);
        expect(after.dev).toBe(malformed.dev);
        expect(after.ino).toBe(malformed.ino);
        expect(after.mode).toBe(malformed.mode);
        expect(after.mtimeNs).toBe(malformed.mtimeNs);
      } finally {
        chmodSync(lock, originalMode);
      }
      expect(lstatSync(lock).mode & 0o7777).toBe(originalMode);
    });

    it("discards known staging but preserves foreign staging", () => {
      rmSync(stageRoot, { recursive: true, force: true });
      mkdirSync(stageRoot, { mode: 0o700 });
      const recovered = spawnSync(
        process.execPath,
        [runnerFile.pathname, "production"],
        { env: productionEnvironment(), encoding: "utf8" },
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(() => lstatSync(stageRoot)).toThrow(/ENOENT/);

      mkdirSync(stageRoot, { mode: 0o700 });
      const foreign = new URL("foreign", stageRoot);
      writeFileSync(foreign, "foreign", { mode: 0o600 });
      const rejected = spawnSync(
        process.execPath,
        [runnerFile.pathname, "production"],
        { env: productionEnvironment(), encoding: "utf8" },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toMatch(/foreign stale staging/);
      expect(lstatSync(foreign).isFile()).toBe(true);
      rmSync(stageRoot, { recursive: true });
    }, 10_000);

    it("keeps the same OFD locked after the helper exits", () => {
      const root = mkdtempSync(join(tmpdir(), "atomic-build-ofd-"));
      const path = join(root, "lock");
      const held = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const acquired = spawnSync(
          "/usr/bin/flock",
          ["--exclusive", "--timeout", "60", "9"],
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              held,
            ],
          },
        );
        expect(acquired.status).toBe(0);
        const contender = openSync(
          path,
          constants.O_RDWR | constants.O_NOFOLLOW,
        );
        try {
          const blocked = spawnSync(
            "/usr/bin/flock",
            ["--exclusive", "--nonblock", "9"],
            {
              stdio: [
                "ignore",
                "pipe",
                "pipe",
                "ignore",
                "ignore",
                "ignore",
                "ignore",
                "ignore",
                "ignore",
                contender,
              ],
            },
          );
          expect(blocked.status).not.toBe(0);
        } finally {
          closeSync(contender);
        }
      } finally {
        closeSync(held);
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps fd 9 through the closed orphan fixture seam", () => {
      const result = spawnSync(process.execPath, ["--expose-gc", thisFile], {
        cwd: new URL("..", import.meta.url),
        env: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          LANG: "C",
          TZ: "UTC",
          VITEST: "true",
        },
        encoding: "utf8",
        timeout: 300_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.addonCacheDriftRejected).toBe(true);
      expect(parsed.fixture).toMatchObject({
        result: { kind: "exit", code: 0 },
        fixtureControlVariant: 0,
        prepareNegativeCases: 36,
        isolatedPrepareCases: 7,
        wrongUidProbeSkipped: false,
        cleanupFinal: { closeRequests: 1, ownerClosed: true },
        lifecycleFinal: {
          pidfdCloseRequests: 1,
          pidfdCloseCompletions: 1,
          asyncWorkDeleteRequests: 1,
          asyncWorkDeleteCompletions: 1,
          promiseRefReleaseRequests: 1,
          promiseRefReleaseCompletions: 1,
          handleRefReleaseRequests: 1,
          handleRefReleaseCompletions: 1,
          externalFinalizerCalls: 1,
          cleanupTimerCloseRequests: 1,
          cleanupTimerCloseCompletions: 1,
          settlementOwnerCloseRequests: 1,
          settlementOwnerCloseCompletions: 1,
        },
        audit: {
          claimAttempts: 1,
          releaseWrites: 1,
          releaseCloses: 1,
          reapStarts: 1,
        },
        phase: {
          claimState: "reaped",
          claimAttempted: true,
          releaseState: "closed",
          releaseWriteAttempted: true,
          releaseWriteResult: "written",
          releaseWriterCloseAttempted: true,
          releaseWriterCloseResult: "closed",
          reapState: "settled",
          reapAttempted: true,
        },
      });
      const boundaryNames = [
        "ready",
        "driver-exit",
        "adoption",
        "evidence",
        "claim-ack",
        "contention",
        "release-write-attempt",
        "release-write-syscall",
        "release-write-result",
        "close-attempt",
        "close-syscall",
        "close-result",
        "promise-return",
        "promise-storage",
        "promise-pending",
        "promise-settlement",
        "repeated-reentry",
      ];
      expect(
        parsed.boundaryMatrix.map((entry) => entry.boundary.target),
      ).toEqual(boundaryNames);
      for (const entry of parsed.boundaryMatrix) {
        expect(
          entry.boundary.events.map((event) => event.name),
          entry.boundary.target,
        ).toEqual(boundaryNames);
        expect(entry.boundary, entry.boundary.target).toMatchObject({
          targetHits: 1,
          reentries:
            entry.boundary.target === "repeated-reentry" ? 3 : 1,
          stablePromise: true,
        });
        expect(entry.exactPidGone, entry.boundary.target).toBe(true);
        expect(entry.audit, entry.boundary.target).toMatchObject({
          claimAttempts: 1,
          releaseWrites: 1,
          releaseCloses: 1,
          reapStarts: 1,
        });
        expect(entry.prepareNegativeCases, entry.boundary.target).toBe(36);
        expect(entry.isolatedPrepareCases, entry.boundary.target).toBe(0);
        expect(entry.phase.reapState, entry.boundary.target).toBe("settled");
        expect(entry.phase.claimState, entry.boundary.target).toBe("reaped");
      }
      const writeResultBoundary = parsed.boundaryMatrix.find(
        (entry) => entry.boundary.target === "release-write-result",
      );
      expect(writeResultBoundary.phase).toMatchObject({
        releaseState: "failed",
        releaseWriteResult: { code: "EPIPE" },
        releaseWriterCloseResult: "closed",
      });
      expect(
        writeResultBoundary.boundary.events.find(
          (event) => event.name === "release-write-result",
        ).result,
      ).toBe("EPIPE");
      expect(writeResultBoundary.result).toMatchObject({
        kind: "signal",
        signal: 15,
      });
      const closeResultBoundary = parsed.boundaryMatrix.find(
        (entry) => entry.boundary.target === "close-result",
      );
      expect(closeResultBoundary.phase).toMatchObject({
        releaseState: "failed",
        releaseWriteResult: "written",
        releaseWriterCloseResult: { code: "EBADF" },
      });
      expect(
        closeResultBoundary.boundary.events.find(
          (event) => event.name === "close-result",
        ).result,
      ).toBe("EBADF");
      expect(parsed.faultVariants.map((entry) => entry.fault)).toEqual([
        "napi-promise",
        "napi-reference",
        "napi-async-create",
        "napi-async-queue",
        "pidfd-signal",
        "wait",
        "deadline",
        "claim-external",
        "claim-reference",
        "claim-timer-init",
        "claim-timer-start",
        "phase-graceful",
        "phase-term",
        "phase-kill",
        "post-kill-timeout",
        "audit-create",
        "settlement-handle-scope",
        "settlement-object",
        "settlement-property",
        "settlement-resolve",
        "settlement-reject",
        "settlement-owner-init",
        "settlement-owner-start",
        "settlement-owner-ref",
        "preauthority-ref-delete",
        "audit-cleanup-promise",
        "audit-lifecycle-promise",
        "audit-close-external",
        "audit-close-typedarray",
        "audit-property",
        "audit-reference",
        "setup-resolve",
        "preauthority-deferred-settle",
        "lifecycle-scope-close",
      ]);
      expect(
        parsed.faultVariants
          .filter((entry) => entry.error !== undefined)
          .map((entry) => [entry.fault, entry.error.category]),
      ).toEqual([
        ["napi-async-create", "atomic_publish_reap_job_creation_failed"],
        ["napi-async-queue", "atomic_publish_reap_queue_failed"],
        ["pidfd-signal", "atomic_publish_signal_failed"],
        ["wait", "atomic_publish_wait_failed"],
        ["deadline", "atomic_publish_deadline_failed"],
        ["post-kill-timeout", "atomic_publish_reap_timeout"],
        [
          "settlement-reject",
          "atomic_publish_settlement_retry_test_failed",
        ],
      ]);
      const settlementRetryExpectations = {
        "settlement-handle-scope": 2,
        "settlement-object": 3,
        "settlement-property": 3,
        "settlement-resolve": 2,
        "settlement-reject": 1,
      };
      for (const [index, entry] of parsed.faultVariants.entries()) {
        expect(entry.fixtureControlVariant, entry.fault).toBe(index + 1);
        expect(entry.exactPidGone, entry.fault).toBe(true);
        expect(entry.heartbeatTicks, entry.fault).toBeGreaterThan(0);
        expect(entry.audit.claimAttempts, entry.fault).toBe(
          entry.fault.startsWith("claim-") ||
            ["napi-promise", "napi-reference", "audit-create"].includes(
              entry.fault,
            ) ||
            [
              "settlement-owner-init",
              "settlement-owner-start",
              "settlement-owner-ref",
              "preauthority-ref-delete",
              "audit-cleanup-promise",
              "audit-lifecycle-promise",
              "audit-close-external",
              "audit-close-typedarray",
              "audit-property",
              "audit-reference",
              "setup-resolve",
              "preauthority-deferred-settle",
            ].includes(entry.fault)
            ? 2
            : 1,
        );
        expect(entry.audit.releaseWrites, entry.fault).toBe(1);
        expect(entry.audit.releaseCloses, entry.fault).toBe(1);
        expect(entry.audit.reapStarts, entry.fault).toBe(1);
        expect(entry.prepareNegativeCases, entry.fault).toBe(36);
        expect(entry.isolatedPrepareCases, entry.fault).toBe(0);
        expect(entry.wrongUidProbeSkipped, entry.fault).toBe(false);
        if (entry.error !== undefined) {
          expect(entry.error.cleanup, entry.fault).toBe(
            "exact_pid_cleanup_owner",
          );
          expect(entry.error.errno, entry.fault).toBe(
            entry.fault === "post-kill-timeout" ? 110 : 5,
          );
          expect(entry.error.cleanupFinal, entry.fault).toMatchObject({
            closeRequests: 1,
            ownerClosed: true,
          });
        }
        {
          const asyncWorkExpected =
            entry.fault === "napi-async-create" ? 0 : 1;
          expect(entry.lifecycleFinal, entry.fault).toMatchObject({
            pidfdCloseRequests: 1,
            pidfdCloseCompletions: 1,
            asyncWorkDeleteRequests: asyncWorkExpected,
            asyncWorkDeleteCompletions: asyncWorkExpected,
            promiseRefReleaseRequests: 1,
            promiseRefReleaseCompletions: 1,
            handleRefReleaseRequests: 1,
            handleRefReleaseCompletions: 1,
            externalFinalizerCalls: 1,
            cleanupTimerCloseRequests: 1,
            cleanupTimerCloseCompletions: 1,
            settlementOwnerCloseRequests: 1,
            settlementOwnerCloseCompletions: 1,
          });
          expect(entry.lifecycleFinal.settlementRetries, entry.fault).toBe(
            settlementRetryExpectations[entry.fault] ?? 0,
          );
        }
      }
      expect(
        parsed.faultVariants.find((entry) => entry.fault === "pidfd-signal")
          .audit.barrierStops,
      ).toBe(1);
      for (const name of [
        "napi-promise",
        "napi-reference",
        "claim-external",
        "claim-reference",
        "claim-timer-init",
        "claim-timer-start",
        "audit-create",
        "settlement-owner-init",
        "settlement-owner-start",
        "settlement-owner-ref",
        "preauthority-ref-delete",
        "audit-cleanup-promise",
        "audit-lifecycle-promise",
        "audit-close-external",
        "audit-close-typedarray",
        "audit-property",
        "audit-reference",
        "setup-resolve",
        "preauthority-deferred-settle",
      ]) {
        const entry = parsed.faultVariants.find((candidate) =>
          candidate.fault === name
        );
        expect(entry.audit.claimSetupFailures, name).toBe(1);
        expect(entry.result.kind, name).toBe("signal");
        expect(entry.result.signal, name).toBe(15);
      }
      const setupCounterBase = {
        externalCreateRequests: 1,
        externalCreateCompletions: 1,
        ownerRefCreateRequests: 1,
        ownerRefCreateCompletions: 1,
        settlementOwnerInitRequests: 1,
        settlementOwnerInitCompletions: 1,
        settlementOwnerInitFailures: 0,
        settlementOwnerStartRequests: 1,
        settlementOwnerStartCompletions: 1,
        settlementOwnerStartFailures: 0,
        settlementOwnerRefRequests: 1,
        settlementOwnerRefCompletions: 1,
        settlementOwnerRefFailures: 0,
        settlementOwnerCloseRequests: 1,
        settlementOwnerCloseCompletions: 1,
        preauthorityRefDeleteRequests: 1,
        preauthorityRefDeleteFailures: 0,
        preauthorityRefDeleteCompletions: 1,
        preauthorityRefDeleteRetries: 0,
        deferredSettleRequests: 0,
        deferredSettleFailures: 0,
        deferredSettleCompletions: 0,
        setupSettleRequests: 1,
        setupSettleFailures: 0,
        setupSettleCompletions: 1,
        setupResultRefDeleteRequests: 1,
        setupResultRefDeleteFailures: 0,
        setupResultRefDeleteCompletions: 1,
        mandatoryDeferredsCreated: 0,
        mandatoryDeferredsSettled: 0,
        preauthoritySettlementRetries: 0,
      };
      const setupCounterExpectations = {
        "napi-promise": {
          deferredSettleRequests: 2,
          deferredSettleCompletions: 2,
          mandatoryDeferredsCreated: 2,
          mandatoryDeferredsSettled: 2,
        },
        "napi-reference": {
          deferredSettleRequests: 3,
          deferredSettleCompletions: 3,
          mandatoryDeferredsCreated: 3,
          mandatoryDeferredsSettled: 3,
        },
        "claim-external": {
          externalCreateCompletions: 0,
          ownerRefCreateRequests: 0,
          ownerRefCreateCompletions: 0,
          preauthorityRefDeleteRequests: 0,
          preauthorityRefDeleteCompletions: 0,
        },
        "claim-reference": {
          ownerRefCreateCompletions: 0,
          preauthorityRefDeleteRequests: 0,
          preauthorityRefDeleteCompletions: 0,
        },
        "claim-timer-init": {},
        "claim-timer-start": {},
        "audit-create": {},
        "preauthority-ref-delete": {
          preauthorityRefDeleteRequests: 2,
          preauthorityRefDeleteFailures: 1,
          preauthorityRefDeleteRetries: 1,
          preauthoritySettlementRetries: 1,
        },
        "audit-cleanup-promise": {},
        "audit-lifecycle-promise": {
          deferredSettleRequests: 1,
          deferredSettleCompletions: 1,
          mandatoryDeferredsCreated: 1,
          mandatoryDeferredsSettled: 1,
        },
        "audit-close-external": {
          deferredSettleRequests: 2,
          deferredSettleCompletions: 2,
          mandatoryDeferredsCreated: 2,
          mandatoryDeferredsSettled: 2,
        },
        "audit-close-typedarray": {
          deferredSettleRequests: 2,
          deferredSettleCompletions: 2,
          mandatoryDeferredsCreated: 2,
          mandatoryDeferredsSettled: 2,
        },
        "audit-property": {
          deferredSettleRequests: 2,
          deferredSettleCompletions: 2,
          mandatoryDeferredsCreated: 2,
          mandatoryDeferredsSettled: 2,
        },
        "audit-reference": {
          preauthorityRefDeleteRequests: 2,
          preauthorityRefDeleteCompletions: 2,
          deferredSettleRequests: 3,
          deferredSettleCompletions: 3,
          mandatoryDeferredsCreated: 3,
          mandatoryDeferredsSettled: 3,
        },
        "setup-resolve": {
          setupSettleRequests: 2,
          setupSettleFailures: 1,
        },
        "preauthority-deferred-settle": {
          preauthorityRefDeleteRequests: 2,
          preauthorityRefDeleteCompletions: 2,
          deferredSettleRequests: 4,
          deferredSettleFailures: 1,
          deferredSettleCompletions: 3,
          mandatoryDeferredsCreated: 3,
          mandatoryDeferredsSettled: 3,
          preauthoritySettlementRetries: 1,
        },
      };
      for (const [name, expected] of Object.entries(setupCounterExpectations)) {
        const entry = parsed.faultVariants.find(
          (candidate) => candidate.fault === name,
        );
        expect(entry.audit.claimSetupFinal, name).toEqual({
          ...setupCounterBase,
          ...expected,
        });
      }
      for (const name of [
        "settlement-owner-init",
        "settlement-owner-start",
        "settlement-owner-ref",
      ]) {
        const entry = parsed.faultVariants.find(
          (candidate) => candidate.fault === name,
        );
        expect(entry.audit.claimSetupFinal, name).toBeUndefined();
      }
      const lifecycleRetryExpectations = {
        "settlement-handle-scope": {
          lifecycleRetries: 1,
          lifecycleHandleScopeFailures: 1,
        },
        "settlement-object": {
          lifecycleRetries: 2,
          lifecycleObjectFailures: 1,
          lifecycleFreezeFailures: 1,
        },
        "settlement-property": {
          lifecycleRetries: 2,
          lifecyclePropertyFailures: 1,
          lifecycleRefDeleteFailures: 1,
        },
        "settlement-resolve": {
          lifecycleRetries: 1,
          lifecycleResolveFailures: 1,
        },
        "lifecycle-scope-close": {
          lifecycleRetries: 0,
          lifecycleHandleScopeCloseFailures: 1,
          lifecycleAttempts: 1,
        },
      };
      for (const [name, expected] of Object.entries(
        lifecycleRetryExpectations,
      )) {
        const entry = parsed.faultVariants.find(
          (candidate) => candidate.fault === name,
        );
        expect(entry.lifecycleFinal, name).toMatchObject(expected);
      }
      const graceful = parsed.faultVariants.find(
        (entry) => entry.fault === "phase-graceful",
      );
      expect(graceful.result).toMatchObject({ kind: "exit", code: 0 });
      expect(graceful.result.nativeAudit.signalAttempts).toBe(0);
      expect(graceful.result.nativeAudit.termSignalAttempts).toBe(0);
      expect(graceful.result.nativeAudit.killSignalAttempts).toBe(0);
      expect(graceful.result.nativeAudit.waitAttempts).toBeGreaterThan(0);
      const term = parsed.faultVariants.find(
        (entry) => entry.fault === "phase-term",
      );
      expect(term.result).toMatchObject({ kind: "signal", signal: 15 });
      expect(term.result.nativeAudit.signalAttempts).toBe(1);
      expect(term.result.nativeAudit.termSignalAttempts).toBe(1);
      expect(term.result.nativeAudit.killSignalAttempts).toBe(0);
      const kill = parsed.faultVariants.find(
        (entry) => entry.fault === "phase-kill",
      );
      expect(kill.result).toMatchObject({ kind: "signal", signal: 9 });
      expect(kill.result.nativeAudit.signalAttempts).toBe(2);
      expect(kill.result.nativeAudit.termSignalAttempts).toBe(1);
      expect(kill.result.nativeAudit.killSignalAttempts).toBe(1);
      const timeout = parsed.faultVariants.find(
        (entry) => entry.fault === "post-kill-timeout",
      );
      expect(timeout.error.nativeAudit.signalAttempts).toBe(2);
      expect(timeout.error.nativeAudit.termSignalAttempts).toBe(1);
      expect(timeout.error.nativeAudit.killSignalAttempts).toBe(1);
      expect(timeout.error.nativeAudit.waitAttempts).toBeGreaterThan(0);
      expect(timeout.error.nativeAudit.deadlineAttempts).toBeGreaterThan(0);
      expect(timeout.error.cleanupFinal).toMatchObject({
        exactReaps: 1,
        closeRequests: 1,
        barrierReleases: 1,
        ownerClosed: true,
      });
      expect(parsed.headerTrustMatrix).toEqual(
        [
          "writable-directory",
          "wrong-directory-mode",
          "writable-header",
          "wrong-header-mode",
          "redirected-directory",
          "redirected-header",
          "hardlinked-header",
          "wrong-owner-header",
        ].map((fault) => ({ fault, rejected: true })),
      );
      expect(parsed.faultBuild.compiler).toMatch(
        /^\/usr\/bin\/[a-z0-9_+-]+-linux-gnu-gcc-[0-9]+$/,
      );
      expect(parsed.faultBuild.compilerHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(parsed.faultBuild.headerHashes)).toEqual([
        "node_api.h",
        "node_api_types.h",
        "node_version.h",
      ]);
      for (const hash of Object.values(parsed.faultBuild.headerHashes)) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(Object.values(parsed.faultBuild.sourceHashes)).toHaveLength(3);
      expect(parsed.lockMatrix.map((entry) => entry.fault)).toEqual([
        "helper-signal",
        "helper-timeout",
        "builder-nonzero",
        "builder-signal",
        "post-lock-revalidation",
        "builder-spawn-failure",
      ]);
      for (const entry of parsed.lockMatrix) {
        expect(entry.stageUnchanged, entry.fault).toBe(true);
        expect(entry.runnerChildrenUnchanged, entry.fault).toBe(true);
        expect(entry.nativeChildren, entry.fault).toBe("");
      }
      expect(parsed.lockMatrix).toMatchObject([
        {
          helperSpawns: 1,
          builderSpawns: 0,
          builderSpawned: false,
          errorText: expect.stringMatching(/flock helper terminated by signal/),
        },
        {
          helperSpawns: 1,
          builderSpawns: 0,
          builderSpawned: false,
          errorText: expect.stringMatching(/flock helper exited unsuccessfully/),
        },
        {
          helperSpawns: 1,
          builderSpawns: 1,
          builderSpawned: true,
          errorText: expect.stringMatching(
            /native builder exited unsuccessfully/,
          ),
        },
        {
          helperSpawns: 1,
          builderSpawns: 1,
          builderSpawned: true,
          errorText: expect.stringMatching(
            /native builder terminated by signal/,
          ),
        },
        {
          helperSpawns: 1,
          builderSpawns: 0,
          builderSpawned: false,
          errorText: expect.stringMatching(/descriptor identity changed/),
        },
        {
          helperSpawns: 1,
          builderSpawns: 1,
          builderSpawned: false,
          errorText: expect.stringMatching(/ENOENT/),
        },
      ]);
    }, 300_000);

    it("keeps module load and subreaper activation descriptor-neutral", () => {
      const lock = openSync(
        new URL(".atomic-directory-publication-build.lock", buildRoot),
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      const artifact = new URL(
        "../build/Test/atomic_directory_publication_test.node",
        import.meta.url,
      );
      const inspect = String.raw`
const { closeSync, fstatSync, readFileSync } = require("node:fs");
const { constants: osConstants } = require("node:os");
const identityKeys = ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"];
const addonBefore = fstatSync(10, { bigint: true });
const flags = () => readFileSync("/proc/self/fdinfo/9", "utf8").match(/^flags:\s+([0-7]+)$/m)[1];
const before = flags();
const moduleRecord = { exports: Object.create(null) };
process.dlopen(moduleRecord, "/proc/self/fd/10", osConstants.dlopen.RTLD_NOW);
const native = moduleRecord.exports;
const addonAfter = fstatSync(10, { bigint: true });
if (!identityKeys.every((key) => addonAfter[key] === addonBefore[key])) {
  throw new Error("held test addon identity drifted");
}
closeSync(10);
try {
  fstatSync(10);
  throw new Error("held test addon remained open");
} catch (error) {
  if (error?.code !== "EBADF") throw error;
}
const afterLoad = flags();
native.testHooks.becomeChildSubreaperForTest();
const afterSubreaper = flags();
let arbitraryRejected = false;
try { native.testHooks.prepareInheritedLockFdForTest({ fd: 9 }); }
catch { arbitraryRejected = true; }
process.stdout.write(JSON.stringify({
  before, afterLoad, afterSubreaper, arbitraryRejected,
  hooks: Object.keys(native.testHooks).sort(),
}));
`;
      const addon = openSync(
        artifact,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const result = spawnSync(
          process.execPath,
          ["-e", inspect],
          {
            env: productionEnvironment(),
            encoding: "utf8",
            stdio: [
              "ignore",
              "pipe",
              "pipe",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              lock,
              addon,
            ],
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const observed = JSON.parse(result.stdout);
        expect(observed.afterLoad).toBe(observed.before);
        expect(observed.afterSubreaper).toBe(observed.before);
        expect(observed.arbitraryRejected).toBe(true);
        expect(observed.hooks).toEqual([
          "becomeChildSubreaperForTest",
          "claimAdoptedChildForTest",
          "prepareInheritedLockFdForTest",
          "reapClaimedChildForTest",
        ]);
        expect(readFileSync(`/proc/self/fd/${lock}`)).toBeDefined();
      } finally {
        closeSync(addon);
        closeSync(lock);
      }
    });
  });
}
