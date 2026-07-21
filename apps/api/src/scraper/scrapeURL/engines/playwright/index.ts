import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";

class CheckpointTooLargeError extends Error {
  readonly category = "checkpoint_too_large";

  constructor(message: string) {
    super(message);
    this.name = "CheckpointTooLargeError";
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const indexedDBRecordSchema = z.strictObject({
  key: jsonValueSchema.optional(),
  keyEncoded: jsonValueSchema.optional(),
  value: jsonValueSchema.optional(),
  valueEncoded: jsonValueSchema.optional(),
});

const storageStateSchema = z.strictObject({
  cookies: z.array(
    z.strictObject({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
      partitionKey: z.string().optional(),
      _crHasCrossSiteAncestor: z.boolean().optional(),
    }),
  ),
  origins: z.array(
    z.strictObject({
      origin: z.string(),
      localStorage: z.array(
        z.strictObject({ name: z.string(), value: z.string() }),
      ),
      indexedDB: z
        .array(
          z.strictObject({
            name: z.string(),
            version: z.number(),
            stores: z.array(
              z.strictObject({
                name: z.string(),
                autoIncrement: z.boolean(),
                keyPath: z.string().optional(),
                keyPathArray: z.array(z.string()).optional(),
                records: z.array(indexedDBRecordSchema),
                indexes: z.array(
                  z.strictObject({
                    name: z.string(),
                    keyPath: z.string().optional(),
                    keyPathArray: z.array(z.string()).optional(),
                    multiEntry: z.boolean(),
                    unique: z.boolean(),
                  }),
                ),
              }),
            ),
          }),
        )
        .optional(),
    }),
  ),
});

const browserSettingsSchema = z.strictObject({
  headers: z.record(z.string(), z.string()),
  cookies: z.array(
    z.strictObject({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
    }),
  ),
  viewport: z.strictObject({
    width: z.number(),
    height: z.number(),
    deviceScaleFactor: z.number(),
    isMobile: z.boolean(),
    hasTouch: z.boolean(),
  }),
  deviceName: z.string().optional(),
  userAgent: z.string(),
  locale: z.string(),
  timezoneId: z.string().optional(),
  geolocation: z
    .strictObject({
      latitude: z.number(),
      longitude: z.number(),
      accuracy: z.number(),
    })
    .optional(),
  location: z.strictObject({
    country: z.string(),
    languages: z.array(z.string()),
  }),
  proxy: z.strictObject({
    kind: z.enum(["basic", "stealth", "enhanced", "auto"]),
    country: z.string().optional(),
    credentialRef: z.string().optional(),
  }),
  skipTlsVerification: z.boolean(),
  blockAds: z.boolean(),
  lockdown: z.boolean(),
});

const replayCheckpointSchema = z.strictObject({
  version: z.literal(1),
  storageState: storageStateSchema,
  finalUrl: z.string(),
  fingerprint: z.strictObject({
    finalUrl: z.string(),
    titleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    bodyTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  browserSettings: browserSettingsSchema,
});

const scrapeResponseSchema = z.union([
  z.strictObject({
    content: z.string(),
    pageStatusCode: z.number(),
    pageError: z.string().optional(),
    contentType: z.string().optional(),
    replayCheckpoint: replayCheckpointSchema.optional(),
  }),
  z.strictObject({
    errorCategory: z.literal("checkpoint_too_large"),
    error: z.string(),
  }),
]);

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const rawResponse = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
      capture_replay_checkpoint:
        (
          config as typeof config & {
            LOCAL_BROWSER_SERVICE_ENABLED?: boolean;
          }
        ).LOCAL_BROWSER_SERVICE_ENABLED === true &&
        !meta.internalOptions.zeroDataRetention,
      mobile: meta.options.mobile,
      location: meta.options.location,
      proxy_kind: meta.options.proxy,
      block_ads: meta.options.blockAds,
      lockdown: meta.options.lockdown,
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.unknown(),
    ignoreFailureStatus: true,
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });
  const response = scrapeResponseSchema.parse(rawResponse);

  if ("errorCategory" in response) {
    throw new CheckpointTooLargeError(response.error);
  }

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    url: meta.rewrittenUrl ?? meta.url, // TODO: impove redirect following
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    replayCheckpoint: response.replayCheckpoint,

    proxyUsed: "basic",
  };
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + 30000;
}
