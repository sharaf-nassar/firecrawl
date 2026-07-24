import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadAtomicDirectoryPublicationNative } from "./atomic-directory-publication-native.js";
import {
  reduceAtomicStartupRecoveryV1,
  type AtomicCanaryProofV1,
  type AtomicObjectEvidenceV1,
} from "./atomic-directory-publication.js";

const roots: string[] = [];
const addonPath = new URL(
  "../build/Release/atomic_directory_publication.node",
  import.meta.url,
).pathname;
const testAddonPath = new URL(
  "../build/Test/atomic_directory_publication_test.node",
  import.meta.url,
).pathname;
const tsxPath = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const PROTECTED_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const PROTECTED_GENERATION_ID = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("durable startup topology", () => {
  test("classifies a real published target without pathname data in the result", () => {
    const directory = root();
    const wrapper = join(directory, "wrapper");
    const target = join(directory, "target");
    mkdirSync(wrapper, { mode: 0o700 });
    mkdirSync(target, { mode: 0o700 });

    const decision = reduceAtomicStartupRecoveryV1({
      kind: "finalize",
      phase: "manifest_published",
      classification: "published",
      authorizedByFreshSnapshot: true,
      topology: {
        stableIntent: true,
        intentTemp: false,
        wrapper: existsSync(wrapper),
        privateSource: false,
        publicSource: false,
        publicTarget: existsSync(target) ? "match" : "absent",
        manifest: "stable",
      },
    });

    expect(decision).toEqual({
      kind: "recover_published",
      disposition: "adopt",
    });
    expect(JSON.stringify(decision)).not.toContain(directory);
  });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "atomic-publication-integration-"));
  roots.push(value);
  return value;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function directoryEvidence(target: string): AtomicObjectEvidenceV1 {
  const observed = statSync(target, { bigint: true });
  const value = {
    dev: String(observed.dev),
    ino: String(observed.ino),
    mode: Number(observed.mode & 0o7777n),
    size: Number(observed.size),
    contentSha256: null,
  };
  return Object.freeze({
    ...value,
    evidenceDigest: sha(JSON.stringify(value)),
  });
}

type CanaryBarrierFixture = {
  child: ChildProcess;
  close: () => void;
  completion: Promise<{
    code: number | null;
    error?: Error;
    signal: NodeJS.Signals | null;
  }>;
  readyReader: number;
};

const canaryBarrierChild = String.raw`
const { fstatSync } = require("node:fs");
const { constants: osConstants } = require("node:os");
const before = fstatSync(3, { bigint: true });
const moduleRecord = { exports: Object.create(null) };
process.dlopen(moduleRecord, "/proc/self/fd/3", osConstants.dlopen.RTLD_NOW);
const after = fstatSync(3, { bigint: true });
for (const key of ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"]) {
  if (before[key] !== after[key]) throw new Error("held test addon identity drifted");
}
moduleRecord.exports.renameNoReplace(4, process.argv[1], 5, process.argv[2]);
`;

