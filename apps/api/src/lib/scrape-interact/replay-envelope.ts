import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";

import { z } from "zod";

import {
  URL as requestUrlSchema,
  type BaseScrapeOptions,
} from "../../controllers/v2/types";
import { countries } from "../validate-country";
import { rewriteUrl } from "../../scraper/scrapeURL/lib/rewriteUrl";

/** @public */
export type ReplayAction =
  | { type: "wait"; milliseconds?: number; selector?: string }
  | { type: "click"; selector: string; all?: boolean }
  | {
      type: "screenshot";
      fullPage?: boolean;
      quality?: number;
      viewport?: { width: number; height: number };
    }
  | { type: "write"; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; direction?: "up" | "down"; selector?: string }
  | { type: "scrape" }
  | { type: "executeJavascript"; script: string }
  | {
      type: "pdf";
      landscape?: boolean;
      scale?: number;
      format?:
        | "A0"
        | "A1"
        | "A2"
        | "A3"
        | "A4"
        | "A5"
        | "A6"
        | "Letter"
        | "Legal"
        | "Tabloid"
        | "Ledger";
    };

/** @public */
export type ReplayActionEffect = "read_only" | "side_effecting";

/** @public */
export interface ReplayBrowserSettingsV1 {
  headers: Record<string, string>;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
  };
  deviceName?: string;
  userAgent: string;
  locale: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
  location: { country: string; languages: string[] };
  proxy: {
    kind: "basic" | "stealth" | "enhanced" | "auto";
    country?: string;
    credentialRef?: string;
  };
  skipTlsVerification: boolean;
  blockAds: boolean;
  lockdown: boolean;
}

/** @public */
export interface ReplayEnvelopeV1 {
  version: 1;
  navigationPolicyVersion: 1;
  canonicalTargetUrl: string;
  callerOrigin: string;
  waitForMs: number;
  browserSettings: ReplayBrowserSettingsV1;
  profile?: {
    name: string;
    saveChanges: boolean;
    generationId?: string;
  };
  actions: Array<{
    index: number;
    effect: ReplayActionEffect;
    action: ReplayAction;
  }>;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** @public */
export interface StoredReplayCheckpoint {
  version: 1;
  statePath: string;
  storageState: {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
      partitionKey?: string;
      _crHasCrossSiteAncestor?: boolean;
    }>;
    origins: Array<{
      origin: string;
      localStorage: Array<{ name: string; value: string }>;
      indexedDB?: Array<{
        name: string;
        version: number;
        stores: Array<{
          name: string;
          autoIncrement: boolean;
          keyPath?: string;
          keyPathArray?: string[];
          records: Array<{
            key?: JsonValue;
            keyEncoded?: JsonValue;
            value?: JsonValue;
            valueEncoded?: JsonValue;
          }>;
          indexes: Array<{
            name: string;
            keyPath?: string;
            keyPathArray?: string[];
            multiEntry: boolean;
            unique: boolean;
          }>;
        }>;
      }>;
    }>;
  };
  finalUrl: string;
  fingerprint: {
    finalUrl: string;
    titleSha256: string;
    bodyTextSha256: string;
  };
  checksum: string;
  byteSize: number;
}

/** @public */
export type ReplayResolution =
  | {
      kind: "checkpoint";
      envelope: ReplayEnvelopeV1;
      checkpoint: StoredReplayCheckpoint;
    }
  | {
      kind: "legacy";
      envelope: ReplayEnvelopeV1;
      safeActions: ReplayAction[];
    }
  | ReplayError;

/** @public */
export interface ReplayEnvelopeSource {
  url: unknown;
  options: unknown;
  callerOrigin: unknown;
  browserSettings?: unknown;
  profileGenerationId?: unknown;
  checkpoint?: unknown;
  zeroDataRetention?: boolean;
}

type ReplayError = {
  kind: "error";
  category: "replay_unavailable" | "replay_unsupported";
  fields: string[];
  message: string;
};

/** @public */
export type ReplayEnvelopeNormalization =
  | { kind: "ok"; envelope: ReplayEnvelopeV1 }
  | ReplayError;

const boundedString = (maximum: number) => z.string().min(1).max(maximum);
const specialLocationCountries = new Set(["us-generic", "us-whitelist"]);

function isLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

const languageTagSchema = boundedString(128).refine(isLanguageTag);
const timeZoneSchema = boundedString(256).refine(isTimeZone);

const headersSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, context) => {
    for (const [name, value] of Object.entries(headers)) {
      try {
        validateHeaderName(name);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Invalid header name",
        });
      }
      try {
        validateHeaderValue(name, value);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Invalid header value",
        });
      }
    }
  });

