import { describe, expect, test, vi } from "vitest";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  actionExecutionRequestSchema,
  actionExecutionResultSchema,
  artifactMetadataV1Schema,
  browserOperationSchema,
  browserOperationResultSchema,
  canonicalJson,
  canonicalUuidSchema,
  createControlGenerationV1Schema,
  createSessionV1Schema,
  encodedBytes,
  httpUrlSchema,
  profileInputV1Schema,
  jsonSafeSchema,
  PRIVATE_V1_CUSTOM_CONSTANTS,
  PRIVATE_V1_SCHEMAS,
  PRIVATE_V1_SCHEMA_REGISTRY,
  PRIVATE_V1_SEMANTIC_RULE_REGISTRY,
  replayBrowserSettingsV1Schema,
  privateErrorV1Schema,
  liveDiscoveryV1Schema,
  readyHealthV1Schema,
  replayCheckpointV1Schema,
  reconciliationRequestV1Schema,
  relativeStatePathSchema,
  scopedLiveHealthV1Schema,
  sessionV1Schema,
  storageStateV1Schema,
  SUPPORTED_LOCATION_COUNTRIES,
  timestampSchema,
  tokenSchema,
} from "./contracts.js";
import {
  buildServicePrivateV1Inventory,
  fingerprintPrivateV1Inventory,
  normalizePrivateV1Inventory,
  readCanonicalPrivateV1Fixture,
  servicePrivateV1Inventory,
  sha256,
  validateSemanticRuleCoverage,
} from "./contract-inventory.js";
import {
  AUTH_CUSTOM_CONSTANTS,
  AUTH_SEMANTIC_RULE_REGISTRY,
  authorizePrivateRequest,
  PRIVATE_AUTH_HEADERS,
  PRIVATE_FENCING_HEADERS,
} from "./auth.js";
import {
  BROWSER_SERVICE_ERROR_STATUS,
  BrowserServiceError,
  ERROR_CUSTOM_CONSTANTS,
  ERROR_SEMANTIC_RULE_REGISTRY,
} from "./errors.js";

const VALID_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const VALID_RUN_ID = "22222222-2222-4222-8222-222222222222";
const VALID_NONCE = Buffer.alloc(32, 1).toString("base64url");
const VALID_CONTROL_GENERATION_NONCE = Buffer.alloc(32, 2).toString(
  "base64url",
);

function validAction(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    actionId: VALID_ID,
    runId: VALID_RUN_ID,
    sequence: 1,
    normalizedProposalHash: "a".repeat(64),
    effect: "side_effecting",
    expectedSessionVersion: 0,
    allowedDomains: ["example.test"],
    operation: { kind: "click", ref: "e1" },
    ...overrides,
  };
}

function validSettings(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    cookies: [],
    viewport: {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
    userAgent: "test",
    locale: "en-US",
    location: { country: "us", languages: ["en-US"] },
    proxy: { kind: "auto" },
    skipTlsVerification: false,
    blockAds: false,
    lockdown: true,
    ...overrides,
  };
}

function validSessionRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sessionId: VALID_ID,
    initialUrl: "https://example.test/",
    allowedDomains: ["example.test"],
    ttlSeconds: 30,
    activityTtlSeconds: 10,
    profile: null,
    replay: null,
    settings: validSettings(),
    ...overrides,
  };
}

function findEncodedBoundary<T>(
  maximumCount: number,
  byteCap: number,
  build: (count: number) => T,
): { within: T; overflow: T; withinBytes: number; overflowBytes: number } {
  if (encodedBytes(build(maximumCount)) <= byteCap) {
    throw new TypeError("encoded boundary upper bound does not overflow");
  }
  let lower = 0;
  let upper = maximumCount;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (encodedBytes(build(middle)) <= byteCap) lower = middle;
    else upper = middle;
  }
  const within = build(lower);
  const overflow = build(upper);
  return {
    within,
    overflow,
    withinBytes: encodedBytes(within),
    overflowBytes: encodedBytes(overflow),
  };
}

function payloadCookies(characterCount: number) {
  const cookies = [];
  let remaining = characterCount;
  let index = 0;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 32_768);
    cookies.push({
      name: `payload-${index}`,
      value: "💥".repeat(chunk),
      domain: "example.test",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax" as const,
    });
    remaining -= chunk;
    index += 1;
  }
  return cookies;
}

function storageStateWithPayload(characterCount: number) {
  const localStorage = [];
  let remaining = characterCount;
  let index = 0;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 32_768);
    localStorage.push({
      name: `payload-${index}`,
      value: "💥".repeat(chunk),
    });
    remaining -= chunk;
    index += 1;
  }
  return {
    cookies: [],
    origins: [{ origin: "https://example.test/", localStorage }],
  };
}

let cachedStorageStateBoundary:
  | ReturnType<
      typeof findEncodedBoundary<ReturnType<typeof storageStateWithPayload>>
    >
  | undefined;

function storageStateBoundary() {
  cachedStorageStateBoundary ??= findEncodedBoundary(
    600_000,
    PRIVATE_V1_CUSTOM_CONSTANTS.storageStateMaxBytes,
    storageStateWithPayload,
  );
  return cachedStorageStateBoundary;
}

function checkpointForStorageState(
  storageState: ReturnType<typeof storageStateWithPayload>,
) {
  const bytes = Buffer.from(canonicalJson(storageState));
  return {
    checkpointId: VALID_RUN_ID,
    statePath: "replay/a.json",
    checksum: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    storageState,
    finalUrl: "https://example.test/",
    fingerprint: {
      finalUrl: "https://example.test/",
      titleSha256: "a".repeat(64),
      bodyTextSha256: "b".repeat(64),
    },
  };
}

