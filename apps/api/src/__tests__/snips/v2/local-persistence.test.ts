import { randomUUID } from "crypto";
import { Client } from "pg";
import request from "supertest";

import { config } from "../../../config";
import { localPersistenceExternalSettings } from "../../../harness-local-persistence";
import { TEST_API_URL, TEST_SUITE_WEBSITE } from "../lib";
import { scrapeTimeout } from "./lib";

type PersistedScrape = {
  id: string;
  request_id: string;
  team_id: string;
  url: string;
  options: Record<string, unknown>;
  request_team_id: string;
  target_hint: string;
};

const persistencePollIntervalMs = 50;
const persistencePollDeadlineMs = 10_000;

async function waitForPersistedScrape(
  client: Client,
  scrapeId: string,
): Promise<PersistedScrape> {
  const deadline = Date.now() + persistencePollDeadlineMs;

  while (Date.now() <= deadline) {
    const result = await client.query<PersistedScrape>(
      `SELECT s.id,
              s.request_id,
              s.team_id::text AS team_id,
              s.url,
              s.options,
              r.team_id::text AS request_team_id,
              r.target_hint
         FROM scrapes s
         JOIN requests r ON r.id = s.request_id
        WHERE s.id = $1`,
      [scrapeId],
    );
    if (result.rows.length === 1) return result.rows[0];

    await new Promise(resolve =>
      setTimeout(resolve, persistencePollIntervalMs),
    );
  }

  throw new Error(
    `Timed out waiting for persisted request and scrape rows for scrape ${scrapeId}`,
  );
}

async function interactWithScrape(scrapeId: string) {
  return request(TEST_API_URL)
    .post(`/v2/scrape/${scrapeId}/interact`)
    .set("Content-Type", "application/json")
    .send({
      code: "console.log('ownership boundary reached')",
      language: "node",
      timeout: 1,
    });
}

describe("local application persistence", () => {
  it(
    "persists auth-off request and scrape rows under the configured owner",
    async () => {
      expect(config.TEST_SUITE_SELF_HOSTED).toBe(true);
      expect(config.USE_DB_AUTHENTICATION).toBe(false);
      expect(config.LOCAL_PERSISTENCE_ENABLED).toBe(true);
      expect(config.APPLICATION_DATABASE_URL).toBeTruthy();
      expect(config.LOCAL_OWNER_ID).toBeTruthy();
      expect(config.ARTIFACT_STORE_PROVIDER).toBe("none");
      expect(config.GCS_BUCKET_NAME).toBeUndefined();
      expect(config.GCS_CREDENTIALS).toBeUndefined();
      expect(config.GCS_FIRE_ENGINE_BUCKET_NAME).toBeUndefined();
      expect(config.GCS_INDEX_BUCKET_NAME).toBeUndefined();
      expect(config.GCS_MEDIA_BUCKET_NAME).toBeUndefined();
      expect(config.BROWSER_SERVICE_URL).toBeUndefined();
      for (const setting of localPersistenceExternalSettings) {
        expect(process.env).not.toHaveProperty(setting);
      }

      const scrapeResponse = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({
          url: TEST_SUITE_WEBSITE,
          formats: ["markdown"],
        });
      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      const document = scrapeResponse.body.data;
      const scrapeId = document.metadata.scrapeId;
      expect(scrapeId).toBeTruthy();

      const foreignOwnerId = "1f971a90-f4d2-4289-b7b7-5ae8b6367fc3";
      const foreignRequestId = randomUUID();
      const foreignScrapeId = randomUUID();
      const client = new Client({
        connectionString: config.APPLICATION_DATABASE_URL,
      });
      await client.connect();
      try {
        const row = await waitForPersistedScrape(client, scrapeId);
        expect(row.team_id).toBe(config.LOCAL_OWNER_ID);
        expect(row.request_team_id).toBe(config.LOCAL_OWNER_ID);
        expect(row.url).toBe(TEST_SUITE_WEBSITE);
        expect(row.target_hint).toContain(TEST_SUITE_WEBSITE);
        expect(row.options).toEqual(
          expect.objectContaining({ formats: expect.any(Array) }),
        );

        const ownedInteract = await interactWithScrape(scrapeId);
        expect(ownedInteract.statusCode).not.toBe(404);
        expect(ownedInteract.statusCode).not.toBe(403);
        expect(ownedInteract.statusCode).toBe(503);
        expect(ownedInteract.body).toEqual({
          success: false,
          error:
            "Browser feature is not configured (BROWSER_SERVICE_URL is missing).",
        });

        await client.query(
          `INSERT INTO requests
             (id, kind, api_version, team_id, origin, target_hint)
           VALUES ($1, 'scrape', 'v2', $2, 'api', $3)`,
          [foreignRequestId, foreignOwnerId, TEST_SUITE_WEBSITE],
        );
        await client.query(
          `INSERT INTO scrapes
             (id, request_id, url, is_successful, time_taken, team_id,
              options, credits_cost)
           VALUES ($1, $2, $3, true, 1, $4, $5, 1)`,
          [
            foreignScrapeId,
            foreignRequestId,
            TEST_SUITE_WEBSITE,
            foreignOwnerId,
            { formats: [{ type: "markdown" }] },
          ],
        );

        const foreignInteract = await interactWithScrape(foreignScrapeId);
        expect(foreignInteract.statusCode).toBe(403);
        expect(foreignInteract.body).toEqual({
          success: false,
          error: "Forbidden.",
        });
      } finally {
        await client.query("DELETE FROM scrapes WHERE id = $1", [
          foreignScrapeId,
        ]);
        await client.query("DELETE FROM requests WHERE id = $1", [
          foreignRequestId,
        ]);
        await client.end();
      }
    },
    scrapeTimeout,
  );
});
