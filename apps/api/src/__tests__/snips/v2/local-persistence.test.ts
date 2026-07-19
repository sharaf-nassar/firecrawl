import { Client } from "pg";

import { config } from "../../../config";
import { isScrapeOwnedBy } from "../../../lib/local-owner";
import { TEST_SUITE_WEBSITE } from "../lib";
import { scrape, scrapeTimeout } from "./lib";

type PersistedScrape = {
  id: string;
  request_id: string;
  team_id: string;
  url: string;
  options: Record<string, unknown>;
  request_team_id: string;
  target_hint: string;
};

describe("local application persistence", () => {
  it(
    "persists keyless request and scrape rows under the configured owner",
    async () => {
      expect(config.TEST_SUITE_SELF_HOSTED).toBe(true);
      expect(config.USE_DB_AUTHENTICATION).toBe(false);
      expect(config.LOCAL_PERSISTENCE_ENABLED).toBe(true);
      expect(config.APPLICATION_DATABASE_URL).toBeTruthy();
      expect(config.LOCAL_OWNER_ID).toBeTruthy();

      const document = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: ["markdown"],
        },
        {
          apiKey: "local-persistence",
          teamId: config.LOCAL_OWNER_ID!,
        },
      );
      const scrapeId = document.metadata.scrapeId;
      expect(scrapeId).toBeTruthy();

      const client = new Client({
        connectionString: config.APPLICATION_DATABASE_URL,
      });
      await client.connect();
      try {
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

        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row.team_id).toBe(config.LOCAL_OWNER_ID);
        expect(row.request_team_id).toBe(config.LOCAL_OWNER_ID);
        expect(row.url).toBe(TEST_SUITE_WEBSITE);
        expect(row.target_hint).toContain(TEST_SUITE_WEBSITE);
        expect(row.options).toEqual(
          expect.objectContaining({ formats: expect.any(Array) }),
        );

        expect(
          isScrapeOwnedBy(row.team_id, config.LOCAL_OWNER_ID!, config),
        ).toBe(true);
        expect(
          isScrapeOwnedBy(
            "1f971a90-f4d2-4289-b7b7-5ae8b6367fc3",
            config.LOCAL_OWNER_ID!,
            config,
          ),
        ).toBe(false);
      } finally {
        await client.end();
      }
    },
    scrapeTimeout,
  );
});
