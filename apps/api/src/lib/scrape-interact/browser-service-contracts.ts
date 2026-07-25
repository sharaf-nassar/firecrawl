import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { validateHeaderName, validateHeaderValue } from "node:http";

import { z } from "zod";

const MAX_PRIVATE_REQUEST_BYTES = 256 * 1024;
const MAX_PRIVATE_RESPONSE_BYTES = 128 * 1024;
const MAX_REPLAY_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;
const MAX_ACTION_OPERATION_BYTES = 64 * 1024;
const MAX_ACTION_RESULT_BYTES = 64 * 1024;
const MAX_EVALUATE_RESULT_BYTES = 32 * 1024;
const MAX_RECONCILIATION_REFERENCES = 25_000;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_RUN_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_RUN_ARTIFACTS = 8;
const TOKEN_DECODED_BYTES = 32;
const RELATIVE_STATE_PATH_MAX_BYTES = 1_024;
const JSON_SAFE_MAX_DEPTH = 16;
const JSON_SAFE_MAX_ARRAY_ENTRIES = 1_000;
const JSON_SAFE_MAX_OBJECT_ENTRIES = 256;
const JSON_SAFE_MAX_KEY_CHARS = 256;
const JSON_SAFE_MAX_STRING_BYTES = 64 * 1024;
const HEADER_MAX_COUNT = 256;
const HEADER_MAX_BYTES = 64 * 1024;
const SESSION_TTL_MIN_SECONDS = 30;
const SESSION_TTL_MAX_SECONDS = 3_600;
const SESSION_ACTIVITY_TTL_MIN_SECONDS = 10;
const SESSION_ACTIVITY_TTL_MAX_SECONDS = 600;
const SESSION_MAX_ALLOWED_DOMAINS = 8;
const PRIVATE_ERROR_MAX_MESSAGE_CHARS = 1_024;
const PRIVATE_ERROR_MAX_BYTES = 4 * 1024;
const HTTP_URL_PROTOCOLS = ["http:", "https:"] as const;
const ARTIFACT_CONTENT_TYPES_BY_KIND = {
  screenshot: ["image/png", "image/jpeg"],
  trace: ["application/zip"],
  recording: ["video/webm"],
} as const;
const ARTIFACT_CONTENT_TYPES = [
  ...ARTIFACT_CONTENT_TYPES_BY_KIND.screenshot,
  ...ARTIFACT_CONTENT_TYPES_BY_KIND.trace,
  ...ARTIFACT_CONTENT_TYPES_BY_KIND.recording,
] as const;

/** @public */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("value is not JSON serializable");
  }
  return serialized;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function addSizeIssue(
  value: unknown,
  maximum: number,
  context: z.RefinementCtx,
  message: string,
): void {
  try {
    if (encodedBytes(value) > maximum) {
      context.addIssue({ code: "custom", message });
    }
  } catch {
    context.addIssue({ code: "custom", message: "value is not encodable" });
  }
}

/** @public */
export const canonicalUuidSchema = z
  .string()
  .uuid()
  .refine(value => value === value.toLowerCase(), {
    message: "UUID must be canonical lowercase",
  });

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const tokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(
    value =>
      Buffer.from(value, "base64url").length === TOKEN_DECODED_BYTES &&
      Buffer.from(value, "base64url").toString("base64url") === value,
    { message: "token must be canonical base64url for 32 bytes" },
  );

/** @public */
export const httpUrlSchema = z
  .string()
  .min(1)
  .max(8_192)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "invalid URL" });
      return;
    }
    if (
      !HTTP_URL_PROTOCOLS.includes(
        parsed.protocol as (typeof HTTP_URL_PROTOCOLS)[number],
      ) ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      context.addIssue({ code: "custom", message: "HTTP(S) URL required" });
    }
  });

const initialPageUrlSchema = z.union([z.literal("about:blank"), httpUrlSchema]);

const timestampSchema = z.string().superRefine((value, context) => {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    context.addIssue({
      code: "custom",
      message: "canonical UTC timestamp required",
    });
  }
});

const relativeStatePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const segments = value.split("/");
    if (
      Buffer.byteLength(value, "utf8") > RELATIVE_STATE_PATH_MAX_BYTES ||
      value.startsWith("/") ||
      value.includes("\\") ||
      segments.some(
        segment =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          /[\u0000-\u001f\u007f]/u.test(segment),
      )
    ) {
      context.addIssue({ code: "custom", message: "invalid state path" });
    }
  });

type JsonSafe =
  | null
  | boolean
  | number
  | string
  | JsonSafe[]
  | { [key: string]: JsonSafe };

function isJsonSafeValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
): value is JsonSafe {
  if (depth > JSON_SAFE_MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= JSON_SAFE_MAX_STRING_BYTES;
  }
  if (typeof value !== "object" || seen.has(value)) return false;

  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > JSON_SAFE_MAX_ARRAY_ENTRIES ||
        Object.getOwnPropertyNames(value).length !== value.length + 1
      ) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !isJsonSafeValue(descriptor.value, seen, depth + 1)
        ) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > JSON_SAFE_MAX_OBJECT_ENTRIES) return false;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        key.length > JSON_SAFE_MAX_KEY_CHARS ||
        !isJsonSafeValue(descriptor.value, seen, depth + 1)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

const jsonSafeSchema = z.custom<JsonSafe>(value => {
  try {
    return isJsonSafeValue(value, new Set<object>(), 0);
  } catch {
    return false;
  }
});

const jsonObjectSchema = z.custom<Record<string, JsonSafe>>(value => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return isJsonSafeValue(value, new Set<object>(), 0);
  } catch {
    return false;
  }
});

const refSchema = z.string().min(1).max(128);
const textSchema = z.string().max(20_000);
const safeIntegerSchema = z.number().int().safe().nonnegative();

const browserOperationSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("snapshot") }),
    z.strictObject({ kind: z.literal("click"), ref: refSchema }),
    z.strictObject({
      kind: z.literal("fill"),
      ref: refSchema,
      value: textSchema,
    }),
    z.strictObject({
      kind: z.literal("type"),
      ref: refSchema,
      value: textSchema,
      delayMs: z.number().int().min(0).max(250),
    }),
    z.strictObject({
      kind: z.literal("press"),
      ref: refSchema,
      key: z.string().min(1).max(64),
    }),
    z.strictObject({
      kind: z.literal("select"),
      ref: refSchema,
      values: z.array(z.string().max(512)).max(20),
    }),
    z.strictObject({
      kind: z.literal("scroll"),
      deltaX: z.number().int().min(-10_000).max(10_000),
      deltaY: z.number().int().min(-10_000).max(10_000),
    }),
    z.strictObject({
      kind: z.literal("wait"),
      milliseconds: z.number().int().min(0).max(30_000),
    }),
    z.strictObject({ kind: z.literal("get_text"), ref: refSchema.optional() }),
    z.strictObject({ kind: z.literal("get_url") }),
    z.strictObject({ kind: z.literal("navigate"), url: httpUrlSchema }),
    z.strictObject({
      kind: z.literal("evaluate"),
      expression: textSchema,
      args: jsonObjectSchema,
    }),
  ])
  .superRefine((operation, context) => {
    addSizeIssue(
      operation,
      MAX_ACTION_OPERATION_BYTES,
      context,
      "operation exceeds 64 KiB",
    );
  });

/** @public */
const authorityDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/,
  );

export const actionExecutionRequestSchema = z.strictObject({
  version: z.literal(1),
  actionId: canonicalUuidSchema,
  runId: canonicalUuidSchema,
  sequence: z.number().int().min(1).max(25),
  normalizedProposalHash: sha256Schema,
  effect: z.enum(["read_only", "side_effecting"]),
  expectedSessionVersion: safeIntegerSchema,
  allowedDomains: z.array(authorityDomainSchema).max(8),
  operation: browserOperationSchema,
});

