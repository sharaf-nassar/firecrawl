import {
  createHash,
  randomBytes as systemRandomBytes,
  randomUUID as systemRandomUUID,
} from "node:crypto";

import {
  bindProfileGeneration,
  canonicalizeHeldProfileTree,
  copyHeldProfileTree,
  ensureAtomicPublicationNamespaces,
  isUnverifiedProfileCleanupError,
  listHeldProfileGenerations,
  readHeldRootFile,
  syncAndCanonicalizeHeldProfileTree,
  transitionHeldProfileGenerationAtomically,
  writeHeldProfileFixtureFile,
  type AnchoredProfileRoot,
  type BoundProfileGeneration,
  type ReadyProfileRootBinding,
} from "./reconciliation.js";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export type ProfileMode = "writer" | "snapshot";

export type ProfileGenerationAuthority = Readonly<{
  generationId: string;
  statePath: string;
  checksum: string;
}>;

declare const workingProfileBrand: unique symbol;
declare const preparedProfileBrand: unique symbol;

export type WorkingProfile = Readonly<{
  [workingProfileBrand]: true;
  profileId: string;
  generationId: string;
  sessionId: string;
  mode: ProfileMode;
}>;

export type PreparedProfileGeneration = Readonly<{
  [preparedProfileBrand]: true;
  profileId: string;
  generationId: string;
  checksum: string;
  byteSize: number;
  prepareToken: string;
}>;

export type FinalizedProfileGeneration = Readonly<{
  version: 1;
  profileId: string;
  generationId: string;
  checksum: string;
  committed: true;
}>;

export class ProfileStoreError extends Error {
  readonly category:
    | "browser_unavailable"
    | "profile_prepare_failed"
    | "profile_finalize_failed"
    | "profile_discard_failed";
  readonly detail: "profile_schema_empty" | undefined;
  readonly retainedWork: WorkingProfile | undefined;
  readonly cleanupUnverified: boolean;

  constructor(
    category: ProfileStoreError["category"],
    message: string,
    options: ErrorOptions & {
      detail?: "profile_schema_empty";
      retainedWork?: WorkingProfile;
      cleanupUnverified?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = "ProfileStoreError";
    this.category = category;
    this.detail = options.detail;
    this.retainedWork = options.retainedWork;
    this.cleanupUnverified = options.cleanupUnverified ?? false;
  }
}

type WorkRecord = {
  store: StoreRecord;
  token: WorkingProfile;
  capability: BoundProfileGeneration;
  state: "working" | "staging" | "committed" | "discarded";
  prepared?: PreparedProfileGeneration;
};

type PreparedRecord =
  | {
      store: StoreRecord;
      work: WorkRecord;
      state: "staging" | "committed" | "verified";
    }
  | {
      store: StoreRecord;
      state: "finalized";
      result: FinalizedProfileGeneration;
    };

type StoreRecord = {
  state: "live" | "closing" | "closed" | "close_unverified";
  root: AnchoredProfileRoot;
  binding: ReadyProfileRootBinding;
  randomUUID: () => string;
  randomBytes: (size: number) => Buffer;
  works: Set<WorkRecord>;
  auxiliaryCapabilities: Set<BoundProfileGeneration>;
  finalizedHistory: Map<PreparedProfileGeneration, FinalizedProfileGeneration>;
};

export type ProfileStore = Readonly<{
  readRootFile(relative: string, maximumBytes: number): Promise<Buffer>;
  workingGeneration(work: WorkingProfile): BoundProfileGeneration;
  createWorkingCopy(
    profileId: string,
    base: ProfileGenerationAuthority | null,
    mode: ProfileMode,
    sessionId: string,
  ): Promise<WorkingProfile>;
  discardWorkingCopy(work: WorkingProfile): Promise<void>;
  prepareWorkingCopy(
    work: WorkingProfile,
  ): Promise<PreparedProfileGeneration>;
  finalizePreparedGeneration(
    prepared: PreparedProfileGeneration,
  ): Promise<FinalizedProfileGeneration>;
  hasCommitted(generationId: string): Promise<boolean>;
  listWorking(): Promise<string[]>;
  listStaging(): Promise<string[]>;
  listCommitted(): Promise<string[]>;
  close(): Promise<void>;
}>;

const storeRecords = new WeakMap<object, StoreRecord>();
const workRecords = new WeakMap<object, WorkRecord>();
const preparedRecords = new WeakMap<object, PreparedRecord>();
const attachedGenerationOwners = new WeakMap<object, StoreRecord>();
const MAX_FINALIZED_HISTORY = 256;

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) {
    throw new ProfileStoreError(
      "profile_prepare_failed",
      `${label} must be a canonical lowercase UUID`,
    );
  }
}

