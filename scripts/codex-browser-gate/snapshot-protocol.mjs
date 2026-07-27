import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertSameCodexIdentity,
  captureCodexIdentity,
} from "./codex-executable.mjs";
import {
  loadRequiredV2Contract,
  validateAppServerCompatibility,
} from "./app-server-compatibility.mjs";
import { gateError } from "./gate-contract.mjs";
import {
  LifecycleRegistry,
  runCaptured,
  surfaceCleanupFailures,
} from "./lifecycle.mjs";
import {
  canonicalizeJsonBytes,
  canonicalizeJsonFile,
  hashCanonicalSchemaBundle,
} from "./schema-canonicalizer.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRED_V2_CONTRACT_URL = new URL(
  "../../host/browser-runtime/protocol/compatibility/required-v2-contract.json",
  import.meta.url,
);
const MODEL_DECISION_SCHEMA_URL = new URL(
  "../../host/browser-runtime/protocol/model-decision-envelope-v1.schema.json",
  import.meta.url,
);
const SCHEMA_LOGICAL_PREFIX =
  "host/browser-runtime/protocol/codex-app-server/";

function compareUtf16(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function normalizedRelativePath(root, entry) {
  const path = relative(root, join(entry.parentPath, entry.name)).replaceAll(
    "\\",
    "/",
  );
  if (
    path === "" ||
    path.startsWith("/") ||
    path.split("/").some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    throw gateError("codex_protocol_snapshot_invalid");
  }
  return path;
}

async function collectGeneratedSchemas(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw gateError("codex_protocol_snapshot_invalid");
    }
    const path = normalizedRelativePath(root, entry);
    const absolutePath = join(root, path);
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw gateError("codex_protocol_snapshot_invalid");
    }
    await canonicalizeJsonFile(absolutePath);
    files.push([path, await readFile(absolutePath)]);
  }
  files.sort(([left], [right]) => compareUtf16(left, right));
  if (
    files.length === 0 ||
    !files.some(
      ([path]) => path === "codex_app_server_protocol.v2.schemas.json",
    )
  ) {
    throw gateError("codex_protocol_snapshot_invalid");
  }
  return files;
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function checksumManifest(files) {
  return [...files]
    .sort(([left], [right]) => compareUtf16(left, right))
    .map(([path, raw]) => `${sha256(raw)}  ${path}`)
    .join("\n")
    .concat("\n");
}

function outsideRepository(path, repositoryRoot) {
  const root = resolve(repositoryRoot);
  const candidate = resolve(path);
  const child = relative(root, candidate);
  return child.startsWith("..") || isAbsolute(child);
}