const boundedPageStateSchema = z.strictObject({
  url: initialPageUrlSchema,
  title: z.string().max(4_096),
  snapshotExcerpt: z.string().max(40_000),
});

const evaluateOperationResultSchema = z
  .strictObject({ kind: z.literal("evaluate"), value: jsonSafeSchema })
  .superRefine((result, context) => {
    addSizeIssue(
      result.value,
      MAX_EVALUATE_RESULT_BYTES,
      context,
      "evaluate result exceeds 32 KiB",
    );
  });

/** @public */
export const browserOperationResultSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("snapshot"),
      refCount: z.number().int().min(0).max(500),
    }),
    ...(
      [
        "click",
        "fill",
        "type",
        "press",
        "select",
        "scroll",
        "navigate",
      ] as const
    ).map(kind =>
      z.strictObject({ kind: z.literal(kind), applied: z.literal(true) }),
    ),
    z.strictObject({
      kind: z.literal("wait"),
      waitedMs: z.number().int().min(0).max(30_000),
    }),
    z.strictObject({
      kind: z.literal("get_text"),
      text: z.string().max(40_000),
    }),
    z.strictObject({ kind: z.literal("get_url"), url: httpUrlSchema }),
    evaluateOperationResultSchema,
  ])
  .superRefine((result, context) => {
    addSizeIssue(
      result,
      MAX_ACTION_RESULT_BYTES,
      context,
      "operation result exceeds 64 KiB",
    );
  });

const actionResultBase = {
  version: z.literal(1),
  actionId: canonicalUuidSchema,
  sequence: z.number().int().min(1).max(25),
  normalizedProposalHash: sha256Schema,
  page: boundedPageStateSchema,
  sessionVersion: safeIntegerSchema,
};

const actionErrorSchema = z.strictObject({
  category: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x20-\x7e]+$/),
  message: z.string().max(1_024),
});

/** @public */
export const actionExecutionResultSchema = z
  .discriminatedUnion("outcome", [
    z.strictObject({
      ...actionResultBase,
      outcome: z.literal("succeeded"),
      result: browserOperationResultSchema,
    }),
    z.strictObject({
      ...actionResultBase,
      outcome: z.literal("failed_no_effect"),
      error: actionErrorSchema,
    }),
  ])
  .superRefine((result, context) => {
    addSizeIssue(
      result,
      MAX_PRIVATE_RESPONSE_BYTES,
      context,
      "action response exceeds 128 KiB",
    );
  });

const string1To4096 = z.string().min(1).max(4_096);
const string0To65536 = z.string().max(65_536);
const optionalJsonPair = z
  .strictObject({
    key: jsonSafeSchema.optional(),
    keyEncoded: jsonSafeSchema.optional(),
    value: jsonSafeSchema.optional(),
    valueEncoded: jsonSafeSchema.optional(),
  })
  .superRefine((record, context) => {
    const keyCount =
      Number(record.key !== undefined) +
      Number(record.keyEncoded !== undefined);
    const valueCount =
      Number(record.value !== undefined) +
      Number(record.valueEncoded !== undefined);
    if (keyCount > 1) {
      context.addIssue({
        code: "custom",
        message: "key and keyEncoded are exclusive",
      });
    }
    if (valueCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "exactly one value encoding required",
      });
    }
  });

const keyPathShape = {
  keyPath: z.string().max(4_096).optional(),
  keyPathArray: z.array(z.string().max(4_096)).max(64).optional(),
};

function exclusiveKeyPath(
  value: {
    keyPath?: string | undefined;
    keyPathArray?: string[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.keyPath !== undefined && value.keyPathArray !== undefined) {
    context.addIssue({
      code: "custom",
      message: "key path forms are exclusive",
    });
  }
}

const indexedDbIndexSchema = z
  .strictObject({
    name: string1To4096,
    ...keyPathShape,
    multiEntry: z.boolean(),
    unique: z.boolean(),
  })
  .superRefine((index, context) => {
    const keyPathCount =
      Number(index.keyPath !== undefined) +
      Number(index.keyPathArray !== undefined);
    if (keyPathCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "index requires exactly one key path form",
      });
    }
  });

const indexedDbStoreSchema = z
  .strictObject({
    name: string1To4096,
    autoIncrement: z.boolean(),
    ...keyPathShape,
    records: z.array(optionalJsonPair).max(10_000),
    indexes: z.array(indexedDbIndexSchema).max(256),
  })
  .superRefine((store, context) => {
    exclusiveKeyPath(store, context);
    const usesInlineKeys =
      store.keyPath !== undefined || store.keyPathArray !== undefined;
    for (const record of store.records) {
      const keyCount =
        Number(record.key !== undefined) +
        Number(record.keyEncoded !== undefined);
      if (usesInlineKeys) {
        if (keyCount !== 0) {
          context.addIssue({
            code: "custom",
            message: "inline record must omit key encodings",
          });
        }
      } else if (keyCount !== 1) {
        context.addIssue({
          code: "custom",
          message: "out-of-line record requires exactly one key encoding",
        });
      }
    }
  });

const indexedDbSchema = z.strictObject({
  name: string1To4096,
  version: z.number().int().safe().positive(),
  stores: z.array(indexedDbStoreSchema).max(256),
});

const storageCookieV1Schema = z.strictObject({
  name: string1To4096,
  value: string0To65536,
  domain: string1To4096,
  path: string1To4096,
  expires: z.number().finite(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  partitionKey: string1To4096.optional(),
  _crHasCrossSiteAncestor: z.boolean().optional(),
});

/** @public */
export const storageStateV1Schema = z
  .strictObject({
    cookies: z.array(storageCookieV1Schema).max(10_000),
    origins: z
      .array(
        z.strictObject({
          origin: httpUrlSchema,
          localStorage: z
            .array(
              z.strictObject({
                name: z.string().max(4_096),
                value: string0To65536,
              }),
            )
            .max(10_000),
          indexedDB: z.array(indexedDbSchema).max(256).optional(),
        }),
      )
      .max(256),
  })
  .superRefine((state, context) => {
    addSizeIssue(
      state,
      MAX_STORAGE_STATE_BYTES,
      context,
      "storage state exceeds 2 MiB",
    );
  });

const headersSchema = z
  .record(z.string().min(1).max(256), z.string().max(65_536))
  .superRefine((headers, context) => {
    if (Object.keys(headers).length > HEADER_MAX_COUNT) {
      context.addIssue({ code: "custom", message: "too many headers" });
    }
    for (const [name, value] of Object.entries(headers)) {
      try {
        validateHeaderName(name);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        context.addIssue({
          code: "custom",
          path: [name],
          message: "invalid HTTP header name",
        });
      }
      try {
        validateHeaderValue(name, value);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        context.addIssue({
          code: "custom",
          path: [name],
          message: "invalid HTTP header value",
        });
      }
    }
    if (encodedBytes(headers) > HEADER_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "headers exceed 64 KiB" });
    }
  });

const languageTagSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(value => {
    try {
      Intl.getCanonicalLocales(value);
      return true;
    } catch {
      return false;
    }
  }, "invalid language tag");

const timezoneSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "invalid IANA time zone");

