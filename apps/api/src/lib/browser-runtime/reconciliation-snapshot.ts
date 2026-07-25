import { createHash } from "node:crypto";

import type { Pool } from "pg";

import {
  reconciliationReferenceV1Schema,
  type ReconciliationReferenceV1,
} from "../scrape-interact/browser-service-contracts";

const MAX_RECONCILIATION_REFERENCES = 25_000;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROFILE_STATES = new Set(["committed", "staging", "working"]);

type AuthorityRow = {
  id: string;
  state_path: string | null;
  checksum: string | null;
};

/** @public */
export class BrowserReconciliationSnapshotError extends Error {
  readonly category = "browser_state_unavailable";

  constructor(cause?: unknown) {
    super("Browser reconciliation snapshot is unavailable", { cause });
    this.name = "BrowserReconciliationSnapshotError";
  }
}

/** @public */
export type BrowserReconciliationSnapshot = {
  snapshotDigest: string;
  references: ReconciliationReferenceV1[];
};

function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapRows(
  kind: ReconciliationReferenceV1["kind"],
  rows: AuthorityRow[],
): ReconciliationReferenceV1[] {
  return rows.map(row => {
    const parsed = reconciliationReferenceV1Schema.safeParse({
      kind,
      id: row.id,
      path: row.state_path,
      checksum: row.checksum,
    });
    if (!parsed.success) {
      throw new BrowserReconciliationSnapshotError(parsed.error);
    }
    const segments = parsed.data.path.split("/");
    const validPath =
      kind === "profile_generation"
        ? segments.length === 4 &&
          segments[0] === "profiles" &&
          UUID.test(segments[1] ?? "") &&
          PROFILE_STATES.has(segments[2] ?? "") &&
          UUID.test(segments[3] ?? "")
        : segments.length === 4 &&
          segments[0] === "replay" &&
          SAFE_OWNER.test(segments[1] ?? "") &&
          SAFE_OWNER.test(segments[2] ?? "") &&
          UUID.test((segments[3] ?? "").replace(/\.json$/, "")) &&
          segments[3]?.endsWith(".json");
    if (!validPath) throw new BrowserReconciliationSnapshotError();
    return parsed.data;
  });
}

/** @public */
export async function loadBrowserReconciliationSnapshot(
  pool: Pick<Pool, "connect">,
  signal?: AbortSignal,
): Promise<BrowserReconciliationSnapshot> {
  signal?.throwIfAborted();
  const connection = pool.connect();
  const client = signal
    ? await new Promise<Awaited<typeof connection>>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        connection.then(
          value => {
            signal.removeEventListener("abort", aborted);
            if (signal.aborted) {
              value.release(true);
              reject(signal.reason);
            } else {
              resolve(value);
            }
          },
          error => {
            signal.removeEventListener("abort", aborted);
            reject(error);
          },
        );
      })
    : await connection;
  let transaction = false;
  let destroyed = false;
  const query = async <Row extends Record<string, unknown> = never>(
    text: string,
  ) => {
    signal?.throwIfAborted();
    const pending = client.query<Row>(text);
    if (!signal) return pending;
    return new Promise<Awaited<typeof pending>>((resolve, reject) => {
      const aborted = () => {
        destroyed = true;
        client.release(true);
        reject(signal.reason);
      };
      signal.addEventListener("abort", aborted, { once: true });
      pending.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", aborted);
      });
    });
  };
  try {
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transaction = true;
    const checkpoints = await query<AuthorityRow>(
      `SELECT id, state_path, checksum
         FROM browser_replay_checkpoints
        WHERE state_path IS NOT NULL
          AND file_deleted_at IS NULL`,
    );
    const generations = await query<AuthorityRow>(
      `SELECT id, state_path, checksum
         FROM browser_profile_generations
        WHERE state_path IS NOT NULL
          AND file_deleted_at IS NULL`,
    );
    const cleanupIntents = await query<AuthorityRow>(
      `SELECT id, state_path, checksum
         FROM browser_replay_checkpoint_cleanup_intents`,
    );

    const references = [
      ...mapRows("replay_checkpoint", checkpoints.rows),
      ...mapRows("profile_generation", generations.rows),
      ...mapRows("replay_checkpoint_cleanup_intent", cleanupIntents.rows),
    ].sort(
      (left, right) =>
        rawCompare(left.kind, right.kind) ||
        rawCompare(left.id, right.id) ||
        rawCompare(left.path, right.path),
    );
    if (references.length > MAX_RECONCILIATION_REFERENCES) {
      throw new BrowserReconciliationSnapshotError();
    }

    const identities = new Set<string>();
    const pathChecksums = new Map<string, string>();
    for (const reference of references) {
      const identity = `${reference.kind}\u0000${reference.id}`;
      if (identities.has(identity)) {
        throw new BrowserReconciliationSnapshotError();
      }
      identities.add(identity);
      const prior = pathChecksums.get(reference.path);
      if (prior !== undefined && prior !== reference.checksum) {
        throw new BrowserReconciliationSnapshotError();
      }
      pathChecksums.set(reference.path, reference.checksum);
    }

    const canonical = JSON.stringify({ version: 1, references });
    const snapshotDigest = createHash("sha256").update(canonical).digest("hex");
    await query("COMMIT");
    transaction = false;
    return { snapshotDigest, references };
  } catch (error) {
    if (transaction) {
      try {
        await query("ROLLBACK");
      } catch {
        // Preserve the snapshot failure.
      }
    }
    if (error instanceof BrowserReconciliationSnapshotError) throw error;
    throw new BrowserReconciliationSnapshotError(error);
  } finally {
    if (!destroyed) client.release();
  }
}