function mintPrepareToken(record: StoreRecord): string {
  const bytes = record.randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 32) {
    throw new TypeError("randomBytes must return exactly 32 bytes");
  }
  return bytes.toString("base64url");
}

function profileTransitionAuthorityDigest(
  kind: "prepare" | "finalize",
  prepareToken: string,
  checksum: string,
): string {
  return createHash("sha256")
    .update(`${kind}\0${prepareToken}\0${checksum}`)
    .digest("hex");
}

function requireStore(store: ProfileStore): StoreRecord {
  const record = storeRecords.get(store as object);
  if (record === undefined || record.state !== "live") {
    throw new ProfileStoreError(
      "profile_prepare_failed",
      "profile store is not live",
    );
  }
  return record;
}

export function attachSealedProfileGenerations(
  store: ProfileStore,
  generations: readonly BoundProfileGeneration[],
): void {
  const record = requireStore(store);
  const unique = new Set(generations);
  if (unique.size !== generations.length) {
    throw new ProfileStoreError(
      "profile_prepare_failed",
      "sealed generation attachment is duplicated",
    );
  }
  for (const generation of generations) {
    if (attachedGenerationOwners.has(generation as object)) {
      throw new ProfileStoreError(
        "profile_prepare_failed",
        "sealed generation is already attached",
      );
    }
  }
  for (const generation of generations) {
    attachedGenerationOwners.set(generation as object, record);
    record.auxiliaryCapabilities.add(generation);
  }
}

function requireWork(work: WorkingProfile): WorkRecord {
  const record = workRecords.get(work as object);
  if (
    record === undefined ||
    record.store.state !== "live" ||
    record.state === "discarded"
  ) {
    throw new ProfileStoreError(
      "profile_prepare_failed",
      "working profile authority is invalid",
    );
  }
  return record;
}

export function requireWorkingProfileGeneration(
  work: WorkingProfile,
): BoundProfileGeneration {
  const record = requireWork(work);
  if (record.state !== "working") {
    throw new ProfileStoreError(
      "profile_prepare_failed",
      "profile is not a working generation",
    );
  }
  return record.capability;
}

/** Test fixture support; omitted from production barrels. */
export async function writeProfileFixtureFile(
  work: WorkingProfile,
  leaf: string,
  contents: string | Uint8Array,
): Promise<void> {
  await writeHeldProfileFixtureFile(
    requireWorkingProfileGeneration(work),
    leaf,
    contents,
  );
}

function sortedIds(record: StoreRecord, state: WorkRecord["state"]): string[] {
  return [...record.works]
    .filter((work) => work.state === state)
    .map((work) => work.token.generationId)
    .sort();
}