const SUPPORTED_LOCATION_COUNTRIES = [
  "ad",
  "ae",
  "af",
  "ag",
  "ai",
  "al",
  "am",
  "ao",
  "aq",
  "ar",
  "as",
  "at",
  "au",
  "aw",
  "ax",
  "az",
  "ba",
  "bb",
  "bd",
  "be",
  "bf",
  "bg",
  "bh",
  "bi",
  "bj",
  "bl",
  "bm",
  "bn",
  "bo",
  "bq",
  "br",
  "bs",
  "bt",
  "bv",
  "bw",
  "by",
  "bz",
  "ca",
  "cc",
  "cd",
  "cf",
  "cg",
  "ch",
  "ci",
  "ck",
  "cl",
  "cm",
  "cn",
  "co",
  "cr",
  "cu",
  "cv",
  "cw",
  "cx",
  "cy",
  "cz",
  "de",
  "dj",
  "dk",
  "dm",
  "do",
  "dz",
  "ec",
  "ee",
  "eg",
  "eh",
  "er",
  "es",
  "et",
  "fi",
  "fj",
  "fk",
  "fm",
  "fo",
  "fr",
  "ga",
  "gb",
  "gd",
  "ge",
  "gf",
  "gg",
  "gh",
  "gi",
  "gl",
  "gm",
  "gn",
  "gp",
  "gq",
  "gr",
  "gs",
  "gt",
  "gu",
  "gw",
  "gy",
  "hk",
  "hm",
  "hn",
  "hr",
  "ht",
  "hu",
  "id",
  "ie",
  "il",
  "im",
  "in",
  "io",
  "iq",
  "ir",
  "is",
  "it",
  "je",
  "jm",
  "jo",
  "jp",
  "ke",
  "kg",
  "kh",
  "ki",
  "km",
  "kn",
  "kp",
  "kr",
  "kw",
  "ky",
  "kz",
  "la",
  "lb",
  "lc",
  "li",
  "lk",
  "lr",
  "ls",
  "lt",
  "lu",
  "lv",
  "ly",
  "ma",
  "mc",
  "md",
  "me",
  "mf",
  "mg",
  "mh",
  "mk",
  "ml",
  "mm",
  "mn",
  "mo",
  "mp",
  "mq",
  "mr",
  "ms",
  "mt",
  "mu",
  "mv",
  "mw",
  "mx",
  "my",
  "mz",
  "na",
  "nc",
  "ne",
  "nf",
  "ng",
  "ni",
  "nl",
  "no",
  "np",
  "nr",
  "nu",
  "nz",
  "om",
  "pa",
  "pe",
  "pf",
  "pg",
  "ph",
  "pk",
  "pl",
  "pm",
  "pn",
  "pr",
  "ps",
  "pt",
  "pw",
  "py",
  "qa",
  "re",
  "ro",
  "rs",
  "ru",
  "rw",
  "sa",
  "sb",
  "sc",
  "sd",
  "se",
  "sg",
  "sh",
  "si",
  "sj",
  "sk",
  "sl",
  "sm",
  "sn",
  "so",
  "sr",
  "ss",
  "st",
  "sv",
  "sx",
  "sy",
  "sz",
  "tc",
  "td",
  "tf",
  "tg",
  "th",
  "tj",
  "tk",
  "tl",
  "tm",
  "tn",
  "to",
  "tr",
  "tt",
  "tv",
  "tw",
  "tz",
  "ua",
  "ug",
  "um",
  "us",
  "uy",
  "uz",
  "va",
  "vc",
  "ve",
  "vg",
  "vi",
  "vn",
  "vu",
  "wf",
  "ws",
  "xk",
  "ye",
  "yt",
  "za",
  "zm",
  "zw",
  "us-generic",
  "us-whitelist",
] as const;

const supportedLocationCountries = new Set<string>(
  SUPPORTED_LOCATION_COUNTRIES,
);
const countrySchema = z
  .string()
  .min(1)
  .max(64)
  .refine(value => supportedLocationCountries.has(value.toLowerCase()), {
    message: "unsupported country",
  })
  .transform(value => value.toLowerCase());

/** @public */
export const replayBrowserSettingsV1Schema = z.strictObject({
  headers: headersSchema,
  cookies: z.array(storageCookieV1Schema).max(10_000),
  viewport: z.strictObject({
    width: z.number().int().min(1).max(7_680),
    height: z.number().int().min(1).max(4_320),
    deviceScaleFactor: z.number().finite().positive().max(10),
    isMobile: z.boolean(),
    hasTouch: z.boolean(),
  }),
  deviceName: z.string().min(1).max(256).optional(),
  userAgent: z.string().min(1).max(4_096),
  locale: languageTagSchema,
  timezoneId: timezoneSchema.optional(),
  geolocation: z
    .strictObject({
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
      accuracy: z.number().finite().min(0).max(100_000),
    })
    .optional(),
  location: z.strictObject({
    country: countrySchema,
    languages: z.array(languageTagSchema).max(32),
  }),
  proxy: z.strictObject({
    kind: z.enum(["basic", "stealth", "enhanced", "auto"]),
    country: countrySchema.optional(),
    credentialRef: z
      .string()
      .regex(/^proxy-credential:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/)
      .optional(),
  }),
  skipTlsVerification: z.boolean(),
  blockAds: z.boolean(),
  lockdown: z.boolean(),
});

/** @public */
export const replayCheckpointV1Schema = z
  .strictObject({
    checkpointId: canonicalUuidSchema,
    statePath: relativeStatePathSchema,
    checksum: sha256Schema,
    byteSize: z.number().int().min(1).max(MAX_STORAGE_STATE_BYTES),
    storageState: storageStateV1Schema,
    finalUrl: httpUrlSchema,
    fingerprint: z.strictObject({
      finalUrl: httpUrlSchema,
      titleSha256: sha256Schema,
      bodyTextSha256: sha256Schema,
    }),
  })
  .superRefine((checkpoint, context) => {
    if (checkpoint.fingerprint.finalUrl !== checkpoint.finalUrl) {
      context.addIssue({ code: "custom", message: "fingerprint URL mismatch" });
    }
    const bytes = Buffer.from(canonicalJson(checkpoint.storageState), "utf8");
    if (checkpoint.byteSize !== bytes.length) {
      context.addIssue({
        code: "custom",
        message: "checkpoint byte size mismatch",
      });
    }
    if (
      checkpoint.checksum !== createHash("sha256").update(bytes).digest("hex")
    ) {
      context.addIssue({
        code: "custom",
        message: "checkpoint checksum mismatch",
      });
    }
  });

/** @public */
export const profileInputV1Schema = z
  .union([
    z.null(),
    z.strictObject({
      profileId: canonicalUuidSchema,
      mode: z.enum(["writer", "snapshot"]),
      generationId: canonicalUuidSchema.nullable(),
      statePath: relativeStatePathSchema.nullable(),
      checksum: sha256Schema.nullable(),
    }),
  ])
  .superRefine((profile, context) => {
    if (profile === null) return;
    const populated = [
      profile.generationId,
      profile.statePath,
      profile.checksum,
    ].filter(value => value !== null).length;
    if (populated !== 0 && populated !== 3) {
      context.addIssue({
        code: "custom",
        message: "profile generation fields must agree",
      });
    }
  });

const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/,
  );

/** @public */
export const createSessionV1Schema = z
  .strictObject({
    version: z.literal(1),
    sessionId: canonicalUuidSchema,
    initialUrl: initialPageUrlSchema,
    allowedDomains: z.array(hostnameSchema).max(SESSION_MAX_ALLOWED_DOMAINS),
    ttlSeconds: z
      .number()
      .int()
      .min(SESSION_TTL_MIN_SECONDS)
      .max(SESSION_TTL_MAX_SECONDS),
    activityTtlSeconds: z
      .number()
      .int()
      .min(SESSION_ACTIVITY_TTL_MIN_SECONDS)
      .max(SESSION_ACTIVITY_TTL_MAX_SECONDS),
    profile: profileInputV1Schema,
    replay: replayCheckpointV1Schema.nullable(),
    settings: replayBrowserSettingsV1Schema,
  })
  .superRefine((request, context) => {
    if (request.activityTtlSeconds > request.ttlSeconds) {
      context.addIssue({ code: "custom", message: "activity TTL exceeds TTL" });
    }
    const domains = new Set(
      request.allowedDomains.map(value => value.toLowerCase()),
    );
    if (domains.size !== request.allowedDomains.length) {
      context.addIssue({
        code: "custom",
        message: "allowed domains must be unique",
      });
    }
    if (request.initialUrl === "about:blank" && request.replay !== null) {
      context.addIssue({
        code: "custom",
        message: "about:blank initial page cannot restore replay",
      });
    }
    if (
      request.replay !== null &&
      request.profile !== null &&
      request.profile.generationId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "replay and profile generation conflict",
      });
    }
    addSizeIssue(
      request,
      request.replay === null
        ? MAX_PRIVATE_REQUEST_BYTES
        : MAX_REPLAY_REQUEST_BYTES,
      context,
      "create session request exceeds byte cap",
    );
  });