function spawnCanaryBarrier(
  canonicalRoot: string,
  sourceLeaf: string,
  targetLeaf: string,
  phase: "before" | "after",
): CanaryBarrierFixture {
  const heldAddonPath = join(canonicalRoot, ".held-test-addon.node");
  copyFileSync(testAddonPath, heldAddonPath, constants.COPYFILE_EXCL);
  chmodSync(heldAddonPath, 0o600);
  const addon = openSync(
    heldAddonPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  unlinkSync(heldAddonPath);
  const wrapperPath = join(
    canonicalRoot,
    ".profile-publish-staging",
    "bundles",
    OPERATION_ID,
  );
  const sourceFd = openSync(
    wrapperPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const targetFd = openSync(
    join(canonicalRoot, "profiles"),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const controlPath = join(canonicalRoot, ".canary-barrier-control");
  writeFileSync(
    controlPath,
    `atomic-publish-syscall-barrier-v1:${phase}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const control = openSync(
    controlPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  unlinkSync(controlPath);
  const readyPath = join(canonicalRoot, ".canary-ready");
  const releasePath = join(canonicalRoot, ".canary-release");
  const mkfifo = spawnSync(
    "/usr/bin/mkfifo",
    ["--mode=0600", "--", readyPath, releasePath],
    { encoding: "utf8" },
  );
  if (mkfifo.status !== 0) {
    throw new Error(`mkfifo failed: ${mkfifo.stderr}`);
  }
  const open = new Set<number>();
  const remember = (descriptor: number): number => {
    open.add(descriptor);
    return descriptor;
  };
  const readyAnchor = remember(
    openSync(
      readyPath,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const releaseAnchor = remember(
    openSync(
      releasePath,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const readyReader = remember(
    openSync(
      readyPath,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const readyWriter = remember(
    openSync(
      readyPath,
      constants.O_WRONLY | constants.O_NOFOLLOW,
    ),
  );
  const releaseWriter = remember(
    openSync(
      releasePath,
      constants.O_WRONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const releaseReader = remember(
    openSync(
      releasePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ),
  );
  unlinkSync(readyPath);
  unlinkSync(releasePath);
  const closeRemembered = (descriptor: number): void => {
    if (!open.delete(descriptor)) return;
    closeSync(descriptor);
  };
  closeRemembered(readyAnchor);
  closeRemembered(releaseAnchor);
  let stderr = "";
  const child = spawn(
    process.execPath,
    ["-e", canaryBarrierChild, sourceLeaf, targetLeaf],
    {
      stdio: [
        "ignore",
        "ignore",
        "pipe",
        addon,
        sourceFd,
        targetFd,
        control,
        readyWriter,
        releaseReader,
      ],
    },
  );
  child.stderr?.setEncoding("utf8").on("data", chunk => {
    stderr += chunk;
  });
  let spawnError: Error | undefined;
  child.once("error", error => {
    spawnError = error;
  });
  const completion = new Promise<{
    code: number | null;
    error?: Error;
    signal: NodeJS.Signals | null;
  }>(resolve => {
    child.once("close", (code, signal) => {
      resolve({
        code,
        ...(spawnError === undefined ? {} : { error: spawnError }),
        signal,
      });
    });
  });
  closeSync(addon);
  closeSync(sourceFd);
  closeSync(targetFd);
  closeSync(control);
  closeRemembered(readyWriter);
  closeRemembered(releaseReader);
  let closed = false;
  return {
    child,
    close: () => {
      if (closed) return;
      closed = true;
      for (const descriptor of [...open]) closeRemembered(descriptor);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      if (stderr.length > 0 && child.signalCode !== "SIGKILL") {
        throw new Error(stderr);
      }
    },
    completion,
    readyReader,
  };
}

async function waitForCanaryBarrier(
  fixture: CanaryBarrierFixture,
): Promise<void> {
  const deadline = performance.now() + 3_000;
  const byte = Buffer.alloc(2);
  for (;;) {
    try {
      const count = readSync(
        fixture.readyReader,
        byte,
        0,
        byte.length,
        null,
      );
      if (count !== 1 || byte[0] !== 0x01) {
        throw new Error("invalid native syscall barrier ready record");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
    if (
      fixture.child.exitCode !== null ||
      fixture.child.signalCode !== null
    ) {
      throw new Error("barrier child exited before native rendezvous");
    }
    if (performance.now() >= deadline) {
      throw new Error("native syscall barrier ready deadline exceeded");
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function waitForCanaryChild(
  fixture: CanaryBarrierFixture,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout;
  const outcome = await Promise.race([
    fixture.completion.then(result => ({
      result,
      timedOut: false as const,
    })),
    new Promise<{ timedOut: true }>(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), 3_000);
    }),
  ]);
  if (outcome.timedOut) {
    fixture.child.kill("SIGKILL");
    await fixture.completion;
    throw new Error("native syscall barrier child deadline exceeded");
  }
  clearTimeout(timer!);
  if (outcome.result.error !== undefined) throw outcome.result.error;
  return {
    code: outcome.result.code,
    signal: outcome.result.signal,
  };
}

const protectedPublisherChild = String.raw`
const { createHash } = require("node:crypto");
const fs = require("node:fs");
(async () => {
  const reconciliation = await import("./src/reconciliation.ts");
  const canonicalRoot = process.argv[1];
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const barrierPhase = process.argv[3];
  const barrierMove = process.argv[4];
  const readyFd = fs.openSync(
    process.argv[5],
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
  );
  const releaseFd = fs.openSync(
    process.argv[6],
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const snapshot =
    reconciliation.canonicalizeReconciliationSnapshot([]);
  const request = {
    version: 1,
    processNonce: fixture.binding.processNonce,
    controlGenerationNonce: fixture.binding.controlGenerationNonce,
    snapshotDigest: snapshot.snapshotDigest,
    references: [],
  };
  if (request.snapshotDigest !== fixture.binding.snapshotDigest) {
    throw new Error("protected publisher binding digest mismatched");
  }
  const admission = {
    signal: new AbortController().signal,
    assertAdmitted() {},
  };
  const outcome =
    await reconciliation.reconcileBrowserStateWithAuthority(
      canonicalRoot,
      request,
      { admission },
    );
  let installedRoot;
  await reconciliation.consumeInternalReconciliationOutcome(
    outcome,
    fixture.binding,
    async install => {
      installedRoot = install.root;
    },
  );
  if (installedRoot === undefined) {
    throw new Error("protected publisher root was not installed");
  }
  const working = await reconciliation.bindProfileGeneration(
    installedRoot,
    {
      profileId: fixture.profileId,
      state: "working",
      generationId: fixture.generationId,
      openMode: "create_exclusive",
    },
  );
  await reconciliation.writeHeldProfileFixtureFile(
    working,
    "source.bin",
    "protected-source",
  );
  let rendezvoused = false;
  const rendezvous = () => {
    rendezvoused = true;
    try {
      fs.writeSync(readyFd, Buffer.from([0x01]));
      fs.readSync(releaseFd, Buffer.alloc(1), 0, 1, null);
    } catch (error) {
      fs.writeSync(
        2,
        "protected barrier failed: " +
          String(error?.stack ?? error) +
          "\n",
      );
      throw error;
    }
  };
  await reconciliation.runWithReconciliationFilesystemTestContext(
    {
      atomicNativeBarrier(phase, move) {
        if (
          rendezvoused ||
          phase !== barrierPhase ||
          move !== barrierMove
        ) {
          return;
        }
        rendezvous();
      },
      beforeCall(point) {
        if (
          rendezvoused ||
          barrierPhase !== "remove" ||
          point !== "atomic-remove-mutate"
        ) {
          return;
        }
        const intentsPath =
          canonicalRoot + "/.profile-publish-staging/intents";
        const removing = fs.readdirSync(intentsPath)
          .filter(leaf => /^[0-9a-f-]{36}\.json$/.test(leaf))
          .map(leaf =>
            JSON.parse(
              fs.readFileSync(intentsPath + "/" + leaf, "utf8"),
            ),
          )
          .some(intent =>
            intent.phase === "source_deleting" &&
            intent.sourceDeletion?.phase === "removing" &&
            intent.sourceDeletion.nextIndex > 0,
          );
        if (removing) rendezvous();
      },
    },
    () =>
      reconciliation.transitionHeldProfileGenerationAtomically(
        working,
        {
          binding: fixture.binding,
          kind: "prepare",
          authorityDigest: createHash("sha256")
            .update("protected-restart-authority")
            .digest("hex"),
          adoptionMode: "pre_ready",
        },
      ),
  );
  throw new Error("protected publisher escaped SIGKILL rendezvous");
})().catch(error => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
`;

function spawnProtectedPublisherBarrier(
  canonicalRoot: string,
  fixturePath: string,
  phase: "before" | "after" | "remove",
  move:
    | "profile_source_to_private"
    | "profile_publish" = "profile_source_to_private",
): CanaryBarrierFixture {
  const readyPath = `${fixturePath}.ready`;
  const releasePath = `${fixturePath}.release`;
  const mkfifo = spawnSync(
    "/usr/bin/mkfifo",
    ["--mode=0600", "--", readyPath, releasePath],
    { encoding: "utf8" },
  );
  if (mkfifo.status !== 0) {
    throw new Error(`mkfifo failed: ${mkfifo.stderr}`);
  }
  const open = new Set<number>();
  const remember = (descriptor: number): number => {
    open.add(descriptor);
    return descriptor;
  };
  const readyAnchor = remember(
    openSync(
      readyPath,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const releaseAnchor = remember(
    openSync(
      releasePath,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const readyReader = remember(
    openSync(
      readyPath,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const releaseWriter = remember(
    openSync(
      releasePath,
      constants.O_WRONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    ),
  );
  const closeRemembered = (descriptor: number): void => {
    if (!open.delete(descriptor)) return;
    closeSync(descriptor);
  };
  let stderr = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      protectedPublisherChild,
      canonicalRoot,
      fixturePath,
      phase,
      move,
      readyPath,
      releasePath,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.setEncoding("utf8").on("data", chunk => {
    stderr += chunk;
  });
  let spawnError: Error | undefined;
  child.once("error", error => {
    spawnError = error;
  });
  const completion = new Promise<{
    code: number | null;
    error?: Error;
    signal: NodeJS.Signals | null;
  }>(resolve => {
    child.once("close", (code, signal) => {
      resolve({
        code,
        ...(spawnError === undefined ? {} : { error: spawnError }),
        signal,
      });
    });
  });
  let closed = false;
  return {
    child,
    close: () => {
      if (closed) return;
      closed = true;
      for (const descriptor of [...open]) closeRemembered(descriptor);
      if (existsSync(readyPath)) unlinkSync(readyPath);
      if (existsSync(releasePath)) unlinkSync(releasePath);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      if (stderr.length > 0 && child.signalCode !== "SIGKILL") {
        throw new Error(stderr);
      }
    },
    completion,
    readyReader,
  };
}

const childPublisher = String.raw`
const fs = require("node:fs");
const moduleRecord = { exports: Object.create(null) };
process.dlopen(moduleRecord, process.argv[1]);
try {
  moduleRecord.exports.renameNoReplace(3, process.argv[2], 4, process.argv[3]);
  fs.writeSync(1, "success\n");
} catch (error) {
  fs.writeSync(1, String(error?.code ?? "unknown") + "\n");
}
`;

function publishChild(
  sourceFd: number,
  targetFd: number,
  sourceLeaf: string,
  targetLeaf: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", childPublisher, addonPath, sourceLeaf, targetLeaf],
      {
        stdio: ["ignore", "pipe", "pipe", sourceFd, targetFd],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) {
        reject(new Error(`publisher exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const freshCanaryRecoveryChild = String.raw`
const { createHash } = require("node:crypto");
const { constants, existsSync, readFileSync, statSync } = require("node:fs");
(async () => {
  const reconciliation = await import("./src/reconciliation.ts");
  const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const effectId = () => Object.freeze({});
  const evidence = target => {
    const observed = statSync(target, { bigint: true });
    const value = {
      dev: String(observed.dev),
      ino: String(observed.ino),
      mode: Number(observed.mode & 0o7777n),
      size: Number(observed.size),
      contentSha256: null,
    };
    return Object.freeze({
      ...value,
      evidenceDigest: createHash("sha256")
        .update(JSON.stringify(value))
        .digest("hex"),
    });
  };
  const admission = {
    signal: new AbortController().signal,
    assertAdmitted() {},
  };
  const lease =
    await reconciliation.acquireAtomicPreReadyRecoveryAuthorityFromCanonicalRoot(
      process.argv[1],
      fixture.binding,
      admission,
      fixture.proof.operationId,
    );
  try {
    for (const reservation of [
      { reservation: "stable_files", count: 1, byteSize: 0 },
      { reservation: "payload_entries", count: 257, byteSize: 0 },
      { reservation: "scratch_entries", count: 257, byteSize: 0 },
    ]) {
      const observed = await reconciliation.applyAtomicEffect(
        lease.controller,
        {
          kind: "reserve_budget",
          effectId: effectId(),
          operationId: fixture.proof.operationId,
          ...reservation,
        },
      );
      if (observed.kind !== "effect_completed") {
        throw new Error("fresh canary reservation failed");
      }
    }
    const bundlesPath =
      process.argv[1] + "/.profile-publish-staging/bundles";
    const bundles = await reconciliation.applyAtomicEffect(
      lease.controller,
      {
        kind: "open_pin_handle",
        effectId: effectId(),
        operationId: fixture.proof.operationId,
        role: "bundles_parent",
        parentId: lease.initialAuthority.stagingRootId,
        leaf: "bundles",
        flags: "directory_nofollow",
        expected: evidence(bundlesPath),
      },
    );
    if (bundles.kind !== "existing_handle_pinned") {
      throw new Error("fresh canary bundles parent was not pinned");
    }
    const wrapper = await reconciliation.applyAtomicEffect(
      lease.controller,
      {
        kind: "open_pin_handle",
        effectId: effectId(),
        operationId: fixture.proof.operationId,
        role: "wrapper",
        parentId: bundles.handleId,
        leaf: fixture.proof.operationId,
        flags: "directory_nofollow",
        expected: fixture.proof.wrapperEvidence,
      },
    );
    if (wrapper.kind !== "existing_handle_pinned") {
      throw new Error("fresh canary wrapper was not pinned");
    }
    const sourcePath =
      bundlesPath + "/" + fixture.proof.operationId + "/" +
      fixture.proof.sourceLeaf;
    let sourceId = Object.freeze({});
    if (existsSync(sourcePath)) {
      const source = await reconciliation.applyAtomicEffect(
        lease.controller,
        {
          kind: "open_pin_handle",
          effectId: effectId(),
          operationId: fixture.proof.operationId,
          role: "private_source",
          parentId: wrapper.handleId,
          leaf: fixture.proof.sourceLeaf,
          flags: "directory_nofollow",
          expected: fixture.proof.privateSourceEvidence,
        },
      );
      if (source.kind !== "existing_handle_pinned") {
        throw new Error("fresh canary source was not pinned");
      }
      sourceId = source.handleId;
    }
    const persisted = [];
    const result = await reconciliation.runAtomicCanaryRecovery(
      lease.controller,
      {
        flightNonce: "fresh-process-canary-recovery",
        action: "prove_mount",
        proof: fixture.proof,
        durableCanaryInventory: [fixture.proof],
        expectedTargetParentLocatorDigest:
          fixture.proof.targetParentLocatorDigest,
        sourceParentId: wrapper.handleId,
        sourceParentRole: "wrapper",
        sourceParentEvidence: wrapper.evidence,
        sourceId,
        targetParentId: lease.initialAuthority.profilesParentId,
        targetParentRole: "profiles_parent",
        targetParentEvidence:
          lease.initialAuthority.evidence.profilesParent,
        cleanupManifest: null,
      },
      async request => {
        persisted.push(request.proof.phase);
      },
    );
    process.stdout.write(JSON.stringify({
      kind: result.kind,
      phase: result.proof.phase,
      persisted,
    }));
  } finally {
    await reconciliation.closeAtomicEffectController(
      lease.controller,
    ).catch(() => undefined);
    await lease.closeRoot();
  }
})().catch(error => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
`;

function runFreshCanaryRecovery(
  canonicalRoot: string,
  fixturePath: string,
): {
  kind: string;
  phase: string;
  persisted: string[];
} {
  const result = spawnSync(
    tsxPath,
    [
      "-e",
      freshCanaryRecoveryChild,
      canonicalRoot,
      fixturePath,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    kind: string;
    phase: string;
    persisted: string[];
  };
}

const freshProtectedRecoveryChild = String.raw`
const fs = require("node:fs");
(async () => {
  const reconciliation = await import("./src/reconciliation.ts");
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const admission = {
    signal: new AbortController().signal,
    assertAdmitted() {},
  };
  const result =
    await reconciliation.recoverAtomicProtectedPublicationFromCanonicalRoot(
      process.argv[1],
      fixture.binding,
      admission,
      fixture.operationId,
    );
  process.stdout.write(JSON.stringify(result));
})().catch(error => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
`;

function runFreshProtectedRecovery(
  canonicalRoot: string,
  fixturePath: string,
): {
  operationId: string;
  phase: string;
  sealed: boolean;
} {
  const result = spawnSync(
    tsxPath,
    [
      "-e",
      freshProtectedRecoveryChild,
      canonicalRoot,
      fixturePath,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    operationId: string;
    phase: string;
    sealed: boolean;
  };
}

const freshStartupRecoveryChild = String.raw`
const fs = require("node:fs");
(async () => {
  const reconciliation = await import("./src/reconciliation.ts");
  const fixture = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const snapshot = reconciliation.canonicalizeReconciliationSnapshot([]);
  const request = {
    version: 1,
    processNonce: fixture.binding.processNonce,
    controlGenerationNonce: fixture.binding.controlGenerationNonce,
    snapshotDigest: snapshot.snapshotDigest,
    references: [],
  };
  const admission = {
    signal: new AbortController().signal,
    assertAdmitted() {},
  };
  const outcome =
    await reconciliation.reconcileBrowserStateWithAuthority(
      process.argv[1],
      request,
      { admission },
    );
  let installed = false;
  await reconciliation.consumeInternalReconciliationOutcome(
    outcome,
    fixture.binding,
    async install => {
      installed = true;
      await reconciliation.closeAnchoredProfileRoot(install.root);
    },
  );
  process.stdout.write(JSON.stringify({ installed }));
})().catch(error => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
`;

function runFreshStartupRecovery(
  canonicalRoot: string,
  fixturePath: string,
): { installed: boolean } {
  const result = spawnSync(
    tsxPath,
    [
      "-e",
      freshStartupRecoveryChild,
      canonicalRoot,
      fixturePath,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { installed: boolean };
}

describe("atomic directory publication host integration", () => {
  test("selects exactly one complete winner across concurrent processes", async () => {
    const directory = root();
    const sourceFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const targetFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const publishers = Array.from({ length: 24 }, (_, index) => {
        const leaf = `source-${String(index).padStart(2, "0")}`;
        mkdirSync(join(directory, leaf), { mode: 0o700 });
        writeFileSync(join(directory, leaf, "winner"), `${index}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        return { index, leaf };
      });
      const results = await Promise.all(
        publishers.map(({ leaf }) =>
          publishChild(sourceFd, targetFd, leaf, "winner"),
        ),
      );
      expect(results.filter(result => result === "success")).toHaveLength(1);
      expect(
        results.filter(result => result === "atomic_publish_exists"),
      ).toHaveLength(publishers.length - 1);
      const winner = Number(readFileSync(join(directory, "winner", "winner"), "utf8"));
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(winner).toBeLessThan(publishers.length);
      expect(results[winner]).toBe("success");
    } finally {
      closeSync(sourceFd);
      closeSync(targetFd);
    }
  });

  test.each(["before", "after"] as const)(
    "recovers durable canary after SIGKILL at native %s barrier",
    async phase => {
      const canonicalRoot = root();
      const profilesPath = join(canonicalRoot, "profiles");
      const stagingPath = join(
        canonicalRoot,
        ".profile-publish-staging",
      );
      const bundlesPath = join(stagingPath, "bundles");
      const wrapperPath = join(bundlesPath, OPERATION_ID);
      const sourceLeaf = `proof-${OPERATION_ID}-0`;
      const targetLeaf = `canary-${OPERATION_ID}-0`;
      mkdirSync(profilesPath, { mode: 0o700 });
      mkdirSync(stagingPath, { mode: 0o700 });
      mkdirSync(join(stagingPath, "intents"), { mode: 0o700 });
      mkdirSync(bundlesPath, { mode: 0o700 });
      mkdirSync(wrapperPath, { mode: 0o700 });
      mkdirSync(join(wrapperPath, sourceLeaf), { mode: 0o700 });
      const proof: AtomicCanaryProofV1 = Object.freeze({
        version: 1,
        operationId: OPERATION_ID,
        targetParentLocatorDigest: sha("profiles-parent"),
        targetParentEvidence: directoryEvidence(profilesPath),
        wrapperEvidence: directoryEvidence(wrapperPath),
        attempt: 0,
        sourceLeaf,
        targetLeaf,
        deletionLeaf: `deletion-${OPERATION_ID}-0`,
        phase: "planned",
        privateSourceEvidence: directoryEvidence(
          join(wrapperPath, sourceLeaf),
        ),
        publishedEvidence: null,
        privateDeletionEvidence: null,
        classification: null,
        manifestSha256: null,
        cleanupNextIndex: 0,
        cleanupEntryCount: 0,
        sourceParentSynced: false,
        targetParentSynced: false,
      });
      const durableFixturePath = join(
        canonicalRoot,
        ".durable-canary-fixture.json",
      );
      writeFileSync(
        durableFixturePath,
        JSON.stringify({
          binding: {
            processNonce: Buffer.alloc(32, 4).toString("base64url"),
            controlGenerationNonce:
              Buffer.alloc(32, 5).toString("base64url"),
            snapshotDigest: "a".repeat(64),
          },
          proof,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const fixture = spawnCanaryBarrier(
        canonicalRoot,
        sourceLeaf,
        targetLeaf,
        phase,
      );
      try {
        await waitForCanaryBarrier(fixture);
        expect(fixture.child.kill("SIGKILL")).toBe(true);
        expect(await waitForCanaryChild(fixture)).toEqual({
          code: null,
          signal: "SIGKILL",
        });
        expect({
          source: existsSync(join(wrapperPath, sourceLeaf)),
          target: existsSync(join(profilesPath, targetLeaf)),
        }).toEqual(
          phase === "before"
            ? { source: true, target: false }
            : { source: false, target: true },
        );
      } finally {
        fixture.close();
      }
      expect(
        runFreshCanaryRecovery(canonicalRoot, durableFixturePath),
      ).toEqual({
        kind: "mount_proved",
        phase: "published",
        persisted: ["published"],
      });
      expect(existsSync(join(wrapperPath, sourceLeaf))).toBe(false);
      expect(existsSync(join(profilesPath, targetLeaf))).toBe(true);
    },
  );

  test.each([
    {
      seam: "source-native-before",
      phase: "before",
      move: "profile_source_to_private",
    },
    {
      seam: "source-native-after",
      phase: "after",
      move: "profile_source_to_private",
    },
    {
      seam: "publication-native-after",
      phase: "after",
      move: "profile_publish",
    },
    {
      seam: "cursor-before-remove",
      phase: "remove",
      move: "profile_source_to_private",
    },
  ] as const)(
    "recovers protected publication after SIGKILL at $seam seam",
    async ({ phase, move }) => {
      const canonicalRoot = root();
      const fixtureDirectory = root();
      const stagingPath = join(
        canonicalRoot,
        ".profile-publish-staging",
      );
      mkdirSync(stagingPath, { mode: 0o700 });
      mkdirSync(join(stagingPath, "bundles"), { mode: 0o700 });
      mkdirSync(join(stagingPath, "intents"), { mode: 0o700 });
      mkdirSync(join(canonicalRoot, "profiles"), { mode: 0o700 });
      const binding = {
        processNonce: Buffer.alloc(32, 6).toString("base64url"),
        controlGenerationNonce:
          Buffer.alloc(32, 7).toString("base64url"),
        snapshotDigest: sha(
          JSON.stringify({ version: 1, references: [] }),
        ),
      };
      const fixturePath = join(
        fixtureDirectory,
        ".protected-publication-fixture.json",
      );
      writeFileSync(
        fixturePath,
        JSON.stringify({
          binding,
          profileId: PROTECTED_PROFILE_ID,
          generationId: PROTECTED_GENERATION_ID,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const fixture = spawnProtectedPublisherBarrier(
        canonicalRoot,
        fixturePath,
        phase,
        move,
      );
      let operationId = "";
      try {
        await waitForCanaryBarrier(fixture);
        const intentsPath = join(
          canonicalRoot,
          ".profile-publish-staging",
          "intents",
        );
        const intentLeaves = readdirSync(intentsPath).filter(leaf =>
          /^[0-9a-f-]{36}\.json$/u.test(leaf),
        );
        expect(intentLeaves).toHaveLength(1);
        operationId = intentLeaves[0]!.slice(0, -".json".length);
        expect(fixture.child.kill("SIGKILL")).toBe(true);
        expect(await waitForCanaryChild(fixture)).toEqual({
          code: null,
          signal: "SIGKILL",
        });
        if (move === "profile_publish") {
          const durable = JSON.parse(
            readFileSync(
              join(intentsPath, `${operationId}.json`),
              "utf8",
            ),
          );
          expect(durable).toMatchObject({
            phase: "ready",
            classification: null,
          });
        }
      } finally {
        fixture.close();
      }
      const intentsPath = join(
        canonicalRoot,
        ".profile-publish-staging",
        "intents",
      );
      const bundlesPath = join(
        canonicalRoot,
        ".profile-publish-staging",
        "bundles",
      );
      const wrapperPath = join(bundlesPath, operationId);
      const publicSourcePath = join(
        canonicalRoot,
        "profiles",
        PROTECTED_PROFILE_ID,
        "working",
        PROTECTED_GENERATION_ID,
      );
      const privateSourcePath = join(
        wrapperPath,
        `delete-${operationId}`,
      );
      const targetPath = join(
        canonicalRoot,
        "profiles",
        PROTECTED_PROFILE_ID,
        "staging",
        PROTECTED_GENERATION_ID,
      );
      expect(existsSync(targetPath)).toBe(true);
      expect({
        publicSource: existsSync(publicSourcePath),
        privateSource: existsSync(privateSourcePath),
      }).toEqual(
        phase === "before"
          ? { publicSource: true, privateSource: false }
          : {
              publicSource: move === "profile_publish",
              privateSource: move !== "profile_publish",
            },
      );
      writeFileSync(
        fixturePath,
        JSON.stringify({ binding, operationId }),
        { flag: "w", mode: 0o600 },
      );
      if (move === "profile_publish") {
        expect(
          runFreshStartupRecovery(canonicalRoot, fixturePath),
        ).toEqual({ installed: true });
      } else {
        expect(
          runFreshProtectedRecovery(canonicalRoot, fixturePath),
        ).toEqual({
          operationId,
          phase: "cleaned",
          sealed: true,
        });
      }
      expect(
        readFileSync(join(targetPath, "source.bin"), "utf8"),
      ).toBe("protected-source");
      expect(existsSync(publicSourcePath)).toBe(false);
      expect(existsSync(privateSourcePath)).toBe(false);
      expect(existsSync(wrapperPath)).toBe(false);
      expect(
        existsSync(join(intentsPath, `${operationId}.identities.json`)),
      ).toBe(false);
      expect(existsSync(join(intentsPath, `${operationId}.json`))).toBe(
        false,
      );
      expect(readdirSync(bundlesPath)).toEqual([]);
      expect(readdirSync(intentsPath)).toEqual([]);
    },
  );

  test("returns exact stable codes for host-native boundary failures", () => {
    const directory = root();
    const sourceFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const targetFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const ordinaryFile = join(directory, "ordinary");
    writeFileSync(ordinaryFile, "x", { flag: "wx", mode: 0o600 });
    const nonDirectoryFd = openSync(ordinaryFile, constants.O_RDONLY);
    const closedFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    closeSync(closedFd);
    const native = loadAtomicDirectoryPublicationNative();
    try {
      expect(() =>
        native.renameNoReplace(
          sourceFd,
          "missing",
          targetFd,
          "missing-target",
        ),
      ).toThrow(
        expect.objectContaining({ code: "atomic_publish_source_missing" }),
      );
      expect(() =>
        native.renameNoReplace(-1, "source", targetFd, "target"),
      ).toThrow(
        expect.objectContaining({ code: "atomic_publish_invalid_argument" }),
      );
      expect(() =>
        native.renameNoReplace(closedFd, "source", targetFd, "target"),
      ).toThrow(
        expect.objectContaining({ code: "atomic_publish_binding_invalid" }),
      );
      expect(() =>
        native.renameNoReplace(
          nonDirectoryFd,
          "source",
          targetFd,
          "target",
        ),
      ).toThrow(
        expect.objectContaining({ code: "atomic_publish_binding_invalid" }),
      );
      expect(() =>
        native.renameNoReplace(sourceFd, "../source", targetFd, "target"),
      ).toThrow(
        expect.objectContaining({ code: "atomic_publish_invalid_argument" }),
      );
    } finally {
      closeSync(nonDirectoryFd);
      closeSync(sourceFd);
      closeSync(targetFd);
    }
  });
});