function isSupportedLocationCountry(value: string): boolean {
  return (
    Object.hasOwn(countries, value.toUpperCase()) ||
    specialLocationCountries.has(value.toLowerCase())
  );
}

const retainedLocationCountrySchema = boundedString(64)
  .refine(isSupportedLocationCountry)
  .transform(value => value.toLowerCase());

const optionLocationCountrySchema = z
  .string()
  .max(64)
  .refine(value => !value || isSupportedLocationCountry(value))
  .transform(value => (value ? value.toLowerCase() : "us-generic"));

const viewportSchema = z.strictObject({
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
  deviceScaleFactor: z.number().positive().finite().max(10),
  isMobile: z.boolean(),
  hasTouch: z.boolean(),
});

const locationSchema = z.strictObject({
  country: retainedLocationCountrySchema,
  languages: z.array(languageTagSchema).max(32),
});

const browserSettingsSchema = z.strictObject({
  headers: headersSchema,
  cookies: z
    .array(
      z.strictObject({
        name: boundedString(4_096),
        value: z.string().max(64 * 1024),
        domain: boundedString(4_096),
        path: boundedString(4_096),
        expires: z.number().finite(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(["Strict", "Lax", "None"]),
      }),
    )
    .max(10_000),
  viewport: viewportSchema,
  deviceName: boundedString(256).optional(),
  userAgent: boundedString(4_096),
  locale: languageTagSchema,
  timezoneId: timeZoneSchema.optional(),
  geolocation: z
    .strictObject({
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
      accuracy: z.number().finite().nonnegative(),
    })
    .optional(),
  location: locationSchema,
  proxy: z.strictObject({
    kind: z.enum(["basic", "stealth", "enhanced", "auto"]),
    country: retainedLocationCountrySchema.optional(),
    credentialRef: z
      .string()
      .regex(/^proxy-credential:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/)
      .refine(value => {
        const opaqueId = value.slice("proxy-credential:".length);
        return !/(?:^|[._-])(?:password|passwd|secret|token|user|username)(?:$|[._-])/i.test(
          opaqueId,
        );
      })
      .optional(),
  }),
  skipTlsVerification: z.boolean(),
  blockAds: z.boolean(),
  lockdown: z.boolean(),
});

const waitActionSchema = z
  .strictObject({
    type: z.literal("wait"),
    milliseconds: z.number().int().positive().finite().max(60_000).optional(),
    selector: boundedString(10_000).optional(),
  })
  .superRefine((action, context) => {
    if (
      (action.milliseconds === undefined) ===
      (action.selector === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "wait requires exactly one duration or selector",
      });
    }
  });

const actionSchema = z.discriminatedUnion("type", [
  waitActionSchema,
  z.strictObject({
    type: z.literal("click"),
    selector: boundedString(10_000),
    all: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("screenshot"),
    fullPage: z.boolean().optional(),
    quality: z.number().min(1).max(100).optional(),
    viewport: z
      .strictObject({
        width: z.number().int().positive().finite().max(7680),
        height: z.number().int().positive().finite().max(4320),
      })
      .optional(),
  }),
  z.strictObject({ type: z.literal("write"), text: z.string().max(40_000) }),
  z.strictObject({ type: z.literal("press"), key: boundedString(128) }),
  z.strictObject({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down"]).optional(),
    selector: boundedString(10_000).optional(),
  }),
  z.strictObject({ type: z.literal("scrape") }),
  z.strictObject({
    type: z.literal("executeJavascript"),
    script: z.string().max(32_000),
  }),
  z.strictObject({
    type: z.literal("pdf"),
    landscape: z.boolean().optional(),
    scale: z.number().finite().optional(),
    format: z
      .enum([
        "A0",
        "A1",
        "A2",
        "A3",
        "A4",
        "A5",
        "A6",
        "Letter",
        "Legal",
        "Tabloid",
        "Ledger",
      ])
      .optional(),
  }),
]);

const optionPolicies = {
  formats: "output_only",
  headers: "browser",
  includeTags: "output_only",
  excludeTags: "output_only",
  onlyMainContent: "output_only",
  onlyCleanContent: "output_only",
  timeout: "output_only",
  waitFor: "browser",
  mobile: "browser",
  parsers: "output_only",
  actions: "browser",
  location: "browser",
  skipTlsVerification: "browser",
  removeBase64Images: "output_only",
  fastMode: "output_only",
  useMock: "output_only",
  blockAds: "browser",
  proxy: "browser",
  maxAge: "output_only",
  minAge: "output_only",
  storeInCache: "output_only",
  lockdown: "browser",
  redactPII: "output_only",
  profile: "browser",
  __searchPreviewToken: "output_only",
  __experimental_omce: "output_only",
  __experimental_omceDomain: "output_only",
  __experimental_engpicker: "output_only",
  __forceFirePDF: "output_only",
} as const satisfies Record<keyof BaseScrapeOptions, "browser" | "output_only">;