/** @public */
export const sessionV1Schema = z
  .strictObject({
    version: z.literal(1),
    runtimeSessionId: canonicalUuidSchema,
    state: z.enum(["ready", "executing", "stopping"]),
    sessionVersion: safeIntegerSchema,
    page: boundedPageStateSchema,
    expiresAt: timestampSchema,
    idleExpiresAt: timestampSchema,
  })
  .superRefine((session, context) => {
    addSizeIssue(
      session,
      MAX_PRIVATE_RESPONSE_BYTES,
      context,
      "session response exceeds 128 KiB",
    );
  });

/** @public */
export const closeSessionV1Schema = z.strictObject({
  version: z.literal(1),
  reason: z.enum(["requested", "expired", "error", "shutdown"]),
  expectedSessionVersion: safeIntegerSchema,
});

const preparedProfileV1Schema = z.strictObject({
  profileId: canonicalUuidSchema,
  generationId: canonicalUuidSchema,
  checksum: sha256Schema,
  byteSize: z.number().int().safe().min(1).max(268_435_456),
  prepareToken: tokenSchema,
});

/** @public */
export const closedSessionV1Schema = z.strictObject({
  version: z.literal(1),
  runtimeSessionId: canonicalUuidSchema,
  closed: z.literal(true),
  sessionVersion: safeIntegerSchema,
  preparedProfile: preparedProfileV1Schema.nullable(),
});

const finalizeProfileFields = {
  version: z.literal(1),
  profileId: canonicalUuidSchema,
  generationId: canonicalUuidSchema,
  checksum: sha256Schema,
  prepareToken: tokenSchema,
};

/** @public */
export const finalizeProfileGenerationV1Schema = z.strictObject(
  finalizeProfileFields,
);
/** @public */
export const finalizedProfileGenerationV1Schema = z.strictObject({
  version: z.literal(1),
  profileId: canonicalUuidSchema,
  generationId: canonicalUuidSchema,
  checksum: sha256Schema,
  committed: z.literal(true),
});
/** @public */
export const deleteProfileGenerationV1Schema = z.strictObject(
  finalizeProfileFields,
);
/** @public */
export const deletedProfileGenerationV1Schema = z.strictObject({
  version: z.literal(1),
  profileId: canonicalUuidSchema,
  generationId: canonicalUuidSchema,
  checksum: sha256Schema,
  deleted: z.literal(true),
});

/** @public */
export const createRelayGrantV1Schema = z.strictObject({
  version: z.literal(1),
  grantId: canonicalUuidSchema,
  permission: z.enum(["passive", "interactive", "cdp"]),
  expiresAt: timestampSchema,
  useLimit: z.literal(1),
  expectedSessionVersion: safeIntegerSchema,
  allowedDomains: z.array(authorityDomainSchema).max(8),
});
/** @public */
export const relayGrantV1Schema = z.strictObject({
  version: z.literal(1),
  grantId: canonicalUuidSchema,
  permission: z.enum(["passive", "interactive", "cdp"]),
  expiresAt: timestampSchema,
  relayToken: tokenSchema,
});
/** @public */
export const revokeRelayGrantV1Schema = z.strictObject({
  version: z.literal(1),
  grantId: canonicalUuidSchema,
});
/** @public */
export const revokedRelayGrantV1Schema = z.strictObject({
  version: z.literal(1),
  grantId: canonicalUuidSchema,
  revoked: z.literal(true),
});

/** @public */
export const fetchArtifactV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    artifactId: canonicalUuidSchema,
    kind: z.literal("screenshot"),
    format: z.enum(["png", "jpeg"]),
    fullPage: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(1),
    artifactId: canonicalUuidSchema,
    kind: z.enum(["trace", "recording"]),
    preset: z.literal("diagnostic-v1"),
  }),
]);

/** @public */
export const artifactMetadataV1Schema = z
  .strictObject({
    version: z.literal(1),
    artifactId: canonicalUuidSchema,
    kind: z.enum(["screenshot", "trace", "recording"]),
    contentType: z.enum(ARTIFACT_CONTENT_TYPES),
    byteSize: z.number().int().safe().min(1).max(MAX_ARTIFACT_BYTES),
    checksum: sha256Schema,
  })
  .superRefine((metadata, context) => {
    const valid = (
      ARTIFACT_CONTENT_TYPES_BY_KIND[metadata.kind] as readonly string[]
    ).includes(metadata.contentType);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "artifact media type mismatch",
      });
    }
  });

export const ARTIFACT_METADATA_HEADERS = {
  version: "x-firecrawl-artifact-version",
  artifactId: "x-firecrawl-artifact-id",
  kind: "x-firecrawl-artifact-kind",
  byteSize: "x-firecrawl-artifact-byte-size",
  checksum: "x-firecrawl-artifact-sha256",
  contentType: "content-type",
  contentLength: "content-length",
} as const;

/** @public */
export const createControlGenerationV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: tokenSchema,
  apiInstanceId: canonicalUuidSchema,
  idempotencyKey: tokenSchema,
});
/** @public */
export const controlGenerationV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: tokenSchema,
  controlGenerationNonce: tokenSchema,
  apiInstanceId: canonicalUuidSchema,
});

/** @public */
export const reconciliationReferenceV1Schema = z.strictObject({
  kind: z.enum([
    "replay_checkpoint",
    "profile_generation",
    "replay_checkpoint_cleanup_intent",
  ]),
  id: canonicalUuidSchema,
  path: relativeStatePathSchema,
  checksum: sha256Schema,
});

/** @public */
export const reconciliationRequestV1Schema = z
  .strictObject({
    version: z.literal(1),
    processNonce: tokenSchema,
    controlGenerationNonce: tokenSchema,
    snapshotDigest: sha256Schema,
    references: z
      .array(reconciliationReferenceV1Schema)
      .max(MAX_RECONCILIATION_REFERENCES),
  })
  .superRefine((request, context) => {
    const identities = new Set<string>();
    const pathChecksums = new Map<string, string>();
    for (const reference of request.references) {
      const identity = `${reference.kind}\u0000${reference.id}`;
      if (identities.has(identity)) {
        context.addIssue({ code: "custom", message: "duplicate identity" });
      }
      identities.add(identity);
      const prior = pathChecksums.get(reference.path);
      if (prior !== undefined && prior !== reference.checksum) {
        context.addIssue({ code: "custom", message: "conflicting path alias" });
      }
      pathChecksums.set(reference.path, reference.checksum);
    }
    addSizeIssue(
      request,
      MAX_REPLAY_REQUEST_BYTES,
      context,
      "snapshot exceeds 16 MiB",
    );
  });

/** @public */
export const reconciliationResultV1Schema = z.strictObject({
  version: z.literal(1),
  processNonce: tokenSchema,
  controlGenerationNonce: tokenSchema,
  snapshotDigest: sha256Schema,
  retained: z.number().int().min(0).max(MAX_RECONCILIATION_REFERENCES),
  removed: z.number().int().min(0).max(MAX_RECONCILIATION_REFERENCES),
  missing: z.literal(0),
  corrupt: z.literal(0),
  ready: z.literal(true),
});

