import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";

import { createGateActionStore } from "./action-store.mjs";
import {
  runProtocolHardeningSelfTest,
  runTransportSelfTest,
} from "./app-server-protocol.mjs";
import {
  normalizedProposalHash,
  runDecisionWireSelfTest,
} from "./decision-wire.mjs";
import {
  DISABLED_FEATURES,
  gateError,
  hashFeatureInventory,
  MAX_RUNS,
  REVIEWED_ENABLED_NON_TOOL_FEATURES,
} from "./gate-contract.mjs";
import {
  combinePrimaryAndCleanup,
  LifecycleRegistry,
  runLifecycleSelfTest,
  surfaceCleanupFailures,
} from "./lifecycle.mjs";

async function withOwnedRoot(lifecycle, rootPrefix, callback) {
  const root = lifecycle.createRoot(rootPrefix);
  let result;
  let primaryFailure;
  try {
    result = await callback(root);
  } catch (error) {
    primaryFailure = error;
  }

  const cleanupFailures = [];
  try {
    await lifecycle.removeRoot(root);
  } catch (error) {
    cleanupFailures.push(error);
  }
  surfaceCleanupFailures(primaryFailure, cleanupFailures);
  if (primaryFailure) throw primaryFailure;
  return result;
}

async function runActionStoreSelfTest({ silent = false } = {}) {
  const lifecycle = new LifecycleRegistry();
  return withOwnedRoot(
    lifecycle,
    join(tmpdir(), "codex-browser-action-store-"),
    async root => {
      const markerPath = join(root, "marker");
      const store = createGateActionStore({ markerPath });
      const action = {
        version: 1, adapterJobId: "gate-job", sequence: 1,
        actionId: "gate-action-1",
        proposalHash: normalizedProposalHash({
          kind: "fill", ref: "gate-marker", value: "approved",
        }),
        effect: "side_effecting",
        operation: { kind: "fill", ref: "gate-marker", value: "approved" },
      };
      const first = await store.execute(action);
      const replay = await store.execute(action);
      await assert.rejects(
        store.execute({ ...action, proposalHash: "0".repeat(64) }),
        /action_identity_mismatch/,
      );
      assert.deepEqual(replay, first);
      assert.equal(await readFile(markerPath, "utf8"), "approved\n");
      const markerStat = await stat(markerPath);
      assert.equal(markerStat.isFile(), true);
      assert.equal(markerStat.mode & 0o777, 0o600);
      const snapshot = store.snapshot();
      assert.equal(snapshot.writeCount, 1);
      assert.equal(snapshot.records.length, 1);
      assert.deepEqual(
        {
          version: snapshot.records[0].version,
          adapterJobId: snapshot.records[0].adapterJobId,
          sequence: snapshot.records[0].sequence,
          actionId: snapshot.records[0].actionId,
          proposalHash: snapshot.records[0].proposalHash,
          effect: snapshot.records[0].effect,
          operation: snapshot.records[0].operation,
          state: snapshot.records[0].state,
        },
        { ...action, state: "succeeded" },
      );
      await assert.rejects(
        store.execute({
          ...action,
          actionId: "bad-operation",
          sequence: 2,
          operation: {
            kind: "fill",
            ref: "gate-marker",
            value: "approved",
            extra: true,
          },
        }),
        /invalid_action_operation/,
      );
      const failedMarkerPath = join(root, "failed-marker");
      await writeFile(failedMarkerPath, "occupied\n", { mode: 0o600 });
      const failedStore = createGateActionStore({ markerPath: failedMarkerPath });
      await assert.rejects(
        failedStore.execute({
          ...action,
          actionId: "dispatch-failure",
        }),
        error => error?.code === "EEXIST",
      );
      assert.equal(failedStore.snapshot().records[0].state, "executing");
      if (!silent) {
        process.stdout.write(
          `codex_browser_action_store: PASS writes=${snapshot.writeCount} records=${snapshot.records.length}\n`,
        );
      }
    },
  );
}

