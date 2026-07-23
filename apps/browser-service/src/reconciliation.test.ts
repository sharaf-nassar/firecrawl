import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright";
import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  ReconciliationReferenceV1,
  ReconciliationRequestV1,
} from "./contracts.js";
import { BrowserServiceError } from "./errors.js";
import type {
  AtomicCanaryProofV1,
  AtomicObjectEvidenceV1,
  FlightEffectId,
  FlightSemanticId,
} from "./atomic-directory-publication.js";
import {
  acquireAtomicPreReadyRecoveryAuthority,
  applyAtomicEffect,
  atomicHeldProfileHashImplementationIdentityForTest,
  bindProfileGeneration,
  canonicalizeHeldProfileTree,
  canonicalizeReconciliationSnapshot,
  closeAtomicEffectController,
  canonicalizeProfileTree,
  closeAnchoredProfileRoot,
  consumeInternalReconciliationOutcome,
  copyHeldProfileTree,
  listHeldProfileGenerations,
  launchPersistentChromiumForWorking,
  reconcileBrowserState,
  reconcileBrowserStateWithAuthority,
  releaseChromiumSessionAttachment,
  retryFailedReconciliationOutcomeCleanups,
  runAtomicCanaryRecovery,
  runWithReconciliationFilesystemTestContext,
  syncAndCanonicalizeHeldProfileTree,
  writeHeldProfileFixtureFile,
  type AnchoredProfileRoot,
} from "./reconciliation.js";
import type { ReconciliationExecutionAdmission } from "./startup-state.js";

const PROCESS = Buffer.alloc(32, 4).toString("base64url");
const GENERATION = Buffer.alloc(32, 5).toString("base64url");
const CHECKPOINT_A = "11111111-1111-4111-8111-111111111111";
const CHECKPOINT_B = "22222222-2222-4222-8222-222222222222";
const PROFILE = "33333333-3333-4333-8333-333333333333";
const STATE = { cookies: [], origins: [] };
const STATE_BYTES = Buffer.from('{"cookies":[],"origins":[]}', "utf8");
const OLD = new Date("2026-07-21T11:00:00.000Z");
const NOW = new Date("2026-07-21T12:00:00.000Z");
const roots: string[] = [];
const execFileAsync = promisify(execFile);

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function atomicEffectId(): FlightEffectId {
  return Object.freeze({}) as FlightEffectId;
}

async function atomicFileEvidence(
  target: string,
  contentSha256: string | null,
): Promise<AtomicObjectEvidenceV1> {
  const observed = await stat(target, { bigint: true });
  const value = {
    dev: String(observed.dev),
    ino: String(observed.ino),
    mode: Number(observed.mode & 0o7777n),
    size: Number(observed.size),
    contentSha256,
  };
  return Object.freeze({
    ...value,
    evidenceDigest: sha(JSON.stringify(value)),
  }) as AtomicObjectEvidenceV1;
}

async function openAtomicBundlesParent(
  lease: Awaited<ReturnType<typeof acquireAtomicPreReadyRecoveryAuthority>>,
  canonicalRoot: string,
  operationId = CHECKPOINT_A,
) {
  for (const reservation of [
    {
      reservation: "stable_files" as const,
      count: 1,
      byteSize: 0,
    },
    {
      reservation: "payload_entries" as const,
      count: 257,
      byteSize: 0,
    },
  ]) {
    const reserved = await applyAtomicEffect(lease.controller, {
      kind: "reserve_budget",
      effectId: atomicEffectId(),
      operationId,
      ...reservation,
    });
    if (reserved.kind !== "effect_completed") {
      throw new Error("atomic test reservation failed");
    }
  }
  const expected = await atomicFileEvidence(
    path.join(
      canonicalRoot,
      ".profile-publish-staging",
      "bundles",
    ),
    null,
  );
  const opened = await applyAtomicEffect(lease.controller, {
    kind: "open_pin_handle",
    effectId: atomicEffectId(),
    operationId,
    role: "bundles_parent",
    parentId: lease.initialAuthority.stagingRootId,
    leaf: "bundles",
    flags: "directory_nofollow",
    expected,
  });
  if (opened.kind !== "existing_handle_pinned") {
    throw new Error("atomic bundles parent was not pinned");
  }
  return opened;
}

async function createAtomicCanaryFixture(
  lease: Awaited<ReturnType<typeof acquireAtomicPreReadyRecoveryAuthority>>,
  bundles: Awaited<ReturnType<typeof openAtomicBundlesParent>>,
  operationId: typeof CHECKPOINT_A | typeof CHECKPOINT_B,
  targetParentLocatorDigest = sha("profiles-parent-locator"),
) {
  const wrapper = await applyAtomicEffect(lease.controller, {
    kind: "create_and_pin_wrapper",
    effectId: atomicEffectId(),
    operationId,
    role: "wrapper",
    parentId: bundles.handleId,
    leaf: operationId,
    parentEvidenceDigest: bundles.evidence.evidenceDigest,
    mode: 448,
    expectedAbsence: true,
  });
  if (wrapper.kind !== "create_and_pin_completed") {
    throw new Error("canary wrapper was not created");
  }
  const sourceLeaf = `proof-${operationId}-0`;
  const source = await applyAtomicEffect(lease.controller, {
    kind: "create_and_pin_directory",
    effectId: atomicEffectId(),
    operationId,
    role: "private_source",
    parentId: wrapper.handleId,
    leaf: sourceLeaf,
    parentEvidenceDigest: wrapper.evidence.evidenceDigest,
    mode: 448,
    expectedAbsence: true,
  });
  if (source.kind !== "create_and_pin_completed") {
    throw new Error("canary source was not created");
  }
  const proof: AtomicCanaryProofV1 = Object.freeze({
    version: 1,
    operationId,
    targetParentLocatorDigest,
    targetParentEvidence: lease.initialAuthority.evidence.profilesParent,
    wrapperEvidence: wrapper.evidence,
    attempt: 0,
    sourceLeaf,
    targetLeaf: `canary-${operationId}-0`,
    deletionLeaf: `deletion-${operationId}-0`,
    phase: "planned",
    privateSourceEvidence: source.evidence,
    publishedEvidence: null,
    privateDeletionEvidence: null,
    classification: null,
    manifestSha256: null,
    cleanupNextIndex: 0,
    cleanupEntryCount: 0,
    sourceParentSynced: false,
    targetParentSynced: false,
  });
  return Object.freeze({ wrapper, source, proof });
}

async function provisionAtomicNamespaces(canonicalRoot: string): Promise<void> {
  await mkdir(path.join(canonicalRoot, "profiles"), {
    mode: 0o700,
  });
  await mkdir(path.join(canonicalRoot, ".profile-publish-staging"), {
    mode: 0o700,
  });
  await mkdir(
    path.join(canonicalRoot, ".profile-publish-staging", "intents"),
    { mode: 0o700 },
  );
  await mkdir(
    path.join(canonicalRoot, ".profile-publish-staging", "bundles"),
    { mode: 0o700 },
  );
}

function admission(controller = new AbortController()): {
  value: ReconciliationExecutionAdmission;
  controller: AbortController;
} {
  return {
    value: {
      signal: controller.signal,
      assertAdmitted() {
        if (controller.signal.aborted) {
          throw new BrowserServiceError(
            "reconciliation_required",
            "reconciliation is not admitted",
          );
        }
      },
    },
    controller,
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "firecrawl-reconcile-"));
  await chmod(value, 0o700);
  roots.push(value);
  return value;
}

async function put(
  canonicalRoot: string,
  relative: string,
  bytes = STATE_BYTES,
  old = true,
): Promise<void> {
  const profileMatch = /^profiles\/([^/]+)\/(working|staging|committed)\//u.exec(
    relative,
  );
  if (profileMatch !== null) {
    for (const state of ["working", "staging", "committed"]) {
      await mkdir(
        path.join(canonicalRoot, "profiles", profileMatch[1]!, state),
        { recursive: true, mode: 0o700 },
      );
    }
  }
  const target = path.join(canonicalRoot, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600 });
  if (old) await utimes(target, OLD, OLD);
}

async function ensureProfileStates(
  canonicalRoot: string,
  profileId = PROFILE,
): Promise<void> {
  for (const state of ["working", "staging", "committed"]) {
    await mkdir(path.join(canonicalRoot, "profiles", profileId, state), {
      recursive: true,
      mode: 0o700,
    });
  }
}

function reference(
  id: string,
  relativePath: string,
  checksum = sha(STATE_BYTES),
  kind: ReconciliationReferenceV1["kind"] = "replay_checkpoint",
): ReconciliationReferenceV1 {
  return { kind, id, path: relativePath, checksum };
}

function request(
  references: ReconciliationReferenceV1[],
  processNonce = PROCESS,
  controlGenerationNonce = GENERATION,
): ReconciliationRequestV1 {
  const { snapshotDigest } = canonicalizeReconciliationSnapshot(references);
  return {
    version: 1,
    processNonce,
    controlGenerationNonce,
    snapshotDigest,
    references,
  };
}

function checkpointId(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function rootDescriptors(canonicalRoot: string): Promise<string[]> {
  const leaked: string[] = [];
  for (const descriptor of await readdir("/proc/self/fd")) {
    try {
      const target = await readlink(`/proc/self/fd/${descriptor}`);
      if (target.includes(canonicalRoot)) leaked.push(target);
    } catch {
      // Descriptor may close between readdir and readlink.
    }
  }
  return leaked;
}

async function installedProfileRoot(
  canonicalRoot: string,
  installedAdmission?: ReconciliationExecutionAdmission,
): Promise<{
  root: AnchoredProfileRoot;
  binding: {
    processNonce: string;
    controlGenerationNonce: string;
    snapshotDigest: string;
  };
}> {
  const value = request([]);
  const outcome = await reconcileBrowserStateWithAuthority(
    canonicalRoot,
    value,
    { admission: installedAdmission ?? admission().value, now: () => NOW },
  );
  const binding = {
    processNonce: value.processNonce,
    controlGenerationNonce: value.controlGenerationNonce,
    snapshotDigest: value.snapshotDigest,
  };
  let installed: AnchoredProfileRoot | undefined;
  await consumeInternalReconciliationOutcome(
    outcome,
    binding,
    async (install) => {
      installed = install.root;
    },
  );
  if (installed === undefined) throw new Error("root was not installed");
  return { root: installed, binding };
}

function parentRecord(
  relative: string,
  value: Awaited<ReturnType<typeof stat>>,
): {
  path: string;
  dev: string;
  ino: string;
  mode: number;
} {
  return {
    path: relative,
    dev: String(value.dev),
    ino: String(value.ino),
    mode: value.mode & 0o777,
  };
}

async function installPendingPlan(
  canonicalRoot: string,
  count: number,
  processNonce: string,
  generationNonce: string,
): Promise<void> {
  const sourceParentPath = "replay/pending/workset";
  const destinationParentPath = `quarantine/${processNonce}/${generationNonce}/${sourceParentPath}`;
  await mkdir(path.join(canonicalRoot, sourceParentPath), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(path.join(canonicalRoot, destinationParentPath), {
    recursive: true,
    mode: 0o700,
  });
  const sourceParent = parentRecord(
    sourceParentPath,
    await stat(path.join(canonicalRoot, sourceParentPath)),
  );
  const destinationParent = parentRecord(
    destinationParentPath,
    await stat(path.join(canonicalRoot, destinationParentPath)),
  );
  const entries = Array.from({ length: count }, (_, index) => {
    const id = `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index
      .toString(16)
      .padStart(12, "0")}`;
    const sourcePath = `${sourceParentPath}/${id}.json`;
    return {
      sourcePath,
      destinationPath: `quarantine/${processNonce}/${generationNonce}/${sourcePath}`,
      recognizedType: "replay_checkpoint",
      identitySha256: "0".repeat(64),
      bytes: 0,
      sourceParent,
      destinationParent,
      phaseModel: 1,
    };
  });
  const digest = "d".repeat(64);
  const planDirectory = path.join(
    canonicalRoot,
    "quarantine",
    processNonce,
    generationNonce,
    ".plans",
    digest,
  );
  await mkdir(planDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(planDirectory, "plan.json"),
    Buffer.from(
      JSON.stringify({
        version: 1,
        processNonce,
        controlGenerationNonce: generationNonce,
        snapshotDigest: digest,
        retained: 0,
        removed: count,
        entries,
      }),
    ),
    { mode: 0o600 },
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true })),
  );
});

describe("snapshot canonicalization", () => {
  test("sorts references by kind, id, and path with fixed keys", () => {
    const a = reference(
      CHECKPOINT_A,
      `replay/owner/scrape/${CHECKPOINT_A}.json`,
    );
    const b = reference(
      CHECKPOINT_B,
      `replay/owner/scrape/${CHECKPOINT_B}.json`,
      sha(STATE_BYTES),
      "replay_checkpoint_cleanup_intent",
    );
    const result = canonicalizeReconciliationSnapshot([b, a]);
    expect(result.canonicalJson).toBe(
      JSON.stringify({ version: 1, references: [a, b] }),
    );
    expect(result.snapshotDigest).toBe(sha(result.canonicalJson));
  });
});