/** @public */
export const liveDiscoveryV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["live_unreconciled", "reconciling", "ready"]),
  processNonce: tokenSchema,
});
/** @public */
export const scopedLiveHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["live_unreconciled", "reconciling", "ready"]),
  processNonce: tokenSchema,
  controlGenerationNonce: tokenSchema,
});
/** @public */
export const unreadyHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.literal("unready"),
  processNonce: tokenSchema,
  controlGenerationNonce: tokenSchema,
  category: z.enum(["reconciliation_required", "reconciliation_in_progress"]),
});
/** @public */
export const readyHealthV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.literal("ready"),
  processNonce: tokenSchema,
  controlGenerationNonce: tokenSchema,
  snapshotDigest: sha256Schema,
});

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const privateErrorV1Schema = z
  .strictObject({
    version: z.literal(1),
    category: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x20-\x7e]+$/),
    message: z
      .string()
      .refine(
        value => Array.from(value).length <= PRIVATE_ERROR_MAX_MESSAGE_CHARS,
        {
          message: "message exceeds 1,024 characters",
        },
      )
      .refine(isWellFormedText, { message: "message must be well formed" })
      .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), {
        message: "message contains control characters",
      }),
  })
  .superRefine((error, context) => {
    addSizeIssue(
      error,
      PRIVATE_ERROR_MAX_BYTES,
      context,
      "error response exceeds 4 KiB",
    );
  });

const PRIVATE_V1_CUSTOM_CONSTANTS = {
  httpUrlProtocols: HTTP_URL_PROTOCOLS,
  tokenDecodedBytes: TOKEN_DECODED_BYTES,
  relativeStatePathMaxBytes: RELATIVE_STATE_PATH_MAX_BYTES,
  jsonSafeMaxDepth: JSON_SAFE_MAX_DEPTH,
  jsonSafeMaxArrayEntries: JSON_SAFE_MAX_ARRAY_ENTRIES,
  jsonSafeMaxObjectEntries: JSON_SAFE_MAX_OBJECT_ENTRIES,
  jsonSafeMaxKeyChars: JSON_SAFE_MAX_KEY_CHARS,
  jsonSafeMaxStringBytes: JSON_SAFE_MAX_STRING_BYTES,
  operationMaxBytes: MAX_ACTION_OPERATION_BYTES,
  evaluateResultMaxBytes: MAX_EVALUATE_RESULT_BYTES,
  operationResultMaxBytes: MAX_ACTION_RESULT_BYTES,
  actionResponseMaxBytes: MAX_PRIVATE_RESPONSE_BYTES,
  storageStateMaxBytes: MAX_STORAGE_STATE_BYTES,
  headerMaxCount: HEADER_MAX_COUNT,
  headerMaxBytes: HEADER_MAX_BYTES,
  supportedLocationCountries: SUPPORTED_LOCATION_COUNTRIES,
  sessionTtlMinSeconds: SESSION_TTL_MIN_SECONDS,
  sessionTtlMaxSeconds: SESSION_TTL_MAX_SECONDS,
  sessionActivityTtlMinSeconds: SESSION_ACTIVITY_TTL_MIN_SECONDS,
  sessionActivityTtlMaxSeconds: SESSION_ACTIVITY_TTL_MAX_SECONDS,
  sessionMaxAllowedDomains: SESSION_MAX_ALLOWED_DOMAINS,
  createSessionDefaultMaxBytes: MAX_PRIVATE_REQUEST_BYTES,
  createSessionReplayMaxBytes: MAX_REPLAY_REQUEST_BYTES,
  reconciliationMaxReferences: MAX_RECONCILIATION_REFERENCES,
  reconciliationMaxBytes: MAX_REPLAY_REQUEST_BYTES,
  sessionResponseMaxBytes: MAX_PRIVATE_RESPONSE_BYTES,
  privateErrorMaxMessageChars: PRIVATE_ERROR_MAX_MESSAGE_CHARS,
  privateErrorMaxBytes: PRIVATE_ERROR_MAX_BYTES,
  artifactContentTypesByKind: ARTIFACT_CONTENT_TYPES_BY_KIND,
} as const;

const PRIVATE_V1_SEMANTIC_RULE_REGISTRY = {
  canonical_json_v1: {
    target: "canonicalJson",
    constantKeys: [],
    behaviorKeys: ["recursive_locale_sort", "array_order_and_utf8"],
  },
  canonical_uuid_v1: {
    target: "canonicalUuidSchema",
    constantKeys: [],
    behaviorKeys: ["canonical_lowercase_uuid"],
  },
  canonical_token_v1: {
    target: "tokenSchema",
    constantKeys: ["tokenDecodedBytes"],
    behaviorKeys: ["canonical_unpadded_base64url"],
  },
  http_url_v1: {
    target: "httpUrlSchema",
    constantKeys: ["httpUrlProtocols"],
    behaviorKeys: ["absolute_url", "credentials_forbidden"],
  },
  timestamp_v1: {
    target: "timestampSchema",
    constantKeys: [],
    behaviorKeys: ["canonical_utc_milliseconds"],
  },
  relative_state_path_v1: {
    target: "relativeStatePathSchema",
    constantKeys: ["relativeStatePathMaxBytes"],
    behaviorKeys: ["safe_relative_segments"],
  },
  json_safe_v1: {
    target: "jsonSafeSchema",
    constantKeys: [
      "jsonSafeMaxDepth",
      "jsonSafeMaxArrayEntries",
      "jsonSafeMaxObjectEntries",
      "jsonSafeMaxKeyChars",
      "jsonSafeMaxStringBytes",
    ],
    behaviorKeys: [
      "finite_json_primitives",
      "plain_objects_and_arrays",
      "cycles_forbidden",
      "sparse_arrays_forbidden",
      "symbol_keys_forbidden",
      "functions_forbidden",
      "accessors_forbidden",
      "non_enumerable_fields_forbidden",
      "custom_prototypes_forbidden",
      "reflection_failures_rejected",
    ],
  },
  operation_request_v1: {
    target: "browserOperationSchema",
    constantKeys: ["operationMaxBytes"],
    behaviorKeys: [],
  },
  operation_result_v1: {
    target: "actionExecutionResultSchema",
    constantKeys: [
      "evaluateResultMaxBytes",
      "operationResultMaxBytes",
      "actionResponseMaxBytes",
    ],
    behaviorKeys: [],
  },
  indexeddb_v1: {
    target: "storageStateV1Schema",
    constantKeys: [],
    behaviorKeys: [
      "record_value_encoding_exclusive",
      "record_key_encoding_exclusive",
      "index_requires_one_key_path",
      "store_key_paths_exclusive",
      "inline_records_omit_keys",
      "out_of_line_records_require_one_key",
    ],
  },
  storage_state_v1: {
    target: "storageStateV1Schema",
    constantKeys: ["storageStateMaxBytes"],
    behaviorKeys: [],
  },
  headers_v1: {
    target: "replayBrowserSettingsV1Schema",
    constantKeys: ["headerMaxCount", "headerMaxBytes"],
    behaviorKeys: ["node_header_validation"],
  },
  locale_timezone_v1: {
    target: "replayBrowserSettingsV1Schema",
    constantKeys: [],
    behaviorKeys: ["language_tags_valid", "iana_timezone_valid"],
  },
  country_v1: {
    target: "replayBrowserSettingsV1Schema",
    constantKeys: ["supportedLocationCountries"],
    behaviorKeys: ["country_case_normalization"],
  },
  replay_checkpoint_v1: {
    target: "replayCheckpointV1Schema",
    constantKeys: ["storageStateMaxBytes"],
    behaviorKeys: ["fingerprint_url_matches", "canonical_state_integrity"],
  },
  profile_input_v1: {
    target: "profileInputV1Schema",
    constantKeys: [],
    behaviorKeys: ["generation_tuple_all_or_none"],
  },
  create_session_v1: {
    target: "createSessionV1Schema",
    constantKeys: [
      "sessionTtlMinSeconds",
      "sessionTtlMaxSeconds",
      "sessionActivityTtlMinSeconds",
      "sessionActivityTtlMaxSeconds",
      "sessionMaxAllowedDomains",
      "createSessionDefaultMaxBytes",
      "createSessionReplayMaxBytes",
    ],
    behaviorKeys: [
      "activity_ttl_not_after_ttl",
      "domains_case_insensitively_unique",
      "replay_profile_generation_conflict",
    ],
  },
  session_response_v1: {
    target: "sessionV1Schema",
    constantKeys: ["sessionResponseMaxBytes"],
    behaviorKeys: [],
  },
  artifact_metadata_v1: {
    target: "artifactMetadataV1Schema",
    constantKeys: ["artifactContentTypesByKind"],
    behaviorKeys: ["content_type_matches_kind"],
  },
  reconciliation_v1: {
    target: "reconciliationRequestV1Schema",
    constantKeys: ["reconciliationMaxReferences", "reconciliationMaxBytes"],
    behaviorKeys: ["unique_reference_identity", "consistent_path_checksum"],
  },
  private_error_v1: {
    target: "privateErrorV1Schema",
    constantKeys: ["privateErrorMaxMessageChars", "privateErrorMaxBytes"],
    behaviorKeys: ["well_formed_control_free_message"],
  },
} as const;