const knownOptionKeys = new Set<string>(Object.keys(optionPolicies));

const optionsSchema = z.strictObject({
  headers: headersSchema.optional(),
  waitFor: z.number().int().nonnegative().finite().max(60_000).optional(),
  mobile: z.boolean().optional(),
  actions: z.array(actionSchema).max(50).optional(),
  location: z
    .strictObject({
      country: optionLocationCountrySchema.optional(),
      languages: z.array(languageTagSchema).max(32).optional(),
    })
    .optional(),
  skipTlsVerification: z.boolean().optional(),
  blockAds: z.boolean().optional(),
  proxy: z.enum(["basic", "stealth", "enhanced", "auto"]).optional(),
  lockdown: z.boolean().optional(),
  profile: z
    .strictObject({
      name: boundedString(128),
      saveChanges: z.boolean().optional(),
    })
    .optional(),
  formats: z.unknown().optional(),
  includeTags: z.unknown().optional(),
  excludeTags: z.unknown().optional(),
  onlyMainContent: z.unknown().optional(),
  onlyCleanContent: z.unknown().optional(),
  timeout: z.unknown().optional(),
  parsers: z.unknown().optional(),
  removeBase64Images: z.unknown().optional(),
  fastMode: z.unknown().optional(),
  useMock: z.unknown().optional(),
  maxAge: z.unknown().optional(),
  minAge: z.unknown().optional(),
  storeInCache: z.unknown().optional(),
  redactPII: z.unknown().optional(),
  __searchPreviewToken: z.unknown().optional(),
  __experimental_omce: z.unknown().optional(),
  __experimental_omceDomain: z.unknown().optional(),
  __experimental_engpicker: z.unknown().optional(),
  __forceFirePDF: z.unknown().optional(),
});

const retainedUrlSchema = z
  .url()
  .regex(/^https?:\/\//i)
  .refine(value => isAllowedRetainedUrl(value));

const storageCookieSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number().finite(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  partitionKey: z.string().optional(),
  _crHasCrossSiteAncestor: z.boolean().optional(),
});

const indexedDBRecordSchema = z
  .strictObject({
    key: z.json().optional(),
    keyEncoded: z.json().optional(),
    value: z.json().optional(),
    valueEncoded: z.json().optional(),
  })
  .superRefine((record, context) => {
    if ((record.key === undefined) === (record.keyEncoded === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["key"],
        message: "Invalid IndexedDB key",
      });
    }
    if ((record.value === undefined) === (record.valueEncoded === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Invalid IndexedDB value",
      });
    }
  });

const indexedDBIndexSchema = z.strictObject({
  name: z.string(),
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
  multiEntry: z.boolean(),
  unique: z.boolean(),
});

const indexedDBStoreSchema = z.strictObject({
  name: z.string(),
  autoIncrement: z.boolean(),
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
  records: z.array(indexedDBRecordSchema),
  indexes: z.array(indexedDBIndexSchema),
});

const indexedDBDatabaseSchema = z.strictObject({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(indexedDBStoreSchema),
});

const storageStateSchema = z.strictObject({
  cookies: z.array(storageCookieSchema),
  origins: z.array(
    z.strictObject({
      origin: retainedUrlSchema,
      localStorage: z.array(
        z.strictObject({ name: z.string(), value: z.string() }),
      ),
      indexedDB: z.array(indexedDBDatabaseSchema).optional(),
    }),
  ),
});

