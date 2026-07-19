import { randomUUID } from "node:crypto";
import { Client } from "minio";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MinioArtifactStore } from "./minio";
import { jobArtifactKey } from ".";
import type { ArtifactStore } from "./types";
import { putLocalArtifactWithManifest } from "./local-manifest";
import { createPdfCacheKey, savePdfResultToCache } from "../gcs-pdf-cache";
import { saveMonitorDiffArtifact } from "../gcs-monitoring";

const endpoint =
  process.env.TEST_MINIO_ENDPOINT ?? process.env.ARTIFACT_MINIO_ENDPOINT;
const accessKey =
  process.env.TEST_MINIO_ACCESS_KEY ?? process.env.ARTIFACT_MINIO_ACCESS_KEY;
const secretKey =
  process.env.TEST_MINIO_SECRET_KEY ?? process.env.ARTIFACT_MINIO_SECRET_KEY;
const bucket =
  process.env.TEST_MINIO_BUCKET ??
  process.env.ARTIFACT_MINIO_BUCKET ??
  "firecrawl-artifacts";
const region =
  process.env.TEST_MINIO_REGION ??
  process.env.ARTIFACT_MINIO_REGION ??
  "us-east-1";
const enabled = Boolean(endpoint && accessKey && secretKey);
const databaseUrl = process.env.APPLICATION_DATABASE_URL;
const ownerId = process.env.LOCAL_OWNER_ID;
const localManifestEnabled = Boolean(
  databaseUrl && ownerId && process.env.LOCAL_PERSISTENCE_ENABLED === "true",
);
const prefix = `integration/${randomUUID()}`;
const objectKey = `${prefix}/artifact.json`;

function rawClient(): Client {
  const url = new URL(endpoint ?? "http://127.0.0.1:9000");
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: accessKey ?? "disabled",
    secretKey: secretKey ?? "disabled",
    region,
    retryOptions: { disableRetry: true },
  });
}

