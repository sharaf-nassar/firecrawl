import {
  existsSync,
  readdirSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { BrowserServiceError } from "./errors.js";
import {
  createProfileStore,
  writeProfileFixtureFile,
  type ProfileGenerationAuthority,
} from "./profile-store.js";
import {
  canonicalizeReconciliationSnapshot,
  closeAnchoredProfileRoot,
  consumeInternalReconciliationOutcome,
  reconcileBrowserStateWithAuthority,
  runWithReconciliationFilesystemTestContext,
  type AnchoredProfileRoot,
  type ReadyProfileRootBinding,
} from "./reconciliation.js";
import type { ReconciliationExecutionAdmission } from "./startup-state.js";

const PROCESS = Buffer.alloc(32, 14).toString("base64url");
const CONTROL = Buffer.alloc(32, 15).toString("base64url");
const PROFILE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const GENERATIONS = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
const DURABLE_FILESYSTEM_TEST_TIMEOUT_MS = 15_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function admission(controller: AbortController): ReconciliationExecutionAdmission {
  return {
    signal: controller.signal,
    assertAdmitted() {
      if (controller.signal.aborted) {
        throw new BrowserServiceError(
          "reconciliation_required",
          "reconciliation is not admitted",
        );
      }
    },
  };
}

function errorChainHasCategory(error: unknown, category: string): boolean {
  if (error === null || typeof error !== "object") return false;
  if ("category" in error && error.category === category) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => errorChainHasCategory(nested, category));
  }
  return "cause" in error && errorChainHasCategory(error.cause, category);
}

async function harness(randomBytes?: (size: number) => Buffer) {
  const stateRoot = await mkdtemp(join(tmpdir(), "profile-store-held-"));
  await chmod(stateRoot, 0o700);
  roots.push(stateRoot);
  const controller = new AbortController();
  const snapshot = canonicalizeReconciliationSnapshot([]);
  const request = {
    version: 1 as const,
    processNonce: PROCESS,
    controlGenerationNonce: CONTROL,
    snapshotDigest: snapshot.snapshotDigest,
    references: [],
  };
  const binding: ReadyProfileRootBinding = Object.freeze({
    processNonce: PROCESS,
    controlGenerationNonce: CONTROL,
    snapshotDigest: snapshot.snapshotDigest,
  });
  const outcome = await reconcileBrowserStateWithAuthority(stateRoot, request, {
    admission: admission(controller),
  });
  let root: AnchoredProfileRoot | undefined;
  await consumeInternalReconciliationOutcome(
    outcome,
    binding,
    async (install) => {
      root = install.root;
    },
  );
  if (root === undefined) throw new Error("authority installation failed");
  let index = 0;
  const store = await createProfileStore({
    root,
    binding,
    randomUUID: () => GENERATIONS[index++]!,
    ...(randomBytes === undefined ? {} : { randomBytes }),
  });
  return { controller, root, stateRoot, store };
}

async function heldDescriptorCount(stateRoot: string): Promise<number> {
  const descriptors = await readdir("/proc/self/fd");
  const targets = await Promise.all(
    descriptors.map((descriptor) =>
      readlink(`/proc/self/fd/${descriptor}`).catch(() => ""),
    ),
  );
  return targets.filter((target) => target.startsWith(stateRoot)).length;
}

