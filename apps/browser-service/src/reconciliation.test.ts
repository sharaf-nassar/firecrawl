import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
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

import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  ReconciliationReferenceV1,
  ReconciliationRequestV1,
} from "./contracts.js";
import { BrowserServiceError } from "./errors.js";
import {
  canonicalizeReconciliationSnapshot,
  canonicalizeProfileTree,
  reconcileBrowserState,
  runWithReconciliationFilesystemTestContext,
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
  const target = path.join(canonicalRoot, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600 });
  if (old) await utimes(target, OLD, OLD);
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
          if (property === "dev" && isDirectory) {
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