const checkpointSchema = z
  .strictObject({
    version: z.literal(1),
    statePath: boundedString(4_096),
    storageState: storageStateSchema,
    finalUrl: retainedUrlSchema,
    fingerprint: z.strictObject({
      finalUrl: retainedUrlSchema,
      titleSha256: z.string().regex(/^[a-f0-9]{64}$/),
      bodyTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().nonnegative().safe(),
  })
  .superRefine((value, context) => {
    if (value.finalUrl !== value.fingerprint.finalUrl) {
      context.addIssue({
        code: "custom",
        path: ["fingerprint", "finalUrl"],
        message: "fingerprint URL must equal checkpoint URL",
      });
    }
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldsFromIssues(
  prefix: string | undefined,
  issues: z.core.$ZodIssue[],
): string[] {
  return issues.flatMap(issue => {
    const base = [prefix, ...issue.path.map(String)].filter(Boolean);
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map(key => [...base, key].join("."));
    }
    const field = base.join(".");
    return field ? [field] : [];
  });
}

function sortedFields(fields: Iterable<string>): string[] {
  return [...new Set(fields)].sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function detachAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function error(
  category: ReplayError["category"],
  fields: Iterable<string>,
): ReplayError {
  const normalizedFields = sortedFields(fields);
  return detachAndFreeze({
    kind: "error",
    category,
    fields: normalizedFields,
    message:
      category === "replay_unavailable"
        ? `Replay state is unavailable: ${normalizedFields.join(", ")}`
        : `Replay state is unsupported: ${normalizedFields.join(", ")}`,
  } satisfies ReplayError);
}

function isRedacted(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("<redacted");
}

function isAllowedRetainedUrl(value: string): boolean {
  if (!requestUrlSchema.safeParse(value).success) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const unbracketedHostname = hostname.replace(/^\[|\]$/g, "");
    return (
      url.username.length === 0 &&
      url.password.length === 0 &&
      hostname.includes(".") &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      hostname !== "local" &&
      !hostname.endsWith(".local") &&
      isIP(unbracketedHostname) === 0
    );
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function canonicalUrl(value: string): string | undefined {
  const rewritten = rewriteUrl(value) ?? value;
  try {
    const url = new URL(rewritten);
    if (!isAllowedRetainedUrl(url.href)) return;
    return url.href;
  } catch {
    return;
  }
}

function deriveBrowserSettings(
  options: z.output<typeof optionsSchema>,
): ReplayBrowserSettingsV1 {
  const mobile = options.mobile ?? false;
  const location = {
    country: options.location?.country?.toLowerCase() ?? "us-generic",
    languages: options.location?.languages ?? ["en-US"],
  };
  const userAgentEntry = Object.entries(options.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "user-agent",
  );
  return {
    headers: options.headers ?? {},
    cookies: [],
    viewport: mobile
      ? {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
        }
      : {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
        },
    userAgent: userAgentEntry?.[1] ?? "Firecrawl",
    locale: location.languages[0] ?? "en-US",
    location,
    proxy: {
      kind: options.proxy ?? "auto",
      ...(location.country ? { country: location.country } : {}),
    },
    skipTlsVerification: options.skipTlsVerification ?? false,
    blockAds: options.blockAds ?? true,
    lockdown: options.lockdown ?? false,
  };
}

function effectForAction(action: ReplayAction): ReplayActionEffect {
  switch (action.type) {
    case "wait":
    case "scroll":
    case "screenshot":
    case "pdf":
    case "scrape":
      return "read_only";
    case "click":
    case "write":
    case "press":
    case "executeJavascript":
      return "side_effecting";
  }
}

function aggregateWaitMs(options: z.output<typeof optionsSchema>): number {
  return (
    (options.waitFor ?? 0) +
    (options.actions ?? []).reduce((total, action) => {
      if (action.type !== "wait") return total;
      if (action.milliseconds !== undefined) {
        return total + action.milliseconds;
      }
      return action.selector !== undefined ? total + 1_000 : total;
    }, 0)
  );
}

function legacyUnrepresentableActionFields(options: unknown): string[] {
  if (!isRecord(options) || !Array.isArray(options.actions)) return [];
  return options.actions.flatMap((action, index) => {
    if (!isRecord(action)) return [`actions.${index}`];
    if (
      action.type === "click" ||
      action.type === "write" ||
      action.type === "press" ||
      action.type === "executeJavascript"
    ) {
      return [`actions.${index}`];
    }
    return actionSchema.safeParse(action).success ? [] : [`actions.${index}`];
  });
}

export function normalizeReplayEnvelope(
  source: ReplayEnvelopeSource,
): ReplayEnvelopeNormalization {
  if (source.zeroDataRetention) {
    return error("replay_unavailable", ["options", "url"]);
  }

  const unavailable: string[] = [];
  if (
    typeof source.url !== "string" ||
    source.url.trim().length === 0 ||
    isRedacted(source.url)
  ) {
    unavailable.push("url");
  }
  if (!isRecord(source.options) || isRedacted(source.options)) {
    unavailable.push("options");
  }
  if (unavailable.length > 0) {
    return error("replay_unavailable", unavailable);
  }

  const unsupported: string[] = [];
  const rawOptions = source.options as Record<string, unknown>;
  for (const key of Object.keys(rawOptions)) {
    if (!knownOptionKeys.has(key)) unsupported.push(key);
  }

  const parsedOptions = optionsSchema.safeParse(rawOptions);
  if (!parsedOptions.success) {
    unsupported.push(
      ...fieldsFromIssues(undefined, parsedOptions.error.issues),
    );
  } else if (aggregateWaitMs(parsedOptions.data) > 60_000) {
    unsupported.push("actions", "waitFor");
  }

  const targetUrl = canonicalUrl(source.url as string);
  if (!targetUrl) unsupported.push("url");
  if (
    typeof source.callerOrigin !== "string" ||
    source.callerOrigin.trim().length === 0 ||
    source.callerOrigin.length > 256
  ) {
    unsupported.push("callerOrigin");
  }

  let browserSettings: ReplayBrowserSettingsV1 | undefined;
  if (source.browserSettings !== undefined) {
    const parsedSettings = browserSettingsSchema.safeParse(
      source.browserSettings,
    );
    if (parsedSettings.success) {
      browserSettings = parsedSettings.data;
    } else {
      unsupported.push(
        ...fieldsFromIssues("browserSettings", parsedSettings.error.issues),
      );
    }
  } else if (parsedOptions.success) {
    browserSettings = deriveBrowserSettings(parsedOptions.data);
  }

  if (
    source.profileGenerationId !== undefined &&
    (typeof source.profileGenerationId !== "string" ||
      source.profileGenerationId.length === 0 ||
      source.profileGenerationId.length > 1_024)
  ) {
    unsupported.push("profile.generationId");
  }
  if (
    typeof source.profileGenerationId === "string" &&
    rawOptions.profile === undefined
  ) {
    unsupported.push("profile.generationId");
  }

  if (
    unsupported.length > 0 ||
    !parsedOptions.success ||
    !targetUrl ||
    !browserSettings
  ) {
    return error("replay_unsupported", unsupported);
  }

  const profile = parsedOptions.data.profile
    ? {
        name: parsedOptions.data.profile.name,
        saveChanges: parsedOptions.data.profile.saveChanges ?? true,
        ...(typeof source.profileGenerationId === "string"
          ? { generationId: source.profileGenerationId }
          : {}),
      }
    : undefined;
  const actions = (parsedOptions.data.actions ?? []).map((action, index) => ({
    index,
    effect: effectForAction(action),
    action,
  }));

  return detachAndFreeze({
    kind: "ok",
    envelope: {
      version: 1,
      navigationPolicyVersion: 1,
      canonicalTargetUrl: targetUrl,
      callerOrigin: source.callerOrigin as string,
      waitForMs: parsedOptions.data.waitFor ?? 0,
      browserSettings,
      ...(profile ? { profile } : {}),
      actions,
    },
  } satisfies ReplayEnvelopeNormalization);
}

export function resolveReplayEnvelope(
  source: ReplayEnvelopeSource,
): ReplayResolution {
  const normalized = normalizeReplayEnvelope(source);
  const parsedCheckpoint =
    source.checkpoint === undefined
      ? undefined
      : checkpointSchema.safeParse(source.checkpoint);
  if (normalized.kind === "error") {
    const fields = [...normalized.fields];
    let category = normalized.category;
    if (parsedCheckpoint && !parsedCheckpoint.success) {
      fields.push(
        ...fieldsFromIssues("checkpoint", parsedCheckpoint.error.issues),
      );
      category = "replay_unavailable";
    }
    if (
      normalized.category === "replay_unsupported" &&
      source.checkpoint === undefined
    ) {
      fields.push(...legacyUnrepresentableActionFields(source.options));
    }
    return error(category, fields);
  }

  if (parsedCheckpoint !== undefined) {
    if (!parsedCheckpoint.success) {
      return error(
        "replay_unavailable",
        fieldsFromIssues("checkpoint", parsedCheckpoint.error.issues),
      );
    }
    return detachAndFreeze({
      kind: "checkpoint",
      envelope: normalized.envelope,
      checkpoint: parsedCheckpoint.data,
    } satisfies ReplayResolution);
  }

  const unsafeFields = normalized.envelope.actions
    .filter(action => action.effect === "side_effecting")
    .map(action => `actions.${action.index}`);
  if (
    normalized.envelope.profile &&
    normalized.envelope.profile.generationId === undefined
  ) {
    unsafeFields.push("profile.generationId");
  }
  if (unsafeFields.length > 0) {
    return error("replay_unsupported", unsafeFields);
  }

  return detachAndFreeze({
    kind: "legacy",
    envelope: normalized.envelope,
    safeActions: normalized.envelope.actions.map(action => action.action),
  } satisfies ReplayResolution);
}
