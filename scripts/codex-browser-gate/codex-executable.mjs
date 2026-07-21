import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import { gateError } from "./gate-contract.mjs";
import { runCaptured } from "./lifecycle.mjs";

const SEMVER =
  "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)" +
  "(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?" +
  "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?";
const VERSION_OUTPUT = new RegExp(`^codex-cli (${SEMVER})\\n?$`);
const IDENTITY_FIELDS = Object.freeze([
  "executablePath",
  "resolvedPath",
  "device",
  "inode",
  "version",
]);

export function parseCodexVersionOutput(output) {
  if (typeof output !== "string") throw gateError("codex_version_mismatch");
  const match = VERSION_OUTPUT.exec(output);
  if (!match) throw gateError("codex_version_mismatch");
  return match[1];
}

export async function captureCodexIdentity({
  pathValue,
  cwd,
  supervisor,
  failureCode = "codex_version_mismatch",
  accessFile = access,
  realpathFile = realpath,
  statFile = path => stat(path, { bigint: true }),
  runCommand = runCaptured,
}) {
  try {
    if (typeof pathValue !== "string" || pathValue === "") {
      throw gateError(failureCode);
    }
    let selected;
    for (const entry of pathValue.split(delimiter)) {
      const candidate = resolve(cwd, entry || ".", "codex");
      try {
        await accessFile(candidate, constants.X_OK);
        const resolvedPath = await realpathFile(candidate);
        const executableStat = await statFile(resolvedPath);
        if (!executableStat.isFile()) continue;
        selected = { executablePath: candidate, resolvedPath, executableStat };
        break;
      } catch (error) {
        if (["EACCES", "ENOENT", "ENOTDIR"].includes(error?.code)) continue;
        throw error;
      }
    }
    if (!selected) throw gateError(failureCode);
    const versionResult = await runCommand(
      selected.resolvedPath,
      ["--version"],
      {
        supervisor,
      },
    );
    if (versionResult.code !== 0) throw gateError(failureCode);
    let version;
    try {
      version = parseCodexVersionOutput(versionResult.stdout);
    } catch {
      throw gateError(failureCode);
    }
    const verifiedStat = await statFile(selected.resolvedPath);
    if (
      !verifiedStat.isFile() ||
      String(verifiedStat.dev) !== String(selected.executableStat.dev) ||
      String(verifiedStat.ino) !== String(selected.executableStat.ino)
    ) {
      throw gateError(failureCode);
    }
    return Object.freeze({
      executablePath: selected.executablePath,
      resolvedPath: selected.resolvedPath,
      device: String(selected.executableStat.dev),
      inode: String(selected.executableStat.ino),
      version,
    });
  } catch (error) {
    if (error?.code === failureCode) throw error;
    throw gateError(failureCode);
  }
}

export function assertSameCodexIdentity(expected, actual) {
  for (const field of IDENTITY_FIELDS) {
    if (
      typeof expected?.[field] !== "string" ||
      expected[field] === "" ||
      typeof actual?.[field] !== "string" ||
      actual[field] === "" ||
      expected[field] !== actual[field]
    ) {
      throw gateError("codex_version_changed", field);
    }
  }
}