async function runCrossModuleHardeningSelfTest() {
  assert.equal(parseInvocation([]).runCount, 3);
  for (let runCount = 1; runCount <= MAX_RUNS; runCount += 1) {
    assert.equal(
      parseInvocation(["--runs", String(runCount)]).runCount,
      runCount,
    );
  }
  assert.deepEqual(
    parseInvocation([
      "--runs",
      "3",
      "--attestation-out",
      "/tmp/codex-gate-attestation.json",
    ]),
    {
      runCount: 3,
      attestationOut: "/tmp/codex-gate-attestation.json",
    },
  );
  for (const [flag, name] of [
    ["--action-store-self-test", "actionStore"],
    ["--hardening-self-test", "hardening"],
    ["--transport-self-test", "transport"],
    ["--lifecycle-self-test", "lifecycle"],
  ]) {
    assert.equal(parseInvocation([flag]).selfTest, defaultChecks[name]);
  }
  for (const args of [
    ["--runs"],
    ["--runs", "0"],
    ["--runs", "01"],
    ["--runs", "+1"],
    ["--runs", "-1"],
    ["--runs", "1.0"],
    ["--runs", " 1"],
    ["--runs", "11"],
    ["--runs", "9007199254740993"],
    ["--runs", "Infinity"],
    ["--runs", "1", "extra"],
    ["--runs", "3", "--attestation-out", "relative.json"],
    ["--runs", "3", "--attestation-out", ""],
    ["--attestation-out", "/tmp/attestation.json", "--runs", "3"],
    ["--unknown"],
    ["--transport-self-test", "--lifecycle-self-test"],
    ["--hardening-self-test", "extra"],
  ]) {
    assert.throws(
      () => parseInvocation(args),
      /codex_gate_arguments_invalid/,
    );
  }

  const preflightCalls = [];
  const preflightChecks = Object.fromEntries(
    ["actionStore", "hardening", "transport", "lifecycle"].map(name => [
      name,
      async options => preflightCalls.push([name, options]),
    ]),
  );
  await runPreflight(preflightChecks);
  assert.deepEqual(preflightCalls, [
    ["actionStore", { silent: true }],
    ["hardening", { silent: true }],
    ["transport", { silent: true }],
    ["lifecycle", { silent: true }],
  ]);

  const failedCalls = [];
  const preflightFailure = new Error("preflight_failure");
  await assert.rejects(
    runPreflight({
      actionStore: async options => {
        failedCalls.push(["actionStore", options]);
      },
      hardening: async options => {
        failedCalls.push(["hardening", options]);
        throw preflightFailure;
      },
      transport: async options => {
        failedCalls.push(["transport", options]);
      },
      lifecycle: async options => {
        failedCalls.push(["lifecycle", options]);
      },
    }),
    error => error === preflightFailure,
  );
  assert.deepEqual(failedCalls, [
    ["actionStore", { silent: true }],
    ["hardening", { silent: true }],
  ]);

  const disabledLines = DISABLED_FEATURES.map(
    name => `${name}  experimental  false`,
  );
  const reviewedLines = [...REVIEWED_ENABLED_NON_TOOL_FEATURES].map(
    ([name, stage]) => `${name}  ${stage}  true`,
  );
  const featureFixture = [...disabledLines, ...reviewedLines].join("\n");
  assert.equal(
    hashFeatureInventory(featureFixture),
    "c7565da62fad92c89d24aa7caed1dbcf32bdeb08fa3a8bfafeb9e5c5e9d9532c",
  );
  for (const output of [
    `${featureFixture}\n${disabledLines[0]}`,
    [...disabledLines.slice(1), ...reviewedLines].join("\n"),
    [
      ...disabledLines.filter(line => !line.startsWith("skill_search  ")),
      "skill_search  stable  true",
      ...reviewedLines,
    ].join("\n"),
    `${featureFixture}\nunreviewed_tool  stable  true`,
    "",
  ]) {
    assert.throws(
      () => hashFeatureInventory(output),
      /codex_feature_surface_changed/,
    );
  }

  const primaryFailure = gateError("model_protocol_error");
  const storeFailure = new Error("store cleanup failed");
  const rootFailure = new Error("root cleanup failed");
  assert.equal(
    combinePrimaryAndCleanup(primaryFailure, undefined),
    primaryFailure,
  );
  assert.throws(
    () => {
      throw combinePrimaryAndCleanup(primaryFailure, storeFailure);
    },
    error =>
      error instanceof AggregateError &&
      error.errors[0] === primaryFailure &&
      error.errors[1] === storeFailure,
  );
  assert.throws(
    () => surfaceCleanupFailures(primaryFailure, [storeFailure, rootFailure]),
    error =>
      error instanceof AggregateError &&
      error.errors.length === 3 &&
      error.errors[0] === primaryFailure &&
      error.errors[1] === storeFailure &&
      error.errors[2] === rootFailure,
  );
  assert.throws(
    () => surfaceCleanupFailures(undefined, [storeFailure]),
    error => error === storeFailure,
  );

  const rootPrefix = "/fake/action-store-root-";
  const fakeRoot = "/fake/action-store-root-1";
  const primaryOnlyCalls = [];
  await assert.rejects(
    () =>
      withOwnedRoot(
        {
          createRoot(prefix) {
            primaryOnlyCalls.push(["create", prefix]);
            return fakeRoot;
          },
          async removeRoot(root) {
            primaryOnlyCalls.push(["remove", root]);
          },
        },
        rootPrefix,
        async root => {
          primaryOnlyCalls.push(["callback", root]);
          throw primaryFailure;
        },
      ),
    error => error === primaryFailure,
  );
  assert.deepEqual(primaryOnlyCalls, [
    ["create", rootPrefix],
    ["callback", fakeRoot],
    ["remove", fakeRoot],
  ]);

  const cleanupOnlyCalls = [];
  await assert.rejects(
    () =>
      withOwnedRoot(
        {
          createRoot(prefix) {
            cleanupOnlyCalls.push(["create", prefix]);
            return fakeRoot;
          },
          async removeRoot(root) {
            cleanupOnlyCalls.push(["remove", root]);
            throw rootFailure;
          },
        },
        rootPrefix,
        async root => {
          cleanupOnlyCalls.push(["callback", root]);
        },
      ),
    error => error === rootFailure,
  );
  assert.deepEqual(cleanupOnlyCalls, [
    ["create", rootPrefix],
    ["callback", fakeRoot],
    ["remove", fakeRoot],
  ]);

  const combinedCalls = [];
  await assert.rejects(
    () =>
      withOwnedRoot(
        {
          createRoot(prefix) {
            combinedCalls.push(["create", prefix]);
            return fakeRoot;
          },
          async removeRoot(root) {
            combinedCalls.push(["remove", root]);
            throw rootFailure;
          },
        },
        rootPrefix,
        async root => {
          combinedCalls.push(["callback", root]);
          throw primaryFailure;
        },
      ),
    error =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors[0] === primaryFailure &&
      error.errors[1] === rootFailure,
  );
  assert.deepEqual(combinedCalls, [
    ["create", rootPrefix],
    ["callback", fakeRoot],
    ["remove", fakeRoot],
  ]);
}