const semanticRuleImplementations: Record<string, () => void> = {
  canonical_json_v1: () => {
    const value = { z: 1, A: { b: 2, B: 3 }, a: [2, 1] };
    const reference = (input: unknown): string =>
      Array.isArray(input)
        ? `[${input.map(reference).join(",")}]`
        : input !== null && typeof input === "object"
          ? `{${Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => `${JSON.stringify(key)}:${reference(item)}`)
              .join(",")}}`
          : (JSON.stringify(input) as string);
    expect(canonicalJson(value)).toBe(reference(value));
    expect(canonicalJson(["é", "a"])).toBe('["é","a"]');
  },
  canonical_uuid_v1: () => {
    expect(canonicalUuidSchema.safeParse(VALID_ID).success).toBe(true);
    expect(canonicalUuidSchema.safeParse(VALID_ID.toUpperCase()).success).toBe(
      false,
    );
  },
  canonical_token_v1: () => {
    expect(tokenSchema.safeParse(VALID_NONCE).success).toBe(true);
    expect(tokenSchema.safeParse("B".repeat(43)).success).toBe(false);
    expect(
      tokenSchema.safeParse(
        Buffer.alloc(
          PRIVATE_V1_CUSTOM_CONSTANTS.tokenDecodedBytes - 1,
        ).toString("base64url"),
      ).success,
    ).toBe(false);
    expect(
      tokenSchema.safeParse(
        Buffer.alloc(
          PRIVATE_V1_CUSTOM_CONSTANTS.tokenDecodedBytes + 1,
        ).toString("base64url"),
      ).success,
    ).toBe(false);
  },
  http_url_v1: () => {
    for (const protocol of PRIVATE_V1_CUSTOM_CONSTANTS.httpUrlProtocols) {
      expect(
        httpUrlSchema.safeParse(`${protocol}//example.test/`).success,
      ).toBe(true);
    }
    for (const value of ["file:///x", "/x", "https://u:p@example.test/"]) {
      expect(httpUrlSchema.safeParse(value).success).toBe(false);
    }
  },
  timestamp_v1: () => {
    expect(timestampSchema.safeParse("2026-07-21T00:00:00.000Z").success).toBe(
      true,
    );
    expect(timestampSchema.safeParse("2026-07-21T00:00:00Z").success).toBe(
      false,
    );
  },
  relative_state_path_v1: () => {
    const maximum = PRIVATE_V1_CUSTOM_CONSTANTS.relativeStatePathMaxBytes;
    expect(relativeStatePathSchema.safeParse("replay/a.json").success).toBe(
      true,
    );
    expect(relativeStatePathSchema.safeParse("a".repeat(maximum)).success).toBe(
      true,
    );
    expect(
      relativeStatePathSchema.safeParse("a".repeat(maximum + 1)).success,
    ).toBe(false);
    expect(
      relativeStatePathSchema.safeParse("é".repeat(maximum / 2)).success,
    ).toBe(true);
    expect(
      relativeStatePathSchema.safeParse(`${"é".repeat(maximum / 2)}a`).success,
    ).toBe(false);
    for (const value of ["/a", "a/../b", "a\\b", "a//b"]) {
      expect(relativeStatePathSchema.safeParse(value).success).toBe(false);
    }
  },
  json_safe_v1: () => {
    const c = PRIVATE_V1_CUSTOM_CONSTANTS;
    for (const value of [null, true, 0, "", [], {}]) {
      expect(jsonSafeSchema.safeParse(value).success).toBe(true);
    }
    expect(
      jsonSafeSchema.safeParse(Array(c.jsonSafeMaxArrayEntries).fill(0))
        .success,
    ).toBe(true);
    expect(
      jsonSafeSchema.safeParse(Array(c.jsonSafeMaxArrayEntries + 1).fill(0))
        .success,
    ).toBe(false);
    expect(
      jsonSafeSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: c.jsonSafeMaxObjectEntries }, (_, i) => [
            String(i),
            0,
          ]),
        ),
      ).success,
    ).toBe(true);
    expect(
      jsonSafeSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: c.jsonSafeMaxObjectEntries + 1 }, (_, i) => [
            String(i),
            0,
          ]),
        ),
      ).success,
    ).toBe(false);
    expect(
      jsonSafeSchema.safeParse({ ["k".repeat(c.jsonSafeMaxKeyChars)]: 0 })
        .success,
    ).toBe(true);
    expect(
      jsonSafeSchema.safeParse({ ["k".repeat(c.jsonSafeMaxKeyChars + 1)]: 0 })
        .success,
    ).toBe(false);
    expect(
      jsonSafeSchema.safeParse("é".repeat(c.jsonSafeMaxStringBytes / 2))
        .success,
    ).toBe(true);
    expect(
      jsonSafeSchema.safeParse("é".repeat(c.jsonSafeMaxStringBytes / 2 + 1))
        .success,
    ).toBe(false);
    let depth: unknown = 0;
    for (let i = 0; i < c.jsonSafeMaxDepth; i += 1) depth = [depth];
    expect(jsonSafeSchema.safeParse(depth).success).toBe(true);
    depth = [depth];
    expect(jsonSafeSchema.safeParse(depth).success).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array(1);
    const customArray = [0];
    Object.setPrototypeOf(customArray, {});
    const symbolKey = { x: 1, [Symbol("x")]: 2 };
    const accessor = {};
    Object.defineProperty(accessor, "x", { enumerable: true, get: () => 1 });
    const hidden = {};
    Object.defineProperty(hidden, "x", { value: 0, enumerable: false });
    for (const value of [
      cyclic,
      sparse,
      customArray,
      symbolKey,
      () => undefined,
      accessor,
      hidden,
      Object.create({ x: 1 }),
      NaN,
      Infinity,
    ])
      expect(jsonSafeSchema.safeParse(value).success).toBe(false);
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("no");
        },
      },
    );
    expect(() => jsonSafeSchema.safeParse(proxy)).not.toThrow();
    expect(jsonSafeSchema.safeParse(proxy).success).toBe(false);
  },
  operation_request_v1: () => {
    const cap = PRIVATE_V1_CUSTOM_CONSTANTS.operationMaxBytes;
    const boundary = findEncodedBoundary(20_000, cap, (count) => ({
      kind: "evaluate" as const,
      expression: "",
      args: { x: "💥".repeat(count) },
    }));
    expect(boundary.withinBytes).toBeLessThanOrEqual(cap);
    expect(boundary.overflowBytes).toBeGreaterThan(cap);
    expect(browserOperationSchema.safeParse(boundary.within).success).toBe(
      true,
    );
    expect(browserOperationSchema.safeParse(boundary.overflow).success).toBe(
      false,
    );
    expect(
      browserOperationSchema.safeParse({
        kind: "evaluate",
        expression: "x".repeat(20_000),
        args: { x: "界".repeat(20_000) },
      }).success,
    ).toBe(false);
  },
  operation_result_v1: () => {
    const c = PRIVATE_V1_CUSTOM_CONSTANTS;
    const evaluateAtCap = "x".repeat(c.evaluateResultMaxBytes - 2);
    const evaluateOverflow = "x".repeat(c.evaluateResultMaxBytes - 1);
    const base = {
      version: 1,
      actionId: VALID_ID,
      sequence: 1,
      normalizedProposalHash: "a".repeat(64),
      outcome: "succeeded",
      page: { url: "https://example.test/", title: "", snapshotExcerpt: "" },
      sessionVersion: 0,
    };
    expect(
      actionExecutionResultSchema.safeParse({
        ...base,
        result: {
          kind: "evaluate",
          value: evaluateAtCap,
        },
      }).success,
    ).toBe(true);
    expect(
      actionExecutionResultSchema.safeParse({
        ...base,
        result: {
          kind: "evaluate",
          value: evaluateOverflow,
        },
      }).success,
    ).toBe(false);
    expect(encodedBytes(evaluateAtCap)).toBe(c.evaluateResultMaxBytes);
    expect(encodedBytes(evaluateOverflow)).toBe(c.evaluateResultMaxBytes + 1);

    const operationBoundary = findEncodedBoundary(
      40_000,
      c.operationResultMaxBytes,
      (count) => ({ kind: "get_text" as const, text: "💥".repeat(count) }),
    );
    expect(operationBoundary.withinBytes).toBeLessThanOrEqual(
      c.operationResultMaxBytes,
    );
    expect(operationBoundary.overflowBytes).toBeGreaterThan(
      c.operationResultMaxBytes,
    );
    expect(
      browserOperationResultSchema.safeParse(operationBoundary.within).success,
    ).toBe(true);
    expect(
      browserOperationResultSchema.safeParse(operationBoundary.overflow)
        .success,
    ).toBe(false);

    const actionBoundary = findEncodedBoundary(
      40_000,
      c.actionResponseMaxBytes,
      (count) => ({
        ...base,
        result: { kind: "get_url" as const, url: "https://example.test/" },
        page: {
          ...base.page,
          title: "界".repeat(4_096),
          snapshotExcerpt: "界".repeat(count),
        },
      }),
    );
    expect(actionBoundary.withinBytes).toBeLessThanOrEqual(
      c.actionResponseMaxBytes,
    );
    expect(actionBoundary.overflowBytes).toBeGreaterThan(
      c.actionResponseMaxBytes,
    );
    expect(
      actionExecutionResultSchema.safeParse(actionBoundary.within).success,
    ).toBe(true);
    expect(
      actionExecutionResultSchema.safeParse(actionBoundary.overflow).success,
    ).toBe(false);
  },
  indexeddb_v1: () => {
    const state = (store: Record<string, unknown>) => ({
      cookies: [],
      origins: [
        {
          origin: "https://example.test",
          localStorage: [],
          indexedDB: [
            {
              name: "db",
              version: 1,
              stores: [
                {
                  name: "s",
                  autoIncrement: false,
                  indexes: [
                    {
                      name: "i",
                      keyPath: "",
                      multiEntry: false,
                      unique: false,
                    },
                  ],
                  ...store,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      storageStateV1Schema.safeParse(
        state({ records: [{ key: 1, value: 1 }] }),
      ),
    ).toMatchObject({ success: true });
    expect(
      storageStateV1Schema.safeParse(
        state({ keyPath: "", records: [{ valueEncoded: 1 }] }),
      ),
    ).toMatchObject({ success: true });
    for (const store of [
      { records: [{ value: 1 }] },
      { records: [{ key: 1 }] },
      { keyPath: "", records: [{ key: 1, value: 1 }] },
      { records: [{ key: 1, keyEncoded: 1, value: 1 }] },
      { records: [{ key: 1, value: 1, valueEncoded: 1 }] },
      {
        records: [{ key: 1, value: 1 }],
        indexes: [{ name: "i", multiEntry: false, unique: false }],
      },
      {
        records: [{ key: 1, value: 1 }],
        indexes: [
          {
            name: "i",
            keyPath: "",
            keyPathArray: [],
            multiEntry: false,
            unique: false,
          },
        ],
      },
      {
        keyPath: "",
        keyPathArray: [],
        records: [{ value: 1 }],
      },
    ]) {
      expect(storageStateV1Schema.safeParse(state(store)).success).toBe(false);
    }
  },
  storage_state_v1: () => {
    const cap = PRIVATE_V1_CUSTOM_CONSTANTS.storageStateMaxBytes;
    const boundary = storageStateBoundary();
    expect(boundary.withinBytes).toBeLessThanOrEqual(cap);
    expect(boundary.overflowBytes).toBeGreaterThan(cap);
    expect(storageStateV1Schema.safeParse(boundary.within).success).toBe(true);
    expect(storageStateV1Schema.safeParse(boundary.overflow).success).toBe(
      false,
    );
  },
  headers_v1: () => {
    const c = PRIVATE_V1_CUSTOM_CONSTANTS;
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({
          headers: Object.fromEntries(
            Array.from({ length: c.headerMaxCount }, (_, i) => [`x-${i}`, "v"]),
          ),
        }),
      ).success,
    ).toBe(true);
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({
          headers: Object.fromEntries(
            Array.from({ length: c.headerMaxCount + 1 }, (_, i) => [
              `x-${i}`,
              "v",
            ]),
          ),
        }),
      ).success,
    ).toBe(false);
    const baseBytes = encodedBytes({ x: "" });
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({
          headers: { x: "a".repeat(c.headerMaxBytes - baseBytes) },
        }),
      ).success,
    ).toBe(true);
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({
          headers: { x: "a".repeat(c.headerMaxBytes - baseBytes + 1) },
        }),
      ).success,
    ).toBe(false);
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({ headers: { "x-💥": "v" } }),
      ).success,
    ).toBe(false);
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({ headers: { x: "bad\n" } }),
      ).success,
    ).toBe(false);
  },
  locale_timezone_v1: () => {
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({ locale: "en-US", timezoneId: "America/Los_Angeles" }),
      ).success,
    ).toBe(true);
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({ locale: "bad_locale" }),
      ).success,
    ).toBe(false);
    expect(
      replayBrowserSettingsV1Schema.safeParse(
        validSettings({ timezoneId: "Mars/Olympus" }),
      ).success,
    ).toBe(false);
  },
  country_v1: () => {
    for (const country of PRIVATE_V1_CUSTOM_CONSTANTS.supportedLocationCountries) {
      expect(
        replayBrowserSettingsV1Schema.parse(
          validSettings({
            location: { country: country.toUpperCase(), languages: ["en"] },
          }),
        ).location.country,
      ).toBe(country);
    }
    for (const country of ["zz", "canada", "MARS"])
      expect(
        replayBrowserSettingsV1Schema.safeParse(
          validSettings({ location: { country, languages: ["en"] } }),
        ).success,
      ).toBe(false);
  },
  replay_checkpoint_v1: () => {
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState));
    const checkpoint = {
      checkpointId: VALID_RUN_ID,
      statePath: "replay/a.json",
      checksum: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      storageState,
      finalUrl: "https://example.test/",
      fingerprint: {
        finalUrl: "https://example.test/",
        titleSha256: "a".repeat(64),
        bodyTextSha256: "b".repeat(64),
      },
    };
    expect(replayCheckpointV1Schema.safeParse(checkpoint).success).toBe(true);
    expect(
      replayCheckpointV1Schema.safeParse({
        ...checkpoint,
        byteSize: bytes.length + 1,
      }).success,
    ).toBe(false);
    expect(
      replayCheckpointV1Schema.safeParse({
        ...checkpoint,
        checksum: "f".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      replayCheckpointV1Schema.safeParse({
        ...checkpoint,
        fingerprint: {
          ...checkpoint.fingerprint,
          finalUrl: "https://other.test/",
        },
      }).success,
    ).toBe(false);
    const storageBoundary = storageStateBoundary();
    expect(storageBoundary.withinBytes).toBeLessThanOrEqual(
      PRIVATE_V1_CUSTOM_CONSTANTS.storageStateMaxBytes,
    );
    expect(storageBoundary.overflowBytes).toBeGreaterThan(
      PRIVATE_V1_CUSTOM_CONSTANTS.storageStateMaxBytes,
    );
    expect(
      replayCheckpointV1Schema.safeParse(
        checkpointForStorageState(storageBoundary.within),
      ).success,
    ).toBe(true);
    expect(
      replayCheckpointV1Schema.safeParse(
        checkpointForStorageState(storageBoundary.overflow),
      ).success,
    ).toBe(false);
  },
  profile_input_v1: () => {
    const populated = {
      profileId: VALID_ID,
      mode: "writer",
      generationId: VALID_RUN_ID,
      statePath: "profiles/a",
      checksum: "a".repeat(64),
    };
    expect(profileInputV1Schema.safeParse(populated).success).toBe(true);
    expect(
      profileInputV1Schema.safeParse({
        ...populated,
        generationId: null,
        statePath: null,
        checksum: null,
      }).success,
    ).toBe(true);
    expect(
      profileInputV1Schema.safeParse({ ...populated, statePath: null }).success,
    ).toBe(false);
  },
  create_session_v1: () => {
    const c = PRIVATE_V1_CUSTOM_CONSTANTS;
    expect(
      createSessionV1Schema.safeParse(
        validSessionRequest({
          ttlSeconds: c.sessionTtlMinSeconds,
          activityTtlSeconds: c.sessionActivityTtlMinSeconds,
          allowedDomains: Array.from(
            { length: c.sessionMaxAllowedDomains },
            (_, i) => `d${i}.test`,
          ),
        }),
      ).success,
    ).toBe(true);
    expect(
      createSessionV1Schema.safeParse(
        validSessionRequest({
          ttlSeconds: c.sessionTtlMaxSeconds,
          activityTtlSeconds: c.sessionActivityTtlMaxSeconds,
        }),
      ).success,
    ).toBe(true);
    for (const patch of [
      { ttlSeconds: c.sessionTtlMinSeconds - 1 },
      { ttlSeconds: c.sessionTtlMaxSeconds + 1 },
      { activityTtlSeconds: c.sessionActivityTtlMinSeconds - 1 },
      { activityTtlSeconds: c.sessionActivityTtlMaxSeconds + 1 },
      { ttlSeconds: 30, activityTtlSeconds: 31 },
      { allowedDomains: ["a.test", "A.TEST"] },
      {
        allowedDomains: Array.from(
          { length: c.sessionMaxAllowedDomains + 1 },
          (_, i) => `d${i}.test`,
        ),
      },
    ])
      expect(
        createSessionV1Schema.safeParse(validSessionRequest(patch)).success,
      ).toBe(false);
    const storageState = { cookies: [], origins: [] };
    const bytes = Buffer.from(canonicalJson(storageState));
    const replay = {
      checkpointId: VALID_RUN_ID,
      statePath: "replay/a",
      checksum: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      storageState,
      finalUrl: "https://example.test/",
      fingerprint: {
        finalUrl: "https://example.test/",
        titleSha256: "a".repeat(64),
        bodyTextSha256: "b".repeat(64),
      },
    };
    const profile = {
      profileId: VALID_ID,
      mode: "writer",
      generationId: VALID_RUN_ID,
      statePath: "profiles/a",
      checksum: "a".repeat(64),
    };
    expect(
      createSessionV1Schema.safeParse(validSessionRequest({ replay, profile }))
        .success,
    ).toBe(false);

    const defaultBoundary = findEncodedBoundary(
      Math.ceil(c.createSessionDefaultMaxBytes / 4) + 32_768,
      c.createSessionDefaultMaxBytes,
      (count) =>
        validSessionRequest({
          settings: validSettings({ cookies: payloadCookies(count) }),
        }),
    );
    expect(defaultBoundary.withinBytes).toBeLessThanOrEqual(
      c.createSessionDefaultMaxBytes,
    );
    expect(defaultBoundary.overflowBytes).toBeGreaterThan(
      c.createSessionDefaultMaxBytes,
    );
    expect(
      createSessionV1Schema.safeParse(defaultBoundary.within).success,
    ).toBe(true);
    expect(
      createSessionV1Schema.safeParse(defaultBoundary.overflow).success,
    ).toBe(false);

    const replayBoundary = findEncodedBoundary(
      Math.ceil(c.createSessionReplayMaxBytes / 4) + 32_768,
      c.createSessionReplayMaxBytes,
      (count) =>
        validSessionRequest({
          replay,
          settings: validSettings({ cookies: payloadCookies(count) }),
        }),
    );
    expect(replayBoundary.withinBytes).toBeLessThanOrEqual(
      c.createSessionReplayMaxBytes,
    );
    expect(replayBoundary.overflowBytes).toBeGreaterThan(
      c.createSessionReplayMaxBytes,
    );
    expect(createSessionV1Schema.safeParse(replayBoundary.within).success).toBe(
      true,
    );
    expect(
      createSessionV1Schema.safeParse(replayBoundary.overflow).success,
    ).toBe(false);
  },
  session_response_v1: () => {
    const cap = PRIVATE_V1_CUSTOM_CONSTANTS.sessionResponseMaxBytes;
    const boundary = findEncodedBoundary(40_000, cap, (count) => ({
      version: 1 as const,
      runtimeSessionId: VALID_ID,
      state: "ready" as const,
      sessionVersion: 0,
      page: {
        url: "https://example.test/",
        title: "界".repeat(4_096),
        snapshotExcerpt: "界".repeat(count),
      },
      expiresAt: "2026-07-21T01:00:00.000Z",
      idleExpiresAt: "2026-07-21T00:10:00.000Z",
    }));
    expect(boundary.withinBytes).toBeLessThanOrEqual(cap);
    expect(boundary.overflowBytes).toBeGreaterThan(cap);
    expect(sessionV1Schema.safeParse(boundary.within).success).toBe(true);
    expect(sessionV1Schema.safeParse(boundary.overflow).success).toBe(false);
  },
  artifact_metadata_v1: () => {
    const base = {
      version: 1,
      artifactId: VALID_ID,
      byteSize: 1,
      checksum: "a".repeat(64),
    };
    for (const [kind, contentTypes] of Object.entries(
      PRIVATE_V1_CUSTOM_CONSTANTS.artifactContentTypesByKind,
    )) {
      for (const contentType of contentTypes) {
        expect(
          artifactMetadataV1Schema.safeParse({ ...base, kind, contentType })
            .success,
        ).toBe(true);
      }
    }
    expect(
      artifactMetadataV1Schema.safeParse({
        ...base,
        kind: "recording",
        contentType: "image/png",
      }).success,
    ).toBe(false);
  },
  reconciliation_v1: () => {
    const c = PRIVATE_V1_CUSTOM_CONSTANTS;
    const ref = {
      kind: "replay_checkpoint",
      id: VALID_ID,
      path: "replay/a",
      checksum: "a".repeat(64),
    };
    const base = {
      version: 1,
      processNonce: VALID_NONCE,
      controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
      snapshotDigest: "b".repeat(64),
    };
    expect(
      reconciliationRequestV1Schema.safeParse({ ...base, references: [ref] })
        .success,
    ).toBe(true);
    expect(
      reconciliationRequestV1Schema.safeParse({
        ...base,
        references: [ref, ref],
      }).success,
    ).toBe(false);
    expect(
      reconciliationRequestV1Schema.safeParse({
        ...base,
        references: [
          ref,
          {
            ...ref,
            kind: "profile_generation",
            id: VALID_RUN_ID,
            checksum: "c".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    const references = (count: number, totalPathPayload = 0) => {
      const perReference = Math.floor(totalPathPayload / count);
      const remainder = totalPathPayload % count;
      return Array.from({ length: count }, (_, i) => ({
        ...ref,
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        path: `replay/${String(i).padStart(6, "0")}-${"x".repeat(
          perReference + Number(i < remainder),
        )}`,
      }));
    };
    expect(
      reconciliationRequestV1Schema.safeParse({
        ...base,
        references: references(c.reconciliationMaxReferences),
      }).success,
    ).toBe(true);
    expect(
      reconciliationRequestV1Schema.safeParse({
        ...base,
        references: references(c.reconciliationMaxReferences + 1),
      }).success,
    ).toBe(false);

    const byteBoundaryReferenceCount = 20_000;
    const byteBoundary = findEncodedBoundary(
      byteBoundaryReferenceCount * 900,
      c.reconciliationMaxBytes,
      (totalPathPayload) => ({
        ...base,
        references: references(byteBoundaryReferenceCount, totalPathPayload),
      }),
    );
    expect(byteBoundary.withinBytes).toBeLessThanOrEqual(
      c.reconciliationMaxBytes,
    );
    expect(byteBoundary.overflowBytes).toBeGreaterThan(
      c.reconciliationMaxBytes,
    );
    expect(
      reconciliationRequestV1Schema.safeParse(byteBoundary.within).success,
    ).toBe(true);
    expect(
      reconciliationRequestV1Schema.safeParse(byteBoundary.overflow).success,
    ).toBe(false);
  },
  private_error_v1: () => {
    const c = PRIVATE_V1_CUSTOM_CONSTANTS;
    expect(
      privateErrorV1Schema.safeParse({
        version: 1,
        category: "x",
        message: "x".repeat(c.privateErrorMaxMessageChars),
      }).success,
    ).toBe(true);
    for (const message of [
      "x".repeat(c.privateErrorMaxMessageChars + 1),
      "💥".repeat(c.privateErrorMaxMessageChars),
      "bad\u0000",
      "bad\ud800",
    ])
      expect(
        privateErrorV1Schema.safeParse({ version: 1, category: "x", message })
          .success,
      ).toBe(false);
    const byteBoundary = findEncodedBoundary(
      c.privateErrorMaxMessageChars,
      c.privateErrorMaxBytes,
      (count) => ({
        version: 1 as const,
        category: "x",
        message: "💥".repeat(count),
      }),
    );
    expect(byteBoundary.withinBytes).toBeLessThanOrEqual(
      c.privateErrorMaxBytes,
    );
    expect(byteBoundary.overflowBytes).toBeGreaterThan(c.privateErrorMaxBytes);
    expect(privateErrorV1Schema.safeParse(byteBoundary.within).success).toBe(
      true,
    );
    expect(privateErrorV1Schema.safeParse(byteBoundary.overflow).success).toBe(
      false,
    );
  },
  private_auth_v1: () => {
    const now = new Date("2026-07-21T00:00:00.000Z");
    vi.setSystemTime(now);
    const call = (
      authorization: string,
      correlationId: string,
      deadline: string,
    ) =>
      authorizePrivateRequest(
        { authorization, correlationId, deadline },
        authorization.slice(7),
      );
    const maximumDeadline = new Date(
      now.getTime() + AUTH_CUSTOM_CONSTANTS.authDeadlineMaxMs,
    ).toISOString();
    const asciiKey = "a".repeat(AUTH_CUSTOM_CONSTANTS.authBearerMaxBytes - 7);
    expect(() =>
      call(`Bearer ${asciiKey}`, "x", maximumDeadline),
    ).not.toThrow();
    expect(() =>
      call(`Bearer ${asciiKey}a`, "x", "2026-07-21T00:05:00.000Z"),
    ).toThrow();
    expect(() =>
      authorizePrivateRequest(
        {
          authorization: "Bearer key",
          correlationId: "x",
          deadline: "2026-07-21T00:05:00.000Z",
        },
        "different",
      ),
    ).toThrow();
    for (const id of [
      " ".repeat(AUTH_CUSTOM_CONSTANTS.authCorrelationMinChars),
      "~".repeat(AUTH_CUSTOM_CONSTANTS.authCorrelationMaxChars),
    ])
      expect(() =>
        call("Bearer key", id, "2026-07-21T00:05:00.000Z"),
      ).not.toThrow();
    for (const id of [
      "".repeat(AUTH_CUSTOM_CONSTANTS.authCorrelationMinChars - 1),
      "x".repeat(AUTH_CUSTOM_CONSTANTS.authCorrelationMaxChars + 1),
      "\x1f",
      "\x7f",
    ])
      expect(() =>
        call("Bearer key", id, "2026-07-21T00:05:00.000Z"),
      ).toThrow();
    for (const deadline of [
      "2026-07-21T00:00:00.000Z",
      new Date(
        now.getTime() + AUTH_CUSTOM_CONSTANTS.authDeadlineMaxMs + 1,
      ).toISOString(),
      "2026-07-21T00:05:00Z",
    ])
      expect(() => call("Bearer key", "x", deadline)).toThrow();
    vi.useRealTimers();
  },
  internal_error_detail_v1: () => {
    for (const detail of ERROR_CUSTOM_CONSTANTS.internalErrorDetailAllowlist)
      expect(
        () =>
          new BrowserServiceError("reconciliation_cleanup_failed", "safe", {
            detail,
          }),
      ).not.toThrow();
    for (const detail of ["outside", "bad\n"])
      expect(
        () =>
          new BrowserServiceError("reconciliation_cleanup_failed", "safe", {
            detail: detail as never,
          }),
      ).toThrow();
  },
};

const semanticRuleCaseCoverage: Record<
  string,
  {
    coveredConstantKeys: readonly string[];
    coveredBehaviorKeys: readonly string[];
  }
> = {
  canonical_json_v1: {
    coveredConstantKeys: [],
    coveredBehaviorKeys: ["recursive_locale_sort", "array_order_and_utf8"],
  },
  canonical_uuid_v1: {
    coveredConstantKeys: [],
    coveredBehaviorKeys: ["canonical_lowercase_uuid"],
  },
  canonical_token_v1: {
    coveredConstantKeys: ["tokenDecodedBytes"],
    coveredBehaviorKeys: ["canonical_unpadded_base64url"],
  },
  http_url_v1: {
    coveredConstantKeys: ["httpUrlProtocols"],
    coveredBehaviorKeys: ["absolute_url", "credentials_forbidden"],
  },
  timestamp_v1: {
    coveredConstantKeys: [],
    coveredBehaviorKeys: ["canonical_utc_milliseconds"],
  },
  relative_state_path_v1: {
    coveredConstantKeys: ["relativeStatePathMaxBytes"],
    coveredBehaviorKeys: ["safe_relative_segments"],
  },
  json_safe_v1: {
    coveredConstantKeys: [
      "jsonSafeMaxDepth",
      "jsonSafeMaxArrayEntries",
      "jsonSafeMaxObjectEntries",
      "jsonSafeMaxKeyChars",
      "jsonSafeMaxStringBytes",
    ],
    coveredBehaviorKeys: [
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
    coveredConstantKeys: ["operationMaxBytes"],
    coveredBehaviorKeys: [],
  },
  operation_result_v1: {
    coveredConstantKeys: [
      "evaluateResultMaxBytes",
      "operationResultMaxBytes",
      "actionResponseMaxBytes",
    ],
    coveredBehaviorKeys: [],
  },
  indexeddb_v1: {
    coveredConstantKeys: [],
    coveredBehaviorKeys: [
      "record_value_encoding_exclusive",
      "record_key_encoding_exclusive",
      "index_requires_one_key_path",
      "store_key_paths_exclusive",
      "inline_records_omit_keys",
      "out_of_line_records_require_one_key",
    ],
  },
  storage_state_v1: {
    coveredConstantKeys: ["storageStateMaxBytes"],
    coveredBehaviorKeys: [],
  },
  headers_v1: {
    coveredConstantKeys: ["headerMaxCount", "headerMaxBytes"],
    coveredBehaviorKeys: ["node_header_validation"],
  },
  locale_timezone_v1: {
    coveredConstantKeys: [],
    coveredBehaviorKeys: ["language_tags_valid", "iana_timezone_valid"],
  },
  country_v1: {
    coveredConstantKeys: ["supportedLocationCountries"],
    coveredBehaviorKeys: ["country_case_normalization"],
  },
  replay_checkpoint_v1: {
    coveredConstantKeys: ["storageStateMaxBytes"],
    coveredBehaviorKeys: [
      "fingerprint_url_matches",
      "canonical_state_integrity",
    ],
  },
  profile_input_v1: {
    coveredConstantKeys: [],
    coveredBehaviorKeys: ["generation_tuple_all_or_none"],
  },
  create_session_v1: {
    coveredConstantKeys: [
      "sessionTtlMinSeconds",
      "sessionTtlMaxSeconds",
      "sessionActivityTtlMinSeconds",
      "sessionActivityTtlMaxSeconds",
      "sessionMaxAllowedDomains",
      "createSessionDefaultMaxBytes",
      "createSessionReplayMaxBytes",
    ],
    coveredBehaviorKeys: [
      "activity_ttl_not_after_ttl",
      "domains_case_insensitively_unique",
      "replay_profile_generation_conflict",
    ],
  },
  session_response_v1: {
    coveredConstantKeys: ["sessionResponseMaxBytes"],
    coveredBehaviorKeys: [],
  },
  artifact_metadata_v1: {
    coveredConstantKeys: ["artifactContentTypesByKind"],
    coveredBehaviorKeys: ["content_type_matches_kind"],
  },
  reconciliation_v1: {
    coveredConstantKeys: [
      "reconciliationMaxReferences",
      "reconciliationMaxBytes",
    ],
    coveredBehaviorKeys: [
      "unique_reference_identity",
      "consistent_path_checksum",
    ],
  },
  private_error_v1: {
    coveredConstantKeys: [
      "privateErrorMaxMessageChars",
      "privateErrorMaxBytes",
    ],
    coveredBehaviorKeys: ["well_formed_control_free_message"],
  },
  private_auth_v1: {
    coveredConstantKeys: [
      "authBearerMaxBytes",
      "authCorrelationMinChars",
      "authCorrelationMaxChars",
      "authCorrelationPrintableAscii",
      "authDeadlineMaxMs",
      "authDeadlineCanonicalUtc",
    ],
    coveredBehaviorKeys: [
      "exact_bearer_secret",
      "printable_ascii_correlation_id",
      "canonical_future_deadline",
    ],
  },
  internal_error_detail_v1: {
    coveredConstantKeys: ["internalErrorDetailAllowlist"],
    coveredBehaviorKeys: ["internal_detail_allowlist_enforced"],
  },
};

const semanticRuleCases = Object.fromEntries(
  Object.entries(semanticRuleImplementations).map(([ruleKey, run]) => [
    ruleKey,
    { ...semanticRuleCaseCoverage[ruleKey], run },
  ]),
);

describe("private V1 executable semantic rules", () => {
  test.each(Object.entries(semanticRuleCases))(
    "%s",
    (_ruleKey, semanticRuleCase) => {
      semanticRuleCase.run();
    },
  );
});

describe("private V1 contracts", () => {
  test("canonical bytes and checksum match API localeCompare ordering", () => {
    const apiStableJson = (value: unknown): string => {
      if (Array.isArray(value)) {
        return `[${value.map(apiStableJson).join(",")}]`;
      }
      if (value !== null && typeof value === "object") {
        return `{${Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => `${JSON.stringify(key)}:${apiStableJson(item)}`)
          .join(",")}}`;
      }
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new TypeError("not JSON");
      return serialized;
    };
    const mixedCase = {
      z: 1,
      A: { b: 2, B: 3, a: 4 },
      a: [{ Z: 5, z: 6 }],
    };
    const expected = apiStableJson(mixedCase);
    expect(canonicalJson(mixedCase)).toBe(expected);
    expect(sha256(canonicalJson(mixedCase))).toBe(
      createHash("sha256").update(Buffer.from(expected, "utf8")).digest("hex"),
    );
  });

  test("action request rejects unknown fields and non-SHA hashes", () => {
    expect(
      actionExecutionRequestSchema.safeParse(
        validAction({ normalizedProposalHash: "not-a-hash", extra: true }),
      ).success,
    ).toBe(false);
  });

  test("operation union cannot select shell or transport", () => {
    expect(
      browserOperationSchema.safeParse({ kind: "shell", command: "id" })
        .success,
    ).toBe(false);
  });

  test("control handoff and scoped health reject unknown identity fields", () => {
    expect(
      createControlGenerationV1Schema.safeParse({
        version: 1,
        processNonce: VALID_NONCE,
        apiInstanceId: VALID_ID,
        idempotencyKey: VALID_NONCE,
        controlGenerationNonce: VALID_NONCE,
      }).success,
    ).toBe(false);
    expect(
      scopedLiveHealthV1Schema.safeParse({
        version: 1,
        status: "ready",
        processNonce: VALID_NONCE,
      }).success,
    ).toBe(false);
  });

  test("reconciliation rejects malformed filesystem authority", () => {
    expect(
      reconciliationRequestV1Schema.safeParse({
        version: 1,
        processNonce: "A".repeat(43),
        controlGenerationNonce: VALID_NONCE,
        snapshotDigest: "a".repeat(64),
        references: [
          {
            kind: "replay_checkpoint",
            id: VALID_ID.toUpperCase(),
            path: "../escape.json",
            checksum: "A".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("reconciliation rejects duplicate identities and checksum aliases", () => {
    const reference = {
      kind: "replay_checkpoint",
      id: VALID_ID,
      path: "replay/a.json",
      checksum: "a".repeat(64),
    };
    const base = {
      version: 1,
      processNonce: VALID_NONCE,
      controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
      snapshotDigest: "b".repeat(64),
    };
    expect(
      reconciliationRequestV1Schema.safeParse({
        ...base,
        references: [reference, reference],
      }).success,
    ).toBe(false);
    expect(
      reconciliationRequestV1Schema.safeParse({
        ...base,
        references: [
          reference,
          {
            ...reference,
            kind: "profile_generation",
            id: VALID_RUN_ID,
            checksum: "c".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("health contracts distinguish live, reconciling, and ready", () => {
    expect(
      liveDiscoveryV1Schema.parse({
        version: 1,
        status: "live_unreconciled",
        processNonce: VALID_NONCE,
      }).status,
    ).toBe("live_unreconciled");
    expect(
      scopedLiveHealthV1Schema.parse({
        version: 1,
        status: "reconciling",
        processNonce: VALID_NONCE,
        controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
      }).status,
    ).toBe("reconciling");
    expect(
      scopedLiveHealthV1Schema.safeParse({
        version: 1,
        status: "draining",
        processNonce: VALID_NONCE,
        controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
      }).success,
    ).toBe(false);
    expect(
      readyHealthV1Schema.safeParse({
        version: 1,
        status: "ready",
        processNonce: VALID_NONCE,
        controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
        snapshotDigest: "a".repeat(64),
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("service contracts exactly match canonical V1 inventory", async () => {
    const fixture = await readCanonicalPrivateV1Fixture();
    const derived = buildServicePrivateV1Inventory();
    expect(servicePrivateV1Inventory).toEqual(derived);
    expect(normalizePrivateV1Inventory(derived)).toEqual(fixture);
    expect(fingerprintPrivateV1Inventory(servicePrivateV1Inventory)).toBe(
      sha256(canonicalJson(fixture)),
    );
    expect(Object.keys(derived.definitions.schemas).sort()).toEqual(
      Object.keys(PRIVATE_V1_SCHEMAS).sort(),
    );
    expect(derived.definitions.headers).toEqual({
      auth: PRIVATE_AUTH_HEADERS,
      fencing: PRIVATE_FENCING_HEADERS,
    });
    expect(derived.definitions.errors.statusByCategory).toEqual(
      BROWSER_SERVICE_ERROR_STATUS,
    );
    expect(derived.definitions.semanticRules).toEqual({
      ...PRIVATE_V1_SEMANTIC_RULE_REGISTRY,
      ...AUTH_SEMANTIC_RULE_REGISTRY,
      ...ERROR_SEMANTIC_RULE_REGISTRY,
    });
    expect(derived.definitions.customConstants).toEqual({
      ...PRIVATE_V1_CUSTOM_CONSTANTS,
      ...AUTH_CUSTOM_CONSTANTS,
      ...ERROR_CUSTOM_CONSTANTS,
    });
    const registeredRuleKeys = new Set(
      Object.keys(derived.definitions.semanticRules),
    );
    for (const entry of Object.values(PRIVATE_V1_SCHEMA_REGISTRY)) {
      for (const semanticRuleKey of entry.semanticRuleKeys) {
        expect(registeredRuleKeys.has(semanticRuleKey)).toBe(true);
      }
    }
  });

  test("semantic registry rejects orphan rules and orphan cases", () => {
    const registry = {
      ...PRIVATE_V1_SEMANTIC_RULE_REGISTRY,
      ...AUTH_SEMANTIC_RULE_REGISTRY,
      ...ERROR_SEMANTIC_RULE_REGISTRY,
    };
    const constants = {
      ...PRIVATE_V1_CUSTOM_CONSTANTS,
      ...AUTH_CUSTOM_CONSTANTS,
      ...ERROR_CUSTOM_CONSTANTS,
    };
    expect(() =>
      validateSemanticRuleCoverage(registry, semanticRuleCases, constants),
    ).not.toThrow();
    expect(() =>
      validateSemanticRuleCoverage(
        {
          ...registry,
          orphan_rule: {
            target: "orphan",
            constantKeys: [],
            behaviorKeys: [],
          },
        },
        semanticRuleCases,
        constants,
      ),
    ).toThrow(/orphan_rule/);
    expect(() =>
      validateSemanticRuleCoverage(
        registry,
        {
          ...semanticRuleCases,
          orphan_case: semanticRuleCases.canonical_json_v1,
        },
        constants,
      ),
    ).toThrow(/orphan_case/);
    const { canonical_json_v1: _removed, ...missingCase } = semanticRuleCases;
    expect(() =>
      validateSemanticRuleCoverage(registry, missingCase, constants),
    ).toThrow(/canonical_json_v1/);
    const { canonical_json_v1: _registration, ...missingRule } = registry;
    expect(() =>
      validateSemanticRuleCoverage(missingRule, semanticRuleCases, constants),
    ).toThrow(/canonical_json_v1/);
    expect(() =>
      validateSemanticRuleCoverage(
        {
          ...registry,
          canonical_json_v1: {
            ...registry.canonical_json_v1,
            target: "canonicalJson",
            constantKeys: ["missing_constant"],
          },
        },
        semanticRuleCases,
        constants,
      ),
    ).toThrow(/missing_constant/);
    expect(() =>
      validateSemanticRuleCoverage(registry, semanticRuleCases, {
        ...constants,
        orphan_constant: true,
      }),
    ).toThrow(/orphan_constant/);
  });

  test("semantic registry rejects unproved constants and behaviors", () => {
    const registry = {
      example_rule: {
        target: "example",
        constantKeys: ["exampleLimit"],
        behaviorKeys: ["example_behavior"],
      },
    };
    const constants = { exampleLimit: 1 };
    const completeCase = {
      example_rule: {
        coveredConstantKeys: ["exampleLimit"],
        coveredBehaviorKeys: ["example_behavior"],
        run: () => undefined,
      },
    };
    expect(() =>
      validateSemanticRuleCoverage(
        registry,
        {
          example_rule: {
            ...completeCase.example_rule,
            coveredConstantKeys: [],
          },
        },
        constants,
      ),
    ).toThrow(/exampleLimit/);
    expect(() =>
      validateSemanticRuleCoverage(
        registry,
        {
          example_rule: {
            ...completeCase.example_rule,
            coveredBehaviorKeys: [],
          },
        },
        constants,
      ),
    ).toThrow(/example_behavior/);
    expect(() =>
      validateSemanticRuleCoverage(
        registry,
        {
          example_rule: {
            ...completeCase.example_rule,
            coveredConstantKeys: ["exampleLimit", "extraLimit"],
          },
        },
        constants,
      ),
    ).toThrow(/extraLimit/);
    expect(() =>
      validateSemanticRuleCoverage(
        registry,
        {
          example_rule: {
            ...completeCase.example_rule,
            coveredBehaviorKeys: ["example_behavior", "extra_behavior"],
          },
        },
        constants,
      ),
    ).toThrow(/extra_behavior/);
  });

  test("action results reject unsafe JSON and encoded overflow", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [undefined, Symbol("x"), 1n, Number.NaN, cyclic]) {
      expect(
        actionExecutionResultSchema.safeParse({
          version: 1,
          actionId: VALID_ID,
          sequence: 1,
          normalizedProposalHash: "a".repeat(64),
          outcome: "succeeded",
          result: { kind: "evaluate", value },
          page: {
            url: "https://example.test/",
            title: "ok",
            snapshotExcerpt: "ok",
          },
          sessionVersion: 1,
        }).success,
      ).toBe(false);
    }
    expect(
      actionExecutionResultSchema.safeParse({
        version: 1,
        actionId: VALID_ID,
        sequence: 1,
        normalizedProposalHash: "a".repeat(64),
        outcome: "succeeded",
        result: { kind: "get_text", text: "x".repeat(40_001) },
        page: {
          url: "https://example.test/",
          title: "ok",
          snapshotExcerpt: "ok",
        },
        sessionVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      actionExecutionResultSchema.safeParse({
        version: 1,
        actionId: VALID_ID,
        sequence: 1,
        normalizedProposalHash: "a".repeat(64),
        outcome: "succeeded",
        result: { kind: "evaluate", value: "x".repeat(32 * 1024 + 1) },
        page: {
          url: "https://example.test/",
          title: "ok",
          snapshotExcerpt: "ok",
        },
        sessionVersion: 1,
      }).success,
    ).toBe(false);

    const maximalValidActionResponse = {
      version: 1,
      actionId: VALID_ID,
      sequence: 25,
      normalizedProposalHash: "a".repeat(64),
      outcome: "succeeded",
      result: { kind: "evaluate", value: "x".repeat(32 * 1024 - 2) },
      page: {
        url: "https://example.test/",
        title: "x".repeat(4_096),
        snapshotExcerpt: "x".repeat(40_000),
      },
      sessionVersion: Number.MAX_SAFE_INTEGER,
    };
    expect(
      actionExecutionResultSchema.safeParse(maximalValidActionResponse).success,
    ).toBe(true);
    expect(encodedBytes(maximalValidActionResponse)).toBeLessThanOrEqual(
      128 * 1024,
    );
  });

  test("JSON-safe values reject array accessors and extra properties", () => {
    const withAccessor = ["ok"];
    Object.defineProperty(withAccessor, "secret", {
      enumerable: true,
      get: () => "leak",
    });
    expect(jsonSafeSchema.safeParse(withAccessor).success).toBe(false);
    const withExtra = ["ok"] as unknown[] & { extra?: string };
    withExtra.extra = "not-json-array-data";
    expect(jsonSafeSchema.safeParse(withExtra).success).toBe(false);
  });

  test("JSON-safe depth is bounded and reflection failures never escape", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = "leaf";
      for (let index = 0; index < depth; index += 1) value = [value];
      return value;
    };
    expect(jsonSafeSchema.safeParse(nested(16)).success).toBe(true);
    expect(jsonSafeSchema.safeParse(nested(17)).success).toBe(false);

    const nonEnumerable = ["secret"];
    Object.defineProperty(nonEnumerable, "0", {
      configurable: true,
      enumerable: false,
      value: "secret",
      writable: true,
    });
    expect(jsonSafeSchema.safeParse(nonEnumerable).success).toBe(false);

    const throwingProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("reflection denied");
        },
        ownKeys: () => {
          throw new Error("reflection denied");
        },
      },
    );
    expect(() => jsonSafeSchema.safeParse(throwingProxy)).not.toThrow();
    expect(jsonSafeSchema.safeParse(throwingProxy).success).toBe(false);
  });

  test("out-of-line IndexedDB stores require exactly one key encoding", () => {
    expect(
      storageStateV1Schema.safeParse({
        cookies: [],
        origins: [
          {
            origin: "https://example.test",
            localStorage: [],
            indexedDB: [
              {
                name: "db",
                version: 1,
                stores: [
                  {
                    name: "store",
                    autoIncrement: false,
                    records: [{ value: "missing-key" }],
                    indexes: [],
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("IndexedDB key paths match replay envelope semantics", () => {
    const record = { value: "ok" };
    const base = {
      cookies: [],
      origins: [
        {
          origin: "https://example.test",
          localStorage: [],
          indexedDB: [
            {
              name: "db",
              version: 1,
              stores: [
                {
                  name: "store",
                  autoIncrement: false,
                  records: [record],
                  indexes: [
                    {
                      name: "index",
                      keyPath: "",
                      multiEntry: false,
                      unique: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(
      storageStateV1Schema.safeParse({
        ...base,
        origins: [
          {
            ...base.origins[0],
            indexedDB: [
              {
                ...base.origins[0]!.indexedDB[0],
                stores: [
                  {
                    ...base.origins[0]!.indexedDB[0]!.stores[0],
                    keyPathArray: [""],
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      storageStateV1Schema.safeParse({
        ...base,
        origins: [
          {
            ...base.origins[0],
            indexedDB: [
              {
                ...base.origins[0]!.indexedDB[0],
                stores: [
                  {
                    ...base.origins[0]!.indexedDB[0]!.stores[0],
                    keyPath: "id",
                    records: [{ key: "forbidden", value: "ok" }],
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      storageStateV1Schema.safeParse({
        ...base,
        origins: [
          {
            ...base.origins[0],
            indexedDB: [
              {
                ...base.origins[0]!.indexedDB[0],
                stores: [
                  {
                    ...base.origins[0]!.indexedDB[0]!.stores[0],
                    indexes: [
                      {
                        name: "index",
                        multiEntry: false,
                        unique: false,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("artifact media type must match artifact kind", () => {
    expect(
      artifactMetadataV1Schema.safeParse({
        version: 1,
        artifactId: VALID_ID,
        kind: "recording",
        contentType: "image/png",
        byteSize: 1,
        checksum: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  test("country values use API-supported exact normalized set", async () => {
    const source = await readFile(
      new URL("../../api/src/lib/validate-country.ts", import.meta.url),
      "utf8",
    );
    const apiCountries = [...source.matchAll(/^  ([A-Z]{2}): \{/gm)].map(
      (match) => match[1]!.toLowerCase(),
    );
    expect([...SUPPORTED_LOCATION_COUNTRIES].sort()).toEqual(
      [...apiCountries, "us-generic", "us-whitelist"].sort(),
    );

    const settings = {
      headers: {},
      cookies: [],
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
      userAgent: "test",
      locale: "en-US",
      location: { country: "CA", languages: ["en-CA"] },
      proxy: { kind: "auto", country: "US-WHITELIST" },
      skipTlsVerification: false,
      blockAds: false,
      lockdown: true,
    };
    const parsed = replayBrowserSettingsV1Schema.parse(settings);
    expect(parsed.location.country).toBe("ca");
    expect(parsed.proxy.country).toBe("us-whitelist");
    for (const country of ["canada", "zz", "MARS"]) {
      expect(
        replayBrowserSettingsV1Schema.safeParse({
          ...settings,
          location: { ...settings.location, country },
        }).success,
      ).toBe(false);
    }
  });

  test("Node HTTP validation rejects invalid Unicode and control headers", () => {
    const base = {
      headers: {},
      cookies: [],
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
      userAgent: "test",
      locale: "en-US",
      location: { country: "us", languages: ["en-US"] },
      proxy: { kind: "auto" },
      skipTlsVerification: false,
      blockAds: false,
      lockdown: true,
    };
    for (const headers of [
      { "x-💥": "value" },
      { "x-ok": "bad\u0000value" },
      { "x-ok": "snowman-☃" },
    ]) {
      expect(
        replayBrowserSettingsV1Schema.safeParse({ ...base, headers }).success,
      ).toBe(false);
    }
  });

  test("session response enforces 128 KiB encoded multibyte cap", () => {
    const session = {
      version: 1,
      runtimeSessionId: VALID_ID,
      state: "ready",
      sessionVersion: 0,
      page: {
        url: "https://example.test/",
        title: "界".repeat(2_000),
        snapshotExcerpt: "界".repeat(40_000),
      },
      expiresAt: "2026-07-21T01:00:00.000Z",
      idleExpiresAt: "2026-07-21T00:10:00.000Z",
    };
    expect(sessionV1Schema.safeParse(session).success).toBe(true);
    expect(encodedBytes(session)).toBeLessThanOrEqual(128 * 1024);
    const overflow = {
      ...session,
      page: { ...session.page, title: "界".repeat(4_096) },
    };
    expect(encodedBytes(overflow)).toBeGreaterThan(128 * 1024);
    expect(sessionV1Schema.safeParse(overflow).success).toBe(false);
  });

  test("private errors sanitize controls, surrogates, and encoded overflow", () => {
    const error = new BrowserServiceError(
      "reconciliation_cleanup_failed",
      `\ud800bad\u0000${"界".repeat(2_000)}`,
      { detail: "close_failed" },
    );
    expect(() => error.toResponse()).not.toThrow();
    const response = error.toResponse();
    expect(response.message).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(response.message.isWellFormed()).toBe(true);
    expect(
      Buffer.byteLength(canonicalJson(response), "utf8"),
    ).toBeLessThanOrEqual(4 * 1024);
    expect(response).not.toHaveProperty("detail");
    expect(
      () =>
        new BrowserServiceError("reconciliation_cleanup_failed", "safe", {
          detail: "raw-cause" as never,
        }),
    ).toThrow(/detail/i);
    expect(
      privateErrorV1Schema.safeParse({
        version: 1,
        category: "invalid_request",
        message: "bad\u0000message",
      }).success,
    ).toBe(false);
    expect(
      privateErrorV1Schema.safeParse({
        version: 1,
        category: "invalid_request",
        message: "bad\ud800message",
      }).success,
    ).toBe(false);
  });

  test("error taxonomy includes every reconciliation failure status", () => {
    expect(BROWSER_SERVICE_ERROR_STATUS).toMatchObject({
      browser_service_runtime_mismatch: 503,
      browser_unavailable: 503,
      reconciliation_snapshot_invalid: 400,
      reconciliation_snapshot_too_large: 413,
      reconciliation_reference_missing: 409,
      reconciliation_reference_corrupt: 409,
      reconciliation_filesystem_unsafe: 503,
      reconciliation_deadline_exceeded: 408,
    });
  });

  test("operation and storage-state encoded caps reject multibyte overflow", () => {
    expect(
      browserOperationSchema.safeParse({
        kind: "evaluate",
        expression: "x".repeat(20_000),
        args: { value: "界".repeat(20_000) },
      }).success,
    ).toBe(false);
    const validState = {
      cookies: [],
      origins: [
        {
          origin: "https://example.test",
          localStorage: Array.from({ length: 10 }, (_, index) => ({
            name: String(index),
            value: "界".repeat(65_536),
          })),
        },
      ],
    };
    expect(storageStateV1Schema.safeParse(validState).success).toBe(true);
    expect(
      storageStateV1Schema.safeParse({
        ...validState,
        origins: [
          {
            ...validState.origins[0],
            localStorage: Array.from({ length: 11 }, (_, index) => ({
              name: String(index),
              value: "界".repeat(65_536),
            })),
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("locale, timezone, timestamp, and relative path semantics are closed", () => {
    const base = {
      headers: {},
      cookies: [],
      viewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
      userAgent: "test",
      locale: "en-US",
      location: { country: "us", languages: ["en-US"] },
      proxy: { kind: "auto" },
      skipTlsVerification: false,
      blockAds: false,
      lockdown: true,
    };
    expect(
      replayBrowserSettingsV1Schema.safeParse({
        ...base,
        locale: "not_a_locale",
      }).success,
    ).toBe(false);
    expect(
      replayBrowserSettingsV1Schema.safeParse({
        ...base,
        timezoneId: "Mars/Olympus",
      }).success,
    ).toBe(false);
    expect(
      sessionV1Schema.safeParse({
        version: 1,
        runtimeSessionId: VALID_ID,
        state: "ready",
        sessionVersion: 0,
        page: {
          url: "https://example.test/",
          title: "ok",
          snapshotExcerpt: "ok",
        },
        expiresAt: "2026-07-21T01:00:00Z",
        idleExpiresAt: "2026-07-21T00:10:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      reconciliationRequestV1Schema.safeParse({
        version: 1,
        processNonce: VALID_NONCE,
        controlGenerationNonce: VALID_CONTROL_GENERATION_NONCE,
        snapshotDigest: "a".repeat(64),
        references: [
          {
            kind: "replay_checkpoint",
            id: VALID_ID,
            path: "replay/./escape.json",
            checksum: "a".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("all direct package versions are exact", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    for (const version of Object.values({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("shared primitives reject noncanonical IDs and non-HTTP URLs", () => {
    expect(canonicalUuidSchema.safeParse(VALID_ID.toUpperCase()).success).toBe(
      false,
    );
    for (const url of [
      "file:///etc/passwd",
      "mailto:a@example.test",
      "ftp://example.test/a",
      "https://user:pass@example.test/",
      "/relative",
      `https://example.test/${"x".repeat(8_193)}`,
    ]) {
      expect(httpUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  test("session request enforces TTL, domain, and replay/profile invariants", () => {
    const request = {
      version: 1,
      sessionId: VALID_ID,
      initialUrl: "https://example.test/",
      allowedDomains: ["example.test"],
      ttlSeconds: 30,
      activityTtlSeconds: 10,
      profile: null,
      replay: null,
      settings: {
        headers: {},
        cookies: [],
        viewport: {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
        },
        userAgent: "test",
        locale: "en-US",
        location: { country: "US", languages: ["en-US"] },
        proxy: { kind: "auto" },
        skipTlsVerification: false,
        blockAds: false,
        lockdown: true,
      },
    };
    expect(createSessionV1Schema.safeParse(request).success).toBe(true);
    expect(
      createSessionV1Schema.safeParse({
        ...request,
        initialUrl: "about:blank",
        allowedDomains: [],
      }).success,
    ).toBe(true);
    expect(
      createSessionV1Schema.safeParse({
        ...request,
        activityTtlSeconds: 31,
      }).success,
    ).toBe(false);
    expect(
      createSessionV1Schema.safeParse({
        ...request,
        allowedDomains: ["example.test", "example.test"],
      }).success,
    ).toBe(false);
  });
});
