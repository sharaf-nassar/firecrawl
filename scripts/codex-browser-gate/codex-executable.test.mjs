import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSameCodexIdentity,
  captureCodexIdentity,
  parseCodexVersionOutput,
} from "./codex-executable.mjs";

for (const [output, version] of [
  ["codex-cli 0.144.6\n", "0.144.6"],
  ["codex-cli 1.2.3-alpha.1+build.5\n", "1.2.3-alpha.1+build.5"],
  ["codex-cli 1.2.3+build.5", "1.2.3+build.5"],
]) {
  assert.equal(parseCodexVersionOutput(output), version);
}

for (const output of [
  " codex-cli 1.2.3\n",
  "codex-cli 1.2.3 \n",
  "codex 1.2.3\n",
  "codex-cli 1.2\n",
  "codex-cli 01.2.3\n",
  "codex-cli 1.02.3\n",
  "codex-cli 1.2.03\n",
  "codex-cli 1.2.3-01\n",
  "codex-cli 1.2.3-alpha..1\n",
  "codex-cli 1.2.3-\n",
  "codex-cli 1.2.3\nextra\n",
  "codex-cli 1.2.3\r\n",
  "",
]) {
  assert.throws(
    () => parseCodexVersionOutput(output),
    error => error?.code === "codex_version_mismatch",
  );
}