async function runHardeningSelfTest({ silent = false } = {}) {
  await runDecisionWireSelfTest({ silent: true });
  await runProtocolHardeningSelfTest({ silent });
  await runCrossModuleHardeningSelfTest({ silent: true });
  if (!silent) process.stdout.write("codex_browser_hardening: PASS\n");
}

const defaultChecks = {
  actionStore: runActionStoreSelfTest,
  hardening: runHardeningSelfTest,
  transport: runTransportSelfTest,
  lifecycle: runLifecycleSelfTest,
};

export function parseInvocation(args, checks = defaultChecks) {
  const selfTests = new Map([
    ["--action-store-self-test", checks.actionStore],
    ["--hardening-self-test", checks.hardening],
    ["--lifecycle-self-test", checks.lifecycle],
    ["--transport-self-test", checks.transport],
  ]);
  if (args.length === 1 && selfTests.has(args[0])) {
    return { selfTest: selfTests.get(args[0]) };
  }
  if (args.length === 0) return { runCount: 3 };
  if (
    args.length === 4 &&
    args[0] === "--runs" &&
    /^[1-9]\d*$/.test(args[1]) &&
    args[2] === "--attestation-out" &&
    isAbsolute(args[3])
  ) {
    const runCount = Number(args[1]);
    if (!Number.isSafeInteger(runCount) || runCount > MAX_RUNS) {
      throw gateError("codex_gate_arguments_invalid");
    }
    return { runCount, attestationOut: args[3] };
  }
  if (
    args.length !== 2 ||
    args[0] !== "--runs" ||
    !/^[1-9]\d*$/.test(args[1])
  ) {
    throw gateError("codex_gate_arguments_invalid");
  }
  const runCount = Number(args[1]);
  if (!Number.isSafeInteger(runCount) || runCount > MAX_RUNS) {
    throw gateError("codex_gate_arguments_invalid");
  }
  return { runCount };
}

export async function runPreflight(checks = defaultChecks) {
  await checks.actionStore({ silent: true });
  await checks.hardening({ silent: true });
  await checks.transport({ silent: true });
  await checks.lifecycle({ silent: true });
}