export async function createProfileStore(options: {
  root: AnchoredProfileRoot;
  binding: ReadyProfileRootBinding;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Buffer;
}): Promise<ProfileStore> {
  await ensureAtomicPublicationNamespaces(options.root);
  const record: StoreRecord = {
    state: "live",
    root: options.root,
    binding: Object.freeze({ ...options.binding }),
    randomUUID: options.randomUUID ?? systemRandomUUID,
    randomBytes: options.randomBytes ?? systemRandomBytes,
    works: new Set(),
    auxiliaryCapabilities: new Set(),
    finalizedHistory: new Map(),
  };

  const store: ProfileStore = Object.freeze({
    async readRootFile(relative, maximumBytes) {
      requireStore(store);
      return readHeldRootFile(record.root, relative, maximumBytes);
    },

    workingGeneration(work) {
      const workRecord = requireWork(work);
      if (workRecord.store !== record || workRecord.state !== "working") {
        throw new ProfileStoreError(
          "profile_prepare_failed",
          "profile is not an owned working generation",
        );
      }
      return workRecord.capability;
    },

    async createWorkingCopy(profileId, base, mode, sessionId) {
      requireStore(store);
      assertUuid(profileId, "profileId");
      assertUuid(sessionId, "sessionId");
      const generationId = record.randomUUID();
      assertUuid(generationId, "generationId");
      let destination: BoundProfileGeneration | undefined;
      let source: BoundProfileGeneration | undefined;
      let createdWork: WorkingProfile | undefined;
      try {
        if (base !== null) {
          assertUuid(base.generationId, "base generationId");
          const expectedStatePath =
            `profiles/${profileId}/committed/${base.generationId}`;
          if (
            base.statePath !== expectedStatePath ||
            !/^[a-f0-9]{64}$/u.test(base.checksum)
          ) {
            throw new ProfileStoreError(
              "profile_prepare_failed",
              "base profile authority does not match its committed path",
            );
          }
          source = await bindProfileGeneration(record.root, {
            profileId,
            state: "committed",
            generationId: base.generationId,
            openMode: "existing",
          });
        }
        destination = await bindProfileGeneration(record.root, {
          profileId,
          state: "working",
          generationId,
          openMode: "create_exclusive",
        });
        if (base !== null && source !== undefined) {
          const copied = await copyHeldProfileTree(source, destination);
          if (copied.checksum !== base.checksum) {
            throw new ProfileStoreError(
              "profile_prepare_failed",
              "base profile checksum changed",
            );
          }
        }
        const token = Object.freeze({
          profileId,
          generationId,
          sessionId,
          mode,
        }) as WorkingProfile;
        createdWork = token;
        const work: WorkRecord = {
          store: record,
          token,
          capability: destination,
          state: "working",
        };
        workRecords.set(token, work);
        record.works.add(work);
        destination = undefined;
        return token;
      } catch (error) {
        if (destination !== undefined) {
          try {
            await destination.remove();
          } catch (cleanupError) {
            const retained = Object.freeze({
              profileId,
              generationId,
              sessionId,
              mode,
            }) as WorkingProfile;
            const retainedRecord: WorkRecord = {
              store: record,
              token: retained,
              capability: destination,
              state: "working",
            };
            workRecords.set(retained, retainedRecord);
            record.works.add(retainedRecord);
            destination = undefined;
            throw new ProfileStoreError(
              "profile_prepare_failed",
              "working copy cleanup is unverified",
              {
                cause: new AggregateError(
                  [error, cleanupError],
                  "profile acquisition and cleanup failed",
                ),
                retainedWork: retained,
                cleanupUnverified: true,
              },
            );
          }
        }
        if (isUnverifiedProfileCleanupError(error)) {
          throw new ProfileStoreError(
            "profile_prepare_failed",
            "working copy cleanup is unverified",
            { cause: error, cleanupUnverified: true },
          );
        }
        throw error;
      } finally {
        if (source !== undefined) {
          record.auxiliaryCapabilities.add(source);
          try {
            await source.close();
            record.auxiliaryCapabilities.delete(source);
          } catch (cause) {
            throw new ProfileStoreError(
              "profile_prepare_failed",
              "source profile cleanup is unverified",
              {
                cause,
                ...(createdWork === undefined
                  ? {}
                  : { retainedWork: createdWork }),
                cleanupUnverified: true,
              },
            );
          }
        }
      }
    },

    async discardWorkingCopy(work) {
      const workRecord = requireWork(work);
      if (workRecord.store !== record || workRecord.state !== "working") {
        throw new ProfileStoreError(
          "profile_discard_failed",
          "only an owned working generation may be discarded",
        );
      }
      try {
        await workRecord.capability.remove();
        workRecord.state = "discarded";
        record.works.delete(workRecord);
        workRecords.delete(work as object);
      } catch (cause) {
        throw new ProfileStoreError(
          "profile_discard_failed",
          "working generation removal failed",
          { cause, retainedWork: work },
        );
      }
    },

    async prepareWorkingCopy(work) {
      const workRecord = requireWork(work);
      if (workRecord.store !== record || work.mode !== "writer") {
        throw new ProfileStoreError(
          "profile_prepare_failed",
          "only an owned writer may be prepared",
        );
      }
      if (workRecord.prepared !== undefined) return workRecord.prepared;
      if (workRecord.state === "staging") {
        try {
          const stagedTree = await canonicalizeHeldProfileTree(
            workRecord.capability,
          );
          if (stagedTree.fileCount === 0) {
            throw new ProfileStoreError(
              "browser_unavailable",
              "writer profile schema is empty",
              { detail: "profile_schema_empty" },
            );
          }
          const recovered = Object.freeze({
            profileId: work.profileId,
            generationId: work.generationId,
            checksum: stagedTree.checksum,
            byteSize: stagedTree.byteSize,
            prepareToken: mintPrepareToken(record),
          }) as PreparedProfileGeneration;
          preparedRecords.set(recovered, {
            store: record,
            work: workRecord,
            state: "staging",
          });
          workRecord.prepared = recovered;
          return recovered;
        } catch (cause) {
          if (cause instanceof ProfileStoreError) throw cause;
          throw new ProfileStoreError(
            "profile_prepare_failed",
            "staged profile recovery failed",
            { cause, retainedWork: work },
          );
        }
      }
      if (workRecord.state !== "working") {
        throw new ProfileStoreError(
          "profile_prepare_failed",
          "writer is not in working state",
        );
      }
      try {
        const workingTree = await syncAndCanonicalizeHeldProfileTree(
          workRecord.capability,
        );
        if (workingTree.fileCount === 0) {
          throw new ProfileStoreError(
            "browser_unavailable",
            "writer profile schema is empty",
            { detail: "profile_schema_empty" },
          );
        }
        const prepareToken = mintPrepareToken(record);
        const transition = await transitionHeldProfileGenerationAtomically(
          workRecord.capability,
          {
            binding: record.binding,
            kind: "prepare",
            authorityDigest: profileTransitionAuthorityDigest(
              "prepare",
              prepareToken,
              workingTree.checksum,
            ),
          },
        );
        const staging = transition.generation;
        workRecord.capability = transition.generation;
        workRecord.state = "staging";
        const stagedTree = transition.tree;
        if (stagedTree.checksum !== workingTree.checksum) {
          throw new ProfileStoreError(
            "profile_prepare_failed",
            "staged profile checksum changed",
          );
        }
        const prepared = Object.freeze({
          profileId: work.profileId,
          generationId: work.generationId,
          checksum: stagedTree.checksum,
          byteSize: stagedTree.byteSize,
          prepareToken,
        }) as PreparedProfileGeneration;
        preparedRecords.set(prepared, {
          store: record,
          work: workRecord,
          state: "staging",
        });
        workRecord.prepared = prepared;
        return prepared;
      } catch (cause) {
        if (cause instanceof ProfileStoreError) throw cause;
        throw new ProfileStoreError(
          "profile_prepare_failed",
          "profile prepare failed",
          { cause, retainedWork: work },
        );
      }
    },

    async finalizePreparedGeneration(prepared) {
      const preparedRecord = preparedRecords.get(prepared as object);
      if (preparedRecord === undefined || preparedRecord.store !== record) {
        throw new ProfileStoreError(
          "profile_finalize_failed",
          "prepared profile authority is invalid",
        );
      }
      if (preparedRecord.state === "finalized") {
        return preparedRecord.result;
      }
      const settleFinalized = async (): Promise<FinalizedProfileGeneration> => {
        try {
          await preparedRecord.work.capability.close();
          const result = Object.freeze({
            version: 1 as const,
            profileId: prepared.profileId,
            generationId: prepared.generationId,
            checksum: prepared.checksum,
            committed: true as const,
          });
          record.works.delete(preparedRecord.work);
          workRecords.delete(preparedRecord.work.token as object);
          preparedRecords.set(prepared, {
            store: record,
            state: "finalized",
            result,
          });
          record.finalizedHistory.set(prepared, result);
          if (record.finalizedHistory.size > MAX_FINALIZED_HISTORY) {
            const oldest = record.finalizedHistory.keys().next().value;
            if (oldest !== undefined) {
              record.finalizedHistory.delete(oldest);
              preparedRecords.delete(oldest as object);
            }
          }
          return result;
        } catch (cause) {
          if (cause instanceof ProfileStoreError) throw cause;
          throw new ProfileStoreError(
            "profile_finalize_failed",
            "committed profile cleanup is unverified",
            {
              cause,
              retainedWork: preparedRecord.work.token,
              cleanupUnverified: true,
            },
          );
        }
      };
      if (preparedRecord.state === "verified") {
        return settleFinalized();
      }
      if (
        preparedRecord.state === "committed" &&
        preparedRecord.work.state === "committed"
      ) {
        try {
          const committedTree = await canonicalizeHeldProfileTree(
            preparedRecord.work.capability,
          );
          if (committedTree.checksum !== prepared.checksum) {
            throw new ProfileStoreError(
              "profile_finalize_failed",
              "committed profile checksum changed",
            );
          }
          preparedRecord.state = "verified";
          return settleFinalized();
        } catch (cause) {
          if (cause instanceof ProfileStoreError) throw cause;
          throw new ProfileStoreError(
            "profile_finalize_failed",
            "committed profile verification failed",
            { cause },
          );
        }
      }
      if (
        preparedRecord.state !== "staging" ||
        preparedRecord.work.state !== "staging"
      ) {
        throw new ProfileStoreError(
          "profile_finalize_failed",
          "prepared profile is not staged",
        );
      }
      try {
        const before = await canonicalizeHeldProfileTree(
          preparedRecord.work.capability,
        );
        if (before.checksum !== prepared.checksum) {
          throw new ProfileStoreError(
            "profile_finalize_failed",
            "prepared profile checksum changed",
          );
        }
        const transition = await transitionHeldProfileGenerationAtomically(
          preparedRecord.work.capability,
          {
            binding: record.binding,
            kind: "finalize",
            authorityDigest: profileTransitionAuthorityDigest(
              "finalize",
              prepared.prepareToken,
              prepared.checksum,
            ),
          },
        );
        const committed = transition.generation;
        preparedRecord.work.capability = transition.generation;
        preparedRecord.work.state = "committed";
        preparedRecord.state = "committed";
        const after = transition.tree;
        if (after.checksum !== prepared.checksum) {
          throw new ProfileStoreError(
            "profile_finalize_failed",
            "committed profile checksum changed",
          );
        }
        preparedRecord.state = "verified";
        return settleFinalized();
      } catch (cause) {
        if (cause instanceof ProfileStoreError) throw cause;
        throw new ProfileStoreError(
          "profile_finalize_failed",
          "profile finalize failed",
          { cause },
        );
      }
    },

    async hasCommitted(generationId) {
      requireStore(store);
      assertUuid(generationId, "generationId");
      return (await listHeldProfileGenerations(record.root, "committed")).some(
        (generation) => generation.generationId === generationId,
      );
    },

    async listWorking() {
      requireStore(store);
      return (await listHeldProfileGenerations(record.root, "working")).map(
        (generation) => generation.generationId,
      );
    },

    async listStaging() {
      requireStore(store);
      return (await listHeldProfileGenerations(record.root, "staging")).map(
        (generation) => generation.generationId,
      );
    },

    async listCommitted() {
      requireStore(store);
      return (await listHeldProfileGenerations(record.root, "committed")).map(
        (generation) => generation.generationId,
      );
    },

    async close() {
      const live = storeRecords.get(store as object);
      if (
        live === undefined ||
        (live.state !== "live" && live.state !== "close_unverified")
      ) {
        throw new ProfileStoreError(
          "profile_discard_failed",
          "profile store is not closable",
        );
      }
      live.state = "closing";
      const targets = [...live.works]
        .filter((work) => work.state !== "discarded")
        .map((work) => ({
          close: work.capability.close(),
          settled: () => {
            live.works.delete(work);
            workRecords.delete(work.token as object);
            if (work.prepared !== undefined) {
              preparedRecords.delete(work.prepared as object);
            }
          },
        }));
      const results = await Promise.allSettled(
        targets.map((target) => target.close),
      );
      results.forEach((result, index) => {
        if (result.status === "fulfilled") targets[index]!.settled();
      });
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      ).map((failure) => failure.reason);
      for (const capability of [
        ...live.auxiliaryCapabilities,
      ].reverse()) {
        try {
          await capability.close();
          live.auxiliaryCapabilities.delete(capability);
          attachedGenerationOwners.delete(capability as object);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length !== 0) {
        live.state = "close_unverified";
        throw new AggregateError(
          failures,
          "profile capability cleanup failed",
        );
      }
      live.works.clear();
      live.auxiliaryCapabilities.clear();
      for (const prepared of live.finalizedHistory.keys()) {
        preparedRecords.delete(prepared as object);
      }
      live.finalizedHistory.clear();
      live.state = "closed";
      storeRecords.delete(store as object);
    },
  });
  storeRecords.set(store, record);
  return store;
}
