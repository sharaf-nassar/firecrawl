import { createHash } from "node:crypto";

import {
  canonicalJson,
  replayCheckpointV1Schema,
  storageStateV1Schema,
  type ReplayCheckpointV1,
  type StorageStateV1,
} from "./contracts.js";

const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const UUID_FILE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/u;

export class ReplayRestoreError extends Error {
  readonly category: "replay_unavailable" | "replay_unsupported";

  constructor(
    category: ReplayRestoreError["category"],
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ReplayRestoreError";
    this.category = category;
  }
}

function unavailable(message: string, cause?: unknown): ReplayRestoreError {
  return new ReplayRestoreError(
    "replay_unavailable",
    message,
    cause === undefined ? {} : { cause },
  );
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertReplayPath(statePath: string): string[] {
  const segments = statePath.split("/");
  if (
    segments.length !== 4 ||
    segments[0] !== "replay" ||
    segments[1] === "replay" ||
    !SAFE_OWNER.test(segments[1] ?? "") ||
    !SAFE_OWNER.test(segments[2] ?? "") ||
    !UUID_FILE.test(segments[3] ?? "")
  ) {
    throw unavailable("checkpoint path has invalid replay grammar");
  }
  return segments;
}

export type LoadedReplayCheckpoint = {
  checkpoint: ReplayCheckpointV1;
  storageState: StorageStateV1;
  rawBytes: Buffer;
  canonicalBytes: Buffer;
};

export function replayCheckpointStatePath(input: unknown): string {
  const parsed = replayCheckpointV1Schema.safeParse(input);
  if (!parsed.success) {
    throw unavailable("checkpoint metadata is invalid", parsed.error);
  }
  assertReplayPath(parsed.data.statePath);
  return parsed.data.statePath;
}

export function loadReplayCheckpointFromBytes(
  input: unknown,
  rawInput: Uint8Array,
): LoadedReplayCheckpoint {
  const parsedCheckpoint = replayCheckpointV1Schema.safeParse(input);
  if (!parsedCheckpoint.success) {
    throw unavailable("checkpoint metadata is invalid", parsedCheckpoint.error);
  }
  const checkpoint = parsedCheckpoint.data;
  assertReplayPath(checkpoint.statePath);
  const rawBytes = Buffer.from(rawInput);
  if (rawBytes.length !== checkpoint.byteSize) {
    throw unavailable("checkpoint byte size mismatch");
  }
  if (sha256(rawBytes) !== checkpoint.checksum) {
    throw unavailable("checkpoint checksum mismatch");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBytes),
    ) as unknown;
  } catch (error) {
    throw unavailable("checkpoint is not canonical UTF-8 JSON", error);
  }
  const parsedState = storageStateV1Schema.safeParse(decoded);
  if (!parsedState.success) {
    throw unavailable("checkpoint storage state is invalid", parsedState.error);
  }
  const canonicalBytes = Buffer.from(canonicalJson(parsedState.data), "utf8");
  const requestBytes = Buffer.from(
    canonicalJson(checkpoint.storageState),
    "utf8",
  );
  if (!rawBytes.equals(canonicalBytes) || !rawBytes.equals(requestBytes)) {
    throw unavailable("checkpoint file and request bytes differ");
  }
  return {
    checkpoint,
    storageState: parsedState.data,
    rawBytes,
    canonicalBytes,
  };
}

type JsonObject = Record<string, unknown>;

function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function frame(tag: string, value: unknown): Buffer {
  const tagBytes = Buffer.from(tag, "utf8");
  const valueBytes = bytes(value);
  return Buffer.concat([
    Buffer.from(`${tagBytes.length}:`, "ascii"),
    tagBytes,
    Buffer.from(`${valueBytes.length}:`, "ascii"),
    valueBytes,
  ]);
}

function tuple(...parts: Array<[string, unknown]>): Buffer {
  return Buffer.concat(parts.map(([tag, value]) => frame(tag, value)));
}

