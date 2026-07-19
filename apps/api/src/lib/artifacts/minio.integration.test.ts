import { randomUUID } from "node:crypto";
import { Client } from "minio";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MinioArtifactStore } from "./minio";
import { jobArtifactKey } from ".";

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
});
