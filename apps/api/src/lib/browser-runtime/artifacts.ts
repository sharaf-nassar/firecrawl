import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../db/connection";
import type { ArtifactStore } from "../artifacts";
import { persistBrowserArtifactManifestWithLease } from "../artifacts/local-manifest";
import { logger } from "../logger";
import type { ActiveBrowserRunAuthority } from "../browser-state/store";
import { canonicalUuidSchema } from "../scrape-interact/browser-service-contracts";
import type {
  BrowserMutationCommitOutcome,
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "./startup-gate";

const MAX_BROWSER_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_BROWSER_ARTIFACTS_PER_RUN = 8;
const MAX_BROWSER_ARTIFACT_RUN_BYTES = 32 * 1024 * 1024;
const BROWSER_ARTIFACT_ROLLBACK_TIMEOUT_MS = 2_000;
const BROWSER_ARTIFACT_COMMIT_OUTCOME_TIMEOUT_MS = 2_000;
const BROWSER_ARTIFACT_TRANSACTION_COMMIT_TIMEOUT_MS = 30_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const kindSchema = z.enum(["screenshot", "trace", "recording"]);
const contentTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "application/zip",
  "video/webm",
]);
const positiveSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_BROWSER_ARTIFACT_BYTES);

/** @public */
export type BrowserArtifactHeaders = {
  contentLength: number;
  artifactId: string;
  kind: z.infer<typeof kindSchema>;
  contentType: z.infer<typeof contentTypeSchema>;
  byteSize: number;
  sha256: string;
};

/** @public */
export type BrowserArtifactReference = {
  artifactId: string;
  objectKey: string;
  kind: z.infer<typeof kindSchema>;
  contentType: z.infer<typeof contentTypeSchema>;
  byteSize: number;
  sha256: string;
};

type ArtifactTarget = {
  ownerId: string;
  requestId: string;
  scrapeId: string | null;
  sessionId: string;
  runId: string;
  deleteAfter: Date | null;
};

const referenceSchema = z.strictObject({
  artifactId: canonicalUuidSchema,
  objectKey: z.string().min(1).max(1_024),
  kind: kindSchema,
  contentType: contentTypeSchema,
  byteSize: positiveSizeSchema,
  sha256: sha256Schema,
});

const allowedHeaders = new Set([
  "x-firecrawl-artifact-id",
  "x-firecrawl-artifact-kind",
  "x-firecrawl-artifact-content-type",
  "x-firecrawl-artifact-byte-size",
  "x-firecrawl-artifact-sha256",
]);

/** @public */
export class BrowserArtifactError extends Error {
  constructor(
    public readonly category:
      | "artifact_invalid_headers"
      | "artifact_too_large"
      | "artifact_length_mismatch"
      | "artifact_checksum_mismatch"
      | "artifact_budget_exceeded"
      | "artifact_duplicate"
      | "artifact_upload_interrupted"
      | "artifact_store_unavailable"
      | "capability_denied",
    message: string,
  ) {
    super(message);
    this.name = "BrowserArtifactError";
  }
}

function invalidHeaders(): never {
  throw new BrowserArtifactError(
    "artifact_invalid_headers",
    "Browser artifact headers are invalid",
  );
}

function interrupted(): BrowserArtifactError {
  return new BrowserArtifactError(
    "artifact_upload_interrupted",
    "Browser artifact upload was interrupted",
  );
}