describe("filesystem reconciliation", () => {
  test("resumes an authorized working deletion tombstone before readiness", async () => {
    const canonicalRoot = await root();
    await ensureProfileStates(canonicalRoot);
    const tombstone = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      `.${CHECKPOINT_A}.deleting`,
    );
    await mkdir(path.join(tombstone, "Default"), { recursive: true });
    await writeFile(path.join(tombstone, "Default", "Preferences"), "{}");
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ ready: true });
    expect(await exists(tombstone)).toBe(false);
  });

  test("rejects malformed working deletion tombstones without removing them", async () => {
    const canonicalRoot = await root();
    const tombstone = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      ".not-a-generation.deleting",
    );
    await mkdir(tombstone, { recursive: true });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toBeDefined();
    expect(await exists(tombstone)).toBe(true);
  });

  test("preflights all profile evidence before deleting a valid tombstone", async () => {
    const canonicalRoot = await root();
    await ensureProfileStates(canonicalRoot);
    const tombstone = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      `.${CHECKPOINT_A}.deleting`,
    );
    await mkdir(tombstone, { mode: 0o700 });
    await mkdir(
      path.join(
        canonicalRoot,
        "profiles",
        PROFILE,
        "committed",
        "not-a-generation",
      ),
      { mode: 0o700 },
    );
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(tombstone)).toBe(true);
  });

  test.each(["tombstone-entry-remove", "tombstone-remove"])(
    "never deletes a swapped tombstone leaf at %s",
    async (point) => {
      const canonicalRoot = await root();
      await ensureProfileStates(canonicalRoot);
      const tombstone = path.join(
        canonicalRoot,
        "profiles",
        PROFILE,
        "working",
        `.${CHECKPOINT_A}.deleting`,
      );
      const child = path.join(tombstone, "state");
      await mkdir(tombstone, { mode: 0o700 });
      await writeFile(child, "trusted", { mode: 0o600 });
      let replacement = "";
      let held = "";
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(candidate) {
              if (candidate !== point || replacement !== "") return;
              replacement = point === "tombstone-remove" ? tombstone : child;
              held = `${replacement}.held`;
              await rename(replacement, held);
              if (point === "tombstone-remove") {
                await mkdir(replacement, { mode: 0o700 });
                await writeFile(path.join(replacement, "outside"), "safe");
              } else {
                await writeFile(replacement, "safe", { mode: 0o600 });
              }
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(replacement).not.toBe("");
      expect(
        point === "tombstone-remove"
          ? await readFile(path.join(replacement, "outside"), "utf8")
          : await readFile(replacement, "utf8"),
      ).toBe("safe");
      expect(await exists(held)).toBe(true);
    },
  );

  test.each([
    "tombstone-entry-remove",
    "tombstone-entry-parent-sync",
    "tombstone-remove",
    "tombstone-parent-sync",
  ])("resumes tombstone recovery after %s crash", async (crashPoint) => {
    const canonicalRoot = await root();
    await ensureProfileStates(canonicalRoot);
    const tombstone = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      `.${CHECKPOINT_A}.deleting`,
    );
    await mkdir(path.join(tombstone, "Default"), { recursive: true });
    await writeFile(path.join(tombstone, "Default", "Preferences"), "{}");
    let injected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (!injected && point === crashPoint) {
              injected = true;
              throw new Error(`crash:${point}`);
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toBeDefined();
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ ready: true });
    expect(await exists(tombstone)).toBe(false);
  });

  test("generation close revokes acquisitions and drains a paused operation", async () => {
    const stage = async <T>(promise: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`stuck:${label}`)), 1_000),
        ),
      ]);
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(working, "Preferences", "{}");
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached!: () => void;
    const didReach = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const operation = runWithReconciliationFilesystemTestContext(
      {
        async beforeCall(point) {
          if (point === "absolute-held-stat") {
            reached();
            await paused;
          }
        },
      },
      () => canonicalizeHeldProfileTree(working),
    );
    await stage(didReach, "reach");
    let closed = false;
    const closing = working.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(canonicalizeHeldProfileTree(working)).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    resume();
    await stage(operation, "operation");
    await stage(closing, "closing");
    await stage(closeAnchoredProfileRoot(installed.root), "root-close");
  });

  test("retains failed generation close ownership until a verified retry", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    let injected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async closeOperation(point, close) {
            if (!injected && point === "generation") {
              injected = true;
              throw new Error("injected generation close failure");
            }
            await close();
          },
        },
        () => working.close(),
      ),
    ).rejects.toThrow("injected generation close failure");
    await expect(canonicalizeHeldProfileTree(working)).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    await expect(
      Promise.race([
        closeAnchoredProfileRoot(installed.root),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("root close hung")), 1_000),
        ),
      ]),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await expect(working.close()).resolves.toBeUndefined();
    await expect(closeAnchoredProfileRoot(installed.root)).resolves.toBeUndefined();
  });

  test("generation transition revokes acquisitions and waits for prior work", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(working, "Preferences", "{}");
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached!: () => void;
    const didReach = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const operation = runWithReconciliationFilesystemTestContext(
      {
        async beforeCall(point) {
          if (point === "absolute-held-stat") {
            reached();
            await paused;
          }
        },
      },
      () => canonicalizeHeldProfileTree(working),
    );
    await didReach;
    const transition = working.transitionTo("staging");
    await expect(canonicalizeHeldProfileTree(working)).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    resume();
    await operation;
    const staging = await transition;
    await staging.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("retains attacker replacement and fail-stops after create identity loss", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const generation = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
    );
    const held = `${generation}.held`;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (point !== "profile-mkdir-generation") return;
            await rename(generation, held);
            await mkdir(generation, { mode: 0o700 });
            await writeFile(path.join(generation, "outside"), "safe");
            throw new Error("injected generation identity loss");
          },
        },
        () => bindProfileGeneration(installed.root, {
          profileId: PROFILE,
          state: "working",
          generationId: CHECKPOINT_A,
          openMode: "create_exclusive",
        }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await readFile(path.join(generation, "outside"), "utf8")).toBe("safe");
    expect(await exists(held)).toBe(true);
    await expect(listHeldProfileGenerations(installed.root, "working"))
      .rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await expect(closeAnchoredProfileRoot(installed.root)).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    await rm(generation, { recursive: true });
    await rename(held, generation);
    await closeAnchoredProfileRoot(installed.root);
  });

  test("copy rolls back its source lease when destination is revoked", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const sourceWorking = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(sourceWorking, "Preferences", "{}");
    const sourceStaging = await sourceWorking.transitionTo("staging");
    const source = await sourceStaging.transitionTo("committed");
    const destination = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_B,
      openMode: "create_exclusive",
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached!: () => void;
    const didReach = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let intercepted = false;
    const operation = runWithReconciliationFilesystemTestContext(
      {
        async beforeCall(point) {
          if (!intercepted && point === "absolute-held-stat") {
            intercepted = true;
            reached();
            await paused;
          }
        },
      },
      () => canonicalizeHeldProfileTree(destination),
    );
    await didReach;
    const transition = destination.transitionTo("staging");
    await expect(copyHeldProfileTree(source, destination)).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    resume();
    await operation;
    const destinationStaging = await transition;
    await canonicalizeHeldProfileTree(source);
    await destinationStaging.close();
    await source.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each([
    ["canonicalize", "before"],
    ["canonicalize", "after"],
    ["sync", "before"],
    ["sync", "after"],
    ["copy", "before"],
    ["copy", "after"],
    ["transition", "before"],
    ["transition", "after"],
  ] as const)("aborts held %s at %s-await admission boundary", async (operation, seam) => {
    const canonicalRoot = await root();
    const controller = new AbortController();
    const installed = await installedProfileRoot(
      canonicalRoot,
      admission(controller).value,
    );
    let primary = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(primary, "state", "trusted");
    let secondary: Awaited<ReturnType<typeof bindProfileGeneration>> | undefined;
    if (operation === "copy") {
      primary = await (await primary.transitionTo("staging")).transitionTo(
        "committed",
      );
      secondary = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_B,
        openMode: "create_exclusive",
      });
    }
    let aborted = false;
    const execute = (): Promise<unknown> => {
      if (operation === "canonicalize") return canonicalizeHeldProfileTree(primary);
      if (operation === "sync") return syncAndCanonicalizeHeldProfileTree(primary);
      if (operation === "transition") return primary.transitionTo("staging");
      return copyHeldProfileTree(primary, secondary!);
    };
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (!aborted && seam === "before" && point === "generation-held-stat") {
              aborted = true;
              controller.abort();
            }
          },
          afterCall(point) {
            if (!aborted && seam === "after" && point === "generation-held-stat") {
              aborted = true;
              controller.abort();
            }
          },
        },
        execute,
      ),
    ).rejects.toMatchObject({ category: "reconciliation_required" });
    expect(aborted).toBe(true);
    await secondary?.close();
    await primary.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each(["sync", "copy"] as const)(
    "root rollover drains paused held %s before descriptor close",
    async (operation) => {
      const canonicalRoot = await root();
      const installed = await installedProfileRoot(canonicalRoot);
      let primary = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_A,
        openMode: "create_exclusive",
      });
      await writeHeldProfileFixtureFile(primary, "state", "trusted");
      let secondary: Awaited<ReturnType<typeof bindProfileGeneration>> | undefined;
      if (operation === "copy") {
        primary = await (await primary.transitionTo("staging")).transitionTo(
          "committed",
        );
        secondary = await bindProfileGeneration(installed.root, {
          profileId: PROFILE,
          state: "working",
          generationId: CHECKPOINT_B,
          openMode: "create_exclusive",
        });
      }
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let reached!: () => void;
      const didReach = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let intercepted = false;
      const running = runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            const target = operation === "sync" ? "held-profile-sync" : "held-copy-write";
            if (!intercepted && point === target) {
              intercepted = true;
              reached();
              await paused;
            }
          },
        },
        () =>
          operation === "sync"
            ? syncAndCanonicalizeHeldProfileTree(primary)
            : copyHeldProfileTree(primary, secondary!),
      );
      await didReach;
      let rootClosed = false;
      const closing = closeAnchoredProfileRoot(installed.root).then(() => {
        rootClosed = true;
      });
      await Promise.resolve();
      expect(rootClosed).toBe(false);
      resume();
      await running;
      await secondary?.close();
      await primary.close();
      await closing;
      expect(rootClosed).toBe(true);
    },
  );

  test.each(
    (["canonicalize", "sync", "copy", "transition"] as const).flatMap(
      (operation) =>
        (["root", "profiles", "profile", "state", "generation"] as const).map(
          (component) => [operation, component] as const,
        ),
    ),
  )(
    "confines direct held %s across a %s hierarchy replacement",
    async (operation, component) => {
      const canonicalRoot = await root();
      const installed = await installedProfileRoot(canonicalRoot);
      let primary = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_A,
        openMode: "create_exclusive",
      });
      await writeHeldProfileFixtureFile(primary, "state", "trusted");
      let secondary: Awaited<ReturnType<typeof bindProfileGeneration>> | undefined;
      let state = "working";
      if (operation === "copy") {
        primary = await (await primary.transitionTo("staging")).transitionTo(
          "committed",
        );
        state = "committed";
        secondary = await bindProfileGeneration(installed.root, {
          profileId: PROFILE,
          state: "working",
          generationId: CHECKPOINT_B,
          openMode: "create_exclusive",
        });
      }
      const targets = {
        root: canonicalRoot,
        profiles: path.join(canonicalRoot, "profiles"),
        profile: path.join(canonicalRoot, "profiles", PROFILE),
        state: path.join(canonicalRoot, "profiles", PROFILE, state),
        generation: path.join(
          canonicalRoot,
          "profiles",
          PROFILE,
          state,
          CHECKPOINT_A,
        ),
      };
      const target = targets[component];
      const held = `${target}.held-matrix`;
      let swapped = false;
      let restored = false;
      let attackerBytes: string | undefined;
      const swap = async (): Promise<void> => {
        await rename(target, held);
        await mkdir(target, { recursive: true, mode: 0o700 });
        await writeFile(path.join(target, "outside"), "safe", { mode: 0o600 });
        swapped = true;
      };
      const restore = async (): Promise<void> => {
        attackerBytes = await readFile(path.join(target, "outside"), "utf8");
        await rm(target, { recursive: true });
        await rename(held, target);
        restored = true;
      };
      const seam =
        operation === "canonicalize"
          ? "profile-evidence-read"
          : operation === "sync"
            ? "held-profile-sync-stat"
            : operation === "copy"
              ? "held-copy-read"
              : "profile-state-transition";
      try {
        const running = runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(point) {
              if (!swapped && point === seam) await swap();
            },
            async afterCall(point) {
              if (
                operation !== "transition" &&
                swapped &&
                !restored &&
                point === seam
              ) {
                await restore();
              }
            },
          },
          () => {
            if (operation === "canonicalize")
              return canonicalizeHeldProfileTree(primary);
            if (operation === "sync")
              return syncAndCanonicalizeHeldProfileTree(primary);
            if (operation === "copy")
              return copyHeldProfileTree(primary, secondary!);
            return primary.transitionTo("staging");
          },
        );
        const rejectsReplacement =
          operation === "transition" ||
          (component === "generation" &&
            (operation === "canonicalize" || operation === "sync"));
        if (rejectsReplacement) {
          await expect(running).rejects.toMatchObject({
            category: "reconciliation_filesystem_unsafe",
          });
          if (operation === "transition") {
            expect(await readFile(path.join(target, "outside"), "utf8")).toBe(
              "safe",
            );
          }
        } else {
          await expect(running).resolves.toMatchObject({
            checksum: expect.any(String),
          });
        }
        expect(swapped).toBe(true);
        expect(operation === "transition" ? "safe" : attackerBytes).toBe(
          "safe",
        );
      } finally {
        if (swapped && !restored) await restore();
        await secondary?.close().catch(() => undefined);
        await primary.close().catch(() => undefined);
        await closeAnchoredProfileRoot(installed.root);
      }
    },
  );

  test("stops held sync and copy before effect at entry 25,001", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    let source = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const generation = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
    );
    for (let offset = 0; offset < 25_000; offset += 250) {
      await Promise.all(
        Array.from({ length: 250 }, (_, index) =>
          writeFile(
            path.join(
              generation,
              `entry-${String(offset + index).padStart(5, "0")}`,
            ),
            Buffer.alloc(0),
            { mode: 0o600 },
          ),
        ),
      );
    }
    let syncEffects = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point === "held-profile-sync") syncEffects += 1;
          },
        },
        () => syncAndCanonicalizeHeldProfileTree(source),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_snapshot_too_large" });
    expect(syncEffects).toBe(0);

    source = await (await source.transitionTo("staging")).transitionTo(
      "committed",
    );
    const destination = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_B,
      openMode: "create_exclusive",
    });
    let copyEffects = 0;
    try {
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (point.startsWith("held-copy-")) copyEffects += 1;
            },
          },
          () => copyHeldProfileTree(source, destination),
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_snapshot_too_large",
      });
      expect(copyEffects).toBe(0);
    } finally {
      await destination.close();
      await source.close();
      await closeAnchoredProfileRoot(installed.root);
    }
  }, 60_000);

  test.each([
    "held-copy-mkdir",
    "held-copy-create-file",
    "held-copy-write",
    "held-copy-file-parent-sync",
  ])("rejects nested destination parent swaps at %s", async (operationPoint) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const sourceWorking = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const sourcePath = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
      "Default",
      "Nested",
    );
    await mkdir(sourcePath, { recursive: true, mode: 0o700 });
    await writeFile(path.join(sourcePath, "state"), "trusted", { mode: 0o600 });
    const sourceStaging = await sourceWorking.transitionTo("staging");
    const source = await sourceStaging.transitionTo("committed");
    const destination = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_B,
      openMode: "create_exclusive",
    });
    const destinationRoot = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_B,
    );
    const canonicalParent = path.join(destinationRoot, "Default");
    const heldParent = path.join(destinationRoot, ".held-default");
    let pointCount = 0;
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== operationPoint || swapped) return;
            pointCount += 1;
            if (operationPoint === "held-copy-mkdir" && pointCount === 1) return;
            swapped = true;
            await rename(canonicalParent, heldParent);
            await mkdir(path.join(canonicalParent, "Nested"), {
              recursive: true,
              mode: 0o700,
            });
            await writeFile(path.join(canonicalParent, "outside"), "safe");
          },
        },
        () => copyHeldProfileTree(source, destination),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(swapped).toBe(true);
    expect(await readFile(path.join(canonicalParent, "outside"), "utf8")).toBe(
      "safe",
    );
    await rm(canonicalParent, { recursive: true });
    await rename(heldParent, canonicalParent);
    await destination.close();
    await source.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each([
    "held-copy-read",
    "held-copy-write",
    "held-copy-eof",
    "held-copy-source-stat-after-stream",
    "held-copy-file-sync",
    "held-copy-file-parent-sync",
  ])("rejects same-inode source stream drift at %s", async (point) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const sourceWorking = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(sourceWorking, "state", "trusted");
    const source = await (await sourceWorking.transitionTo("staging"))
      .transitionTo("committed");
    const destination = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_B,
      openMode: "create_exclusive",
    });
    const sourceFile = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "committed",
      CHECKPOINT_A,
      "state",
    );
    let changed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(candidate) {
            if (!changed && candidate === point) {
              changed = true;
              await writeFile(sourceFile, "altered", { mode: 0o600 });
            }
          },
        },
        () => copyHeldProfileTree(source, destination),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(changed).toBe(true);
    await destination.close();
    await source.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each(
    (["sync", "copy"] as const).flatMap((operation) =>
      (["mode", "size", "prefix", "truncation", "trailing"] as const).map(
        (drift) => [operation, drift] as const,
      ),
    ),
  )("rejects held %s source %s drift", async (operation, drift) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    let source = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(source, "state", "trusted");
    let destination: Awaited<ReturnType<typeof bindProfileGeneration>> | undefined;
    let state = "working";
    if (operation === "copy") {
      source = await (await source.transitionTo("staging")).transitionTo(
        "committed",
      );
      state = "committed";
      destination = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_B,
        openMode: "create_exclusive",
      });
    }
    const sourceFile = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      state,
      CHECKPOINT_A,
      "state",
    );
    let changed = false;
    const mutate = async (): Promise<void> => {
      if (drift === "mode") await chmod(sourceFile, 0o640);
      else if (drift === "size") await truncate(sourceFile, 8);
      else if (drift === "prefix")
        await writeFile(sourceFile, "Xrusted", { mode: 0o600 });
      else if (drift === "truncation") await truncate(sourceFile, 3);
      else await writeFile(sourceFile, "trusted-tail", { mode: 0o600 });
    };
    try {
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(point) {
              const seam =
                operation === "sync" ? "held-profile-sync" : "held-copy-read";
              if (!changed && point === seam) {
                changed = true;
                await mutate();
              }
            },
          },
          () =>
            operation === "sync"
              ? syncAndCanonicalizeHeldProfileTree(source)
              : copyHeldProfileTree(source, destination!),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(changed).toBe(true);
    } finally {
      await destination?.close().catch(() => undefined);
      await source.close();
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test.each(["depth-65", "file-64mib-plus-1", "tree-256mib-plus-1"] as const)(
    "stops held sync and copy before effect for %s",
    async (shape) => {
      const canonicalRoot = await root();
      const installed = await installedProfileRoot(canonicalRoot);
      let source = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_A,
        openMode: "create_exclusive",
      });
      const generation = path.join(
        canonicalRoot,
        "profiles",
        PROFILE,
        "working",
        CHECKPOINT_A,
      );
      if (shape === "depth-65") {
        let nested = generation;
        for (let depth = 0; depth < 65; depth += 1) {
          nested = path.join(nested, "d");
          await mkdir(nested, { mode: 0o700 });
        }
      } else if (shape === "file-64mib-plus-1") {
        const file = path.join(generation, "oversized");
        await writeFile(file, Buffer.alloc(0), { mode: 0o600 });
        await truncate(file, 64 * 1024 * 1024 + 1);
      } else {
        for (let index = 0; index < 4; index += 1) {
          const file = path.join(generation, `part-${index}`);
          await writeFile(file, Buffer.alloc(0), { mode: 0o600 });
          await truncate(file, 64 * 1024 * 1024);
        }
        await writeFile(path.join(generation, "part-4"), Buffer.from([1]), {
          mode: 0o600,
        });
      }
      let syncEffects = 0;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (point === "held-profile-sync") syncEffects += 1;
            },
          },
          () => syncAndCanonicalizeHeldProfileTree(source),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(syncEffects).toBe(0);

      source = await (await source.transitionTo("staging")).transitionTo(
        "committed",
      );
      const destination = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_B,
        openMode: "create_exclusive",
      });
      let copyEffects = 0;
      try {
        await expect(
          runWithReconciliationFilesystemTestContext(
            {
              beforeCall(point) {
                if (point.startsWith("held-copy-")) copyEffects += 1;
              },
            },
            () => copyHeldProfileTree(source, destination),
          ),
        ).rejects.toMatchObject({
          category: "reconciliation_filesystem_unsafe",
        });
        expect(copyEffects).toBe(0);
      } finally {
        await destination.close();
        await source.close();
        await closeAnchoredProfileRoot(installed.root);
      }
    },
    60_000,
  );

  test("rejects nested parent replacement inside held sync boundary", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const generation = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
    );
    const nested = path.join(generation, "Default", "Nested");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await writeFile(path.join(nested, "state"), "trusted", { mode: 0o600 });
    const held = path.join(generation, ".held-default");
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (!swapped && point === "held-profile-sync") {
              swapped = true;
              await rename(path.join(generation, "Default"), held);
              await mkdir(path.join(generation, "Default", "Nested"), {
                recursive: true,
              });
              await writeFile(path.join(generation, "Default", "outside"), "safe");
            }
          },
        },
        () => syncAndCanonicalizeHeldProfileTree(working),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await readFile(path.join(generation, "Default", "outside"), "utf8"))
      .toBe("safe");
    await rm(path.join(generation, "Default"), { recursive: true });
    await rename(held, path.join(generation, "Default"));
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("validates transition destination binding inside rename boundary", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const profile = path.join(canonicalRoot, "profiles", PROFILE);
    const staging = path.join(profile, "staging");
    const held = path.join(profile, ".held-staging");
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (!swapped && point === "profile-state-transition") {
              swapped = true;
              await rename(staging, held);
              await mkdir(staging, { mode: 0o700 });
              await writeFile(path.join(staging, "outside"), "safe");
            }
          },
        },
        () => working.transitionTo("staging"),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await readFile(path.join(staging, "outside"), "utf8")).toBe("safe");
    await rm(staging, { recursive: true });
    await rename(held, staging);
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("live inventory rejects malformed working deletion tombstones", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    await mkdir(
      path.join(
        canonicalRoot,
        "profiles",
        PROFILE,
        "working",
        ".00000000-0000-0000-0000-000000000000.deleting",
      ),
      { recursive: true },
    );
    await expect(
      listHeldProfileGenerations(installed.root, "working"),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await closeAnchoredProfileRoot(installed.root);
  });

  test("attachment retry observes late context close without recalling it", async () => {
    vi.useFakeTimers();
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    let settleContext!: () => void;
    const contextClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleContext = resolve;
        }),
    );
    const browserClose = vi.fn(async () => {
      throw new Error("browser close failed");
    });
    const context = {
      close: contextClose,
      browser: () => ({ close: browserClose, isConnected: () => true }),
    };
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue(context as never);
    try {
      const attachment = await launchPersistentChromiumForWorking(
        working,
        installed.binding,
        {} as never,
      );
      const first = releaseChromiumSessionAttachment(attachment);
      const firstFailure = expect(first).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await firstFailure;
      settleContext();
      await Promise.resolve();
      await releaseChromiumSessionAttachment(attachment);
      expect(contextClose).toHaveBeenCalledOnce();
      expect(browserClose).toHaveBeenCalledOnce();
      await expect(
        releaseChromiumSessionAttachment(attachment),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    } finally {
      launch.mockRestore();
      vi.useRealTimers();
    }
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("synchronous context close failure uses bounded browser fallback", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    let connected = true;
    const contextClose = vi.fn(() => {
      throw new Error("sync close failure");
    });
    const browserClose = vi.fn(async () => {
      connected = false;
    });
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue({
        close: contextClose,
        browser: () => ({
          close: browserClose,
          isConnected: () => connected,
        }),
      } as never);
    try {
      const attachment = await launchPersistentChromiumForWorking(
        working,
        installed.binding,
        {} as never,
      );
      await releaseChromiumSessionAttachment(attachment);
      expect(contextClose).toHaveBeenCalledOnce();
      expect(browserClose).toHaveBeenCalledOnce();
    } finally {
      launch.mockRestore();
    }
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("context close timeout uses one successful Browser fallback", async () => {
    vi.useFakeTimers();
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const contextClose = vi.fn(() => new Promise<void>(() => undefined));
    let connected = true;
    const browserClose = vi.fn(async () => {
      connected = false;
    });
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue({
        close: contextClose,
        browser: () => ({
          close: browserClose,
          isConnected: () => connected,
        }),
      } as never);
    try {
      const attachment = await launchPersistentChromiumForWorking(
        working,
        installed.binding,
        {} as never,
      );
      const releasing = releaseChromiumSessionAttachment(attachment);
      await vi.advanceTimersByTimeAsync(5_000);
      await releasing;
      expect(contextClose).toHaveBeenCalledOnce();
      expect(browserClose).toHaveBeenCalledOnce();
    } finally {
      launch.mockRestore();
      vi.useRealTimers();
    }
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("retries failed Browser fallback without recalling context close", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const contextClose = vi.fn(async () => {
      throw new Error("context close failed");
    });
    let connected = true;
    const browserClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("browser close failed"))
      .mockImplementationOnce(async () => {
        connected = false;
      });
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue({
        close: contextClose,
        browser: () => ({
          close: browserClose,
          isConnected: () => connected,
        }),
      } as never);
    try {
      const attachment = await launchPersistentChromiumForWorking(
        working,
        installed.binding,
        {} as never,
      );
      await expect(
        releaseChromiumSessionAttachment(attachment),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      await releaseChromiumSessionAttachment(attachment);
      expect(contextClose).toHaveBeenCalledOnce();
      expect(browserClose).toHaveBeenCalledTimes(2);
    } finally {
      launch.mockRestore();
    }
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("retries timed-out Browser fallback without recalling context close", async () => {
    vi.useFakeTimers();
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const contextClose = vi.fn(async () => {
      throw new Error("context close failed");
    });
    let connected = true;
    const browserClose = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(async () => {
        connected = false;
      });
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue({
        close: contextClose,
        browser: () => ({
          close: browserClose,
          isConnected: () => connected,
        }),
      } as never);
    try {
      const attachment = await launchPersistentChromiumForWorking(
        working,
        installed.binding,
        {} as never,
      );
      const first = releaseChromiumSessionAttachment(attachment);
      const firstFailure = expect(first).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await firstFailure;
      await releaseChromiumSessionAttachment(attachment);
      expect(contextClose).toHaveBeenCalledOnce();
      expect(browserClose).toHaveBeenCalledTimes(2);
    } finally {
      launch.mockRestore();
      vi.useRealTimers();
    }
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("accepts already-disconnected Browser after Chromium crash", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const contextClose = vi.fn(async () => {
      throw new Error("Chromium already crashed");
    });
    const browserClose = vi.fn(async () => undefined);
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue({
        close: contextClose,
        browser: () => ({
          close: browserClose,
          isConnected: () => false,
        }),
      } as never);
    try {
      const attachment = await launchPersistentChromiumForWorking(
        working,
        installed.binding,
        {} as never,
      );
      await releaseChromiumSessionAttachment(attachment);
      expect(contextClose).toHaveBeenCalledOnce();
      expect(browserClose).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each(["before", "after"] as const)(
    "aborts Chromium launch at the %s-await admission edge",
    async (edge) => {
      const canonicalRoot = await root();
      const controller = new AbortController();
      const installed = await installedProfileRoot(
        canonicalRoot,
        admission(controller).value,
      );
      const working = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_A,
        openMode: "create_exclusive",
      });
      const contextClose = vi.fn(async () => undefined);
      let aborted = false;
      const launch = vi.spyOn(chromium, "launchPersistentContext");
      if (edge === "after") {
        launch.mockImplementationOnce(async () => {
          aborted = true;
          controller.abort();
          return {
            close: contextClose,
            browser: () => null,
          } as never;
        });
      }
      try {
        await expect(
          runWithReconciliationFilesystemTestContext(
            {
              beforeCall(point) {
                if (!aborted && edge === "before" && point === "verify-procfd-generation") {
                  aborted = true;
                  controller.abort();
                }
              },
            },
            () =>
              launchPersistentChromiumForWorking(
                working,
                installed.binding,
                {} as never,
              ),
          ),
        ).rejects.toMatchObject({ category: "reconciliation_required" });
        expect(aborted).toBe(true);
        expect(launch).toHaveBeenCalledTimes(edge === "after" ? 1 : 0);
        expect(contextClose).toHaveBeenCalledTimes(edge === "after" ? 1 : 0);
      } finally {
        launch.mockRestore();
        await working.close();
        await closeAnchoredProfileRoot(installed.root);
      }
    },
  );

  test("launch uses procfd and rejects canonical generation swap after verify", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const generationPath = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
    );
    const heldPath = `${generationPath}.held`;
    const contextClose = vi.fn(async () => undefined);
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockResolvedValue({
        close: contextClose,
        browser: () => null,
      } as never);
    let swapped = false;
    try {
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async afterCall(point) {
              if (!swapped && point === "verify-procfd-generation") {
                swapped = true;
                await rename(generationPath, heldPath);
                await mkdir(generationPath, { mode: 0o700 });
                await writeFile(path.join(generationPath, "outside"), "safe");
              }
            },
          },
          () =>
            launchPersistentChromiumForWorking(
              working,
              installed.binding,
              {} as never,
            ),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(launch.mock.calls[0]![0]).toMatch(
        new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`, "u"),
      );
      expect(contextClose).toHaveBeenCalledOnce();
      expect(await readFile(path.join(generationPath, "outside"), "utf8")).toBe(
        "safe",
      );
    } finally {
      launch.mockRestore();
      if (swapped) {
        await rm(generationPath, { recursive: true });
        await rename(heldPath, generationPath);
      }
    }
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each(["before-launch", "during-launch"] as const)(
    "real Chromium remains procfd-confined across a %s canonical swap",
    async (swapAt) => {
      const canonicalRoot = await root();
      const installed = await installedProfileRoot(canonicalRoot);
      const working = await bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_A,
        openMode: "create_exclusive",
      });
      const generationPath = path.join(
        canonicalRoot,
        "profiles",
        PROFILE,
        "working",
        CHECKPOINT_A,
      );
      const heldPath = `${generationPath}.held-real`;
      const originalLaunch = chromium.launchPersistentContext.bind(chromium);
      let swapped = false;
      let realContext: Awaited<ReturnType<typeof originalLaunch>> | undefined;
      const swap = async (): Promise<void> => {
        if (swapped) return;
        await rename(generationPath, heldPath);
        await mkdir(generationPath, { mode: 0o700 });
        await writeFile(path.join(generationPath, "outside"), "safe", {
          mode: 0o600,
        });
        swapped = true;
      };
      const launch = vi
        .spyOn(chromium, "launchPersistentContext")
        .mockImplementation(async (userDataDir, options) => {
          const launching = originalLaunch(userDataDir, options);
          if (swapAt === "during-launch") await swap();
          realContext = await launching;
          return realContext;
        });
      try {
        await expect(
          runWithReconciliationFilesystemTestContext(
            {
              async afterCall(point) {
                if (
                  swapAt === "before-launch" &&
                  point === "verify-procfd-generation"
                ) {
                  await swap();
                }
              },
            },
            () =>
              launchPersistentChromiumForWorking(
                working,
                installed.binding,
                {
                  headless: true,
                  acceptDownloads: false,
                  timeout: 15_000,
                },
              ),
          ),
        ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
        expect(launch).toHaveBeenCalledOnce();
        expect(launch.mock.calls[0]![0]).toMatch(
          new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`, "u"),
        );
        expect(swapped).toBe(true);
        expect(await readFile(path.join(generationPath, "outside"), "utf8")).toBe(
          "safe",
        );
        expect(realContext?.browser()?.isConnected() ?? false).toBe(false);
      } finally {
        launch.mockRestore();
        if (swapped) {
          await rm(generationPath, { recursive: true });
          await rename(heldPath, generationPath);
        }
        await working.close().catch(() => undefined);
        await closeAnchoredProfileRoot(installed.root);
      }
    },
    30_000,
  );

  test.each([
    ["state", "unknown", CHECKPOINT_A],
    ["generation", "committed", "not-a-generation"],
  ])("bind rejects unknown profile %s siblings before mutation", async (_kind, state, leaf) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    for (const stateName of ["working", "staging", "committed"]) {
      await mkdir(path.join(canonicalRoot, "profiles", PROFILE, stateName), {
        recursive: true,
        mode: 0o700,
      });
    }
    if (state === "unknown") {
      await mkdir(path.join(canonicalRoot, "profiles", PROFILE, state), {
        mode: 0o700,
      });
    } else {
      await mkdir(path.join(canonicalRoot, "profiles", PROFILE, state, leaf), {
        mode: 0o700,
      });
    }
    await expect(
      bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_B,
        openMode: "create_exclusive",
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(
      await exists(
        path.join(
          canonicalRoot,
          "profiles",
          PROFILE,
          "working",
          CHECKPOINT_B,
        ),
      ),
    ).toBe(false);
    await closeAnchoredProfileRoot(installed.root);
  });

  test("create does not repair an incomplete existing profile namespace", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    await mkdir(path.join(canonicalRoot, "profiles", PROFILE, "working"), {
      recursive: true,
      mode: 0o700,
    });
    await expect(
      bindProfileGeneration(installed.root, {
        profileId: PROFILE,
        state: "working",
        generationId: CHECKPOINT_A,
        openMode: "create_exclusive",
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, "profiles", PROFILE, "staging")))
      .toBe(false);
    await closeAnchoredProfileRoot(installed.root);
  });

  test("create race cannot insert and repair an incomplete target profile", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    let mkdirCount = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "capability-mkdir-exclusive") return;
            mkdirCount += 1;
            if (mkdirCount === 2) {
              await mkdir(
                path.join(canonicalRoot, "profiles", PROFILE, "working"),
                { recursive: true, mode: 0o700 },
              );
            }
          },
        },
        () =>
          bindProfileGeneration(installed.root, {
            profileId: PROFILE,
            state: "working",
            generationId: CHECKPOINT_A,
            openMode: "create_exclusive",
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, "profiles", PROFILE, "staging")))
      .toBe(false);
    expect(
      await exists(
        path.join(
          canonicalRoot,
          "profiles",
          PROFILE,
          "working",
          CHECKPOINT_A,
        ),
      ),
    ).toBe(false);
    await expect(closeAnchoredProfileRoot(installed.root)).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    await rm(path.join(canonicalRoot, "profiles", PROFILE), {
      recursive: true,
    });
    await closeAnchoredProfileRoot(installed.root);
  });

  test("live list rejects malformed sibling state drift", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const unknown = path.join(canonicalRoot, "profiles", PROFILE, "unknown");
    await mkdir(unknown, { mode: 0o700 });
    await expect(
      listHeldProfileGenerations(installed.root, "working"),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await rm(unknown, { recursive: true });
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("held create fails on an absolute-root swap without touching replacement", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const original = `${canonicalRoot}-original`;
    let swapped = false;
    try {
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(point) {
              if (!swapped && point === "capability-mkdir-exclusive") {
                swapped = true;
                await rename(canonicalRoot, original);
                await mkdir(canonicalRoot, { mode: 0o700 });
                await writeFile(path.join(canonicalRoot, "outside"), "safe");
              }
            },
          },
          () =>
            bindProfileGeneration(installed.root, {
              profileId: PROFILE,
              state: "working",
              generationId: CHECKPOINT_A,
              openMode: "create_exclusive",
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(await readFile(path.join(canonicalRoot, "outside"), "utf8")).toBe(
        "safe",
      );
    } finally {
      if (swapped) {
        await rm(canonicalRoot, { recursive: true, force: true });
        await rename(original, canonicalRoot);
      }
      await closeAnchoredProfileRoot(installed.root);
    }
  });
  test("validates all authorities before quarantining old orphan", async () => {
    const canonicalRoot = await root();
    const kept = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const orphan = `replay/owner/scrape/${CHECKPOINT_B}.json`;
    await put(canonicalRoot, kept);
    await put(canonicalRoot, orphan);
    const result = await reconcileBrowserState(
      canonicalRoot,
      request([reference(CHECKPOINT_A, kept)]),
      { admission: admission().value, now: () => NOW },
    );
    expect(result).toMatchObject({
      retained: 1,
      removed: 1,
      missing: 0,
      corrupt: 0,
      ready: true,
    });
    expect(await readFile(path.join(canonicalRoot, kept))).toEqual(STATE_BYTES);
    expect(await exists(path.join(canonicalRoot, orphan))).toBe(false);
  });

  test("retains checkpoint cleanup-intent authority", async () => {
    const canonicalRoot = await root();
    const kept = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, kept);
    const result = await reconcileBrowserState(
      canonicalRoot,
      request([
        reference(
          CHECKPOINT_A,
          kept,
          sha(STATE_BYTES),
          "replay_checkpoint_cleanup_intent",
        ),
      ]),
      { admission: admission().value, now: () => NOW },
    );
    expect(result.retained).toBe(1);
    expect(await readFile(path.join(canonicalRoot, kept))).toEqual(STATE_BYTES);
  });

  test("counts same-checksum authority aliases as one retained path", async () => {
    const canonicalRoot = await root();
    const kept = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, kept);
    const result = await reconcileBrowserState(
      canonicalRoot,
      request([
        reference(CHECKPOINT_A, kept),
        reference(
          CHECKPOINT_B,
          kept,
          sha(STATE_BYTES),
          "replay_checkpoint_cleanup_intent",
        ),
      ]),
      { admission: admission().value, now: () => NOW },
    );
    expect(result.retained).toBe(1);
    expect(await exists(path.join(canonicalRoot, kept))).toBe(true);
  });

  test("validates canonical profile tree authority", async () => {
    const canonicalRoot = await root();
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await ensureProfileStates(canonicalRoot, profileId);
    const generation = `profiles/${profileId}/committed/${PROFILE}`;
    const generationRoot = path.join(canonicalRoot, generation);
    await mkdir(generationRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(generationRoot, "storage-state.json"),
      STATE_BYTES,
      {
        mode: 0o600,
      },
    );
    await utimes(generationRoot, OLD, OLD);
    const treeChecksum = sha(
      JSON.stringify({
        version: 1,
        entries: [
          {
            path: "",
            type: "directory",
            mode: 0o700,
            size: 0,
            sha256: null,
          },
          {
            path: "storage-state.json",
            type: "file",
            mode: 0o600,
            size: STATE_BYTES.byteLength,
            sha256: sha(STATE_BYTES),
          },
        ],
      }),
    );
    const result = await reconcileBrowserState(
      canonicalRoot,
      request([
        reference(PROFILE, generation, treeChecksum, "profile_generation"),
      ]),
      { admission: admission().value, now: () => NOW },
    );
    expect(result).toMatchObject({ retained: 1, removed: 0, ready: true });
    expect(
      await readFile(path.join(generationRoot, "storage-state.json")),
    ).toEqual(STATE_BYTES);
  });

  test("exports exact fixed-key canonical profile tree bytes", async () => {
    const canonicalRoot = await root();
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const generation = `profiles/${profileId}/staging/${PROFILE}`;
    const generationRoot = path.join(canonicalRoot, generation);
    await mkdir(generationRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(generationRoot, "b"), Buffer.from("b"), {
      mode: 0o600,
    });
    await writeFile(path.join(generationRoot, "a"), Buffer.from("a"), {
      mode: 0o600,
    });
    const tree = await canonicalizeProfileTree(
      canonicalRoot,
      generation,
      admission().value,
    );
    const expected = JSON.stringify({
      version: 1,
      entries: [
        {
          path: "",
          type: "directory",
          mode: 0o700,
          size: 0,
          sha256: null,
        },
        {
          path: "a",
          type: "file",
          mode: 0o600,
          size: 1,
          sha256: sha("a"),
        },
        {
          path: "b",
          type: "file",
          mode: 0o600,
          size: 1,
          sha256: sha("b"),
        },
      ],
    });
    expect(tree.canonicalJson).toBe(expected);
    expect(tree.checksum).toBe(sha(expected));
    expect(tree.byteSize).toBe(2);
  });

  test("authenticates and consumes internal reconciliation outcomes once", async () => {
    const canonicalRoot = await root();
    const value = request([]);
    const outcome = await reconcileBrowserStateWithAuthority(
      canonicalRoot,
      value,
      { admission: admission().value, now: () => NOW },
    );
    const binding = {
      processNonce: value.processNonce,
      controlGenerationNonce: value.controlGenerationNonce,
      snapshotDigest: value.snapshotDigest,
    };
    let held: AnchoredProfileRoot | undefined;
    await consumeInternalReconciliationOutcome(
      outcome,
      binding,
      async (install) => {
        expect(install.publicResult).toMatchObject({ ready: true });
        expect(install).not.toHaveProperty("evidence");
        held = install.root;
      },
    );
    await expect(
      consumeInternalReconciliationOutcome(outcome, binding, async () => {}),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await expect(
      consumeInternalReconciliationOutcome(
        {} as never,
        binding,
        async () => {},
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await closeAnchoredProfileRoot(held!);
  });

  test("aggregates consume cleanup failure and retains root close ownership", async () => {
    const canonicalRoot = await root();
    const value = request([]);
    const outcome = await reconcileBrowserStateWithAuthority(
      canonicalRoot,
      value,
      { admission: admission().value, now: () => NOW },
    );
    const binding = {
      processNonce: value.processNonce,
      controlGenerationNonce: value.controlGenerationNonce,
      snapshotDigest: value.snapshotDigest,
    };
    const callbackFailure = new Error("injected consume callback failure");
    const closeFailure = new Error("injected root close failure");
    let injected = false;
    let activeCloses = 0;
    let maximumActiveCloses = 0;
    const closePoints: string[] = [];
    const failure = await runWithReconciliationFilesystemTestContext(
      {
        async closeOperation(point, close) {
          activeCloses += 1;
          maximumActiveCloses = Math.max(
            maximumActiveCloses,
            activeCloses,
          );
          closePoints.push(point);
          try {
            if (!injected && point === "root") {
              injected = true;
              throw closeFailure;
            }
            await close();
          } finally {
            activeCloses -= 1;
          }
        },
      },
      () =>
        consumeInternalReconciliationOutcome(
          outcome,
          binding,
          async () => {
            throw callbackFailure;
          },
        ),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      callbackFailure,
      closeFailure,
    ]);
    expect(maximumActiveCloses).toBe(1);
    expect(closePoints[0]).toBe("root");
    expect(closePoints.slice(1)).toEqual(
      closePoints.slice(1).map((_, index) => `root-chain-${index + 1}`),
    );
    await expect(
      consumeInternalReconciliationOutcome(outcome, binding, async () => {}),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });

    const retryFailure = new Error("injected retained cleanup retry failure");
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async closeOperation(point, close) {
            if (point === "root") throw retryFailure;
            await close();
          },
        },
        () => retryFailedReconciliationOutcomeCleanups(),
      ),
    ).rejects.toBe(retryFailure);

    const retryPoints: string[] = [];
    await runWithReconciliationFilesystemTestContext(
      {
        async closeOperation(point, close) {
          retryPoints.push(point);
          await close();
        },
      },
      () => retryFailedReconciliationOutcomeCleanups(),
    );
    expect(retryPoints[0]).toBe("root");

    let repeatedRetryCloses = 0;
    await runWithReconciliationFilesystemTestContext(
      {
        async closeOperation(_point, close) {
          repeatedRetryCloses += 1;
          await close();
        },
      },
      () => retryFailedReconciliationOutcomeCleanups(),
    );
    expect(repeatedRetryCloses).toBe(0);
  });

  test("public reconciliation delegates through and disposes authority", async () => {
    const canonicalRoot = await root();
    let rootOpens = 0;
    let rootCloses = 0;
    const result = await runWithReconciliationFilesystemTestContext(
      {
        afterCall(point) {
          if (point === "open-root") rootOpens += 1;
        },
        handleClosed(point) {
          if (point === "root") rootCloses += 1;
        },
      },
      () =>
        reconcileBrowserState(canonicalRoot, request([]), {
          admission: admission().value,
          now: () => NOW,
        }),
    );
    expect(Object.keys(result)).toEqual([
      "version",
      "processNonce",
      "controlGenerationNonce",
      "snapshotDigest",
      "retained",
      "removed",
      "missing",
      "corrupt",
      "ready",
    ]);
    expect(rootOpens).toBe(2);
    expect(rootCloses).toBe(2);
  });

  test("uses one held canonical engine for legacy and capability consumers", async () => {
    const canonicalRoot = await root();
    await mkdir(path.join(canonicalRoot, "profiles", PROFILE, "working"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(canonicalRoot, "profiles", PROFILE, "staging"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(canonicalRoot, "profiles", PROFILE, "committed"), {
      recursive: true,
      mode: 0o700,
    });
    const installed = await installedProfileRoot(canonicalRoot);
    const generation = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    expect(generation).not.toHaveProperty("fd");
    expect(generation).not.toHaveProperty("path");
    const held = await canonicalizeHeldProfileTree(generation);
    const synced = await syncAndCanonicalizeHeldProfileTree(generation);
    const legacy = await canonicalizeProfileTree(
      canonicalRoot,
      `profiles/${PROFILE}/working/${CHECKPOINT_A}`,
      admission().value,
    );
    expect(held.canonicalJson).toBe(legacy.canonicalJson);
    expect(synced.checksum).toBe(legacy.checksum);
    await generation.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test("enforces held transition and committed-only copy state rules", async () => {
    const canonicalRoot = await root();
    for (const state of ["working", "staging", "committed"]) {
      await mkdir(path.join(canonicalRoot, "profiles", PROFILE, state), {
        recursive: true,
        mode: 0o700,
      });
    }
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeFile(
      path.join(
        canonicalRoot,
        "profiles",
        PROFILE,
        "working",
        CHECKPOINT_A,
        "Preferences",
      ),
      "state",
      { mode: 0o600 },
    );
    const staging = await working.transitionTo("staging");
    await expect(working.close()).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    const committed = await staging.transitionTo("committed");
    const destination = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_B,
      openMode: "create_exclusive",
    });
    await copyHeldProfileTree(committed, destination);
    expect(await canonicalizeHeldProfileTree(destination)).toMatchObject({
      checksum: (await canonicalizeHeldProfileTree(committed)).checksum,
    });
    await destination.remove();
    await committed.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each([
    "held-remove-file",
    "held-remove-directory",
    "held-remove-generation",
  ])("never deletes a swapped held leaf at %s", async (point) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    const generation = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
    );
    await mkdir(path.join(generation, "Default"), { mode: 0o700 });
    await writeFile(path.join(generation, "Default", "state"), "trusted", {
      mode: 0o600,
    });
    let replacement = "";
    let held = "";
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(candidate) {
            if (candidate !== point || replacement !== "") return;
            const tombstoneRoot = path.join(
              canonicalRoot,
              "profiles",
              PROFILE,
              "working",
              `.${CHECKPOINT_A}.deleting`,
            );
            if (point === "held-remove-file") {
              replacement = path.join(tombstoneRoot, "Default", "state");
            } else if (point === "held-remove-directory") {
              replacement = path.join(tombstoneRoot, "Default");
            } else {
              replacement = tombstoneRoot;
            }
            held = `${replacement}.held`;
            await rename(replacement, held);
            if (point === "held-remove-file") {
              await writeFile(replacement, "safe", { mode: 0o600 });
            } else {
              await mkdir(replacement, { mode: 0o700 });
              await writeFile(path.join(replacement, "outside"), "safe");
            }
          },
        },
        () => working.remove(),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(replacement).not.toBe("");
    expect(
      point === "held-remove-file"
        ? await readFile(replacement, "utf8")
        : await readFile(path.join(replacement, "outside"), "utf8"),
    ).toBe("safe");
    expect(await exists(held)).toBe(true);
    await rm(replacement, { recursive: true, force: true });
    await rename(held, replacement);
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
  });

  test.each([
    "removal-leaf-pin-lstat",
    "removal-leaf-pin-open",
    "removal-leaf-fstat",
  ])("fails closed and releases ownership after %s failure", async (point) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const working = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(working, "state", "trusted");
    let injected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(candidate) {
            if (!injected && candidate === point) {
              injected = true;
              throw new Error(`injected:${point}`);
            }
          },
        },
        () => working.remove(),
      ),
    ).rejects.toBeDefined();
    expect(injected).toBe(true);
    await working.close();
    await closeAnchoredProfileRoot(installed.root);
    const leaked: string[] = [];
    for (const descriptor of await readdir("/proc/self/fd")) {
      try {
        const target = await readlink(`/proc/self/fd/${descriptor}`);
        if (target.includes(canonicalRoot)) leaked.push(target);
      } catch {
        // Descriptor may close while inventory runs.
      }
    }
    expect(leaked).toEqual([]);
  });

  test.each([
    "profile-create-cleanup-remove",
    "profile-create-cleanup-parent-sync",
    "profile-create-cleanup",
  ])("fail-stops admission after unverified create cleanup at %s", async (point) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const descriptorBaseline = (await rootDescriptors(canonicalRoot)).length;
    let primaryInjected = false;
    let cleanupInjected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(candidate) {
            if (
              !primaryInjected &&
              candidate === "profile-stat-created-generation"
            ) {
              primaryInjected = true;
              throw new Error("injected generation acquisition failure");
            }
          },
          beforeCleanup(candidate) {
            if (!cleanupInjected && candidate === point) {
              cleanupInjected = true;
              throw new Error(`injected:${point}`);
            }
          },
          async closeOperation(candidate, close) {
            if (!cleanupInjected && point === "profile-create-cleanup" && candidate === point) {
              cleanupInjected = true;
              throw new Error(`injected:${point}`);
            }
            await close();
          },
        },
        () => bindProfileGeneration(installed.root, {
          profileId: PROFILE,
          state: "working",
          generationId: CHECKPOINT_A,
          openMode: "create_exclusive",
        }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(primaryInjected).toBe(true);
    expect(cleanupInjected).toBe(true);
    expect((await rootDescriptors(canonicalRoot)).length).toBeGreaterThan(
      descriptorBaseline,
    );
    await expect(listHeldProfileGenerations(installed.root, "working"))
      .rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await closeAnchoredProfileRoot(installed.root);
    expect(await rootDescriptors(canonicalRoot)).toEqual([]);
  });

  test.each([
    ["capability-open-created-directory", false],
    ["capability-stat-created-directory", false],
    ["profile-open-created-generation", true],
    ["profile-stat-created-generation", true],
  ] as const)(
    "recovers exclusive mkdir ownership after %s failure",
    async (point, existingNamespace) => {
      const canonicalRoot = await root();
      if (existingNamespace) await ensureProfileStates(canonicalRoot);
      const installed = await installedProfileRoot(canonicalRoot);
      const descriptorBaseline = (await rootDescriptors(canonicalRoot)).length;
      let injected = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall(candidate) {
              if (!injected && candidate === point) {
                injected = true;
                throw new Error(`injected:${point}`);
              }
            },
          },
          () =>
            bindProfileGeneration(installed.root, {
              profileId: PROFILE,
              state: "working",
              generationId: CHECKPOINT_A,
              openMode: "create_exclusive",
            }),
        ),
      ).rejects.toBeDefined();
      expect(injected).toBe(true);
      const createdPath = existingNamespace
        ? path.join(
            canonicalRoot,
            "profiles",
            PROFILE,
            "working",
            CHECKPOINT_A,
          )
        : path.join(canonicalRoot, "profiles");
      expect(await exists(createdPath)).toBe(false);
      expect((await rootDescriptors(canonicalRoot)).length).toBe(
        descriptorBaseline,
      );
      await closeAnchoredProfileRoot(installed.root);
      expect(await rootDescriptors(canonicalRoot)).toEqual([]);
    },
  );

  test("never deletes an attacker leaf when mkdir identity is unverified", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const created = path.join(canonicalRoot, "profiles");
    const displaced = path.join(canonicalRoot, ".created-profiles");
    let identityFailure = false;
    let replaced = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (!identityFailure && point === "capability-lstat-created-directory") {
              identityFailure = true;
              throw new Error("creation identity unavailable");
            }
          },
          async beforeCleanup(point) {
            if (!replaced && point === "profile-create-cleanup-pin-lstat") {
              replaced = true;
              await rename(created, displaced);
              await mkdir(created, { mode: 0o700 });
              await writeFile(path.join(created, "outside"), "safe");
            }
          },
        },
        () =>
          bindProfileGeneration(installed.root, {
            profileId: PROFILE,
            state: "working",
            generationId: CHECKPOINT_A,
            openMode: "create_exclusive",
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(identityFailure).toBe(true);
    expect(replaced).toBe(true);
    await expect(closeAnchoredProfileRoot(installed.root)).rejects.toMatchObject({
      category: "reconciliation_filesystem_unsafe",
    });
    expect(await readFile(path.join(created, "outside"), "utf8")).toBe("safe");
    await rm(created, { recursive: true });
    await rm(displaced, { recursive: true });
    await expect(closeAnchoredProfileRoot(installed.root)).resolves.toBeUndefined();
    expect(await rootDescriptors(canonicalRoot)).toEqual([]);
  });

  test.each([
    "held-copy-open-directory",
    "held-copy-stat-created-directory",
  ])("cleans a copied directory after %s failure", async (failurePoint) => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    const sourceWorking = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await mkdir(
      path.join(
        canonicalRoot,
        "profiles",
        PROFILE,
        "working",
        CHECKPOINT_A,
        "Default",
      ),
      { mode: 0o700 },
    );
    const source = await (await sourceWorking.transitionTo("staging"))
      .transitionTo("committed");
    const destination = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_B,
      openMode: "create_exclusive",
    });
    const copied = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_B,
      "Default",
    );
    let injected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (!injected && point === failurePoint) {
              injected = true;
              throw new Error(`injected:${failurePoint}`);
            }
          },
        },
        () => copyHeldProfileTree(source, destination),
      ),
    ).rejects.toBeDefined();
    expect(injected).toBe(true);
    expect(await exists(copied)).toBe(false);
    await destination.close();
    await source.close();
    await closeAnchoredProfileRoot(installed.root);
    expect(await rootDescriptors(canonicalRoot)).toEqual([]);
  });

  test("retains an exclusive copied file until close retry succeeds", async () => {
    const canonicalRoot = await root();
    const gate = admission();
    const installed = await installedProfileRoot(canonicalRoot, gate.value);
    const descriptorBaseline = (await rootDescriptors(canonicalRoot)).length;
    const sourceWorking = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_A,
      openMode: "create_exclusive",
    });
    await writeHeldProfileFixtureFile(sourceWorking, "state", "trusted");
    const source = await (await sourceWorking.transitionTo("staging"))
      .transitionTo("committed");
    const destination = await bindProfileGeneration(installed.root, {
      profileId: PROFILE,
      state: "working",
      generationId: CHECKPOINT_B,
      openMode: "create_exclusive",
    });
    let postOpenFailure = false;
    let closeRejected = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (!postOpenFailure && point === "held-copy-create-file") {
              postOpenFailure = true;
              throw new Error("post-open failure");
            }
          },
          async closeOperation(point, close) {
            if (!closeRejected && point === "held-copy-output") {
              closeRejected = true;
              throw new Error("underlying close rejected");
            }
            await close();
          },
        },
        () => copyHeldProfileTree(source, destination),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(postOpenFailure).toBe(true);
    expect(closeRejected).toBe(true);
    expect((await rootDescriptors(canonicalRoot)).length).toBeGreaterThan(
      descriptorBaseline,
    );
    await expect(listHeldProfileGenerations(installed.root, "working"))
      .rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    await destination.close();
    await source.close();
    await closeAnchoredProfileRoot(installed.root);
    expect(await rootDescriptors(canonicalRoot)).toEqual([]);
  });

  test("rejects a profile authority file", async () => {
    const canonicalRoot = await root();
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const generation = `profiles/${profileId}/committed/${PROFILE}`;
    await put(canonicalRoot, generation);
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([
          reference(
            PROFILE,
            generation,
            sha(STATE_BYTES),
            "profile_generation",
          ),
        ]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects non-UUID profile namespace before mutation", async () => {
    const canonicalRoot = await root();
    const generation = `profiles/profile-a/committed/${PROFILE}`;
    const generationRoot = path.join(canonicalRoot, generation);
    await mkdir(generationRoot, { recursive: true });
    await writeFile(path.join(generationRoot, "state"), STATE_BYTES);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("one corrupt authority causes zero mutation", async () => {
    const canonicalRoot = await root();
    const kept = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const orphan = `replay/owner/scrape/${CHECKPOINT_B}.json`;
    await put(canonicalRoot, kept, Buffer.from("{}"));
    await put(canonicalRoot, orphan);
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([reference(CHECKPOINT_A, kept)]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_reference_corrupt" });
    expect(await exists(path.join(canonicalRoot, orphan))).toBe(true);
  });

  test("missing authority preserves an old quarantine", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const quarantined = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      relative,
    );
    await put(canonicalRoot, path.relative(canonicalRoot, quarantined));
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([reference(CHECKPOINT_A, relative)]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_reference_missing" });
    expect(await exists(quarantined)).toBe(true);
  });

  test.each([
    "../escape.json",
    "/absolute.json",
    "replay\\owner\\scrape\\file.json",
    "replay/owner/scrape/not-a-uuid.json",
    "profiles/a/working/../escape",
  ])("rejects unsafe or unrecognized authority path %s", async (relative) => {
    const canonicalRoot = await root();
    const unsafe = {
      kind: "replay_checkpoint" as const,
      id: CHECKPOINT_A,
      path: relative,
      checksum: sha(STATE_BYTES),
    };
    const snapshotDigest = canonicalizeReconciliationSnapshot([
      unsafe,
    ]).snapshotDigest;
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        {
          version: 1,
          processNonce: PROCESS,
          controlGenerationNonce: GENERATION,
          snapshotDigest,
          references: [unsafe],
        },
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({
      category: expect.stringMatching(
        /reconciliation_snapshot_invalid|reconciliation_filesystem_unsafe/,
      ),
    });
  });

  test("rejects symlink authority and leaves unrelated orphan unchanged", async () => {
    const canonicalRoot = await root();
    const outside = path.join(canonicalRoot, "outside.json");
    const kept = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const orphan = `replay/owner/scrape/${CHECKPOINT_B}.json`;
    await writeFile(outside, STATE_BYTES);
    await mkdir(path.dirname(path.join(canonicalRoot, kept)), {
      recursive: true,
    });
    await symlink(outside, path.join(canonicalRoot, kept));
    await put(canonicalRoot, orphan);
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([reference(CHECKPOINT_A, kept)]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, orphan))).toBe(true);
  });

  test("rejects a symlinked authority parent before reading outside bytes", async () => {
    const canonicalRoot = await root();
    const externalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(externalRoot, `owner/scrape/${CHECKPOINT_A}.json`);
    await mkdir(path.join(canonicalRoot, "replay"));
    await symlink(
      path.join(externalRoot, "owner"),
      path.join(canonicalRoot, "replay", "owner"),
    );
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([reference(CHECKPOINT_A, relative)]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects hard-linked managed files before mutation", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    await link(
      path.join(canonicalRoot, relative),
      path.join(canonicalRoot, "linked-copy.json"),
    );
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([reference(CHECKPOINT_A, relative)]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects FIFO checkpoint authority before reading", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const target = path.join(canonicalRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await execFileAsync("/usr/bin/mkfifo", [target]);
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([reference(CHECKPOINT_A, relative)]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects Unix socket checkpoint authority", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const target = path.join(canonicalRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, resolve);
    });
    try {
      await expect(
        reconcileBrowserState(
          canonicalRoot,
          request([reference(CHECKPOINT_A, relative)]),
          { admission: admission().value, now: () => NOW },
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  test("rejects oversized checkpoint before reading bytes", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const target = path.join(canonicalRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(0), { mode: 0o600 });
    await truncate(target, 2 * 1024 * 1024 + 1);
    await expect(
      reconcileBrowserState(
        canonicalRoot,
        request([reference(CHECKPOINT_A, relative)]),
        { admission: admission().value, now: () => NOW },
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects profile depth 65 before descending further", async () => {
    const canonicalRoot = await root();
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await ensureProfileStates(canonicalRoot, profileId);
    const generation = `profiles/${profileId}/working/${PROFILE}`;
    let target = path.join(canonicalRoot, generation);
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (let depth = 0; depth < 65; depth += 1) {
      target = path.join(target, `d${depth}`);
      await mkdir(target, { mode: 0o700 });
    }
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects one profile file above 64 MiB before content read", async () => {
    const canonicalRoot = await root();
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const generation = `profiles/${profileId}/working/${PROFILE}`;
    const target = path.join(canonicalRoot, generation, "large");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.alloc(0), { mode: 0o600 });
    await truncate(target, 64 * 1024 * 1024 + 1);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("retains unreferenced entries younger than grace period", async () => {
    const canonicalRoot = await root();
    const young = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, young, STATE_BYTES, false);
    const result = await reconcileBrowserState(canonicalRoot, request([]), {
      admission: admission().value,
      now: () => new Date(),
    });
    expect(result.removed).toBe(0);
    expect(await exists(path.join(canonicalRoot, young))).toBe(true);
  });

  test("uses maximum descendant mtime for profile grace", async () => {
    const canonicalRoot = await root();
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await ensureProfileStates(canonicalRoot, profileId);
    const generation = `profiles/${profileId}/working/${PROFILE}`;
    const generationRoot = path.join(canonicalRoot, generation);
    await mkdir(generationRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(generationRoot, "young"), STATE_BYTES, {
      mode: 0o600,
    });
    await utimes(generationRoot, OLD, OLD);
    const result = await reconcileBrowserState(canonicalRoot, request([]), {
      admission: admission().value,
      now: () => new Date(),
    });
    expect(result.removed).toBe(0);
    expect(await exists(generationRoot)).toBe(true);
  });

  test("fails before mutation on an unknown managed name", async () => {
    const canonicalRoot = await root();
    const orphan = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, orphan);
    await put(canonicalRoot, "replay/owner/scrape/unknown.txt");
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, orphan))).toBe(true);
  });

  test("enforces managed-entry bound before mutation", async () => {
    const canonicalRoot = await root();
    await put(canonicalRoot, `replay/owner/scrape/${CHECKPOINT_A}.json`);
    await put(canonicalRoot, `replay/owner/scrape/${CHECKPOINT_B}.json`);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
        maxManagedEntries: 1,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_snapshot_too_large" });
    expect(
      await exists(
        path.join(canonicalRoot, `replay/owner/scrape/${CHECKPOINT_A}.json`),
      ),
    ).toBe(true);
  });

  test("charges one managed namespace root and refunds EOF and ENOENT", async () => {
    const canonicalRoot = await root();
    await mkdir(path.join(canonicalRoot, "replay"), { mode: 0o700 });
    const streamBufferSizes: number[] = [];
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          directoryStreamOpened(bufferSize) {
            streamBufferSizes.push(bufferSize);
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
            maxManagedEntries: 1,
          }),
      ),
    ).resolves.toMatchObject({ removed: 0, ready: true });
    expect(streamBufferSizes.length).toBeGreaterThan(0);
    expect(streamBufferSizes.every((size) => size <= 32)).toBe(true);
  });

  test("streams profile inventory at the exact shared 25k entry cap", async () => {
    const canonicalRoot = await root();
    const installed = await installedProfileRoot(canonicalRoot);
    await ensureProfileStates(canonicalRoot);
    const working = path.join(canonicalRoot, "profiles", PROFILE, "working");
    const generationId = (index: number) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const count = 24_995;
    for (let offset = 0; offset < count; offset += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, count - offset) }, (_, index) =>
          mkdir(path.join(working, generationId(offset + index)), { mode: 0o700 }),
        ),
      );
    }
    const streamBufferSizes: number[] = [];
    const inventory = await runWithReconciliationFilesystemTestContext(
      {
        directoryStreamOpened(bufferSize) {
          streamBufferSizes.push(bufferSize);
        },
      },
      () => listHeldProfileGenerations(installed.root, "working"),
    );
    expect(inventory).toHaveLength(count);
    expect(streamBufferSizes.length).toBeGreaterThan(0);
    expect(streamBufferSizes.every((size) => size <= 32)).toBe(true);
    await mkdir(path.join(working, generationId(count)), { mode: 0o700 });
    await expect(listHeldProfileGenerations(installed.root, "working"))
      .rejects.toMatchObject({ category: "reconciliation_snapshot_too_large" });
    await closeAnchoredProfileRoot(installed.root);
  }, 30_000);

  test("charges an empty quarantine namespace root once globally", async () => {
    const canonicalRoot = await root();
    await mkdir(path.join(canonicalRoot, "quarantine"), { mode: 0o700 });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
        maxManagedEntries: 1,
      }),
    ).resolves.toMatchObject({ removed: 0, ready: true });
  });

  test("stops full reconciliation before reading namespace root 2", async () => {
    const canonicalRoot = await root();
    await mkdir(path.join(canonicalRoot, "replay"), { mode: 0o700 });
    await mkdir(path.join(canonicalRoot, "profiles"), { mode: 0o700 });
    let reads = 0;
    let yields = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point === "read-directory-entry") reads += 1;
            if (point === "yield-directory-entry") yields += 1;
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
            maxManagedEntries: 1,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_snapshot_too_large" });
    expect(reads).toBe(1);
    expect(yields).toBe(1);
    expect(await exists(path.join(canonicalRoot, "quarantine"))).toBe(false);
  });

  test.each(["before", "after"] as const)(
    "surfaces admission loss %s overflow lookahead",
    async (phase) => {
      const canonicalRoot = await root();
      await mkdir(path.join(canonicalRoot, "replay"), { mode: 0o700 });
      await mkdir(path.join(canonicalRoot, "profiles"), { mode: 0o700 });
      const controller = new AbortController();
      let underlyingReads = 0;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (phase === "before" && point === "read-overflow-lookahead") {
                controller.abort();
              }
            },
            async overflowLookaheadRead(read) {
              underlyingReads += 1;
              const result = await read();
              if (phase === "after") controller.abort();
              return result;
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission(controller).value,
              now: () => NOW,
              maxManagedEntries: 1,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_required" });
      expect(underlyingReads).toBe(phase === "before" ? 0 : 1);
    },
  );

  test("new process resumes an old durable manifest after rename crash", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    await put(canonicalRoot, relative);
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "rename-candidate" && !crashed) {
              crashed = true;
              throw new Error("simulated process crash");
            }
          },
        },
        () =>
          reconcileBrowserState(
            canonicalRoot,
            request([], oldProcess, oldGeneration),
            { admission: admission().value, now: () => NOW },
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const oldDestination = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      relative,
    );
    expect(await exists(oldDestination)).toBe(true);
    const result = await reconcileBrowserState(canonicalRoot, request([]), {
      admission: admission().value,
      now: () => NOW,
    });
    expect(result.removed).toBe(1);
    expect(await exists(oldDestination)).toBe(false);
    expect(
      await exists(
        path.join(
          canonicalRoot,
          "quarantine",
          PROCESS,
          GENERATION,
          "quarantine",
        ),
      ),
    ).toBe(false);
  });

  test("rejects quarantine bytes without a durable manifest", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const destination = `quarantine/${PROCESS}/${GENERATION}/${relative}`;
    await put(canonicalRoot, destination);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, destination))).toBe(true);
  });

  test("publishes durable plan and completion before exact replay", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const reconciliationRequest = request([]);
    const first = await reconcileBrowserState(
      canonicalRoot,
      reconciliationRequest,
      { admission: admission().value, now: () => NOW },
    );
    const planDirectory = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
    );
    expect((await stat(path.join(planDirectory, "plan.json"))).isFile()).toBe(
      true,
    );
    expect((await stat(path.join(planDirectory, "complete"))).isFile()).toBe(
      true,
    );
    await expect(
      reconcileBrowserState(canonicalRoot, reconciliationRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toEqual(first);
  });

  test.each([
    "fsync-plan.tmp",
    "rename-plan.tmp",
    "fsync-plan.json-directory",
    "fsync-plan.json-parent",
    "rename-candidate",
    "fsync-source-parent",
    "fsync-destination-parent-after-rename",
    "delete-candidate",
    "fsync-destination-parent-after-delete",
    "fsync-complete.tmp",
    "rename-complete.tmp",
    "fsync-complete-directory",
    "fsync-complete-parent",
  ])("resumes deterministically after %s crash", async (crashPoint) => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const reconciliationRequest = request([]);
    let failed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === crashPoint && !failed) {
              failed = true;
              throw new Error(`crash:${crashPoint}`);
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    expect(failed).toBe(true);
    await expect(
      reconcileBrowserState(canonicalRoot, reconciliationRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ removed: 1, ready: true });
    expect(await exists(path.join(canonicalRoot, relative))).toBe(false);
  });

  test.each([
    "cleanup-destination-directory",
    "cleanup-destination-directory-parent-fsync",
    "cleanup-plan.json",
    "cleanup-plan.json-parent-fsync",
    "cleanup-plan-digest",
    "cleanup-plan-digest-parent-fsync",
    "cleanup-plans-directory",
    "cleanup-plans-directory-parent-fsync",
    "cleanup-generation",
    "cleanup-generation-parent-fsync",
    "cleanup-process",
    "cleanup-process-parent-fsync",
  ])("resumes old-completion cleanup after %s crash", async (crashPoint) => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    await put(canonicalRoot, relative);
    await reconcileBrowserState(
      canonicalRoot,
      request([], oldProcess, oldGeneration),
      { admission: admission().value, now: () => NOW },
    );
    let failed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === crashPoint && !failed) {
              failed = true;
              throw new Error(`cleanup-crash:${crashPoint}`);
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    expect(failed).toBe(true);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ ready: true });
  });

  test("rejects modified quarantine destination against durable manifest", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const destination = `quarantine/${PROCESS}/${GENERATION}/${relative}`;
    await put(canonicalRoot, relative);
    let failed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "rename-candidate" && !failed) {
              failed = true;
              throw new Error("crash after rename");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    await writeFile(path.join(canonicalRoot, destination), Buffer.from("{}"));
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects modified durable manifest", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const reconciliationRequest = request([]);
    await reconcileBrowserState(canonicalRoot, reconciliationRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    const manifest = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
      "plan.json",
    );
    await writeFile(manifest, Buffer.from("{}"));
    await expect(
      reconcileBrowserState(canonicalRoot, reconciliationRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("rejects a canonical source parent symlink before promotion", async () => {
    const canonicalRoot = await root();
    const outsideRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const sourceParent = path.join(canonicalRoot, "replay", "owner", "scrape");
    const reconciliationRequest = request([]);
    await put(canonicalRoot, relative);
    const sentinel = path.join(outsideRoot, "sentinel");
    await writeFile(sentinel, Buffer.from("outside"));
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (point === "fsync-destination-parent-after-delete" && !swapped) {
              swapped = true;
              await rename(sourceParent, `${sourceParent}-held`);
              await symlink(outsideRoot, sourceParent);
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(swapped).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("outside");
    expect(await exists(path.join(outsideRoot, `${CHECKPOINT_A}.json`))).toBe(
      false,
    );
    expect(
      await exists(
        path.join(
          canonicalRoot,
          "quarantine",
          PROCESS,
          GENERATION,
          ".plans",
          reconciliationRequest.snapshotDigest,
          "complete",
        ),
      ),
    ).toBe(false);
  });

  test("rejects a replaced canonical source parent before promotion", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const sourceParent = path.join(canonicalRoot, "replay", "owner", "scrape");
    const attackerBytes = Buffer.from('{"attacker":true}', "utf8");
    const reconciliationRequest = request([]);
    await put(canonicalRoot, relative);
    let replaced = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (
              point === "fsync-destination-parent-after-delete" &&
              !replaced
            ) {
              replaced = true;
              await rename(sourceParent, `${sourceParent}-held`);
              await mkdir(sourceParent, { recursive: true, mode: 0o700 });
              await writeFile(
                path.join(sourceParent, `${CHECKPOINT_A}.json`),
                attackerBytes,
                { mode: 0o600 },
              );
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(replaced).toBe(true);
    expect(await readFile(path.join(canonicalRoot, relative))).toEqual(
      attackerBytes,
    );
    expect(
      await exists(
        path.join(
          canonicalRoot,
          "quarantine",
          PROCESS,
          GENERATION,
          ".plans",
          reconciliationRequest.snapshotDigest,
          "complete",
        ),
      ),
    ).toBe(false);
  });

  test("rejects a missing canonical source parent before promotion", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const sourceParent = path.join(canonicalRoot, "replay", "owner", "scrape");
    const heldParent = `${sourceParent}-held`;
    const reconciliationRequest = request([]);
    await put(canonicalRoot, relative);
    let removed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (point === "fsync-destination-parent-after-delete" && !removed) {
              removed = true;
              await rename(sourceParent, heldParent);
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(removed).toBe(true);
    expect(await readdir(heldParent)).toEqual([]);
    expect(
      await exists(
        path.join(
          canonicalRoot,
          "quarantine",
          PROCESS,
          GENERATION,
          ".plans",
          reconciliationRequest.snapshotDigest,
          "complete",
        ),
      ),
    ).toBe(false);
  });

  test("rejects a source leaf swap at the rename boundary", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const target = path.join(canonicalRoot, relative);
    const held = `${target}.held`;
    await put(canonicalRoot, relative);
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "rename-candidate" || swapped) return;
            swapped = true;
            await rename(target, held);
            await put(canonicalRoot, relative, Buffer.from("{}"));
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(held)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  test("rejects same-inode source overwrite at the rename boundary", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const target = path.join(canonicalRoot, relative);
    await put(canonicalRoot, relative);
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point === "rename-candidate") {
              await writeFile(target, Buffer.from("{}"), { mode: 0o600 });
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(target)).toBe(true);
  });

  test("rejects a destination leaf swap at the delete boundary", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const destination = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      relative,
    );
    const held = `${destination}.held`;
    await put(canonicalRoot, relative);
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "delete-candidate" || swapped) return;
            swapped = true;
            await rename(destination, held);
            await writeFile(destination, Buffer.from("{}"), { mode: 0o600 });
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(held)).toBe(true);
    expect(await exists(destination)).toBe(true);
  });

  test("rejects same-inode destination overwrite at the delete boundary", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const destination = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      relative,
    );
    await put(canonicalRoot, relative);
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point === "delete-candidate") {
              await writeFile(destination, Buffer.from("{}"), { mode: 0o600 });
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(destination)).toBe(true);
  });

  test.each(["rename-candidate", "delete-candidate"])(
    "revalidates profile descendants at the %s boundary",
    async (boundary) => {
      const canonicalRoot = await root();
      await ensureProfileStates(canonicalRoot);
      const relative = `profiles/${PROFILE}/working/${CHECKPOINT_A}`;
      const generation = path.join(canonicalRoot, relative);
      const descendant = path.join(generation, "state.json");
      await mkdir(generation, { recursive: true, mode: 0o700 });
      await writeFile(descendant, STATE_BYTES, { mode: 0o600 });
      await utimes(descendant, OLD, OLD);
      await utimes(generation, OLD, OLD);
      let changed = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(point) {
              if (point !== boundary || changed) return;
              changed = true;
              const target =
                boundary === "rename-candidate"
                  ? descendant
                  : path.join(
                      canonicalRoot,
                      "quarantine",
                      PROCESS,
                      GENERATION,
                      relative,
                      "state.json",
                    );
              await writeFile(target, Buffer.from("{}"), { mode: 0o600 });
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      if (boundary === "rename-candidate") {
        expect(await exists(generation)).toBe(true);
      } else {
        expect(
          await exists(
            path.join(
              canonicalRoot,
              "quarantine",
              PROCESS,
              GENERATION,
              relative,
            ),
          ),
        ).toBe(true);
      }
    },
  );

  test("rejects an authority leaf swap after opened-inode validation", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const target = path.join(canonicalRoot, relative);
    const held = `${target}.held`;
    await put(canonicalRoot, relative);
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (point !== "file-stat-after-read" || swapped) return;
            swapped = true;
            await rename(target, held);
            await put(canonicalRoot, relative, STATE_BYTES);
          },
        },
        () =>
          reconcileBrowserState(
            canonicalRoot,
            request([reference(CHECKPOINT_A, relative)]),
            { admission: admission().value, now: () => NOW },
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(held)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  test("rejects profile-authority root replacement during held hashing", async () => {
    const canonicalRoot = await root();
    await ensureProfileStates(canonicalRoot);
    const outsideRoot = await root();
    const relative = `profiles/${PROFILE}/working/${CHECKPOINT_A}`;
    const generation = path.join(canonicalRoot, relative);
    const held = path.join(outsideRoot, "held-generation");
    await mkdir(generation, { recursive: true, mode: 0o700 });
    await writeFile(path.join(generation, "state.json"), STATE_BYTES, {
      mode: 0o600,
    });
    const tree = await canonicalizeProfileTree(
      canonicalRoot,
      relative,
      admission().value,
    );
    let replaced = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (point !== "profile-directory-stat" || replaced) return;
            replaced = true;
            await rename(generation, held);
            await mkdir(generation, { mode: 0o700 });
            await writeFile(path.join(generation, "state.json"), STATE_BYTES, {
              mode: 0o600,
            });
          },
        },
        () =>
          reconcileBrowserState(
            canonicalRoot,
            request([
              reference(PROFILE, relative, tree.checksum, "profile_generation"),
            ]),
            { admission: admission().value, now: () => NOW },
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(held)).toBe(true);
    expect(await exists(generation)).toBe(true);
  });

  test("revalidates profile-authority content after the last tree-stat hook", async () => {
    const canonicalRoot = await root();
    await ensureProfileStates(canonicalRoot);
    const relative = `profiles/${PROFILE}/working/${CHECKPOINT_A}`;
    const generation = path.join(canonicalRoot, relative);
    const descendant = path.join(generation, "state.json");
    await mkdir(generation, { recursive: true, mode: 0o700 });
    await writeFile(descendant, STATE_BYTES, { mode: 0o600 });
    const tree = await canonicalizeProfileTree(
      canonicalRoot,
      relative,
      admission().value,
    );
    let changed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (point !== "profile-directory-stat-after" || changed) return;
            changed = true;
            await writeFile(descendant, Buffer.from("{}"), { mode: 0o600 });
          },
        },
        () =>
          reconcileBrowserState(
            canonicalRoot,
            request([
              reference(PROFILE, relative, tree.checksum, "profile_generation"),
            ]),
            { admission: admission().value, now: () => NOW },
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(generation)).toBe(true);
  });

  test.each([
    "profile-evidence-lstat",
    "profile-evidence-read",
    "profile-evidence-final-stat",
  ] as const)(
    "stops profile authority after admission loss at %s",
    async (abortPoint) => {
      const canonicalRoot = await root();
      await ensureProfileStates(canonicalRoot);
      const relative = `profiles/${PROFILE}/working/${CHECKPOINT_A}`;
      const generation = path.join(canonicalRoot, relative);
      await mkdir(generation, { recursive: true, mode: 0o700 });
      await writeFile(path.join(generation, "state.json"), STATE_BYTES, {
        mode: 0o600,
      });
      const tree = await canonicalizeProfileTree(
        canonicalRoot,
        relative,
        admission().value,
      );
      const controller = new AbortController();
      let aborted = false;
      let callsAfterAbort = 0;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall() {
              if (aborted) callsAfterAbort += 1;
            },
            afterCall(point) {
              if (point === abortPoint && !aborted) {
                aborted = true;
                controller.abort();
              }
            },
          },
          () =>
            reconcileBrowserState(
              canonicalRoot,
              request([
                reference(
                  PROFILE,
                  relative,
                  tree.checksum,
                  "profile_generation",
                ),
              ]),
              { admission: admission(controller).value, now: () => NOW },
            ),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_required" });
      expect(aborted).toBe(true);
      expect(callsAfterAbort).toBe(0);
      expect(await exists(generation)).toBe(true);
    },
  );

  test.each(["rename-candidate", "delete-candidate"] as const)(
    "stops %s after final profile-evidence admission loss",
    async (boundary) => {
      const canonicalRoot = await root();
      await ensureProfileStates(canonicalRoot);
      const relative = `profiles/${PROFILE}/working/${CHECKPOINT_A}`;
      const generation = path.join(canonicalRoot, relative);
      const descendant = path.join(generation, "state.json");
      await mkdir(generation, { recursive: true, mode: 0o700 });
      await writeFile(descendant, STATE_BYTES, { mode: 0o600 });
      await utimes(descendant, OLD, OLD);
      await utimes(generation, OLD, OLD);
      const controller = new AbortController();
      let atBoundary = false;
      let aborted = false;
      let callsAfterAbort = 0;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (aborted) callsAfterAbort += 1;
              if (point === boundary) atBoundary = true;
            },
            afterCall(point) {
              if (
                point === "profile-evidence-final-stat" &&
                atBoundary &&
                !aborted
              ) {
                aborted = true;
                controller.abort();
              }
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission(controller).value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_required" });
      expect(aborted).toBe(true);
      expect(callsAfterAbort).toBe(0);
      const destination = path.join(
        canonicalRoot,
        "quarantine",
        PROCESS,
        GENERATION,
        relative,
      );
      expect(
        await exists(
          boundary === "rename-candidate" ? generation : destination,
        ),
      ).toBe(true);
    },
  );

  test.each(["rename-candidate", "delete-candidate"] as const)(
    "revalidates profile content after the last tree-stat hook before %s",
    async (boundary) => {
      const canonicalRoot = await root();
      await ensureProfileStates(canonicalRoot);
      const relative = `profiles/${PROFILE}/working/${CHECKPOINT_A}`;
      const generation = path.join(canonicalRoot, relative);
      await mkdir(generation, { recursive: true, mode: 0o700 });
      const descendant = path.join(generation, "state.json");
      await writeFile(descendant, STATE_BYTES, {
        mode: 0o600,
      });
      await utimes(descendant, OLD, OLD);
      await utimes(generation, OLD, OLD);
      let atBoundary = false;
      let changed = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (point === boundary) atBoundary = true;
            },
            async afterCall(point) {
              if (
                point !== "profile-directory-stat-after" ||
                !atBoundary ||
                changed
              )
                return;
              changed = true;
              const rootPath =
                boundary === "rename-candidate"
                  ? generation
                  : path.join(
                      canonicalRoot,
                      "quarantine",
                      PROCESS,
                      GENERATION,
                      relative,
                    );
              await writeFile(
                path.join(rootPath, "state.json"),
                Buffer.from("{}"),
                {
                  mode: 0o600,
                },
              );
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(changed).toBe(true);
      const expectedRoot =
        boundary === "rename-candidate"
          ? generation
          : path.join(
              canonicalRoot,
              "quarantine",
              PROCESS,
              GENERATION,
              relative,
            );
      expect(await exists(expectedRoot)).toBe(true);
    },
  );

  test("rejects directory replacement during held-parent identity validation", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    let fileOpens = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "open-file" || ++fileOpens !== 2) return;
            await rename(
              path.join(canonicalRoot, "replay"),
              path.join(canonicalRoot, "replay-held"),
            );
            await put(canonicalRoot, relative, Buffer.from("{}"));
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(
      await exists(path.join(canonicalRoot, "replay-held", relative.slice(7))),
    ).toBe(true);
    expect(await exists(path.join(canonicalRoot, relative))).toBe(true);
  });

  test("rejects a missing recorded destination parent during recovery", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "delete-candidate" && !crashed) {
              crashed = true;
              throw new Error("crash after delete");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    await rm(
      path.join(canonicalRoot, "quarantine", PROCESS, GENERATION, "replay"),
      { recursive: true },
    );
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("validates every pending phase before mutating the first entry", async () => {
    const canonicalRoot = await root();
    const first = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const second = `replay/owner/scrape/${CHECKPOINT_B}.json`;
    const reconciliationRequest = request([]);
    await put(canonicalRoot, first);
    await put(canonicalRoot, second);
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "fsync-plan.json-parent" && !crashed) {
              crashed = true;
              throw new Error("stop after plan publication");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const manifestPath = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
      "plan.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ sourceParent: { ino: string } }>;
    };
    manifest.entries[1]!.sourceParent.ino = "0";
    await writeFile(manifestPath, Buffer.from(JSON.stringify(manifest)), {
      mode: 0o600,
    });
    let mutations = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point === "rename-candidate" || point === "delete-candidate") {
              mutations += 1;
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(mutations).toBe(0);
    expect(await exists(path.join(canonicalRoot, first))).toBe(true);
    expect(await exists(path.join(canonicalRoot, second))).toBe(true);
  });

  test("repairs both recorded parents after a post-delete crash", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "delete-candidate" && !crashed) {
              crashed = true;
              throw new Error("crash after delete");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const calls: string[] = [];
    await runWithReconciliationFilesystemTestContext(
      { beforeCall: (point) => void calls.push(point) },
      () =>
        reconcileBrowserState(canonicalRoot, request([]), {
          admission: admission().value,
          now: () => NOW,
        }),
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        "repair-source-parent-fsync",
        "repair-destination-parent-fsync",
      ]),
    );
  });

  test("rejects canonical completion records with forged counts", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const reconciliationRequest = request([]);
    await put(canonicalRoot, relative);
    await reconcileBrowserState(canonicalRoot, reconciliationRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    const directory = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
    );
    const completion = JSON.parse(
      await readFile(path.join(directory, "complete"), "utf8"),
    ) as Record<string, unknown>;
    completion.retained = 123;
    completion.removed = 456;
    await writeFile(
      path.join(directory, "complete"),
      Buffer.from(JSON.stringify(completion)),
      { mode: 0o600 },
    );
    await expect(
      reconcileBrowserState(canonicalRoot, reconciliationRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test.each(["plan", "complete"])(
    "fsyncs recovered %s.tmp before promotion",
    async (record) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      await put(canonicalRoot, relative);
      const crashPoint = `write-${record}.tmp`;
      let crashed = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            afterCall(point) {
              if (point === crashPoint && !crashed) {
                crashed = true;
                throw new Error(`crash:${crashPoint}`);
              }
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
      const calls: string[] = [];
      await runWithReconciliationFilesystemTestContext(
        { beforeCall: (point) => void calls.push(point) },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      );
      expect(calls.indexOf(`fsync-${record}.tmp`)).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf(`fsync-${record}.tmp`)).toBeLessThan(
        calls.indexOf(`rename-${record}.tmp`),
      );
    },
  );

  test("treats complete.tmp as completed phase without suffix privilege", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const oldRequest = request([], oldProcess, oldGeneration);
    await put(canonicalRoot, relative);
    await reconcileBrowserState(canonicalRoot, oldRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    const planDirectory = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      oldRequest.snapshotDigest,
    );
    await rename(
      path.join(planDirectory, "complete"),
      path.join(planDirectory, "complete.tmp"),
    );
    await put(canonicalRoot, relative, STATE_BYTES, false);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, relative))).toBe(true);
    expect(await exists(path.join(planDirectory, "complete.tmp"))).toBe(true);
  });

  test("revalidates completed absence at the complete.tmp promotion boundary", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const oldRequest = request([], oldProcess, oldGeneration);
    await put(canonicalRoot, relative);
    await reconcileBrowserState(canonicalRoot, oldRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    const planDirectory = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      oldRequest.snapshotDigest,
    );
    await rename(
      path.join(planDirectory, "complete"),
      path.join(planDirectory, "complete.tmp"),
    );
    let recreated = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "rename-complete.tmp" || recreated) return;
            recreated = true;
            await put(canonicalRoot, relative, STATE_BYTES, false);
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, relative))).toBe(true);
    expect(await exists(path.join(planDirectory, "complete.tmp"))).toBe(true);
    expect(await exists(path.join(planDirectory, "complete"))).toBe(false);
    expect(await exists(path.join(planDirectory, "plan.json"))).toBe(true);
  });

  test.each(["source", "destination"] as const)(
    "revalidates fresh completion %s absence at promotion",
    async (recreatedLeaf) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const destination = `quarantine/${PROCESS}/${GENERATION}/${relative}`;
      const reconciliationRequest = request([]);
      await put(canonicalRoot, relative);
      let recreated = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(point) {
              if (point !== "rename-complete.tmp" || recreated) return;
              recreated = true;
              await put(
                canonicalRoot,
                recreatedLeaf === "source" ? relative : destination,
                STATE_BYTES,
                false,
              );
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, reconciliationRequest, {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      const planDirectory = path.join(
        canonicalRoot,
        "quarantine",
        PROCESS,
        GENERATION,
        ".plans",
        reconciliationRequest.snapshotDigest,
      );
      expect(
        await exists(
          path.join(
            canonicalRoot,
            recreatedLeaf === "source" ? relative : destination,
          ),
        ),
      ).toBe(true);
      expect(await exists(path.join(planDirectory, "complete.tmp"))).toBe(true);
      expect(await exists(path.join(planDirectory, "complete"))).toBe(false);
      expect(await exists(path.join(planDirectory, "plan.json"))).toBe(true);
    },
  );

  test("repairs mkdir parent durability before publishing a plan", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "mkdir" && !crashed) {
              crashed = true;
              throw new Error("crash after mkdir");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const calls: string[] = [];
    await runWithReconciliationFilesystemTestContext(
      { beforeCall: (point) => void calls.push(point) },
      () =>
        reconcileBrowserState(canonicalRoot, request([]), {
          admission: admission().value,
          now: () => NOW,
        }),
    );
    expect(calls).toContain("repair-mkdir-parent");
    expect(calls.indexOf("repair-mkdir-parent")).toBeLessThan(
      calls.indexOf("create-plan.tmp"),
    );
  });

  test("resumes an exact empty current destination skeleton", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    let skeletons = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "fsync-skeleton" && ++skeletons === 2) {
              throw new Error("stop after destination skeleton");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ removed: 1, ready: true });
  });

  test("cleans one canonical final completion-only skeleton", async () => {
    const canonicalRoot = await root();
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const digest = "f".repeat(64);
    const directory = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      digest,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "complete"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          manifestSha256: "a".repeat(64),
          retained: 0,
          removed: 0,
        }),
      ),
      { mode: 0o600 },
    );
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ removed: 0, ready: true });
    expect(await exists(directory)).toBe(false);
  });

  test.each(["second completion", "empty digest"])(
    "rejects a completion-only generation with an unauthorized %s sibling",
    async (siblingKind) => {
      const canonicalRoot = await root();
      const oldProcess = Buffer.alloc(32, 9).toString("base64url");
      const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
      const plans = path.join(
        canonicalRoot,
        "quarantine",
        oldProcess,
        oldGeneration,
        ".plans",
      );
      const first = path.join(plans, "a".repeat(64));
      const sibling = path.join(plans, "b".repeat(64));
      const completion = Buffer.from(
        JSON.stringify({
          version: 1,
          manifestSha256: "c".repeat(64),
          retained: 0,
          removed: 0,
        }),
      );
      await mkdir(first, { recursive: true, mode: 0o700 });
      await writeFile(path.join(first, "complete"), completion, {
        mode: 0o600,
      });
      await mkdir(sibling, { recursive: true, mode: 0o700 });
      if (siblingKind === "second completion") {
        await writeFile(path.join(sibling, "complete"), completion, {
          mode: 0o600,
        });
      }
      await expect(
        reconcileBrowserState(canonicalRoot, request([]), {
          admission: admission().value,
          now: () => NOW,
        }),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(await exists(first)).toBe(true);
      expect(await exists(sibling)).toBe(true);
    },
  );

  test("rejects an empty quarantine hierarchy beside completion-only state", async () => {
    const canonicalRoot = await root();
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const generation = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
    );
    const directory = path.join(generation, ".plans", "f".repeat(64));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "complete"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          manifestSha256: "a".repeat(64),
          retained: 0,
          removed: 0,
        }),
      ),
      { mode: 0o600 },
    );
    await mkdir(path.join(generation, "replay", "owner", "scrape"), {
      recursive: true,
      mode: 0o700,
    });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(directory)).toBe(true);
  });

  test("rejects current-tuple completion-only state before plan publication", async () => {
    const canonicalRoot = await root();
    const reconciliationRequest = request([]);
    const directory = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "complete"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          manifestSha256: "a".repeat(64),
          retained: 0,
          removed: 0,
        }),
      ),
      { mode: 0o600 },
    );
    await expect(
      reconcileBrowserState(canonicalRoot, reconciliationRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(directory, "plan.json"))).toBe(false);
    expect(await exists(path.join(directory, "complete"))).toBe(true);
  });

  test("rejects a manifestless temporary completion marker", async () => {
    const canonicalRoot = await root();
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const directory = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      "f".repeat(64),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "complete.tmp"),
      Buffer.from(
        JSON.stringify({
          version: 1,
          manifestSha256: "a".repeat(64),
          retained: 0,
          removed: 0,
        }),
      ),
      { mode: 0o600 },
    );
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(directory, "complete.tmp"))).toBe(true);
  });

  test("validates every quarantine sibling before cleaning old skeletons", async () => {
    const canonicalRoot = await root();
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const emptyDigest = "e".repeat(64);
    const empty = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      emptyDigest,
    );
    await mkdir(empty, { recursive: true, mode: 0o700 });
    await mkdir(path.join(canonicalRoot, "quarantine", "invalid-sibling"), {
      recursive: true,
    });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(empty)).toBe(true);
  });

  test("rejects a lone unauthorized old empty plan skeleton", async () => {
    const canonicalRoot = await root();
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const empty = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      "e".repeat(64),
    );
    await mkdir(empty, { recursive: true, mode: 0o700 });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(empty)).toBe(true);
  });

  test("rejects chmod after the final managed-file read", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const target = path.join(canonicalRoot, relative);
    await put(canonicalRoot, relative);
    let changed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async afterCall(point) {
            if (point === "read-file" && !changed) {
              changed = true;
              await chmod(target, 0o640);
            }
          },
        },
        () =>
          reconcileBrowserState(
            canonicalRoot,
            request([reference(CHECKPOINT_A, relative)]),
            { admission: admission().value, now: () => NOW },
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
  });

  test("same-process new generation preserves old completion counts", async () => {
    const canonicalRoot = await root();
    const first = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const second = `replay/owner/scrape/${CHECKPOINT_B}.json`;
    const generationA = Buffer.alloc(32, 10).toString("base64url");
    const generationB = Buffer.alloc(32, 11).toString("base64url");
    await put(canonicalRoot, first);
    let renamed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "rename-candidate" && !renamed) {
              renamed = true;
              throw new Error("first crash");
            }
          },
        },
        () =>
          reconcileBrowserState(
            canonicalRoot,
            request([], PROCESS, generationA),
            { admission: admission().value, now: () => NOW },
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    await put(canonicalRoot, second);
    const currentRequest = request([], PROCESS, generationB);
    let completedOld = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "fsync-complete-parent" && !completedOld) {
              completedOld = true;
              throw new Error("crash after old completion");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, currentRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const firstResult = await reconcileBrowserState(
      canonicalRoot,
      currentRequest,
      { admission: admission().value, now: () => NOW },
    );
    const replay = await reconcileBrowserState(canonicalRoot, currentRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    expect(firstResult.removed).toBe(2);
    expect(replay).toEqual(firstResult);
  });

  test("publishes a 25,000-entry combined workset and rejects entry 25,001", async () => {
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");

    const exactRoot = await root();
    await installPendingPlan(exactRoot, 24_999, oldProcess, oldGeneration);
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(exactRoot, relative);
    const exactRequest = request([]);
    let published = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "fsync-plan.json-parent" && !published) {
              published = true;
              throw new Error("stop after exact-bound publication");
            }
          },
        },
        () =>
          reconcileBrowserState(exactRoot, exactRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const exactPlan = JSON.parse(
      await readFile(
        path.join(
          exactRoot,
          "quarantine",
          PROCESS,
          GENERATION,
          ".plans",
          exactRequest.snapshotDigest,
          "plan.json",
        ),
        "utf8",
      ),
    ) as { removed: number; entries: Array<{ sourcePath: string }> };
    expect(exactPlan.removed).toBe(25_000);
    expect(exactPlan.entries.map((entry) => entry.sourcePath)).toEqual([
      relative,
    ]);

    const excessRoot = await root();
    await installPendingPlan(excessRoot, 25_000, oldProcess, oldGeneration);
    await put(excessRoot, relative);
    const excessRequest = request([]);
    await expect(
      reconcileBrowserState(excessRoot, excessRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_snapshot_too_large" });
    expect(
      await exists(
        path.join(
          excessRoot,
          "quarantine",
          PROCESS,
          GENERATION,
          ".plans",
          excessRequest.snapshotDigest,
          "plan.json",
        ),
      ),
    ).toBe(false);
  }, 120_000);

  test("completed history contributes zero to a fresh generation", async () => {
    const canonicalRoot = await root();
    const first = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const second = `replay/owner/scrape/${CHECKPOINT_B}.json`;
    const generationA = Buffer.alloc(32, 10).toString("base64url");
    const generationB = Buffer.alloc(32, 11).toString("base64url");
    await put(canonicalRoot, first);
    await reconcileBrowserState(
      canonicalRoot,
      request([], PROCESS, generationA),
      { admission: admission().value, now: () => NOW },
    );
    await put(canonicalRoot, second);
    const currentRequest = request([], PROCESS, generationB);
    const result = await reconcileBrowserState(canonicalRoot, currentRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    expect(result.removed).toBe(1);
    const plan = JSON.parse(
      await readFile(
        path.join(
          canonicalRoot,
          "quarantine",
          PROCESS,
          generationB,
          ".plans",
          currentRequest.snapshotDigest,
          "plan.json",
        ),
        "utf8",
      ),
    ) as { removed: number; entries: Array<{ sourcePath: string }> };
    expect(plan.removed).toBe(1);
    expect(plan.entries.map((entry) => entry.sourcePath)).toEqual([second]);
  });

  test("fresh empty generation after completed history reports zero", async () => {
    const canonicalRoot = await root();
    const first = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const generationA = Buffer.alloc(32, 10).toString("base64url");
    const generationB = Buffer.alloc(32, 11).toString("base64url");
    await put(canonicalRoot, first);
    await reconcileBrowserState(
      canonicalRoot,
      request([], PROCESS, generationA),
      { admission: admission().value, now: () => NOW },
    );
    await expect(
      reconcileBrowserState(canonicalRoot, request([], PROCESS, generationB), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ removed: 0, ready: true });
  });

  test("rejects a recreated source until its completed plan is cleaned", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const generationA = Buffer.alloc(32, 10).toString("base64url");
    const generationB = Buffer.alloc(32, 11).toString("base64url");
    await put(canonicalRoot, relative);
    await reconcileBrowserState(
      canonicalRoot,
      request([], PROCESS, generationA),
      { admission: admission().value, now: () => NOW },
    );
    await put(canonicalRoot, relative);
    const currentRequest = request([], PROCESS, generationB);
    await expect(
      reconcileBrowserState(canonicalRoot, currentRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(canonicalRoot, relative))).toBe(true);

    await rm(path.join(canonicalRoot, relative));
    await reconcileBrowserState(canonicalRoot, currentRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    await put(canonicalRoot, relative);
    const generationC = Buffer.alloc(32, 12).toString("base64url");
    await expect(
      reconcileBrowserState(canonicalRoot, request([], PROCESS, generationC), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ removed: 1, ready: true });
    expect(await exists(path.join(canonicalRoot, relative))).toBe(false);
  });

  test("rejects a destination leaf restored under a completed plan", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    await put(canonicalRoot, relative);
    await reconcileBrowserState(
      canonicalRoot,
      request([], oldProcess, oldGeneration),
      { admission: admission().value, now: () => NOW },
    );
    const destination = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      relative,
    );
    await put(canonicalRoot, path.relative(canonicalRoot, destination));
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(destination)).toBe(true);
  });

  test("never creates cleanup-copy records during completed cleanup", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const oldRequest = request([], oldProcess, oldGeneration);
    await put(canonicalRoot, relative);
    await reconcileBrowserState(canonicalRoot, oldRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "cleanup-destination-directory" && !crashed) {
              crashed = true;
              throw new Error("crash after destination directory removal");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const planDirectory = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      oldRequest.snapshotDigest,
    );
    expect((await readdir(planDirectory)).sort()).toEqual([
      "complete",
      "plan.json",
    ]);
    const currentRequest = request([]);
    await expect(
      reconcileBrowserState(canonicalRoot, currentRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ ready: true });
    await expect(
      reconcileBrowserState(canonicalRoot, currentRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ ready: true });
    expect(
      await exists(path.join(canonicalRoot, "quarantine", oldProcess)),
    ).toBe(false);
  });

  test("rejects destination-parent replacement during completed cleanup", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const oldRequest = request([], oldProcess, oldGeneration);
    await put(canonicalRoot, relative);
    await reconcileBrowserState(canonicalRoot, oldRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    const destinationParent = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      "replay",
      "owner",
      "scrape",
    );
    const held = `${destinationParent}-held`;
    let replaced = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "cleanup-destination-directory" || replaced) return;
            replaced = true;
            await rename(destinationParent, held);
            await mkdir(destinationParent, { mode: 0o700 });
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(held)).toBe(true);
    expect(await exists(destinationParent)).toBe(true);
    expect(
      await exists(
        path.join(
          canonicalRoot,
          "quarantine",
          oldProcess,
          oldGeneration,
          ".plans",
          oldRequest.snapshotDigest,
          "plan.json",
        ),
      ),
    ).toBe(true);
  });

  test("retains the surviving suffix ancestor through completed cleanup", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    await put(canonicalRoot, relative);
    await reconcileBrowserState(
      canonicalRoot,
      request([], oldProcess, oldGeneration),
      { admission: admission().value, now: () => NOW },
    );
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "cleanup-destination-directory" && !crashed) {
              crashed = true;
              throw new Error("stop after deepest suffix removal");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });

    const owner = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      "replay",
      "owner",
    );
    const held = `${owner}-held`;
    let replaced = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "cleanup-surviving-ancestor-fsync" || replaced)
              return;
            replaced = true;
            await rename(owner, held);
            await mkdir(owner, { mode: 0o700 });
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(held)).toBe(true);
    expect(await exists(owner)).toBe(true);
  });

  test.each([
    ["parent-open", "open-completed-cleanup-parent"],
    ["intermediate-close", "completed-cleanup-suffix-grandparent"],
  ] as const)(
    "closes completed-suffix descriptors after %s failure",
    async (failureKind, failurePoint) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const oldProcess = Buffer.alloc(32, 9).toString("base64url");
      const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
      await put(canonicalRoot, relative);
      await reconcileBrowserState(
        canonicalRoot,
        request([], oldProcess, oldGeneration),
        { admission: admission().value, now: () => NOW },
      );
      let stopped = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            afterCall(point) {
              if (point === "cleanup-destination-directory" && !stopped) {
                stopped = true;
                throw new Error("stop after deepest suffix removal");
              }
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });

      let injected = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          failureKind === "parent-open"
            ? {
                beforeCall(point) {
                  if (point === failurePoint && !injected) {
                    injected = true;
                    throw new Error(`injected:${failurePoint}`);
                  }
                },
              }
            : {
                beforeClose(point) {
                  if (point === failurePoint && !injected) {
                    injected = true;
                    throw new Error(`injected:${failurePoint}`);
                  }
                },
              },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toBeDefined();
      expect(injected).toBe(true);
      expect(await rootDescriptors(canonicalRoot)).toEqual([]);
    },
  );

  test("rejects an existing cleanup ancestor swap before rmdir", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    await put(canonicalRoot, relative);
    await reconcileBrowserState(
      canonicalRoot,
      request([], oldProcess, oldGeneration),
      { admission: admission().value, now: () => NOW },
    );
    const ancestor = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      "replay",
    );
    const held = `${ancestor}-held`;
    let swapped = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "cleanup-destination-ancestor" || swapped) return;
            swapped = true;
            await rename(ancestor, held);
            await mkdir(ancestor, { mode: 0o700 });
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(held)).toBe(true);
    expect(await exists(ancestor)).toBe(true);
  });

  test.each(["plan.json", "complete"] as const)(
    "rejects a completed %s record swap before unlink",
    async (recordName) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const oldProcess = Buffer.alloc(32, 9).toString("base64url");
      const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
      const oldRequest = request([], oldProcess, oldGeneration);
      await put(canonicalRoot, relative);
      await reconcileBrowserState(canonicalRoot, oldRequest, {
        admission: admission().value,
        now: () => NOW,
      });
      const planDirectory = path.join(
        canonicalRoot,
        "quarantine",
        oldProcess,
        oldGeneration,
        ".plans",
        oldRequest.snapshotDigest,
      );
      const target = path.join(planDirectory, recordName);
      const held = `${target}.held`;
      let swapped = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(point) {
              if (point !== `cleanup-${recordName}` || swapped) return;
              swapped = true;
              await rename(target, held);
              await writeFile(target, Buffer.from("{}"), { mode: 0o600 });
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(await exists(held)).toBe(true);
      expect(await exists(target)).toBe(true);
    },
  );

  test.each(["plan.json", "complete"] as const)(
    "rejects %s reappearance at cleanup parent fsync",
    async (recordName) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const oldProcess = Buffer.alloc(32, 9).toString("base64url");
      const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
      const oldRequest = request([], oldProcess, oldGeneration);
      await put(canonicalRoot, relative);
      await reconcileBrowserState(canonicalRoot, oldRequest, {
        admission: admission().value,
        now: () => NOW,
      });
      const target = path.join(
        canonicalRoot,
        "quarantine",
        oldProcess,
        oldGeneration,
        ".plans",
        oldRequest.snapshotDigest,
        recordName,
      );
      let recreated = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeCall(point) {
              if (point !== `cleanup-${recordName}-parent-fsync` || recreated)
                return;
              recreated = true;
              await writeFile(target, Buffer.from("{}"), { mode: 0o600 });
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(await exists(target)).toBe(true);
      await expect(
        reconcileBrowserState(canonicalRoot, request([]), {
          admission: admission().value,
          now: () => NOW,
        }),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(await exists(target)).toBe(true);
    },
  );

  test("rejects plan directory reappearance at cleanup parent fsync", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    const oldRequest = request([], oldProcess, oldGeneration);
    await put(canonicalRoot, relative);
    await reconcileBrowserState(canonicalRoot, oldRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    const planDirectory = path.join(
      canonicalRoot,
      "quarantine",
      oldProcess,
      oldGeneration,
      ".plans",
      oldRequest.snapshotDigest,
    );
    let recreated = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point !== "cleanup-plan-digest-parent-fsync" || recreated)
              return;
            recreated = true;
            await mkdir(planDirectory, { mode: 0o700 });
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(planDirectory)).toBe(true);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(planDirectory)).toBe(true);
  });

  test("rejects legacy cleanup-copy records without mutation", async () => {
    const canonicalRoot = await root();
    const reconciliationRequest = request([]);
    await reconcileBrowserState(canonicalRoot, reconciliationRequest, {
      admission: admission().value,
      now: () => NOW,
    });
    const directory = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
    );
    await writeFile(path.join(directory, "cleanup"), Buffer.from("{}"), {
      mode: 0o600,
    });
    await expect(
      reconcileBrowserState(canonicalRoot, reconciliationRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(directory, "cleanup"))).toBe(true);
  });

  test.each(["cleanup-plan-digest"])(
    "repairs parent durability after %s completed before a crash",
    async (crashPoint) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const oldProcess = Buffer.alloc(32, 9).toString("base64url");
      const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
      await put(canonicalRoot, relative);
      await reconcileBrowserState(
        canonicalRoot,
        request([], oldProcess, oldGeneration),
        { admission: admission().value, now: () => NOW },
      );
      let crashed = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            afterCall(point) {
              if (point === crashPoint && !crashed) {
                crashed = true;
                throw new Error(`crash:${crashPoint}`);
              }
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
      const calls: string[] = [];
      await runWithReconciliationFilesystemTestContext(
        { beforeCall: (point) => void calls.push(point) },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      );
      expect(calls).toContain(`${crashPoint}-repair-parent-fsync`);
    },
  );

  test("closes an acquired root when its post-open hook fails", async () => {
    const canonicalRoot = await root();
    const closed: string[] = [];
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "open-root") throw new Error("post-open failure");
          },
          handleClosed: (point) => void closed.push(point),
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toBeDefined();
    expect(closed).toContain("failed-open-root");
    const leaked: string[] = [];
    for (const descriptor of await readdir("/proc/self/fd")) {
      try {
        const target = await readlink(`/proc/self/fd/${descriptor}`);
        if (target.includes(canonicalRoot)) leaked.push(target);
      } catch {
        // Descriptor may close between readdir and readlink.
      }
    }
    expect(leaked).toEqual([]);
  });

  test("attempts every descriptor close after one close reports failure", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const attempted: string[] = [];
    let failed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeClose(point) {
            attempted.push(point);
            if (point === "destination-parent" && !failed) {
              failed = true;
              throw new Error("simulated close failure");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toBeDefined();
    expect(attempted).toEqual(
      expect.arrayContaining(["destination-parent", "source-parent", "root"]),
    );
    expect(await rootDescriptors(canonicalRoot)).toEqual([]);
  });

  test("accepts exactly 25,000 managed profile entries and stops before 25,001", async () => {
    const canonicalRoot = await root();
    const generation = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
    );
    await mkdir(generation, { recursive: true, mode: 0o700 });
    for (let offset = 0; offset < 24_999; offset += 250) {
      await Promise.all(
        Array.from({ length: Math.min(250, 24_999 - offset) }, (_, index) =>
          writeFile(
            path.join(
              generation,
              `entry-${String(offset + index).padStart(5, "0")}`,
            ),
            Buffer.alloc(0),
            { mode: 0o600 },
          ),
        ),
      );
    }
    await expect(
      canonicalizeProfileTree(
        canonicalRoot,
        `profiles/${PROFILE}/working/${CHECKPOINT_A}`,
        admission().value,
      ),
    ).resolves.toMatchObject({ byteSize: 0 });
    await writeFile(path.join(generation, "entry-24999"), Buffer.alloc(0), {
      mode: 0o600,
    });
    let yielded = 0;
    let downstreamAfterLimit = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point === "yield-directory-entry") yielded += 1;
            else if (
              yielded === 24_999 &&
              [
                "lstat",
                "open-file",
                "read-file",
                "open-profile-directory",
              ].includes(point)
            ) {
              downstreamAfterLimit += 1;
            }
          },
        },
        () =>
          canonicalizeProfileTree(
            canonicalRoot,
            `profiles/${PROFILE}/working/${CHECKPOINT_A}`,
            admission().value,
          ),
      ),
    ).rejects.toMatchObject({
      category: "reconciliation_snapshot_too_large",
    });
    expect(yielded).toBe(24_999);
    expect(downstreamAfterLimit).toBe(0);
  }, 60_000);

  test("rejects cumulative profile bytes before reading the excess file", async () => {
    const canonicalRoot = await root();
    const generation = path.join(
      canonicalRoot,
      "profiles",
      PROFILE,
      "working",
      CHECKPOINT_A,
    );
    await mkdir(generation, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 4; index += 1) {
      const file = path.join(generation, `part-${index}`);
      await writeFile(file, Buffer.alloc(0), { mode: 0o600 });
      await truncate(file, 64 * 1024 * 1024);
    }
    await writeFile(path.join(generation, "part-4"), Buffer.from([1]), {
      mode: 0o600,
    });
    let reads = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point === "read-file") reads += 1;
          },
        },
        () =>
          canonicalizeProfileTree(
            canonicalRoot,
            `profiles/${PROFILE}/working/${CHECKPOINT_A}`,
            admission().value,
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(reads).toBe(4 * 1_025);
  });

  test("rejects unauthorized empty quarantine candidate hierarchies", async () => {
    const canonicalRoot = await root();
    const empty = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      "replay",
      "owner",
      "scrape",
    );
    await mkdir(empty, { recursive: true, mode: 0o700 });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(empty)).toBe(true);
  });

  test("uses bigint file-handle stats for parent identities", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const sourceParent = path.join(canonicalRoot, "replay", "owner", "scrape");
    const sourceParentStat = await stat(sourceParent, { bigint: true });
    const offset = 9_007_199_254_740_993n;
    const probe = await open(canonicalRoot, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      stat: (...args: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const original = prototype.stat;
    const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: unknown,
      options?: unknown,
    ) {
      if (
        options === null ||
        typeof options !== "object" ||
        !("bigint" in options) ||
        (options as { bigint?: unknown }).bigint !== true
      ) {
        throw new Error("non-bigint stat forbidden");
      }
      const actual = (await original.call(this, options)) as object;
      const isDirectory = (actual as { isDirectory(): boolean }).isDirectory();
      return new Proxy(actual, {
        get(target, property) {
          if (
            property === "dev" &&
            isDirectory &&
            Reflect.get(target, "ino", target) === sourceParentStat.ino
          ) {
            return Reflect.get(target, property, target) + offset;
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(
        reconcileBrowserState(canonicalRoot, request([]), {
          admission: admission().value,
          now: () => NOW,
        }),
      ).resolves.toMatchObject({ ready: true });
      const reconciliationRequest = request([]);
      const plan = JSON.parse(
        await readFile(
          path.join(
            canonicalRoot,
            "quarantine",
            PROCESS,
            GENERATION,
            ".plans",
            reconciliationRequest.snapshotDigest,
            "plan.json",
          ),
          "utf8",
        ),
      ) as { entries: Array<{ sourceParent: { dev: string } }> };
      expect(plan.entries[0]?.sourceParent.dev).toBe(
        (sourceParentStat.dev + offset).toString(10),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("allows an exact empty managed candidate hierarchy", async () => {
    const canonicalRoot = await root();
    await mkdir(path.join(canonicalRoot, "replay", "owner", "scrape"), {
      recursive: true,
      mode: 0o700,
    });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ removed: 0, ready: true });
  });

  test.each(["open-directory", "open-file"])(
    "closes a handle when the %s post-acquisition hook fails",
    async (failurePoint) => {
      const canonicalRoot = await root();
      await put(canonicalRoot, `replay/owner/scrape/${CHECKPOINT_A}.json`);
      const closed: string[] = [];
      let failed = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            afterCall(point) {
              if (point === failurePoint && !failed) {
                failed = true;
                throw new Error(`post-open:${failurePoint}`);
              }
            },
            handleClosed: (point) => void closed.push(point),
          },
          () =>
            reconcileBrowserState(canonicalRoot, request([]), {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toBeDefined();
      expect(closed).toContain(`failed-${failurePoint}`);
      const leaked: string[] = [];
      for (const descriptor of await readdir("/proc/self/fd")) {
        try {
          const target = await readlink(`/proc/self/fd/${descriptor}`);
          if (target.includes(canonicalRoot)) leaked.push(target);
        } catch {
          // Descriptor may close between readdir and readlink.
        }
      }
      expect(leaked).toEqual([]);
    },
  );

  test.each(["root", "file", "profile", "temp", "opendir"] as const)(
    "owns and closes %s acquired before post-open admission loss",
    async (kind) => {
      const canonicalRoot = await root();
      const controller = new AbortController();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const profileRelative = `profiles/${PROFILE}/working/${CHECKPOINT_A}`;
      if (kind === "file" || kind === "temp") {
        await put(canonicalRoot, relative);
      }
      if (kind === "profile") {
        const generation = path.join(canonicalRoot, profileRelative);
        await mkdir(generation, { recursive: true, mode: 0o700 });
        await writeFile(path.join(generation, "state.json"), STATE_BYTES, {
          mode: 0o600,
        });
      }
      const targetPoint = {
        root: "open-root",
        file: "open-file",
        profile: "open-profile-root",
        temp: "create-complete.tmp",
        opendir: "open-directory-stream",
      }[kind];
      let armed = false;
      let armedChecks = 0;
      const controlled: ReconciliationExecutionAdmission = {
        signal: controller.signal,
        assertAdmitted() {
          if (armed) {
            armedChecks += 1;
            if (armedChecks === 2) controller.abort();
          }
          if (controller.signal.aborted) {
            throw new BrowserServiceError(
              "reconciliation_required",
              "reconciliation is not admitted",
            );
          }
        },
      };
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (point === targetPoint && !armed) armed = true;
            },
          },
          () => {
            if (kind === "profile") {
              return canonicalizeProfileTree(
                canonicalRoot,
                profileRelative,
                controlled,
              );
            }
            return reconcileBrowserState(
              canonicalRoot,
              kind === "file"
                ? request([reference(CHECKPOINT_A, relative)])
                : request([]),
              { admission: controlled, now: () => NOW },
            );
          },
        ),
      ).rejects.toMatchObject({ category: "reconciliation_required" });
      expect(armed).toBe(true);
      expect(armedChecks).toBe(2);
      expect(await rootDescriptors(canonicalRoot)).toEqual([]);
    },
  );

  test("promotes multiple completed entries sharing one source parent", async () => {
    const canonicalRoot = await root();
    const first = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const second = `replay/owner/scrape/${CHECKPOINT_B}.json`;
    await put(canonicalRoot, first);
    await put(canonicalRoot, second);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ removed: 2, ready: true });
  });

  test.each(["source-parent", "source-leaf", "destination-leaf"] as const)(
    "rejects %s recreation after promotion entry validation",
    async (mutation) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const sourceParent = path.join(
        canonicalRoot,
        "replay",
        "owner",
        "scrape",
      );
      const destination = path.join(
        canonicalRoot,
        "quarantine",
        PROCESS,
        GENERATION,
        relative,
      );
      const reconciliationRequest = request([]);
      const attackerBytes = Buffer.from(`attacker-${mutation}`, "utf8");
      const attackerTarget =
        mutation === "source-parent"
          ? path.join(sourceParent, "sentinel")
          : mutation === "source-leaf"
            ? path.join(canonicalRoot, relative)
            : destination;
      await put(canonicalRoot, relative);
      let mutated = false;
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async afterCall(point) {
              if (point !== "promotion-entry-validation" || mutated) return;
              mutated = true;
              if (mutation === "source-parent") {
                await rename(sourceParent, `${sourceParent}-held`);
                await mkdir(sourceParent, { recursive: true, mode: 0o700 });
              } else {
                await mkdir(path.dirname(attackerTarget), {
                  recursive: true,
                  mode: 0o700,
                });
              }
              await writeFile(attackerTarget, attackerBytes, { mode: 0o600 });
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, reconciliationRequest, {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(mutated).toBe(true);
      expect(await readFile(attackerTarget)).toEqual(attackerBytes);
      const planDirectory = path.join(
        canonicalRoot,
        "quarantine",
        PROCESS,
        GENERATION,
        ".plans",
        reconciliationRequest.snapshotDigest,
      );
      expect(await exists(path.join(planDirectory, "complete.tmp"))).toBe(true);
      expect(await exists(path.join(planDirectory, "complete"))).toBe(false);
    },
  );

  test.each([
    "complete-replace",
    "complete-modify",
    "plan-replace",
    "plan-modify",
    "directory-replace",
  ] as const)("rejects %s during final promotion sweep", async (mutation) => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const reconciliationRequest = request([]);
    const planDirectory = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
    );
    const tempPath = path.join(planDirectory, "complete.tmp");
    const planPath = path.join(planDirectory, "plan.json");
    const heldPath = `${
      mutation.startsWith("complete") ? tempPath : planPath
    }.held`;
    const directoryHeld = `${planDirectory}-held`;
    const attackerBytes = Buffer.from(`attacker-${mutation}`, "utf8");
    const attackerTarget =
      mutation === "directory-replace"
        ? path.join(planDirectory, "sentinel")
        : mutation.startsWith("complete")
          ? tempPath
          : planPath;
    let expectedDiagnostic = attackerBytes;
    let mutated = false;
    await put(canonicalRoot, relative);
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeFinalPromotionAnchors() {
            if (mutated) return;
            mutated = true;
            if (mutation === "directory-replace") {
              await rename(planDirectory, directoryHeld);
              await mkdir(planDirectory, { recursive: true, mode: 0o700 });
              await writeFile(attackerTarget, attackerBytes, { mode: 0o600 });
              return;
            }
            if (mutation.endsWith("replace")) {
              expectedDiagnostic = await readFile(attackerTarget);
              await rename(attackerTarget, heldPath);
              await writeFile(attackerTarget, expectedDiagnostic, {
                mode: 0o600,
              });
              return;
            }
            await writeFile(attackerTarget, attackerBytes, { mode: 0o600 });
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(mutated).toBe(true);
    expect(await readFile(attackerTarget)).toEqual(expectedDiagnostic);
    expect(await exists(path.join(planDirectory, "complete"))).toBe(false);
    if (mutation === "directory-replace") {
      expect(await exists(path.join(directoryHeld, "complete"))).toBe(false);
      expect(await exists(path.join(directoryHeld, "complete.tmp"))).toBe(true);
    } else if (mutation.endsWith("replace")) {
      expect(await exists(heldPath)).toBe(true);
    }
  });

  test.each(["source-leaf", "destination-leaf"] as const)(
    "rejects %s recreation at final promotion anchor seam",
    async (mutation) => {
      const canonicalRoot = await root();
      const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
      const reconciliationRequest = request([]);
      const planDirectory = path.join(
        canonicalRoot,
        "quarantine",
        PROCESS,
        GENERATION,
        ".plans",
        reconciliationRequest.snapshotDigest,
      );
      const attackerTarget =
        mutation === "source-leaf"
          ? path.join(canonicalRoot, relative)
          : path.join(
              canonicalRoot,
              "quarantine",
              PROCESS,
              GENERATION,
              relative,
            );
      const attackerBytes = Buffer.from(`attacker-${mutation}`, "utf8");
      let mutated = false;
      await put(canonicalRoot, relative);
      await expect(
        runWithReconciliationFilesystemTestContext(
          {
            async beforeFinalPromotionAnchors() {
              if (mutated) return;
              mutated = true;
              await mkdir(path.dirname(attackerTarget), {
                recursive: true,
                mode: 0o700,
              });
              await writeFile(attackerTarget, attackerBytes, { mode: 0o600 });
            },
          },
          () =>
            reconcileBrowserState(canonicalRoot, reconciliationRequest, {
              admission: admission().value,
              now: () => NOW,
            }),
        ),
      ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
      expect(mutated).toBe(true);
      expect(await readFile(attackerTarget)).toEqual(attackerBytes);
      expect(await exists(path.join(planDirectory, "complete.tmp"))).toBe(true);
      expect(await exists(path.join(planDirectory, "complete"))).toBe(false);
    },
  );

  test("bounds promotion handles and validates entries linearly", async () => {
    const canonicalRoot = await root();
    const count = 24;
    for (let index = 0; index < count; index += 1) {
      await put(
        canonicalRoot,
        `replay/owner/scrape/${checkpointId(index)}.json`,
      );
    }
    let validationLookups = 0;
    let promotionValidationActive = false;
    let peakLiveAtPromotion = 0;
    // Root/temp/plan pins plus one source/destination walk stay below 16.
    const promotionDescriptorCap = 16;
    const samplePromotionDescriptors = async (): Promise<void> => {
      peakLiveAtPromotion = Math.max(
        peakLiveAtPromotion,
        (await rootDescriptors(canonicalRoot)).length,
      );
    };
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async beforeCall(point) {
            if (point === "promotion-entry-validation") {
              validationLookups += 1;
              promotionValidationActive = true;
            }
            if (promotionValidationActive) await samplePromotionDescriptors();
          },
          async afterCall(point) {
            if (promotionValidationActive) {
              await samplePromotionDescriptors();
            }
            if (point === "promotion-entry-validation") {
              promotionValidationActive = false;
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).resolves.toMatchObject({ removed: count, ready: true });
    expect(validationLookups).toBe(count);
    expect(peakLiveAtPromotion).toBeGreaterThan(0);
    expect(peakLiveAtPromotion).toBeLessThanOrEqual(promotionDescriptorCap);
  });

  test("retries completed cleanup with two branches sharing ancestors", async () => {
    const canonicalRoot = await root();
    const first = `replay/owner-a/scrape/${CHECKPOINT_A}.json`;
    const second = `replay/owner-b/scrape/${CHECKPOINT_B}.json`;
    const oldProcess = Buffer.alloc(32, 9).toString("base64url");
    const oldGeneration = Buffer.alloc(32, 10).toString("base64url");
    await put(canonicalRoot, first);
    await put(canonicalRoot, second);
    await reconcileBrowserState(
      canonicalRoot,
      request([], oldProcess, oldGeneration),
      { admission: admission().value, now: () => NOW },
    );
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "cleanup-destination-directory" && !crashed) {
              crashed = true;
              throw new Error("crash after first branch");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, request([]), {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ ready: true });
    expect(
      await exists(path.join(canonicalRoot, "quarantine", oldProcess)),
    ).toBe(false);
  });

  test("does not promote a temp manifest before validating every sibling", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const reconciliationRequest = request([]);
    await put(canonicalRoot, relative);
    let crashed = false;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "write-plan.tmp" && !crashed) {
              crashed = true;
              throw new Error("crash after plan write");
            }
          },
        },
        () =>
          reconcileBrowserState(canonicalRoot, reconciliationRequest, {
            admission: admission().value,
            now: () => NOW,
          }),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_cleanup_failed" });
    const planDirectory = path.join(
      canonicalRoot,
      "quarantine",
      PROCESS,
      GENERATION,
      ".plans",
      reconciliationRequest.snapshotDigest,
    );
    await mkdir(path.join(canonicalRoot, "quarantine", "invalid-sibling"));
    await expect(
      reconcileBrowserState(canonicalRoot, reconciliationRequest, {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await exists(path.join(planDirectory, "plan.tmp"))).toBe(true);
    expect(await exists(path.join(planDirectory, "plan.json"))).toBe(false);
  });

  test("failure logs remain bounded and redact invalid filesystem names", async () => {
    const canonicalRoot = await root();
    const secret = "secret-invalid-owner!";
    await mkdir(path.join(canonicalRoot, "replay", secret), {
      recursive: true,
    });
    const logger = { info: vi.fn(), error: vi.fn() };
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
        correlationId: "unsafe correlation value",
        logger,
      }),
    ).rejects.toBeDefined();
    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized.length).toBeLessThan(2_048);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("unsafe correlation value");
  });

  test("fails closed when source and deterministic destination both exist", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    const destination = `quarantine/${PROCESS}/${GENERATION}/${relative}`;
    await put(canonicalRoot, relative);
    await put(canonicalRoot, destination);
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: admission().value,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_filesystem_unsafe" });
    expect(await readFile(path.join(canonicalRoot, relative))).toEqual(
      STATE_BYTES,
    );
    expect(await readFile(path.join(canonicalRoot, destination))).toEqual(
      STATE_BYTES,
    );
  });

  test("preserves complete source namespaces for equal basenames", async () => {
    const canonicalRoot = await root();
    const name = `${CHECKPOINT_A}.json`;
    const replay = `replay/owner/scrape/${name}`;
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await ensureProfileStates(canonicalRoot, profileId);
    const profile = `profiles/${profileId}/working/${CHECKPOINT_A}`;
    await put(canonicalRoot, replay);
    const profileRoot = path.join(canonicalRoot, profile);
    await mkdir(profileRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(profileRoot, "state"), STATE_BYTES, {
      mode: 0o600,
    });
    await utimes(path.join(profileRoot, "state"), OLD, OLD);
    await utimes(profileRoot, OLD, OLD);
    await reconcileBrowserState(canonicalRoot, request([]), {
      admission: admission().value,
      now: () => NOW,
    });
    expect(await exists(path.join(canonicalRoot, replay))).toBe(false);
    expect(await exists(path.join(canonicalRoot, profile))).toBe(false);
  });

  test("aborts between filesystem calls without mapping to cleanup failure", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const controller = new AbortController();
    let checks = 0;
    const controlled: ReconciliationExecutionAdmission = {
      signal: controller.signal,
      assertAdmitted() {
        checks += 1;
        if (checks === 8) controller.abort();
        if (controller.signal.aborted) {
          throw new BrowserServiceError(
            "reconciliation_required",
            "reconciliation is not admitted",
          );
        }
      },
    };
    await expect(
      reconcileBrowserState(canonicalRoot, request([]), {
        admission: controlled,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ category: "reconciliation_required" });
  });

  test("closes every held descriptor through abort cleanup", async () => {
    const canonicalRoot = await root();
    const relative = `replay/owner/scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const controller = new AbortController();
    const closed: string[] = [];
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "read-file") controller.abort();
          },
          handleClosed(point) {
            closed.push(point);
          },
        },
        () =>
          reconcileBrowserState(
            canonicalRoot,
            request([reference(CHECKPOINT_A, relative)]),
            { admission: admission(controller).value, now: () => NOW },
          ),
      ),
    ).rejects.toMatchObject({ category: "reconciliation_required" });
    expect(closed).toEqual(
      expect.arrayContaining(["regular-file", "regular-file-parent", "root"]),
    );
    const leaked: string[] = [];
    for (const descriptor of await readdir("/proc/self/fd")) {
      try {
        const target = await readlink(`/proc/self/fd/${descriptor}`);
        if (target.includes(canonicalRoot)) leaked.push(target);
      } catch {
        // Descriptor may close between readdir and readlink.
      }
    }
    expect(leaked).toEqual([]);
  });

  test("logs only bounded aggregate fields", async () => {
    const canonicalRoot = await root();
    const relative = `replay/secret-owner/secret-scrape/${CHECKPOINT_A}.json`;
    await put(canonicalRoot, relative);
    const logger = { info: vi.fn(), error: vi.fn() };
    await reconcileBrowserState(canonicalRoot, request([]), {
      admission: admission().value,
      now: () => NOW,
      correlationId: "correlation-safe",
      logger,
    });
    const serialized = JSON.stringify(logger.info.mock.calls);
    expect(serialized).toContain("correlation-safe");
    expect(serialized).not.toContain("secret-owner");
    expect(serialized).not.toContain(CHECKPOINT_A);
    expect(serialized).not.toContain(PROCESS);
    expect(serialized).not.toContain(GENERATION);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("atomic publication reconciliation ownership", () => {
  test.each([
    "missing",
    "inaccessible",
    "wrong_type",
    "identity_mismatch",
    "unsupported_operation",
  ] as const)("rejects %s procfs preflight", async (atomicProcfsScenario) => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    try {
      const attempt = runWithReconciliationFilesystemTestContext(
        { atomicProcfsScenario },
        () =>
          acquireAtomicPreReadyRecoveryAuthority(
            installed.root,
            CHECKPOINT_A,
          ),
      );
      await expect(attempt).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic publication procfs is unsupported",
      });
      await expect(attempt).rejects.not.toHaveProperty("cause");
    } finally {
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("rejects disallowed filesystems before minting atomic authority", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    try {
      await expect(
        runWithReconciliationFilesystemTestContext(
          { atomicStatfsScenario: "disallowed" },
          () =>
            acquireAtomicPreReadyRecoveryAuthority(
              installed.root,
              CHECKPOINT_A,
            ),
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic publication filesystem is unsupported",
      });
    } finally {
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("publishes a canary through raw native and separate location effects", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const sourceLeaf = `proof-${CHECKPOINT_A}-0`;
    const targetLeaf = `canary-${CHECKPOINT_A}-0`;
    let wrapper:
      | Extract<
          Awaited<ReturnType<typeof applyAtomicEffect>>,
          { kind: "create_and_pin_completed" }
        >
      | undefined;
    try {
      const createdWrapper = await applyAtomicEffect(lease.controller, {
        kind: "create_and_pin_wrapper",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "wrapper",
        parentId: bundles.handleId,
        leaf: CHECKPOINT_A,
        parentEvidenceDigest: bundles.evidence.evidenceDigest,
        mode: 448,
        expectedAbsence: true,
      });
      if (createdWrapper.kind !== "create_and_pin_completed") {
        throw new Error("canary wrapper was not created");
      }
      wrapper = createdWrapper;
      const source = await applyAtomicEffect(lease.controller, {
        kind: "create_and_pin_directory",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "private_source",
        parentId: wrapper.handleId,
        leaf: sourceLeaf,
        parentEvidenceDigest: wrapper.evidence.evidenceDigest,
        mode: 448,
        expectedAbsence: true,
      });
      if (source.kind !== "create_and_pin_completed") {
        throw new Error("canary source was not created");
      }
      for (const [role, objectId, expected] of [
        ["wrapper", wrapper.handleId, wrapper.evidence],
        [
          "profiles_parent",
          lease.initialAuthority.profilesParentId,
          lease.initialAuthority.evidence.profilesParent,
        ],
      ] as const) {
        const revalidated = await applyAtomicEffect(lease.controller, {
          kind: "revalidate_handle",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          role,
          objectId,
          cursor: 0,
          byteLength: 0,
          expected,
        });
        expect(revalidated).toMatchObject({
          kind: "effect_completed",
          requestKind: "revalidate_handle",
        });
        await expect(
          applyAtomicEffect(lease.controller, {
            kind: "statfs_parent",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role,
            objectId,
            expected,
          }),
        ).resolves.toMatchObject({
          kind: "statfs_observed",
          objectId,
          device: expected.dev,
        });
      }
      const native = await applyAtomicEffect(lease.controller, {
        kind: "native_no_replace",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        move: "canary_publish",
        sourceParentId: wrapper.handleId,
        sourceId: source.handleId,
        sourceLeaf,
        targetParentId: lease.initialAuthority.profilesParentId,
        targetLeaf,
        expectedSource: source.evidence,
        expectedTarget: { absent: true },
        evidenceDigest: sha("canary-native"),
      });
      expect(native).toMatchObject({
        kind: "native_resolved",
        requestKind: "native_no_replace",
        move: "canary_publish",
        rawCode: "success",
      });
      const observed = await applyAtomicEffect(lease.controller, {
        kind: "observe_locations",
        requestKind: "native_no_replace",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        move: "canary_publish",
        sourceParentId: wrapper.handleId,
        sourceId: source.handleId,
        sourceLeaf,
        targetParentId: lease.initialAuthority.profilesParentId,
        targetLeaf,
        expectedSource: source.evidence,
        expectedTarget: { absent: true },
        evidenceDigest: sha("canary-native"),
      });
      expect(observed).toMatchObject({
        kind: "locations_observed",
        source: { state: "absent" },
        target: {
          state: "match",
          dev: source.evidence.dev,
          ino: source.evidence.ino,
        },
      });
      if (
        observed.kind !== "locations_observed" ||
        observed.targetObjectId === null ||
        observed.target.evidence === null
      ) {
        throw new Error("published canary was not pinned");
      }
      await expect(
        lstat(
          path.join(
            canonicalRoot,
            ".profile-publish-staging",
            "bundles",
            CHECKPOINT_A,
            sourceLeaf,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (
          await lstat(path.join(canonicalRoot, "profiles", targetLeaf), {
            bigint: true,
          })
        ).ino,
      ).toBe(BigInt(source.evidence.ino));

      for (const [role, objectId, expected] of [
        ["wrapper", wrapper.handleId, wrapper.evidence],
        [
          "profiles_parent",
          lease.initialAuthority.profilesParentId,
          lease.initialAuthority.evidence.profilesParent,
        ],
      ] as const) {
        await applyAtomicEffect(lease.controller, {
          kind: "revalidate_handle",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          role,
          objectId,
          cursor: 0,
          byteLength: 0,
          expected,
        });
        await applyAtomicEffect(lease.controller, {
          kind: "statfs_parent",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          role,
          objectId,
          expected,
        });
      }
      await expect(
        applyAtomicEffect(lease.controller, {
          kind: "native_no_replace",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          move: "canary_publish",
          sourceParentId: wrapper.handleId,
          sourceId: source.handleId,
          sourceLeaf,
          targetParentId: lease.initialAuthority.profilesParentId,
          targetLeaf,
          expectedSource: source.evidence,
          expectedTarget: { absent: true },
          evidenceDigest: sha("canary-native-replay"),
        }),
      ).resolves.toMatchObject({
        kind: "native_resolved",
        rawCode: "atomic_publish_source_missing",
      });
      await expect(
        applyAtomicEffect(lease.controller, {
          kind: "observe_locations",
          requestKind: "native_no_replace",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          move: "canary_publish",
          sourceParentId: wrapper.handleId,
          sourceId: source.handleId,
          sourceLeaf,
          targetParentId: lease.initialAuthority.profilesParentId,
          targetLeaf,
          expectedSource: source.evidence,
          expectedTarget: { absent: true },
          evidenceDigest: sha("canary-native-replay"),
        }),
      ).resolves.toMatchObject({
        kind: "locations_observed",
        source: { state: "absent" },
        target: { state: "match" },
      });
      const plannedProof: AtomicCanaryProofV1 = Object.freeze({
        version: 1,
        operationId: CHECKPOINT_A,
        targetParentLocatorDigest: sha("profiles-parent-locator"),
        targetParentEvidence:
          lease.initialAuthority.evidence.profilesParent,
        wrapperEvidence: wrapper.evidence,
        attempt: 0,
        sourceLeaf,
        targetLeaf,
        deletionLeaf: `deletion-${CHECKPOINT_A}-0`,
        phase: "planned",
        privateSourceEvidence: source.evidence,
        publishedEvidence: null,
        privateDeletionEvidence: null,
        classification: null,
        manifestSha256: null,
        cleanupNextIndex: 0,
        cleanupEntryCount: 0,
        sourceParentSynced: false,
        targetParentSynced: false,
      });
      const persistedPhases: string[] = [];
      await expect(
        runAtomicCanaryRecovery(
          lease.controller,
          {
            flightNonce: "duplicate-canary-runner",
            action: "prove_mount",
            proof: plannedProof,
            durableCanaryInventory: [plannedProof, plannedProof],
            expectedTargetParentLocatorDigest:
              plannedProof.targetParentLocatorDigest,
            sourceParentId: wrapper.handleId,
            sourceParentRole: "wrapper",
            sourceParentEvidence: wrapper.evidence,
            sourceId: source.handleId,
            targetParentId: lease.initialAuthority.profilesParentId,
            targetParentRole: "profiles_parent",
            targetParentEvidence:
              lease.initialAuthority.evidence.profilesParent,
            cleanupManifest: null,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic canary inventory conflicts",
      });
      await expect(
        runAtomicCanaryRecovery(
          lease.controller,
          {
            flightNonce: "wrong-locator-canary-runner",
            action: "prove_mount",
            proof: plannedProof,
            durableCanaryInventory: [],
            expectedTargetParentLocatorDigest: sha("wrong-parent-locator"),
            sourceParentId: wrapper.handleId,
            sourceParentRole: "wrapper",
            sourceParentEvidence: wrapper.evidence,
            sourceId: source.handleId,
            targetParentId: lease.initialAuthority.profilesParentId,
            targetParentRole: "profiles_parent",
            targetParentEvidence:
              lease.initialAuthority.evidence.profilesParent,
            cleanupManifest: null,
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic canary inventory conflicts",
      });
      const recoveredMount = await runAtomicCanaryRecovery(
          lease.controller,
          {
            flightNonce: "fresh-canary-runner",
            action: "prove_mount",
            proof: plannedProof,
            durableCanaryInventory: [],
            expectedTargetParentLocatorDigest:
              plannedProof.targetParentLocatorDigest,
            sourceParentId: wrapper.handleId,
            sourceParentRole: "wrapper",
            sourceParentEvidence: wrapper.evidence,
            sourceId: source.handleId,
            targetParentId: lease.initialAuthority.profilesParentId,
            targetParentRole: "profiles_parent",
            targetParentEvidence:
              lease.initialAuthority.evidence.profilesParent,
            cleanupManifest: null,
          },
          async request => {
            persistedPhases.push(request.proof.phase);
          },
        );
      expect(recoveredMount).toMatchObject({
        kind: "mount_proved",
        proof: {
          phase: "published",
          publishedEvidence: source.evidence,
        },
      });
      expect(persistedPhases).toEqual(["planned", "published"]);
      const replayPersistence = vi.fn(async () => undefined);
      const concurrentReplay = (flightNonce: string) =>
        runAtomicCanaryRecovery(
          lease.controller,
          {
            flightNonce,
            action: "prove_mount",
            proof: recoveredMount.proof,
            durableCanaryInventory: [recoveredMount.proof],
            expectedTargetParentLocatorDigest:
              recoveredMount.proof.targetParentLocatorDigest,
            sourceParentId: wrapper.handleId,
            sourceParentRole: "wrapper",
            sourceParentEvidence: wrapper.evidence,
            sourceId: source.handleId,
            targetParentId: lease.initialAuthority.profilesParentId,
            targetParentRole: "profiles_parent",
            targetParentEvidence:
              lease.initialAuthority.evidence.profilesParent,
            cleanupManifest: null,
          },
          replayPersistence,
        );
      const sameParentResults = await Promise.all([
        concurrentReplay("same-parent-canary-a"),
        concurrentReplay("same-parent-canary-b"),
      ]);
      expect(sameParentResults).toMatchObject([
        { kind: "mount_proved", proof: { phase: "published" } },
        { kind: "mount_proved", proof: { phase: "published" } },
      ]);
      expect(replayPersistence).not.toHaveBeenCalled();
      expect(sameParentResults[0]!.proof).toEqual(recoveredMount.proof);
      expect(sameParentResults[1]!.proof).toEqual(recoveredMount.proof);

      const deletionLeaf = `deletion-${CHECKPOINT_A}-0`;
      const cleanupPhases: string[] = [];
      const deleting = await runAtomicCanaryRecovery(
        lease.controller,
        {
          flightNonce: "canary-cleanup-runner",
          action: "cleanup",
          proof: recoveredMount.proof,
          durableCanaryInventory: [recoveredMount.proof],
          expectedTargetParentLocatorDigest:
            recoveredMount.proof.targetParentLocatorDigest,
          sourceParentId: lease.initialAuthority.profilesParentId,
          sourceParentRole: "profiles_parent",
          sourceParentEvidence:
            lease.initialAuthority.evidence.profilesParent,
          sourceId: observed.targetObjectId,
          targetParentId: wrapper.handleId,
          targetParentRole: "wrapper",
          targetParentEvidence: wrapper.evidence,
          cleanupManifest: {
            sha256: sha("canary-manifest"),
            entryCount: 1,
            nextIndex: 0,
          },
        },
        async request => {
          cleanupPhases.push(request.proof.phase);
        },
      );
      expect(cleanupPhases).toEqual(["deleting", "deleting"]);
      expect(deleting).toMatchObject({
        kind: "cleanup_pending",
        proof: {
          phase: "deleting",
          privateDeletionEvidence: source.evidence,
        },
      });
      const replayedCleanup = await runAtomicCanaryRecovery(
        lease.controller,
        {
          flightNonce: "fresh-cleanup-replay-runner",
          action: "cleanup",
          proof: deleting.proof,
          durableCanaryInventory: [deleting.proof],
          expectedTargetParentLocatorDigest:
            deleting.proof.targetParentLocatorDigest,
          sourceParentId: lease.initialAuthority.profilesParentId,
          sourceParentRole: "profiles_parent",
          sourceParentEvidence:
            lease.initialAuthority.evidence.profilesParent,
          sourceId: observed.targetObjectId,
          targetParentId: wrapper.handleId,
          targetParentRole: "wrapper",
          targetParentEvidence: wrapper.evidence,
          cleanupManifest: {
            sha256: sha("canary-manifest"),
            entryCount: 1,
            nextIndex: 0,
          },
        },
        async () => undefined,
      );
      expect(replayedCleanup).toMatchObject({
        kind: "cleanup_pending",
        proof: {
          phase: "deleting",
          privateDeletionEvidence: source.evidence,
        },
      });
      expect(
        await lstat(
          path.join(
            canonicalRoot,
            ".profile-publish-staging",
            "bundles",
            CHECKPOINT_A,
            deletionLeaf,
          ),
        ),
      ).toMatchObject({ ino: Number(source.evidence.ino) });
    } finally {
      await closeAtomicEffectController(lease.controller).catch(() => undefined);
      await rm(path.join(canonicalRoot, "profiles", targetLeaf), {
        recursive: true,
        force: true,
      });
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_A,
        ),
        { recursive: true, force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("reserves one fresh canary across controllers sharing a root", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const leaseA = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const leaseB = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_B,
    );
    const locator = sha("shared-parent-race-locator");
    const bundlesA = await openAtomicBundlesParent(
      leaseA,
      canonicalRoot,
      CHECKPOINT_A,
    );
    const bundlesB = await openAtomicBundlesParent(
      leaseB,
      canonicalRoot,
      CHECKPOINT_B,
    );
    const fixtureA = await createAtomicCanaryFixture(
      leaseA,
      bundlesA,
      CHECKPOINT_A,
      locator,
    );
    const fixtureB = await createAtomicCanaryFixture(
      leaseB,
      bundlesB,
      CHECKPOINT_B,
      locator,
    );
    let entered!: () => void;
    const persistenceEntered = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release!: () => void;
    const persistenceRelease = new Promise<void>(resolve => {
      release = resolve;
    });
    const input = (
      lease: typeof leaseA,
      fixture: typeof fixtureA,
      flightNonce: string,
    ) => ({
      flightNonce,
      action: "prove_mount" as const,
      proof: fixture.proof,
      durableCanaryInventory: [],
      expectedTargetParentLocatorDigest: locator,
      sourceParentId: fixture.wrapper.handleId,
      sourceParentRole: "wrapper" as const,
      sourceParentEvidence: fixture.wrapper.evidence,
      sourceId: fixture.source.handleId,
      targetParentId: lease.initialAuthority.profilesParentId,
      targetParentRole: "profiles_parent" as const,
      targetParentEvidence: lease.initialAuthority.evidence.profilesParent,
      cleanupManifest: null,
    });
    const first = runAtomicCanaryRecovery(
      leaseA.controller,
      input(leaseA, fixtureA, "fresh-claim-a"),
      async () => {
        entered();
        await persistenceRelease;
        throw new Error("injected uncertain persistence");
      },
    );
    await persistenceEntered;
    const secondPersistence = vi.fn(async () => undefined);
    const second = runAtomicCanaryRecovery(
      leaseB.controller,
      input(leaseB, fixtureB, "fresh-claim-b"),
      secondPersistence,
    );
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    }).catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    release();
    try {
      await expect(first).rejects.toThrow("injected uncertain persistence");
      await expect(second).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic canary inventory conflicts",
      });
      expect(secondPersistence).not.toHaveBeenCalled();
    } finally {
      await closeAtomicEffectController(leaseA.controller).catch(
        () => undefined,
      );
      await closeAtomicEffectController(leaseB.controller).catch(
        () => undefined,
      );
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_A,
        ),
        { recursive: true, force: true },
      );
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_B,
        ),
        { recursive: true, force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("runner closes admission for a real canary target conflict", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const locator = sha("conflict-parent-locator");
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const fixture = await createAtomicCanaryFixture(
      lease,
      bundles,
      CHECKPOINT_A,
      locator,
    );
    const target = path.join(
      canonicalRoot,
      "profiles",
      fixture.proof.targetLeaf,
    );
    await mkdir(target, { mode: 0o700 });
    const persisted: string[] = [];
    try {
      await expect(
        runAtomicCanaryRecovery(
          lease.controller,
          {
            flightNonce: "real-canary-conflict",
            action: "prove_mount",
            proof: fixture.proof,
            durableCanaryInventory: [],
            expectedTargetParentLocatorDigest: locator,
            sourceParentId: fixture.wrapper.handleId,
            sourceParentRole: "wrapper",
            sourceParentEvidence: fixture.wrapper.evidence,
            sourceId: fixture.source.handleId,
            targetParentId: lease.initialAuthority.profilesParentId,
            targetParentRole: "profiles_parent",
            targetParentEvidence:
              lease.initialAuthority.evidence.profilesParent,
            cleanupManifest: null,
          },
          async request => {
            persisted.push(request.proof.phase);
          },
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message:
          "atomic canary recovery failed: native_binding_invalid",
      });
      expect(persisted).toEqual(["planned"]);
      await expect(lstat(target)).resolves.toMatchObject({
        ino: expect.any(Number),
      });
    } finally {
      await closeAtomicEffectController(lease.controller).catch(
        () => undefined,
      );
      await rm(target, { recursive: true, force: true });
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_A,
        ),
        { recursive: true, force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("published replay never renames a regressed private source", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const locator = sha("published-regression-locator");
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const fixture = await createAtomicCanaryFixture(
      lease,
      bundles,
      CHECKPOINT_A,
      locator,
    );
    const published: AtomicCanaryProofV1 = Object.freeze({
      ...fixture.proof,
      phase: "published",
      publishedEvidence: fixture.source.evidence,
      classification: Object.freeze({
        outcome: "published",
        nativeCode: "success",
        sourceMatches: false,
        targetMatches: true,
        targetOther: false,
        nativePrecheckEvidenceDigest: sha("published-precheck"),
        locationEvidenceDigest: sha("published-locations"),
      }),
      sourceParentSynced: true,
      targetParentSynced: true,
    });
    const source = path.join(
      canonicalRoot,
      ".profile-publish-staging",
      "bundles",
      CHECKPOINT_A,
      fixture.proof.sourceLeaf,
    );
    const target = path.join(
      canonicalRoot,
      "profiles",
      fixture.proof.targetLeaf,
    );
    const persistence = vi.fn(async () => undefined);
    try {
      await expect(
        runAtomicCanaryRecovery(
          lease.controller,
          {
            flightNonce: "published-regressed-source",
            action: "prove_mount",
            proof: published,
            durableCanaryInventory: [published],
            expectedTargetParentLocatorDigest: locator,
            sourceParentId: fixture.wrapper.handleId,
            sourceParentRole: "wrapper",
            sourceParentEvidence: fixture.wrapper.evidence,
            sourceId: fixture.source.handleId,
            targetParentId: lease.initialAuthority.profilesParentId,
            targetParentRole: "profiles_parent",
            targetParentEvidence:
              lease.initialAuthority.evidence.profilesParent,
            cleanupManifest: null,
          },
          persistence,
        ),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message:
          "atomic canary recovery failed: native_binding_invalid",
      });
      expect(persistence).not.toHaveBeenCalled();
      await expect(lstat(source)).resolves.toMatchObject({
        ino: Number(fixture.source.evidence.ino),
      });
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await closeAtomicEffectController(lease.controller).catch(
        () => undefined,
      );
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_A,
        ),
        { recursive: true, force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("acquires fixed held authority and runs exact create/remove sequences", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const points: string[] = [];
    const gates: string[] = [];
    const openFlags: Array<readonly [string, number, number | undefined]> = [];
    let createdId: FlightSemanticId | undefined;
    let createdEvidence: AtomicObjectEvidenceV1 | undefined;
    try {
      const created = await runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point.startsWith("atomic-")) points.push(point);
          },
          atomicGate(phase, point) {
            gates.push(`${phase}:${point}`);
          },
          atomicOpenFlags(point, flags, mode) {
            openFlags.push([point, flags, mode]);
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "create_and_pin_wrapper",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "wrapper",
            parentId: bundles.handleId,
            leaf: CHECKPOINT_A,
            parentEvidenceDigest: bundles.evidence.evidenceDigest,
            mode: 448,
            expectedAbsence: true,
          }),
      );
      expect(created.kind).toBe("create_and_pin_completed");
      if (created.kind !== "create_and_pin_completed") {
        throw new Error("wrapper was not created");
      }
      createdId = created.handleId;
      createdEvidence = created.evidence;
      expect(points).toEqual([
        "atomic-create-mkdir",
        "atomic-create-open",
        "atomic-create-fstat",
      ]);
      expect(openFlags).toEqual([
        [
          "atomic-create-open",
          constants.O_RDONLY |
            constants.O_DIRECTORY |
            constants.O_NOFOLLOW,
          undefined,
        ],
      ]);
      for (const point of points) {
        expect(gates).toContain(`before:${point}`);
        expect(gates).toContain(`after:${point}`);
      }

      points.length = 0;
      openFlags.length = 0;
      const removed = await runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point.startsWith("atomic-")) points.push(point);
          },
          atomicOpenFlags(point, flags, mode) {
            openFlags.push([point, flags, mode]);
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "remove_root",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "wrapper",
            parentId: bundles.handleId,
            leaf: CHECKPOINT_A,
            objectId: created.handleId,
            expected: created.evidence,
            manifestSha256: sha("manifest"),
            cursor: 0,
          }),
      );
      expect(removed).toMatchObject({
        kind: "removal_observed",
        objectId: created.handleId,
        removedEvidence: created.evidence,
        state: "absent",
        parentSynced: true,
      });
      expect(points).toEqual([
        "atomic-remove-lstat",
        "atomic-remove-open",
        "atomic-remove-fstat",
        "atomic-remove-recheck",
        "atomic-remove-mutate",
        "atomic-remove-absence",
        "atomic-remove-parent-fsync",
      ]);
      expect(openFlags).toEqual([
        [
          "atomic-remove-open",
          constants.O_RDONLY |
            constants.O_DIRECTORY |
            constants.O_NOFOLLOW,
          undefined,
        ],
      ]);

      const closed = await applyAtomicEffect(lease.controller, {
        kind: "close_handle",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "wrapper",
        objectId: created.handleId,
        cursor: 0,
        byteLength: 0,
        expected: created.evidence,
      });
      expect(closed).toMatchObject({
        kind: "effect_completed",
        requestKind: "close_handle",
      });
    } finally {
      if (createdId !== undefined && createdEvidence !== undefined) {
        // A failed assertion must not leave the test's created wrapper behind.
        await rm(
          path.join(
            canonicalRoot,
            ".profile-publish-staging",
            "bundles",
            CHECKPOINT_A,
          ),
          { recursive: true, force: true },
        );
      }
      await closeAtomicEffectController(lease.controller).catch(() => undefined);
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("rejects strict-leaf and foreign semantic IDs before filesystem I/O", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const points: string[] = [];
    try {
      const invalidLeaf = await runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point.startsWith("atomic-create")) points.push(point);
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "create_and_pin_directory",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "payload_entry",
            parentId: bundles.handleId,
            leaf: "nested/leaf",
            parentEvidenceDigest: bundles.evidence.evidenceDigest,
            mode: 448,
            expectedAbsence: true,
          }),
      );
      expect(invalidLeaf).toMatchObject({
        kind: "effect_rejected",
        code: "binding_invalid",
      });
      expect(points).toEqual([]);

      const foreign = await applyAtomicEffect(lease.controller, {
        kind: "create_and_pin_directory",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "private_source",
        parentId: Object.freeze({}) as FlightSemanticId,
        leaf: "payload",
        parentEvidenceDigest: bundles.evidence.evidenceDigest,
        mode: 448,
        expectedAbsence: true,
      });
      expect(foreign).toMatchObject({
        kind: "effect_rejected",
        code: "binding_invalid",
      });
      expect(points).toEqual([]);
    } finally {
      await closeAtomicEffectController(lease.controller);
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("uses exact numeric file and temp creation flags", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    await applyAtomicEffect(lease.controller, {
      kind: "reserve_budget",
      effectId: atomicEffectId(),
      operationId: CHECKPOINT_A,
      reservation: "scratch_files",
      count: 1,
      byteSize: 0,
    });
    const observed: Array<readonly [string, number, number | undefined]> = [];
    try {
      for (const request of [
        {
          kind: "create_and_pin_file" as const,
          role: "payload_entry" as const,
          leaf: "payload-file",
        },
        {
          kind: "create_and_pin_temp_file" as const,
          role: "manifest_temp" as const,
          leaf: "manifest-temp",
        },
      ]) {
        const created = await runWithReconciliationFilesystemTestContext(
          {
            atomicOpenFlags(point, flags, mode) {
              observed.push([point, flags, mode]);
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              ...request,
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              parentId: bundles.handleId,
              parentEvidenceDigest: bundles.evidence.evidenceDigest,
              mode: 384,
              expectedAbsence: true,
            }),
        );
        expect(created.kind).toBe("create_and_pin_completed");
      }
      expect(observed).toEqual([
        [
          "atomic-create-open",
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        ],
        [
          "atomic-create-open",
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        ],
      ]);
    } finally {
      await closeAtomicEffectController(lease.controller);
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          "payload-file",
        ),
        { force: true },
      );
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          "manifest-temp",
        ),
        { force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("verifies the complete destination digest after atomic writes", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const bytes = Buffer.from("verified-result", "utf8");
    const leaves = ["write-valid", "write-invalid"] as const;
    try {
      const reserved = await applyAtomicEffect(lease.controller, {
        kind: "reserve_budget",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        reservation: "payload_bytes",
        count: 0,
        byteSize: bytes.byteLength,
      });
      expect(reserved.kind).toBe("effect_completed");

      const files = [];
      for (const leaf of leaves) {
        const created = await applyAtomicEffect(lease.controller, {
          kind: "create_and_pin_file",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          role: "payload_entry",
          parentId: bundles.handleId,
          leaf,
          parentEvidenceDigest: bundles.evidence.evidenceDigest,
          mode: 384,
          expectedAbsence: true,
        });
        if (created.kind !== "create_and_pin_completed") {
          throw new Error("atomic write destination was not created");
        }
        files.push(created);
      }

      const points: string[] = [];
      const completed = await runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point.startsWith("atomic-write")) points.push(point);
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "write_file_chunk",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            sourceFileId: null,
            destinationFileId: files[0]!.handleId,
            offset: 0,
            byteLength: bytes.byteLength,
            inlineBytes: bytes,
            expectedChunkSha256: sha(bytes),
            expectedResultSha256: sha(bytes),
          }),
      );
      expect(completed).toMatchObject({
        kind: "effect_completed",
        requestKind: "write_file_chunk",
      });
      expect(points).toEqual([
        "atomic-write-result-stat-before",
        "atomic-write-chunk",
        "atomic-write-result-stat-after",
        "atomic-write-result-read",
        "atomic-write-result-read",
        "atomic-write-result-final-stat",
      ]);
      expect(
        await readFile(
          path.join(
            canonicalRoot,
            ".profile-publish-staging",
            "bundles",
            leaves[0],
          ),
        ),
      ).toEqual(bytes);

      const rejected = await applyAtomicEffect(lease.controller, {
        kind: "write_file_chunk",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        sourceFileId: null,
        destinationFileId: files[1]!.handleId,
        offset: 0,
        byteLength: bytes.byteLength,
        inlineBytes: bytes,
        expectedChunkSha256: sha(bytes),
        expectedResultSha256: sha("forged-result"),
      });
      expect(rejected).toMatchObject({
        kind: "effect_rejected",
        code: "binding_invalid",
      });
      await expect(
        applyAtomicEffect(lease.controller, {
          kind: "reserve_budget",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          reservation: "payload_bytes",
          count: 0,
          byteSize: 1,
        }),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic publication controller is not live",
      });
    } finally {
      await closeAtomicEffectController(lease.controller).catch(() => undefined);
      for (const leaf of leaves) {
        await rm(
          path.join(
            canonicalRoot,
            ".profile-publish-staging",
            "bundles",
            leaf,
          ),
          { force: true },
        );
      }
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("enforces strict leaf boundaries before controller I/O", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const createdLeaves: string[] = [];
    try {
      for (const [role, leaf] of [
        ["wrapper", "a"],
        ["wrapper", `a${".".repeat(126)}z`],
        ["payload_entry", "x"],
        ["payload_entry", `${"é".repeat(127)}a`],
      ] as const) {
        const created = await applyAtomicEffect(lease.controller, {
          kind: "create_and_pin_directory",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          role,
          parentId: bundles.handleId,
          leaf,
          parentEvidenceDigest: bundles.evidence.evidenceDigest,
          mode: 448,
          expectedAbsence: true,
        });
        expect(created.kind).toBe("create_and_pin_completed");
        createdLeaves.push(leaf);
      }

      const points: string[] = [];
      for (const [role, leaf] of [
        ["wrapper", ""],
        ["wrapper", "."],
        ["wrapper", ".."],
        ["wrapper", "Upper"],
        ["wrapper", "-edge"],
        ["wrapper", "edge-"],
        ["wrapper", "bad!"],
        ["payload_entry", "bad/slash"],
        ["payload_entry", "bad\\slash"],
        ["payload_entry", "\0"],
        ["payload_entry", "e\u0301"],
        ["payload_entry", "\ud800"],
      ] as const) {
        const rejected = await runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (point.startsWith("atomic-create")) points.push(point);
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              kind: "create_and_pin_directory",
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              role,
              parentId: bundles.handleId,
              leaf,
              parentEvidenceDigest: bundles.evidence.evidenceDigest,
              mode: 448,
              expectedAbsence: true,
            }),
        );
        expect(rejected).toMatchObject({
          kind: "effect_rejected",
          code: "binding_invalid",
        });
      }
      expect(points).toEqual([]);
    } finally {
      await closeAtomicEffectController(lease.controller);
      for (const leaf of createdLeaves) {
        await rm(
          path.join(
            canonicalRoot,
            ".profile-publish-staging",
            "bundles",
            leaf,
          ),
          { recursive: true, force: true },
        );
      }
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("sanitizes rejected procfd operations and gates their rejection path", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const collision = path.join(
      canonicalRoot,
      ".profile-publish-staging",
      "bundles",
      CHECKPOINT_A,
    );
    await mkdir(collision, { mode: 0o700 });
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    const gates: string[] = [];
    try {
      const result = await runWithReconciliationFilesystemTestContext(
        {
          atomicGate(phase, point) {
            if (point === "atomic-create-mkdir") {
              gates.push(`${phase}:${point}`);
            }
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "create_and_pin_wrapper",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "wrapper",
            parentId: bundles.handleId,
            leaf: CHECKPOINT_A,
            parentEvidenceDigest: bundles.evidence.evidenceDigest,
            mode: 448,
            expectedAbsence: true,
          }),
      );
      expect(result).toMatchObject({
        kind: "effect_rejected",
        code: "conflict",
      });
      expect(JSON.stringify(result)).not.toContain("/proc/");
      expect(gates).toContain("before:atomic-create-mkdir");
      expect(gates).toContain("after:atomic-create-mkdir");
      expect(atomicHeldProfileHashImplementationIdentityForTest()).toBe(
        "reconciliation-private-held-profile-hash",
      );
    } finally {
      await closeAtomicEffectController(lease.controller);
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("reserves exact payload capacity before bounded directory discovery", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const payload = path.join(
      canonicalRoot,
      ".profile-publish-staging",
      "bundles",
      "payload",
    );
    await mkdir(payload, { mode: 0o700 });
    await writeFile(path.join(payload, "a"), "a", { mode: 0o600 });
    await writeFile(path.join(payload, "b"), "b", { mode: 0o600 });
    const expected = await atomicFileEvidence(payload, null);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    try {
      const opened = await applyAtomicEffect(lease.controller, {
        kind: "open_pin_handle",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "payload_entry",
        parentId: bundles.handleId,
        leaf: "payload",
        flags: "directory_nofollow",
        expected,
      });
      expect(opened.kind).toBe("existing_handle_pinned");
      if (opened.kind !== "existing_handle_pinned") {
        throw new Error("payload directory was not pinned");
      }
      const points: string[] = [];
      const unreserved = await runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (point.startsWith("atomic-enumerate")) points.push(point);
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "enumerate_directory",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "payload_entry",
            objectId: opened.handleId,
            cursor: 0,
            byteLength: 65_536,
            expected: opened.evidence,
          }),
      );
      expect(unreserved).toMatchObject({
        kind: "effect_rejected",
        code: "budget_exceeded",
      });
      expect(points).toEqual([]);

      for (const reservation of [
        {
          reservation: "payload_entries" as const,
          count: 257,
          byteSize: 0,
        },
        {
          reservation: "payload_bytes" as const,
          count: 0,
          byteSize: 65_536,
        },
      ]) {
        const reserved = await applyAtomicEffect(lease.controller, {
          kind: "reserve_budget",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          ...reservation,
        });
        expect(reserved.kind).toBe("effect_completed");
      }
      const failedEnumerationCloses: string[] = [];
      let enumerationFailureInjected = false;
      const failedEnumeration =
        await runWithReconciliationFilesystemTestContext(
          {
            atomicOperationCompleted(point) {
              if (
                !enumerationFailureInjected &&
                point === "atomic-enumerate-fstat"
              ) {
                enumerationFailureInjected = true;
                throw Object.assign(
                  new Error("injected enumeration fstat failure"),
                  { code: "EIO" },
                );
              }
            },
            handleClosed(point) {
              if (point.startsWith("atomic-enumerate-close")) {
                failedEnumerationCloses.push(point);
              }
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              kind: "enumerate_directory",
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              role: "payload_entry",
              objectId: opened.handleId,
              cursor: 0,
              byteLength: 65_536,
              expected: opened.evidence,
            }),
        );
      expect(failedEnumeration).toMatchObject({
        kind: "effect_rejected",
        code: "io",
      });
      expect(failedEnumerationCloses).toContain(
        "atomic-enumerate-close-provisional",
      );
      expect(enumerationFailureInjected).toBe(true);
      let streamBufferSize = 0;
      const observed = await runWithReconciliationFilesystemTestContext(
        {
          directoryStreamOpened(bufferSize) {
            streamBufferSize = bufferSize;
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "enumerate_directory",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "payload_entry",
            objectId: opened.handleId,
            cursor: 0,
            byteLength: 65_536,
            expected: opened.evidence,
          }),
      );
      expect(observed.kind).toBe("directory_observed");
      if (observed.kind !== "directory_observed") {
        throw new Error("payload directory was not observed");
      }
      expect(observed.entries.map((entry) => entry.leaf).sort()).toEqual([
        "a",
        "b",
      ]);
      expect(observed.done).toBe(true);
      expect(streamBufferSize).toBe(32);
      const payloadFile = observed.entries.find((entry) => entry.leaf === "a");
      if (payloadFile === undefined) {
        throw new Error("payload file was not discovered");
      }
      await applyAtomicEffect(lease.controller, {
        kind: "release_budget",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        reservation: "payload_bytes",
        count: 0,
        byteSize: 65_536,
      });
      await applyAtomicEffect(lease.controller, {
        kind: "reserve_budget",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        reservation: "manifest_bytes",
        count: 0,
        byteSize: 65_536,
      });
      const wrongCategoryPoints: string[] = [];
      const fileEvidence = await atomicFileEvidence(
        path.join(payload, "a"),
        null,
      );
      const wrongRead = await runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (
              point === "atomic-read-chunk" ||
              point === "atomic-hash-chunk"
            ) {
              wrongCategoryPoints.push(point);
            }
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "read_file_chunk",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "payload_entry",
            objectId: payloadFile.objectId,
            cursor: 0,
            byteLength: 1,
            expected: fileEvidence,
          }),
      );
      expect(wrongRead).toMatchObject({
        kind: "effect_rejected",
        code: "budget_exceeded",
      });
      const wrongHash = await runWithReconciliationFilesystemTestContext(
        {
          beforeCall(point) {
            if (
              point === "atomic-read-chunk" ||
              point === "atomic-hash-chunk"
            ) {
              wrongCategoryPoints.push(point);
            }
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "hash_content_chunk",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            objectId: payloadFile.objectId,
            offset: 0,
            byteLength: 1,
            evidenceDigest: payloadFile.evidenceDigest,
          }),
      );
      expect(wrongHash).toMatchObject({
        kind: "effect_rejected",
        code: "budget_exceeded",
      });
      expect(wrongCategoryPoints).toEqual([]);
    } finally {
      await closeAtomicEffectController(lease.controller);
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("defers an unverified enumeration stream close to shutdown", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const payload = path.join(
      canonicalRoot,
      ".profile-publish-staging",
      "bundles",
      "payload-close",
    );
    await mkdir(payload, { mode: 0o700 });
    const expected = await atomicFileEvidence(payload, null);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    let controllerClosed = false;
    try {
      const reserved = await applyAtomicEffect(lease.controller, {
        kind: "reserve_budget",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        reservation: "payload_bytes",
        count: 0,
        byteSize: 65_536,
      });
      expect(reserved.kind).toBe("effect_completed");
      const opened = await applyAtomicEffect(lease.controller, {
        kind: "open_pin_handle",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "payload_entry",
        parentId: bundles.handleId,
        leaf: "payload-close",
        flags: "directory_nofollow",
        expected,
      });
      if (opened.kind !== "existing_handle_pinned") {
        throw new Error("payload directory was not pinned");
      }

      let effectCloseAttempts = 0;
      const rejected = await runWithReconciliationFilesystemTestContext(
        {
          async closeOperation(point, close) {
            if (point === "atomic-enumerate-close-stream") {
              effectCloseAttempts += 1;
              throw new Error("injected enumeration stream close failure");
            }
            await close();
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "enumerate_directory",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "payload_entry",
            objectId: opened.handleId,
            cursor: 0,
            byteLength: 65_536,
            expected: opened.evidence,
          }),
      );
      expect(rejected).toMatchObject({
        kind: "effect_rejected",
        code: "close_unverified",
      });
      expect(effectCloseAttempts).toBe(1);

      let shutdownRetries = 0;
      await runWithReconciliationFilesystemTestContext(
        {
          async closeOperation(point, close) {
            if (point === "atomic-enumerate-retained-stream-close") {
              shutdownRetries += 1;
            }
            await close();
          },
        },
        () => closeAtomicEffectController(lease.controller),
      );
      controllerClosed = true;
      expect(shutdownRetries).toBe(1);
    } finally {
      if (!controllerClosed) {
        await closeAtomicEffectController(lease.controller).catch(
          () => undefined,
        );
      }
      await rm(payload, { recursive: true, force: true });
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("verifies held file bytes only after their exact reservation", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const payload = path.join(
      canonicalRoot,
      ".profile-publish-staging",
      "bundles",
      "payload",
    );
    const bytes = Buffer.from("held-content", "utf8");
    await mkdir(payload, { mode: 0o700 });
    await writeFile(path.join(payload, "content"), bytes, { mode: 0o600 });
    const directoryEvidence = await atomicFileEvidence(payload, null);
    const fileEvidence = await atomicFileEvidence(
      path.join(payload, "content"),
      sha(bytes),
    );
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    try {
      const directory = await applyAtomicEffect(lease.controller, {
        kind: "open_pin_handle",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "payload_entry",
        parentId: bundles.handleId,
        leaf: "payload",
        flags: "directory_nofollow",
        expected: directoryEvidence,
      });
      expect(directory.kind).toBe("existing_handle_pinned");
      if (directory.kind !== "existing_handle_pinned") {
        throw new Error("payload directory was not pinned");
      }
      await applyAtomicEffect(lease.controller, {
        kind: "reserve_budget",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        reservation: "manifest_bytes",
        count: 0,
        byteSize: bytes.byteLength,
      });
      const unreserved = await applyAtomicEffect(lease.controller, {
        kind: "open_pin_handle",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "payload_entry",
        parentId: directory.handleId,
        leaf: "content",
        flags: "file_read_nofollow",
        expected: fileEvidence,
      });
      expect(unreserved).toMatchObject({
        kind: "effect_rejected",
        code: "budget_exceeded",
      });
      await applyAtomicEffect(lease.controller, {
        kind: "reserve_budget",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        reservation: "payload_bytes",
        count: 0,
        byteSize: bytes.byteLength,
      });
      const existingFlags: number[] = [];
      const opened = await runWithReconciliationFilesystemTestContext(
        {
          atomicOpenFlags(point, flags) {
            if (point === "atomic-open-existing") {
              existingFlags.push(flags);
            }
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "open_pin_handle",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "payload_entry",
            parentId: directory.handleId,
            leaf: "content",
            flags: "file_read_nofollow",
            expected: fileEvidence,
          }),
      );
      expect(opened).toMatchObject({
        kind: "existing_handle_pinned",
        evidence: fileEvidence,
      });
      expect(existingFlags).toEqual([
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ]);
      if (opened.kind !== "existing_handle_pinned") {
        throw new Error("payload file was not pinned");
      }
      const readFailure =
        await runWithReconciliationFilesystemTestContext(
          {
            atomicOperationCompleted(point) {
              if (point === "atomic-read-chunk") {
                throw Object.assign(
                  new Error("private read path"),
                  { code: "EIO", path: "/proc/self/fd/secret" },
                );
              }
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              kind: "read_file_chunk",
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              role: "payload_entry",
              objectId: opened.handleId,
              cursor: 0,
              byteLength: bytes.byteLength,
              expected: opened.evidence,
            }),
        );
      expect(readFailure).toMatchObject({
        kind: "effect_rejected",
        code: "io",
      });
      expect(JSON.stringify(readFailure)).not.toContain("/proc/");

      const hashFailure =
        await runWithReconciliationFilesystemTestContext(
          {
            atomicOperationCompleted(point) {
              if (point === "atomic-hash-chunk") {
                throw Object.assign(
                  new Error("private hash path"),
                  { code: "ENOSPC", path: "/proc/self/fd/secret" },
                );
              }
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              kind: "hash_content_chunk",
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              objectId: opened.handleId,
              offset: 0,
              byteLength: bytes.byteLength,
              evidenceDigest: opened.evidence.evidenceDigest,
            }),
        );
      expect(hashFailure).toMatchObject({
        kind: "effect_rejected",
        code: "io",
      });
      expect(JSON.stringify(hashFailure)).not.toContain("/proc/");

      await applyAtomicEffect(lease.controller, {
        kind: "close_handle",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "payload_entry",
        objectId: opened.handleId,
        cursor: 0,
        byteLength: 0,
        expected: opened.evidence,
      });

      const forgedValue = {
        ...fileEvidence,
        contentSha256: sha("forged"),
      };
      const forged = Object.freeze({
        ...forgedValue,
        evidenceDigest: sha(
          JSON.stringify({
            dev: forgedValue.dev,
            ino: forgedValue.ino,
            mode: forgedValue.mode,
            size: forgedValue.size,
            contentSha256: forgedValue.contentSha256,
          }),
        ),
      });
      const rejected = await applyAtomicEffect(lease.controller, {
        kind: "open_pin_handle",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "payload_entry",
        parentId: directory.handleId,
        leaf: "content",
        flags: "file_read_nofollow",
        expected: forged,
      });
      expect(rejected).toMatchObject({
        kind: "effect_rejected",
        code: "binding_invalid",
      });

      const unknownSync =
        runWithReconciliationFilesystemTestContext(
          {
            atomicGate(phase, point) {
              if (phase === "before" && point === "atomic-revalidate") {
                throw Object.assign(
                  new Error("secret revalidation path"),
                  {
                    code: "EUNKNOWN",
                    path: "/proc/self/fd/secret",
                  },
                );
              }
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              kind: "revalidate_handle",
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              role: "payload_entry",
              objectId: directory.handleId,
              cursor: 0,
              byteLength: 0,
              expected: directory.evidence,
            }),
        );
      await expect(unknownSync).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic publication filesystem operation failed",
      });
      await expect(unknownSync).rejects.not.toHaveProperty("cause");
      await expect(
        applyAtomicEffect(lease.controller, {
          kind: "reserve_budget",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          reservation: "payload_bytes",
          count: 0,
          byteSize: 1,
        }),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic publication controller is not live",
      });
    } finally {
      await closeAtomicEffectController(lease.controller);
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("retains post-gate create authority until partial cleanup", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    try {
      const partial = await runWithReconciliationFilesystemTestContext(
        {
          afterCall(point) {
            if (point === "atomic-create-mkdir") {
              throw new Error("injected post-create gate failure");
            }
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "create_and_pin_wrapper",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "wrapper",
            parentId: bundles.handleId,
            leaf: CHECKPOINT_A,
            parentEvidenceDigest: bundles.evidence.evidenceDigest,
            mode: 448,
            expectedAbsence: true,
          }),
      );
      expect(partial).toMatchObject({
        kind: "create_and_pin_partial",
        stage: "entry_created",
        entryCreated: true,
        handleOpened: false,
      });
      if (partial.kind !== "create_and_pin_partial") {
        throw new Error("partial create authority was not returned");
      }
      const cleaned = await applyAtomicEffect(lease.controller, {
        kind: "cleanup_partial_create",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        partialId: partial.partialId,
      });
      expect(cleaned).toMatchObject({
        kind: "partial_create_cleanup_observed",
        state: "absent",
        parentSynced: true,
      });
    } finally {
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_A,
        ),
        { recursive: true, force: true },
      );
      await closeAtomicEffectController(lease.controller);
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("sanitizes unknown errno after creation and closes admission", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    try {
      const partial = await runWithReconciliationFilesystemTestContext(
        {
          atomicOperationCompleted(point) {
            if (point === "atomic-create-open") {
              throw Object.assign(
                new Error("secret /proc/self/fd/999 path"),
                {
                  code: "EUNKNOWN",
                  path: "/proc/self/fd/999/secret",
                },
              );
            }
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "create_and_pin_file",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "payload_entry",
            parentId: bundles.handleId,
            leaf: "unknown-errno",
            parentEvidenceDigest: bundles.evidence.evidenceDigest,
            mode: 384,
            expectedAbsence: true,
          }),
      );
      expect(partial).toMatchObject({
        kind: "create_and_pin_partial",
        code: "io",
      });
      expect(JSON.stringify(partial)).not.toContain("/proc/");
      expect(JSON.stringify(partial)).not.toContain("secret");
      await expect(
        applyAtomicEffect(lease.controller, {
          kind: "reserve_budget",
          effectId: atomicEffectId(),
          operationId: CHECKPOINT_A,
          reservation: "payload_bytes",
          count: 0,
          byteSize: 1,
        }),
      ).rejects.toMatchObject({
        category: "reconciliation_filesystem_unsafe",
        message: "atomic publication controller is not live",
      });
      if (partial.kind !== "create_and_pin_partial") {
        throw new Error("partial create authority was not returned");
      }
      const cleaned = await applyAtomicEffect(lease.controller, {
        kind: "cleanup_partial_create",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        partialId: partial.partialId,
      });
      expect(cleaned.kind).toBe("partial_create_cleanup_observed");
    } finally {
      await closeAtomicEffectController(lease.controller);
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          "unknown-errno",
        ),
        { force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("fail-stops on unverified close and retries ownership at shutdown", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    try {
      const created = await applyAtomicEffect(lease.controller, {
        kind: "create_and_pin_wrapper",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "wrapper",
        parentId: bundles.handleId,
        leaf: CHECKPOINT_A,
        parentEvidenceDigest: bundles.evidence.evidenceDigest,
        mode: 448,
        expectedAbsence: true,
      });
      if (created.kind !== "create_and_pin_completed") {
        throw new Error("wrapper was not created");
      }
      const rejected = await runWithReconciliationFilesystemTestContext(
        {
          closeOperation(point) {
            if (point === "atomic-close") {
              throw new Error("injected close rejection");
            }
            throw new Error("unexpected close operation");
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "close_handle",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "wrapper",
            objectId: created.handleId,
            cursor: 0,
            byteLength: 0,
            expected: created.evidence,
          }),
      );
      expect(rejected).toMatchObject({
        kind: "effect_rejected",
        code: "close_unverified",
      });
    } finally {
      await closeAtomicEffectController(lease.controller);
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_A,
        ),
        { recursive: true, force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test("prioritizes failed removal close and retains its pin for shutdown", async () => {
    const canonicalRoot = await root();
    await provisionAtomicNamespaces(canonicalRoot);
    const installed = await installedProfileRoot(canonicalRoot);
    const lease = await acquireAtomicPreReadyRecoveryAuthority(
      installed.root,
      CHECKPOINT_A,
    );
    const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
    let controllerClosed = false;
    try {
      const created = await applyAtomicEffect(lease.controller, {
        kind: "create_and_pin_wrapper",
        effectId: atomicEffectId(),
        operationId: CHECKPOINT_A,
        role: "wrapper",
        parentId: bundles.handleId,
        leaf: CHECKPOINT_A,
        parentEvidenceDigest: bundles.evidence.evidenceDigest,
        mode: 448,
        expectedAbsence: true,
      });
      if (created.kind !== "create_and_pin_completed") {
        throw new Error("wrapper was not created");
      }
      const rejected = await runWithReconciliationFilesystemTestContext(
        {
          atomicOperationCompleted(point) {
            if (point === "atomic-remove-fstat") {
              throw Object.assign(
                new Error("injected primary removal failure"),
                { code: "EIO" },
              );
            }
          },
          async closeOperation(point, close) {
            if (point === "atomic-remove-final-close") {
              throw new Error("injected removal close failure");
            }
            await close();
          },
        },
        () =>
          applyAtomicEffect(lease.controller, {
            kind: "remove_root",
            effectId: atomicEffectId(),
            operationId: CHECKPOINT_A,
            role: "wrapper",
            parentId: bundles.handleId,
            leaf: CHECKPOINT_A,
            objectId: created.handleId,
            expected: created.evidence,
            manifestSha256: sha("manifest"),
            cursor: 0,
          }),
      );
      expect(rejected).toMatchObject({
        kind: "effect_rejected",
        code: "close_unverified",
      });

      const retriedCloses: string[] = [];
      await runWithReconciliationFilesystemTestContext(
        {
          handleClosed(point) {
            retriedCloses.push(point);
          },
        },
        () => closeAtomicEffectController(lease.controller),
      );
      controllerClosed = true;
      expect(retriedCloses).toContain("atomic-remove-retained-close");
    } finally {
      if (!controllerClosed) {
        await closeAtomicEffectController(lease.controller).catch(
          () => undefined,
        );
      }
      await rm(
        path.join(
          canonicalRoot,
          ".profile-publish-staging",
          "bundles",
          CHECKPOINT_A,
        ),
        { recursive: true, force: true },
      );
      await closeAnchoredProfileRoot(installed.root);
    }
  });

  test.each([
    ["close", "atomic-partial-close"],
    ["identity_verify", "atomic-partial-lstat"],
    ["remove", "atomic-partial-remove"],
    ["absence_verify", "atomic-partial-absence"],
    ["parent_fsync", "atomic-partial-parent-fsync"],
  ] as const)(
    "reports exact %s partial-cleanup failure",
    async (expectedStage, failurePoint) => {
      const canonicalRoot = await root();
      await provisionAtomicNamespaces(canonicalRoot);
      const installed = await installedProfileRoot(canonicalRoot);
      const lease = await acquireAtomicPreReadyRecoveryAuthority(
        installed.root,
        CHECKPOINT_A,
      );
      const bundles = await openAtomicBundlesParent(lease, canonicalRoot);
      const leaf =
        expectedStage === "close" ? "partial-file" : "partial-directory";
      try {
        const partial = await runWithReconciliationFilesystemTestContext(
          {
            afterCall(point) {
              if (
                point ===
                (expectedStage === "close"
                  ? "atomic-create-fstat"
                  : "atomic-create-mkdir")
              ) {
                throw new Error("injected partial create boundary");
              }
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              kind:
                expectedStage === "close"
                  ? "create_and_pin_file"
                  : "create_and_pin_directory",
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              role: "payload_entry",
              parentId: bundles.handleId,
              leaf,
              parentEvidenceDigest: bundles.evidence.evidenceDigest,
              mode: expectedStage === "close" ? 384 : 448,
              expectedAbsence: true,
            }),
        );
        if (partial.kind !== "create_and_pin_partial") {
          throw new Error("partial create authority was not returned");
        }
        const failed = await runWithReconciliationFilesystemTestContext(
          {
            beforeCall(point) {
              if (
                failurePoint !== "atomic-partial-close" &&
                point === failurePoint
              ) {
                throw new Error("injected partial cleanup failure");
              }
            },
            closeOperation(point, close) {
              if (
                failurePoint === "atomic-partial-close" &&
                point === failurePoint
              ) {
                throw new Error("injected partial close failure");
              }
              return close();
            },
          },
          () =>
            applyAtomicEffect(lease.controller, {
              kind: "cleanup_partial_create",
              effectId: atomicEffectId(),
              operationId: CHECKPOINT_A,
              partialId: partial.partialId,
            }),
        );
        expect(failed).toMatchObject({
          kind: "partial_create_cleanup_failed",
          stage: expectedStage,
          parentSynced: false,
        });
      } finally {
        await closeAtomicEffectController(lease.controller);
        await rm(
          path.join(
            canonicalRoot,
            ".profile-publish-staging",
            "bundles",
            leaf,
          ),
          { recursive: true, force: true },
        );
        await closeAnchoredProfileRoot(installed.root);
      }
    },
  );
});