function normalizeSet<T>(
  values: readonly T[],
  identity: (value: T) => Buffer,
  normalize: (value: T) => unknown,
  label: string,
): unknown[] {
  const entries = values.map((value) => {
    const primary = identity(value);
    const normalized = normalize(value);
    return { primary, full: bytes(normalized), normalized };
  });
  entries.sort((left, right) => {
    const primary = Buffer.compare(left.primary, right.primary);
    return primary === 0 ? Buffer.compare(left.full, right.full) : primary;
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (
      Buffer.compare(entries[index - 1]!.primary, entries[index]!.primary) === 0
    ) {
      throw unavailable(`duplicate ${label} identity`);
    }
  }
  return entries.map((entry) => entry.normalized);
}

function normalizeRecord(record: JsonObject): JsonObject {
  return Object.fromEntries(
    ["key", "keyEncoded", "value", "valueEncoded"]
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
}

function recordIdentity(record: JsonObject): Buffer {
  if (record.key !== undefined) return tuple(["key", record.key]);
  if (record.keyEncoded !== undefined) {
    return tuple(["keyEncoded", record.keyEncoded]);
  }
  if (record.value !== undefined) return tuple(["value", record.value]);
  return tuple(["valueEncoded", record.valueEncoded]);
}

function normalizeIndex(index: JsonObject): JsonObject {
  const result: JsonObject = {
    name: index.name,
    multiEntry: index.multiEntry,
    unique: index.unique,
  };
  if (index.keyPath !== undefined) result.keyPath = index.keyPath;
  if (index.keyPathArray !== undefined)
    result.keyPathArray = index.keyPathArray;
  return result;
}

function normalizeStore(store: JsonObject): JsonObject {
  const result: JsonObject = {
    name: store.name,
    autoIncrement: store.autoIncrement,
    records: normalizeSet(
      store.records as JsonObject[],
      recordIdentity,
      normalizeRecord,
      "IndexedDB record",
    ),
    indexes: normalizeSet(
      store.indexes as JsonObject[],
      (index) => tuple(["name", index.name]),
      normalizeIndex,
      "IndexedDB index",
    ),
  };
  if (store.keyPath !== undefined) result.keyPath = store.keyPath;
  if (store.keyPathArray !== undefined)
    result.keyPathArray = store.keyPathArray;
  return result;
}

function normalizeDatabase(database: JsonObject): JsonObject {
  return {
    name: database.name,
    version: database.version,
    stores: normalizeSet(
      database.stores as JsonObject[],
      (store) => tuple(["name", store.name]),
      normalizeStore,
      "IndexedDB store",
    ),
  };
}

function normalizeOrigin(origin: JsonObject): JsonObject | null {
  const localStorage = normalizeSet(
    origin.localStorage as JsonObject[],
    (entry) => tuple(["name", entry.name]),
    (entry) => ({ name: entry.name, value: entry.value }),
    "localStorage entry",
  );
  const indexedDB = normalizeSet(
    (origin.indexedDB as JsonObject[] | undefined) ?? [],
    (database) => tuple(["name", database.name]),
    normalizeDatabase,
    "IndexedDB database",
  );
  if (localStorage.length === 0 && indexedDB.length === 0) return null;
  return { origin: origin.origin, localStorage, indexedDB };
}

export function semanticNormalizeStorageState(input: unknown): Buffer {
  const parsed = storageStateV1Schema.safeParse(input);
  if (!parsed.success) {
    throw unavailable("storage state has invalid semantic shape", parsed.error);
  }
  const state = parsed.data as unknown as {
    cookies: JsonObject[];
    origins: JsonObject[];
  };
  const cookies = normalizeSet(
    state.cookies,
    (cookie) =>
      tuple(
        ["domain", cookie.domain],
        ["path", cookie.path],
        ["name", cookie.name],
        ["partitionKey", cookie.partitionKey ?? { absent: true }],
        [
          "_crHasCrossSiteAncestor",
          cookie._crHasCrossSiteAncestor ?? { absent: true },
        ],
      ),
    (cookie) => cookie,
    "cookie",
  );
  const origins = normalizeSet(
    state.origins,
    (origin) => tuple(["origin", origin.origin]),
    normalizeOrigin,
    "origin",
  ).filter((origin) => origin !== null);
  return bytes({ cookies, origins });
}

export function verifySemanticallyEquivalentStorageState(
  left: unknown,
  right: unknown,
): void {
  const leftBytes = semanticNormalizeStorageState(left);
  const rightBytes = semanticNormalizeStorageState(right);
  if (!leftBytes.equals(rightBytes)) {
    throw unavailable("restored storage state differs semantically");
  }
}