const PRIVATE_V1_SCHEMAS = {
  ArtifactMetadataV1: artifactMetadataV1Schema,
  BrowserActionExecutionResultV1: actionExecutionResultSchema,
  BrowserActionExecutionV1: actionExecutionRequestSchema,
  CloseSessionV1: closeSessionV1Schema,
  ClosedSessionV1: closedSessionV1Schema,
  ControlGenerationV1: controlGenerationV1Schema,
  CreateControlGenerationV1: createControlGenerationV1Schema,
  CreateRelayGrantV1: createRelayGrantV1Schema,
  CreateSessionV1: createSessionV1Schema,
  DeleteProfileGenerationV1: deleteProfileGenerationV1Schema,
  DeletedProfileGenerationV1: deletedProfileGenerationV1Schema,
  FetchArtifactV1: fetchArtifactV1Schema,
  FinalizeProfileGenerationV1: finalizeProfileGenerationV1Schema,
  FinalizedProfileGenerationV1: finalizedProfileGenerationV1Schema,
  LiveDiscoveryV1: liveDiscoveryV1Schema,
  PrivateErrorV1: privateErrorV1Schema,
  ReadyHealthV1: readyHealthV1Schema,
  ReconciliationRequestV1: reconciliationRequestV1Schema,
  ReconciliationResultV1: reconciliationResultV1Schema,
  RelayGrantV1: relayGrantV1Schema,
  RevokeRelayGrantV1: revokeRelayGrantV1Schema,
  RevokedRelayGrantV1: revokedRelayGrantV1Schema,
  ScopedLiveHealthV1: scopedLiveHealthV1Schema,
  SessionV1: sessionV1Schema,
  UnreadyHealthV1: unreadyHealthV1Schema,
} as const;

const PRIVATE_V1_SCHEMA_RULE_KEYS = {
  ArtifactMetadataV1: ["canonical_uuid_v1", "artifact_metadata_v1"],
  BrowserActionExecutionResultV1: [
    "canonical_uuid_v1",
    "http_url_v1",
    "json_safe_v1",
    "operation_result_v1",
  ],
  BrowserActionExecutionV1: [
    "canonical_uuid_v1",
    "http_url_v1",
    "json_safe_v1",
    "operation_request_v1",
  ],
  CloseSessionV1: [],
  ClosedSessionV1: ["canonical_uuid_v1", "canonical_token_v1"],
  ControlGenerationV1: ["canonical_uuid_v1", "canonical_token_v1"],
  CreateControlGenerationV1: ["canonical_uuid_v1", "canonical_token_v1"],
  CreateRelayGrantV1: ["canonical_uuid_v1", "timestamp_v1"],
  CreateSessionV1: [
    "canonical_uuid_v1",
    "http_url_v1",
    "relative_state_path_v1",
    "json_safe_v1",
    "indexeddb_v1",
    "storage_state_v1",
    "headers_v1",
    "locale_timezone_v1",
    "country_v1",
    "replay_checkpoint_v1",
    "profile_input_v1",
    "create_session_v1",
  ],
  DeleteProfileGenerationV1: ["canonical_uuid_v1", "canonical_token_v1"],
  DeletedProfileGenerationV1: ["canonical_uuid_v1"],
  FetchArtifactV1: ["canonical_uuid_v1"],
  FinalizeProfileGenerationV1: ["canonical_uuid_v1", "canonical_token_v1"],
  FinalizedProfileGenerationV1: ["canonical_uuid_v1"],
  LiveDiscoveryV1: ["canonical_token_v1"],
  PrivateErrorV1: ["private_error_v1"],
  ReadyHealthV1: ["canonical_token_v1"],
  ReconciliationRequestV1: [
    "canonical_uuid_v1",
    "canonical_token_v1",
    "relative_state_path_v1",
    "reconciliation_v1",
  ],
  ReconciliationResultV1: ["canonical_token_v1"],
  RelayGrantV1: ["canonical_uuid_v1", "canonical_token_v1", "timestamp_v1"],
  RevokeRelayGrantV1: ["canonical_uuid_v1"],
  RevokedRelayGrantV1: ["canonical_uuid_v1"],
  ScopedLiveHealthV1: ["canonical_token_v1"],
  SessionV1: [
    "canonical_uuid_v1",
    "http_url_v1",
    "timestamp_v1",
    "session_response_v1",
  ],
  UnreadyHealthV1: ["canonical_token_v1"],
} as const satisfies Record<keyof typeof PRIVATE_V1_SCHEMAS, readonly string[]>;

const PRIVATE_V1_SCHEMA_REGISTRY = Object.fromEntries(
  Object.entries(PRIVATE_V1_SCHEMAS).map(([name, schema]) => [
    name,
    {
      schema,
      semanticRuleKeys:
        PRIVATE_V1_SCHEMA_RULE_KEYS[name as keyof typeof PRIVATE_V1_SCHEMAS],
    },
  ]),
) as unknown as Record<
  keyof typeof PRIVATE_V1_SCHEMAS,
  { schema: z.ZodType; semanticRuleKeys: readonly string[] }
>;

type BrowserOperation = z.infer<typeof browserOperationSchema>;
/** @public */
export type BrowserOperationResultV1 = z.infer<
  typeof browserOperationResultSchema
>;
/** @public */
export type BrowserActionExecutionV1 = z.infer<
  typeof actionExecutionRequestSchema
>;
/** @public */
export type BrowserActionExecutionResultV1 = z.infer<
  typeof actionExecutionResultSchema
>;
/** @public */
export type CreateSessionV1 = z.infer<typeof createSessionV1Schema>;
/** @public */
export type SessionV1 = z.infer<typeof sessionV1Schema>;
/** @public */
export type CloseSessionV1 = z.infer<typeof closeSessionV1Schema>;
/** @public */
export type ClosedSessionV1 = z.infer<typeof closedSessionV1Schema>;
type PreparedProfileV1 = z.infer<typeof preparedProfileV1Schema>;
/** @public */
export type StorageStateV1 = z.infer<typeof storageStateV1Schema>;
/** @public */
export type ReplayBrowserSettingsV1 = z.infer<
  typeof replayBrowserSettingsV1Schema