async function waitForArtifactOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw interrupted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(interrupted());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function waitForRollbackDelete(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserArtifactError(
                "artifact_store_unavailable",
                "Browser artifact rollback delete timed out",
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForArtifactCommitOutcome(
  operation: Promise<BrowserMutationCommitOutcome>,
  timeoutMs: number,
): Promise<BrowserMutationCommitOutcome | "timed_out"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<"timed_out">(resolve => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseDecimal(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) invalidHeaders();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidHeaders();
  return parsed;
}

function assertKindContentType(
  kind: z.infer<typeof kindSchema>,
  contentType: z.infer<typeof contentTypeSchema>,
): void {
  const valid =
    (kind === "screenshot" &&
      (contentType === "image/png" || contentType === "image/jpeg")) ||
    (kind === "trace" && contentType === "application/zip") ||
    (kind === "recording" && contentType === "video/webm");
  if (!valid) invalidHeaders();
}

/** @public Parses raw singleton headers without normalized-header ambiguity. */
export function parseBrowserArtifactHeaders(
  rawHeaders: readonly string[],
): BrowserArtifactHeaders {
  const values = new Map<string, string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined) invalidHeaders();
    const lower = name.toLowerCase();
    if (lower === "transfer-encoding") invalidHeaders();
    if (
      lower !== "content-length" &&
      !lower.startsWith("x-firecrawl-artifact-")
    ) {
      continue;
    }
    if (
      name !== lower ||
      (lower.startsWith("x-firecrawl-artifact-") &&
        !allowedHeaders.has(lower)) ||
      values.has(lower) ||
      value.length === 0 ||
      value.trim() !== value ||
      /[\r\n]/u.test(value)
    ) {
      invalidHeaders();
    }
    values.set(lower, value);
  }
  if (
    !values.has("content-length") ||
    [...allowedHeaders].some(name => !values.has(name))
  ) {
    invalidHeaders();
  }
  const contentLength = parseDecimal(values.get("content-length")!);
  const byteSize = parseDecimal(values.get("x-firecrawl-artifact-byte-size")!);
  if (
    contentLength > MAX_BROWSER_ARTIFACT_BYTES ||
    byteSize > MAX_BROWSER_ARTIFACT_BYTES
  ) {
    throw new BrowserArtifactError(
      "artifact_too_large",
      "Browser artifact exceeds its item budget",
    );
  }
  if (contentLength < 1 || byteSize < 1 || contentLength !== byteSize) {
    throw new BrowserArtifactError(
      "artifact_length_mismatch",
      "Browser artifact lengths do not match",
    );
  }
  const artifactId = canonicalUuidSchema.safeParse(
    values.get("x-firecrawl-artifact-id"),
  );
  const kind = kindSchema.safeParse(values.get("x-firecrawl-artifact-kind"));
  const contentType = contentTypeSchema.safeParse(
    values.get("x-firecrawl-artifact-content-type"),
  );
  const sha256 = sha256Schema.safeParse(
    values.get("x-firecrawl-artifact-sha256"),
  );
  if (
    !artifactId.success ||
    !kind.success ||
    !contentType.success ||
    !sha256.success
  ) {
    invalidHeaders();
  }
  assertKindContentType(kind.data, contentType.data);
  return {
    contentLength,
    artifactId: artifactId.data,
    kind: kind.data,
    contentType: contentType.data,
    byteSize,
    sha256: sha256.data,
  };
}

