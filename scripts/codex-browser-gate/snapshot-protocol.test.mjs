import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRequiredV2Contract } from "./app-server-compatibility.mjs";
import { gateError } from "./gate-contract.mjs";
import { snapshotProtocol } from "./snapshot-protocol.mjs";

const contractPath = new URL(
  "../../host/browser-runtime/protocol/compatibility/required-v2-contract.json",
  import.meta.url,
);
const contract = await loadRequiredV2Contract(contractPath);
let cases = 0;

function compatibleSchema() {
  const definitions = {};
  for (const [name, shape] of Object.entries(contract.requiredDefinitions)) {
    definitions[name] = {
      type: "object",
      properties: Object.fromEntries(
        shape.properties.map(field => [field, { type: "string" }]),
      ),
      required: [...shape.required],
    };
  }
  return { definitions };
}

const identity = Object.freeze({
  executablePath: "/builder/bin/codex",
  resolvedPath: "/builder/releases/codex",
  device: "8",
  inode: "144",
  version: "99.7.1-compatible",
});

class TestSupervisor {
  constructor(cleanupFailure) {
    this.cleaned = 0;
    this.cleanupFailure = cleanupFailure;
  }
  async cleanup() {
    this.cleaned += 1;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
}

function fakeRun(schema = compatibleSchema(), extraFile) {
  return async (_command, args) => {
    const out = args.at(-1);
    await mkdir(join(out, "v2"), { mode: 0o700, recursive: true });
    await writeFile(
      join(out, "codex_app_server_protocol.v2.schemas.json"),
      JSON.stringify(schema),
    );
    for (const name of Object.keys(contract.requiredDefinitions)) {
      await writeFile(
        join(out, "v2", `${name}.json`),
        JSON.stringify(schema.definitions[name]),
      );
    }
    if (extraFile) await writeFile(join(out, extraFile.name), extraFile.bytes);
    return { code: 0, signal: null, stderr: "", stdout: "" };
  };
}

const root = await mkdtemp(join(tmpdir(), "codex-snapshot-test-"));
try {
  await stat(root).then(rootStat =>
    assert.equal((rootStat.mode & 0o777) === 0o700, true),
  );
  const modelSchema = join(root, "model.json");
  await writeFile(
    modelSchema,
    '{"type":"object","properties":{"decision":{"type":"object"}}}',
  );
  const captureIdentity = async () => identity;
  const assertIdentity = (left, right) => assert.deepEqual(left, right);

  const stagingOne = join(root, "one");
  const stagingTwo = join(root, "two");
  await mkdir(stagingOne, { mode: 0o700 });
  await mkdir(stagingTwo, { mode: 0o700 });
  const supervisorOne = new TestSupervisor();
  const supervisorTwo = new TestSupervisor();
  const first = await snapshotProtocol({
    out: join(stagingOne, "protocol"),
    repositoryRoot: process.cwd(),
    contractPath,
    modelDecisionSchemaPath: modelSchema,
    supervisor: supervisorOne,
    captureIdentity,
    assertIdentity,
    runCommand: fakeRun(),
  });
  const second = await snapshotProtocol({
    out: join(stagingTwo, "protocol"),
    repositoryRoot: process.cwd(),
    contractPath,
    modelDecisionSchemaPath: modelSchema,
    supervisor: supervisorTwo,
    captureIdentity,
    assertIdentity,
    runCommand: fakeRun(),
  });
  assert.equal(first.schemaDigest, second.schemaDigest);
  assert.deepEqual(first.schemaInventory, second.schemaInventory);
  assert.equal(supervisorOne.cleaned, 1);
  assert.equal(supervisorTwo.cleaned, 1);
  cases += 4;

  const published = join(stagingOne, "protocol");
  const manifest = JSON.parse(await readFile(join(published, "manifest.json")));
  assert.deepEqual(manifest.codexIdentity, identity);
  assert.deepEqual(manifest.schemaInventory, first.schemaInventory);
  assert.equal(manifest.schemaDigest, first.schemaDigest);
  assert.equal("release" in manifest, false);
  assert.equal("minimumVersion" in manifest, false);
  assert.equal(
    await readFile(
      join(published, "model-decision-envelope-v1.schema.json"),
      "utf8",
    ),
    '{"properties":{"decision":{"type":"object"}},"type":"object"}',
  );
  const sums = await readFile(join(published, "SHA256SUMS"), "utf8");
  assert.match(sums, /codex_app_server_protocol\.v2\.schemas\.json/);
  assert.match(sums, /model-decision-envelope-v1\.schema\.json/);
  assert.doesNotMatch(sums, /manifest\.json|SHA256SUMS/);
  cases += 9;

  const driftParent = join(root, "drift");
  await mkdir(driftParent, { mode: 0o700 });
  let captures = 0;
  const driftSupervisor = new TestSupervisor();
  await assert.rejects(
    snapshotProtocol({
      out: join(driftParent, "protocol"),
      repositoryRoot: process.cwd(),
      contractPath,
      modelDecisionSchemaPath: modelSchema,
      supervisor: driftSupervisor,
      captureIdentity: async () => {
        captures += 1;
        return captures === 1
          ? identity
          : { ...identity, version: "99.7.2-compatible" };
      },
      assertIdentity: (left, right) => {
        if (left.version !== right.version) {
          throw gateError("codex_version_changed", "version");
        }
      },
      runCommand: fakeRun(),
    }),
    error => error?.code === "codex_version_changed",
  );
  await assert.rejects(stat(join(driftParent, "protocol")), {
    code: "ENOENT",
  });
  assert.equal(driftSupervisor.cleaned, 1);
  cases += 3;

  const cleanupParent = join(root, "cleanup-failure");
  await mkdir(cleanupParent, { mode: 0o700 });
  captures = 0;
  const cleanupFailure = new Error("snapshot cleanup failed");
  await assert.rejects(
    snapshotProtocol({
      out: join(cleanupParent, "protocol"),
      repositoryRoot: process.cwd(),
      contractPath,
      modelDecisionSchemaPath: modelSchema,
      supervisor: new TestSupervisor(cleanupFailure),
      captureIdentity: async () => {
        captures += 1;
        return captures === 1
          ? identity
          : { ...identity, version: "99.7.2-compatible" };
      },
      assertIdentity: (left, right) => {
        if (left.version !== right.version) {
          throw gateError("codex_version_changed", "version");
        }
      },
      runCommand: fakeRun(),
    }),
    error =>
      error instanceof AggregateError &&
      error.message === "gate_and_cleanup_failed" &&
      error.errors.some(item => item?.code === "codex_version_changed") &&
      error.errors.includes(cleanupFailure),
  );
  cases += 1;

  const malformedParent = join(root, "malformed");
  await mkdir(malformedParent, { mode: 0o700 });
  await assert.rejects(
    snapshotProtocol({
      out: join(malformedParent, "protocol"),
      repositoryRoot: process.cwd(),
      contractPath,
      modelDecisionSchemaPath: modelSchema,
      supervisor: new TestSupervisor(),
      captureIdentity,
      assertIdentity,
      runCommand: fakeRun(compatibleSchema(), {
        name: "unexpected.txt",
        bytes: "not-json",
      }),
    }),
    error => error?.code === "codex_protocol_snapshot_invalid",
  );
  cases += 1;

  await assert.rejects(
    snapshotProtocol({
      out: join(process.cwd(), "protocol"),
      repositoryRoot: process.cwd(),
    }),
    error => error?.code === "codex_protocol_snapshot_output_invalid",
  );
  await assert.rejects(
    snapshotProtocol({
      out: join(root, "wrong-name"),
      repositoryRoot: process.cwd(),
    }),
    error => error?.code === "codex_protocol_snapshot_output_invalid",
  );
  cases += 2;
} finally {
  await rm(root, { force: true, recursive: true });
}

process.stdout.write(
  `codex_browser_snapshot_protocol: PASS cases=${cases}\n`,
);
