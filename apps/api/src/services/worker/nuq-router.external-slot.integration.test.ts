import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const redisUrl = process.env.TEST_REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

describeWithRedis("NuQ external Redis slot release", () => {
  beforeAll(() => {
    process.env.REDIS_URL = redisUrl!;
    process.env.REDIS_EVICT_URL = redisUrl!;
    process.env.REDIS_RATE_LIMIT_URL = redisUrl!;
  });

  afterAll(async () => {
    const [{ getRedisConnection }, { redisEvictConnection }, rateLimiter] =
      await Promise.all([
        import("../queue-service.js"),
        import("../redis.js"),
        import("../rate-limiter.js"),
      ]);
    getRedisConnection().disconnect();
    redisEvictConnection.disconnect();
    rateLimiter.redisRateLimitClient.disconnect();
  });

  it("removes the exact persisted holder through the routed release", async () => {
    const concurrency = await import("../../lib/concurrency-redis.js");
    const router = await import("./nuq-router.js");
    const teamId = randomUUID();
    const holderId = randomUUID();

    await concurrency.pushConcurrencyLimitActiveJob(teamId, holderId, 60_000);
    expect(await concurrency.getConcurrencyLimitActiveJobsCount(teamId)).toBe(
      1,
    );

    await router.releaseExternalSlotBackend(teamId, holderId, "redis");

    expect(await concurrency.getConcurrencyLimitActiveJobsCount(teamId)).toBe(
      0,
    );
  });

  it("keeps keyless dedupe permanent until PostgreSQL ack then retains it beyond 30 days", async () => {
    const keyless = await import("../../lib/keyless.js");
    const { redisRateLimitClient } = await import("../rate-limiter.js");
    const sessionId = randomUUID();
    const ip = "203.0.113.211";
    const teamId = `preview_keyless_${ip}`;
    const counterKey = `keyless_credits:${ip}`;
    const receiptKey = `keyless_browser_reconcile:${sessionId}`;
    const retainedSeconds = 37 * 86_400;
    await redisRateLimitClient.del(counterKey, receiptKey);
    await redisRateLimitClient.set(counterKey, 8, "EX", 86_400);

    await expect(
      keyless.reconcileBrowserKeylessCreditsOnce(teamId, 8, 3, sessionId),
    ).resolves.toBe(true);
    await expect(redisRateLimitClient.pttl(receiptKey)).resolves.toBe(-1);
    await expect(
      keyless.reconcileBrowserKeylessCreditsOnce(teamId, 8, 3, sessionId),
    ).resolves.toBe(false);
    await expect(redisRateLimitClient.get(counterKey)).resolves.toBe("3");

    await keyless.expireBrowserKeylessReconcileReceipt(
      sessionId,
      retainedSeconds,
    );
    expect(await redisRateLimitClient.ttl(receiptKey)).toBeGreaterThanOrEqual(
      retainedSeconds - 1,
    );
    await redisRateLimitClient.del(counterKey, receiptKey);
  });
});