describe.skipIf(!enabled)("MinIO artifact integration", () => {
  const store = new MinioArtifactStore({
    endpoint: endpoint ?? "http://127.0.0.1:9000",
    accessKey: accessKey ?? "disabled",
    secretKey: secretKey ?? "disabled",
    bucket,
    region,
  });
  const client = rawClient();

  afterAll(async () => {
    await store.delete(objectKey).catch(() => undefined);
  });

  it("round-trips content and object metadata", async () => {
    const body = Buffer.from('{"ok":true}');
    await store.put({
      key: objectKey,
      body,
      contentType: "application/json",
      metadata: { contract: "artifact-store" },
    });

    await expect(store.get(objectKey)).resolves.toEqual(body);
    const stat = await client.statObject(bucket, objectKey);
    expect(stat.metaData["content-type"]).toBe("application/json");
    expect(stat.metaData.contract).toBe("artifact-store");

    await store.delete(objectKey);
    await expect(store.get(objectKey)).resolves.toBeNull();
    await expect(store.delete(objectKey)).resolves.toBeUndefined();
  });

  it("cannot inspect a bucket outside the application policy", async () => {
    await expect(
      client.bucketExists("firecrawl-artifacts-forbidden"),
    ).rejects.toMatchObject({ code: "AccessDenied" });
  });

  it.skipIf(process.env.TEST_LOCAL_ARTIFACT_E2E !== "true")(
    "persists API scrape output and its local manifest",
    async () => {
      const apiEndpoint = process.env.TEST_API_ENDPOINT;
      const databaseUrl = process.env.APPLICATION_DATABASE_URL;
      if (!apiEndpoint || !databaseUrl) {
        throw new Error(
          "TEST_API_ENDPOINT and APPLICATION_DATABASE_URL are required",
        );
      }
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      let key: string | undefined;
      try {
        const url = `https://example.com/?artifact-e2e=${randomUUID()}`;
        const response = await fetch(`${apiEndpoint}/v2/scrape`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url,
            formats: ["markdown"],
            maxAge: 0,
            storeInCache: false,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const payload = (await response.json()) as {
          success?: boolean;
          data?: { metadata?: { scrapeId?: string } };
        };
        expect(response.status, JSON.stringify(payload)).toBe(200);
        expect(payload.success).toBe(true);
        const scrapeId = payload.data?.metadata?.scrapeId;
        expect(scrapeId).toMatch(/^[0-9a-f-]{36}$/);
        key = jobArtifactKey(scrapeId!);

        const manifest = await pool.query<{
          object_key: string;
          kind: string;
          content_type: string;
          byte_size: string;
          retained: boolean;
        }>(
          `SELECT object_key, kind, content_type, byte_size::text,
                  delete_after > created_at AS retained
             FROM local_artifacts
            WHERE job_id = $1`,
          [scrapeId],
        );
        expect(manifest.rows).toEqual([
          {
            object_key: key,
            kind: "scrape",
            content_type: "application/json",
            byte_size: expect.stringMatching(/^[1-9][0-9]*$/),
            retained: true,
          },
        ]);

        const artifact = await store.get(key);
        expect(artifact).not.toBeNull();
        expect(JSON.parse(artifact!.toString())).toHaveLength(1);
      } finally {
        if (key) {
          await store.delete(key).catch(() => undefined);
          await pool
            .query("DELETE FROM local_artifacts WHERE object_key = $1", [key])
            .catch(() => undefined);
        }
        await pool.end();
      }
    },
    70_000,
  );

  it.skipIf(!localManifestEnabled)(
    "persists PDF and monitor objects with exact local manifests",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const pdfContent = `integration-pdf-${randomUUID()}`;
      const pdfResult = {
        markdown: "unicode π markdown",
        html: "<p>unicode π html</p>",
      };
      const pdfKey = `pdf-cache-v2/${createPdfCacheKey(pdfContent)}.json`;
      const monitorKey = `${prefix}/${randomUUID()}.diff.json`;
      const monitorArtifact = {
        kind: "markdown" as const,
        url: "https://example.com/integration-monitor",
        previousScrapeId: null,
        currentScrapeId: null,
        generatedAt: new Date().toISOString(),
        text: "unicode π diff",
        json: { changed: true },
      };

      try {
        await savePdfResultToCache(pdfContent, pdfResult);
        await saveMonitorDiffArtifact(monitorKey, monitorArtifact);

        const pdfBody = await store.get(pdfKey);
        const monitorBody = await store.get(monitorKey);
        expect(pdfBody?.toString()).toBe(JSON.stringify(pdfResult));
        expect(monitorBody?.toString()).toBe(JSON.stringify(monitorArtifact));

        const manifests = await pool.query<{
          object_key: string;
          owner_id: string;
          request_id: string | null;
          job_id: string | null;
          kind: string;
          content_type: string;
          byte_size: string;
          retained: boolean;
        }>(
          `SELECT object_key, owner_id::text, request_id::text, job_id::text,
                  kind, content_type, byte_size::text,
                  delete_after > created_at AS retained
             FROM local_artifacts
            WHERE object_key = ANY($1::text[])
            ORDER BY kind`,
          [[pdfKey, monitorKey]],
        );
        expect(manifests.rows).toEqual([
          {
            object_key: monitorKey,
            owner_id: ownerId,
            request_id: null,
            job_id: null,
            kind: "monitor-diff",
            content_type: "application/json",
            byte_size: String(monitorBody!.byteLength),
            retained: true,
          },
          {
            object_key: pdfKey,
            owner_id: ownerId,
            request_id: null,
            job_id: null,
            kind: "pdf-cache",
            content_type: "application/json",
            byte_size: String(pdfBody!.byteLength),
            retained: true,
          },
        ]);
      } finally {
        await Promise.all([
          store.delete(pdfKey).catch(() => undefined),
          store.delete(monitorKey).catch(() => undefined),
        ]);
        await pool
          .query(
            "DELETE FROM local_artifacts WHERE object_key = ANY($1::text[])",
            [[pdfKey, monitorKey]],
          )
          .catch(() => undefined);
        await pool.end();
      }
    },
  );

  it.skipIf(!localManifestEnabled)(
    "rolls back only newly unmanifested local objects",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const newKey = `${prefix}/${randomUUID()}-new.json`;
      const existingKey = `${prefix}/${randomUUID()}-existing.json`;
      const validInput = {
        key: existingKey,
        body: "existing",
        contentType: "application/json",
        ownerId: ownerId!,
        requestId: null,
        jobId: null,
        kind: "scrape",
        deleteAfter: new Date(Date.now() + 86_400_000),
      };

      try {
        await expect(
          putLocalArtifactWithManifest(store, {
            ...validInput,
            key: newKey,
            ownerId: "not-a-uuid",
          }),
        ).rejects.toThrow();
        await expect(store.get(newKey)).resolves.toBeNull();

        await putLocalArtifactWithManifest(store, validInput);
        await expect(
          putLocalArtifactWithManifest(store, {
            ...validInput,
            body: "replacement",
            ownerId: "not-a-uuid",
          }),
        ).rejects.toThrow();
        await expect(store.get(existingKey)).resolves.toEqual(
          Buffer.from("replacement"),
        );
        const manifest = await pool.query(
          "SELECT object_key FROM local_artifacts WHERE object_key = $1",
          [existingKey],
        );
        expect(manifest.rowCount).toBe(1);
      } finally {
        await Promise.all([
          store.delete(newKey).catch(() => undefined),
          store.delete(existingKey).catch(() => undefined),
        ]);
        await pool
          .query(
            "DELETE FROM local_artifacts WHERE object_key = ANY($1::text[])",
            [[newKey, existingKey]],
          )
          .catch(() => undefined);
        await pool.end();
      }
    },
  );

  it.skipIf(!localManifestEnabled)(
    "serializes concurrent same-key local writers",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const key = `${prefix}/${randomUUID()}-concurrent.json`;
      let putCount = 0;
      let releaseFirst!: () => void;
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>(resolve => {
        markFirstEntered = resolve;
      });
      const firstRelease = new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      const instrumentedStore: ArtifactStore = {
        provider: store.provider,
        put: async input => {
          putCount += 1;
          if (putCount === 1) {
            markFirstEntered();
            await firstRelease;
          }
          return store.put(input);
        },
        get: key => store.get(key),
        delete: key => store.delete(key),
        health: () => store.health(),
      };
      const common = {
        key,
        contentType: "application/json",
        requestId: null,
        jobId: null,
        kind: "scrape",
        deleteAfter: new Date(Date.now() + 86_400_000),
      };

      try {
        const first = putLocalArtifactWithManifest(instrumentedStore, {
          ...common,
          body: "first",
          ownerId: "not-a-uuid",
        }).catch(error => error);
        await firstEntered;
        const second = putLocalArtifactWithManifest(instrumentedStore, {
          ...common,
          body: "second",
          ownerId: ownerId!,
        });

        let waitingOnLock = false;
        const deadline = Date.now() + 5_000;
        while (!waitingOnLock && Date.now() < deadline) {
          const waiting = await pool.query<{ waiting: boolean }>(`
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%pg_advisory_xact_lock%'
            ) AS waiting
          `);
          waitingOnLock = waiting.rows[0]?.waiting === true;
          if (!waitingOnLock) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        expect(waitingOnLock).toBe(true);
        expect(putCount).toBe(1);

        releaseFirst();
        expect(await first).toBeInstanceOf(Error);
        await second;
        expect(putCount).toBe(2);
        await expect(store.get(key)).resolves.toEqual(Buffer.from("second"));
        const manifest = await pool.query(
          "SELECT object_key FROM local_artifacts WHERE object_key = $1",
          [key],
        );
        expect(manifest.rowCount).toBe(1);
      } finally {
        releaseFirst();
        await store.delete(key).catch(() => undefined);
        await pool
          .query("DELETE FROM local_artifacts WHERE object_key = $1", [key])
          .catch(() => undefined);
        await pool.end();
      }
    },
    15_000,
  );
});