const calls = [];
const identity = await captureCodexIdentity({
  pathValue: "/first:/active:/newer",
  cwd: "/workspace",
  supervisor: {},
  async accessFile(path) {
    calls.push(["access", path]);
    if (path !== "/active/codex") {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
  },
  async realpathFile(path) {
    calls.push(["realpath", path]);
    return "/opt/codex/0.144.6/codex";
  },
  async statFile(path) {
    calls.push(["stat", path]);
    return { isFile: () => true, dev: 8n, ino: 1446n };
  },
  async runCommand(command, args) {
    calls.push(["run", command, args]);
    return { code: 0, stdout: "codex-cli 0.144.6\n", stderr: "" };
  },
});

assert.deepEqual(identity, {
  executablePath: "/active/codex",
  resolvedPath: "/opt/codex/0.144.6/codex",
  device: "8",
  inode: "1446",
  version: "0.144.6",
});
assert.equal(Object.isFrozen(identity), true);
assert.deepEqual(calls, [
  ["access", "/first/codex"],
  ["access", "/active/codex"],
  ["realpath", "/active/codex"],
  ["stat", "/opt/codex/0.144.6/codex"],
  ["run", "/opt/codex/0.144.6/codex", ["--version"]],
]);
assert.equal(calls.some(call => String(call[1]).includes("newer")), false);

let mutablePathTarget = "/opt/codex/0.144.6/codex";
let raceCommand;
const raceIdentity = await captureCodexIdentity({
  pathValue: "/active",
  cwd: "/workspace",
  supervisor: {},
  async accessFile() {},
  async realpathFile() {
    const capturedTarget = mutablePathTarget;
    mutablePathTarget = "/opt/codex/0.144.7/codex";
    return capturedTarget;
  },
  async statFile() {
    return { isFile: () => true, dev: 8n, ino: 1446n };
  },
  async runCommand(command) {
    assert.equal(mutablePathTarget, "/opt/codex/0.144.7/codex");
    raceCommand = command;
    return { code: 0, stdout: "codex-cli 0.144.6\n", stderr: "" };
  },
});
assert.equal(raceCommand, "/opt/codex/0.144.6/codex");
assert.equal(raceIdentity.executablePath, "/active/codex");
assert.equal(raceIdentity.resolvedPath, "/opt/codex/0.144.6/codex");

function missingError(code = "ENOENT") {
  const error = new Error("private filesystem detail");
  error.code = code;
  return error;
}

const successfulCandidate = {
  pathValue: "/active",
  cwd: "/workspace",
  supervisor: {},
  async accessFile() {},
  async realpathFile() {
    return "/opt/codex/codex";
  },
  async statFile() {
    return { isFile: () => true, dev: 8, ino: 1446 };
  },
};

for (const failureCode of [
  "codex_version_mismatch",
  "codex_version_changed",
]) {
  const failureCases = [
    {
      name: "empty PATH",
      options: { ...successfulCandidate, pathValue: "" },
    },
    {
      name: "missing executable",
      options: {
        ...successfulCandidate,
        async accessFile() {
          throw missingError();
        },
      },
    },
    {
      name: "non-file candidate",
      options: {
        ...successfulCandidate,
        async statFile() {
          return { isFile: () => false, dev: 8, ino: 1446 };
        },
      },
    },
    {
      name: "nonzero version command",
      options: {
        ...successfulCandidate,
        async runCommand() {
          return { code: 1, stdout: "", stderr: "private detail" };
        },
      },
    },
    {
      name: "invalid version output",
      options: {
        ...successfulCandidate,
        async runCommand() {
          return { code: 0, stdout: "codex-cli 0.144\n", stderr: "" };
        },
      },
    },
    {
      name: "unexpected filesystem failure",
      options: {
        ...successfulCandidate,
        async accessFile() {
          throw missingError("EIO");
        },
      },
    },
  ];

  for (const { name, options } of failureCases) {
    await assert.rejects(
      captureCodexIdentity({ ...options, failureCode }),
      error =>
        error?.code === failureCode && error.message === failureCode,
      `${name} maps to ${failureCode}`,
    );
  }
}

const statProbeRoot = await mkdtemp(join(tmpdir(), "codex-gate-stat-"));
try {
  const statProbeTarget = join(statProbeRoot, "codex-target");
  const statProbeExecutable = join(statProbeRoot, "codex");
  await writeFile(statProbeTarget, "#!/bin/sh\n", { mode: 0o700 });
  await chmod(statProbeTarget, 0o700);
  await symlink(statProbeTarget, statProbeExecutable);
  const expectedStat = await stat(statProbeTarget, { bigint: true });
  assert.equal(typeof expectedStat.dev, "bigint");
  assert.equal(typeof expectedStat.ino, "bigint");

  const statIdentity = await captureCodexIdentity({
    pathValue: statProbeRoot,
    cwd: "/workspace",
    supervisor: {},
    async runCommand(command) {
      assert.equal(command, statProbeTarget);
      return { code: 0, stdout: "codex-cli 0.144.6\n", stderr: "" };
    },
  });
  assert.equal(statIdentity.executablePath, statProbeExecutable);
  assert.equal(statIdentity.resolvedPath, statProbeTarget);
  assert.equal(statIdentity.device, String(expectedStat.dev));
  assert.equal(statIdentity.inode, String(expectedStat.ino));
} finally {
  await rm(statProbeRoot, { force: true, recursive: true });
}

const baseline = Object.freeze({
  executablePath: "/active/codex",
  resolvedPath: "/opt/codex/0.144.6/codex",
  device: "8",
  inode: "1446",
  version: "0.144.6",
});
assert.doesNotThrow(() => assertSameCodexIdentity(baseline, { ...baseline }));
for (const [expected, actual, field] of [
  [undefined, undefined, "executablePath"],
  [{}, {}, "executablePath"],
  [baseline, { ...baseline, resolvedPath: undefined }, "resolvedPath"],
  [{ ...baseline, device: undefined }, baseline, "device"],
  [{ ...baseline, inode: 1446 }, { ...baseline, inode: 1446 }, "inode"],
  [{ ...baseline, version: "" }, { ...baseline, version: "" }, "version"],
]) {
  assert.throws(
    () => assertSameCodexIdentity(expected, actual),
    error =>
      error?.code === "codex_version_changed" &&
      error.message === `codex_version_changed: ${field}`,
  );
}
for (const [field, value] of [
  ["executablePath", "/replacement/codex"],
  ["resolvedPath", "/opt/codex/0.144.7/codex"],
  ["device", "9"],
  ["inode", "1447"],
  ["version", "0.144.7"],
]) {
  assert.throws(
    () => assertSameCodexIdentity(baseline, { ...baseline, [field]: value }),
    error =>
      error?.code === "codex_version_changed" &&
      error.message === `codex_version_changed: ${field}`,
  );
}

process.stdout.write("codex_browser_executable: PASS\n");