describe("held profile publication", () => {
  test.each(
    (["create", "prepare", "finalize", "remove"] as const).flatMap((operation) =>
      (["before", "after"] as const).map((edge) => [operation, edge] as const),
    ),
  )(
    "aborts ProfileStore %s at the %s-await admission edge",
    async (operation, edge) => {
      const { controller, root, stateRoot, store } = await harness();
      let work: Awaited<ReturnType<typeof store.createWorkingCopy>> | undefined;
      let prepared: Awaited<ReturnType<typeof store.prepareWorkingCopy>> | undefined;
      if (operation !== "create") {
        work = await store.createWorkingCopy(
          PROFILE,
          null,
          operation === "remove" ? "snapshot" : "writer",
          SESSION,
        );
        if (operation !== "remove") {
          await writeProfileFixtureFile(work, "Preferences", "trusted");
        }
        if (operation === "finalize") {
          prepared = await store.prepareWorkingCopy(work);
        }
      }
      const point =
        operation === "create"
          ? "profile-mkdir-generation"
          : operation === "prepare"
            ? "held-profile-sync"
            : operation === "finalize"
              ? "atomic-transition-source-read"
              : "held-remove-tombstone-rename";
      let aborted = false;
      let callsAfterAbort = 0;
      const execute = () => {
        if (operation === "create")
          return store.createWorkingCopy(PROFILE, null, "snapshot", SESSION);
        if (operation === "prepare") return store.prepareWorkingCopy(work!);
        if (operation === "finalize")
          return store.finalizePreparedGeneration(prepared!);
        return store.discardWorkingCopy(work!);
      };
      let rejection: unknown;
      try {
        await runWithReconciliationFilesystemTestContext(
          {
            beforeCall(candidate) {
              if (controller.signal.aborted) callsAfterAbort += 1;
              if (!aborted && edge === "before" && candidate === point) {
                aborted = true;
                controller.abort();
              }
            },
            afterCall(candidate) {
              if (!aborted && edge === "after" && candidate === point) {
                aborted = true;
                controller.abort();
              }
            },
          },
          execute,
        );
      } catch (error) {
        rejection = error;
      }
      expect(aborted).toBe(true);
      expect(errorChainHasCategory(rejection, "reconciliation_required")).toBe(
        true,
      );
      expect(callsAfterAbort).toBe(0);
      if (operation === "create") {
        expect(
          await readdir(join(stateRoot, "profiles", PROFILE, "working")),
        ).toEqual([]);
      } else if (operation === "remove") {
        expect(
          await readdir(join(stateRoot, "profiles", PROFILE, "working")),
        ).toEqual([
          edge === "before"
            ? GENERATIONS[0]!
            : `.${GENERATIONS[0]!}.deleting`,
        ]);
      }
      await store.close();
      await closeAnchoredProfileRoot(root);
    },
  );

  test("publishes a non-empty writer without exposing a path", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    expect(work).not.toHaveProperty("path");
    await writeProfileFixtureFile(work, "Cookies", "state");

    const prepared = await store.prepareWorkingCopy(work);
    expect(await store.hasCommitted(prepared.generationId)).toBe(false);
    const finalized = await store.finalizePreparedGeneration(prepared);
    expect(finalized).toMatchObject({ committed: true, checksum: prepared.checksum });
    expect(await store.hasCommitted(prepared.generationId)).toBe(true);
    expect(await store.finalizePreparedGeneration(prepared)).toBe(finalized);

    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("redeems a transport-shaped prepared authorization exactly once", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Cookies", "state");
    const prepared = await store.prepareWorkingCopy(work);
    const authorization = {
      profileId: prepared.profileId,
      generationId: prepared.generationId,
      checksum: prepared.checksum,
      prepareToken: prepared.prepareToken,
    };

    const [first, second] = await Promise.all([
      store.finalizePreparedGenerationByAuthorization({ ...authorization }),
      store.finalizePreparedGenerationByAuthorization({ ...authorization }),
    ]);
    expect(second).toBe(first);
    expect(first).toMatchObject({ committed: true, checksum: prepared.checksum });
    expect(await store.hasCommitted(prepared.generationId)).toBe(true);

    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("rejects forged transport authorization before publication", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Cookies", "state");
    const prepared = await store.prepareWorkingCopy(work);

    await expect(
      store.finalizePreparedGenerationByAuthorization({
        profileId: prepared.profileId,
        generationId: prepared.generationId,
        checksum: prepared.checksum,
        prepareToken: Buffer.alloc(32, 99).toString("base64url"),
      }),
    ).rejects.toMatchObject({ category: "profile_finalize_failed" });
    expect(await store.hasCommitted(prepared.generationId)).toBe(false);
    expect(await store.listStaging()).toEqual([prepared.generationId]);

    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("deletes exact staged and finalized generations through authorization", async () => {
    const { root, store } = await harness();
    const stagedWork = await store.createWorkingCopy(
      PROFILE,
      null,
      "writer",
      SESSION,
    );
    await writeProfileFixtureFile(stagedWork, "Cookies", "staged");
    const staged = await store.prepareWorkingCopy(stagedWork);
    const stagedAuthorization = {
      profileId: staged.profileId,
      generationId: staged.generationId,
      checksum: staged.checksum,
      prepareToken: staged.prepareToken,
    };
    const stagedDeleted =
      await store.deletePreparedGenerationByAuthorization(stagedAuthorization);
    expect(stagedDeleted).toMatchObject({ deleted: true });
    expect(
      await store.deletePreparedGenerationByAuthorization(stagedAuthorization),
    ).toBe(stagedDeleted);
    expect(await store.listStaging()).toEqual([]);

    const committedWork = await store.createWorkingCopy(
      PROFILE,
      null,
      "writer",
      SESSION,
    );
    await writeProfileFixtureFile(committedWork, "Cookies", "committed");
    const committed = await store.prepareWorkingCopy(committedWork);
    const committedAuthorization = {
      profileId: committed.profileId,
      generationId: committed.generationId,
      checksum: committed.checksum,
      prepareToken: committed.prepareToken,
    };
    await store.finalizePreparedGenerationByAuthorization(
      committedAuthorization,
    );
    const committedDeleted =
      await store.deletePreparedGenerationByAuthorization(
        committedAuthorization,
      );
    expect(committedDeleted).toMatchObject({ deleted: true });
    expect(await store.listCommitted()).toEqual([]);

    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("moves prepare and finalize sources private before returning", async () => {
    const { root, stateRoot, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Cookies", "state");
    const observations: Array<{
      sourceGone: boolean;
      privateDeletionHeld: boolean;
    }> = [];
    const moves: string[] = [];

    await runWithReconciliationFilesystemTestContext(
      {
        atomicNativeBarrier(phase, move) {
          if (phase !== "after") return;
          moves.push(move);
          if (move !== "profile_source_to_private") return;
          const sourceState =
            observations.length === 0 ? "working" : "staging";
          const bundles = join(
            stateRoot,
            ".profile-publish-staging",
            "bundles",
          );
          const privateDeletionHeld = readdirSync(bundles).some(
            (operationId) =>
              existsSync(
                join(
                  bundles,
                  operationId,
                  `delete-${operationId}`,
                ),
              ),
          );
          observations.push({
            sourceGone: !existsSync(
              join(
                stateRoot,
                "profiles",
                PROFILE,
                sourceState,
                work.generationId,
              ),
            ),
            privateDeletionHeld,
          });
        },
      },
      async () => {
        const prepared = await store.prepareWorkingCopy(work);
        await store.finalizePreparedGeneration(prepared);
      },
    );

    expect(observations).toEqual([
      { sourceGone: true, privateDeletionHeld: true },
      { sourceGone: true, privateDeletionHeld: true },
    ]);
    expect(
      moves.filter((move) => move === "profile_source_to_private"),
    ).toHaveLength(2);
    expect(moves.filter((move) => move === "profile_publish")).toHaveLength(2);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("fail-stops when execution aborts after protected source move", async () => {
    const { root, stateRoot, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Cookies", "state");
    let injected = false;

    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          atomicNativeBarrier(phase, move) {
            if (
              !injected &&
              phase === "after" &&
              move === "profile_source_to_private"
            ) {
              injected = true;
              throw new Error("injected post-source-move abort");
            }
          },
        },
        () => store.prepareWorkingCopy(work),
      ),
    ).rejects.toMatchObject({ category: "profile_prepare_failed" });

    expect(injected).toBe(true);
    expect(
      existsSync(
        join(
          stateRoot,
          "profiles",
          PROFILE,
          "working",
          work.generationId,
        ),
      ),
    ).toBe(false);
    await expect(
      store.createWorkingCopy(PROFILE, null, "snapshot", SESSION),
    ).rejects.toBeDefined();
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("finalize closes live generations and keeps only bounded retry evidence", async () => {
    const { root, stateRoot, store } = await harness();
    const baseline = await heldDescriptorCount(stateRoot);
    const finalized = [];
    for (let index = 0; index < 3; index += 1) {
      const work = await store.createWorkingCopy(
        PROFILE,
        null,
        "writer",
        SESSION,
      );
      await writeProfileFixtureFile(work, "Preferences", String(index));
      const prepared = await store.prepareWorkingCopy(work);
      const result = await store.finalizePreparedGeneration(prepared);
      expect(await store.finalizePreparedGeneration(prepared)).toBe(result);
      expect(() => store.workingGeneration(work)).toThrow();
      expect(await heldDescriptorCount(stateRoot)).toBe(baseline);
      finalized.push(result);
    }
    expect(finalized).toHaveLength(3);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("retries an unverified committed capability close", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Preferences", "trusted");
    const prepared = await store.prepareWorkingCopy(work);
    let injected = false;
    let generationCloses = 0;
    await expect(
      runWithReconciliationFilesystemTestContext(
        {
          async closeOperation(point, close) {
            if (
              point === "generation" &&
              ++generationCloses === 2 &&
              !injected
            ) {
              injected = true;
              throw new Error("injected generation close failure");
            }
            await close();
          },
        },
        () => store.finalizePreparedGeneration(prepared),
      ),
    ).rejects.toMatchObject({
      category: "profile_finalize_failed",
      cleanupUnverified: true,
      retainedWork: work,
    });
    const finalized = await store.finalizePreparedGeneration(prepared);
    expect(await store.finalizePreparedGeneration(prepared)).toBe(finalized);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("rejects an empty writer before staging or publication", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await expect(store.prepareWorkingCopy(work)).rejects.toMatchObject({
      category: "browser_unavailable",
      detail: "profile_schema_empty",
    });
    expect(await store.listWorking()).toEqual([work.generationId]);
    expect(await store.listStaging()).toEqual([]);
    expect(await store.listCommitted()).toEqual([]);
    await store.discardWorkingCopy(work);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("rejects a prepare-token source that is not exactly 32 bytes", async () => {
    const { root, store } = await harness(() => Buffer.alloc(31));
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Cookies", "state");
    await expect(store.prepareWorkingCopy(work)).rejects.toMatchObject({
      category: "profile_prepare_failed",
      cause: { message: "randomBytes must return exactly 32 bytes" },
    });
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("copies only a committed base into a new empty working generation", async () => {
    const { root, store } = await harness();
    const first = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(first, "Preferences", "trusted");
    const prepared = await store.prepareWorkingCopy(first);
    await store.finalizePreparedGeneration(prepared);
    const base: ProfileGenerationAuthority = {
      generationId: prepared.generationId,
      statePath: `profiles/${PROFILE}/committed/${prepared.generationId}`,
      checksum: prepared.checksum,
    };

    const second = await store.createWorkingCopy(PROFILE, base, "writer", SESSION);
    const copied = await store.prepareWorkingCopy(second);
    expect(copied.checksum).toBe(prepared.checksum);
    await store.finalizePreparedGeneration(copied);
    expect(await store.listCommitted()).toEqual([
      first.generationId,
      second.generationId,
    ]);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("rejects mismatched committed authority tuples before copy", async () => {
    const { root, store } = await harness();
    for (const base of [
      {
        generationId: GENERATIONS[1]!,
        statePath: `profiles/${PROFILE}/working/${GENERATIONS[1]}`,
        checksum: "a".repeat(64),
      },
      {
        generationId: GENERATIONS[1]!,
        statePath: `profiles/${SESSION}/committed/${GENERATIONS[1]}`,
        checksum: "a".repeat(64),
      },
      {
        generationId: GENERATIONS[1]!,
        statePath: `profiles/${PROFILE}/committed/${GENERATIONS[2]}`,
        checksum: "a".repeat(64),
      },
    ]) {
      await expect(
        store.createWorkingCopy(PROFILE, base, "writer", SESSION),
      ).rejects.toMatchObject({ category: "profile_prepare_failed" });
    }
    expect(await store.listWorking()).toEqual([]);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("snapshot generations cannot prepare and are removed explicitly", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "snapshot", SESSION);
    await expect(store.prepareWorkingCopy(work)).rejects.toMatchObject({
      category: "profile_prepare_failed",
    });
    await store.discardWorkingCopy(work);
    await expect(store.discardWorkingCopy(work)).rejects.toMatchObject({
      category: "profile_prepare_failed",
    });
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("runtime-authenticates work and prepared tokens", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Preferences", "trusted");
    const prepared = await store.prepareWorkingCopy(work);
    await expect(
      store.finalizePreparedGeneration({ ...prepared } as typeof prepared),
    ).rejects.toMatchObject({ category: "profile_finalize_failed" });
    await expect(
      store.prepareWorkingCopy({ ...work } as typeof work),
    ).rejects.toMatchObject({ category: "profile_prepare_failed" });
    await store.finalizePreparedGeneration(prepared);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("never uses the legacy public state-transition mutation", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Preferences", "trusted");
    let legacyMutationCalled = false;
    await runWithReconciliationFilesystemTestContext(
      {
        beforeCall(point) {
          if (
            point === "profile-state-transition" ||
            point === "profile-transition-generation-lstat"
          ) {
            legacyMutationCalled = true;
          }
        },
      },
      async () => {
        const prepared = await store.prepareWorkingCopy(work);
        await store.finalizePreparedGeneration(prepared);
      },
    );
    expect(legacyMutationCalled).toBe(false);
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test.each([
    "held-copy-mkdir",
    "held-copy-create-file",
    "held-copy-write",
    "held-copy-file-parent-sync",
  ])("recovers a partial working copy after %s crash", async (crashPoint) => {
    const { root, stateRoot, store } = await harness();
    const baseWork = await store.createWorkingCopy(
      PROFILE,
      null,
      "writer",
      SESSION,
    );
    const nested = join(
      stateRoot,
      "profiles",
      PROFILE,
      "working",
      baseWork.generationId,
      "Default",
    );
    await mkdir(nested, { recursive: true, mode: 0o700 });
    await writeFile(join(nested, "Preferences"), "trusted", { mode: 0o600 });
    const prepared = await store.prepareWorkingCopy(baseWork);
    await store.finalizePreparedGeneration(prepared);
    const base: ProfileGenerationAuthority = {
      generationId: prepared.generationId,
      statePath: `profiles/${PROFILE}/committed/${prepared.generationId}`,
      checksum: prepared.checksum,
    };
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
        () => store.createWorkingCopy(PROFILE, base, "writer", SESSION),
      ),
    ).rejects.toBeDefined();
    expect(injected).toBe(true);
    expect(await store.listWorking()).toEqual([]);

    const recovered = await store.createWorkingCopy(
      PROFILE,
      base,
      "writer",
      SESSION,
    );
    await expect(store.prepareWorkingCopy(recovered)).resolves.toMatchObject({
      checksum: prepared.checksum,
    });
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test.each(
    (["create", "canonicalize", "sync", "copy", "transition"] as const).flatMap((operation) =>
      (["root", "profiles", "profile", "state", "generation"] as const).map(
        (component) => [operation, component] as const,
      ),
    ).filter(
      ([operation]) =>
        operation !== "canonicalize" && operation !== "transition",
    ),
  )(
    "propagates ProfileStore %s rejection across a %s hierarchy replacement",
    async (operation, component) => {
      const { root, stateRoot, store } = await harness();
      let work: Awaited<ReturnType<typeof store.createWorkingCopy>> | undefined;
      let prepared: Awaited<ReturnType<typeof store.prepareWorkingCopy>> | undefined;
      let base: ProfileGenerationAuthority | null = null;
      if (operation === "copy") {
        const baseWork = await store.createWorkingCopy(
          PROFILE,
          null,
          "writer",
          SESSION,
        );
        await writeProfileFixtureFile(baseWork, "Preferences", "trusted");
        const basePrepared = await store.prepareWorkingCopy(baseWork);
        await store.finalizePreparedGeneration(basePrepared);
        base = {
          generationId: basePrepared.generationId,
          statePath: `profiles/${PROFILE}/committed/${basePrepared.generationId}`,
          checksum: basePrepared.checksum,
        };
      } else if (operation !== "create") {
        work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
        await writeProfileFixtureFile(work, "Preferences", "trusted");
        if (operation === "transition") {
          prepared = await store.prepareWorkingCopy(work);
        } else if (operation === "canonicalize") {
          let crashed = false;
          await expect(
            runWithReconciliationFilesystemTestContext(
              {
                afterCall(point) {
                  if (!crashed && point === "profile-state-transition") {
                    crashed = true;
                    throw new Error("crash after staging rename");
                  }
                },
              },
              () => store.prepareWorkingCopy(work!),
            ),
          ).rejects.toMatchObject({ category: "profile_prepare_failed" });
          expect(crashed).toBe(true);
        }
      }
      const generationId =
        operation === "copy" ? base!.generationId : GENERATIONS[0]!;
      const state =
        operation === "copy"
          ? "committed"
          : operation === "canonicalize" || operation === "transition"
            ? "staging"
            : "working";
      const targets = {
        root: stateRoot,
        profiles: join(stateRoot, "profiles"),
        profile: join(stateRoot, "profiles", PROFILE),
        state: join(stateRoot, "profiles", PROFILE, state),
        generation: join(
          stateRoot,
          "profiles",
          PROFILE,
          state,
          generationId,
        ),
      };
      const target = targets[component];
      const held = `${target}.held-store-matrix`;
      let swapped = false;
      const swap = async (): Promise<void> => {
        await rename(target, held);
        await mkdir(target, { recursive: true, mode: 0o700 });
        await writeFile(join(target, "outside"), "safe", { mode: 0o600 });
        swapped = true;
      };
      const point =
        operation === "create"
          ? "profile-mkdir-generation"
          : operation === "copy"
            ? "held-copy-write"
            : operation === "canonicalize"
              ? "profile-evidence-read"
              : operation === "sync"
              ? "held-profile-sync"
              : "profile-state-transition";
      const execute = () => {
        if (operation === "create")
          return store.createWorkingCopy(PROFILE, null, "snapshot", SESSION);
        if (operation === "copy")
          return store.createWorkingCopy(PROFILE, base, "snapshot", SESSION);
        if (operation === "canonicalize" || operation === "sync")
          return store.prepareWorkingCopy(work!);
        return store.finalizePreparedGeneration(prepared!);
      };
      try {
        await expect(
          runWithReconciliationFilesystemTestContext(
            {
              async beforeCall(candidate) {
                if (
                  !swapped &&
                  candidate === point &&
                  !(operation === "create" && component === "generation")
                ) {
                  await swap();
                }
              },
              async afterCall(candidate) {
                if (
                  !swapped &&
                  candidate === point &&
                  operation === "create" &&
                  component === "generation"
                ) {
                  await swap();
                }
              },
            },
            execute,
          ),
        ).rejects.toBeDefined();
        expect(swapped).toBe(true);
        expect(await readFile(join(target, "outside"), "utf8")).toBe("safe");
      } finally {
        if (swapped) {
          await rm(target, { recursive: true });
          await rename(held, target);
        }
        await store.close();
        await closeAnchoredProfileRoot(root);
      }
    },
  );

  test("rebuilds committed inventory in a fresh generation-scoped store", async () => {
    const { root, store } = await harness();
    const work = await store.createWorkingCopy(PROFILE, null, "writer", SESSION);
    await writeProfileFixtureFile(work, "Cookies", "state");
    const prepared = await store.prepareWorkingCopy(work);
    await store.finalizePreparedGeneration(prepared);
    const restarted = await createProfileStore({
      root,
      binding: {
        processNonce: PROCESS,
        controlGenerationNonce: CONTROL,
        snapshotDigest: canonicalizeReconciliationSnapshot([]).snapshotDigest,
      },
    });
    expect(await restarted.listCommitted()).toEqual([prepared.generationId]);
    expect(await restarted.hasCommitted(prepared.generationId)).toBe(true);
    await restarted.close();
    await store.close();
    await closeAnchoredProfileRoot(root);
  });

  test("rollover cleanup closes capabilities after admission revocation", async () => {
    const { controller, root, store } = await harness();
    await store.createWorkingCopy(PROFILE, null, "snapshot", SESSION);
    controller.abort();
    await expect(store.close()).resolves.toBeUndefined();
    await expect(closeAnchoredProfileRoot(root)).resolves.toBeUndefined();
  });
}, DURABLE_FILESYSTEM_TEST_TIMEOUT_MS);