>;
/** @public */
export type ReplayCheckpointV1 = z.infer<typeof replayCheckpointV1Schema>;
/** @public */
export type ProfileInputV1 = z.infer<typeof profileInputV1Schema>;
/** @public */
export type FinalizeProfileGenerationV1 = z.infer<
  typeof finalizeProfileGenerationV1Schema
>;
/** @public */
export type FinalizedProfileGenerationV1 = z.infer<
  typeof finalizedProfileGenerationV1Schema
>;
/** @public */
export type DeleteProfileGenerationV1 = z.infer<
  typeof deleteProfileGenerationV1Schema
>;
/** @public */
export type DeletedProfileGenerationV1 = z.infer<
  typeof deletedProfileGenerationV1Schema
>;
/** @public */
export type CreateRelayGrantV1 = z.infer<typeof createRelayGrantV1Schema>;
/** @public */
export type RelayGrantV1 = z.infer<typeof relayGrantV1Schema>;
/** @public */
export type RevokeRelayGrantV1 = z.infer<typeof revokeRelayGrantV1Schema>;
/** @public */
export type RevokedRelayGrantV1 = z.infer<typeof revokedRelayGrantV1Schema>;
/** @public */
export type FetchArtifactV1 = z.infer<typeof fetchArtifactV1Schema>;
/** @public */
export type ArtifactMetadataV1 = z.infer<typeof artifactMetadataV1Schema>;
/** @public */
export type CreateControlGenerationV1 = z.infer<
  typeof createControlGenerationV1Schema
>;
/** @public */
export type ControlGenerationV1 = z.infer<typeof controlGenerationV1Schema>;
/** @public */
export type ReconciliationReferenceV1 = z.infer<
  typeof reconciliationReferenceV1Schema
>;
/** @public */
export type ReconciliationRequestV1 = z.infer<
  typeof reconciliationRequestV1Schema
>;
/** @public */
export type ReconciliationResultV1 = z.infer<
  typeof reconciliationResultV1Schema
>;
/** @public */
export type LiveDiscoveryV1 = z.infer<typeof liveDiscoveryV1Schema>;
/** @public */
export type ScopedLiveHealthV1 = z.infer<typeof scopedLiveHealthV1Schema>;
/** @public */
export type UnreadyHealthV1 = z.infer<typeof unreadyHealthV1Schema>;
/** @public */
export type ReadyHealthV1 = z.infer<typeof readyHealthV1Schema>;

export const PRIVATE_AUTH_HEADERS = {
  authorization: "authorization",
  correlationId: "x-firecrawl-correlation-id",
  deadline: "x-firecrawl-deadline",
} as const;
export const PRIVATE_FENCING_HEADERS = {
  processNonce: "x-firecrawl-process-nonce",
  controlGenerationNonce: "x-firecrawl-control-generation-nonce",
} as const;
export const AUTH_DEADLINE_MAX_MS = 5 * 60 * 1_000;
const AUTH_CUSTOM_CONSTANTS = {
  authBearerMaxBytes: 4_096,
  authCorrelationMinChars: 1,
  authCorrelationMaxChars: 128,
  authCorrelationPrintableAscii: "0x20..0x7e",
  authDeadlineMaxMs: AUTH_DEADLINE_MAX_MS,
  authDeadlineCanonicalUtc: true,
} as const;
const AUTH_SEMANTIC_RULE_REGISTRY = {
  private_auth_v1: {
    target: "authorizePrivateRequest",
    constantKeys: [
      "authBearerMaxBytes",
      "authCorrelationMinChars",
      "authCorrelationMaxChars",
      "authCorrelationPrintableAscii",
      "authDeadlineMaxMs",
      "authDeadlineCanonicalUtc",
    ],
    behaviorKeys: [
      "exact_bearer_secret",
      "printable_ascii_correlation_id",
      "canonical_future_deadline",
    ],
  },
} as const;
export const BROWSER_SERVICE_ERROR_STATUS = {
  browser_service_runtime_mismatch: 503,
  browser_unavailable: 503,
  unauthorized: 401,
  invalid_request: 400,
  request_too_large: 413,
  deadline_expired: 408,
  control_generation_required: 503,
  control_generation_in_progress: 409,
  control_generation_conflict: 409,
  control_generation_superseded: 409,
  control_generation_mismatch: 409,
  control_generation_drain_failed: 503,
  control_generation_history_exhausted: 503,
  reconciliation_required: 503,
  reconciliation_in_progress: 503,
  reconciliation_nonce_mismatch: 409,
  reconciliation_conflicting_replay: 409,
  reconciliation_snapshot_invalid: 400,
  reconciliation_snapshot_too_large: 413,
  reconciliation_reference_missing: 409,
  reconciliation_reference_corrupt: 409,
  reconciliation_filesystem_unsafe: 503,
  reconciliation_deadline_exceeded: 408,
  reconciliation_execution_failed: 503,
  reconciliation_cleanup_failed: 503,
} as const;
const ERROR_CUSTOM_CONSTANTS = {
  internalErrorDetailAllowlist: [
    "close_failed",
    "close_deadline_exceeded",
    "drain_invariant_failed",
  ],
  privateErrorMaxBytes: PRIVATE_ERROR_MAX_BYTES,
  privateErrorMaxMessageChars: PRIVATE_ERROR_MAX_MESSAGE_CHARS,
} as const;
const ERROR_SEMANTIC_RULE_REGISTRY = {
  internal_error_detail_v1: {
    target: "BrowserServiceError",
    constantKeys: ["internalErrorDetailAllowlist"],
    behaviorKeys: ["internal_detail_allowlist_enforced"],
  },
} as const;

type PrivateSchemaName = keyof typeof PRIVATE_V1_SCHEMAS;
type RouteResponse = { status: number; definition: PrivateSchemaName | null };
type PrivateRouteContract = {
  method: "GET" | "POST" | "DELETE" | "WS";
  path: string;
  request: PrivateSchemaName | null;
  responses: readonly RouteResponse[];
  requestBytes: number | { default: number; withReplay: number };
  responseBytes: number | null;
  fencing: "bootstrap" | "bootstrap_or_generation" | "generation";
  streaming:
    | null
    | { body: "binary"; headers: readonly string[] }
    | { permission: "passive" | "interactive" | "cdp"; transport: "websocket" };
};

