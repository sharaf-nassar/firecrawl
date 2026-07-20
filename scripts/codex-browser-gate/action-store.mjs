import { writeFile } from "node:fs/promises";

const REQUEST_KEYS = [
  "actionId",
  "adapterJobId",
  "effect",
  "operation",
  "proposalHash",
  "sequence",
  "version",
];
const OPERATION_KEYS = ["kind", "ref", "value"];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).toSorted().join("\0") === expected.join("\0")
  );
}

function validateAction(action) {
  if (!hasExactKeys(action, REQUEST_KEYS)) fail("invalid_action_request");
  if (!hasExactKeys(action.operation, OPERATION_KEYS)) {
    fail("invalid_action_operation");
  }
  if (
    action.version !== 1 ||
    typeof action.adapterJobId !== "string" ||
    action.adapterJobId.trim() === "" ||
    !Number.isInteger(action.sequence) ||
    action.sequence < 1 ||
    typeof action.actionId !== "string" ||
    action.actionId.trim() === "" ||
    !/^[0-9a-f]{64}$/.test(action.proposalHash) ||
    action.effect !== "side_effecting" ||
    action.operation.kind !== "fill" ||
    action.operation.ref !== "gate-marker" ||
    action.operation.value !== "approved"
  ) {
    fail("invalid_action_request");
  }
}

export function createGateActionStore({ markerPath }) {
  const records = new Map();
  const sequences = new Map();
  let writeCount = 0;

  return {
    async execute(action) {
      validateAction(action);

      const existing = records.get(action.actionId);
      if (existing) {
        if (
          existing.sequence !== action.sequence ||
          existing.proposalHash !== action.proposalHash
        ) {
          fail("action_identity_mismatch");
        }
        if (existing.state === "executing") fail("action_in_flight");
        if (existing.state === "succeeded") {
          return structuredClone(existing.observation);
        }
        fail("action_execution_failed");
      }

      if (sequences.has(action.sequence)) fail("action_identity_mismatch");

      const record = { ...structuredClone(action), state: "prepared" };
      records.set(action.actionId, record);
      sequences.set(action.sequence, action.actionId);
      record.state = "executing";

      await writeFile(markerPath, "approved\n", { flag: "wx", mode: 0o600 });
      writeCount += 1;
      record.observation = {
        version: 1,
        type: "action_result",
        sequence: 1,
        actionId: action.actionId,
        actionKind: "fill",
        outcome: "succeeded",
        result: { value: "approved" },
        page: {
          url: "https://gate.invalid/form",
          title: "Gate fixture",
          snapshotExcerpt: "textbox gate-marker value=approved",
        },
      };
      record.state = "succeeded";
      return structuredClone(record.observation);
    },

    snapshot() {
      return {
        records: structuredClone([...records.values()]),
        writeCount,
      };
    },
  };
}
