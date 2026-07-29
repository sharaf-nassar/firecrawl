import crypto from "node:crypto";
import { Client } from "pg";

import { config } from "../../../config";
import { isHarnessControlledBrowserEnvironment } from "../../../harness-browser-command";
import {
  describeIf,
  HAS_PLAYWRIGHT,
  itIf,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  browserCreateRaw,
  browserDeleteRaw,
  browserHarnessRestartRaw,
  browserListRaw,
  Identity,
  idmux,
  scrapeIdFromRawResponse,
  scrapeInteractRaw,
  scrapeRaw,
  scrapeStopInteractiveBrowserRaw,
  scrapeTimeout,
} from "./lib";
import {
  cleanupTrackedResources,
  throwTrackedCleanupFailures,
  type TrackedCleanupFailure,
} from "./tracked-cleanup";

const localBrowserEnabled =
  isHarnessControlledBrowserEnvironment(process.env) &&
  TEST_SELF_HOST &&
  config.LOCAL_BROWSER_SERVICE_ENABLED === true &&
  typeof config.BROWSER_SERVICE_URL === "string";

describeIf(localBrowserEnabled)("local Browser API", () => {
  let identity: Identity;
  const sessions = new Set<string>();
  const scrapes = new Set<string>();

  async function cleanupResources(): Promise<
    Array<TrackedCleanupFailure<unknown>>
  > {
    return [
      ...(await cleanupTrackedResources(scrapes, "scrape", async scrapeId => {
        const response = await scrapeStopInteractiveBrowserRaw(
          scrapeId,
          identity,
        );
        if (response.statusCode !== 200 || response.body.success !== true) {
          throw new Error(
            `Scrape ${scrapeId} cleanup returned ${response.statusCode}`,
          );
        }
      })),
      ...(await cleanupTrackedResources(
        sessions,
        "browser-session",
        async sessionId => {
          const response = await browserDeleteRaw(sessionId, identity);
          if (response.statusCode !== 200 || response.body.success !== true) {
            throw new Error(
              `Browser ${sessionId} cleanup returned ${response.statusCode}`,
            );
          }
        },
      )),
    ];
  }

  async function create(
    body: Parameters<typeof browserCreateRaw>[0] = {},
  ): Promise<{
    id: string;
    cdpUrl: string;
    liveViewUrl: string;
    interactiveLiveViewUrl: string;
  }> {
    const response = await browserCreateRaw(body, identity);
    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(typeof response.body.id).toBe("string");
    sessions.add(response.body.id);
    return response.body;
  }

  async function restartBrowserHarness(): Promise<void> {
    const restartResponse = await browserHarnessRestartRaw();
    expect(restartResponse.status).toBe(200);
    const restarted = (await restartResponse.json()) as {
      oldProcessNonce: string;
      newProcessNonce: string;
    };
    expect(restarted.oldProcessNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(restarted.newProcessNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(restarted.newProcessNonce).not.toBe(restarted.oldProcessNonce);
  }

  beforeAll(async () => {
    identity = await idmux({
      name: "local-browser-contracts",
      concurrency: 20,
      credits: 1_000_000,
    });
  }, 10_000 + scrapeTimeout);

  afterEach(async () => {
    throwTrackedCleanupFailures(await cleanupResources());
  });

  afterAll(async () => {
    throwTrackedCleanupFailures(await cleanupResources());
  });

  it(
    "creates, lists, rotates grants, and deletes a local browser",
    async () => {
      const created = await create({
        ttl: 60,
        activityTtl: 30,
        streamWebView: true,
      });

      expect(created.cdpUrl).toContain("/v2/browser/proxy/");
      expect(created.cdpUrl).toMatch(/\/cdp$/);
      expect(created.liveViewUrl).toContain("/v2/browser/proxy/");
      expect(created.liveViewUrl).toMatch(/\/view$/);
      expect(created.interactiveLiveViewUrl).toContain("/v2/browser/proxy/");
      expect(created.interactiveLiveViewUrl).toMatch(/\/view$/);
      expect(
        new Set([
          created.cdpUrl,
          created.liveViewUrl,
          created.interactiveLiveViewUrl,
        ]).size,
      ).toBe(3);

      const firstList = await browserListRaw(identity);
      const secondList = await browserListRaw(identity);
      expect(firstList.statusCode).toBe(200);
      expect(secondList.statusCode).toBe(200);
      const first = firstList.body.sessions.find(
        (session: { id: string }) => session.id === created.id,
      );
      const second = secondList.body.sessions.find(
        (session: { id: string }) => session.id === created.id,
      );
      expect(first).toMatchObject({
        id: created.id,
        status: "active",
        streamWebView: true,
      });
      expect(second).toBeDefined();
      expect(second.cdpUrl).not.toBe(first.cdpUrl);
      expect(second.liveViewUrl).not.toBe(first.liveViewUrl);
      expect(second.interactiveLiveViewUrl).not.toBe(
        first.interactiveLiveViewUrl,
      );

      const stopped = await browserDeleteRaw(created.id, identity);
      expect(stopped.statusCode).toBe(200);
      expect(stopped.body.success).toBe(true);

      const duplicate = await browserDeleteRaw(created.id, identity);
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.body.success).toBe(true);
      sessions.delete(created.id);

      const destroyed = await browserListRaw(identity, "destroyed");
      expect(destroyed.statusCode).toBe(200);
      expect(destroyed.body.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.id, status: "closed" }),
        ]),
      );
    },
    scrapeTimeout,
  );

  it(
    "enforces the eight-origin limit without collapsing origin grants",
    async () => {
      const allowedDomains = Array.from(
        { length: 8 },
        (_, index) => `origin-${index}.fixture.example`,
      );
      const created = await create({ allowedDomains });
      expect(created.id).toBeTruthy();

      const tooMany = await browserCreateRaw(
        {
          allowedDomains: [...allowedDomains, "origin-8.fixture.example"],
        },
        identity,
      );
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  it(
    "locks profile writers but permits a snapshot reader",
    async () => {
      const profileName = `snip-${crypto.randomUUID()}`;
      const writer = await create({
        profile: { name: profileName, saveChanges: true },
      });

      const locked = await browserCreateRaw(
        {
          profile: { name: profileName, saveChanges: true },
        },
        identity,
      );
      expect(locked.statusCode).toBe(409);
      expect(locked.body).toEqual({
        success: false,
        error: "Another session is currently writing to this profile.",
      });

      const snapshot = await create({
        profile: { name: profileName, saveChanges: false },
      });
      expect(snapshot.id).not.toBe(writer.id);
    },
    scrapeTimeout,
  );

  it(
    "does not disclose or stop another owner's browser",
    async () => {
      const created = await create();
      const ownerId = config.LOCAL_OWNER_ID;
      const databaseUrl = config.APPLICATION_DATABASE_URL;
      expect(ownerId).toBeTruthy();
      expect(databaseUrl).toBeTruthy();

      const foreignOwnerId = crypto.randomUUID();
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO local_owners (id, label)
           VALUES ($1, 'browser-local-snip-foreign')`,
          [foreignOwnerId],
        );
        const changed = await client.query(
          `UPDATE browser_sessions
              SET owner_id = $1
            WHERE id = $2 AND owner_id = $3
          RETURNING id`,
          [foreignOwnerId, created.id, ownerId],
        );
        expect(changed.rowCount).toBe(1);

        const listed = await browserListRaw(identity);
        expect(listed.statusCode).toBe(200);
        expect(
          listed.body.sessions.some(
            (session: { id: string }) => session.id === created.id,
          ),
        ).toBe(false);

        const denied = await browserDeleteRaw(created.id, identity);
        expect(denied.statusCode).toBe(403);
        expect(denied.body).toEqual({
          success: false,
          error: "Forbidden.",
        });
      } finally {
        const failures: unknown[] = [];
        try {
          await client.query(
            `UPDATE browser_sessions SET owner_id = $1 WHERE id = $2`,
            [ownerId, created.id],
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await client.query("DELETE FROM local_owners WHERE id = $1", [
            foreignOwnerId,
          ]);
        } catch (error) {
          failures.push(error);
        }
        try {
          await client.end();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `Foreign-owner cleanup failed for ${foreignOwnerId}`,
          );
        }
      }
    },
    scrapeTimeout,
  );

  it(
    "restarts and admits a new browser",
    async () => {
      const beforeRestart = await create();

      await restartBrowserHarness();

      const released = await browserDeleteRaw(beforeRestart.id, identity);
      expect(released.statusCode).toBe(200);
      expect(released.body.success).toBe(true);
      sessions.delete(beforeRestart.id);

      const afterRestart = await create();
      expect(afterRestart.id).not.toBe(beforeRestart.id);
    },
    scrapeTimeout,
  );

  itIf(HAS_PLAYWRIGHT)(
    "replays a controlled checkpoint after Browser restart",
    async () => {
      await restartBrowserHarness();

      const scrapeResponse = await scrapeRaw(
        {
          url: `${TEST_SUITE_WEBSITE}?afterBrowserRestart=${crypto.randomUUID()}`,
          origin: "website-local-browser-restart-snip",
          formats: ["markdown"],
          maxAge: 0,
        },
        identity,
      );
      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      const scrapeId = scrapeIdFromRawResponse(scrapeResponse.body);
      expect(typeof scrapeId).toBe("string");
      scrapes.add(scrapeId!);

      const replayResponse = await scrapeInteractRaw(
        scrapeId!,
        {
          prompt: "Read the controlled fixture heading.",
          language: "node",
          timeout: 5,
          origin: "local-browser-restart-snip",
          integration: "_local-browser-restart-snip",
          allowedDomains: Array.from(
            { length: 8 },
            (_, index) => `restart-${index}.fixture.example`,
          ),
        },
        identity,
      );
      expect(replayResponse.statusCode).toBe(400);
      expect(replayResponse.body).toEqual({
        success: false,
        error: "allowedDomains and replay origins may contain at most 8 hosts.",
      });
    },
    scrapeTimeout,
  );
});