export const API_PRIVATE_ROUTE_CONTRACTS = [
  {
    method: "POST",
    path: "/v1/control-generations",
    request: "CreateControlGenerationV1",
    responses: [{ status: 201, definition: "ControlGenerationV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "bootstrap",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions",
    request: "CreateSessionV1",
    responses: [{ status: 201, definition: "SessionV1" }],
    requestBytes: {
      default: MAX_PRIVATE_REQUEST_BYTES,
      withReplay: MAX_REPLAY_REQUEST_BYTES,
    },
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "GET",
    path: "/v1/sessions/:runtimeSessionId",
    request: null,
    responses: [{ status: 200, definition: "SessionV1" }],
    requestBytes: 0,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "DELETE",
    path: "/v1/sessions/:runtimeSessionId",
    request: "CloseSessionV1",
    responses: [{ status: 200, definition: "ClosedSessionV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions/:runtimeSessionId/actions",
    request: "BrowserActionExecutionV1",
    responses: [{ status: 200, definition: "BrowserActionExecutionResultV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions/:runtimeSessionId/grants",
    request: "CreateRelayGrantV1",
    responses: [{ status: 201, definition: "RelayGrantV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "DELETE",
    path: "/v1/sessions/:runtimeSessionId/grants/:grantId",
    request: "RevokeRelayGrantV1",
    responses: [{ status: 200, definition: "RevokedRelayGrantV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/sessions/:runtimeSessionId/artifacts",
    request: "FetchArtifactV1",
    responses: [{ status: 200, definition: "ArtifactMetadataV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_ARTIFACT_BYTES,
    fencing: "generation",
    streaming: {
      body: "binary",
      headers: Object.values(ARTIFACT_METADATA_HEADERS).sort((left, right) =>
        left.localeCompare(right),
      ),
    },
  },
  {
    method: "POST",
    path: "/v1/profile-generations/:generationId/finalize",
    request: "FinalizeProfileGenerationV1",
    responses: [{ status: 200, definition: "FinalizedProfileGenerationV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "DELETE",
    path: "/v1/profile-generations/:generationId",
    request: "DeleteProfileGenerationV1",
    responses: [{ status: 200, definition: "DeletedProfileGenerationV1" }],
    requestBytes: MAX_PRIVATE_REQUEST_BYTES,
    responseBytes: MAX_PRIVATE_RESPONSE_BYTES,
    fencing: "generation",
    streaming: null,
  },
  {
    method: "POST",
    path: "/v1/reconciliation",
    request: "ReconciliationRequestV1",
    responses: [{ status: 200, definition: "ReconciliationResultV1" }],
    requestBytes: MAX_REPLAY_REQUEST_BYTES,
    responseBytes: 4 * 1024,
    fencing: "generation",
    streaming: null,
  },
  ...(["passive", "interactive", "cdp"] as const).map(permission => ({
    method: "WS" as const,
    path: `/v1/sessions/:runtimeSessionId/streams/${permission}`,
    request: null,
    responses: [{ status: 101, definition: null }],
    requestBytes: 0,
    responseBytes: null,
    fencing: "generation" as const,
    streaming: { permission, transport: "websocket" as const },
  })),
  {
    method: "GET",
    path: "/health/live",
    request: null,
    responses: [
      { status: 200, definition: "LiveDiscoveryV1" },
      { status: 200, definition: "ScopedLiveHealthV1" },
    ],
    requestBytes: 0,
    responseBytes: 4 * 1024,
    fencing: "bootstrap_or_generation",
    streaming: null,
  },
  {
    method: "GET",
    path: "/health/ready",
    request: null,
    responses: [
      { status: 200, definition: "ReadyHealthV1" },
      { status: 503, definition: "UnreadyHealthV1" },
    ],
    requestBytes: 0,
    responseBytes: 4 * 1024,
    fencing: "generation",
    streaming: null,
  },
] as const satisfies readonly PrivateRouteContract[];

/** @public */
export type PrivateV1Inventory = {
  version: 1;
  routes: readonly PrivateRouteContract[];
  definitions: {
    schemas: Record<string, unknown>;
    sharedSchema: unknown;
    semanticRules: Readonly<Record<string, unknown>>;
    customConstants: Readonly<Record<string, unknown>>;
    headers: {
      auth: Readonly<Record<string, string>>;
      fencing: Readonly<Record<string, string>>;
    };
    errors: {
      envelopeSchema: "PrivateErrorV1";
      statusByCategory: Readonly<Record<string, number>>;
    };
    constants: Readonly<Record<string, unknown>>;
  };
};

function privateJsonSchemas(
  schemaOverrides: Partial<Record<PrivateSchemaName, z.ZodType>> = {},
): {
  schemas: Record<string, unknown>;
  sharedSchema: unknown;
} {
  const registry = z.registry<{ id: string }>();
  for (const [name, entry] of Object.entries(PRIVATE_V1_SCHEMA_REGISTRY)) {
    registry.add(schemaOverrides[name as PrivateSchemaName] ?? entry.schema, {
      id: name,
    });
  }
  const generated = z.toJSONSchema(registry, {
    io: "input",
    reused: "ref",
    target: "draft-2020-12",
    unrepresentable: "any",
  });
  const { __shared: sharedSchema, ...generatedSchemas } = generated.schemas;
  if (sharedSchema === undefined) {
    throw new TypeError("API schema registry did not emit shared definitions");
  }
  return {
    schemas: Object.fromEntries(
      Object.entries(generatedSchemas).map(([name, jsonSchema]) => [
        name,
        {
          jsonSchema,
          semanticRuleKeys:
            PRIVATE_V1_SCHEMA_REGISTRY[
              name as keyof typeof PRIVATE_V1_SCHEMA_REGISTRY
            ].semanticRuleKeys,
        },
      ]),
    ),
    sharedSchema,
  };
}

/** @public */
export type ApiPrivateV1InventoryOverrides = {
  schemaOverrides?: Partial<Record<PrivateSchemaName, z.ZodType>>;
  routes?: readonly PrivateRouteContract[];
  authHeaders?: Readonly<Record<string, string>>;
  fencingHeaders?: Readonly<Record<string, string>>;
  statusByCategory?: Readonly<Record<string, number>>;
  constantOverrides?: Readonly<Record<string, unknown>>;
};

/** @public */
export function buildApiPrivateV1Inventory(
  overrides: ApiPrivateV1InventoryOverrides = {},
): PrivateV1Inventory {
  const { schemas, sharedSchema } = privateJsonSchemas(
    overrides.schemaOverrides,
  );
  const inventory: PrivateV1Inventory = {
    version: 1,
    routes: overrides.routes ?? API_PRIVATE_ROUTE_CONTRACTS,
    definitions: {
      schemas,
      sharedSchema,
      semanticRules: {
        ...PRIVATE_V1_SEMANTIC_RULE_REGISTRY,
        ...AUTH_SEMANTIC_RULE_REGISTRY,
        ...ERROR_SEMANTIC_RULE_REGISTRY,
      },
      customConstants: {
        ...PRIVATE_V1_CUSTOM_CONSTANTS,
        ...AUTH_CUSTOM_CONSTANTS,
        ...ERROR_CUSTOM_CONSTANTS,
      },
      headers: {
        auth: overrides.authHeaders ?? PRIVATE_AUTH_HEADERS,
        fencing: overrides.fencingHeaders ?? PRIVATE_FENCING_HEADERS,
      },
      errors: {
        envelopeSchema: "PrivateErrorV1",
        statusByCategory:
          overrides.statusByCategory ?? BROWSER_SERVICE_ERROR_STATUS,
      },
      constants: {
        artifactMetadataHeaders: ARTIFACT_METADATA_HEADERS,
        maxActionOperationBytes: MAX_ACTION_OPERATION_BYTES,
        maxActionResultBytes: MAX_ACTION_RESULT_BYTES,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
        maxEvaluateResultBytes: MAX_EVALUATE_RESULT_BYTES,
        maxPrivateRequestBytes: MAX_PRIVATE_REQUEST_BYTES,
        maxPrivateResponseBytes: MAX_PRIVATE_RESPONSE_BYTES,
        maxReconciliationReferences: MAX_RECONCILIATION_REFERENCES,
        maxReplayRequestBytes: MAX_REPLAY_REQUEST_BYTES,
        maxRunArtifactBytes: MAX_RUN_ARTIFACT_BYTES,
        maxRunArtifacts: MAX_RUN_ARTIFACTS,
        maxStorageStateBytes: MAX_STORAGE_STATE_BYTES,
        supportedLocationCountries: SUPPORTED_LOCATION_COUNTRIES,
        ...overrides.constantOverrides,
      },
    },
  };
  return JSON.parse(canonicalJson(inventory)) as PrivateV1Inventory;
}

/** @public */
export const apiPrivateV1Inventory = buildApiPrivateV1Inventory();
/** @public */
export const apiPrivateV1Fingerprint = createHash("sha256")
  .update(canonicalJson(apiPrivateV1Inventory))
  .digest("hex");