/** @public Reads exactly the declared byte count and rejects EOF/trailing data. */
export async function readBrowserArtifactBody(
  source: AsyncIterable<unknown>,
  headers: BrowserArtifactHeaders,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = source[Symbol.asyncIterator]();
  let rejectForAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () =>
      reject(
        new BrowserArtifactError(
          "artifact_upload_interrupted",
          "Browser artifact upload was interrupted",
        ),
      );
    if (signal?.aborted) {
      rejectForAbort();
      return;
    }
    signal?.addEventListener("abort", rejectForAbort, { once: true });
  });
  try {
    while (true) {
      const next = signal
        ? await Promise.race([iterator.next(), abort])
        : await iterator.next();
      if (next.done) break;
      const rawChunk = next.value;
      if (signal?.aborted) {
        throw new BrowserArtifactError(
          "artifact_upload_interrupted",
          "Browser artifact upload was interrupted",
        );
      }
      const chunk =
        typeof rawChunk === "string"
          ? Buffer.from(rawChunk)
          : Buffer.isBuffer(rawChunk)
            ? rawChunk
            : rawChunk instanceof Uint8Array
              ? Buffer.from(rawChunk)
              : invalidHeaders();
      total += chunk.byteLength;
      if (total > headers.byteSize) {
        throw new BrowserArtifactError(
          "artifact_length_mismatch",
          "Browser artifact contains trailing bytes",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    if (rejectForAbort) {
      signal?.removeEventListener("abort", rejectForAbort);
    }
  }
  if (signal?.aborted) {
    throw new BrowserArtifactError(
      "artifact_upload_interrupted",
      "Browser artifact upload was interrupted",
    );
  }
  if (total !== headers.byteSize) {
    throw new BrowserArtifactError(
      "artifact_length_mismatch",
      "Browser artifact ended before its declared length",
    );
  }
  return Buffer.concat(chunks, total);
}

async function resolveArtifactTarget(
  authority: ActiveBrowserRunAuthority,
): Promise<ArtifactTarget> {
  const result = await db.execute<{
    owner_id: string;
    request_id: string;
    scrape_id: string | null;
    session_id: string;
    run_id: string;
    dr_clean_by: string | Date | null;
  }>(sql`
    SELECT r.owner_id, r.request_id, r.scrape_id, r.session_id, r.id AS run_id,
           request.dr_clean_by
      FROM browser_interact_runs r
      JOIN browser_sessions s ON s.id = r.session_id
      JOIN requests request ON request.id = r.request_id
     WHERE r.id = ${authority.runId}::uuid
       AND r.owner_id = ${authority.ownerId}::uuid
       AND r.session_id = ${authority.sessionId}::uuid
       AND r.adapter_job_id = ${authority.adapterJobId}::uuid
       AND r.adapter_supervisor_id = ${authority.adapterSupervisorId}::uuid
       AND r.adapter_process_id = ${authority.adapterProcessId}
       AND r.state = 'running'
       AND s.state = 'executing'
       AND s.current_run_id = r.id
       AND s.owner_id = r.owner_id
       AND request.team_id = r.owner_id
       AND request.target_hint <> '<redacted due to zero data retention>'
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row || authority.zeroDataRetention !== false) {
    throw new BrowserArtifactError(
      "capability_denied",
      "Browser artifact authority was denied",
    );
  }
  return {
    ownerId: row.owner_id,
    requestId: row.request_id,
    scrapeId: row.scrape_id,
    sessionId: row.session_id,
    runId: row.run_id,
    deleteAfter: row.dr_clean_by === null ? null : new Date(row.dr_clean_by),
  };
}

/** @public Final fenced manifest and run-reference transaction. */
export async function commitBrowserArtifactWithLease(
  lease: BrowserStateMutationLease,
  authority: ActiveBrowserRunAuthority,
  target: ArtifactTarget,
  reference: BrowserArtifactReference,
  signal?: AbortSignal,
): Promise<void> {
  const locked = await waitForArtifactOperation(
    lease.transaction.query<{
      owner_id: string;
      request_id: string;
      scrape_id: string | null;
      session_id: string;
      artifact_references: unknown;
      dr_clean_by: string | Date | null;
    }>(
      `SELECT r.owner_id, r.request_id, r.scrape_id, r.session_id,
              r.artifact_references, request.dr_clean_by
         FROM browser_interact_runs r
         JOIN browser_sessions s ON s.id = r.session_id
         JOIN requests request ON request.id = r.request_id
         JOIN browser_capabilities c ON c.run_id = r.id
        WHERE r.id = $1
          AND r.owner_id = $2
          AND r.session_id = $3
          AND r.adapter_job_id = $4
          AND r.adapter_supervisor_id = $5
          AND r.adapter_process_id = $6
          AND r.state = 'running'
          AND r.deadline_at > now()
          AND s.state = 'executing'
          AND s.current_run_id = r.id
          AND s.owner_id = r.owner_id
          AND s.absolute_deadline_at > now()
          AND request.team_id = r.owner_id
          AND request.target_hint <> '<redacted due to zero data retention>'
          AND c.owner_id = r.owner_id
          AND c.session_id = r.session_id
          AND c.adapter_job_id = r.adapter_job_id
          AND c.adapter_supervisor_id = r.adapter_supervisor_id
          AND c.adapter_process_id = r.adapter_process_id
          AND c.activated_at IS NOT NULL
          AND c.revoked_at IS NULL
          AND c.expires_at > now()
          AND c.wall_deadline_at > now()
        FOR UPDATE OF r, s, c`,
      [
        authority.runId,
        authority.ownerId,
        authority.sessionId,
        authority.adapterJobId,
        authority.adapterSupervisorId,
        authority.adapterProcessId,
      ],
    ),
    signal,
  );
  const row = locked.rows[0];
  if (
    !row ||
    authority.zeroDataRetention !== false ||
    row.owner_id !== target.ownerId ||
    row.request_id !== target.requestId ||
    row.scrape_id !== target.scrapeId ||
    row.session_id !== target.sessionId
  ) {
    throw new BrowserArtifactError(
      "capability_denied",
      "Browser artifact authority was denied",
    );
  }
  const parsedReferences = z
    .array(referenceSchema)
    .safeParse(row.artifact_references);
  if (!parsedReferences.success) {
    throw new BrowserArtifactError(
      "artifact_budget_exceeded",
      "Browser artifact references are invalid",
    );
  }
  if (
    parsedReferences.data.some(
      existing => existing.artifactId === reference.artifactId,
    )
  ) {
    throw new BrowserArtifactError(
      "artifact_duplicate",
      "Browser artifact identifier was already attached",
    );
  }
  const aggregateBytes = parsedReferences.data.reduce(
    (total, item) => total + item.byteSize,
    0,
  );
  if (
    parsedReferences.data.length >= MAX_BROWSER_ARTIFACTS_PER_RUN ||
    aggregateBytes + reference.byteSize > MAX_BROWSER_ARTIFACT_RUN_BYTES
  ) {
    throw new BrowserArtifactError(
      "artifact_budget_exceeded",
      "Browser artifact run budget was exceeded",
    );
  }
  if (signal?.aborted) {
    throw new BrowserArtifactError(
      "artifact_upload_interrupted",
      "Browser artifact upload was interrupted",
    );
  }
  await waitForArtifactOperation(
    persistBrowserArtifactManifestWithLease(lease, {
      objectKey: reference.objectKey,
      ownerId: target.ownerId,
      requestId: target.requestId,
      jobId: target.runId,
      kind: reference.kind,
      contentType: reference.contentType,
      byteSize: reference.byteSize,
      checksum: reference.sha256,
      deleteAfter: row.dr_clean_by === null ? null : new Date(row.dr_clean_by),
    }),
    signal,
  );
  if (signal?.aborted) {
    throw new BrowserArtifactError(
      "artifact_upload_interrupted",
      "Browser artifact upload was interrupted",
    );
  }
  const expected = JSON.stringify(parsedReferences.data);
  const next = JSON.stringify([...parsedReferences.data, reference]);
  const attached = await waitForArtifactOperation(
    lease.transaction.query(
      `UPDATE browser_interact_runs
          SET artifact_references = $2::jsonb
        WHERE id = $1
          AND artifact_references = $3::jsonb
          AND state = 'running'
        RETURNING id`,
      [target.runId, next, expected],
    ),
    signal,
  );
  if (attached.rows.length !== 1) {
    throw new BrowserArtifactError(
      "artifact_budget_exceeded",
      "Browser artifact attachment lost its compare-and-set",
    );
  }
  if (signal?.aborted) {
    throw interrupted();
  }
}

/** @public Bounded upload service with lease-free bytes and leased attachment. */
export function createBrowserArtifactService(deps: {
  gate: BrowserStartupGate;
  store: ArtifactStore;
  resolveTarget?: (
    authority: ActiveBrowserRunAuthority,
  ) => Promise<ArtifactTarget>;
  commit?: (
    lease: BrowserStateMutationLease,
    authority: ActiveBrowserRunAuthority,
    target: ArtifactTarget,
    reference: BrowserArtifactReference,
    signal?: AbortSignal,
  ) => Promise<void>;
  randomUploadId?: () => string;
  rollbackTimeoutMs?: number;
  commitOutcomeTimeoutMs?: number;
  transactionCommitTimeoutMs?: number;
}) {
  const resolveTarget = deps.resolveTarget ?? resolveArtifactTarget;
  const commit = deps.commit ?? commitBrowserArtifactWithLease;
  const randomUploadId = deps.randomUploadId ?? randomUUID;
  const rollbackTimeoutMs =
    deps.rollbackTimeoutMs ?? BROWSER_ARTIFACT_ROLLBACK_TIMEOUT_MS;
  const commitOutcomeTimeoutMs =
    deps.commitOutcomeTimeoutMs ?? BROWSER_ARTIFACT_COMMIT_OUTCOME_TIMEOUT_MS;
  const transactionCommitTimeoutMs =
    deps.transactionCommitTimeoutMs ??
    BROWSER_ARTIFACT_TRANSACTION_COMMIT_TIMEOUT_MS;
  return {
    async ingest(
      authority: ActiveBrowserRunAuthority,
      headers: BrowserArtifactHeaders,
      body: Buffer,
      signal?: AbortSignal,
    ): Promise<BrowserArtifactReference> {
      if (
        body.byteLength !== headers.contentLength ||
        body.byteLength !== headers.byteSize
      ) {
        throw new BrowserArtifactError(
          "artifact_length_mismatch",
          "Browser artifact lengths do not match",
        );
      }
      const digest = createHash("sha256").update(body).digest("hex");
      if (digest !== headers.sha256) {
        throw new BrowserArtifactError(
          "artifact_checksum_mismatch",
          "Browser artifact checksum does not match",
        );
      }
      if (signal?.aborted) throw interrupted();
      deps.gate.assertOpen();
      const target = await waitForArtifactOperation(
        resolveTarget(authority),
        signal,
      );
      if (signal?.aborted) throw interrupted();
      const uploadId = canonicalUuidSchema.parse(randomUploadId());
      const scrape = target.scrapeId ?? "direct";
      const objectKey = [
        "browser",
        target.ownerId,
        target.requestId,
        scrape,
        target.sessionId,
        target.runId,
        `${headers.artifactId}-${uploadId}`,
      ].join("/");
      const reference: BrowserArtifactReference = {
        artifactId: headers.artifactId,
        objectKey,
        kind: headers.kind,
        contentType: headers.contentType,
        byteSize: headers.byteSize,
        sha256: headers.sha256,
      };
      let uploadAttempted = false;
      let putSettled = false;
      let deleteBeforePutSettled = false;
      let put: ReturnType<ArtifactStore["put"]> | undefined;
      let commitOutcome: Promise<BrowserMutationCommitOutcome> | undefined;
      const rollbackDelete = async () => {
        try {
          await waitForRollbackDelete(
            deps.store.delete(objectKey),
            rollbackTimeoutMs,
          );
        } catch (cleanupError) {
          logger.error("Browser artifact rollback delete failed", {
            category: "browser_artifact_rollback_failed",
            provider: deps.store.provider,
            objectKey,
            cleanupErrorName:
              cleanupError instanceof Error
                ? cleanupError.name
                : "UnknownError",
          });
        }
      };
      try {
        uploadAttempted = true;
        put = deps.store
          .put({
            key: objectKey,
            body,
            contentType: headers.contentType,
            metadata: {
              kind: headers.kind,
              sha256: headers.sha256,
              artifactId: headers.artifactId,
            },
          })
          .then(
            stored => {
              putSettled = true;
              return stored;
            },
            error => {
              putSettled = true;
              throw error;
            },
          );
        const stored = await waitForArtifactOperation(put, signal);
        if (
          stored.key !== objectKey ||
          stored.byteSize !== headers.byteSize ||
          stored.contentType !== headers.contentType ||
          signal?.aborted
        ) {
          throw new BrowserArtifactError(
            signal?.aborted
              ? "artifact_upload_interrupted"
              : "artifact_store_unavailable",
            "Browser artifact upload could not be verified",
          );
        }
        await waitForArtifactOperation(
          deps.gate.withBrowserStateMutationLease(
            "filesystem_and_database",
            async lease => {
              commitOutcome = lease.transaction.commitOutcome;
              if (signal?.aborted) throw interrupted();
              await commit(lease, authority, target, reference, signal);
              if (signal?.aborted) throw interrupted();
            },
            {
              commitTimeoutMs: Math.max(
                1,
                Math.min(
                  transactionCommitTimeoutMs,
                  authority.perOperationTimeoutMs,
                  authority.deadline.getTime() - Date.now(),
                ),
              ),
            },
          ),
          signal,
        );
        if (signal?.aborted) throw interrupted();
        return reference;
      } catch (error) {
        if (uploadAttempted) {
          deleteBeforePutSettled = !putSettled;
          const outcome =
            commitOutcome === undefined
              ? "rolled_back"
              : await waitForArtifactCommitOutcome(
                  commitOutcome,
                  commitOutcomeTimeoutMs,
                );
          if (outcome === "rolled_back") {
            await rollbackDelete();
          } else if (outcome !== "committed") {
            logger.warn("Browser artifact rollback retained uploaded object", {
              category: "browser_artifact_commit_outcome_uncertain",
              provider: deps.store.provider,
              objectKey,
              commitOutcome: outcome,
            });
            if (outcome === "timed_out" && commitOutcome !== undefined) {
              void commitOutcome
                .then(async eventualOutcome => {
                  if (eventualOutcome === "rolled_back") {
                    await rollbackDelete();
                  }
                })
                .catch(() => undefined);
            }
          }
        }
        throw error;
      } finally {
        if (deleteBeforePutSettled && put !== undefined) {
          void put.finally(rollbackDelete).catch(() => undefined);
        }
      }
    },
  };
}