async function assertBuilderOwnedOutput(out, repositoryRoot) {
  if (
    typeof out !== "string" ||
    !isAbsolute(out) ||
    basename(out) !== "protocol" ||
    !outsideRepository(out, repositoryRoot)
  ) {
    throw gateError("codex_protocol_snapshot_output_invalid");
  }
  const parent = dirname(out);
  const [parentStat, parentRealPath] = await Promise.all([
    stat(parent),
    realpath(parent),
  ]);
  const effectiveUid = process.getuid?.();
  if (
    !parentStat.isDirectory() ||
    parentRealPath !== parent ||
    (effectiveUid !== undefined && parentStat.uid !== effectiveUid) ||
    (parentStat.mode & 0o022) !== 0
  ) {
    throw gateError("codex_protocol_snapshot_output_invalid");
  }
  try {
    await lstat(out);
    throw gateError("codex_protocol_snapshot_output_invalid");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function validateSnapshotBundle(bundle, contract) {
  return validateAppServerCompatibility(bundle, contract);
}

export async function snapshotProtocol({
  out,
  pathValue = process.env.PATH,
  cwd = process.cwd(),
  repositoryRoot = REPOSITORY_ROOT,
  contractPath = REQUIRED_V2_CONTRACT_URL,
  modelDecisionSchemaPath = MODEL_DECISION_SCHEMA_URL,
  supervisor = new LifecycleRegistry(),
  captureIdentity = captureCodexIdentity,
  assertIdentity = assertSameCodexIdentity,
  runCommand = runCaptured,
} = {}) {
  await assertBuilderOwnedOutput(out, repositoryRoot);
  const staging = `${out}.tmp-${process.pid}-${randomUUID()}`;
  let published = false;
  let primaryFailure;
  let outcome;
  let supervisorCleanupAttempted = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    const selection = { pathValue, cwd };
    const identity = await captureIdentity({
      ...selection,
      supervisor,
      runCommand,
    });
    const generated = join(staging, "generated");
    await mkdir(generated, { mode: 0o700 });
    const generation = await runCommand(
      identity.resolvedPath,
      [
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        generated,
      ],
      { cwd, env: process.env, supervisor },
    );
    if (generation.code !== 0) {
      throw gateError("codex_protocol_snapshot_generation_failed");
    }

    const schemaFiles = await collectGeneratedSchemas(generated);
    const contract = await loadRequiredV2Contract(contractPath);
    validateSnapshotBundle({ files: schemaFiles }, contract);

    const publishedFiles = [];
    for (const [path, raw] of schemaFiles) {
      const destination = join(staging, path);
      await mkdir(dirname(destination), { mode: 0o700, recursive: true });
      await writeFile(destination, raw, { flag: "wx", mode: 0o600 });
      publishedFiles.push([path, raw]);
    }
    await rm(generated, { force: true, recursive: true });

    const modelSchemaName = "model-decision-envelope-v1.schema.json";
    const modelSchemaRaw = canonicalizeJsonBytes(
      await readFile(modelDecisionSchemaPath),
    );
    await writeFile(join(staging, modelSchemaName), modelSchemaRaw, {
      flag: "wx",
      mode: 0o600,
    });
    publishedFiles.push([modelSchemaName, modelSchemaRaw]);

    const schemaInventory = schemaFiles.map(([path]) => path);
    const schemaDigest = hashCanonicalSchemaBundle(
      schemaFiles.map(([path, raw]) => [
        `${SCHEMA_LOGICAL_PREFIX}${path}`,
        raw,
      ]),
    );
    const manifest = canonicalizeJsonBytes(
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          codexIdentity: identity,
          schemaInventory,
          schemaDigest,
        }),
        "utf8",
      ),
    );
    await writeFile(join(staging, "manifest.json"), manifest, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      join(staging, "SHA256SUMS"),
      checksumManifest(publishedFiles),
      { flag: "wx", mode: 0o600 },
    );

    const verifiedIdentity = await captureIdentity({
      ...selection,
      supervisor,
      failureCode: "codex_version_changed",
      runCommand,
    });
    assertIdentity(identity, verifiedIdentity);
    supervisorCleanupAttempted = true;
    await supervisor.cleanup();
    await rename(staging, out);
    published = true;
    outcome = Object.freeze({
      out,
      identity,
      schemaDigest,
      schemaInventory: Object.freeze([...schemaInventory]),
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupFailures = [];
    if (!published) {
      try {
        await rm(staging, { force: true, recursive: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (!supervisorCleanupAttempted) {
        try {
          supervisorCleanupAttempted = true;
          await supervisor.cleanup();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    surfaceCleanupFailures(primaryFailure, cleanupFailures);
  }
  if (primaryFailure) throw primaryFailure;
  return outcome;
}

function parseInvocation(argv) {
  if (argv.length !== 2 || argv[0] !== "--out" || argv[1] === "") {
    throw gateError("codex_protocol_snapshot_invocation_invalid");
  }
  return { out: argv[1] };
}

async function main() {
  try {
    const result = await snapshotProtocol(parseInvocation(process.argv.slice(2)));
    process.stdout.write(
      `codex_protocol_snapshot: PASS version=${result.identity.version} schemas=${result.schemaInventory.length} digest=${result.schemaDigest}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error?.code ?? "codex_protocol_snapshot_failed"}\n`);
    process.exitCode = error?.code === "codex_version_changed" ? 78 : 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
